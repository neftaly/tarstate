import { performance } from 'node:perf_hooks';
import { afterAll, bench, describe } from 'vitest';
import { createDb, q, transact, type Db } from '@tarstate/core/db';
import { mat } from '@tarstate/core/materialization';
import {
  aggregate,
  asc,
  count,
  desc,
  eq,
  field,
  from,
  gte,
  pipe,
  project,
  sort,
  sortLimit,
  sum,
  value,
  where,
  type Query
} from '@tarstate/core/query';
import { deleteByKey, insertOrReplace, updateByKey, type WritePatch } from '@tarstate/core/write';
import { createSeededRandom, type SeededRandom } from '../tests/fuzz-helpers.js';
import { entry, schema, type Account, type Entry } from '../tests/behavior-fixtures.js';

const ROW_COUNT = 12_000;
const ACCOUNT_COUNT = 96;
const TOP_N_COUNT = 30;
const SAMPLE_OPS = 12;
const MIX_LENGTH = 256;
const BENCH_OPTIONS = {
  time: 100,
  iterations: 5,
  warmupTime: 20,
  warmupIterations: 1
};

type QueryShape = 'lookup' | 'scan' | 'aggregate' | 'topN';
type PerfMode = 'materialized' | 'recompute';
type FuzzShape = {
  readonly label: string;
  readonly rowCount: number;
  readonly readWeight: number;
  readonly writeWeight: number;
  readonly queryWeights: Readonly<Record<QueryShape, number>>;
};
type FuzzOperation =
  | { readonly kind: 'read'; readonly queryIndex: number; readonly queryShape: QueryShape }
  | { readonly kind: 'write'; readonly patch: WritePatch | readonly WritePatch[] };
type QuerySpec = {
  readonly shape: QueryShape;
  readonly query: Query<unknown>;
};
type PerfMetrics = {
  readonly label: string;
  samples: number;
  operations: number;
  reads: number;
  writes: number;
  rowsRead: number;
  netHeapBytes: number;
  positiveHeapBytes: number;
  maxPositiveHeapBytes: number;
  elapsedMs: number;
  sampleMs: number[];
  maxSampleMs: number;
};

const seeds = [13_579, 97_531] as const;
const fuzzShapes: readonly FuzzShape[] = [
  {
    label: 'read-heavy mixed queries',
    rowCount: ROW_COUNT,
    readWeight: 5,
    writeWeight: 1,
    queryWeights: { lookup: 4, scan: 2, aggregate: 2, topN: 2 }
  },
  {
    label: 'write-heavy GC maintenance mix',
    rowCount: ROW_COUNT,
    readWeight: 1,
    writeWeight: 4,
    queryWeights: { lookup: 1, scan: 1, aggregate: 5, topN: 5 }
  }
];
const accountKinds = ['asset', 'income', 'expense', 'equity', 'liability'] as const;
const accounts: readonly Account[] = Array.from({ length: ACCOUNT_COUNT }, (_, index) => ({
  id: `account-${index}`,
  name: `Account ${index}`,
  kind: accountKinds[index % accountKinds.length] ?? 'asset'
}));
const accountIds = accounts.map((row) => row.id);
const querySpecs = makeQuerySpecs();
const fuzzMetrics: PerfMetrics[] = [];
let rowSink = 0;

describe('core fuzz-driven perf mixes', () => {
  for (const shape of fuzzShapes) {
    describe(shape.label, () => {
      for (const seed of seeds) {
        const operations = makeOperations(seed, shape, querySpecs);
        const materializedQueries = materializedQuerySet(querySpecs, operations);

        bench(
          `seed ${seed} materialized`,
          fuzzProbe(shape, seed, 'materialized', operations, materializedQueries),
          BENCH_OPTIONS
        );
        bench(
          `seed ${seed} recompute`,
          fuzzProbe(shape, seed, 'recompute', operations, materializedQueries),
          BENCH_OPTIONS
        );
      }
    });
  }
});

afterAll(() => {
  if (fuzzMetrics.length === 0) return;

  console.table(fuzzMetrics.map((metrics) => ({
    mix: metrics.label,
    samples: metrics.samples,
    ops: metrics.operations,
    reads: metrics.reads,
    writes: metrics.writes,
    rowsRead: metrics.rowsRead,
    heapNetPerOp: bytesPerOp(metrics.netHeapBytes, metrics.operations),
    heapPositivePerOp: bytesPerOp(metrics.positiveHeapBytes, metrics.operations),
    maxHeapPositiveSample: bytes(metrics.maxPositiveHeapBytes),
    meanSampleMs: ms(metrics.elapsedMs / Math.max(1, metrics.samples)),
    p50SampleMs: ms(percentile(metrics.sampleMs, 0.50)),
    p95SampleMs: ms(percentile(metrics.sampleMs, 0.95)),
    maxSampleMs: ms(metrics.maxSampleMs)
  })));
});

