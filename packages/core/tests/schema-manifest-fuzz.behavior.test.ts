import { describe, expect, it } from 'vitest';
import { rowKey, validateRelationRow } from '@tarstate/core/evaluate';
import {
  canonicalSchemaManifest,
  customField,
  defineSchema,
  hydrateSchemaManifest,
  relation,
  stringifyCanonicalSchemaManifest,
  toSchemaManifest,
  validateSchemaManifest,
  type HydrateSchemaManifestResult,
  type RuntimeCodec
} from '@tarstate/core/schema';
import { createSeededRandom, resolveFuzzSeeds } from './fuzz-helpers.js';
import { makeSchemaManifestFuzzCase } from './schema-manifest-fuzz-fixtures.js';

const seeds = resolveFuzzSeeds([12_301, 45_607, 89_011, 123_457]);

describe('schema manifest seeded fuzz behavior', () => {
  for (const seed of seeds) {
    it(`round-trips generated manifests for seed ${seed}`, () => {
      const random = createSeededRandom(seed);
      for (let caseIndex = 0; caseIndex < 24; caseIndex += 1) {
        const relationCount = 2 + Math.floor(random() * 8);
        const fieldsPerRelation = 1 + Math.floor(random() * 8);
        const fuzzCase = makeSchemaManifestFuzzCase(seed + caseIndex * 9_973, relationCount, fieldsPerRelation);

        expect(validateSchemaManifest(fuzzCase.manifest)).toEqual([]);
        const canonical = canonicalSchemaManifest(fuzzCase.manifest);
        const canonicalText = stringifyCanonicalSchemaManifest(fuzzCase.manifest);
        expect(stringifyCanonicalSchemaManifest(JSON.parse(canonicalText))).toBe(canonicalText);

        const hydrated = hydrateSchemaManifest(canonical, {
          diagnosticMode: 'collect',
          codecs: fuzzCase.runtimeCodecs
        }) as HydrateSchemaManifestResult;
        expect(hydrated.diagnostics).toEqual([]);
        expect(hydrated.schema).toBeDefined();
        if (hydrated.schema === undefined) throw new Error('expected hydrated schema');

        for (const relationName of Object.keys(canonical.relations)) {
          expect(hydrated.schema[relationName]?.name).toBe(relationName);
        }
        for (const relation of Object.values(hydrated.schema)) {
          for (const field of Object.values(relation.fields)) {
            if (field.valueKind === 'custom') {
              expect(field.custom?.codec).toEqual(expect.any(String));
              expect(field.custom).not.toHaveProperty('kind');
            }
          }
        }

        const exported = toSchemaManifest(hydrated.schema, {
          schemaId: canonical.schemaId,
          ...(canonical.metadata === undefined ? {} : { metadata: canonical.metadata }),
          ...(canonical.codecs === undefined ? {} : { codecs: canonical.codecs })
        });
        expect(canonicalSchemaManifest(exported)).toEqual(canonical);
      }
    });
  }

  it('fuzzes custom key scalar conversion without throwing', () => {
    const customKeyCodec = {
      codec: 'customKey',
      validate: (value): value is string => typeof value === 'string',
      toScalar: (value) => (value as string).trim().toLowerCase()
    } satisfies RuntimeCodec;
    const schema = defineSchema({
      rows: relation<{ readonly id: string }>({
        key: 'id',
        fields: {
          id: customField<string>(customKeyCodec)
        }
      })
    });

    for (const seed of seeds) {
      const random = createSeededRandom(seed);
      for (let index = 0; index < 96; index += 1) {
        const value = sampleKeyValue(random, index);
        const row = { id: value };
        const diagnostics = validateRelationRow(schema.rows, row);
        const key = rowKey(schema.rows, row);

        if (typeof value === 'string') {
          expect(diagnostics).toEqual([]);
          expect(key).toBe(JSON.stringify([value.trim().toLowerCase()]));
        } else if (value === null || value === undefined) {
          expect(diagnostics.map((diagnostic) => diagnostic.code)).toContain('field_missing');
          expect(key).toBeUndefined();
        } else {
          expect(diagnostics.map((diagnostic) => diagnostic.code)).toContain('field_invalid');
          expect(key).toBeUndefined();
        }
      }
    }
  });
});

function sampleKeyValue(random: () => number, index: number): unknown {
  switch (index % 8) {
    case 0:
      return ` Key ${Math.floor(random() * 100)} `;
    case 1:
      return Math.floor(random() * 100);
    case 2:
      return random() > 0.5;
    case 3:
      return null;
    case 4:
      return undefined;
    case 5:
      return { text: 'object-key' };
    case 6:
      return ['array-key'];
    default:
      return Number.NaN;
  }
}
