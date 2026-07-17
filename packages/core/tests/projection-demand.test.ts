import { describe, expect, it } from 'vitest';
import type { QueryNode } from '../src/query/model.js';
import { deriveProjectionDemand } from '../src/query/internal/projection-demand.js';

const schemaView = {
  id: 'urn:test:projection-demand',
  contentHash: `sha256:${'a'.repeat(64)}` as const
};
const relation = { schemaView, relationId: 'test.file' } as const;
describe('query projection demand', () => {
  it('collects only relation fields observed before a final select', () => {
    const query: QueryNode = {
      kind: 'select',
      alias: 'title',
      input: {
        kind: 'where',
        input: { kind: 'from', relation, alias: 'file' },
        predicate: {
          kind: 'compare',
          op: 'ne',
          left: { kind: 'field', alias: 'file', name: 'name' },
          right: { kind: 'literal', value: '' }
        }
      },
      fields: { title: { kind: 'field', alias: 'file', name: 'name' } }
    };

    expect(deriveProjectionDemand(query)).toEqual({
      relations: [{ relation, fields: ['name'] }]
    });
  });

  it('retains full projection when output or row semantics are not field-bounded', () => {
    const rawRows = { kind: 'from', relation, alias: 'file' } satisfies QueryNode;
    const distinctRows = {
      kind: 'select',
      alias: 'title',
      input: { kind: 'distinct', input: { kind: 'from', relation, alias: 'file' } },
      fields: { title: { kind: 'field', alias: 'file', name: 'name' } }
    } satisfies QueryNode;
    const ambiguousAlias = {
      kind: 'select',
      alias: 'file',
      input: { kind: 'from', relation, alias: 'file' },
      fields: { title: { kind: 'field', alias: 'file', name: 'name' } }
    } satisfies QueryNode;
    const duplicateRelationAlias = {
      kind: 'select',
      alias: 'result',
      input: {
        kind: 'join',
        join: 'cross',
        left: { kind: 'from', relation, alias: 'file' },
        right: { kind: 'from', relation: { ...relation, relationId: 'test.other' }, alias: 'file' }
      },
      fields: { title: { kind: 'field', alias: 'file', name: 'name' } }
    } satisfies QueryNode;

    expect(deriveProjectionDemand(rawRows)).toBeUndefined();
    expect(deriveProjectionDemand(distinctRows)).toBeUndefined();
    expect(deriveProjectionDemand(ambiguousAlias)).toBeUndefined();
    expect(deriveProjectionDemand(duplicateRelationAlias)).toBeUndefined();
  });

  it('needs only keys when a final select uses provenance but no row fields', () => {
    const query = {
      kind: 'select',
      alias: 'identity',
      input: { kind: 'from', relation, alias: 'file' },
      fields: { sourceId: { kind: 'source-of', alias: 'file' } }
    } satisfies QueryNode;

    expect(deriveProjectionDemand(query)).toEqual({
      relations: [{ relation, fields: [] }]
    });
  });
});
