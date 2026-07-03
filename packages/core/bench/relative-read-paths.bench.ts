import { performance } from 'node:perf_hooks';
import { afterAll, bench, describe } from 'vitest';
import { createDb, q, tryTransact, type Db } from '@tarstate/core/db';
import { mat, type MaterializationMaintenanceChange } from '@tarstate/core/materialization';
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
import { createStore, type StoreView } from '@tarstate/core/store';
import { insertOrReplace, updateByKey, type WritePatch } from '@tarstate/core/write';
import { createSeededRandom, type SeededRandom } from '../tests/fuzz-helpers.js';
import { entry, schema, type Account, type Entry } from '../tests/behavior-fixtures.js';

const ACCOUNT_COUNT = 64;
const QUERY_VARIANTS = 12;
const TOP_N_COUNT = 24;
const MIX_LENGTH = 160;
const SAMPLE_OPS = 8;
const READ_REPEAT_COUNT = 3;
const BENCH_OPTIONS = {
  time: 80,
  iterations: 4,
  warmupTime: 20,
  warmupIterations: 1
};

type ReadPathMode = 'recompute' | 'materialized' | 'store-view';
type QueryShape = 'lookup' | 'range' | 'aggregate' | 'topN';
type Scenario = {
  readonly label: string;
  readonly seed: number;
  readonly rowCount: number;
  readonly readWeight: number;
  readonly writeWeight: number;
  readonly queryWeights: Readonly<Record<QueryShape, number>>;
};
type QuerySpec = {
  readonly shape: QueryShape;
  readonly query: Query<unknown>;
};
type FuzzOperation =
  | { readonly kind: 'read'; readonly queryIndex: number; readonly queryShape: QueryShape }
  | { readonly kind: 'write'; readonly patch: WritePatch | readonly WritePatch[] };
type ProbeMetrics = {
  readonly scenario: string;
  readonly mode: ReadPathMode;
  samples: number;
  operations: number;
  reads: number;
  readPasses: number;
  writes: number;
  rowsRead: number;
  coldRowsRead: number;
  hotRowsRead: number;
  rowsChanged: number;
  writeEffects: number;
  outputRowChanges: number;
  irrelevantWrites: number;
  incrementalEffects: number;
  recomputedEffects: number;
  elapsedMs: number;
  readonly shapes: Record<QueryShape, ShapeMetrics>;
};
type ShapeMetrics = {
  reads: number;
  coldPasses: number;
  hotPasses: number;
  coldRowsRead: number;
  hotRowsRead: number;
};
const accountKinds = ['asset', 'income', 'expense', 'equity', 'liability'] as const;
const accounts: readonly Account[] = Array.from({ length: ACCOUNT_COUNT }, (_, index) => ({
  id: `account-${index}`,
  name: `Account ${index}`,
  kind: accountKinds[index % accountKinds.length] ?? 'asset'
}));
const accountIds = accounts.map((account) => account.id);
const querySpecs = makeQuerySpecs();
const scenarios: readonly Scenario[] = [
  {
    label: 'small read-heavy mixed shapes',
    seed: 20_261,
    rowCount: 1_200,
    readWeight: 6,
    writeWeight: 1,
    queryWeights: { lookup: 4, range: 2, aggregate: 2, topN: 2 }
  },
  {
    label: 'medium churn with aggregates/topN',
    seed: 98_717,
    rowCount: 4_800,
    readWeight: 4,
    writeWeight: 2,
    queryWeights: { lookup: 2, range: 2, aggregate: 3, topN: 3 }
  }
];
const metrics: ProbeMetrics[] = [];
let rowSink = 0;

describe('core relative read paths under fuzz load', () => {
  for (const scenario of scenarios) {
    const operations = makeOperations(scenario);
    const materializedQueries = materializedQuerySet(querySpecs, operations);

    describe(scenario.label, () => {
      bench('recompute repeated reads', makeDbProbe(scenario, operations, 'recompute', []), BENCH_OPTIONS);
      bench('materialized repeated reads', makeDbProbe(scenario, operations, 'materialized', materializedQueries), BENCH_OPTIONS);
      bench('store-view repeated reads', makeStoreViewProbe(scenario, operations), BENCH_OPTIONS);
    });
  }
});

