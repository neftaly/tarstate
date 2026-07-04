import { describe, expect, it } from 'vitest';
import { createDb, q, tryTransact } from '@tarstate/core/db';
import { diffRows, type RowChange, type RowKeySelector } from '@tarstate/core/diff';
import { demat, explainMaterialization, mat, materializedRelationForQuery, materializedSourceFor } from '@tarstate/core/materialization';
import {
  aggregate,
  asc,
  avg,
  btree,
  clauses,
  count,
  desc,
  eq,
  extend,
  field,
  from,
  gte,
  hash,
  join,
  keyBy,
  limit,
  max,
  min,
  pipe,
  project,
  qualify,
  rename,
  sort,
  sum,
  union,
  uniqueIndex,
  value,
  where,
  without,
  type Query
} from '@tarstate/core/query';
import { type RelationRef } from '@tarstate/core/schema';
import { type RelationRangeLookup, type RelationSource } from '@tarstate/core/source';
import { createStore } from '@tarstate/core/store';
import { watch, watchTargetKey } from '@tarstate/core/watch';
import { deleteByKey, insertOrReplace, updateByKey, type WritePatch } from '@tarstate/core/write';
import { account, entry, makeDb, schema, type Account, type Entry } from './behavior-fixtures.js';
import { createSeededRandom, resolveFuzzSeeds } from './fuzz-helpers.js';

type SupportedVariant = {
  readonly label: string;
  readonly query: Query<unknown>;
  readonly keyBy: RowKeySelector<unknown>;
};

type UnsupportedVariant = {
  readonly label: string;
  readonly query: Query<unknown>;
};

const cashEntryProjection = pipe(
  from(entry),
  where(eq(entry.accountId, value('cash'))),
  project({
    id: entry.id,
    amount: entry.amount
  })
);

const sortedEntryProjection = pipe(
  from(entry),
  sort(asc(entry.id)),
  project({
    id: entry.id,
    accountId: entry.accountId,
    amount: entry.amount
  })
);

const entryCount = pipe(
  from(entry),
  aggregate({ aggregates: { count: count() } })
);

const firstTwoEntries = pipe(
  from(entry),
  sort(asc(entry.id)),
  limit(2)
);

const entriesByAccountId = pipe(
  from(entry),
  keyBy('accountId')
);

const supportedVariants: readonly SupportedVariant[] = [
  {
    label: 'source relation',
    query: from(entry) as Query<unknown>,
    keyBy: pathKey('id')
  },
  {
    label: 'final sort',
    query: pipe(from(entry), sort(asc(entry.amount), asc(entry.id))) as Query<unknown>,
    keyBy: pathKey('id')
  },
  {
    label: 'filtered projection',
    query: pipe(
      from(entry),
      where(gte(entry.amount, value(-75))),
      project({ id: entry.id, accountId: entry.accountId, amount: entry.amount })
    ) as Query<unknown>,
    keyBy: pathKey('id')
  },
  {
    label: 'renamed projection key',
    query: pipe(
      from(entry),
      project({ id: entry.id, accountId: entry.accountId, amount: entry.amount }),
      rename({ id: 'entryId' })
    ) as Query<unknown>,
    keyBy: pathKey('entryId')
  },
  {
    label: 'sort before project preserving sort keys',
    query: pipe(
      from(entry),
      where(eq(entry.accountId, value('cash'))),
      sort(asc(entry.amount), asc(entry.id)),
      project({ id: entry.id, accountId: entry.accountId, amount: entry.amount })
    ) as Query<unknown>,
    keyBy: pathKey('id')
  },
  {
    label: 'qualified rows',
    query: pipe(
      from(entry),
      where(eq(entry.posted, value(true))),
      qualify('entry')
    ) as Query<unknown>,
    keyBy: pathKey('entry', 'id')
  },
  {
    label: 'extended rows',
    query: pipe(
      from(entry),
      extend({ kind: value('ledger-entry') }),
      without('memo')
    ) as Query<unknown>,
    keyBy: pathKey('id')
  },
  {
    label: 'explicit keyBy identity',
    query: pipe(from(entry), keyBy('id')) as Query<unknown>,
    keyBy: pathKey('id')
  },
  {
    label: 'grouped aggregate',
    query: pipe(
      from(entry),
      aggregate({
        groupBy: { accountId: entry.accountId },
        aggregates: {
          entryCount: count(),
          lowest: min(entry.amount),
          highest: max(entry.amount),
          average: avg(entry.amount),
          total: sum(entry.amount)
        }
      }),
      sort(asc(field<string>('row', 'accountId')))
    ) as Query<unknown>,
    keyBy: pathKey('accountId')
  },
  {
    label: 'top-N sort limit projection',
    query: pipe(
      from(entry),
      sort(desc(entry.amount), asc(entry.id)),
      limit(3),
      project({ id: entry.id, amount: entry.amount })
    ) as Query<unknown>,
    keyBy: pathKey('id')
  }
];

