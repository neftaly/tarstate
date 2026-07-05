import { afterAll, bench, describe } from 'vitest';
import { createDb, row, transact, type Db } from '@tarstate/core/db';
import {
  customField,
  defineSchema,
  numberField,
  relation,
  stringField
} from '@tarstate/core/schema';
import { incrementByKey, updateByKey, type RelationKeyInput, type WritePatch } from '@tarstate/core/write';

type PrimitiveKeyRow = {
  readonly id: string;
  readonly label: string;
  readonly visits: number;
};

type CompositeKeyRow = {
  readonly tenant: string;
  readonly localId: number;
  readonly label: string;
  readonly visits: number;
};

type RichKey = {
  readonly objectId: string;
  readonly text: string;
  readonly version: number;
};

type RichKeyRow = {
  readonly id: RichKey;
  readonly label: string;
  readonly visits: number;
};

type CaseFoldedKeyRow = {
  readonly id: string;
  readonly label: string;
  readonly visits: number;
};

type RelationKeyBenchmarkMetric = {
  readonly label: string;
  readonly rowCount: number;
  readonly keyCount: number;
};

const ROW_COUNT = 20_000;
const KEY_COUNT = 1_024;
const BENCH_OPTIONS = {
  time: 200,
  iterations: 12,
  warmupTime: 40,
  warmupIterations: 3
};

const relationKeyBenchmarkSchema = defineSchema({
  primitiveRows: relation<PrimitiveKeyRow, 'id'>({
    key: 'id',
    fields: {
      id: stringField(),
      label: stringField(),
      visits: numberField()
    }
  }),
  compositeRows: relation<CompositeKeyRow, readonly ['tenant', 'localId']>({
    key: ['tenant', 'localId'] as const,
    fields: {
      tenant: stringField(),
      localId: numberField(),
      label: stringField(),
      visits: numberField()
    }
  }),
  stableObjectRows: relation<RichKeyRow, 'id'>({
    key: 'id',
    fields: {
      id: customField<RichKey>({
        codec: 'stableObjectKey',
        validate: isRichKey,
        stableKey: richKeyStableKey
      }),
      label: stringField(),
      visits: numberField()
    }
  }),
  scalarObjectRows: relation<RichKeyRow, 'id'>({
    key: 'id',
    fields: {
      id: customField<RichKey>({
        codec: 'scalarObjectKey',
        validate: isRichKey,
        toScalar: richKeyScalar
      }),
      label: stringField(),
      visits: numberField()
    }
  }),
  caseFoldedRows: relation<CaseFoldedKeyRow, 'id'>({
    key: 'id',
    fields: {
      id: customField<string>({
        codec: 'caseFoldedKey',
        validate: (value): value is string => typeof value === 'string',
        toScalar: caseFoldedScalar
      }),
      label: stringField(),
      visits: numberField()
    }
  })
});

const benchmarkFixture = makeRelationKeyBenchmarkFixture();
const benchmarkMetrics: RelationKeyBenchmarkMetric[] = [];
let benchmarkSink = 0;

describe('core relation key lookup paths', () => {
  bench('row primitive single-field key', recordBenchmark('primitive row', keyedRowLookup(
    benchmarkFixture.primitiveKeys,
    (key) => row(benchmarkFixture.db, relationKeyBenchmarkSchema.primitiveRows, key)
  )), BENCH_OPTIONS);

  bench('row custom toScalar primitive key', recordBenchmark('toScalar primitive row', keyedRowLookup(
    benchmarkFixture.caseFoldedKeys,
    (key) => row(benchmarkFixture.db, relationKeyBenchmarkSchema.caseFoldedRows, key)
  )), BENCH_OPTIONS);

  bench('row custom toScalar object key', recordBenchmark('toScalar object row', keyedRowLookup(
    benchmarkFixture.scalarObjectKeys,
    (key) => row(benchmarkFixture.db, relationKeyBenchmarkSchema.scalarObjectRows, key)
  )), BENCH_OPTIONS);

  bench('row composite key scan', recordBenchmark('composite row', keyedRowLookup(
    benchmarkFixture.compositeKeys,
    (key) => row(benchmarkFixture.db, relationKeyBenchmarkSchema.compositeRows, key)
  )), BENCH_OPTIONS);

  bench('row custom stableKey scan', recordBenchmark('stableKey row', keyedRowLookup(
    benchmarkFixture.stableObjectKeys,
    (key) => row(benchmarkFixture.db, relationKeyBenchmarkSchema.stableObjectRows, key)
  )), BENCH_OPTIONS);

  bench('write updateByKey primitive key', recordBenchmark('primitive write', writeByKey(
    benchmarkFixture.db,
    benchmarkFixture.primitivePatches
  )), BENCH_OPTIONS);

  bench('write updateByKey custom stableKey', recordBenchmark('stableKey write', writeByKey(
    benchmarkFixture.db,
    benchmarkFixture.stableObjectPatches
  )), BENCH_OPTIONS);

  bench('write incrementByKey custom toScalar object', recordBenchmark('toScalar object write', writeByKey(
    benchmarkFixture.db,
    benchmarkFixture.scalarObjectPatches
  )), BENCH_OPTIONS);
});

afterAll(() => {
  if (benchmarkMetrics.length > 0) console.table(benchmarkMetrics);
  if (benchmarkSink < 0) throw new Error('unreachable benchmark sink');
});

