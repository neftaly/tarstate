import { describe, expect, it } from 'vitest';
import { createDb, q, tryTransact } from '@tarstate/core/db';
import { diffRows, type RowChange, type RowKeySelector } from '@tarstate/core/diff';
import { demat, explainMaterialization, mat } from '@tarstate/core/materialization';
import {
  asc,
  eq,
  extend,
  field,
  from,
  gte,
  keyBy,
  limit,
  pipe,
  project,
  qualify,
  rename,
  sort,
  union,
  value,
  where,
  without,
  type Query
} from '@tarstate/core/query';
import { createStore } from '@tarstate/core/store';
import { watch, watchTargetKey } from '@tarstate/core/watch';
import { deleteByKey, insertOrReplace, updateByKey, type WritePatch } from '@tarstate/core/write';
import { entry, makeDb, schema, type Entry } from './behavior-fixtures.js';

type SupportedVariant = {
  readonly label: string;
  readonly query: Query<unknown>;
  readonly keyBy: RowKeySelector<unknown>;
};

type UnsupportedVariant = {
  readonly label: string;
  readonly query: Query<unknown>;
};

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

const unsupportedVariants: readonly UnsupportedVariant[] = [
  {
    label: 'limit',
    query: pipe(from(entry), sort(asc(entry.id)), limit(3)) as Query<unknown>
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

describe('materialization fuzz behavior', () => {
  it('keeps supported single-source materializations equivalent to dematerialized rows across seeded transactions', () => {
    let maintainedChanges = 0;
    let equivalenceChecks = 0;

    for (const variant of supportedVariants) {
      expect(explainMaterialization(variant.query), variant.label).toEqual(expect.objectContaining({
        supported: true,
        update: 'incremental',
        recomputed: false,
        diagnostics: []
      }));

      for (const seed of [5, 17, 43, 91]) {
        let db = mat(seededDb(seed), variant.query);
        expect(q(db, variant.query)).toEqual(q(demat(db, variant.query), variant.query));

        for (const patch of randomEntryPatches(seed * 997 + variant.label.length, 24)) {
          const beforeRows = q(db, variant.query);
          const result = tryTransact(db, patch);
          expect(result.committed, `${variant.label} committed ${patch.op}`).toBe(true);
          db = result.db;

          const materializedRows = q(db, variant.query);
          const dematerializedRows = q(demat(db, variant.query), variant.query);
          const change = result.materializations?.changes[0];

          expect(change, `${variant.label} maintained ${patch.op}`).toBeDefined();
          if (change === undefined) continue;

          maintainedChanges += 1;
          equivalenceChecks += 1;
          expect(materializedRows).toBe(change.rows);
          expect(materializedRows).toEqual(dematerializedRows);
          expect(change.rows).toEqual(dematerializedRows);
          expect(change.previousRows).toEqual(beforeRows);

          if (change.update === 'incremental') {
            const expected = diffRows(beforeRows, dematerializedRows, { keyBy: variant.keyBy });
            expect(change.recomputed, variant.label).toBe(false);
            expect(change.reason).toBe('incremental delta maintenance');
            expect(change.diagnostics, variant.label).toEqual([]);
            expect(change.rowChanges).toEqual(expected.changes);
            expect(change.added).toEqual(addedRows(expected.changes));
            expect(change.removed).toEqual(removedRows(expected.changes));
            expect(expected.diagnostics).toEqual([]);
          } else if (change.update === 'carried') {
            expect(change.recomputed, variant.label).toBe(false);
            expect(change.reason).toBe('dependencies unchanged');
            expect(change.diagnostics, variant.label).toEqual([]);
            expect(change.rowChanges).toEqual([]);
            expect(change.added).toEqual([]);
            expect(change.removed).toEqual([]);
          } else {
            expect(change.update).toBe('recomputed');
            expect(change.recomputed, `${variant.label} ${patch.op} ${change.reason}`).toBe(true);
          }
        }
      }
    }

    expect(maintainedChanges).toBeGreaterThan(0);
    expect(equivalenceChecks).toBeGreaterThan(0);
  });

  it('reports materialized watch and store row changes that match diffRows for seeded transactions', async () => {
    let watchDiffChecks = 0;
    let storeDiffChecks = 0;

    for (const variant of supportedVariants.slice(0, 4)) {
      for (const seed of [11, 29, 47]) {
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
          for (const patch of randomEntryPatches(seed * 1231 + variant.label.length, 10)) {
            const beforeRows = q(db, variant.query);
            const beforeStoreRows = view.getSnapshot().rows;
            expect(beforeStoreRows).toEqual(beforeRows);

            const result = tryTransact(db, patch);
            expect(result.committed, `${variant.label} committed ${patch.op}`).toBe(true);
            db = result.db;

            const afterRows = q(demat(db, variant.query), variant.query);
            const expected = diffRows(beforeRows, afterRows, { keyBy: variant.keyBy });
            expect(expected.diagnostics).toEqual([]);

            const materializationChange = result.materializations?.changes[0];
            if (materializationChange?.update === 'incremental') {
              expect(materializationChange.rowChanges).toEqual(expected.changes);
            }

            const refresh = await handle.refresh(db);
            expect(refresh).toEqual(expect.objectContaining({
              targetKey: watchTargetKey(variant.query),
              previousRows: beforeRows,
              rows: afterRows,
              rowChanges: expected.changes,
              added: addedRows(expected.changes),
              removed: removedRows(expected.changes),
              diagnostics: []
            }));
            expect(events[events.length - 1]).toEqual(expect.objectContaining({
              rowChanges: expected.changes,
              added: addedRows(expected.changes),
              removed: removedRows(expected.changes)
            }));
            watchDiffChecks += 1;

            const commit = await store.commit(patch);
            expect(commit).toEqual(expect.objectContaining({
              status: 'accepted',
              reflected: true
            }));
            expect(commit.diagnostics.filter((diagnostic) => diagnostic.severity === 'error')).toEqual([]);
            expect(commit.effects.diagnostics.filter((diagnostic) => diagnostic.severity === 'error')).toEqual([]);
            const afterStoreRows = view.getSnapshot().rows;
            const storeDiff = diffRows(beforeStoreRows, afterStoreRows, { keyBy: variant.keyBy });
            expect(afterStoreRows).toEqual(afterRows);
            expect(storeDiff).toEqual(expected);
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

      for (const seed of [7, 23, 61]) {
        let db = mat(seededDb(seed), variant.query);
        expect(q(db, variant.query)).toEqual(q(demat(db, variant.query), variant.query));

        for (const patch of guaranteedEntryReplacements(seed * 1543 + variant.label.length, 14)) {
          const beforeRows = q(db, variant.query);
          const result = tryTransact(db, patch);
          expect(result.committed, `${variant.label} committed ${patch.op}`).toBe(true);
          expect(result.applied, `${variant.label} applied ${patch.op}`).toBeGreaterThan(0);
          db = result.db;

          const materializedRows = q(db, variant.query);
          const dematerializedRows = q(demat(db, variant.query), variant.query);
          const change = result.materializations?.changes[0];
          const expected = diffRows(beforeRows, dematerializedRows);

          expect(change, `${variant.label} recomputed ${patch.op}`).toBeDefined();
          if (change === undefined) continue;

          recomputes += 1;
          expect(materializedRows).toBe(change.rows);
          expect(materializedRows).toEqual(dematerializedRows);
          expect(change).toEqual(expect.objectContaining({
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
          expect(expected.diagnostics).toEqual([]);
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

function addedRows<Row>(changes: readonly RowChange<Row>[]): readonly Row[] {
  return changes.flatMap((change) => change.kind === 'added' ? [change.row] : []);
}

function removedRows<Row>(changes: readonly RowChange<Row>[]): readonly Row[] {
  return changes.flatMap((change) => change.kind === 'removed' ? [change.row] : []);
}

function randomEntries(seed: number, count: number): Entry[] {
  const next = random(seed);
  return Array.from({ length: count }, (_, index) => randomEntry(next, `r${seed}-${index}`, index));
}

function randomEntryPatches(seed: number, count: number): WritePatch[] {
  const next = random(seed);
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

function guaranteedEntryReplacements(seed: number, count: number): WritePatch[] {
  const next = random(seed);
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

function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === 'object' && input !== null;
}