const positiveEntryIds = pipe(
  from(entry),
  where(gte(entry.amount, value(0))),
  project({ id: entry.id })
);

const postedEntryIds = pipe(
  from(entry),
  where(eq(entry.posted, value(true))),
  project({ id: entry.id })
);

type DeclaredIndexVariant = {
  readonly label: string;
  readonly op: 'hash' | 'btree' | 'uniqueIndex';
  readonly field: 'accountId' | 'amount';
  readonly query: Query<unknown>;
};

const declaredIndexVariants: readonly DeclaredIndexVariant[] = [
  {
    label: 'hash(accountId)',
    op: 'hash',
    field: 'accountId',
    query: pipe(
      from(entry),
      project({ id: entry.id, accountId: entry.accountId, amount: entry.amount, posted: entry.posted }),
      hash(field<string>('row', 'accountId'))
    ) as Query<unknown>
  },
  {
    label: 'btree(amount)',
    op: 'btree',
    field: 'amount',
    query: pipe(
      from(entry),
      project({ id: entry.id, accountId: entry.accountId, amount: entry.amount, posted: entry.posted }),
      btree(field<number>('row', 'amount'))
    ) as Query<unknown>
  },
  {
    label: 'uniqueIndex(accountId)',
    op: 'uniqueIndex',
    field: 'accountId',
    query: pipe(
      from(entry),
      project({ id: entry.id, accountId: entry.accountId, amount: entry.amount, posted: entry.posted }),
      uniqueIndex(field<string>('row', 'accountId'))
    ) as Query<unknown>
  }
];

const joinedEntryAccounts = pipe(
  from(entry),
  join(from(account), clauses<Entry, Account>({ accountId: 'id' })),
  project({
    entryId: entry.id,
    accountId: account.id,
    entryAccountId: entry.accountId,
    amount: entry.amount,
    posted: entry.posted,
    accountName: account.$.name,
    accountKind: account.$.kind
  })
) as Query<unknown>;

const unsupportedVariants: readonly UnsupportedVariant[] = [
  {
    label: 'aggregate without groupBy identity',
    query: entryCount as Query<unknown>
  },
  {
    label: 'unsorted limit',
    query: pipe(from(entry), limit(3)) as Query<unknown>
  },
  {
    label: 'non-final sort',
    query: pipe(
      from(entry),
      sort(asc(entry.amount)),
      where(eq(entry.posted, value(true)))
    ) as Query<unknown>
  },
  {
    label: 'project drops sort key',
    query: pipe(
      from(entry),
      sort(asc(entry.amount)),
      project({ id: entry.id })
    ) as Query<unknown>
  },
  {
    label: 'set operation',
    query: pipe(
      union(positiveEntryIds, postedEntryIds),
      sort(asc(field<string>('row', 'id')))
    ) as Query<unknown>
  }
];

const supportedMaterializationSeeds = resolveFuzzSeeds([5, 17, 43, 91, 137] as const);
const mixedMaterializationSeeds = resolveFuzzSeeds([3, 11, 29, 47, 83] as const);
const declaredIndexSeeds = resolveFuzzSeeds([13, 37, 73] as const);
const joinMaterializationSeeds = resolveFuzzSeeds([19, 41, 83] as const);
const watchStoreSeeds = resolveFuzzSeeds([11, 29, 47] as const);
const unsupportedMaterializationSeeds = resolveFuzzSeeds([7, 23, 61] as const);

