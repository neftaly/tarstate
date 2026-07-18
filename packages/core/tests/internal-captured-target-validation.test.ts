import { describe, expect, it } from 'vitest';
import { capturedTargetsRemain } from '../src/internal-captured-target-validation.js';
import type { WritableLogicalRow } from '../src/logical-edit.js';
import type { WriteExpression, WriteRelation, WriteStatement } from '../src/transaction.js';

const relation: WriteRelation = {
  relationId: 'test.item',
  schemaView: { id: 'urn:test:schema', contentHash: `sha256:${'0'.repeat(64)}` }
};
const literal = (value: string): WriteExpression => ({ kind: 'literal', value });
const keyedDelta = (key: WriteExpression): WriteStatement => ({
  kind: 'statement.keyed-delta',
  relation,
  alias: 'item',
  changes: [{ kind: 'delta.update', key: { id: key }, edits: {} }]
});
const row = (id: string): WritableLogicalRow => ({
  relationId: relation.relationId,
  key: [id],
  fields: { id },
  locator: id
});
const rows = (...values: WritableLogicalRow[]) => new Map([[relation.relationId, values]]);
const keys = new Map([[relation.relationId, ['id']]]);

describe('captured target validation', () => {
  it('accepts one exact projected target', () => {
    expect(capturedTargetsRemain([keyedDelta(literal('a'))], rows(row('a')), keys)).toBe(true);
  });

  it.each([
    ['missing target', rows()],
    ['duplicate target', rows(row('a'), row('a'))]
  ])('rejects a %s', (_case, projectedRows) => {
    expect(capturedTargetsRemain([keyedDelta(literal('a'))], projectedRows, keys)).toBe(false);
  });

  it('rejects targets that are no longer exact literals', () => {
    expect(capturedTargetsRemain(
      [keyedDelta({ kind: 'parameter', name: 'id' })],
      rows(row('a')),
      keys
    )).toBe(false);
  });

  it('rejects transactions outside the replayable keyed-delta subset', () => {
    const statement: WriteStatement = { kind: 'statement.delete', target: { relation, alias: 'item' } };
    expect(capturedTargetsRemain([statement], rows(row('a')), keys)).toBe(false);
  });
});
