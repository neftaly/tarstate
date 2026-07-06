import { describe, expect, it } from 'vitest';
import { createDb, exists, row, tryTransact, type Db } from '@tarstate/core/db';
import {
  booleanField,
  customField,
  defineSchema,
  numberField,
  relation,
  stringField,
  type RelationRef
} from '@tarstate/core/schema';
import {
  deleteByKey,
  incrementByKey,
  updateByKey,
  write,
  type RelationKeyInput
} from '@tarstate/core/write';
import { chooseSeeded, createSeededRandom, resolveFuzzSeeds, type SeededRandom } from './fuzz-helpers.js';

type StringKeyRow = {
  readonly id: string;
  readonly label: string;
  readonly visits: number;
};

type NumberKeyRow = {
  readonly id: number;
  readonly label: string;
  readonly visits: number;
};

type BooleanKeyRow = {
  readonly enabled: boolean;
  readonly label: string;
  readonly visits: number;
};

type CompositeKeyRow = {
  readonly tenant: string;
  readonly slot: number;
  readonly enabled: boolean;
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

type ScaledNumberKeyRow = {
  readonly id: number;
  readonly label: string;
  readonly visits: number;
};

type RelationKeyScenario = {
  readonly label: string;
  readonly relation: RelationRef;
  readonly key: RelationKeyInput;
  readonly missingKey: RelationKeyInput;
  readonly row: Record<string, unknown>;
};

const fuzzSeeds = resolveFuzzSeeds([0x51a7, 0x51a8, 0x51a9, 0x51aa] as const);
const ROWS_PER_SEED = 18;

const relationKeyFuzzSchema = defineSchema({
  stringKeys: relation<StringKeyRow, 'id'>({
    key: 'id',
    fields: {
      id: stringField(),
      label: stringField(),
      visits: numberField()
    }
  }),
  numberKeys: relation<NumberKeyRow, 'id'>({
    key: 'id',
    fields: {
      id: numberField(),
      label: stringField(),
      visits: numberField()
    }
  }),
  booleanKeys: relation<BooleanKeyRow, 'enabled'>({
    key: 'enabled',
    fields: {
      enabled: booleanField(),
      label: stringField(),
      visits: numberField()
    }
  }),
  compositeKeys: relation<CompositeKeyRow, readonly ['tenant', 'slot', 'enabled']>({
    key: ['tenant', 'slot', 'enabled'] as const,
    fields: {
      tenant: stringField(),
      slot: numberField(),
      enabled: booleanField(),
      label: stringField(),
      visits: numberField()
    }
  }),
  stableObjectKeys: relation<RichKeyRow, 'id'>({
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
  scalarObjectKeys: relation<RichKeyRow, 'id'>({
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
  scalarComparableObjectKeys: relation<RichKeyRow, 'id'>({
    key: 'id',
    fields: {
      id: customField<RichKey>({
        codec: 'scalarComparableObjectKey',
        validate: isRichKey,
        toScalar: richKeyScalar,
        compare: compareRichKeysOnly
      }),
      label: stringField(),
      visits: numberField()
    }
  }),
  caseFoldedKeys: relation<CaseFoldedKeyRow, 'id'>({
    key: 'id',
    fields: {
      id: customField<string>({
        codec: 'caseFoldedKey',
        validate: (value): value is string => typeof value === 'string',
        toScalar: caseKeyScalar
      }),
      label: stringField(),
      visits: numberField()
    }
  }),
  stableFoldedKeys: relation<CaseFoldedKeyRow, 'id'>({
    key: 'id',
    fields: {
      id: customField<string>({
        codec: 'stableFoldedKey',
        validate: (value): value is string => typeof value === 'string',
        stableKey: caseKeyScalar
      }),
      label: stringField(),
      visits: numberField()
    }
  }),
  scaledNumberKeys: relation<ScaledNumberKeyRow, 'id'>({
    key: 'id',
    fields: {
      id: customField<number>({
        codec: 'scaledNumberKey',
        validate: (value): value is number => typeof value === 'number' && Number.isFinite(value),
        toScalar: scaledNumberScalar
      }),
      label: stringField(),
      visits: numberField()
    }
  })
});

describe('RelationKeyInput seeded fuzz behavior', () => {
  it('reads and writes generated primitive and composite scalar keys', () => {
    for (const seed of fuzzSeeds) {
      const primitiveKeyFixture = makePrimitiveRelationKeyFixture(seed);
      for (const [index, scenario] of primitiveKeyFixture.scenarios.entries()) {
        assertRelationKeyScenarioBehavior(primitiveKeyFixture.db, scenario, seed, index);
      }
    }
  });

  it('reads and writes generated custom stableKey and toScalar keys by scalar values', () => {
    for (const seed of fuzzSeeds) {
      const customKeyFixture = makeCustomRelationKeyFixture(seed);
      for (const [index, scenario] of customKeyFixture.scenarios.entries()) {
        assertRelationKeyScenarioBehavior(customKeyFixture.db, scenario, seed, index);
      }

      const unserializedObjectKey = customKeyFixture.objectKeys[0];
      if (unserializedObjectKey === undefined) throw new Error('expected custom object-key fixture row');
      expect(row(customKeyFixture.db, relationKeyFuzzSchema.stableObjectKeys, unserializedObjectKey as never), `seed ${seed} stable object read`).toBeUndefined();
      expect(row(customKeyFixture.db, relationKeyFuzzSchema.scalarObjectKeys, unserializedObjectKey as never), `seed ${seed} scalar object read`).toBeUndefined();

      const invalidStableUpdate = tryTransact(
        customKeyFixture.db,
        updateByKey(relationKeyFuzzSchema.stableObjectKeys, unserializedObjectKey as never, { label: `invalid-stable-${seed}` })
      );
      const invalidScalarUpdate = tryTransact(
        customKeyFixture.db,
        write(relationKeyFuzzSchema.scalarObjectKeys).updateByKey(unserializedObjectKey as never, { label: `invalid-scalar-${seed}` })
      );

      expect(invalidStableUpdate.committed, `seed ${seed} stable object write`).toBe(false);
      expect(invalidScalarUpdate.committed, `seed ${seed} scalar object write`).toBe(false);
      expect(invalidStableUpdate.diagnostics, `seed ${seed} stable object diagnostic`).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: 'write_patch_invalid', relation: relationKeyFuzzSchema.stableObjectKeys.name })
      ]));
      expect(invalidScalarUpdate.diagnostics, `seed ${seed} scalar object diagnostic`).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: 'write_patch_invalid', relation: relationKeyFuzzSchema.scalarObjectKeys.name })
      ]));

      const stableFoldedRow = customKeyFixture.stableFoldedRows[0];
      if (stableFoldedRow === undefined) throw new Error('expected stable folded fixture row');
      const duplicateStableFolded = tryTransact(
        customKeyFixture.db,
        write(relationKeyFuzzSchema.stableFoldedKeys).insert({
          ...stableFoldedRow,
          id: stableFoldedRow.id.toUpperCase(),
          label: `duplicate-stable-folded-${seed}`
        })
      );
      expect(duplicateStableFolded.committed, `seed ${seed} stable folded duplicate`).toBe(false);

      const replacedStableFolded = tryTransact(
        customKeyFixture.db,
        write(relationKeyFuzzSchema.stableFoldedKeys).insertOrReplace({
          ...stableFoldedRow,
          id: stableFoldedRow.id.toUpperCase(),
          label: `replaced-stable-folded-${seed}`
        })
      );
      expect(replacedStableFolded.committed, `seed ${seed} stable folded replace`).toBe(true);
      expect(row(replacedStableFolded.db, relationKeyFuzzSchema.stableFoldedKeys, caseKeyScalar(stableFoldedRow.id)), `seed ${seed} stable folded row`).toEqual({
        ...stableFoldedRow,
        id: stableFoldedRow.id.toUpperCase(),
        label: `replaced-stable-folded-${seed}`
      });
    }
  });
});