afterAll(() => {
  if (metrics.length === 0) return;

  console.table(metrics.map((item) => ({
    scenario: item.scenario,
    mode: item.mode,
    samples: item.samples,
    ops: item.operations,
    reads: item.reads,
    writes: item.writes,
    readPassMode: `cold+${READ_REPEAT_COUNT - 1} hot`,
    rowsReadPerOp: ratio(item.rowsRead, item.operations),
    rowsReadPerRead: ratio(item.rowsRead, item.reads),
    coldRowsPerRead: ratio(item.coldRowsRead, item.reads),
    hotRowsPerRead: ratio(item.hotRowsRead, item.reads),
    rowsChangedPerWrite: ratio(item.rowsChanged, item.writes),
    writeEffectsPerWrite: ratio(item.writeEffects, item.writes),
    outputRowChangesPerWrite: ratio(item.outputRowChanges, item.writes),
    irrelevantWrites: item.irrelevantWrites,
    incrementalEffects: item.incrementalEffects,
    recomputedEffects: item.recomputedEffects,
    meanSampleMs: ms(item.elapsedMs / Math.max(1, item.samples)),
    usPerOp: micros(item.elapsedMs, item.operations),
    usPerReturnedRow: micros(item.elapsedMs, item.rowsRead)
  })));

  console.table(shapeRows());
  console.table(ratioRows());
  console.info([
    'Decomplection hints:',
    '- If materialized/recompute usPerOp stays near 1.0 while outputRowChangesPerWrite or rowsChangedPerWrite is higher, simplify by removing that materialized shape first.',
    '- If store-view/materialized usPerOp stays near 1.0 and rowsReadPerRead matches, the separate store-view cache path is the simplification target.',
    '- If recompute/materialized grows with rowCount while materialized writeEffectsPerWrite and irrelevantWrites stay low, keep the materialized maintenance path for that query shape.'
  ].join('\n'));
});

function makeDbProbe(
  scenario: Scenario,
  operations: readonly FuzzOperation[],
  mode: Exclude<ReadPathMode, 'store-view'>,
  materializedQueries: readonly Query<unknown>[]
): () => void {
  const metric = registerMetrics(scenario.label, mode);
  let db = mode === 'materialized'
    ? mat(makeDb(scenario.rowCount), ...materializedQueries)
    : makeDb(scenario.rowCount);
  let cursor = 0;

  return () => {
    const startedAt = performance.now();
    const sample = emptySample();

    for (let index = 0; index < SAMPLE_OPS; index += 1) {
      const operation = opAt(operations, cursor);
      cursor += 1;

      if (operation.kind === 'read') {
        recordRead(sample, operation.queryShape, () => consume(q(db, queryAt(operation.queryIndex))), repeatMode);
        continue;
      }

      const result = tryTransact(db, operation.patch);
      if (!result.committed) throw new Error(result.diagnostics.map((diagnostic) => diagnostic.message).join('; '));
      db = result.db;
      sample.writes += 1;
      sample.rowsChanged += changedRows(result.deltas);
      addWriteImpact(
        sample,
        mode === 'materialized'
          ? materializationWriteImpact(result.materializations?.changes ?? [])
          : relationWriteImpact(result.deltas)
      );
    }

    record(metric, sample, performance.now() - startedAt);
  };
}

function makeStoreViewProbe(scenario: Scenario, operations: readonly FuzzOperation[]): () => Promise<void> {
  const metric = registerMetrics(scenario.label, 'store-view');
  const store = createStore({
    accounts: accounts.map((row) => ({ ...row })),
    entries: makeEntries(scenario.rowCount)
  });
  const views = querySpecs.map((spec) => store.view(spec.query));
  let cursor = 0;

  metricCleanup.set(metric, () => store.close());

  return async () => {
    const startedAt = performance.now();
    const sample = emptySample();

    for (let index = 0; index < SAMPLE_OPS; index += 1) {
      const operation = opAt(operations, cursor);
      cursor += 1;

      if (operation.kind === 'read') {
        const view = viewAt(views, operation.queryIndex);
        recordRead(sample, operation.queryShape, () => consume(view.getSnapshot().rows), repeatMode);
        continue;
      }

      const result = await store.commit(operation.patch);
      if (result.status === 'rejected') {
        throw new Error(result.diagnostics.map((diagnostic) => diagnostic.message).join('; '));
      }
      sample.writes += 1;
      sample.rowsChanged += changedRows(result.effects.deltas);
      addWriteImpact(sample, relationWriteImpact(result.effects.deltas));
    }

    record(metric, sample, performance.now() - startedAt);
  };
}

