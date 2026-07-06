import * as Automerge from '@automerge/automerge';
import { describe, expect, it } from 'vitest';
import {
  createDb,
  exists,
  q,
  row,
  tryTransact,
  type Db
} from '@tarstate/core';
import {
  booleanField,
  customField,
  defineSchema,
  numberField,
  relation,
  stringField,
  type RelationRef
} from '@tarstate/core/schema';
import { write, type WritePatch } from '@tarstate/core/write';
import {
  automergeCounterField,
  automergeMapAdapter,
  defineAutomergeMapRelations,
  type AutomergeMapAdapter
} from '@tarstate/automerge';
import { canonicalRows, choose, mulberry32, randomInt } from './fuzz-helpers.js';

type RichKey = {
  readonly objectId: string;
  readonly text: string;
};

type KeyedRow<Key> = {
  readonly id: Key;
  readonly label: string;
  readonly visits: number;
};

type CompositeRow = {
  readonly tenant: string;
  readonly local: number;
  readonly label: string;
  readonly visits: number;
};
type ComparableMarkerRow = {
  readonly id: string;
  readonly marker: RichKey;
  readonly label: string;
};
type ComparableMarkerDoc = {
  readonly rows: readonly ComparableMarkerRow[];
};

type RelationKeyProbe = {
  readonly label: string;
  readonly key: unknown;
  readonly existing: boolean;
  readonly invalidForWrite?: boolean;
};
type RelationKeyCase = {
  readonly label: string;
  readonly relation: RelationRef;
  readonly probes: readonly RelationKeyProbe[];
};
type RelationKeyOperation = 'updateByKey' | 'incrementByKey' | 'deleteByKey';

type KeyDoc = {
  readonly stringsById: Readonly<Record<string, NativeKeyedRow<string>>>;
  readonly numbers: readonly NativeKeyedRow<number>[];
  readonly booleansById: Readonly<Record<string, NativeKeyedRow<boolean>>>;
  readonly compositesById: Readonly<Record<string, NativeCompositeRow>>;
  readonly stableObjectsById: Readonly<Record<string, NativeKeyedRow<RichKey>>>;
  readonly scalarObjectsById: Readonly<Record<string, NativeKeyedRow<RichKey>>>;
};

type NativeKeyedRow<Key> = Omit<KeyedRow<Key>, 'visits'> & {
  readonly visits: Automerge.Counter;
};
type NativeCompositeRow = Omit<CompositeRow, 'visits'> & {
  readonly visits: Automerge.Counter;
};

const richKey = (objectId: string, text: string): RichKey => ({ objectId, text });
const richKeyStableKey = (value: unknown): string =>
  isRichKey(value) ? value.objectId : '';
const richKeyScalar = (value: unknown): string | null =>
  isRichKey(value) ? value.objectId : null;
const compareRichKeysOnly = (left: unknown, right: unknown): number => {
  if (!isRichKey(left) || !isRichKey(right)) throw new Error('compareRichKeysOnly expects rich keys');
  return left.objectId.localeCompare(right.objectId);
};

const keySemanticsSchema = defineSchema({
  strings: relation<KeyedRow<string>>({
    key: 'id',
    fields: {
      id: stringField(),
      label: stringField(),
      visits: automergeCounterField({ codec: 'app.counter' })
    }
  }),
  numbers: relation<KeyedRow<number>>({
    key: 'id',
    fields: {
      id: numberField(),
      label: stringField(),
      visits: automergeCounterField({ codec: 'app.counter' })
    }
  }),
  booleans: relation<KeyedRow<boolean>>({
    key: 'id',
    fields: {
      id: booleanField(),
      label: stringField(),
      visits: automergeCounterField({ codec: 'app.counter' })
    }
  }),
  composites: relation<CompositeRow, readonly ['tenant', 'local']>({
    key: ['tenant', 'local'] as const,
    fields: {
      tenant: stringField(),
      local: numberField(),
      label: stringField(),
      visits: automergeCounterField({ codec: 'app.counter' })
    }
  }),
  stableObjects: relation<KeyedRow<RichKey>>({
    key: 'id',
    fields: {
      id: customField<RichKey>({
        codec: 'rich.stable',
        validate: isRichKey,
        stableKey: richKeyStableKey
      }),
      label: stringField(),
      visits: automergeCounterField({ codec: 'app.counter' })
    }
  }),
  scalarObjects: relation<KeyedRow<RichKey>>({
    key: 'id',
    fields: {
      id: customField<RichKey>({
        codec: 'rich.scalar',
        validate: isRichKey,
        toScalar: richKeyScalar
      }),
      label: stringField(),
      visits: automergeCounterField({ codec: 'app.counter' })
    }
  })
});

