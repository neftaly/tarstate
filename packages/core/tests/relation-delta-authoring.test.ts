import { describe, expect, it } from 'vitest';
import {
  authorExactKeyedRelationDelta,
  type ExactKeyedRelationDeltaInput
} from '@tarstate/core/transactions';
import type { ArtifactRef } from '../src/index.js';

const hash = (character: string): `sha256:${string}` => `sha256:${character.repeat(64)}`;
const schemaView: ArtifactRef = { id: 'urn:test:delta-schema', contentHash: hash('a') };
const relation = { relationId: 'items', schemaView };

const input = (overrides: Partial<ExactKeyedRelationDeltaInput> = {}): ExactKeyedRelationDeltaInput => ({
  relation,
  keyFields: ['id'],
  replaceableFields: ['title', 'count'],
  before: {
    completeness: 'exact',
    rows: [
      { id: 'c', title: 'Same', count: 3 },
      { id: 'b', title: 'Removed', count: 2 },
      { id: 'a', title: 'Before', count: 1 }
    ]
  },
  after: {
    completeness: 'exact',
    rows: [
      { id: 'd', title: 'Inserted', count: 4 },
      { id: 'a', title: 'After', count: 1 },
      { id: 'c', title: 'Same', count: 3 }
    ]
  },
  ...overrides
});

describe('exact keyed relation-delta authoring', () => {
  it('authors canonical targeted deletes, replacements, and inserts without touching unchanged rows', () => {
    const result = authorExactKeyedRelationDelta(input());
    expect(result).toMatchObject({
      success: true,
      value: [
        {
          kind: 'statement.delete',
          target: {
            alias: 'row',
            where: { kind: 'compare', left: { kind: 'field', name: 'id' }, right: { kind: 'literal', value: 'b' } }
          }
        },
        {
          kind: 'statement.update',
          target: {
            alias: 'row',
            where: { kind: 'compare', left: { kind: 'field', name: 'id' }, right: { kind: 'literal', value: 'a' } }
          },
          edits: { title: { kind: 'edit.replace', value: { kind: 'literal', value: 'After' } } }
        },
        {
          kind: 'statement.insert',
          rows: [{ count: { kind: 'literal', value: 4 }, id: { kind: 'literal', value: 'd' }, title: { kind: 'literal', value: 'Inserted' } }]
        }
      ]
    });
    if (!result.success) throw new Error('Expected successful authoring');
    expect(Object.isFrozen(result.value)).toBe(true);
    expect(JSON.stringify(result.value)).not.toContain('Same');
  });

  it('is deterministic across input row and field ordering and emits no semantic no-ops', () => {
    const first = authorExactKeyedRelationDelta(input());
    const reordered = authorExactKeyedRelationDelta(input({
      before: {
        completeness: 'exact',
        rows: [
          { count: 1, title: 'Before', id: 'a' },
          { count: 2, id: 'b', title: 'Removed' },
          { title: 'Same', id: 'c', count: 3 }
        ]
      },
      after: {
        completeness: 'exact',
        rows: [
          { title: 'Same', count: 3, id: 'c' },
          { count: 4, title: 'Inserted', id: 'd' },
          { count: 1, id: 'a', title: 'After' }
        ]
      }
    }));
    expect(reordered).toEqual(first);

    const noOp = authorExactKeyedRelationDelta(input({ after: input().before }));
    expect(noOp).toEqual({ success: true, value: [], issues: [] });
  });

  it('rejects missing and duplicate keys instead of selecting ambiguous rows', () => {
    const result = authorExactKeyedRelationDelta(input({
      before: { completeness: 'exact', rows: [{ title: 'Missing' }, { id: 'a' }, { id: 'a' }] }
    }));
    expect(result).toMatchObject({
      success: false,
      issues: [
        { code: 'transaction.delta_invalid', details: { reason: 'key_missing', side: 'before' } },
        { code: 'transaction.delta_invalid', details: { reason: 'key_ambiguous', side: 'before' } }
      ]
    });
  });

  it('rejects field removal and replacement without an explicitly permitted mechanism', () => {
    const result = authorExactKeyedRelationDelta(input({
      replaceableFields: [],
      before: { completeness: 'exact', rows: [{ id: 'a', title: 'Before', removed: true }] },
      after: { completeness: 'exact', rows: [{ id: 'a', title: 'After' }] }
    }));
    expect(result).toMatchObject({
      success: false,
      issues: [
        { details: { reason: 'field_removal_unsupported', field: 'removed' } },
        { details: { reason: 'field_replacement_unavailable', field: 'title' } }
      ]
    });
  });

  it('requires exact relation states at the public boundary', () => {
    const candidate = input() as unknown as { before: { completeness: string } };
    candidate.before = { completeness: 'unknown' };
    expect(authorExactKeyedRelationDelta(candidate as never)).toMatchObject({
      success: false,
      issues: [{ code: 'transaction.delta_invalid', details: { reason: 'input_shape' } }]
    });
  });
});