function fuzzProbe(
  shape: FuzzShape,
  seed: number,
  mode: PerfMode,
  operations: readonly FuzzOperation[],
  materializedQueries: readonly Query<unknown>[]
): () => void {
  const label = `${shape.label} / seed ${seed} / ${mode}`;
  const metrics = makeMetrics(label);
  fuzzMetrics.push(metrics);
  let db = makeFuzzDb(shape.rowCount, mode, materializedQueries);
  let cursor = 0;

  return () => {
    const heapBefore = process.memoryUsage().heapUsed;
    const startedAt = performance.now();
    let rowsRead = 0;
    let reads = 0;
    let writes = 0;

    for (let opIndex = 0; opIndex < SAMPLE_OPS; opIndex += 1) {
      const operation = operations[cursor % operations.length];
      if (operation === undefined) throw new Error('fuzz operation set is empty');
      cursor += 1;

      if (operation.kind === 'read') {
        const querySpec = querySpecs[operation.queryIndex];
        if (querySpec === undefined) throw new Error('fuzz query index is invalid');
        rowsRead += consume(q(db, querySpec.query));
        reads += 1;
      } else {
        db = transact(db, operation.patch);
        writes += 1;
      }
    }

    const elapsedMs = performance.now() - startedAt;
    const heapDelta = process.memoryUsage().heapUsed - heapBefore;
    recordSample(metrics, {
      elapsedMs,
      heapDelta,
      rowsRead,
      reads,
      writes
    });
  };
}

function makeQuerySpecs(): readonly QuerySpec[] {
  const lookupQueries = accountIds.slice(0, 8).map((accountId) => ({
    shape: 'lookup' as const,
    query: pipe(
      from(entry),
      where(eq(entry.row.accountId, value(accountId))),
      project({ id: entry.row.id, accountId: entry.row.accountId, amount: entry.row.amount })
    ) as Query<unknown>
  }));
  const scanQueries = [-10_000, -5_000, 0, 5_000].map((threshold) => ({
    shape: 'scan' as const,
    query: pipe(
      from(entry),
      where(gte(entry.row.amount, value(threshold))),
      project({ id: entry.row.id, accountId: entry.row.accountId, amount: entry.row.amount })
    ) as Query<unknown>
  }));
  const aggregateQueries = [
    {
      shape: 'aggregate' as const,
      query: pipe(
        from(entry),
        aggregate({
          groupBy: { accountId: entry.row.accountId },
          aggregates: {
            entryCount: count(),
            total: sum(entry.row.amount)
          }
        }),
        sort(asc(field<string>('row', 'accountId')))
      ) as Query<unknown>
    }
  ];
  const topNQueries = [
    {
      shape: 'topN' as const,
      query: pipe(
        from(entry),
        sortLimit(TOP_N_COUNT, desc(entry.row.amount), asc(entry.row.id)),
        project({ id: entry.row.id, accountId: entry.row.accountId, amount: entry.row.amount })
      ) as Query<unknown>
    }
  ];

  return [...lookupQueries, ...scanQueries, ...aggregateQueries, ...topNQueries];
}

function materializedQuerySet(
  specs: readonly QuerySpec[],
  operations: readonly FuzzOperation[]
): readonly Query<unknown>[] {
  const indexes = new Set<number>();
  for (const operation of operations) {
    if (operation.kind === 'read') indexes.add(operation.queryIndex);
  }

  return [...indexes].map((index) => {
    const spec = specs[index];
    if (spec === undefined) throw new Error('fuzz materialized query index is invalid');
    return spec.query;
  });
}

function makeOperations(seed: number, shape: FuzzShape, specs: readonly QuerySpec[]): readonly FuzzOperation[] {
  const next = createSeededRandom(seed);

  return Array.from({ length: MIX_LENGTH }, (_, index) => {
    if (weightedChoice(next, [
      { value: 'read' as const, weight: shape.readWeight },
      { value: 'write' as const, weight: shape.writeWeight }
    ]) === 'read') {
      const queryShape = weightedChoice(next, [
        { value: 'lookup' as const, weight: shape.queryWeights.lookup },
        { value: 'scan' as const, weight: shape.queryWeights.scan },
        { value: 'aggregate' as const, weight: shape.queryWeights.aggregate },
        { value: 'topN' as const, weight: shape.queryWeights.topN }
      ]);
      return {
        kind: 'read',
        queryShape,
        queryIndex: chooseQueryIndex(next, specs, queryShape)
      };
    }

    return {
      kind: 'write',
      patch: makeFuzzPatch(next, seed, index, shape.rowCount)
    };
  });
}

function makeFuzzDb(rowCount: number, mode: PerfMode, materializedQueries: readonly Query<unknown>[]): Db {
  const db = createDb({
    accounts: accounts.map((row) => ({ ...row })),
    entries: makeEntries(rowCount)
  });

  return mode === 'materialized' ? mat(db, ...materializedQueries) : db;
}

function makeEntries(count: number): Entry[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `entry-${index}`,
    accountId: accountIds[index % accountIds.length] ?? 'account-0',
    amount: amountAt(index),
    memo: index % 5 === 0 ? null : `memo-${index % 251}`,
    posted: index % 7 !== 0
  }));
}