function assertRelationKeyScenarioBehavior(db: Db, scenario: RelationKeyScenario, seed: number, index: number): void {
  const label = `seed ${seed} case ${index} ${scenario.label}`;
  const updateLabel = `${scenario.label}-updated-${seed}-${index}`;
  const bump = (index % 7) + 1;

  expect(row(db, scenario.relation, scenario.key), `${label} row`).toEqual(scenario.row);
  expect(exists(db, scenario.relation, scenario.key), `${label} exists`).toBe(true);
  expect(row(db, scenario.relation, scenario.missingKey), `${label} missing row`).toBeUndefined();
  expect(exists(db, scenario.relation, scenario.missingKey), `${label} missing exists`).toBe(false);

  const updatePatch = index % 2 === 0
    ? updateByKey(scenario.relation, scenario.key, { label: updateLabel })
    : write(scenario.relation).updateByKey(scenario.key, { label: updateLabel });
  const updateResult = tryTransact(db, updatePatch);
  expect(updateResult.committed, `${label} update committed`).toBe(true);
  expect(updateResult.diagnostics, `${label} update diagnostics`).toEqual([]);
  expect(row(updateResult.db, scenario.relation, scenario.key), `${label} updated row`).toEqual({
    ...scenario.row,
    label: updateLabel
  });

  const incrementPatch = index % 2 === 0
    ? incrementByKey(scenario.relation, scenario.key, 'visits' as never, bump)
    : write(scenario.relation).incrementByKey(scenario.key, 'visits' as never, bump);
  const incrementResult = tryTransact(db, incrementPatch);
  expect(incrementResult.committed, `${label} increment committed`).toBe(true);
  expect(incrementResult.diagnostics, `${label} increment diagnostics`).toEqual([]);
  expect(row(incrementResult.db, scenario.relation, scenario.key), `${label} incremented row`).toEqual({
    ...scenario.row,
    visits: Number(scenario.row.visits) + bump
  });

  const deletePatch = index % 2 === 0
    ? deleteByKey(scenario.relation, scenario.key)
    : write(scenario.relation).deleteByKey(scenario.key);
  const deleteResult = tryTransact(db, deletePatch);
  expect(deleteResult.committed, `${label} delete committed`).toBe(true);
  expect(deleteResult.diagnostics, `${label} delete diagnostics`).toEqual([]);
  expect(row(deleteResult.db, scenario.relation, scenario.key), `${label} deleted row`).toBeUndefined();
}

