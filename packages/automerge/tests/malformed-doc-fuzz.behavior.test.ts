import * as Automerge from '@automerge/automerge';
import { describe, expect, it } from 'vitest';
import { defineSchema, numberField, optional, relation, stringField } from '@tarstate/core/schema';
import { write } from '@tarstate/core/write';
import type { RelationLookup, RelationRangeLookup, RelationSource } from '@tarstate/core/source';
import {
  automergeMapAdapter,
  automergeMapSource,
  defineAutomergeMapRelations
} from '@tarstate/automerge';

type FuzzRow = {
  readonly id: string;
  readonly title: string;
  readonly rank?: number;
};

type FuzzDoc = {
  readonly workspace?: {
    readonly rows?: unknown;
    readonly rowsById?: unknown;
    readonly nested?: unknown;
  } | null;
};

const schema = defineSchema({
  fuzzRows: relation<FuzzRow>({
    key: 'id',
    fields: {
      id: stringField(),
      title: stringField(),
      rank: optional(numberField())
    }
  })
});

const defineFuzzRelations = defineAutomergeMapRelations<FuzzDoc>();
const arrayMapping = defineFuzzRelations([
  { relation: schema.fuzzRows, path: ['workspace', 'rows'] }
]);
const mapMapping = defineFuzzRelations([
  { relation: schema.fuzzRows, path: ['workspace', 'rowsById'] }
]);
const combinedMapping = defineFuzzRelations([
  { relation: schema.fuzzRows, path: ['workspace', 'rows'] },
  { relation: schema.fuzzRows, path: ['workspace', 'rowsById'] }
]);
const arraySegmentMapping = defineFuzzRelations([
  { relation: schema.fuzzRows, path: ['workspace', 'nested', 'not-an-index'] }
]);

const malformedPathCases = [
  {
    name: 'missing mapped path',
    doc: { workspace: {} },
    relations: arrayMapping
  },
  {
    name: 'null parent on mapped path',
    doc: { workspace: null },
    relations: arrayMapping
  },
  {
    name: 'null mapped collection',
    doc: { workspace: { rows: null } },
    relations: arrayMapping
  },
  {
    name: 'scalar mapped collection',
    doc: { workspace: { rows: 'not rows' } },
    relations: arrayMapping
  },
  {
    name: 'scalar parent on mapped path',
    doc: { workspace: { nested: 7 } },
    relations: arraySegmentMapping
  },
  {
    name: 'object where an array segment is expected',
    doc: { workspace: { nested: [{ id: 'nested-1', title: 'Nested' }] } },
    relations: arraySegmentMapping
  }
] as const;

const malformedRowCases = [
  {
    name: 'array with primitives, nulls, arrays, and invalid object rows',
    doc: {
      workspace: {
        rows: [
          { id: 'array-1', title: 'Valid', rank: 1 },
          null,
          7,
          ['nested-array'],
          { id: 'array-missing-title' },
          { id: null, title: 'Null id' },
          { id: 'array-wrong-rank', title: 'Wrong rank', rank: 'high' }
        ]
      }
    },
    relations: arrayMapping,
    expectedRows: [
      { id: 'array-1', title: 'Valid', rank: 1 },
      { id: 'array-missing-title' },
      { id: null, title: 'Null id' },
      { id: 'array-wrong-rank', title: 'Wrong rank', rank: 'high' }
    ],
    expectedDiagnosticCodes: ['field_missing', 'field_invalid']
  },
  {
    name: 'map with non-object values and invalid object rows',
    doc: {
      workspace: {
        rowsById: {
          'map-1': { id: 'map-1', title: 'Valid', rank: 2 },
          primitive: 'not a row',
          nil: null,
          array: [{ id: 'inside-array', title: 'Ignored' }],
          missingTitle: { id: 'map-missing-title' },
          wrongRank: { id: 'map-wrong-rank', title: 'Wrong rank', rank: 'high' }
        }
      }
    },
    relations: mapMapping,
    expectedRows: [
      { id: 'map-1', title: 'Valid', rank: 2 },
      { id: 'map-missing-title' },
      { id: 'map-wrong-rank', title: 'Wrong rank', rank: 'high' }
    ],
    expectedDiagnosticCodes: ['field_missing', 'field_invalid']
  },
  {
    name: 'duplicate row ids across array and map mappings',
    doc: {
      workspace: {
        rows: [{ id: 'duplicate-1', title: 'Array row' }],
        rowsById: {
          'duplicate-1': { id: 'duplicate-1', title: 'Map row' },
          'map-2': { id: 'map-2', title: 'Second map row' }
        }
      }
    },
    relations: combinedMapping,
    expectedRows: [
      { id: 'duplicate-1', title: 'Array row' },
      { id: 'duplicate-1', title: 'Map row' },
      { id: 'map-2', title: 'Second map row' }
    ],
    expectedDiagnosticCodes: []
  },
  {
    name: 'map key disagrees with row key',
    doc: {
      workspace: {
        rowsById: {
          'storage-key': { id: 'row-key', title: 'Disagrees' }
        }
      }
    },
    relations: mapMapping,
    expectedRows: [{ id: 'row-key', title: 'Disagrees' }],
    expectedDiagnosticCodes: []
  }
] as const;

