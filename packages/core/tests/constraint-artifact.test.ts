import { describe, expect, it } from 'vitest';
import { compileSourceConstraints, expandReferentialDeletes, sealConstraintSet } from '../src/index.js';

const hash = (value: string) => `sha256:${value.repeat(64)}` as const;
const schemaView = { id: 'schema', contentHash: hash('a') };

describe('portable constraints and referential actions', () => {
  it('compiles portable violation queries with stable subject identities and indeterminate evidence', async () => {
    const set = await sealConstraintSet({ id: 'constraints:test', body: { schemaView, constraints: [{ id: 'unique-name', code: 'constraint.unique', dependencyRelations: ['people'], violationQuery: { kind: 'unique-name' } }], requiredCapabilities: [] } });
    const constraints = compileSourceConstraints({ set, mode: 'required', evaluateQuery: (_query, state: { mode: string }) => state.mode === 'unknown' ? { rows: [], completeness: 'unknown', issues: [] } : { rows: [{ subject: { relationId: 'people', key: 1 }, evidence: ['row:2'] }], completeness: 'exact', issues: [] } });
    const violated = constraints[0]?.evaluate({ mode: 'bad' }, 1);
    expect(violated).toMatchObject({ status: 'violated', violations: [{ code: 'constraint.unique', subject: { relationId: 'people', key: 1 } }] });
    const repeat = constraints[0]?.evaluate({ mode: 'bad' }, 2);
    expect(repeat).toMatchObject({ status: 'violated' });
    if (violated?.status !== 'violated' || repeat?.status !== 'violated') throw new Error('expected violation');
    expect(repeat.violations[0]?.id).toBe(violated.violations[0]?.id);
    expect(constraints[0]?.evaluate({ mode: 'unknown' }, 2)).toMatchObject({ status: 'indeterminate', failures: [{ code: 'constraint.query_indeterminate' }] });
  });

  it('expands cascades to a cycle-safe fixed point and exposes restrict/set-null', () => {
    const rows = [
      { handle: 'parent:1', relationId: 'parents', key: 1, fields: {} },
      { handle: 'child:1', relationId: 'children', key: 2, fields: { parentId: 1 } },
      { handle: 'note:1', relationId: 'notes', key: 3, fields: { childId: 2 } }
    ];
    const cascade = expandReferentialDeletes({ deleted: [rows[0] as typeof rows[number]], rows, actions: [{ id: 'children', parentRelationId: 'parents', childRelationId: 'children', policy: 'cascade', childFields: ['parentId'] }, { id: 'notes', parentRelationId: 'children', childRelationId: 'notes', policy: 'set-null', childFields: ['childId'] }] });
    expect(cascade).toMatchObject({ edits: [{ handle: 'child:1', kind: 'delete' }, { handle: 'note:1', kind: 'set-null' }], issues: [] });
    expect(expandReferentialDeletes({ deleted: [rows[0] as typeof rows[number]], rows, actions: [{ id: 'restrict', parentRelationId: 'parents', childRelationId: 'children', policy: 'restrict', childFields: ['parentId'] }] })).toMatchObject({ edits: [], issues: [{ code: 'constraint.delete_restricted' }] });
  });
});
