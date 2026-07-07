import { describe, expect, it } from 'vitest';
import { q, setEnvTx, transact, tryTransact, type DbTransactionContext } from '@tarstate/core/db';
import { type TarstateDiagnostic } from '@tarstate/core/diagnostics';
import { diffRows, rowDiffKey, type RowChange } from '@tarstate/core/diff';
import { explainMaterialization, mat, materializedRelationFor } from '@tarstate/core/materialization';
import { relicChanges, trackTransact } from '@tarstate/core/runtime';
import { createMemoryRelationRuntime } from '@tarstate/core/memory-runtime';
import { createRuntimeStore, createStore } from '@tarstate/core/store';
import { asc, env, eq, from, pipe, project, sort, value, where } from '@tarstate/core/query';
import { type RelationRef } from '@tarstate/core/schema';
import {
  composeRelationRuntimes,
  type RelationApplyContext,
  type RelationRuntime,
  type RelationRuntimeInterest
} from '@tarstate/core/adapter';
import {
  attachWatches,
  detachWatches,
  diffQuery,
  isWatchMaterialization,
  subscribeWatch,
  transferWatches,
  unwatch,
  watch,
  watchRuntime,
  watchTargetKey
} from '@tarstate/core/watch';
import { deleteByKey, insert, updateByKey, type WritePatch } from '@tarstate/core/write';
import { accountsById, entry, makeDb, schema } from './behavior-fixtures.js';
import { createSeededRandom, resolveFuzzSeeds } from './fuzz-helpers.js';

const entryList = pipe(
  from(entry),
  sort(asc(entry.row.id)),
  project({
    id: entry.row.id,
    accountId: entry.row.accountId,
    amount: entry.row.amount
  })
);
const watchSeeds = resolveFuzzSeeds([0x4a11, 0x4a12, 0x4a13] as const);

const cashEntryProjection = pipe(
  from(entry),
  where(eq(entry.row.accountId, value('cash'))),
  project({
    id: entry.row.id,
    amount: entry.row.amount
  })
);

const envEntryProjection = pipe(
  from(entry),
  where(eq(entry.row.accountId, env<string>('accountId'))),
  project({
    id: entry.row.id,
    accountId: entry.row.accountId,
    amount: entry.row.amount
  })
);

