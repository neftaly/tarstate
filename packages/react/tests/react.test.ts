import {
  preparePlan,
  type ObserveRequest,
  type ObserverChange,
  type ObserverDiagnostic,
  type ObserverSnapshot,
  type PreparedPlan,
  type QueryObserver
} from '@tarstate/core/database';
import type { CommitReceipt, TransactionAttempt } from '@tarstate/core/transactions';
import { StrictMode, createElement, type ReactElement } from 'react';
import { renderToString } from 'react-dom/server';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import * as ReactAdapter from '../src/index.js';
import {
  TarstateProvider,
  useCommit,
  useDatabase,
  useMutationState,
  useQuery,
  useRow,
  type MutationState,
  type ObservableDatabase,
  type CreateOptimisticOverlay,
  type OptimisticProjection,
  type ReactObserverSnapshot,
  type ReactPreparedPlan
} from '../src/index.js';

type Query = { readonly kind: 'all' };
type Row = { readonly id: number; readonly name: string };

const plan: ReactPreparedPlan<Query, Row> = await preparePlan<Query>({
  query: { kind: 'all' },
  registryFingerprint: 'registry:one',
  authorityFingerprint: 'authority:public',
  datasetId: 'dataset:one'
});

const basis = (revision: number) => ({
  dataset: { datasetId: 'dataset:one', revision },
  attachments: [{ attachmentId: 'attachment:one', sourceId: 'source:one', basis: { incarnation: 'one', revision } }]
});

const openSnapshot = (rows: readonly Row[], revision = 0): ObserverSnapshot<Row> => {
  const current = Object.freeze({
    readiness: 'ready' as const,
    rows: Object.freeze([...rows]),
    resultKeys: Object.freeze(rows.map(({ id }) => 'row:' + id)),
    completeness: 'exact' as const,
    freshness: 'current' as const,
    basis: basis(revision),
    sourceStates: Object.freeze([]),
    issues: Object.freeze([])
  });
  return Object.freeze({ state: 'open', current, lastExact: current });
};

class TestObserver implements QueryObserver<Row> {
  readonly listeners = new Set<(change: ObserverChange<Row>) => void>();
  closeCount = 0;
  snapshot: ObserverSnapshot<Row>;

  constructor(snapshot: ObserverSnapshot<Row>) { this.snapshot = snapshot; }

  getSnapshot(): ObserverSnapshot<Row> { return this.snapshot; }
  subscribe(listener: (change: ObserverChange<Row>) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
  close(): void {
    this.closeCount += 1;
    this.listeners.clear();
    this.snapshot = Object.freeze({ state: 'closed' });
  }
  publish(snapshot: ObserverSnapshot<Row>): void {
    this.snapshot = snapshot;
    const change: ObserverChange<Row> = { kind: 'reset', snapshot };
    for (const listener of Array.from(this.listeners)) listener(change);
  }
}

class TestDatabase implements ObservableDatabase<Query, Row> {
  readonly authorityScope = 'public';
  readonly authorityFingerprint = 'authority:public';
  readonly registryFingerprint = 'registry:one';
  readonly observers: TestObserver[] = [];
  snapshot: ObserverSnapshot<Row> = openSnapshot([{ id: 1, name: 'one' }]);
  closeCount = 0;

  observe(_request: ObserveRequest<Query>): QueryObserver<Row> {
    const observer = new TestObserver(this.snapshot);
    this.observers.push(observer);
    return observer;
  }