function makePrimitiveRelationKeyFixture(seed: number): { readonly db: Db; readonly scenarios: readonly RelationKeyScenario[] } {
  const random = createSeededRandom(seed);
  const stringRows = Array.from({ length: ROWS_PER_SEED }, (_, index): StringKeyRow => ({
    id: stringKey(seed, index, random),
    label: `string-${seed}-${index}`,
    visits: index
  }));
  const numberRows = Array.from({ length: ROWS_PER_SEED }, (_, index): NumberKeyRow => ({
    id: numberKey(seed, index),
    label: `number-${seed}-${index}`,
    visits: index * 2
  }));
  const booleanRows: readonly BooleanKeyRow[] = [
    { enabled: false, label: `boolean-${seed}-false`, visits: 1 },
    { enabled: true, label: `boolean-${seed}-true`, visits: 2 }
  ];
  const compositeRows = Array.from({ length: ROWS_PER_SEED }, (_, index): CompositeKeyRow => ({
    tenant: chooseSeeded(random, ['acme', 'globex', `tenant-${seed % 13}`]),
    slot: index === 0 ? -0 : seed * 100 + index,
    enabled: index % 2 === 0,
    label: `composite-${seed}-${index}`,
    visits: index * 3
  }));

  return {
    db: createDb({
      stringKeys: stringRows,
      numberKeys: numberRows,
      booleanKeys: booleanRows,
      compositeKeys: compositeRows
    }),
    scenarios: [
      ...stringRows.map((rowValue, index): RelationKeyScenario => ({
        label: `string:${index}`,
        relation: relationKeyFuzzSchema.stringKeys,
        key: rowValue.id,
        missingKey: `${rowValue.id}:missing`,
        row: rowValue
      })),
      ...numberRows.map((rowValue, index): RelationKeyScenario => ({
        label: `number:${index}`,
        relation: relationKeyFuzzSchema.numberKeys,
        key: rowValue.id,
        missingKey: missingNumberKey(rowValue.id, index),
        row: rowValue
      })),
      ...booleanRows.map((rowValue): RelationKeyScenario => ({
        label: `boolean:${String(rowValue.enabled)}`,
        relation: relationKeyFuzzSchema.booleanKeys,
        key: rowValue.enabled,
        missingKey: String(rowValue.enabled),
        row: rowValue
      })),
      ...compositeRows.map((rowValue, index): RelationKeyScenario => ({
        label: `composite:${index}`,
        relation: relationKeyFuzzSchema.compositeKeys,
        key: [rowValue.tenant, rowValue.slot, rowValue.enabled] as const,
        missingKey: [rowValue.tenant, rowValue.slot + 10_000 + index, rowValue.enabled] as const,
        row: rowValue
      }))
    ]
  };
}