const metricCleanup = new Map<ProbeMetrics, () => void>();

afterAll(() => {
  for (const cleanup of metricCleanup.values()) cleanup();
  metricCleanup.clear();
});

function makeQuerySpecs(): readonly QuerySpec[] {
  const lookup = accountIds.slice(0, QUERY_VARIANTS / 2).map((accountId) => ({
    shape: 'lookup' as const,
    query: pipe(
      from(entry),
      where(eq(entry.accountId, value(accountId))),
      project({ id: entry.id, accountId: entry.accountId, amount: entry.amount })
    ) as Query<unknown>
  }));
  const range = Array.from({ length: QUERY_VARIANTS / 3 }, (_, index) => -20_000 + index * 10_000).map((lower) => ({
    shape: 'range' as const,
    query: pipe(
      from(entry),
      where(gte(entry.amount, value(lower))),
      project({ id: entry.id, accountId: entry.accountId, amount: entry.amount, posted: entry.posted })
    ) as Query<unknown>
  }));
  const aggregateQuery = pipe(
    from(entry),
    aggregate({
      groupBy: { accountId: entry.accountId },
      aggregates: {
        entryCount: count(),
        total: sum(entry.amount)
      }
    }),
    sort(asc(field<string>('row', 'accountId')))
  ) as Query<unknown>;
  const topNQuery = pipe(
    from(entry),
    sortLimit(TOP_N_COUNT, desc(entry.amount), asc(entry.id)),
    project({ id: entry.id, accountId: entry.accountId, amount: entry.amount })
  ) as Query<unknown>;

  return [
    ...lookup,
    ...range,
    { shape: 'aggregate', query: aggregateQuery },
    { shape: 'topN', query: topNQuery }
  ];
}

function makeOperations(scenario: Scenario): readonly FuzzOperation[] {
  const next = createSeededRandom(scenario.seed);

  return Array.from({ length: MIX_LENGTH }, (_, index) => {
    if (weightedChoice(next, [
      { value: 'read' as const, weight: scenario.readWeight },
      { value: 'write' as const, weight: scenario.writeWeight }
    ]) === 'read') {
      const queryShape = weightedChoice(next, [
        { value: 'lookup' as const, weight: scenario.queryWeights.lookup },
        { value: 'range' as const, weight: scenario.queryWeights.range },
        { value: 'aggregate' as const, weight: scenario.queryWeights.aggregate },
        { value: 'topN' as const, weight: scenario.queryWeights.topN }
      ]);
      return {
        kind: 'read',
        queryShape,
        queryIndex: chooseQueryIndex(next, queryShape)
      };
    }

    return { kind: 'write', patch: makePatch(next, scenario, index) };
  });
}

function materializedQuerySet(
  specs: readonly QuerySpec[],
  operations: readonly FuzzOperation[]
): readonly Query<unknown>[] {
  const indexes = new Set<number>();
  for (const operation of operations) {
    if (operation.kind === 'read') indexes.add(operation.queryIndex);
  }
  return [...indexes].map((index) => queryAt(index, specs));
}

function makeDb(rowCount: number): Db {
  return createDb({
    accounts: accounts.map((row) => ({ ...row })),
    entries: makeEntries(rowCount)
  });
}

function makeEntries(count: number): Entry[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `entry-${index}`,
    accountId: accountIds[index % accountIds.length] ?? 'account-0',
    amount: amountAt(index),
    memo: index % 5 === 0 ? null : `memo-${index % 193}`,
    posted: index % 7 !== 0
  }));
}

function makePatch(next: SeededRandom, scenario: Scenario, index: number): WritePatch | readonly WritePatch[] {
  const rowIndex = Math.floor(next() * scenario.rowCount);
  const accountId = accountIds[Math.floor(next() * accountIds.length)] ?? 'account-0';
  const amount = amountAt(scenario.seed + rowIndex + index * 41);

  if (index % 5 !== 0) {
    return updateByKey(schema.entries, `entry-${rowIndex}`, {
      accountId,
      amount,
      memo: index % 3 === 0 ? null : `relative-${scenario.seed}-${index % 89}`,
      posted: index % 11 !== 0
    });
  }

  return [
    updateByKey(schema.entries, `entry-${rowIndex}`, {
      amount,
      posted: index % 13 !== 0
    }),
    insertOrReplace(schema.entries, {
      id: `scratch-${scenario.seed}-${index % 32}`,
      accountId,
      amount: amountAt(scenario.seed + index * 67),
      memo: index % 2 === 0 ? null : `scratch-${index % 89}`,
      posted: index % 3 !== 0
    })
  ];
}

