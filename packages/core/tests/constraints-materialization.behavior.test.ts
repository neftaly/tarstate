import { describe, expect, it } from 'vitest';
import { check, constrain, fk, req, unique, type ConstraintSet } from '@tarstate/core/constraints';
import { createDb, q, row, tryTransact } from '@tarstate/core/db';
import { demat, mat } from '@tarstate/core/materialization';
import { field, from, gt, pipe, project, sort, asc, value } from '@tarstate/core/query';
import { defineSchema, idField, relation, stringField } from '@tarstate/core/schema';
import { deleteByKey, insert } from '@tarstate/core/write';
import { entry, entriesById, makeDb, schema, type Entry } from './behavior-fixtures.js';

type Parent = {
  readonly tenantId: string;
  readonly id: string;
  readonly name: string;
};

type Child = {
  readonly id: string;
  readonly tenantId: string;
  readonly parentId: string;
  readonly note: string;
};

const cascadeSchema = defineSchema({
  parents: relation<Parent, readonly ['tenantId', 'id']>({
    key: ['tenantId', 'id'] as const,
    fields: {
      tenantId: idField('tenant'),
      id: idField('parent'),
      name: stringField()
    }
  }),
  children: relation<Child>({
    key: 'id',
    fields: {
      id: idField('child'),
      tenantId: stringField(),
      parentId: stringField(),
      note: stringField()
    }
  })
});

const entryConstraints: ConstraintSet = constrain(
  req(schema.entries, 'id', 'accountId', 'amount', 'posted'),
  unique(schema.entries, 'id'),
  fk(schema.entries, 'accountId', schema.accounts, 'id'),
  check(from(entry), gt(field<number>('entry', 'amount'), value(-1_000_000)))
);

describe('constraint enforcement through materialization', () => {
  it('accepts transactions that satisfy materialized constraints', () => {
    const constrained = mat(makeDb(), entryConstraints);
    const validEntry = { id: 'e5', accountId: 'cash', amount: 15, memo: 'tip', posted: true } as const satisfies Entry;
    const result = tryTransact(constrained, insert(schema.entries, validEntry));

    expect(result.committed).toBe(true);
    expect(result.applied).toBe(1);
    expect(result.diagnostics).toEqual([]);
    expect(row(result.db, schema.entries, 'e5')).toEqual(validEntry);
  });

  it('rejects required, unique, foreign-key, and check violations', () => {
    const constrained = mat(makeDb(), entryConstraints);
    const cases = [
      {
        label: 'required amount',
        patch: insert(schema.entries, { id: 'missing-amount', accountId: 'cash', posted: true } as never),
        code: 'required',
        field: 'amount'
      },
      {
        label: 'unique id',
        patch: insert(schema.entries, { id: 'e1', accountId: 'cash', amount: 1, posted: true }),
        code: 'unique',
        field: 'id'
      },
      {
        label: 'foreign key',
        patch: insert(schema.entries, { id: 'orphan', accountId: 'missing', amount: 1, posted: true }),
        code: 'foreign_key',
        field: 'accountId'
      },
      {
        label: 'check predicate',
        patch: insert(schema.entries, { id: 'too-low', accountId: 'cash', amount: -1_000_001, posted: true }),
        code: 'check',
        field: 'amount'
      }
    ] as const;

    for (const testCase of cases) {
      const result = tryTransact(constrained, testCase.patch);

      expect(result.committed, testCase.label).toBe(false);
      expect(result.applied, testCase.label).toBe(0);
      expect(result.db, testCase.label).toBe(constrained);
      expect(result.diagnostics, testCase.label).toEqual(expect.arrayContaining([
        expect.objectContaining({
          code: testCase.code,
          relation: 'entries',
          field: testCase.field
        })
      ]));
    }

    expect(q(constrained, pipe(from(entry), sort(asc(entry.id)), project({ id: entry.id })))).toEqual([
      { id: 'e1' },
      { id: 'e2' },
      { id: 'e3' },
      { id: 'e4' }
    ]);
  });

  it('demat removes enforcement for the selected constraints', () => {
    const constrained = mat(makeDb(), entryConstraints);
    const relaxed = demat(constrained, entryConstraints);
    const orphan = { id: 'orphan', accountId: 'missing', amount: 1, posted: true } as const satisfies Entry;
    const result = tryTransact(relaxed, insert(schema.entries, orphan));

    expect(result.committed).toBe(true);
    expect(result.diagnostics).toEqual([]);
    expect(q(result.db, entriesById)).toEqual([
      { id: 'e1', accountId: 'cash', amount: 120, memo: 'invoice paid', posted: true },
      { id: 'e2', accountId: 'sales', amount: -120, memo: 'invoice paid', posted: true },
      { id: 'e3', accountId: 'fees', amount: -5, memo: null, posted: true },
      { id: 'e4', accountId: 'cash', amount: 0, posted: false },
      orphan
    ]);
  });

  it('cascades simple foreign-key deletes', () => {
    const constrained = mat(
      makeDb(),
      fk(schema.entries, 'accountId', schema.accounts, 'id', { cascade: 'delete' })
    );
    const result = tryTransact(constrained, deleteByKey(schema.accounts, 'cash'));

    expect(result.committed).toBe(true);
    expect(q(result.db, entriesById)).toEqual([
      { id: 'e2', accountId: 'sales', amount: -120, memo: 'invoice paid', posted: true },
      { id: 'e3', accountId: 'fees', amount: -5, memo: null, posted: true }
    ]);
  });

  it('cascades composite foreign-key deletes by matching all components together', () => {
    const db = createDb({
      parents: [
        { tenantId: 't1', id: 'p1', name: 'target' },
        { tenantId: 't1', id: 'p2', name: 'same tenant' },
        { tenantId: 't2', id: 'p1', name: 'same parent id' }
      ] satisfies readonly Parent[],
      children: [
        { id: 'match', tenantId: 't1', parentId: 'p1', note: 'delete me' },
        { id: 'same-tenant', tenantId: 't1', parentId: 'p2', note: 'keep me' },
        { id: 'same-parent', tenantId: 't2', parentId: 'p1', note: 'keep me too' }
      ] satisfies readonly Child[]
    });
    const constrained = mat(
      db,
      fk(
        cascadeSchema.children,
        ['tenantId', 'parentId'],
        cascadeSchema.parents,
        ['tenantId', 'id'],
        { cascade: 'delete' }
      )
    );
    const result = tryTransact(
      constrained,
      deleteByKey(cascadeSchema.parents, ['t1', 'p1'] as const)
    );

    expect(result.committed).toBe(true);
    expect(q(result.db, cascadeSchema.children, { sort: 'id' })).toEqual([
      { id: 'same-parent', tenantId: 't2', parentId: 'p1', note: 'keep me too' },
      { id: 'same-tenant', tenantId: 't1', parentId: 'p2', note: 'keep me' }
    ]);
  });
});