const fuzzSeeds = [0x51a7_0001, 0x51a7_0002, 0x51a7_0003] as const;
const keyOperations = ['updateByKey', 'incrementByKey', 'deleteByKey'] as const;
const relationKeyCases: readonly RelationKeyCase[] = [
  {
    label: 'string',
    relation: keySemanticsSchema.strings,
    probes: [
      { label: 'existing alpha', key: 'alpha', existing: true },
      { label: 'existing empty', key: '', existing: true },
      { label: 'missing', key: 'missing-string', existing: false },
      { label: 'invalid object', key: { id: 'alpha' }, existing: false, invalidForWrite: true }
    ]
  },
  {
    label: 'number',
    relation: keySemanticsSchema.numbers,
    probes: [
      { label: 'existing zero', key: 0, existing: true },
      { label: 'existing fractional', key: 42.5, existing: true },
      { label: 'missing', key: 7_777, existing: false },
      { label: 'invalid non-finite', key: Number.POSITIVE_INFINITY, existing: false, invalidForWrite: true }
    ]
  },
  {
    label: 'boolean',
    relation: keySemanticsSchema.booleans,
    probes: [
      { label: 'existing true', key: true, existing: true },
      { label: 'existing false', key: false, existing: true },
      { label: 'invalid string', key: 'true', existing: false },
      { label: 'invalid object', key: { id: true }, existing: false, invalidForWrite: true }
    ]
  },
  {
    label: 'composite',
    relation: keySemanticsSchema.composites,
    probes: [
      { label: 'existing acme', key: ['acme', 1], existing: true },
      { label: 'existing beta', key: ['beta', 2], existing: true },
      { label: 'missing', key: ['acme', 99], existing: false },
      { label: 'invalid scalar', key: 'acme', existing: false, invalidForWrite: true },
      { label: 'invalid arity', key: ['acme'], existing: false, invalidForWrite: true }
    ]
  },
  {
    label: 'custom stableKey',
    relation: keySemanticsSchema.stableObjects,
    probes: [
      { label: 'existing rich-1', key: 'rich-1', existing: true },
      { label: 'existing rich-2', key: 'rich-2', existing: true },
      { label: 'missing', key: 'rich-missing', existing: false },
      { label: 'invalid object', key: richKey('rich-1', 'Alpha'), existing: false, invalidForWrite: true }
    ]
  },
  {
    label: 'custom toScalar',
    relation: keySemanticsSchema.scalarObjects,
    probes: [
      { label: 'existing scalar-1', key: 'scalar-1', existing: true },
      { label: 'existing scalar-2', key: 'scalar-2', existing: true },
      { label: 'missing', key: 'scalar-missing', existing: false },
      { label: 'invalid object', key: richKey('scalar-1', 'Alpha'), existing: false, invalidForWrite: true }
    ]
  }
];