describe('automerge malformed document shape fuzz', () => {
  it.each(malformedPathCases)('keeps source calls total and rejects writes for $name', async (testCase) => {
    const adapter = automergeMapAdapter({
      doc: asDoc(testCase.doc),
      relations: testCase.relations
    });
    const beforeDoc = adapter.getDoc();
    const beforeHeads = Automerge.getHeads(beforeDoc);

    assertSourceTotal(adapter.source);
    expect(adapter.source.rows(schema.fuzzRows), testCase.name).toEqual([]);
    expect(adapter.source.diagnostics?.(), testCase.name).toEqual([
      expect.objectContaining({
        code: 'runtime_unsupported',
        severity: 'warning',
        relation: 'fuzzRows'
      })
    ]);

    const result = await adapter.target.apply([
      write(schema.fuzzRows).insert({ id: 'new-row', title: 'Should reject', rank: 10 })
    ]);

    expect(result.status, testCase.name).toBe('rejected');
    expect(result.applied, testCase.name).toBe(0);
    expect(result.diagnostics, testCase.name).toEqual([
      expect.objectContaining({
        code: 'runtime_unsupported',
        relation: 'fuzzRows'
      })
    ]);
    expect(adapter.getDoc(), testCase.name).toBe(beforeDoc);
    expect(Automerge.getHeads(adapter.getDoc()), testCase.name).toEqual(beforeHeads);
  });

  it.each(malformedRowCases)('keeps source indexes total for $name', (testCase) => {
    const source = automergeMapSource(asDoc(testCase.doc), { relations: testCase.relations });

    assertSourceTotal(source);
    expect(source.rows(schema.fuzzRows), testCase.name).toEqual(testCase.expectedRows);
    expect((source.diagnostics?.() ?? []).map((diagnostic) => diagnostic.code), testCase.name)
      .toEqual(expect.arrayContaining([...testCase.expectedDiagnosticCodes]));
  });

  it('rejects duplicate writes when duplicate ids are already reachable across mappings', async () => {
    const adapter = automergeMapAdapter({
      doc: asDoc({
        workspace: {
          rows: [{ id: 'duplicate-1', title: 'Array row' }],
          rowsById: {
            'duplicate-1': { id: 'duplicate-1', title: 'Map row' }
          }
        }
      }),
      relations: combinedMapping
    });
    const beforeDoc = adapter.getDoc();

    const result = await adapter.target.apply([
      write(schema.fuzzRows).insert({ id: 'duplicate-1', title: 'Another duplicate' })
    ]);

    expect(result.status).toBe('rejected');
    expect(result.applied).toBe(0);
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        code: 'unique',
        relation: 'fuzzRows'
      })
    ]);
    expect(adapter.getDoc()).toBe(beforeDoc);
  });
});

function assertSourceTotal(source: RelationSource): void {
  expect(() => source.rows(schema.fuzzRows)).not.toThrow();
  expect(() => source.lookup?.(lookup('id', 'missing'))).not.toThrow();
  expect(() => source.lookup?.(lookup('title', null))).not.toThrow();
  expect(() => source.rangeLookup?.(rangeLookup('id'))).not.toThrow();
  expect(() => source.rangeLookup?.(rangeLookup('rank', 0, 100))).not.toThrow();
  expect(() => source.diagnostics?.()).not.toThrow();

  expect(source.lookup?.(lookup('id', 'missing'))).toEqual([]);
  expect(source.rangeLookup?.(rangeLookup('rank', 0, 100))).toEqual(
    source.rows(schema.fuzzRows).filter((row) =>
      isRecord(row) && typeof row.rank === 'number' && row.rank >= 0 && row.rank <= 100)
  );
}

function lookup(field: string, value: unknown): RelationLookup {
  return { relation: schema.fuzzRows, field, value };
}

function rangeLookup(field: string, lower?: unknown, upper?: unknown): RelationRangeLookup {
  return {
    relation: schema.fuzzRows,
    field,
    ...(lower === undefined ? {} : { lower: { value: lower, inclusive: true } }),
    ...(upper === undefined ? {} : { upper: { value: upper, inclusive: true } })
  };
}

function asDoc(input: unknown): Automerge.Doc<FuzzDoc> {
  return Automerge.from(input as FuzzDoc);
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === 'object' && input !== null && !Array.isArray(input);
}