function makeCustomRelationKeyFixture(seed: number): {
  readonly db: Db;
  readonly scenarios: readonly RelationKeyScenario[];
  readonly objectKeys: readonly RichKey[];
  readonly stableFoldedRows: readonly CaseFoldedKeyRow[];
} {
  const random = createSeededRandom(seed ^ 0x9e37);
  const stableObjectRows = Array.from({ length: ROWS_PER_SEED }, (_, index): RichKeyRow => ({
    id: richKey(seed, index, 'stable'),
    label: `stable-${seed}-${index}`,
    visits: index
  }));
  const scalarObjectRows = Array.from({ length: ROWS_PER_SEED }, (_, index): RichKeyRow => ({
    id: richKey(seed, index, 'scalar'),
    label: `scalar-${seed}-${index}`,
    visits: index * 2
  }));
  const scalarComparableRows = Array.from({ length: ROWS_PER_SEED }, (_, index): RichKeyRow => ({
    id: richKey(seed, index, 'scalar-compare'),
    label: `scalar-compare-${seed}-${index}`,
    visits: index * 5
  }));
  const caseFoldedRows = Array.from({ length: ROWS_PER_SEED }, (_, index): CaseFoldedKeyRow => ({
    id: caseKey(seed, index, random),
    label: `case-${seed}-${index}`,
    visits: index * 3
  }));
  const stableFoldedRows = Array.from({ length: ROWS_PER_SEED }, (_, index): CaseFoldedKeyRow => ({
    id: caseKey(seed + 1, index, random),
    label: `stable-folded-${seed}-${index}`,
    visits: index * 6
  }));
  const scaledNumberRows = Array.from({ length: ROWS_PER_SEED }, (_, index): ScaledNumberKeyRow => ({
    id: scaledNumberKey(seed, index),
    label: `scaled-${seed}-${index}`,
    visits: index * 4
  }));

  return {
    db: createDb({
      stableObjectKeys: stableObjectRows,
      scalarObjectKeys: scalarObjectRows,
      scalarComparableObjectKeys: scalarComparableRows,
      caseFoldedKeys: caseFoldedRows,
      stableFoldedKeys: stableFoldedRows,
      scaledNumberKeys: scaledNumberRows
    }),
    objectKeys: [stableObjectRows[0]?.id, scalarObjectRows[0]?.id].filter(isRichKey),
    stableFoldedRows,
    scenarios: [
      ...stableObjectRows.map((rowValue, index): RelationKeyScenario => ({
        label: `stableObject:${index}`,
        relation: relationKeyFuzzSchema.stableObjectKeys,
        key: rowValue.id.objectId,
        missingKey: `${rowValue.id.objectId}:missing`,
        row: rowValue
      })),
      ...scalarObjectRows.map((rowValue, index): RelationKeyScenario => ({
        label: `scalarObject:${index}`,
        relation: relationKeyFuzzSchema.scalarObjectKeys,
        key: rowValue.id.objectId,
        missingKey: `${rowValue.id.objectId}:missing`,
        row: rowValue
      })),
      ...scalarComparableRows.map((rowValue, index): RelationKeyScenario => ({
        label: `scalarComparableObject:${index}`,
        relation: relationKeyFuzzSchema.scalarComparableObjectKeys,
        key: rowValue.id.objectId,
        missingKey: `${rowValue.id.objectId}:missing`,
        row: rowValue
      })),
      ...caseFoldedRows.map((rowValue, index): RelationKeyScenario => ({
        label: `caseFolded:${index}`,
        relation: relationKeyFuzzSchema.caseFoldedKeys,
        key: index % 2 === 0 ? rowValue.id.toUpperCase() : caseKeyScalar(rowValue.id),
        missingKey: `missing-${seed}-${index}`,
        row: rowValue
      })),
      ...stableFoldedRows.map((rowValue, index): RelationKeyScenario => ({
        label: `stableFolded:${index}`,
        relation: relationKeyFuzzSchema.stableFoldedKeys,
        key: caseKeyScalar(rowValue.id),
        missingKey: `missing-stable-${seed}-${index}`,
        row: rowValue
      })),
      ...scaledNumberRows.map((rowValue, index): RelationKeyScenario => ({
        label: `scaledNumber:${index}`,
        relation: relationKeyFuzzSchema.scaledNumberKeys,
        key: rowValue.id + 0.499,
        missingKey: scaledNumberScalar(rowValue.id) + 10_000 + index,
        row: rowValue
      }))
    ]
  };
}

