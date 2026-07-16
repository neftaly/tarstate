import { describe, expect, it } from 'vitest';
import {
  checkCurrentConstraints,
  compileSourceConstraints,
  expandReferentialDeletes,
  sealConstraintSet
} from '../src/index.js';

const hash = (value: string) => `sha256:${value.repeat(64)}` as const;
const schemaView = { id: 'schema', contentHash: hash('a') };

describe('portable constraints and referential actions', () => {
  it('compiles portable violation queries with stable subject identities and indeterminate evidence', async () => {
    const set = await sealConstraintSet({ id: 'constraints:test', body: { schemaView, constraints: [{ id: 'unique-name', code: 'constraint.unique', dependencyRelations: ['people'], violationQuery: { kind: 'values', alias: 'violation', rows: [] } }], requiredCapabilities: [] } });
    const constraints = compileSourceConstraints({ set, mode: 'required', evaluateQuery: (_query, state: { mode: string }) => state.mode === 'unknown' ? { rows: [], completeness: 'unknown', issues: [] } : { rows: [{ subject: { relationId: 'people', key: 1 }, evidence: ['row:2'] }], completeness: 'exact', issues: [] } });
    const violated = constraints[0]?.evaluate({ mode: 'bad' }, 1);
    expect(violated).toMatchObject({ status: 'violated', violations: [{ code: 'constraint.unique', subject: { relationId: 'people', key: 1 } }] });
    const repeat = constraints[0]?.evaluate({ mode: 'bad' }, 2);
    expect(repeat).toMatchObject({ status: 'violated' });
    if (violated?.status !== 'violated' || repeat?.status !== 'violated') throw new Error('expected violation');
    expect(repeat.violations[0]?.id).toBe(violated.violations[0]?.id);
    expect(constraints[0]?.evaluate({ mode: 'unknown' }, 2)).toMatchObject({ status: 'indeterminate', failures: [{ code: 'constraint.query_indeterminate' }] });
  });

  it('derives syntactic relation dependencies and rejects incomplete overrides', async () => {
    const violationQuery = {
      kind: 'from',
      relation: { schemaView, relationId: 'people' },
      alias: 'person'
    } as const;
    await expect(sealConstraintSet({ body: {
      schemaView,
      constraints: [{ id: 'derived', code: 'constraint.derived', violationQuery }],
      requiredCapabilities: []
    } })).resolves.toMatchObject({
      body: { constraints: [{ dependencyRelations: ['people'] }] }
    });
    expect(() => sealConstraintSet({ body: {
      schemaView,
      constraints: [{
        id: 'incomplete',
        code: 'constraint.incomplete',
        dependencyRelations: ['other'],
        violationQuery
      }],
      requiredCapabilities: []
    } })).toThrow('omits query relation dependencies: people');
  });

  it('reports current required failures as blocking and audit failures as warnings', () => {
    const failure = { id: 'failure:one', subject: { scopeId: 'row:one' }, code: 'test.invalid' };
    const checked = checkCurrentConstraints({
      constraints: [
        { id: 'required', mode: 'required', dependencyRelations: [], evaluate: () => ({ status: 'violated', violations: [failure] }) },
        { id: 'audit', mode: 'audit', dependencyRelations: [], evaluate: () => ({ status: 'violated', violations: [failure] }) }
      ],
      state: {},
      basis: { revision: 1 }
    });

    expect(checked.blockingIssues).toMatchObject([{ code: 'test.invalid', severity: 'error' }]);
    expect(checked.auditIssues).toMatchObject([{ code: 'test.invalid', severity: 'warning' }]);
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

  it('matches composite referential keys and rejects invalid or partially blocked expansion', () => {
    const parent = { handle: 'parent:composite', relationId: 'parents', key: ['tenant', 1], fields: {} };
    const child = { handle: 'child:composite', relationId: 'children', key: 2, fields: { tenantId: 'tenant', parentId: 1 } };
    expect(expandReferentialDeletes({
      deleted: [parent],
      rows: [parent, child],
      actions: [{ id: 'composite', parentRelationId: 'parents', childRelationId: 'children', policy: 'cascade', childFields: ['tenantId', 'parentId'] }]
    })).toMatchObject({ edits: [{ handle: 'child:composite', kind: 'delete' }], issues: [] });
    expect(expandReferentialDeletes({
      deleted: [parent],
      rows: [parent, child],
      actions: [{ id: 'empty', parentRelationId: 'parents', childRelationId: 'children', policy: 'cascade', childFields: [] }]
    })).toMatchObject({ edits: [], issues: [{ code: 'constraint.referential_action_invalid' }] });
    expect(expandReferentialDeletes({
      deleted: [parent],
      rows: [parent, child],
      actions: [
        { id: 'cascade', parentRelationId: 'parents', childRelationId: 'children', policy: 'cascade', childFields: ['tenantId', 'parentId'] },
        { id: 'restrict', parentRelationId: 'parents', childRelationId: 'children', policy: 'restrict', childFields: ['tenantId', 'parentId'] }
      ]
    })).toMatchObject({ edits: [], issues: [{ code: 'constraint.delete_restricted' }] });
  });
});