function makeFuzzPatch(
  next: SeededRandom,
  seed: number,
  index: number,
  rowCount: number
): WritePatch | readonly WritePatch[] {
  const rowIndex = Math.floor(next() * rowCount);
  const scratchIndex = (seed + index) % 64;
  const accountId = accountIds[Math.floor(next() * accountIds.length)] ?? 'account-0';
  const amount = amountAt(seed + index * 37 + rowIndex);
  const op = weightedChoice(next, [
    { value: 'update' as const, weight: 5 },
    { value: 'insert' as const, weight: 2 },
    { value: 'batch' as const, weight: 2 },
    { value: 'delete' as const, weight: 1 }
  ]);

  if (op === 'update') {
    return updateByKey(schema.entries, `entry-${rowIndex}`, {
      accountId,
      amount,
      memo: index % 4 === 0 ? null : `fuzz-${seed}-${index % 251}`,
      posted: index % 11 !== 0
    });
  }

  if (op === 'insert') {
    return insertOrReplace(schema.entries, {
      id: `fuzz-entry-${seed}-${scratchIndex}`,
      accountId,
      amount,
      memo: index % 3 === 0 ? null : `insert-${index % 251}`,
      posted: index % 5 !== 0
    });
  }

  if (op === 'delete') {
    return deleteByKey(schema.entries, `fuzz-entry-${seed}-${scratchIndex}`);
  }

  return [
    updateByKey(schema.entries, `entry-${rowIndex}`, {
      amount,
      posted: index % 7 !== 0
    }),
    insertOrReplace(schema.entries, {
      id: `fuzz-entry-${seed}-${scratchIndex}`,
      accountId,
      amount: amountAt(seed + index * 53),
      memo: index % 3 === 0 ? null : `batch-${index % 251}`,
      posted: index % 5 !== 0
    }),
    deleteByKey(schema.entries, `fuzz-entry-${seed}-${(scratchIndex + 32) % 64}`)
  ];
}

function chooseQueryIndex(next: SeededRandom, specs: readonly QuerySpec[], shape: QueryShape): number {
  const indexes = specs.flatMap((spec, index) => spec.shape === shape ? [index] : []);
  if (indexes.length === 0) throw new Error(`no fuzz query specs for ${shape}`);
  return indexes[Math.floor(next() * indexes.length)] ?? indexes[0] ?? 0;
}

function weightedChoice<const Value>(
  next: SeededRandom,
  choices: readonly { readonly value: Value; readonly weight: number }[]
): Value {
  const totalWeight = choices.reduce((sumValue, choice) => sumValue + choice.weight, 0);
  let pick = next() * totalWeight;

  for (const choice of choices) {
    pick -= choice.weight;
    if (pick <= 0) return choice.value;
  }

  const fallback = choices[choices.length - 1];
  if (fallback === undefined) throw new Error('cannot choose from an empty weighted list');
  return fallback.value;
}

function makeMetrics(label: string): PerfMetrics {
  return {
    label,
    samples: 0,
    operations: 0,
    reads: 0,
    writes: 0,
    rowsRead: 0,
    netHeapBytes: 0,
    positiveHeapBytes: 0,
    maxPositiveHeapBytes: 0,
    elapsedMs: 0,
    sampleMs: [],
    maxSampleMs: 0
  };
}

function recordSample(
  metrics: PerfMetrics,
  sample: {
    readonly elapsedMs: number;
    readonly heapDelta: number;
    readonly rowsRead: number;
    readonly reads: number;
    readonly writes: number;
  }
): void {
  const positiveHeapDelta = Math.max(0, sample.heapDelta);
  metrics.samples += 1;
  metrics.operations += SAMPLE_OPS;
  metrics.reads += sample.reads;
  metrics.writes += sample.writes;
  metrics.rowsRead += sample.rowsRead;
  metrics.netHeapBytes += sample.heapDelta;
  metrics.positiveHeapBytes += positiveHeapDelta;
  metrics.maxPositiveHeapBytes = Math.max(metrics.maxPositiveHeapBytes, positiveHeapDelta);
  metrics.elapsedMs += sample.elapsedMs;
  metrics.sampleMs.push(sample.elapsedMs);
  metrics.maxSampleMs = Math.max(metrics.maxSampleMs, sample.elapsedMs);
}

function amountAt(index: number): number {
  return ((index * 7_919) % 100_000) - 50_000;
}

function consume(rows: readonly unknown[]): number {
  rowSink = (rowSink + rows.length) % Number.MAX_SAFE_INTEGER;
  if (rowSink < 0) throw new Error('unreachable benchmark sink');
  return rows.length;
}

function bytesPerOp(byteCount: number, operations: number): string {
  return bytes(byteCount / Math.max(1, operations));
}

function bytes(byteCount: number): string {
  const abs = Math.abs(byteCount);
  if (abs < 1_024) return `${byteCount.toFixed(0)} B`;
  if (abs < 1_048_576) return `${(byteCount / 1_024).toFixed(1)} KiB`;
  return `${(byteCount / 1_048_576).toFixed(2)} MiB`;
}

function ms(value: number): string {
  return `${value.toFixed(2)} ms`;
}

function percentile(values: readonly number[], percentileValue: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * percentileValue) - 1);
  return sorted[index] ?? 0;
}