describe('materialization fuzz behavior', () => {
  it('keeps supported single-source materializations equivalent to dematerialized rows across seeded transactions', () => {
    let maintainedChanges = 0;
    let equivalenceChecks = 0;
    let incrementalChanges = 0;
    let carriedChanges = 0;
    let safetyRecomputes = 0;

    for (const variant of supportedVariants) {
      expect(explainMaterialization(variant.query), variant.label).toEqual(expect.objectContaining({
        supported: true,
        update: 'incremental',
        recomputed: false,
        diagnostics: []
      }));

      for (const seed of supportedMaterializationSeeds) {
        let db = mat(seededDb(seed), variant.query);
        expect(q(db, variant.query), `${variant.label} seed ${seed} initial rows`).toEqual(q(demat(db, variant.query), variant.query));

        for (const [step, patch] of randomEntryPatches(seed * 211 + variant.label.length, 36).entries()) {
          const label = `${variant.label} seed ${seed} step ${step} ${patch.op}`;
          const beforeRows = q(db, variant.query);
          const result = tryTransact(db, patch);
          expect(result.committed, `${label} committed`).toBe(true);
          db = result.db;

          const materializedRows = q(db, variant.query);
          const dematerializedRows = q(demat(db, variant.query), variant.query);
          const change = result.materializations?.changes[0];

          expect(change, `${label} maintained`).toBeDefined();
          if (change === undefined) continue;

          maintainedChanges += 1;
          equivalenceChecks += 1;
          expect(materializedRows, `${label} row identity`).toBe(change.rows);
          expect(materializedRows, `${label} materialized rows`).toEqual(dematerializedRows);
          expect(change.rows, `${label} change rows`).toEqual(dematerializedRows);
          expect(change.previousRows, `${label} previous rows`).toEqual(beforeRows);

          if (change.update === 'incremental') {
            const expected = diffRows(beforeRows, dematerializedRows, { keyBy: variant.keyBy });
            incrementalChanges += 1;
            expect(change.recomputed, `${label} recomputed`).toBe(false);
            expect(change.reason, `${label} reason`).toBe('incremental delta maintenance');
            expect(change.diagnostics, `${label} diagnostics`).toEqual([]);
            expect(change.rowChanges, `${label} row changes`).toEqual(expected.changes);
            expect(change.added, `${label} added`).toEqual(addedRows(expected.changes));
            expect(change.removed, `${label} removed`).toEqual(removedRows(expected.changes));
            expect(expected.diagnostics, `${label} oracle diagnostics`).toEqual([]);
          } else if (change.update === 'carried') {
            carriedChanges += 1;
            expect(change.recomputed, `${label} recomputed`).toBe(false);
            expect(change.reason, `${label} reason`).toBe('dependencies unchanged');
            expect(change.diagnostics, `${label} diagnostics`).toEqual([]);
            expect(change.rowChanges, `${label} row changes`).toEqual([]);
            expect(change.added, `${label} added`).toEqual([]);
            expect(change.removed, `${label} removed`).toEqual([]);
          } else {
            safetyRecomputes += 1;
            expect(change.update, `${label} update kind`).toBe('recomputed');
            expect(change.recomputed, `${label} ${change.reason}`).toBe(true);
            expect(change.diagnostics, `${label} ${change.reason}`).toEqual(expect.arrayContaining([
              expect.objectContaining({ code: 'materialization_unsupported' })
            ]));
          }
        }
      }
    }

    expect(maintainedChanges, 'expected seeded supported materialization changes').toBeGreaterThan(0);
    expect(equivalenceChecks, 'expected seeded materialized/dematerialized equivalence checks').toBeGreaterThan(0);
    expect(incrementalChanges, 'expected seeded incremental changes').toBeGreaterThan(0);
    expect(carriedChanges, 'expected seeded carried changes').toBeGreaterThan(0);
    expect(safetyRecomputes, 'expected seeded safety recomputes').toBeGreaterThan(0);
  }, 10_000);

  it('keeps mixed single-source materializations equivalent across seeded transaction sequences', () => {
    const variants: readonly UnsupportedVariant[] = [
      { label: 'cash projection', query: cashEntryProjection as Query<unknown> },
      { label: 'sorted projection', query: sortedEntryProjection as Query<unknown> },
      { label: 'account keyBy', query: entriesByAccountId as Query<unknown> },
      { label: 'entry count', query: entryCount as Query<unknown> },
      { label: 'first two entries', query: firstTwoEntries as Query<unknown> }
    ];
    let incrementalUpdates = 0;
    let fallbackRecomputes = 0;

    for (const seed of mixedMaterializationSeeds) {
      for (const variant of variants) {
        let db = mat(createDb({ accounts: makeDb().data.accounts ?? [], entries: randomEntries(seed, 7) }), variant.query);

        for (const [step, patch] of randomEntryPatches(seed * 97 + variant.query.data.op.length, 24).entries()) {
          const label = `${variant.label} seed ${seed} step ${step} ${patch.op}`;
          const result = tryTransact(db, patch);
          expect(result.committed, `${label} committed`).toBe(true);
          db = result.db;

          expect(q(db, variant.query), `${label} materialized rows`).toEqual(q(demat(db, variant.query), variant.query));

          const change = result.materializations?.changes[0];
          if (change?.update === 'incremental') incrementalUpdates += 1;
          if (change?.update === 'recomputed') {
            expect(change.diagnostics, `${label} recompute diagnostics`).toEqual(expect.arrayContaining([
              expect.objectContaining({ code: 'materialization_unsupported' })
            ]));
            fallbackRecomputes += 1;
          }
        }
      }
    }

    expect(incrementalUpdates).toBeGreaterThan(0);
    expect(fallbackRecomputes).toBeGreaterThan(0);
    expect(explainMaterialization(cashEntryProjection)).toEqual(expect.objectContaining({
      supported: true,
      update: 'incremental',
      recomputed: false,
      diagnostics: []
    }));
    expect(explainMaterialization(entriesByAccountId)).toEqual(expect.objectContaining({
      supported: true,
      update: 'incremental',
      recomputed: false,
      diagnostics: []
    }));
    expect(explainMaterialization(entryCount)).toEqual(expect.objectContaining({
      supported: false,
      update: 'recomputed',
      recomputed: true,
      diagnostics: expect.arrayContaining([
        expect.objectContaining({ code: 'materialization_unsupported' })
      ])
    }));
  });

  it('keeps declared materialized indexes equivalent to source row filtering after seeded random writes', () => {
    let lookupChecks = 0;
    let indexSpecChecks = 0;

    for (const variant of declaredIndexVariants) {
      expect(explainMaterialization(variant.query), variant.label).toEqual(expect.objectContaining({
        supported: true,
        update: 'incremental',
        recomputed: false,
        diagnostics: []
      }));

      for (const seed of declaredIndexSeeds) {
        let db = mat(seededDb(seed), variant.query);
        lookupChecks += expectDeclaredIndexLookups(db, variant, seed);

        for (const [step, patch] of randomEntryPatchesForDb(seed, seed * 811 + variant.label.length, 28).entries()) {
          const label = `${variant.label} seed ${seed} step ${step} ${patch.op}`;
          const result = tryTransact(db, patch);
          expect(result.committed, `${label} committed`).toBe(true);
          db = result.db;

          const change = result.materializations?.changes[0];
          expect(q(db, variant.query), `${label} materialized rows`).toEqual(q(demat(db, variant.query), variant.query));
          if (change !== undefined) {
            indexSpecChecks += 1;
            expect(change.indexSpecs, `${label} index specs`).toEqual([
              expect.objectContaining({ op: variant.op, field: variant.field })
            ]);
          }

          lookupChecks += expectDeclaredIndexLookups(db, variant, seed * 4099 + step);
        }
      }
    }

    expect(lookupChecks).toBeGreaterThan(0);
    expect(indexSpecChecks).toBeGreaterThan(0);
  });

  it('keeps supported two-relation join materializations equivalent to dematerialized recompute across seeded random writes', () => {
    let equivalenceChecks = 0;
    let diffChecks = 0;

    expect(explainMaterialization(joinedEntryAccounts)).toEqual(expect.objectContaining({
      supported: true,
      update: 'incremental',
      recomputed: false,
      diagnostics: []
    }));

    for (const seed of joinMaterializationSeeds) {
      let db = mat(seededDb(seed), joinedEntryAccounts);
      expect(q(db, joinedEntryAccounts), `join seed ${seed} initial rows`).toEqual(q(demat(db, joinedEntryAccounts), joinedEntryAccounts));

      for (const [step, patch] of randomJoinPatches(seed, seed * 1559, 36).entries()) {
        const label = `join seed ${seed} step ${step} ${patch.op}`;
        const beforeRows = q(db, joinedEntryAccounts);
        const result = tryTransact(db, patch);
        expect(result.committed, `${label} committed`).toBe(true);
        db = result.db;

        const materializedRows = q(db, joinedEntryAccounts);
        const dematerializedRows = q(demat(db, joinedEntryAccounts), joinedEntryAccounts);
        const change = result.materializations?.changes[0];

        equivalenceChecks += 1;
        expect(materializedRows, `${label} materialized rows`).toEqual(dematerializedRows);
        expect(change, `${label} maintained`).toBeDefined();
        if (change === undefined) continue;

        expect(materializedRows, `${label} row identity`).toBe(change.rows);
        expect(change.rows, `${label} change rows`).toEqual(dematerializedRows);
        expect(change.previousRows, `${label} previous rows`).toEqual(beforeRows);

        if (change.update === 'incremental') {
          const expected = diffRows(beforeRows, dematerializedRows, { keyBy: joinedEntryAccountKey });
          diffChecks += 1;
          expect(change.recomputed, `${label} recomputed`).toBe(false);
          expect(change.reason, `${label} reason`).toBe('incremental delta maintenance');
          expect(change.diagnostics, `${label} diagnostics`).toEqual([]);
          expect(change.rowChanges, `${label} row changes`).toEqual(expected.changes);
          expect(change.added, `${label} added`).toEqual(addedRows(expected.changes));
          expect(change.removed, `${label} removed`).toEqual(removedRows(expected.changes));
          expect(expected.diagnostics, `${label} oracle diagnostics`).toEqual([]);
        } else if (change.update === 'carried') {
          expect(change.recomputed, `${label} recomputed`).toBe(false);
          expect(change.reason, `${label} reason`).toBe('dependencies unchanged');
          expect(change.diagnostics, `${label} diagnostics`).toEqual([]);
          expect(change.rowChanges, `${label} row changes`).toEqual([]);
          expect(change.added, `${label} added`).toEqual([]);
          expect(change.removed, `${label} removed`).toEqual([]);
        } else {
          expect(change.update, `${label} update kind`).toBe('recomputed');
          expect(change.recomputed, `${label} ${change.reason}`).toBe(true);
        }
      }
    }

    expect(equivalenceChecks).toBeGreaterThan(0);
    expect(diffChecks).toBeGreaterThan(0);
  });

  it('reports materialized watch and store row changes that match diffRows for seeded transactions', async () => {
    let watchDiffChecks = 0;
    let storeDiffChecks = 0;

    for (const variant of supportedVariants.slice(0, 4)) {
      for (const seed of watchStoreSeeds) {
        let db = mat(seededDb(seed), variant.query);
        const store = createStore(mat(seededDb(seed), variant.query));
        const view = store.view(variant.query);
        const events: unknown[] = [];
        const handle = watch(db, variant.query, (event) => {
          events.push(event);
        }, {
          label: `materialization-fuzz-${seed}-${variant.label}`,
          keyBy: variant.keyBy
        });

        try {
          for (const [step, patch] of randomEntryPatches(seed * 1231 + variant.label.length, 10).entries()) {
            const label = `${variant.label} seed ${seed} step ${step} ${patch.op}`;
            const beforeRows = q(db, variant.query);
            const beforeStoreRows = view.getSnapshot().rows;
            expect(beforeStoreRows, `${label} store rows before`).toEqual(beforeRows);

            const result = tryTransact(db, patch);
            expect(result.committed, `${label} committed`).toBe(true);
            db = result.db;

            const afterRows = q(demat(db, variant.query), variant.query);
            const expected = diffRows(beforeRows, afterRows, { keyBy: variant.keyBy });
            expect(expected.diagnostics, `${label} oracle diagnostics`).toEqual([]);

            const materializationChange = result.materializations?.changes[0];
            if (materializationChange?.update === 'incremental') {
              expect(materializationChange.rowChanges, `${label} materialization changes`).toEqual(expected.changes);
            }

            const refresh = await handle.refresh(db);
            expect(refresh, `${label} watch refresh`).toEqual(expect.objectContaining({
              targetKey: watchTargetKey(variant.query),
              previousRows: beforeRows,
              rows: afterRows,
              rowChanges: expected.changes,
              added: addedRows(expected.changes),
              removed: removedRows(expected.changes),
              diagnostics: []
            }));
            expect(events[events.length - 1], `${label} watch event`).toEqual(expect.objectContaining({
              rowChanges: expected.changes,
              added: addedRows(expected.changes),
              removed: removedRows(expected.changes)
            }));
            watchDiffChecks += 1;

            const commit = await store.commit(patch);
            expect(commit, `${label} store commit`).toEqual(expect.objectContaining({
              status: 'accepted',
              reflected: true
            }));
            expect(commit.diagnostics.filter((diagnostic) => diagnostic.severity === 'error'), `${label} commit diagnostics`).toEqual([]);
            expect(commit.effects.diagnostics.filter((diagnostic) => diagnostic.severity === 'error'), `${label} effect diagnostics`).toEqual([]);
            const afterStoreRows = view.getSnapshot().rows;
            const storeDiff = diffRows(beforeStoreRows, afterStoreRows, { keyBy: variant.keyBy });
            expect(afterStoreRows, `${label} store rows after`).toEqual(afterRows);
            expect(storeDiff, `${label} store diff`).toEqual(expected);
            storeDiffChecks += 1;
          }
        } finally {
          handle.unwatch();
          store.close();
        }
      }
    }

    expect(watchDiffChecks).toBeGreaterThan(0);
    expect(storeDiffChecks).toBeGreaterThan(0);
  });

  it('cleanly recomputes unsupported single-source shapes across seeded transactions', () => {
    let recomputes = 0;

    for (const variant of unsupportedVariants) {
      expect(explainMaterialization(variant.query), variant.label).toEqual(expect.objectContaining({
        supported: false,
        update: 'recomputed',
        recomputed: true,
        diagnostics: expect.arrayContaining([
          expect.objectContaining({ code: 'materialization_unsupported' })
        ])
      }));

      for (const seed of unsupportedMaterializationSeeds) {
        let db = mat(seededDb(seed), variant.query);
        expect(q(db, variant.query), `${variant.label} seed ${seed} initial rows`).toEqual(q(demat(db, variant.query), variant.query));

        for (const [step, patch] of guaranteedEntryReplacements(seed * 1543 + variant.label.length, 14).entries()) {
          const label = `${variant.label} seed ${seed} step ${step} ${patch.op}`;
          const beforeRows = q(db, variant.query);
          const result = tryTransact(db, patch);
          expect(result.committed, `${label} committed`).toBe(true);
          expect(result.applied, `${label} applied`).toBeGreaterThan(0);
          db = result.db;

          const materializedRows = q(db, variant.query);
          const dematerializedRows = q(demat(db, variant.query), variant.query);
          const change = result.materializations?.changes[0];
          const expected = diffRows(beforeRows, dematerializedRows);

          expect(change, `${label} recomputed`).toBeDefined();
          if (change === undefined) continue;

          recomputes += 1;
          expect(materializedRows, `${label} row identity`).toBe(change.rows);
          expect(materializedRows, `${label} materialized rows`).toEqual(dematerializedRows);
          expect(change, `${label} materialization change`).toEqual(expect.objectContaining({
            update: 'recomputed',
            recomputed: true,
            previousRows: beforeRows,
            rows: dematerializedRows,
            rowChanges: expected.changes,
            added: addedRows(expected.changes),
            removed: removedRows(expected.changes),
            diagnostics: expect.arrayContaining([
              expect.objectContaining({ code: 'materialization_unsupported' })
            ])
          }));
          expect(expected.diagnostics, `${label} oracle diagnostics`).toEqual([]);
        }
      }
    }

    expect(recomputes).toBeGreaterThan(0);
  });
});

