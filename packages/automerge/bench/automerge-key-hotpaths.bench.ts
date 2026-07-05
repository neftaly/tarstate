import * as Automerge from '@automerge/automerge';
import { bench, describe } from 'vitest';
import {
  customField,
  defineSchema,
  numberField,
  relation,
  stringField
} from '@tarstate/core/schema';
import { automergeMapAdapter, defineAutomergeMapRelations } from '@tarstate/automerge';
import { stableSize, valueAt } from './bench-helpers.js';

type RichKey = {
  readonly objectId: string;
  readonly text: string;
};

type RichRow = {
  readonly id: RichKey;
  readonly title: string;
  readonly rank: number;
};

type RichDoc = {
  readonly rowsById: Readonly<Record<string, RichRow>>;
};

const ROW_COUNT = 1_200;
const KEY_VARIANT_COUNT = 160;
const SAMPLE_OPS = 24;
const BENCH_OPTIONS = {
  time: 90,
  iterations: 4,
  warmupTime: 15,
  warmupIterations: 1
};

const automergeKeyBenchmarkSchema = defineSchema({
  richRows: relation<RichRow>({
    key: 'id',
    fields: {
      id: customField<RichKey>({
        codec: 'bench.richKey',
        validate: isRichKey,
        toScalar: richKeyScalar
      }),
      title: stringField(),
      rank: numberField()
    }
  })
});

const automergeKeyBenchmarkRelations = defineAutomergeMapRelations<RichDoc>()([
  { relation: automergeKeyBenchmarkSchema.richRows, path: ['rowsById'] }
]);
const benchmarkRows = makeRows();
const benchmarkDoc = Automerge.from<RichDoc>({
  rowsById: Object.fromEntries(benchmarkRows.map((rowValue) => [rowValue.id.objectId, rowValue]))
});
const benchmarkAdapter = automergeMapAdapter({
  doc: benchmarkDoc,
  relations: automergeKeyBenchmarkRelations,
  runtimeId: 'automerge-key-hotpaths'
});
const lookupKeys = Array.from({ length: KEY_VARIANT_COUNT }, (_, index) =>
  `rich-${(index * 37) % ROW_COUNT}`);
const prebuiltRowsByKey = new Map(benchmarkRows.map((rowValue) => [rowValue.id.objectId, [rowValue] as readonly RichRow[]]));
let benchmarkSink = 0;

describe('Automerge custom key hotpaths', () => {
  bench('adapter.objectIdFor custom toScalar key', adapterObjectIdForProbe(), BENCH_OPTIONS);
  bench('direct Automerge map object id', directObjectIdProbe(), BENCH_OPTIONS);
  bench('source.lookup custom toScalar key', sourceLookupProbe(), BENCH_OPTIONS);
  bench('prebuilt key bucket lookup', prebuiltLookupProbe(), BENCH_OPTIONS);
});

function adapterObjectIdForProbe(): () => void {
  let cursor = 0;

  return () => {
    for (let index = 0; index < SAMPLE_OPS; index += 1) {
      consumeValue(benchmarkAdapter.objectIdFor(automergeKeyBenchmarkSchema.richRows, valueAt(lookupKeys, cursor)));
      cursor += 1;
    }
  };
}

function directObjectIdProbe(): () => void {
  let cursor = 0;

  return () => {
    for (let index = 0; index < SAMPLE_OPS; index += 1) {
      const rowValue = benchmarkDoc.rowsById[valueAt(lookupKeys, cursor)];
      cursor += 1;
      consumeValue(rowValue === undefined ? null : Automerge.getObjectId(rowValue));
    }
  };
}

function sourceLookupProbe(): () => void {
  let cursor = 0;
  consumeRows(benchmarkAdapter.source.lookup?.({
    relation: automergeKeyBenchmarkSchema.richRows,
    field: 'id',
    value: valueAt(lookupKeys, cursor)
  }) ?? []);

  return () => {
    for (let index = 0; index < SAMPLE_OPS; index += 1) {
      consumeRows(benchmarkAdapter.source.lookup?.({
        relation: automergeKeyBenchmarkSchema.richRows,
        field: 'id',
        value: valueAt(lookupKeys, cursor)
      }) ?? []);
      cursor += 1;
    }
  };
}

function prebuiltLookupProbe(): () => void {
  let cursor = 0;

  return () => {
    for (let index = 0; index < SAMPLE_OPS; index += 1) {
      consumeRows(prebuiltRowsByKey.get(valueAt(lookupKeys, cursor)) ?? []);
      cursor += 1;
    }
  };
}

function makeRows(): readonly RichRow[] {
  return Array.from({ length: ROW_COUNT }, (_, index) => ({
    id: { objectId: `rich-${index}`, text: `Rich ${index}` },
    title: `Row ${index}`,
    rank: (index * 17) % 1_000
  }));
}

function richKeyScalar(value: unknown): string | null {
  return isRichKey(value) ? value.objectId : null;
}

function isRichKey(value: unknown): value is RichKey {
  return typeof value === 'object'
    && value !== null
    && !Array.isArray(value)
    && typeof (value as { readonly objectId?: unknown }).objectId === 'string'
    && typeof (value as { readonly text?: unknown }).text === 'string';
}

function consumeRows(values: readonly unknown[]): void {
  benchmarkSink = (benchmarkSink + values.length) % Number.MAX_SAFE_INTEGER;
  if (benchmarkSink < 0) throw new Error('unreachable benchmark sink');
}

function consumeValue(value: unknown): void {
  benchmarkSink = (benchmarkSink + stableSize(value)) % Number.MAX_SAFE_INTEGER;
  if (benchmarkSink < 0) throw new Error('unreachable benchmark sink');
}