describe('automerge key semantics fuzz', () => {
  it.each(fuzzSeeds)('matches core row/exists/object-id semantics %#', (seed) => {
    const random = mulberry32(seed);

    for (let step = 0; step < 72; step += 1) {
      const relationKeyCase = choose(random, relationKeyCases);
      const probe = choose(random, relationKeyCase.probes);
      const db = createDb(coreFixtureData());
      const adapter = createKeySemanticsAdapter();

      assertReadParity(adapter, db, relationKeyCase, probe, `seed ${seed} step ${step}`);
    }
  });

  it.each(fuzzSeeds)('matches core update/increment/delete key semantics %#', async (seed) => {
    const random = mulberry32(seed);

    for (let step = 0; step < 96; step += 1) {
      const relationKeyCase = choose(random, relationKeyCases);
      const probe = choose(random, relationKeyCase.probes);
      const operation = choose(random, keyOperations);
      const db = createDb(coreFixtureData());
      const adapter = createKeySemanticsAdapter();
      const patch = patchForKeyOperation(relationKeyCase.relation, probe.key, operation, seed, step, random);
      const coreResult = tryTransact(db, patch);
      const automergeResult = await adapter.target.apply([patch]);
      const expectedRejected = hasErrorDiagnostics(coreResult.diagnostics);
      const label = `seed ${seed} step ${step} ${relationKeyCase.label} ${probe.label} ${operation}`;

      expect(automergeResult.status, label).toBe(expectedRejected ? 'rejected' : 'accepted');
      if (expectedRejected) {
        expect(automergeResult.diagnostics.length, label).toBeGreaterThan(0);
      } else {
        expect(automergeResult.diagnostics, label).toEqual([]);
      }

      const expectedDb = expectedRejected ? db : coreResult.db;
      assertRowsParity(adapter, expectedDb, relationKeyCase.relation, label);
      assertReadParity(adapter, expectedDb, relationKeyCase, probe, `${label} after`);
    }
  });

  it('rejects and replaces primitive custom stableKey rows by canonical row identity', async () => {
    const foldedSchema = defineSchema({
      rows: relation<KeyedRow<string>>({
        key: 'id',
        fields: {
          id: customField<string>({
            codec: 'folded.stable',
            validate: (value): value is string => typeof value === 'string',
            stableKey: (value) => String(value).toLowerCase()
          }),
          label: stringField(),
          visits: automergeCounterField()
        }
      })
    });
    const adapter = automergeMapAdapter({
      doc: Automerge.from({
        rowsById: {
          alpha: nativeRow({ id: 'Alpha', label: 'Original', visits: 1 })
        }
      }),
      relations: defineAutomergeMapRelations<{ readonly rowsById: Readonly<Record<string, NativeKeyedRow<string>>> }>()([
        { relation: foldedSchema.rows, path: ['rowsById'] }
      ])
    });

    const duplicate = await adapter.target.apply([
      write(foldedSchema.rows).insert({ id: 'ALPHA', label: 'Duplicate', visits: 2 })
    ]);
    expect(duplicate.status).toBe('rejected');
    expect(duplicate.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'unique', relation: foldedSchema.rows.name })
    ]));

    const replace = await adapter.target.apply([
      write(foldedSchema.rows).insertOrReplace({ id: 'ALPHA', label: 'Replacement', visits: 3 })
    ]);
    expect(replace.status).toBe('accepted');
    expect(adapter.source.rows(foldedSchema.rows)).toEqual([
      { id: 'ALPHA', label: 'Replacement', visits: 3 }
    ]);
  });

  it('looks up and ranges decoded custom toScalar fields by scalar and host values', () => {
    const adapter = createKeySemanticsAdapter();
    const expected = [{ id: 'scalar-1', label: 'Scalar Alpha', visits: 11 }];

    expect(adapter.source.lookup?.({
      relation: keySemanticsSchema.scalarObjects,
      field: 'id',
      value: 'scalar-1'
    })).toEqual(expected);
    expect(adapter.source.lookup?.({
      relation: keySemanticsSchema.scalarObjects,
      field: 'id',
      value: richKey('scalar-1', 'Equivalent host value')
    })).toEqual(expected);
    expect(adapter.source.rangeLookup?.({
      relation: keySemanticsSchema.scalarObjects,
      field: 'id',
      lower: { value: 'scalar-1', inclusive: true },
      upper: { value: 'scalar-2', inclusive: false }
    })).toEqual(expected);
    expect(adapter.source.rangeLookup?.({
      relation: keySemanticsSchema.scalarObjects,
      field: 'id',
      lower: { value: richKey('scalar-1', 'Lower host value'), inclusive: true },
      upper: { value: richKey('scalar-2', 'Upper host value'), inclusive: false }
    })).toEqual(expected);
  });

  it('matches decoded custom toScalar fields with strict host-value comparators', () => {
    const comparableSchema = defineSchema({
      rows: relation<ComparableMarkerRow>({
        key: 'id',
        fields: {
          id: stringField(),
          marker: customField<RichKey>({
            codec: 'rich.scalar.compare',
            validate: isRichKey,
            toScalar: richKeyScalar,
            compare: compareRichKeysOnly
          }),
          label: stringField()
        }
      })
    });
    const adapter = automergeMapAdapter({
      doc: Automerge.from<ComparableMarkerDoc>({
        rows: [
          { id: 'row-1', marker: richKey('marker-1', 'Original'), label: 'Original' },
          { id: 'row-2', marker: richKey('marker-3', 'Later'), label: 'Later' }
        ]
      }),
      relations: defineAutomergeMapRelations<ComparableMarkerDoc>()([
        { relation: comparableSchema.rows, path: ['rows'] }
      ])
    });
    const expected = [{ id: 'row-1', marker: 'marker-1', label: 'Original' }];

    expect(adapter.source.lookup?.({
      relation: comparableSchema.rows,
      field: 'marker',
      value: 'marker-1'
    })).toEqual(expected);
    expect(adapter.source.lookup?.({
      relation: comparableSchema.rows,
      field: 'marker',
      value: richKey('marker-1', 'Equivalent host value')
    })).toEqual(expected);
    expect(adapter.source.rangeLookup?.({
      relation: comparableSchema.rows,
      field: 'marker',
      lower: { value: richKey('marker-1', 'Lower host value'), inclusive: true },
      upper: { value: richKey('marker-2', 'Upper host value'), inclusive: false }
    })).toEqual(expected);
  });

  it('rejects custom key toScalar outputs that are not finite scalar values', async () => {
    const invalidScalarCases = [
      { label: 'null', toScalar: () => null },
      { label: 'non-finite number', toScalar: () => Number.POSITIVE_INFINITY },
      { label: 'object', toScalar: () => ({ objectId: 'bad' }) as never },
      { label: 'array', toScalar: () => ['bad'] as never }
    ] as const;

    for (const invalidScalarCase of invalidScalarCases) {
      const invalidSchema = defineSchema({
        rows: relation<KeyedRow<RichKey>>({
          key: 'id',
          fields: {
            id: customField<RichKey>({
              codec: `invalid.${invalidScalarCase.label}`,
              validate: isRichKey,
              toScalar: invalidScalarCase.toScalar
            }),
            label: stringField(),
            visits: automergeCounterField()
          }
        })
      });
      const invalidRelations = defineAutomergeMapRelations<{ readonly rows: readonly NativeKeyedRow<RichKey>[] }>()([
        { relation: invalidSchema.rows, path: ['rows'] }
      ]);
      const invalidRow = { id: richKey(`bad-${invalidScalarCase.label}`, 'Bad'), label: 'Bad', visits: 1 };
      const patch = write(invalidSchema.rows).insert(invalidRow);
      const coreResult = tryTransact(createDb({ rows: [] }), patch);
      const adapter = automergeMapAdapter({
        doc: Automerge.from({ rows: [] }),
        relations: invalidRelations
      });
      const automergeResult = await adapter.target.apply([patch]);

      expect(hasErrorDiagnostics(coreResult.diagnostics), invalidScalarCase.label).toBe(true);
      expect(coreResult.diagnostics, invalidScalarCase.label).toEqual(expect.arrayContaining([
        expect.objectContaining({
          code: 'field_invalid',
          field: 'id',
          message: expect.stringContaining('string, finite number, or boolean')
        })
      ]));
      expect(automergeResult.status, invalidScalarCase.label).toBe('rejected');
      expect(automergeResult.diagnostics, invalidScalarCase.label).toEqual(expect.arrayContaining([
        expect.objectContaining({
          code: 'field_invalid',
          field: 'id',
          message: expect.stringContaining('string, finite number, or boolean')
        })
      ]));
      expect(adapter.source.rows(invalidSchema.rows), invalidScalarCase.label).toEqual([]);
    }
  });
});