describe('watch and store behavior', () => {
  it('exposes usable materialization helpers for relation refs, watch transfers, and materialization changes', async () => {
    const relation = materializedRelationFor('test-materialization');
    const watched = attachWatches(makeDb(), entryList);
    const transferred = transferWatches(watched, makeDb());
    const result = tryTransact(mat(makeDb(), cashEntryProjection), insert(schema.entries, { id: 'e5', accountId: 'cash', amount: 35, posted: true }));

    expect(relation).toEqual({
      kind: 'relation',
      name: 'test-materialization',
      key: 'id',
      fields: {},
      ephemeral: true
    });
    const transferredChanges = await trackTransact(
      transferred,
      insert(schema.entries, { id: 'e5', accountId: 'cash', amount: 35, posted: true })
    );
    expect(transferredChanges.changes[0]?.targetKey).toBe(watchTargetKey(entryList));
    expect(isWatchMaterialization(result.materializations?.changes[0])).toBe(true);
    expect(isWatchMaterialization(explainMaterialization(cashEntryProjection))).toBe(false);
  });

  it('watch refresh and query diffs report added, removed, and unchanged rows', async () => {
    const before = makeDb();
    const after = transact(
      before,
      [
        deleteByKey(schema.entries, 'e2'),
        insert(schema.entries, { id: 'e5', accountId: 'cash', amount: 35, memo: 'top-up', posted: true })
      ]
    );
    const events: unknown[] = [];
    const handle = watch(before, entryList, (event) => {
      events.push(event);
    }, { label: 'entries' });
    const refresh = await handle.refresh(after);
    const diff = await diffQuery(before, after, entryList);

    const expectedAdded = [{ id: 'e5', accountId: 'cash', amount: 35 }];
    const expectedRemoved = [{ id: 'e2', accountId: 'sales', amount: -120 }];
    const expectedUnchanged = [
      { id: 'e1', accountId: 'cash', amount: 120 },
      { id: 'e3', accountId: 'fees', amount: -5 },
      { id: 'e4', accountId: 'cash', amount: 0 }
    ];

    expect(refresh).toEqual(expect.objectContaining({
      id: 'entries',
      targetKey: watchTargetKey(entryList),
      delivered: true,
      changed: true,
      added: expectedAdded,
      removed: expectedRemoved,
      unchanged: expectedUnchanged,
      diagnostics: []
    }));
    expect(events).toEqual([
      expect.objectContaining({
        changed: true,
        added: expectedAdded,
        removed: expectedRemoved,
        unchanged: expectedUnchanged
      })
    ]);
    expect(diff).toEqual(expect.objectContaining({
      queryKey: watchTargetKey(entryList),
      changed: true,
      added: expectedAdded,
      removed: expectedRemoved,
      unchanged: expectedUnchanged,
      diagnostics: []
    }));

    const subscription = subscribeWatch(handle, (event) => {
      events.push(event);
    });
    expect(subscription.active).toBe(true);
    expect(subscription.unsubscribe()).toEqual({ id: 'entries', unsubscribed: true, diagnostics: [] });
    expect(unwatch(handle)).toEqual({ id: 'entries', closed: true, diagnostics: [] });
  });

  it('trackTransact returns watcher changes for attached targets', async () => {
    const watched = attachWatches(makeDb(), entryList);
    const result = await trackTransact(
      watched,
      deleteByKey(schema.entries, 'e2'),
      insert(schema.entries, { id: 'e5', accountId: 'cash', amount: 35, memo: 'top-up', posted: true })
    );
    const targetKey = watchTargetKey(entryList);
    const expectedAdded = [{ id: 'e5', accountId: 'cash', amount: 35 }];
    const expectedRemoved = [{ id: 'e2', accountId: 'sales', amount: -120 }];

    expect(result.supported).toBe(true);
    expect(result.result).toEqual(expect.objectContaining({ committed: true, applied: 2 }));
    expect(result.diagnostics).toEqual([]);
    expect(result.changes).toEqual([
      expect.objectContaining({
        targetKey,
        changed: true,
        added: expectedAdded,
        removed: expectedRemoved,
        unchanged: [
          { id: 'e1', accountId: 'cash', amount: 120 },
          { id: 'e3', accountId: 'fees', amount: -5 },
          { id: 'e4', accountId: 'cash', amount: 0 }
        ]
      })
    ]);
    expect(result.changesByTargetKey.get(targetKey)).toEqual(result.changes[0]);
    expect(result.changesByQueryKey[targetKey]).toEqual(expect.objectContaining({
      targetKey,
      added: expectedAdded,
      removed: expectedRemoved
    }));
    expect(q(result.db, entryList)).toEqual([
      { id: 'e1', accountId: 'cash', amount: 120 },
      { id: 'e3', accountId: 'fees', amount: -5 },
      { id: 'e4', accountId: 'cash', amount: 0 },
      { id: 'e5', accountId: 'cash', amount: 35 }
    ]);
  });

  it('watch refresh, query diffs, and tracked transactions match seeded row-diff oracles', async () => {
    let checks = 0;

    for (const seed of watchSeeds) {
      let db = makeDb();

      for (const [index, batch] of seededWatchBatches(seed).entries()) {
        const beforeRows = q(db, entryList);
        const after = transact(db, batch);
        const afterRows = q(after, entryList);
        const expected = diffRows(beforeRows, afterRows);
        const expectedAdded = addedRows(expected.changes);
        const expectedRemoved = removedRows(expected.changes);
        const expectedUnchanged = unchangedRows(afterRows, expected.changes);
        const label = `seed ${seed.toString(16)} batch ${index}`;
        const events: unknown[] = [];
        const handle = watch(db, entryList, (event) => {
          events.push(event);
        }, { label });

        try {
          const refresh = await handle.refresh(after);
          const diff = await diffQuery(db, after, entryList);
          const tracked = await trackTransact(attachWatches(db, entryList), ...batch);

          expect(expected.diagnostics, `${label} oracle diagnostics`).toEqual([]);
          expect(refresh, `${label} refresh`).toEqual(expect.objectContaining({
            targetKey: watchTargetKey(entryList),
            previousRows: beforeRows,
            rows: afterRows,
            changed: expected.changes.length > 0,
            added: expectedAdded,
            removed: expectedRemoved,
            unchanged: expectedUnchanged,
            rowChanges: expected.changes,
            diagnostics: []
          }));
          expect(events, `${label} events`).toEqual([
            expect.objectContaining({
              changed: expected.changes.length > 0,
              added: expectedAdded,
              removed: expectedRemoved,
              unchanged: expectedUnchanged,
              rowChanges: expected.changes
            })
          ]);
          expect(diff, `${label} diff`).toEqual(expect.objectContaining({
            beforeRows,
            afterRows,
            changed: expected.changes.length > 0,
            added: expectedAdded,
            removed: expectedRemoved,
            unchanged: expectedUnchanged,
            rowChanges: expected.changes,
            diagnostics: []
          }));
          expect(tracked.supported, `${label} tracked supported`).toBe(true);
          expect(tracked.result, `${label} tracked result`).toEqual(expect.objectContaining({
            committed: true,
            diagnostics: []
          }));
          expect(tracked.changes, `${label} tracked changes`).toEqual([
            expect.objectContaining({
              targetKey: watchTargetKey(entryList),
              changed: expected.changes.length > 0,
              added: expectedAdded,
              removed: expectedRemoved,
              unchanged: expectedUnchanged,
              rowChanges: expected.changes,
              diagnostics: []
            })
          ]);
          expect(q(tracked.db, entryList), `${label} tracked rows`).toEqual(afterRows);
        } finally {
          handle.unwatch();
        }

        db = after;
        checks += 1;
      }
    }

    expect(checks).toBeGreaterThan(0);
  });

  it('detaches pure db watches and projects trackTransact changes with Relic deleted spelling', async () => {
    const watched = attachWatches(makeDb(), entryList, cashEntryProjection);
    const cashOnly = detachWatches(watched, entryList);
    const targetKey = watchTargetKey(cashEntryProjection);
    const tracked = await trackTransact(
      cashOnly,
      deleteByKey(schema.entries, 'e1'),
      insert(schema.entries, { id: 'e5', accountId: 'cash', amount: 35, memo: 'top-up', posted: true })
    );
    const relic = relicChanges(tracked);

    expect(tracked.changes.map((change) => change.targetKey)).toEqual([targetKey]);
    expect(relic.db).toBe(tracked.db);
    expect(relic.result).toEqual(tracked.result);
    expect(relic.changes[targetKey]).toEqual({
      added: [{ id: 'e5', amount: 35 }],
      deleted: [{ id: 'e1', amount: 120 }],
      removed: [{ id: 'e1', amount: 120 }]
    });

    const detachedAll = detachWatches(cashOnly);
    const untracked = await trackTransact(detachedAll, updateByKey(schema.entries, 'e4', { amount: 1 }));
    expect(untracked.changes).toEqual([]);
  });

  it('tracks rejected transactions without changing watched rows and closes watches idempotently', async () => {
    const watched = attachWatches(makeDb(), entryList);
    const beforeRows = q(watched, entryList);
    const duplicate = insert(schema.entries, {
      id: 'e1',
      accountId: 'cash',
      amount: 999,
      memo: 'duplicate',
      posted: true
    });
    const tracked = await trackTransact(watched, duplicate);

    expect(tracked.supported).toBe(true);
    expect(tracked.db).toBe(watched);
    expect(tracked.result).toEqual(expect.objectContaining({
      committed: false,
      applied: 0,
      diagnostics: expect.arrayContaining([expect.objectContaining({ code: 'unique', relation: 'entries' })])
    }));
    expect(tracked.changes).toEqual([
      expect.objectContaining({
        changed: false,
        added: [],
        removed: [],
        unchanged: beforeRows
      })
    ]);
    expect(q(tracked.db, entryList)).toEqual(beforeRows);

    const events: unknown[] = [];
    const handle = watch(makeDb(), entryList, (event) => {
      events.push(event);
    }, { label: 'close-parity' });

    expect(handle.unwatch()).toEqual({ id: 'close-parity', closed: true, diagnostics: [] });
    expect(unwatch(handle)).toEqual({ id: 'close-parity', closed: false, diagnostics: [] });
    expect(subscribeWatch(handle, () => undefined)).toEqual(expect.objectContaining({
      id: 'close-parity',
      active: false
    }));
    expect(await handle.refresh(transact(makeDb(), insert(schema.entries, {
      id: 'e5',
      accountId: 'cash',
      amount: 35,
      memo: 'top-up',
      posted: true
    })))).toEqual(expect.objectContaining({
      delivered: false,
      changed: false,
      added: [],
      removed: []
    }));
    expect(events).toEqual([]);
  });

  it('runtime watches subscribe to runtime changes and duplicate labels stay isolated', async () => {
    const runtime = createMemoryRelationRuntime(makeDb().data);
    const runtimeEvents: unknown[] = [];
    const runtimeHandle = watchRuntime(runtime, entryList, (event) => {
      runtimeEvents.push(event);
    }, { label: 'entries-runtime' });

    await runtime.target?.apply([
      insert(schema.entries, { id: 'e5', accountId: 'cash', amount: 35, memo: 'top-up', posted: true })
    ]);
    await tick();

    expect(runtimeEvents).toEqual([
      expect.objectContaining({
        changed: true,
        added: [{ id: 'e5', accountId: 'cash', amount: 35 }]
      })
    ]);

    runtimeEvents.length = 0;
    await runtime.target?.apply([
      updateByKey(schema.accounts, 'cash', { name: 'Cash account' })
    ]);
    await tick();
    expect(runtimeEvents).toEqual([]);

    expect(runtimeHandle.unwatch()).toEqual({ id: 'entries-runtime', closed: true, diagnostics: [] });

    const db = makeDb();
    const firstEvents: unknown[] = [];
    const secondEvents: unknown[] = [];
    const first = watch(db, entryList, (event) => {
      firstEvents.push(event);
    }, { label: 'duplicate' });
    const second = watch(db, entryList, (event) => {
      secondEvents.push(event);
    }, { label: 'duplicate' });
    const after = transact(db, insert(schema.entries, { id: 'e6', accountId: 'cash', amount: 10, memo: 'late', posted: true }));

    expect(first.id).toBe('duplicate');
    expect(second.id).not.toBe(first.id);
    expect(unwatch(first)).toEqual({ id: 'duplicate', closed: true, diagnostics: [] });
    await second.refresh(after);
    expect(firstEvents).toEqual([]);
    expect(secondEvents).toEqual([
      expect.objectContaining({
        added: [{ id: 'e6', accountId: 'cash', amount: 10 }]
      })
    ]);
    expect(unwatch(second).closed).toBe(true);
  });

  it('store query, view, commit, and subscriptions reflect accepted commits', async () => {
    const store = createStore(makeDb());
    const view = store.view(entryList);
    const storeRevisions: number[] = [];
    const viewRevisions: number[] = [];
    const unsubscribeStore = store.subscribe(() => {
      storeRevisions.push(store.getSnapshot().revision);
    });
    const unsubscribeView = view.subscribe(() => {
      viewRevisions.push(view.getSnapshot().revision);
    });

    expect(store.getSnapshot()).toEqual(expect.objectContaining({ revision: 0, diagnostics: [] }));
    expect(store.query(entryList)).toEqual(expect.objectContaining({
      revision: 0,
      rows: [
        { id: 'e1', accountId: 'cash', amount: 120 },
        { id: 'e2', accountId: 'sales', amount: -120 },
        { id: 'e3', accountId: 'fees', amount: -5 },
        { id: 'e4', accountId: 'cash', amount: 0 }
      ],
      diagnostics: []
    }));
    expect(view.getSnapshot()).toEqual(expect.objectContaining({
      revision: 0,
      queryKey: view.queryKey,
      rows: [
        { id: 'e1', accountId: 'cash', amount: 120 },
        { id: 'e2', accountId: 'sales', amount: -120 },
        { id: 'e3', accountId: 'fees', amount: -5 },
        { id: 'e4', accountId: 'cash', amount: 0 }
      ],
      diagnostics: []
    }));

    const commit = await store.commit(
      insert(schema.entries, { id: 'e5', accountId: 'cash', amount: 35, memo: 'top-up', posted: true })
    );

    expect(commit).toEqual(expect.objectContaining({
      status: 'accepted',
      reflected: true,
      effects: expect.objectContaining({
        patches: 1,
        applied: 1,
        diagnostics: []
      }),
      diagnostics: []
    }));
    expect(commit.snapshot.revision).toBe(1);
    expect(storeRevisions).toEqual([1]);
    expect(viewRevisions).toEqual([1]);
    expect(view.getSnapshot()).toEqual(expect.objectContaining({
      revision: 1,
      rows: [
        { id: 'e1', accountId: 'cash', amount: 120 },
        { id: 'e2', accountId: 'sales', amount: -120 },
        { id: 'e3', accountId: 'fees', amount: -5 },
        { id: 'e4', accountId: 'cash', amount: 0 },
        { id: 'e5', accountId: 'cash', amount: 35 }
      ],
      diagnostics: []
    }));

    unsubscribeView();
    unsubscribeStore();
    await store.commit(
      insert(schema.entries, { id: 'e6', accountId: 'cash', amount: 10, memo: 'late', posted: true })
    );
    expect(storeRevisions).toEqual([1]);
    expect(viewRevisions).toEqual([1]);

    store.close();
    store.close();
  });

  it('store view invalidates cached snapshots when runtime diagnostics change without a revision change', () => {
    const data = makeDb().data;
    let runtimeDiagnostics: readonly TarstateDiagnostic[] = [];
    const runtime = {
      source: {
        relationNames: Object.keys(data),
        rows: (relationRef) => data[relationRef.name] ?? [],
        diagnostics: () => runtimeDiagnostics
      }
    } satisfies RelationRuntime<number>;
    const store = createRuntimeStore({ runtime, relations: [schema.accounts, schema.entries] });
    const view = store.view(entryList);
    const first = view.getSnapshot();

    runtimeDiagnostics = [{
      code: 'adapter_warning',
      severity: 'warning',
      message: 'adapter diagnostics changed',
      surface: 'adapter'
    }];
    const changed = view.getSnapshot();

    expect(first).toEqual(expect.objectContaining({ revision: 0, diagnostics: [] }));
    expect(changed).not.toBe(first);
    expect(changed).toEqual(expect.objectContaining({
      revision: 1,
      diagnostics: runtimeDiagnostics
    }));
    expect(store.getSnapshot()).toEqual(expect.objectContaining({
      revision: 0,
      diagnostics: runtimeDiagnostics
    }));

    store.close();
  });

  it('runtime store retains view interests only while subscribers are mounted', () => {
    const inner = createMemoryRelationRuntime(makeDb().data);
    const retained: RelationRuntimeInterest[] = [];
    const released: RelationRuntimeInterest[] = [];
    const runtime = {
      ...inner,
      retainInterest: (interest: RelationRuntimeInterest) => {
        retained.push(interest);
        return () => {
          released.push(interest);
        };
      }
    } satisfies RelationRuntime<number>;
    const store = createRuntimeStore({ runtime, relations: [schema.accounts, schema.entries] });
    const view = store.view(entryList);

    const unsubscribeFirst = view.subscribe(() => {});
    const unsubscribeSecond = view.subscribe(() => {});

    expect(retained).toEqual([
      expect.objectContaining({
        kind: 'view',
        queryKey: view.queryKey,
        relationNames: ['entries']
      })
    ]);
    expect(released).toEqual([]);

    unsubscribeFirst();
    expect(released).toEqual([]);

    unsubscribeSecond();
    expect(released).toEqual([retained[0]]);

    const secondView = store.view(cashEntryProjection);
    const unsubscribeThird = secondView.subscribe(() => {});
    expect(retained).toHaveLength(2);

    store.close();
    expect(released).toEqual([retained[0], retained[1]]);
    unsubscribeThird();
    expect(released).toEqual([retained[0], retained[1]]);
  });

  it('runtime store uses changed relation notifications to refresh only affected rows', () => {
    let data = makeDb().data;
    let version = 0;
    let subscribedListener: ((notification?: { readonly relationNames?: readonly string[] }) => void) | undefined;
    const rowReads: Record<string, number> = {};
    const source = {
      relationNames: Object.keys(data),
      rows: (relationRef: RelationRef) => {
        rowReads[relationRef.name] = (rowReads[relationRef.name] ?? 0) + 1;
        return data[relationRef.name] ?? [];
      },
      version: () => version
    };
    const runtime = {
      source,
      snapshot: () => ({
        source,
        version
      }),
      subscribe: (listener: (notification?: { readonly relationNames?: readonly string[] }) => void) => {
        subscribedListener = listener;
        return () => {
          subscribedListener = undefined;
        };
      }
    } satisfies RelationRuntime<number>;
    const store = createRuntimeStore({ runtime, relations: [schema.accounts, schema.entries] });
    const accountsView = store.view(accountsById);
    const entriesView = store.view(entryList);
    const notifiedViews: string[] = [];
    const unsubscribeAccounts = accountsView.subscribe(() => {
      notifiedViews.push('accounts');
    });
    const unsubscribeEntries = entriesView.subscribe(() => {
      notifiedViews.push('entries');
    });

    expect(rowReads).toEqual({ accounts: 1, entries: 1 });

    data = {
      ...data,
      entries: [
        ...(data.entries ?? []),
        { id: 'e5', accountId: 'cash', amount: 35, memo: 'top-up', posted: true }
      ]
    };
    subscribedListener?.({ relationNames: ['entries'] });

    expect(rowReads).toEqual({ accounts: 1, entries: 2 });
    expect(notifiedViews).toEqual(['entries']);
    expect(entriesView.getSnapshot().rows).toEqual([
      { id: 'e1', accountId: 'cash', amount: 120 },
      { id: 'e2', accountId: 'sales', amount: -120 },
      { id: 'e3', accountId: 'fees', amount: -5 },
      { id: 'e4', accountId: 'cash', amount: 0 },
      { id: 'e5', accountId: 'cash', amount: 35 }
    ]);

    notifiedViews.length = 0;
    data = {
      ...data,
      accounts: [
        { id: 'cash', name: 'Cash account', kind: 'asset' },
        { id: 'sales', name: 'Sales', kind: 'income' },
        { id: 'fees', name: 'Bank fees', kind: 'expense' },
        { id: 'equity', name: 'Owner equity', kind: 'equity' }
      ]
    };
    version += 1;
    subscribedListener?.({ relationNames: ['accounts'] });

    expect(rowReads).toEqual({ accounts: 2, entries: 2 });
    expect(notifiedViews).toEqual(['accounts', 'entries']);

    unsubscribeEntries();
    unsubscribeAccounts();
    store.close();
  });

  it('runtime store routes original patches, preserves callback semantics, and rejects after close', async () => {
    const inner = createMemoryRelationRuntime(makeDb().data);
    const target = inner.target;
    if (target === undefined) throw new Error('memory runtime target missing');
    const routedPatches: (readonly WritePatch[])[] = [];
    const runtime = {
      ...inner,
      target: {
        ...target,
        apply: (patches: readonly WritePatch[]) => {
          routedPatches.push(patches);
          return target.apply(patches);
        }
      }
    } satisfies RelationRuntime<number>;
    const store = createRuntimeStore({ runtime, relations: [schema.accounts, schema.entries] });
    const callbackCommit = await store.commit((tx: DbTransactionContext) => {
      expect(q(tx, cashEntryProjection)).toEqual([{ id: 'e1', amount: 120 }, { id: 'e4', amount: 0 }]);
      return updateByKey(schema.entries, 'e1', { amount: 125 });
    });

    expect(callbackCommit).toEqual(expect.objectContaining({
      status: 'accepted',
      reflected: true,
      effects: expect.objectContaining({
        patches: 1,
        applied: 1,
        diagnostics: []
      }),
      diagnostics: []
    }));
    expect(routedPatches).toEqual([
      [expect.objectContaining({ op: 'updateByKey', key: 'e1' })]
    ]);
    expect(routedPatches[0]?.map((patch) => patch.op)).not.toEqual(['deleteExact', 'insertOrReplace']);

    store.close();
    const closedSnapshot = store.getSnapshot();
    const closedCommit = await store.commit(insert(schema.entries, { id: 'e7', accountId: 'cash', amount: 1, posted: true }));
    expect(closedCommit).toEqual(expect.objectContaining({
      status: 'rejected',
      reflected: false,
      snapshot: closedSnapshot,
      diagnostics: expect.arrayContaining([
        expect.objectContaining({ code: 'runtime_unsupported', message: 'store is closed' })
      ])
    }));
  });

  it('runtime store applies original patches with the committed transaction env', async () => {
    const inner = createMemoryRelationRuntime(makeDb().data);
    const target = inner.target;
    if (target === undefined) throw new Error('memory runtime target missing');
    const applyEnvs: (RelationApplyContext['env'] | undefined)[] = [];
    const applyEnvDeltas: (RelationApplyContext['envDeltas'] | undefined)[] = [];
    const runtime = {
      ...inner,
      target: {
        ...target,
        apply: (patches: readonly WritePatch[], context: RelationApplyContext | undefined) => {
          applyEnvs.push(context?.env);
          applyEnvDeltas.push(context?.envDeltas);
          return target.apply(patches, context);
        }
      }
    } satisfies RelationRuntime<number>;
    const store = createRuntimeStore({
      runtime,
      relations: [schema.accounts, schema.entries],
      env: { accountId: 'cash' }
    });

    const commit = await store.commit([
      setEnvTx({ accountId: 'fees' }),
      updateByKey(schema.entries, 'e1', { accountId: env<string>('accountId') })
    ], {
      context: {
        env: { accountId: 'ignored' },
        envDeltas: [{ name: 'accountId', before: 'cash', after: 'fees' }]
      }
    });

    expect(commit.status).toBe('accepted');
    expect(applyEnvs).toEqual([{ accountId: 'fees' }]);
    expect(applyEnvDeltas).toEqual([[{ name: 'accountId', before: 'cash', after: 'fees' }]]);
    expect(commit.snapshot.db.env).toEqual({ accountId: 'fees' });
    expect(store.query(entryList).rows).toEqual([
      { id: 'e1', accountId: 'fees', amount: 120 },
      { id: 'e2', accountId: 'sales', amount: -120 },
      { id: 'e3', accountId: 'fees', amount: -5 },
      { id: 'e4', accountId: 'cash', amount: 0 }
    ]);

    store.close();
  });

  it('runtime store preserves pure env commits without mutating the memory runtime', async () => {
    const runtime = createMemoryRelationRuntime(makeDb().data);
    const beforeRuntimeVersion = runtime.snapshot?.().version;
    const runtimeRevisions: number[] = [];
    const storeRevisions: number[] = [];
    const unsubscribeRuntime = runtime.subscribe?.(() => {
      const runtimeVersion = runtime.snapshot?.().version;
      if (runtimeVersion !== undefined) runtimeRevisions.push(runtimeVersion);
    });
    const store = createRuntimeStore({
      runtime,
      relations: [schema.accounts, schema.entries],
      env: { accountId: 'cash' }
    });
    const unsubscribeStore = store.subscribe(() => {
      storeRevisions.push(store.getSnapshot().revision);
    });

    const commit = await store.commit(setEnvTx({ accountId: 'sales' }));

    expect(commit).toEqual(expect.objectContaining({
      status: 'accepted',
      reflected: true,
      effects: expect.objectContaining({
        patches: 0,
        applied: 0,
        deltas: [],
        diagnostics: []
      }),
      diagnostics: []
    }));
    expect(commit.snapshot.revision).toBe(1);
    expect(commit.snapshot.db.env).toEqual({ accountId: 'sales' });
    expect(store.query(envEntryProjection).rows).toEqual([
      { id: 'e2', accountId: 'sales', amount: -120 }
    ]);
    expect(storeRevisions).toEqual([1]);
    expect(runtime.snapshot?.().version).toBe(beforeRuntimeVersion);
    expect(runtimeRevisions).toEqual([]);

    unsubscribeStore();
    unsubscribeRuntime?.();
    store.close();
  });

  it('subscribes to runtime changes only while the store has active subscribers', async () => {
    const inner = createMemoryRelationRuntime(makeDb().data);
    let runtimeListeners = 0;
    const runtime = {
      ...inner,
      subscribe: (listener: () => void) => {
        runtimeListeners += 1;
        const unsubscribe = inner.subscribe?.(listener);
        return () => {
          runtimeListeners -= 1;
          unsubscribe?.();
        };
      }
    };
    const store = createRuntimeStore({
      runtime,
      relations: [schema.accounts, schema.entries]
    });

    expect(runtimeListeners).toBe(0);

    const unsubscribeStore = store.subscribe(() => {});
    expect(runtimeListeners).toBe(1);

    const entryView = store.view(entryList);
    const unsubscribeView = entryView.subscribe(() => {});
    expect(runtimeListeners).toBe(1);

    unsubscribeStore();
    expect(runtimeListeners).toBe(1);

    unsubscribeView();
    expect(runtimeListeners).toBe(0);

    store.close();
    expect(runtimeListeners).toBe(0);
  });

  it('runtime store does not double notify when apply synchronously refreshes from subscription', async () => {
    const runtime = createMemoryRelationRuntime(makeDb().data);
    const store = createRuntimeStore({ runtime, relations: [schema.accounts, schema.entries] });
    const storeRevisions: number[] = [];
    const unsubscribeStore = store.subscribe(() => {
      storeRevisions.push(store.getSnapshot().revision);
    });

    const commit = await store.commit(
      insert(schema.entries, { id: 'e5', accountId: 'cash', amount: 35, memo: 'top-up', posted: true })
    );

    expect(commit.status).toBe('accepted');
    expect(commit.snapshot.revision).toBe(1);
    expect(store.getSnapshot().revision).toBe(1);
    expect(storeRevisions).toEqual([1]);

    unsubscribeStore();
    store.close();
  });

  it('composed runtime leaves anonymous targets without source relation names unrouted', async () => {
    const routedPatches: (readonly WritePatch[])[] = [];
    const runtime = {
      source: {
        rows: () => []
      },
      target: {
        apply: (patches: readonly WritePatch[]) => {
          routedPatches.push([...patches]);
          return {
            status: 'accepted' as const,
            patches: patches.length,
            applied: patches.length,
            deltas: [],
            diagnostics: [],
            version: 1
          };
        }
      }
    } satisfies RelationRuntime<number>;
    const composed = composeRelationRuntimes(runtime);
    const result = await composed.target?.apply([
      insert(schema.entries, { id: 'e5', accountId: 'cash', amount: 35, posted: true })
    ]);

    expect(composed.target?.ownsRelation?.('entries')).toBe(false);
    expect(result).toEqual(expect.objectContaining({
      status: 'rejected',
      patches: 1,
      applied: 0,
      deltas: [],
      diagnostics: [
        expect.objectContaining({
          code: 'runtime_unsupported',
          relation: 'entries',
          surface: 'composeRelationRuntimes'
        })
      ]
    }));
    expect(routedPatches).toEqual([]);
  });

  it('runtime store keeps its current snapshot when an adapter rejects original patches', async () => {
    const inner = createMemoryRelationRuntime(makeDb().data);
    const target = inner.target;
    if (target === undefined) throw new Error('memory runtime target missing');
    const routedPatches: (readonly WritePatch[])[] = [];
    const runtime = {
      ...inner,
      target: {
        ...target,
        apply: (patches: readonly WritePatch[]) => {
          routedPatches.push(patches);
          const version = inner.snapshot?.().version;
          return {
            status: 'rejected' as const,
            patches: patches.length,
            applied: 0 as const,
            deltas: [] as const,
            diagnostics: [{ code: 'adapter_rejected', severity: 'error' as const, message: 'nope' }],
            ...(version === undefined ? {} : { version })
          };
        }
      }
    } satisfies RelationRuntime<number>;
    const store = createRuntimeStore({ runtime, relations: [schema.accounts, schema.entries] });
    const before = store.getSnapshot();
    const rejected = await store.commit(updateByKey(schema.entries, 'e1', { amount: 999 }));

    expect(rejected).toEqual(expect.objectContaining({
      status: 'rejected',
      reflected: false,
      snapshot: before,
      diagnostics: [expect.objectContaining({ code: 'adapter_rejected' })]
    }));
    expect(store.getSnapshot()).toEqual(before);
    expect(store.getSnapshot().source).toBe(before.source);
    expect(store.query(cashEntryProjection).rows).toEqual([{ id: 'e1', amount: 120 }, { id: 'e4', amount: 0 }]);
    expect(routedPatches).toEqual([
      [expect.objectContaining({ op: 'updateByKey', key: 'e1' })]
    ]);
  });
});