function chooseQueryIndex(next: SeededRandom, shape: QueryShape): number {
  const indexes = querySpecs.flatMap((spec, index) => spec.shape === shape ? [index] : []);
  if (indexes.length === 0) throw new Error(`no query specs for ${shape}`);
  return indexes[Math.floor(next() * indexes.length)] ?? indexes[0] ?? 0;
}

function weightedChoice<const Value>(
  next: SeededRandom,
  choices: readonly { readonly value: Value; readonly weight: number }[]
): Value {
  const total = choices.reduce((sumValue, choice) => sumValue + choice.weight, 0);
  let pick = next() * total;

  for (const choice of choices) {
    pick -= choice.weight;
    if (pick <= 0) return choice.value;
  }

  const fallback = choices[choices.length - 1];
  if (fallback === undefined) throw new Error('cannot choose from an empty weighted list');
  return fallback.value;
}

function opAt(operations: readonly FuzzOperation[], index: number): FuzzOperation {
  const operation = operations[index % operations.length];
  if (operation === undefined) throw new Error('operation set is empty');
  return operation;
}

function queryAt(index: number, specs: readonly QuerySpec[] = querySpecs): Query<unknown> {
  const spec = specs[index];
  if (spec === undefined) throw new Error(`missing query spec ${index}`);
  return spec.query;
}

function viewAt(views: readonly StoreView<unknown>[], index: number): StoreView<unknown> {
  const view = views[index];
  if (view === undefined) throw new Error(`missing store view ${index}`);
  return view;
}

function changedRows(deltas: readonly { readonly added: readonly unknown[]; readonly removed: readonly unknown[] }[]): number {
  return deltas.reduce((sumValue, delta) => sumValue + Math.max(delta.added.length, delta.removed.length), 0);
}

function changedRelationsLowerBound(deltas: readonly { readonly relation: { readonly name: string } }[]): number {
  return new Set(deltas.map((delta) => delta.relation.name)).size;
}

type WriteImpact = {
  readonly effects: number;
  readonly outputRowChanges: number;
  readonly irrelevant: boolean;
  readonly incremental: number;
  readonly recomputed: number;
};

function relationWriteImpact(deltas: readonly { readonly added: readonly unknown[]; readonly removed: readonly unknown[]; readonly relation: { readonly name: string } }[]): WriteImpact {
  return {
    effects: changedRelationsLowerBound(deltas),
    outputRowChanges: changedRows(deltas),
    irrelevant: changedRows(deltas) === 0,
    incremental: 0,
    recomputed: 0
  };
}

function materializationWriteImpact(changes: readonly MaterializationMaintenanceChange[]): WriteImpact {
  const outputRowChanges = changes.reduce((sumValue, change) => sumValue + change.rowChanges.length, 0);
  return {
    effects: changes.length,
    outputRowChanges,
    irrelevant: changes.length > 0 && outputRowChanges === 0,
    incremental: changes.filter((change) => change.update === 'incremental').length,
    recomputed: changes.filter((change) => change.recomputed).length
  };
}

type SampleMetrics = Pick<
  ProbeMetrics,
  | 'reads'
  | 'readPasses'
  | 'writes'
  | 'rowsRead'
  | 'coldRowsRead'
  | 'hotRowsRead'
  | 'rowsChanged'
  | 'writeEffects'
  | 'outputRowChanges'
  | 'irrelevantWrites'
  | 'incrementalEffects'
  | 'recomputedEffects'
  | 'shapes'
>;

function addWriteImpact(sample: SampleMetrics, impact: WriteImpact): void {
  sample.writeEffects += impact.effects;
  sample.outputRowChanges += impact.outputRowChanges;
  sample.irrelevantWrites += impact.irrelevant ? 1 : 0;
  sample.incrementalEffects += impact.incremental;
  sample.recomputedEffects += impact.recomputed;
}