function patchForKeyOperation(
  relationRef: RelationRef,
  key: unknown,
  operation: RelationKeyOperation,
  seed: number,
  step: number,
  random: () => number
): WritePatch {
  switch (operation) {
    case 'updateByKey':
      return write(relationRef).updateByKey(key as never, { label: `updated-${seed}-${step}` } as never);
    case 'incrementByKey':
      return write(relationRef).incrementByKey(key as never, 'visits' as never, randomInt(random, 5) + 1);
    case 'deleteByKey':
      return write(relationRef).deleteByKey(key as never);
  }
}

function assertReadParity(
  adapter: AutomergeMapAdapter<KeyDoc>,
  db: Db,
  relationKeyCase: RelationKeyCase,
  probe: RelationKeyProbe,
  label: string
): void {
  const expectedRow = row(db, relationKeyCase.relation as never, probe.key as never);
  const expectedExists = exists(db, relationKeyCase.relation as never, probe.key as never);
  const expectedAdapterRow = expectedRow === undefined
    ? undefined
    : adapterViewRow(relationKeyCase.relation, expectedRow as Record<string, unknown>);
  const adapterRow = adapterRowMatchingKey(adapter.source.rows(relationKeyCase.relation), relationKeyCase.relation, probe.key);
  const adapterExists = adapterRow !== undefined;
  const objectId = adapter.objectIdFor(relationKeyCase.relation, probe.key);

  expect(adapterRow, `${label} row`).toEqual(expectedAdapterRow);
  expect(adapterExists, `${label} exists`).toBe(expectedExists);
  expect(objectId === null, `${label} objectIdFor`).toBe(!expectedExists);
}