  close(): void { this.closeCount += 1; }
}

const mounted: ReactTestRenderer[] = [];

beforeAll(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(async () => {
  while (mounted.length > 0) {
    const renderer = mounted.pop();
    if (renderer !== undefined) await act(() => { renderer.unmount(); });
  }
  await act(async () => { await Promise.resolve(); });
});

const mount = async (node: ReactElement): Promise<ReactTestRenderer> => {
  let renderer: ReactTestRenderer | undefined;
  await act(() => { renderer = create(node); });
  mounted.push(renderer!);
  return renderer!;
};

describe('@tarstate/react', () => {
  it('keeps the runtime surface to the six v1 boundary exports', () => {
    expect(Object.keys(ReactAdapter).sort()).toEqual([
      'TarstateProvider',
      'useCommit',
      'useDatabase',
      'useMutationState',
      'useQuery',
      'useRow'
    ]);
  });

  it('provides the externally owned database without closing it', async () => {
    const database = new TestDatabase();
    let received: ObservableDatabase | undefined;
    const Consumer = () => { received = useDatabase(); return null; };
    const renderer = await mount(createElement(TarstateProvider, { database }, createElement(Consumer)));
    expect(received).toBe(database);
    await act(() => { renderer.unmount(); });
    expect(database.closeCount).toBe(0);
  });

  it('shares a cached observer, survives StrictMode effect cycling, and collects on last unsubscribe', async () => {
    const database = new TestDatabase();
    const snapshots: ObserverSnapshot<Row>[] = [];
    const Consumer = () => { snapshots.push(useQuery(plan)); return null; };
    const renderer = await mount(createElement(
      StrictMode,
      null,
      createElement(TarstateProvider, { database }, createElement(Consumer), createElement(Consumer))
    ));
    expect(database.observers).toHaveLength(1);
    expect(snapshots.at(-1)).toBe(database.observers[0]?.getSnapshot());
    expect(database.observers[0]?.closeCount).toBe(0);

    await act(() => { renderer.unmount(); });
    await act(async () => { await Promise.resolve(); });
    expect(database.observers[0]?.closeCount).toBe(1);
    expect(database.closeCount).toBe(0);
  });

  it('continues notifying cached query views when an earlier view throws', async () => {
    const database = new TestDatabase();
    const diagnostics: ObserverDiagnostic[] = [];
    const firstSnapshots: ObserverSnapshot<Row>[] = [];
    const secondSnapshots: ObserverSnapshot<Row>[] = [];
    const First = () => { firstSnapshots.push(useQuery(plan)); return null; };
    const Second = () => { secondSnapshots.push(useQuery(plan)); return null; };
    await mount(createElement(
      'div',
      null,
      createElement(TarstateProvider, { database, onDiagnostic: (diagnostic) => diagnostics.push(diagnostic) }, createElement(First)),
      createElement(TarstateProvider, { database }, createElement(Second))
    ));
    expect(database.observers).toHaveLength(1);

    const next = openSnapshot([{ id: 2, name: 'two' }], 1);
    let firstStateRead = true;
    const throwsForFirstView = new Proxy(next, {
      get(target, property, receiver) {
        if (property === 'state' && firstStateRead) {
          firstStateRead = false;
          throw new Error('first query view failed to refresh');
        }
        return Reflect.get(target, property, receiver);
      }
    });

    await act(() => { database.observers[0]?.publish(throwsForFirstView); });
    expect(firstSnapshots.at(-1)).toMatchObject({ current: { rows: [{ id: 1, name: 'one' }] } });
    expect(secondSnapshots.at(-1)).toMatchObject({ current: { rows: [{ id: 2, name: 'two' }] } });
    expect(diagnostics).toMatchObject([{ kind: 'listener_error', component: 'react-query', operation: 'publish-query-store' }]);
  });

  it('attempts every query teardown and reports contained cleanup failures', async () => {
    const diagnostics: ObserverDiagnostic[] = [];
    class ThrowingCleanupObserver extends TestObserver {
      override subscribe(listener: (change: ObserverChange<Row>) => void): () => void {
        super.subscribe(listener);
        return () => { this.listeners.delete(listener); throw new Error('unsubscribe failed'); };
      }
      override close(): void { this.closeCount += 1; throw new Error('close failed'); }
    }
    class ThrowingCleanupDatabase extends TestDatabase {
      override observe(_request: ObserveRequest<Query>): QueryObserver<Row> {
        const observer = new ThrowingCleanupObserver(this.snapshot);
        this.observers.push(observer);
        return observer;
      }
    }
    const database = new ThrowingCleanupDatabase();
    const Consumer = () => { useQuery(plan); return null; };
    const renderer = await mount(createElement(TarstateProvider, { database, onDiagnostic: (diagnostic) => diagnostics.push(diagnostic) }, createElement(Consumer)));

    await act(() => { renderer.unmount(); });
    await act(async () => { await Promise.resolve(); });
    expect(diagnostics.filter(({ kind, component }) => kind === 'cleanup_error' && component === 'react-query')).toHaveLength(2);

    await mount(createElement(TarstateProvider, { database, onDiagnostic: (diagnostic) => diagnostics.push(diagnostic) }, createElement(Consumer)));
    expect(database.observers).toHaveLength(2);
  });

  it('uses collision-safe canonical observation keys', async () => {
    const database = new TestDatabase();
    const first = { ...plan, planId: 'query\u0000all', rootNodeId: 'root' };
    const second = { ...plan, planId: 'query', rootNodeId: 'all\u0000root' };
    const Consumer = () => { useQuery(first); useQuery(second); return null; };
    await mount(createElement(TarstateProvider, { database }, createElement(Consumer)));
    expect(database.observers).toHaveLength(2);
  });

  it('suppresses selected renders on basis-only changes while full snapshots still update', async () => {
    const database = new TestDatabase();
    const selected: string[] = [];
    const full: ObserverSnapshot<Row>[] = [];
    const Selected = () => {
      selected.push(useQuery(plan, {
        selectSnapshot: (snapshot) => snapshot.state === 'open' ? snapshot.current.rows.map(({ name }) => name).join(',') : 'closed'
      }));
      return null;
    };
    const Full = () => { full.push(useQuery(plan)); return null; };
    await mount(createElement(TarstateProvider, { database }, createElement(Selected), createElement(Full)));
    const selectedRenders = selected.length;
    const fullRenders = full.length;

    await act(() => { database.observers[0]?.publish(openSnapshot([{ id: 1, name: 'one' }], 1)); });
    expect(selected).toHaveLength(selectedRenders);
    expect(full.length).toBeGreaterThan(fullRenders);
    expect(full.at(-1)).not.toBe(full.at(-2));

    await act(() => { database.observers[0]?.publish(openSnapshot([{ id: 1, name: 'changed' }], 2)); });
    expect(selected.at(-1)).toBe('changed');
    expect(selected).toHaveLength(selectedRenders + 1);
  });

  it('selects rows by occurrence key and requires explicit retained-exact evidence', async () => {
    const database = new TestDatabase();
    const exact = openSnapshot([{ id: 1, name: 'one' }]);
    const currentUnknown = Object.freeze({
      state: 'open' as const,
      current: Object.freeze({
        readiness: 'incomplete' as const,
        rows: Object.freeze([]) as readonly Row[],
        resultKeys: Object.freeze([]) as readonly string[],
        completeness: 'unknown' as const,
        freshness: 'none' as const,
        basis: basis(1),
        sourceStates: Object.freeze([]),
        issues: Object.freeze([])
      }),
      ...(exact.state === 'open' ? { lastExact: exact.current } : {})
    });
    database.snapshot = currentUnknown;
    let current: Row | undefined;
    let retained: Row | undefined;
    const Consumer = () => {
      current = useRow(plan, 'row:1');
      retained = useRow(plan, 'row:1', { readFrom: 'last-exact' });
      return null;
    };
    await mount(createElement(TarstateProvider, { database }, createElement(Consumer)));
    expect(current).toBeUndefined();
    expect(retained).toEqual({ id: 1, name: 'one' });
  });

  it('uses only a supplied matching observation during server rendering', () => {
    const database = new TestDatabase();
    const request: ObserveRequest<Query> = { plan: plan as PreparedPlan<Query> };
    const Consumer = () => {
      const snapshot = useQuery(plan);
      return createElement('span', null, snapshot.state === 'open' ? snapshot.current.rows[0]?.name : 'closed');
    };
    expect(() => renderToString(createElement(TarstateProvider, { database }, createElement(Consumer)))).toThrow(/server snapshot|getServerSnapshot/i);
    const html = renderToString(createElement(
      TarstateProvider,
      { database, serverQueryObservations: [{ request, snapshot: openSnapshot([{ id: 7, name: 'server' }]) }] },
      createElement(Consumer)
    ));
    expect(html).toContain('server');
    expect(database.observers).toHaveLength(0);
  });

  it('preserves opaque server row identities without inspecting them', () => {
    const database = new TestDatabase();
    let getterReads = 0;
    class OpaqueRow {
      readonly id = 8;
      readonly createdAt = new Date(0);
      get derived(): string { getterReads += 1; return 'derived'; }
    }
    const row = new OpaqueRow();
    const request: ObserveRequest<Query> = { plan: plan as PreparedPlan<Query> };
    const serverSnapshot = openSnapshot([row as unknown as Row]);
    let receivedSnapshot: ReactObserverSnapshot<Row> | undefined;
    let received: Row | undefined;
    const Consumer = () => {
      const snapshot = useQuery(plan);
      receivedSnapshot = snapshot;
      received = snapshot.state === 'open' ? snapshot.current.rows[0] : undefined;
      return null;
    };

    renderToString(createElement(
      TarstateProvider,
      { database, serverQueryObservations: [{ request, snapshot: serverSnapshot }] },
      createElement(Consumer)
    ));
    expect(receivedSnapshot).toBe(serverSnapshot);
    expect(received).toBe(row);
    expect(row.createdAt).toBeInstanceOf(Date);
    expect(Object.isFrozen(row)).toBe(false);
    expect(getterReads).toBe(0);
    expect(database.observers).toHaveLength(0);
  });

  it('tracks pending and settled commit state with selectable render suppression', async () => {
    const database = new TestDatabase();
    let resolveCommit: ((receipt: CommitReceipt) => void) | undefined;
    const commitImplementation = vi.fn(() => new Promise<CommitReceipt>((resolve) => { resolveCommit = resolve; }));
    const states: MutationState[] = [];
    const pendingCounts: number[] = [];
    let commit: ReturnType<typeof useCommit> | undefined;
    const Consumer = () => {
      commit = useCommit();
      states.push(useMutationState());
      pendingCounts.push(useMutationState({ selectState: ({ pendingCount }) => pendingCount }));
      return null;
    };
    await mount(createElement(TarstateProvider, { database, executeCommit: commitImplementation }, createElement(Consumer)));
    const attempt = transactionAttempt();
    let result: Promise<CommitReceipt> | undefined;
    await act(() => { result = commit?.(attempt); });
    expect(states.at(-1)).toMatchObject({ pendingCount: 1, mutations: [{ operationId: 'operation:one', state: 'pending' }] });
    expect(pendingCounts.at(-1)).toBe(1);

    const receipt = commitReceipt();
    await act(async () => {
      resolveCommit?.(receipt);
      await result;
    });
    expect(states.at(-1)).toMatchObject({ pendingCount: 0, mutations: [{ state: 'settled', receipt: { outcome: 'committed' } }] });
    expect(pendingCounts.at(-1)).toBe(0);
    expect(Object.isFrozen(states.at(-1))).toBe(true);
  });

  it('updates commit actions without replacing the query runtime', async () => {
    const database = new TestDatabase();
    const firstCommit = vi.fn(async () => commitReceipt());
    const secondCommit = vi.fn(async () => commitReceipt());
    let commit: ReturnType<typeof useCommit> | undefined;
    const Consumer = () => { commit = useCommit(); useQuery(plan); return null; };
    const renderer = await mount(createElement(TarstateProvider, { database, executeCommit: firstCommit }, createElement(Consumer)));
    const observer = database.observers[0];

    await act(() => { renderer.update(createElement(TarstateProvider, { database, executeCommit: secondCommit }, createElement(Consumer))); });
    await act(async () => { await commit?.(transactionAttempt()); });

    expect(database.observers).toHaveLength(1);
    expect(observer?.closeCount).toBe(0);
    expect(firstCommit).not.toHaveBeenCalled();
    expect(secondCommit).toHaveBeenCalledTimes(1);
  });

  it('applies an immutable optimistic projection tagged by operation and source basis', async () => {
    const database = new TestDatabase();
    let resolveCommit: ((receipt: CommitReceipt) => void) | undefined;
    const commitImplementation = () => new Promise<CommitReceipt>((resolve) => { resolveCommit = resolve; });
    const snapshots: ReactObserverSnapshot<Row>[] = [];
    let commit: ReturnType<typeof useCommit> | undefined;
    const Consumer = () => {
      commit = useCommit();
      snapshots.push(useQuery(plan));
      return null;
    };
    await mount(createElement(TarstateProvider, {
      database,
      executeCommit: commitImplementation,
      createOptimisticOverlay: optimisticNames('pending')
    }, createElement(Consumer)));

    let result: Promise<CommitReceipt> | undefined;
    await act(() => { result = commit?.(transactionAttempt()); });
    const optimistic = snapshots.at(-1);
    const authoritative = database.observers[0]?.getSnapshot();
    expect(optimistic).toMatchObject({
      state: 'open',
      current: { rows: [{ id: 1, name: 'one+pending' }] },
      lastExact: { rows: [{ id: 1, name: 'one' }] },
      optimistic: { operations: [{ operationEpoch: 'epoch:one', operationId: 'operation:one', sourceId: 'source:one', sourceBasis: { revision: 0 }, observedBasis: { revision: 0 }, rebased: false }] }
    });
    expect(Object.isFrozen(optimistic)).toBe(true);
    expect(Object.isFrozen(optimistic?.state === 'open' ? optimistic.current.rows : undefined)).toBe(true);
    expect(Object.isFrozen(optimistic?.state === 'open' ? optimistic.current.resultKeys : undefined)).toBe(true);
    if (optimistic?.state !== 'open' || authoritative?.state !== 'open') throw new Error('expected open snapshots');
    expect(optimistic.lastExact).toBe(authoritative.lastExact);
    expect(optimistic.current.basis).toBe(authoritative.current.basis);
    expect(optimistic.current.sourceStates).toBe(authoritative.current.sourceStates);
    expect(Object.isFrozen(optimistic.optimistic?.operations)).toBe(true);
    expect(Object.isFrozen(optimistic.optimistic?.operations[0])).toBe(true);

    await act(async () => {
      resolveCommit?.(commitReceipt());
      await result;
    });
  });

  it('preserves opaque optimistic row identities without inspecting or freezing them', async () => {
    const database = new TestDatabase();
    const commitImplementation = () => new Promise<CommitReceipt>(() => undefined);
    let getterReads = 0;
    class OpaqueRow {
      readonly id = 9;
      readonly values = new Map([['status', 'pending']]);
      get derived(): string { getterReads += 1; return 'derived'; }
    }
    const row = new OpaqueRow();
    const projectedRows: Row[] = [row as unknown as Row];
    const projectedKeys = ['row:opaque'];
    let commit: ReturnType<typeof useCommit> | undefined;
    let latest: ReactObserverSnapshot<Row> | undefined;
    const Consumer = () => { commit = useCommit(); latest = useQuery(plan); return null; };
    await mount(createElement(TarstateProvider, {
      database,
      executeCommit: commitImplementation,
      createOptimisticOverlay: () => ({
        sourceId: 'source:one',
        sourceBasis: { incarnation: 'one', revision: 0 },
        projectRows: () => ({ rows: projectedRows, resultKeys: projectedKeys })
      })
    }, createElement(Consumer)));

    await act(() => { void commit?.(transactionAttempt()); });
    if (latest?.state !== 'open') throw new Error('expected open snapshot');
    expect(latest.current.rows[0]).toBe(row);
    expect(row.values).toBeInstanceOf(Map);
    expect(Object.isFrozen(row)).toBe(false);
    expect(Object.isFrozen(latest.current.rows)).toBe(true);
    expect(getterReads).toBe(0);
    projectedRows.length = 0;
    projectedKeys[0] = 'row:mutated';
    expect(latest.current.rows).toEqual([row]);
    expect(latest.current.resultKeys).toEqual(['row:opaque']);
  });

  it('retains optimistic factory errors without blocking the real commit', async () => {
    const database = new TestDatabase();
    const commitImplementation = vi.fn(async () => commitReceipt());
    const states: MutationState[] = [];
    let commit: ReturnType<typeof useCommit> | undefined;
    const Consumer = () => { commit = useCommit(); states.push(useMutationState()); return null; };
    await mount(createElement(TarstateProvider, {
      database,
      executeCommit: commitImplementation,
      createOptimisticOverlay: () => { throw new TypeError('cannot project this attempt'); }
    }, createElement(Consumer)));

    await act(async () => { await commit?.(transactionAttempt()); });
    expect(commitImplementation).toHaveBeenCalledTimes(1);
    expect(states.at(-1)).toMatchObject({
      pendingCount: 0,
      mutations: [{ state: 'settled', optimisticError: { phase: 'create-overlay', name: 'TypeError', message: 'cannot project this attempt' } }]
    });
  });

  it.each([
    ['applies-to-query', (() => ({
      sourceId: 'source:one', sourceBasis: { revision: 0 },
      appliesToQuery: () => { throw new Error('broken applicability'); },
      projectRows: ({ currentRows, currentResultKeys }) => ({ rows: currentRows, resultKeys: currentResultKeys })
    })) satisfies CreateOptimisticOverlay<Query, Row>],
    ['project-rows', (() => ({
      sourceId: 'source:one', sourceBasis: { revision: 0 },
      projectRows: () => { throw new Error('broken projection'); }
    })) satisfies CreateOptimisticOverlay<Query, Row>],
    ['projection-result', (() => ({
      sourceId: 'source:one', sourceBasis: { revision: 0 },
      projectRows: () => ({ rows: [], resultKeys: ['orphan'] })
    })) satisfies CreateOptimisticOverlay<Query, Row>]
  ] as const)('records optimistic %s failures without blocking the authoritative commit', async (phase, createOptimisticOverlay) => {
    const database = new TestDatabase();
    const commitImplementation = vi.fn(async () => commitReceipt());
    const states: MutationState[] = [];
    let commit: ReturnType<typeof useCommit> | undefined;
    let latest: ReactObserverSnapshot<Row> | undefined;
    const Consumer = () => { commit = useCommit(); latest = useQuery(plan); states.push(useMutationState()); return null; };
    await mount(createElement(TarstateProvider, { database, executeCommit: commitImplementation, createOptimisticOverlay }, createElement(Consumer)));

    await act(async () => {
      await expect(commit?.(transactionAttempt())).resolves.toMatchObject({ outcome: 'committed' });
    });
    expect(commitImplementation).toHaveBeenCalledTimes(1);
    expect(states.at(-1)).toMatchObject({
      pendingCount: 0,
      mutations: [{ state: 'settled', optimisticError: { phase } }]
    });
    expect(latest).not.toHaveProperty('optimistic');
  });

  it('contains hostile optimistic result access and removes the rejected overlay immediately', async () => {
    const database = new TestDatabase();
    const commitImplementation = () => new Promise<CommitReceipt>(() => undefined);
    const states: MutationState[] = [];
    let commit: ReturnType<typeof useCommit> | undefined;
    let latest: ReactObserverSnapshot<Row> | undefined;
    let getterReads = 0;
    const hostileProjection = Object.defineProperty({ resultKeys: [] }, 'rows', {
      enumerable: true,
      get: () => { getterReads += 1; throw new Error('rows getter escaped'); }
    }) as unknown as OptimisticProjection<Row>;
    const Consumer = () => {
      commit = useCommit();
      latest = useQuery(plan);
      states.push(useMutationState());
      return null;
    };
    await mount(createElement(TarstateProvider, {
      database,
      executeCommit: commitImplementation,
      createOptimisticOverlay: () => ({
        sourceId: 'source:one',
        sourceBasis: { revision: 0 },
        projectRows: () => hostileProjection
      })
    }, createElement(Consumer)));

    await expect(act(() => { void commit?.(transactionAttempt()); })).resolves.toBeUndefined();
    await act(async () => { await Promise.resolve(); });
    expect(latest).not.toHaveProperty('optimistic');
    expect(states.at(-1)).toMatchObject({
      pendingCount: 1,
      mutations: [{ state: 'pending', optimisticError: { phase: 'projection-result', message: expect.stringMatching(/rows.*data property/) } }]
    });
    expect(getterReads).toBe(0);
  });

  it('rejects hostile optimistic source basis without invoking accessors', async () => {
    const database = new TestDatabase();
    let getterReads = 0;
    const sourceBasis = Object.defineProperty({}, 'revision', {
      enumerable: true,
      get: () => { getterReads += 1; return 0; }
    });
    const states: MutationState[] = [];
    let commit: ReturnType<typeof useCommit> | undefined;
    const Consumer = () => { commit = useCommit(); states.push(useMutationState()); return null; };
    await mount(createElement(TarstateProvider, {
      database,
      executeCommit: async () => commitReceipt(),
      createOptimisticOverlay: () => ({
        sourceId: 'source:one',
        sourceBasis: sourceBasis as never,
        projectRows: ({ currentRows, currentResultKeys }) => ({ rows: currentRows, resultKeys: currentResultKeys })
      })
    }, createElement(Consumer)));

    await act(async () => { await commit?.(transactionAttempt()); });
    expect(states.at(-1)).toMatchObject({
      pendingCount: 0,
      mutations: [{ state: 'settled', optimisticError: { phase: 'source-basis' } }]
    });
    expect(getterReads).toBe(0);
  });

  it.each(['sourceId', 'appliesToQuery'] as const)('rejects an optimistic overlay %s accessor without invoking it', async (property) => {
    const database = new TestDatabase();
    const commitImplementation = vi.fn(async () => commitReceipt());
    let getterReads = 0;
    const definition = {
      sourceId: 'source:one',
      sourceBasis: { revision: 0 },
      appliesToQuery: () => true,
      projectRows: ({ currentRows, currentResultKeys }: { readonly currentRows: readonly Row[]; readonly currentResultKeys: readonly string[] }) => ({
        rows: currentRows,
        resultKeys: currentResultKeys
      })
    };
    Object.defineProperty(definition, property, {
      enumerable: true,
      get: () => { getterReads += 1; throw new Error(`${property} getter escaped`); }
    });
    const states: MutationState[] = [];
    let commit: ReturnType<typeof useCommit> | undefined;
    const Consumer = () => { commit = useCommit(); states.push(useMutationState()); return null; };
    await mount(createElement(TarstateProvider, {
      database,
      executeCommit: commitImplementation,
      createOptimisticOverlay: () => definition as unknown as ReturnType<CreateOptimisticOverlay<Query, Row>>
    }, createElement(Consumer)));

    await act(async () => { await commit?.(transactionAttempt()); });
    expect(commitImplementation).toHaveBeenCalledTimes(1);
    expect(states.at(-1)).toMatchObject({
      pendingCount: 0,
      mutations: [{ state: 'settled', optimisticError: { phase: 'create-overlay', message: expect.stringMatching(new RegExp(property)) } }]
    });
    expect(getterReads).toBe(0);
  });

  it('recomputes the overlay as a rebase when a newer source basis arrives', async () => {
    const database = new TestDatabase();
    const commitImplementation = () => new Promise<CommitReceipt>(() => undefined);
    const snapshots: ReactObserverSnapshot<Row>[] = [];
    const rebases: boolean[] = [];
    let commit: ReturnType<typeof useCommit> | undefined;
    const overlay: CreateOptimisticOverlay<Query, Row> = () => ({
      sourceId: 'source:one',
      sourceBasis: { incarnation: 'one', revision: 0 },
      projectRows: ({ currentRows, rebased }) => {
        rebases.push(rebased);
        return { rows: currentRows.map((row) => ({ ...row, name: row.name + (rebased ? '+rebased' : '+pending') })), resultKeys: currentRows.map(({ id }) => 'row:' + id) };
      }
    });
    const Consumer = () => { commit = useCommit(); snapshots.push(useQuery(plan)); return null; };
    await mount(createElement(TarstateProvider, { database, executeCommit: commitImplementation, createOptimisticOverlay: overlay }, createElement(Consumer)));
    await act(() => { void commit?.(transactionAttempt()); });
    expect(snapshots.at(-1)).toMatchObject({ current: { rows: [{ name: 'one+pending' }] }, optimistic: { operations: [{ rebased: false }] } });

    await act(() => { database.observers[0]?.publish(openSnapshot([{ id: 1, name: 'server' }], 1)); });
    expect(snapshots.at(-1)).toMatchObject({
      current: { rows: [{ id: 1, name: 'server+rebased' }], basis: { attachments: [{ basis: { revision: 1 } }] } },
      optimistic: { operations: [{ sourceBasis: { revision: 0 }, observedBasis: { revision: 1 }, rebased: true }] }
    });
    expect(rebases).toContain(false);
    expect(rebases).toContain(true);
  });

  it.each(['committed', 'rejected', 'unknown'] as const)('discards the overlay on a %s receipt without rewriting authoritative evidence', async (outcome) => {
    const database = new TestDatabase();
    let resolveCommit: ((receipt: CommitReceipt) => void) | undefined;
    const commitImplementation = () => new Promise<CommitReceipt>((resolve) => { resolveCommit = resolve; });
    const snapshots: ReactObserverSnapshot<Row>[] = [];
    let commit: ReturnType<typeof useCommit> | undefined;
    const Consumer = () => { commit = useCommit(); snapshots.push(useQuery(plan)); return null; };
    await mount(createElement(TarstateProvider, { database, executeCommit: commitImplementation, createOptimisticOverlay: optimisticNames('pending') }, createElement(Consumer)));
    let result: Promise<CommitReceipt> | undefined;
    await act(() => { result = commit?.(transactionAttempt()); });
    expect(snapshots.at(-1)).toHaveProperty('optimistic');

    await act(async () => {
      resolveCommit?.(commitReceipt(outcome));
      await result;
    });
    expect(snapshots.at(-1)).toMatchObject({ state: 'open', current: { rows: [{ id: 1, name: 'one' }] } });
    expect(snapshots.at(-1)).not.toHaveProperty('optimistic');
    expect(database.observers[0]?.getSnapshot()).toBe(database.snapshot);
  });

  it('discards the overlay when commit throws and records the failed mutation', async () => {
    const database = new TestDatabase();
    let rejectCommit: ((error: Error) => void) | undefined;
    const states: MutationState[] = [];
    const snapshots: ReactObserverSnapshot<Row>[] = [];
    let commit: ReturnType<typeof useCommit> | undefined;
    const Consumer = () => { commit = useCommit(); states.push(useMutationState()); snapshots.push(useQuery(plan)); return null; };
    await mount(createElement(TarstateProvider, {
      database,
      executeCommit: () => new Promise<CommitReceipt>((_resolve, reject) => { rejectCommit = reject; }),
      createOptimisticOverlay: optimisticNames('pending')
    }, createElement(Consumer)));
    let result: Promise<CommitReceipt> | undefined;
    await act(() => { result = commit?.(transactionAttempt()); });
    expect(snapshots.at(-1)).toHaveProperty('optimistic');

    await act(async () => {
      rejectCommit?.(new Error('commit transport failed'));
      await expect(result).rejects.toThrow('commit transport failed');
    });
    expect(snapshots.at(-1)).not.toHaveProperty('optimistic');
    expect(states.at(-1)).toMatchObject({ pendingCount: 0, mutations: [{ state: 'failed', error: { message: 'commit transport failed' } }] });
  });

  it('rejects mismatched receipt identity and discards the overlay', async () => {
    const database = new TestDatabase();
    const states: MutationState[] = [];
    const snapshots: ReactObserverSnapshot<Row>[] = [];
    let commit: ReturnType<typeof useCommit> | undefined;
    const Consumer = () => { commit = useCommit(); states.push(useMutationState()); snapshots.push(useQuery(plan)); return null; };
    await mount(createElement(TarstateProvider, {
      database,
      executeCommit: async () => ({ ...commitReceipt(), operationId: 'operation:other' }),
      createOptimisticOverlay: optimisticNames('pending')
    }, createElement(Consumer)));

    await act(async () => {
      await expect(commit?.(transactionAttempt())).rejects.toThrow('Commit receipt identity does not match');
    });
    expect(snapshots.at(-1)).not.toHaveProperty('optimistic');
    expect(states.at(-1)).toMatchObject({ pendingCount: 0, mutations: [{ state: 'failed', error: { message: 'Commit receipt identity does not match its transaction attempt' } }] });
  });

  it('owns transaction attempts before an asynchronous commit handoff', async () => {
    const database = new TestDatabase();
    const states: MutationState[] = [];
    let resolveCommit: ((receipt: CommitReceipt) => void) | undefined;
    let received: TransactionAttempt | undefined;
    let commit: ReturnType<typeof useCommit> | undefined;
    const Consumer = () => { commit = useCommit(); states.push(useMutationState()); return null; };
    await mount(createElement(TarstateProvider, {
      database,
      executeCommit: (attempt) => {
        received = attempt;
        return new Promise<CommitReceipt>((resolve) => { resolveCommit = resolve; });
      }
    }, createElement(Consumer)));
    const caller = transactionAttempt() as TransactionAttempt & {
      operationId: string;
      transaction: { id: string; contentHash: string };
    };
    let result: Promise<CommitReceipt> | undefined;
    await act(() => { result = commit?.(caller); });

    caller.operationId = 'operation:mutated';
    caller.transaction.contentHash = 'sha256:mutated';
    expect(received).toMatchObject({ operationId: 'operation:one', transaction: { contentHash: 'sha256:transaction' } });
    expect(Object.isFrozen(received)).toBe(true);
    expect(Object.isFrozen(received?.transaction)).toBe(true);
    await act(async () => {
      resolveCommit?.(commitReceipt());
      await result;
    });
    expect(states.at(-1)).toMatchObject({ pendingCount: 0, mutations: [{ operationId: 'operation:one', state: 'settled' }] });
  });

  it('drops overlays with the owning provider runtime without owning observer or database lifecycle', async () => {
    const database = new TestDatabase();
    const project = vi.fn(({ currentRows }: { readonly currentRows: readonly Row[] }) => ({ rows: currentRows.map((row) => ({ ...row, name: row.name + '+pending' })), resultKeys: currentRows.map(({ id }) => 'row:' + id) }));
    const overlay: CreateOptimisticOverlay<Query, Row> = () => ({ sourceId: 'source:one', sourceBasis: { incarnation: 'one', revision: 0 }, projectRows: project });
    let commit: ReturnType<typeof useCommit> | undefined;
    let latest: ReactObserverSnapshot<Row> | undefined;
    const Consumer = () => { commit = useCommit(); latest = useQuery(plan); return null; };
    const renderer = await mount(createElement(TarstateProvider, { database, executeCommit: () => new Promise<CommitReceipt>(() => undefined), createOptimisticOverlay: overlay }, createElement(Consumer)));
    await act(() => { void commit?.(transactionAttempt()); });
    expect(latest).toHaveProperty('optimistic');
    const oldObserver = database.observers[0];
    const callsBeforeClose = project.mock.calls.length;

    await act(() => { renderer.unmount(); });
    await act(async () => { await Promise.resolve(); });
    expect(database.closeCount).toBe(0);
    expect(oldObserver?.closeCount).toBe(1);
    oldObserver?.publish(openSnapshot([{ id: 1, name: 'late' }], 2));
    expect(project).toHaveBeenCalledTimes(callsBeforeClose);

    let remounted: ReactObserverSnapshot<Row> | undefined;
    const Remounted = () => { remounted = useQuery(plan); return null; };
    await mount(createElement(TarstateProvider, { database, createOptimisticOverlay: overlay }, createElement(Remounted)));
    expect(remounted).toMatchObject({ state: 'open', current: { rows: [{ id: 1, name: 'one' }] } });
    expect(remounted).not.toHaveProperty('optimistic');
    expect(database.closeCount).toBe(0);
  });

  it('removes a failed overlay from every query view after a pure snapshot pass', async () => {
    const database = new TestDatabase();
    const states: MutationState[] = [];
    const snapshots: ReactObserverSnapshot<Row>[][] = [];
    const secondPlan = { ...plan, planId: 'query:second', rootNodeId: 'query:second:root' };
    const createOptimisticOverlay: CreateOptimisticOverlay<Query, Row> = () => ({
      sourceId: 'source:one',
      sourceBasis: { incarnation: 'one', revision: 0 },
      projectRows: ({ request, currentRows, currentResultKeys }) => {
        if (request.plan.planId === secondPlan.planId) throw new Error('second query cannot be projected');
        return { rows: currentRows.map((row) => ({ ...row, name: row.name + '+pending' })), resultKeys: currentResultKeys };
      }
    });
    let commit: ReturnType<typeof useCommit> | undefined;
    const Consumer = () => {
      commit = useCommit();
      states.push(useMutationState());
      snapshots.push([useQuery(plan), useQuery(secondPlan)]);
      return null;
    };
    await mount(createElement(TarstateProvider, {
      database,
      executeCommit: () => new Promise<CommitReceipt>(() => undefined),
      createOptimisticOverlay
    }, createElement(Consumer)));

    await act(async () => {
      void commit?.(transactionAttempt());
      await Promise.resolve();
    });

    expect(snapshots.at(-1)?.every((snapshot) => !Object.hasOwn(snapshot, 'optimistic'))).toBe(true);
    expect(states.at(-1)).toMatchObject({
      pendingCount: 1,
      mutations: [{ state: 'pending', optimisticError: { phase: 'project-rows', message: 'second query cannot be projected' } }]
    });
  });
});

const transactionAttempt = (): TransactionAttempt => ({
  operationEpoch: 'epoch:one',
  operationId: 'operation:one',
  attachmentId: 'attachment:one',
  transaction: { id: 'transaction:one', contentHash: 'sha256:transaction' }
});

const commitReceiptEvidence = {
  kind: 'commit',
  receiptVersion: 1 as const,
  operationEpoch: 'epoch:one',
  operationId: 'operation:one',
  transactionHash: 'sha256:transaction',
  intentHash: 'sha256:intent',
  attachmentId: 'attachment:one',
  attachmentFingerprint: 'sha256:attachment',
  sourceId: 'source:one',
  statementResults: [],
  issues: []
} as const;

const commitReceipt = (outcome: CommitReceipt['outcome'] = 'committed'): CommitReceipt => {
  const beforeBasis = { incarnation: 'one', revision: 0 };
  if (outcome === 'committed') return { ...commitReceiptEvidence, outcome, beforeBasis, afterBasis: { incarnation: 'one', revision: 1 }, durability: 'memory' };
  if (outcome === 'unknown') return { ...commitReceiptEvidence, outcome, beforeBasis, durability: 'unknown' };
  return { ...commitReceiptEvidence, outcome, beforeBasis };
};

const optimisticNames = (suffix: string): CreateOptimisticOverlay<Query, Row> => () => ({
  sourceId: 'source:one',
  sourceBasis: { incarnation: 'one', revision: 0 },
  appliesToQuery: ({ plan: candidate }) => candidate.planId === plan.planId,
  projectRows: ({ currentRows, currentResultKeys }) => ({ rows: currentRows.map((row) => ({ ...row, name: row.name + '+' + suffix })), resultKeys: currentResultKeys })
});