function repeatMode(repeat: number): 'cold' | 'hot' {
  return repeat === 0 ? 'cold' : 'hot';
}

function recordRead(
  sample: SampleMetrics,
  shape: QueryShape,
  readRows: (repeat: number) => number,
  modeForRepeat: (repeat: number) => 'cold' | 'hot'
): void {
  const shapeMetric = sample.shapes[shape];
  sample.reads += 1;
  shapeMetric.reads += 1;

  for (let repeat = 0; repeat < READ_REPEAT_COUNT; repeat += 1) {
    const rowCount = readRows(repeat);
    const mode = modeForRepeat(repeat);
    sample.readPasses += 1;
    sample.rowsRead += rowCount;
    if (mode === 'cold') {
      sample.coldRowsRead += rowCount;
      shapeMetric.coldPasses += 1;
      shapeMetric.coldRowsRead += rowCount;
    } else {
      sample.hotRowsRead += rowCount;
      shapeMetric.hotPasses += 1;
      shapeMetric.hotRowsRead += rowCount;
    }
  }
}

function registerMetrics(scenario: string, mode: ReadPathMode): ProbeMetrics {
  const metric: ProbeMetrics = {
    scenario,
    mode,
    samples: 0,
    operations: 0,
    reads: 0,
    readPasses: 0,
    writes: 0,
    rowsRead: 0,
    coldRowsRead: 0,
    hotRowsRead: 0,
    rowsChanged: 0,
    writeEffects: 0,
    outputRowChanges: 0,
    irrelevantWrites: 0,
    incrementalEffects: 0,
    recomputedEffects: 0,
    elapsedMs: 0,
    shapes: emptyShapeMetrics()
  };
  metrics.push(metric);
  return metric;
}

function emptyShapeMetrics(): Record<QueryShape, ShapeMetrics> {
  return {
    lookup: { reads: 0, coldPasses: 0, hotPasses: 0, coldRowsRead: 0, hotRowsRead: 0 },
    range: { reads: 0, coldPasses: 0, hotPasses: 0, coldRowsRead: 0, hotRowsRead: 0 },
    aggregate: { reads: 0, coldPasses: 0, hotPasses: 0, coldRowsRead: 0, hotRowsRead: 0 },
    topN: { reads: 0, coldPasses: 0, hotPasses: 0, coldRowsRead: 0, hotRowsRead: 0 }
  };
}

function emptySample(): SampleMetrics {
  return {
    reads: 0,
    readPasses: 0,
    writes: 0,
    rowsRead: 0,
    coldRowsRead: 0,
    hotRowsRead: 0,
    rowsChanged: 0,
    writeEffects: 0,
    outputRowChanges: 0,
    irrelevantWrites: 0,
    incrementalEffects: 0,
    recomputedEffects: 0,
    shapes: emptyShapeMetrics()
  };
}

function record(
  metric: ProbeMetrics,
  sample: SampleMetrics,
  elapsedMs: number
): void {
  metric.samples += 1;
  metric.operations += SAMPLE_OPS;
  metric.reads += sample.reads;
  metric.readPasses += sample.readPasses;
  metric.writes += sample.writes;
  metric.rowsRead += sample.rowsRead;
  metric.coldRowsRead += sample.coldRowsRead;
  metric.hotRowsRead += sample.hotRowsRead;
  metric.rowsChanged += sample.rowsChanged;
  metric.writeEffects += sample.writeEffects;
  metric.outputRowChanges += sample.outputRowChanges;
  metric.irrelevantWrites += sample.irrelevantWrites;
  metric.incrementalEffects += sample.incrementalEffects;
  metric.recomputedEffects += sample.recomputedEffects;
  metric.elapsedMs += elapsedMs;

  for (const shape of queryShapes) {
    const target = metric.shapes[shape];
    const source = sample.shapes[shape];
    target.reads += source.reads;
    target.coldPasses += source.coldPasses;
    target.hotPasses += source.hotPasses;
    target.coldRowsRead += source.coldRowsRead;
    target.hotRowsRead += source.hotRowsRead;
  }
}

const queryShapes: readonly QueryShape[] = ['lookup', 'range', 'aggregate', 'topN'];