function assertRowsParity(
  adapter: AutomergeMapAdapter<KeyDoc>,
  db: Db,
  relationRef: RelationRef,
  label: string
): void {
  expect(canonicalRows(adapter.source.rows(relationRef)), label).toEqual(canonicalRows(expectedAdapterRows(db, relationRef)));
}

function expectedAdapterRows(db: Db, relationRef: RelationRef): readonly Record<string, unknown>[] {
  return (q(db, relationRef) as readonly Record<string, unknown>[]).map((rowValue) =>
    adapterViewRow(relationRef, rowValue));
}

function adapterViewRow(relationRef: RelationRef, rowValue: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(rowValue).map(([fieldName, value]) => [
    fieldName,
    adapterViewFieldValue(relationRef.fields[fieldName], value)
  ]));
}

function adapterViewFieldValue(spec: RelationRef['fields'][string] | undefined, value: unknown): unknown {
  if (spec?.valueKind !== 'custom' || spec.custom?.toScalar === undefined || value === null || value === undefined) {
    return value;
  }
  return spec.custom.toScalar(value);
}

function adapterRowMatchingKey(
  rows: readonly unknown[],
  relationRef: RelationRef,
  key: unknown
): Record<string, unknown> | undefined {
  const expectedKey = adapterKeyInputStableKey(relationRef, key);
  if (expectedKey === undefined) return undefined;
  return rows.find((rowValue): rowValue is Record<string, unknown> =>
    isRecord(rowValue) && adapterRowStableKey(relationRef, rowValue) === expectedKey);
}