function seededDb(seed: number) {
  const base = makeDb();
  return createDb({
    accounts: base.data.accounts ?? [],
    entries: randomEntries(seed, 12)
  });
}

function pathKey(...path: readonly string[]): RowKeySelector<unknown> {
  return (row) => {
    let current: unknown = row;
    for (const segment of path) {
      if (!isRecord(current)) return undefined;
      current = current[segment];
    }
    return [current];
  };
}

function joinedEntryAccountKey(row: unknown): readonly unknown[] {
  return isRecord(row) ? [row.entryId, row.accountId] : [undefined, undefined];
}

function expectDeclaredIndexLookups(db: unknown, variant: DeclaredIndexVariant, seed: number): number {
  const relation = requireMaterializedRelationForQuery(db, variant.query);
  const source = requireMaterializedSourceFor(db);
  const rows = source.rows(relation);

  if (variant.op === 'btree') {
    const lookups = amountRangeLookups(seed, relation);
    for (const lookup of lookups) {
      expect(source.rangeLookup?.(lookup), `${variant.label} seed ${seed} range ${JSON.stringify(lookup)}`).toEqual(
        rows.filter((row) => rangeContains(row, lookup))
      );
    }
    return lookups.length;
  }

  const values = ['cash', 'sales', 'fees', 'equity', 'missing'] as const;
  for (const valueValue of values) {
    expect(source.lookup?.({ relation, field: variant.field, value: valueValue }), `${variant.label} seed ${seed} lookup ${valueValue}`).toEqual(
      rows.filter((row) => isRecord(row) && Object.is(row[variant.field], valueValue))
    );
  }
  return values.length;
}