function keyedRowLookup<Key extends RelationKeyInput>(
  keys: readonly Key[],
  lookup: (key: Key) => unknown
): () => void {
  let cursor = 0;

  return () => {
    const key = keys[cursor % keys.length];
    if (key === undefined) throw new Error('benchmark key set is empty');
    cursor += 1;
    const rowValue = lookup(key);
    if (rowValue !== undefined) consumeBenchmarkValue(rowValue);
    else consumeBenchmarkValue(key);
  };
}

function writeByKey(db: Db, patches: readonly WritePatch[]): () => void {
  let cursor = 0;

  return () => {
    const patch = patches[cursor % patches.length];
    if (patch === undefined) throw new Error('benchmark patch set is empty');
    cursor += 1;
    const result = transact(db, patch);
    consumeBenchmarkValue(result.data[patch.relation.name]?.length ?? 0);
  };
}

function recordBenchmark(label: string, fn: () => void): () => void {
  benchmarkMetrics.push({ label, rowCount: ROW_COUNT, keyCount: KEY_COUNT });
  return fn;
}

function makeRelationKeyBenchmarkFixture(): {
  readonly db: Db;
  readonly primitiveKeys: readonly string[];
  readonly compositeKeys: readonly (readonly [string, number])[];
  readonly stableObjectKeys: readonly string[];
  readonly scalarObjectKeys: readonly string[];
  readonly caseFoldedKeys: readonly string[];
  readonly primitivePatches: readonly WritePatch[];
  readonly stableObjectPatches: readonly WritePatch[];
  readonly scalarObjectPatches: readonly WritePatch[];
} {
  const primitiveRows = Array.from({ length: ROW_COUNT }, (_, index): PrimitiveKeyRow => ({
    id: primitiveKey(index),
    label: `primitive-${index}`,
    visits: index % 17
  }));
  const compositeRows = Array.from({ length: ROW_COUNT }, (_, index): CompositeKeyRow => ({
    tenant: tenantFor(index),
    localId: index,
    label: `composite-${index}`,
    visits: index % 19
  }));
  const stableObjectRows = Array.from({ length: ROW_COUNT }, (_, index): RichKeyRow => ({
    id: richKey(index, 'stable'),
    label: `stable-${index}`,
    visits: index % 23
  }));
  const scalarObjectRows = Array.from({ length: ROW_COUNT }, (_, index): RichKeyRow => ({
    id: richKey(index, 'scalar'),
    label: `scalar-${index}`,
    visits: index % 29
  }));
  const caseFoldedRows = Array.from({ length: ROW_COUNT }, (_, index): CaseFoldedKeyRow => ({
    id: ` Key ${index} `,
    label: `case-${index}`,
    visits: index % 31
  }));

  return {
    db: createDb({
      primitiveRows,
      compositeRows,
      stableObjectRows,
      scalarObjectRows,
      caseFoldedRows
    }),
    primitiveKeys: lookupIndexes().map(primitiveKey),
    compositeKeys: lookupIndexes().map((index) => [tenantFor(index), index] as const),
    stableObjectKeys: lookupIndexes().map((index) => richKey(index, 'stable').objectId),
    scalarObjectKeys: lookupIndexes().map((index) => richKey(index, 'scalar').objectId),
    caseFoldedKeys: lookupIndexes().map((index) => ` KEY ${index} `),
    primitivePatches: lookupIndexes().map((index) =>
      updateByKey(relationKeyBenchmarkSchema.primitiveRows, primitiveKey(index), { label: `primitive-updated-${index}` })),
    stableObjectPatches: lookupIndexes().map((index) =>
      updateByKey(relationKeyBenchmarkSchema.stableObjectRows, richKey(index, 'stable').objectId, { label: `stable-updated-${index}` })),
    scalarObjectPatches: lookupIndexes().map((index) =>
      incrementByKey(relationKeyBenchmarkSchema.scalarObjectRows, richKey(index, 'scalar').objectId, 'visits', 1))
  };
}

function lookupIndexes(): readonly number[] {
  return Array.from({ length: KEY_COUNT }, (_, index) => (index * 97) % ROW_COUNT);
}

function primitiveKey(index: number): string {
  return `row-${index}`;
}

function tenantFor(index: number): string {
  return `tenant-${index % 64}`;
}

function richKey(index: number, kind: 'stable' | 'scalar'): RichKey {
  return {
    objectId: `${kind}:${index}`,
    text: `Text ${index}`,
    version: index % 41
  };
}

function richKeyStableKey(value: unknown): string {
  return isRichKey(value) ? value.objectId : String(value);
}

function richKeyScalar(value: unknown): string | null {
  return isRichKey(value) ? value.objectId : null;
}

function caseFoldedScalar(value: unknown): string {
  return String(value).trim().toLowerCase();
}

function consumeBenchmarkValue(input: unknown): void {
  if (typeof input === 'number') {
    benchmarkSink = (benchmarkSink + input) % Number.MAX_SAFE_INTEGER;
    return;
  }
  if (Array.isArray(input)) {
    benchmarkSink = (benchmarkSink + input.length) % Number.MAX_SAFE_INTEGER;
    return;
  }
  if (typeof input === 'object' && input !== null) {
    benchmarkSink = (benchmarkSink + Object.keys(input).length) % Number.MAX_SAFE_INTEGER;
    return;
  }
  benchmarkSink = (benchmarkSink + String(input).length) % Number.MAX_SAFE_INTEGER;
}

function isRichKey(input: unknown): input is RichKey {
  return typeof input === 'object'
    && input !== null
    && 'objectId' in input
    && typeof input.objectId === 'string'
    && 'text' in input
    && typeof input.text === 'string'
    && 'version' in input
    && typeof input.version === 'number'
    && Number.isFinite(input.version);
}