function adapterKeyInputStableKey(relationRef: RelationRef, key: unknown): string | undefined {
  const fields = relationKeyFields(relationRef);
  const values = relationKeyInputValues(fields, key)?.map((value, index) =>
    adapterKeyInputValue(relationRef.fields[fields[index] as string], value));
  return values !== undefined && values.length === fields.length && values.every((value) => value !== undefined)
    ? stableKey(values)
    : undefined;
}

function adapterRowStableKey(relationRef: RelationRef, rowValue: Record<string, unknown>): string | undefined {
  const values = relationKeyFields(relationRef).map((fieldName) =>
    adapterRowKeyValue(relationRef.fields[fieldName], rowValue[fieldName]));
  return values.some((value) => value === undefined) ? undefined : stableKey(values);
}

function adapterRowKeyValue(spec: RelationRef['fields'][string] | undefined, value: unknown): unknown {
  if (spec?.valueKind !== 'custom') return value;
  if (value === null || value === undefined) return value;
  if (spec.custom?.stableKey !== undefined) return spec.custom.stableKey(value);
  if (spec.custom?.toScalar !== undefined) return isRelationKeyScalar(value) ? value : spec.custom.toScalar(value);
  return undefined;
}

function adapterKeyInputValue(spec: RelationRef['fields'][string] | undefined, value: unknown): unknown {
  if (spec?.valueKind !== 'custom') return value;
  if (!isRelationKeyScalar(value)) return undefined;
  if (spec.custom?.stableKey !== undefined) return value;
  if (spec.custom?.toScalar !== undefined && fieldValueMatchesSpec(spec, value)) {
    const scalar = spec.custom.toScalar(value);
    return isRelationKeyScalar(scalar) ? scalar : undefined;
  }
  return value;
}

function createKeySemanticsAdapter(): AutomergeMapAdapter<KeyDoc> {
  return automergeMapAdapter({
    doc: Automerge.from(automergeKeyFixtureDoc()),
    relations: defineAutomergeMapRelations<KeyDoc>()([
      { relation: keySemanticsSchema.strings, path: ['stringsById'] },
      { relation: keySemanticsSchema.numbers, path: ['numbers'] },
      { relation: keySemanticsSchema.booleans, path: ['booleansById'] },
      { relation: keySemanticsSchema.composites, path: ['compositesById'] },
      { relation: keySemanticsSchema.stableObjects, path: ['stableObjectsById'] },
      { relation: keySemanticsSchema.scalarObjects, path: ['scalarObjectsById'] }
    ])
  });
}

function coreFixtureData() {
  return {
    strings: [
      { id: 'alpha', label: 'Alpha', visits: 1 },
      { id: '', label: 'Empty', visits: 2 }
    ],
    numbers: [
      { id: 0, label: 'Zero', visits: 3 },
      { id: 42.5, label: 'Fractional', visits: 4 }
    ],
    booleans: [
      { id: true, label: 'True', visits: 5 },
      { id: false, label: 'False', visits: 6 }
    ],
    composites: [
      { tenant: 'acme', local: 1, label: 'Acme', visits: 7 },
      { tenant: 'beta', local: 2, label: 'Beta', visits: 8 }
    ],
    stableObjects: [
      { id: richKey('rich-1', 'Alpha'), label: 'Rich Alpha', visits: 9 },
      { id: richKey('rich-2', 'Beta'), label: 'Rich Beta', visits: 10 }
    ],
    scalarObjects: [
      { id: richKey('scalar-1', 'Alpha'), label: 'Scalar Alpha', visits: 11 },
      { id: richKey('scalar-2', 'Beta'), label: 'Scalar Beta', visits: 12 }
    ]
  };
}

