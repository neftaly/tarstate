import { describe, expect, it } from 'vitest';
import { check, constrain, fk, req, unique, type ConstraintSet } from '@tarstate/core/constraints';
import { q, row, tryTransact } from '@tarstate/core/db';
import { demat, mat } from '@tarstate/core/materialization';
import { field, from, gt, pipe, project, sort, asc, value } from '@tarstate/core/query';
import { insert } from '@tarstate/core/write';
import { entry, entriesById, makeDb, schema, type Entry } from './behavior-fixtures.js';

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
});