function requireMaterializedRelationForQuery(db: unknown, query: Query<unknown>): RelationRef<Record<string, unknown>> {
  const relation = materializedRelationForQuery(db, query);
  if (relation === undefined) throw new Error('expected materialized relation metadata');
  return relation;
}

function requireMaterializedSourceFor(input: unknown): RelationSource {
  const source = materializedSourceFor(input);
  if (source === undefined) throw new Error('expected materialized source');
  return source;
}

function amountRangeLookups(seed: number, relation: RelationRef): readonly RelationRangeLookup[] {
  const next = createSeededRandom(seed);
  const first = Math.floor(next() * 501) - 250;
  const second = Math.floor(next() * 501) - 250;
  const lower = Math.min(first, second);
  const upper = Math.max(first, second);
  return [
    { relation, field: 'amount' },
    { relation, field: 'amount', lower: { value: -100, inclusive: true } },
    { relation, field: 'amount', lower: { value: 0, inclusive: false } },
    { relation, field: 'amount', upper: { value: 0, inclusive: true } },
    {
      relation,
      field: 'amount',
      lower: { value: lower, inclusive: next() > 0.5 },
      upper: { value: upper, inclusive: next() > 0.5 }
    }
  ];
}

function rangeContains(row: unknown, lookup: RelationRangeLookup): boolean {
  if (!isRecord(row)) return false;
  const rowValue = row[lookup.field];
  if (lookup.lower !== undefined) {
    const comparisonValue = compareLookupValues(rowValue, lookup.lower.value);
    if (comparisonValue < 0 || (comparisonValue === 0 && !lookup.lower.inclusive)) return false;
  }
  if (lookup.upper !== undefined) {
    const comparisonValue = compareLookupValues(rowValue, lookup.upper.value);
    if (comparisonValue > 0 || (comparisonValue === 0 && !lookup.upper.inclusive)) return false;
  }
  return true;
}