const watchAccountIds = ['cash', 'sales', 'fees', 'equity'] as const;

function seededWatchBatches(seed: number): readonly (readonly WritePatch[])[] {
  const next = createSeededRandom(seed);
  const suffix = seed.toString(16);
  return [
    [
      updateByKey(schema.entries, 'e1', { amount: seededWatchAmount(next) })
    ],
    [
      insert(schema.entries, {
        id: `watch-${suffix}-a`,
        accountId: seededWatchAccountId(next),
        amount: seededWatchAmount(next),
        memo: `seed-${suffix}-a`,
        posted: true
      })
    ],
    [
      deleteByKey(schema.entries, 'e2')
    ],
    [
      updateByKey(schema.entries, 'e4', {
        accountId: seededWatchAccountId(next),
        amount: seededWatchAmount(next),
        posted: next() > 0.5
      })
    ],
    [
      insert(schema.entries, {
        id: `watch-${suffix}-b`,
        accountId: seededWatchAccountId(next),
        amount: seededWatchAmount(next),
        posted: next() > 0.25
      }),
      updateByKey(schema.entries, `watch-${suffix}-a`, {
        accountId: seededWatchAccountId(next),
        amount: seededWatchAmount(next)
      })
    ],
    [
      deleteByKey(schema.entries, `watch-${suffix}-b`)
    ]
  ];
}

function seededWatchAccountId(next: () => number): typeof watchAccountIds[number] {
  return watchAccountIds[Math.floor(next() * watchAccountIds.length)] ?? 'cash';
}

function seededWatchAmount(next: () => number): number {
  return Math.floor(next() * 401) - 200;
}

function addedRows<Row>(changes: readonly RowChange<Row>[]): readonly Row[] {
  return changes.flatMap((change) => change.kind === 'added' ? [change.row] : []);
}

function removedRows<Row>(changes: readonly RowChange<Row>[]): readonly Row[] {
  return changes.flatMap((change) => change.kind === 'removed' ? [change.row] : []);
}

function unchangedRows<Row>(rows: readonly Row[], changes: readonly RowChange<Row>[]): readonly Row[] {
  const changedKeys = new Set(changes.map((change) => change.key));
  return rows.filter((rowValue) => !changedKeys.has(rowDiffKey(rowValue)));
}

async function tick(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}
