import fc from 'fast-check';
import { expect } from 'vitest';
import {
  applyJsonTreeCommands,
  jsonTreePathFootprint,
  relateJsonTreeFootprints,
  type JsonTreeCommand
} from '../src/database/external-store/json-tree.js';
import { propertyTest } from './support/property-test.js';

const row = fc.record({
  title: fc.string({ maxLength: 12 }),
  count: fc.integer({ min: -100, max: 100 })
});
const key = fc.string({ minLength: 1, maxLength: 6, unit: fc.constantFrom('a', 'b', 'c', '1', '2') });

propertyTest('external-store grouped path edits preserve their immutable oracle', fc.property(
  fc.dictionary(key, row, { minKeys: 1, maxKeys: 12 }),
  fc.array(fc.tuple(key, row), { maxLength: 16 }),
  (generatedRows, generatedEdits) => {
    const rows = Object.freeze(Object.fromEntries(
      Object.entries(generatedRows).map(([id, value]) => [id, Object.freeze({ ...value })])
    ));
    const state = Object.freeze({ rows, untouched: Object.freeze({ value: 1 }) });
    const edits = generatedEdits.filter(([id]) => Object.hasOwn(rows, id));
    const commands: JsonTreeCommand[] = [];
    const oracle: {
      rows: Record<string, { title: string; count: number }>;
      untouched: { value: number };
    } = structuredClone(state);
    for (const [id, value] of edits) {
      commands.push({ kind: 'replace', path: ['rows', id, 'title'], value: value.title });
      commands.push({ kind: 'replace', path: ['rows', id, 'count'], value: value.count });
      oracle.rows[id] = { ...value };
    }
    const applied = applyJsonTreeCommands(state, [{ kind: 'batch', commands }]);
    expect(applied.issues).toEqual([]);
    expect(applied.state).toEqual(oracle);
    expect(state.rows).toEqual(generatedRows);
    expect(applied.state.untouched).toBe(state.untouched);
    if (commands.length === 0) {
      expect(applied.state).toBe(state);
    } else {
      expect(applied.state).not.toBe(state);
      expect(Object.isFrozen(applied.state)).toBe(true);
      expect(Object.isFrozen(applied.state.rows)).toBe(true);
    }
  }
));

const path = fc.array(
  fc.oneof(
    fc.string({ minLength: 1, maxLength: 4 }),
    fc.integer({ min: 0, max: 5 })
  ),
  { maxLength: 5 }
);

propertyTest('external-store path-footprint relations are inverse-symmetric', fc.property(
  path,
  path,
  fc.constantFrom('exact' as const, 'subtree' as const),
  fc.constantFrom('exact' as const, 'subtree' as const),
  (leftPath, rightPath, leftScope, rightScope) => {
    const left = jsonTreePathFootprint([{ scope: leftScope, path: leftPath }]);
    const right = jsonTreePathFootprint([{ scope: rightScope, path: rightPath }]);
    const relation = relateJsonTreeFootprints(left, right);
    const inverse = relateJsonTreeFootprints(right, left);
    expect(inverse).toBe(inverseRelation(relation));
  }
));

propertyTest('external-store exact paths are contained by same-path subtrees', fc.property(
  path,
  (generatedPath) => {
    const exact = jsonTreePathFootprint([{ scope: 'exact', path: generatedPath }]);
    const subtree = jsonTreePathFootprint([{ scope: 'subtree', path: generatedPath }]);
    expect(relateJsonTreeFootprints(exact, subtree)).toBe('contained_by');
    expect(relateJsonTreeFootprints(subtree, exact)).toBe('contains');
  }
));

const inverseRelation = (
  relation: ReturnType<typeof relateJsonTreeFootprints>
): ReturnType<typeof relateJsonTreeFootprints> => {
  if (relation === 'contains') return 'contained_by';
  if (relation === 'contained_by') return 'contains';
  return relation;
};