function stringKey(seed: number, index: number, random: SeededRandom): string {
  const suffix = chooseSeeded(random, ['plain', 'space value', 'quote"value', 'slash/value', 'caseVALUE']);
  return `key-${seed.toString(36)}-${index}-${suffix}`;
}

function numberKey(seed: number, index: number): number {
  if (index === 0) return -0;
  if (index === 1) return 0;
  const sign = index % 3 === 0 ? -1 : 1;
  return sign * (seed * 100 + index + (index % 5) / 10);
}

function missingNumberKey(keyValue: number, index: number): number {
  if (Object.is(keyValue, -0)) return Number.MIN_VALUE;
  return keyValue + 0.03125 + index;
}

function richKey(seed: number, index: number, kind: 'stable' | 'scalar' | 'scalar-compare'): RichKey {
  return {
    objectId: `${kind}:${seed.toString(36)}:${index}`,
    text: `Text ${seed}.${index}`,
    version: (seed + index) % 97
  };
}

function caseKey(seed: number, index: number, random: SeededRandom): string {
  const body = chooseSeeded(random, [`Tag-${seed}-${index}`, ` TAG ${seed} ${index} `, `tag/${seed}/${index}`]);
  return index % 2 === 0 ? body.toUpperCase() : body.toLowerCase();
}

function scaledNumberKey(seed: number, index: number): number {
  return seed * 10 + index + 0.125;
}

function richKeyStableKey(value: unknown): string {
  return isRichKey(value) ? value.objectId : String(value);
}

function richKeyScalar(value: unknown): string | null {
  return isRichKey(value) ? value.objectId : null;
}

function compareRichKeysOnly(left: unknown, right: unknown): number {
  if (!isRichKey(left) || !isRichKey(right)) throw new Error('compareRichKeysOnly expects rich keys');
  return left.objectId.localeCompare(right.objectId);
}

function caseKeyScalar(value: unknown): string {
  return String(value).trim().toLowerCase();
}

function scaledNumberScalar(value: unknown): number {
  return Math.trunc(Number(value));
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