function automergeKeyFixtureDoc(): KeyDoc {
  const data = coreFixtureData();
  return {
    stringsById: Object.fromEntries((data.strings ?? []).map((rowValue) =>
      [String(rowValue.id), nativeRow(rowValue as KeyedRow<string>)])),
    numbers: (data.numbers ?? []).map((rowValue) => nativeRow(rowValue as KeyedRow<number>)),
    booleansById: Object.fromEntries((data.booleans ?? []).map((rowValue) =>
      [String(rowValue.id), nativeRow(rowValue as KeyedRow<boolean>)])),
    compositesById: Object.fromEntries((data.composites ?? []).map((rowValue) => [
      compositeStorageKey(rowValue as CompositeRow),
      nativeCompositeRow(rowValue as CompositeRow)
    ])),
    stableObjectsById: Object.fromEntries((data.stableObjects ?? []).map((rowValue) => [
      richKeyStableKey((rowValue as KeyedRow<RichKey>).id),
      nativeRow(rowValue as KeyedRow<RichKey>)
    ])),
    scalarObjectsById: Object.fromEntries((data.scalarObjects ?? []).map((rowValue) => [
      richKeyScalar((rowValue as KeyedRow<RichKey>).id) ?? '',
      nativeRow(rowValue as KeyedRow<RichKey>)
    ]))
  };
}

function nativeRow<Key>(rowValue: KeyedRow<Key>): NativeKeyedRow<Key> {
  return {
    ...rowValue,
    visits: new Automerge.Counter(rowValue.visits)
  };
}

function nativeCompositeRow(rowValue: CompositeRow): NativeCompositeRow {
  return {
    ...rowValue,
    visits: new Automerge.Counter(rowValue.visits)
  };
}

function compositeStorageKey(rowValue: CompositeRow): string {
  return JSON.stringify([rowValue.tenant, rowValue.local]);
}

function isRichKey(value: unknown): value is RichKey {
  return typeof value === 'object'
    && value !== null
    && !Array.isArray(value)
    && typeof (value as { readonly objectId?: unknown }).objectId === 'string'
    && typeof (value as { readonly text?: unknown }).text === 'string';
}

function fieldValueMatchesSpec(spec: RelationRef['fields'][string], value: unknown): boolean {
  if (spec.valueKind === 'custom') return spec.custom?.validate === undefined || spec.custom.validate(value);
  switch (spec.valueKind) {
    case 'string':
    case 'id':
    case 'ref':
    case 'anchoredPath':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'boolean':
      return typeof value === 'boolean';
    default:
      return true;
  }
}

function relationKeyFields(relationRef: RelationRef): readonly string[] {
  return typeof relationRef.key === 'string' ? [relationRef.key] : relationRef.key;
}

function relationKeyInputValues(fields: readonly string[], key: unknown): readonly unknown[] | undefined {
  if (fields.length === 1) return isRelationKeyScalar(key) ? [key] : undefined;
  if (!Array.isArray(key) || key.length !== fields.length) return undefined;
  return key.every(isRelationKeyScalar) ? key : undefined;
}

function isRelationKeyScalar(value: unknown): value is string | number | boolean {
  return typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value));
}

function stableKey(input: unknown): string {
  if (input === undefined) return '~undefined';
  if (typeof input === 'number') {
    if (Number.isNaN(input)) return '~number:NaN';
    if (input === Infinity) return '~number:Infinity';
    if (input === -Infinity) return '~number:-Infinity';
    if (Object.is(input, -0)) return '~number:-0';
    return JSON.stringify(input);
  }
  if (input === null || typeof input === 'string' || typeof input === 'boolean') return JSON.stringify(input);
  if (Array.isArray(input)) return `[${input.map(stableKey).join(',')}]`;
  if (isRecord(input)) {
    return `{${Object.keys(input).sort().map((key) => `${JSON.stringify(key)}:${stableKey(input[key])}`).join(',')}}`;
  }
  return JSON.stringify(String(input as string | number | boolean | bigint | null | undefined));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasErrorDiagnostics(diagnostics: readonly { readonly severity?: string }[]): boolean {
  return diagnostics.some((diagnostic) => diagnostic.severity === 'error');
}