function compareLookupValues(left: unknown, right: unknown): number {
  if (Object.is(left, right)) return 0;
  if (left === undefined || left === null) return -1;
  if (right === undefined || right === null) return 1;
  if (typeof left === 'number' && typeof right === 'number') return left < right ? -1 : 1;
  if (typeof left === 'string' && typeof right === 'string') return left.localeCompare(right);
  if (typeof left === 'boolean' && typeof right === 'boolean') return Number(left) - Number(right);
  return JSON.stringify(left).localeCompare(JSON.stringify(right));
}

function addedRows<Row>(changes: readonly RowChange<Row>[]): readonly Row[] {
  return changes.flatMap((change) => change.kind === 'added' ? [change.row] : []);
}

function removedRows<Row>(changes: readonly RowChange<Row>[]): readonly Row[] {
  return changes.flatMap((change) => change.kind === 'removed' ? [change.row] : []);
}

function randomEntries(seed: number, count: number): Entry[] {
  const next = createSeededRandom(seed);
  return Array.from({ length: count }, (_, index) => randomEntry(next, `r${seed}-${index}`, index));
}

function randomEntryPatches(seed: number, count: number): WritePatch[] {
  const next = createSeededRandom(seed);
  const patches: WritePatch[] = [];
  for (let index = 0; index < count; index += 1) {
    const id = `r${seed}-${Math.floor(next() * 12)}`;
    const row = randomEntry(next, id, index);
    const op = index % 5;
    if (op === 0 || op === 3 || op === 4) {
      patches.push(insertOrReplace(schema.entries, row));
    } else if (op === 1) {
      patches.push(updateByKey(schema.entries, id, {
        accountId: row.accountId,
        amount: row.amount,
        ...(row.memo === undefined ? {} : { memo: row.memo }),
        posted: row.posted
      }));
    } else {
      patches.push(deleteByKey(schema.entries, id));
    }
  }
  return patches;
}

