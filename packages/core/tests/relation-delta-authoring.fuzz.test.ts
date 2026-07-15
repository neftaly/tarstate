import fc from 'fast-check';
import { expect } from 'vitest';
import {
  authorExactKeyedRelationDelta,
  type WriteStatement
} from '@tarstate/core/transactions';
import type { JsonValue } from '@tarstate/core/foundation';
import { propertyTest } from './support/property-test.js';

const hash = `sha256:${'a'.repeat(64)}` as const;
const relation = { relationId: 'fuzz.items', schemaView: { id: 'urn:test:delta-fuzz', contentHash: hash } };
const key = fc.string({ minLength: 1, maxLength: 4, unit: fc.constantFrom('a', 'b', 'c', '1', '2') });
const rowValue = fc.record({
  title: fc.string({ maxLength: 8 }),
  count: fc.integer({ min: -10, max: 10 })
});
const state = fc.dictionary(key, rowValue, { maxKeys: 12 });

propertyTest('authored exact keyed deltas deterministically reproduce every target state', fc.property(
  state,
  state,
  (beforeState, afterState) => {
    const before = rowsOf(beforeState);
    const after = rowsOf(afterState);
    const authored = authorExactKeyedRelationDelta({
      relation,
      keyFields: ['id'],
      replaceableFields: ['title', 'count'],
      before: { completeness: 'exact', rows: before },
      after: { completeness: 'exact', rows: after }
    });
    expect(authored.success).toBe(true);
    if (!authored.success) return;
    expect(applyStatements(before, authored.value)).toEqual(after);

    const reordered = authorExactKeyedRelationDelta({
      relation,
      keyFields: ['id'],
      replaceableFields: ['count', 'title'],
      before: { completeness: 'exact', rows: [...before].reverse() },
      after: { completeness: 'exact', rows: [...after].reverse() }
    });
    expect(reordered).toEqual(authored);
  }
));

type Row = { readonly id: string; readonly title: string; readonly count: number };

const rowsOf = (stateValue: Readonly<Record<string, { readonly title: string; readonly count: number }>>): readonly Row[] => Object.entries(stateValue)
  .map(([id, value]) => ({ id, ...value }))
  .sort((left, right) => left.id.localeCompare(right.id));

const applyStatements = (
  before: readonly Row[],
  statements: readonly WriteStatement[]
): readonly Row[] => {
  const rows = new Map(before.map((row) => [row.id, { ...row }]));
  for (const statement of statements) {
    if (statement.kind === 'statement.delete') {
      rows.delete(targetId(statement));
      continue;
    }
    if (statement.kind === 'statement.update') {
      const id = targetId(statement);
      const current = rows.get(id) as Record<string, JsonValue>;
      for (const [field, edit] of Object.entries(statement.edits)) {
        if (edit.kind !== 'edit.replace' || edit.value.kind !== 'literal') throw new Error('Unexpected inferred edit');
        current[field] = edit.value.value;
      }
      continue;
    }
    if (statement.kind !== 'statement.insert') throw new Error('Unexpected authored statement');
    for (const expressions of statement.rows) {
      const row: Record<string, JsonValue> = {};
      for (const [field, expression] of Object.entries(expressions)) {
        if (expression.kind !== 'literal') throw new Error('Unexpected authored expression');
        row[field] = expression.value;
      }
      rows.set(row.id as string, row as Row);
    }
  }
  return [...rows.values()].sort((left, right) => (left.id as string).localeCompare(right.id as string)) as Row[];
};

const targetId = (
  statement: Extract<WriteStatement, { readonly kind: 'statement.delete' | 'statement.update' }>
): string => {
  const where = statement.target.where;
  if (where?.kind !== 'compare' || where.right.kind !== 'literal' || typeof where.right.value !== 'string') {
    throw new Error('Unexpected keyed target');
  }
  return where.right.value;
};