function shapeRows(): readonly Record<string, string | number>[] {
  return metrics.flatMap((metric) => queryShapes.map((shape) => {
    const shapeMetric = metric.shapes[shape];
    return {
      scenario: metric.scenario,
      mode: metric.mode,
      shape,
      reads: shapeMetric.reads,
      readPassMode: `cold+${READ_REPEAT_COUNT - 1} hot`,
      coldRowsPerRead: ratio(shapeMetric.coldRowsRead, shapeMetric.reads),
      hotRowsPerRead: ratio(shapeMetric.hotRowsRead, shapeMetric.reads),
      hotRowsPerHotPass: ratio(shapeMetric.hotRowsRead, shapeMetric.hotPasses)
    };
  })).filter((row) => row.reads !== 0);
}

function ratioRows(): readonly Record<string, string>[] {
  const rows: Record<string, string>[] = [];
  const grouped = groupMetricsByScenario(metrics);

  for (const [scenario, scenarioMetrics] of grouped) {
    const recompute = scenarioMetrics.find((item) => item.mode === 'recompute');
    const materialized = scenarioMetrics.find((item) => item.mode === 'materialized');
    const storeView = scenarioMetrics.find((item) => item.mode === 'store-view');
    if (recompute !== undefined && materialized !== undefined) {
      rows.push(compareRow(scenario, 'recompute/materialized', recompute, materialized));
    }
    if (storeView !== undefined && materialized !== undefined) {
      rows.push(compareRow(scenario, 'store-view/materialized', storeView, materialized));
    }
    if (recompute !== undefined && storeView !== undefined) {
      rows.push(compareRow(scenario, 'recompute/store-view', recompute, storeView));
    }
  }

  return rows;
}

function groupMetricsByScenario(items: readonly ProbeMetrics[]): ReadonlyMap<string, readonly ProbeMetrics[]> {
  const grouped = new Map<string, ProbeMetrics[]>();
  for (const item of items) {
    const scenarioMetrics = grouped.get(item.scenario);
    if (scenarioMetrics === undefined) {
      grouped.set(item.scenario, [item]);
    } else {
      scenarioMetrics.push(item);
    }
  }
  return grouped;
}

function compareRow(scenario: string, comparison: string, left: ProbeMetrics, right: ProbeMetrics): Record<string, string> {
  return {
    scenario,
    comparison,
    usPerOpRatio: ratioNumber(usPerOp(left), usPerOp(right)),
    usPerReturnedRowRatio: ratioNumber(usPerReturnedRow(left), usPerReturnedRow(right)),
    rowsReadPerReadRatio: ratioNumber(left.rowsRead / Math.max(1, left.reads), right.rowsRead / Math.max(1, right.reads)),
    rowsChangedPerWriteRatio: ratioNumber(left.rowsChanged / Math.max(1, left.writes), right.rowsChanged / Math.max(1, right.writes)),
    writeEffectsPerWriteRatio: ratioNumber(
      left.writeEffects / Math.max(1, left.writes),
      right.writeEffects / Math.max(1, right.writes)
    ),
    outputRowChangesPerWriteRatio: ratioNumber(
      left.outputRowChanges / Math.max(1, left.writes),
      right.outputRowChanges / Math.max(1, right.writes)
    )
  };
}

function amountAt(index: number): number {
  return ((index * 7_919) % 100_000) - 50_000;
}

function consume(rows: readonly unknown[]): number {
  rowSink = (rowSink + rows.length) % Number.MAX_SAFE_INTEGER;
  if (rowSink < 0) throw new Error('unreachable benchmark sink');
  return rows.length;
}

function ratio(valueValue: number, count: number): string {
  return (valueValue / Math.max(1, count)).toFixed(2);
}

function ratioNumber(left: number, right: number): string {
  return (left / Math.max(Number.EPSILON, right)).toFixed(2);
}

function ms(valueValue: number): string {
  return `${valueValue.toFixed(2)} ms`;
}

function micros(elapsedMs: number, count: number): string {
  return (elapsedMs * 1_000 / Math.max(1, count)).toFixed(2);
}

function usPerOp(metric: ProbeMetrics): number {
  return metric.elapsedMs * 1_000 / Math.max(1, metric.operations);
}

function usPerReturnedRow(metric: ProbeMetrics): number {
  return metric.elapsedMs * 1_000 / Math.max(1, metric.rowsRead);
}