function randomEntryPatchesForDb(dbSeed: number, seed: number, count: number): WritePatch[] {
  const next = createSeededRandom(seed);
  const patches: WritePatch[] = [];
  for (let index = 0; index < count; index += 1) {
    const id = index % 4 === 0
      ? `r${dbSeed}-new-${Math.floor(next() * 6)}`
      : `r${dbSeed}-${Math.floor(next() * 12)}`;
    const row = randomEntry(next, id, index);
    const op = index % 5;
    if (op === 0 || op === 3 || op === 4) {
      patches.push(insertOrReplace(schema.entries, row));
    } else if (op === 1) {
      patches.push(updateByKey(schema.entries, id, {
        accountId: row.accountId,
        amount: row.amount,
        ...(row.memo === undefined ? {} : { memo: row.memo }),
        posted: row.posted
      }));
    } else {
      patches.push(deleteByKey(schema.entries, id));
    }
  }
  return patches;
}

function randomJoinPatches(dbSeed: number, seed: number, count: number): WritePatch[] {
  const next = createSeededRandom(seed);
  const patches: WritePatch[] = [];
  const accountIds = ['cash', 'sales', 'fees', 'equity'] as const;
  const accountKinds = ['asset', 'income', 'expense', 'equity', 'liability'] as const satisfies readonly Account['kind'][];

  for (let index = 0; index < count; index += 1) {
    const op = index % 6;
    if (op === 0 || op === 3) {
      const id = next() > 0.25 ? `r${dbSeed}-${Math.floor(next() * 12)}` : `r${dbSeed}-join-${Math.floor(next() * 8)}`;
      patches.push(insertOrReplace(schema.entries, randomEntry(next, id, index)));
    } else if (op === 1) {
      const id = `r${dbSeed}-${Math.floor(next() * 12)}`;
      const row = randomEntry(next, id, index);
      patches.push(updateByKey(schema.entries, id, {
        accountId: row.accountId,
        amount: row.amount,
        posted: row.posted
      }));
    } else if (op === 2) {
      patches.push(deleteByKey(schema.entries, `r${dbSeed}-${Math.floor(next() * 12)}`));
    } else {
      const accountId = accountIds[Math.floor(next() * accountIds.length)] ?? 'cash';
      patches.push(updateByKey(schema.accounts, accountId, {
        name: `Account ${accountId} ${seed}-${index}-${Math.floor(next() * 100)}`,
        kind: accountKinds[Math.floor(next() * accountKinds.length)] ?? 'asset'
      }));
    }
  }

  return patches;
}

function guaranteedEntryReplacements(seed: number, count: number): WritePatch[] {
  const next = createSeededRandom(seed);
  return Array.from({ length: count }, (_, index) => {
    const id = `r${seed}-${index % 8}`;
    return insertOrReplace(schema.entries, randomEntry(next, id, index));
  });
}

function randomEntry(next: () => number, id: string, index: number): Entry {
  const accountIds = ['cash', 'sales', 'fees', 'equity'] as const;
  return {
    id,
    accountId: accountIds[Math.floor(next() * accountIds.length)] ?? 'cash',
    amount: Math.floor(next() * 501) - 250,
    memo: next() > 0.66 ? null : `fuzz-${index}-${Math.floor(next() * 20)}`,
    posted: next() > 0.35
  };
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === 'object' && input !== null;
}
