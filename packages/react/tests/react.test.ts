import type {
  CommitReceipt,
  ObserveRequest,
  ObserverChange,
  ObserverSnapshot,
  PreparedPlan,
  QueryObserver,
  TransactionAttempt
} from '@tarstate/core';
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
  type OptimisticOverlayFactory,
  type ReactObserverSnapshot,
  type ReactPreparedPlan
} from '../src/index.js';

type Query = { readonly kind: 'all' };
type Row = { readonly id: number; readonly name: string };

const plan: ReactPreparedPlan<Query, Row> = {
  planId: 'query:all',
  rootNodeId: 'query:all:root',
  query: { kind: 'all' },
  registryFingerprint: 'registry:one',
  authorityFingerprint: 'authority:public',
  datasetId: 'dataset:one'
};

const basis = (revision: number) => ({
  dataset: { datasetId: 'dataset:one', revision },
  attachments: [{ attachmentId: 'attachment:one', sourceId: 'source:one', basis: { incarnation: 'one', revision } }]
});

const openSnapshot = (rows: readonly Row[], revision = 0): ObserverSnapshot<Row> => {
  const current = Object.freeze({
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
    let received: ObservableDatabase<Query, Row> | undefined;
    const Consumer = () => { received = useDatabase<Query, Row>(); return null; };
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
        select: (snapshot) => snapshot.state === 'open' ? snapshot.current.rows.map(({ name }) => name).join(',') : 'closed'
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
      retained = useRow(plan, 'row:1', { evidence: 'last-exact' });
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
      { database, serverObservations: [{ request, snapshot: openSnapshot([{ id: 7, name: 'server' }]) }] },
      createElement(Consumer)
    ));
    expect(html).toContain('server');
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
      pendingCounts.push(useMutationState({ select: ({ pendingCount }) => pendingCount }));
      return null;
    };
    await mount(createElement(TarstateProvider, { database, commit: commitImplementation }, createElement(Consumer)));
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
      commit: commitImplementation,
      optimisticOverlay: optimisticNames('pending')
    }, createElement(Consumer)));

    let result: Promise<CommitReceipt> | undefined;
    await act(() => { result = commit?.(transactionAttempt()); });
    const optimistic = snapshots.at(-1);
    expect(optimistic).toMatchObject({
      state: 'open',
      current: { rows: [{ id: 1, name: 'one+pending' }] },
      lastExact: { rows: [{ id: 1, name: 'one' }] },
      optimistic: { operations: [{ operationEpoch: 'epoch:one', operationId: 'operation:one', sourceId: 'source:one', sourceBasis: { revision: 0 }, observedBasis: { revision: 0 }, rebased: false }] }
    });
    expect(Object.isFrozen(optimistic)).toBe(true);
    expect(Object.isFrozen(optimistic?.state === 'open' ? optimistic.current.rows[0] : undefined)).toBe(true);

    await act(async () => {
      resolveCommit?.(commitReceipt());
      await result;
    });
  });

  it('retains optimistic factory errors without blocking the real commit', async () => {
    const database = new TestDatabase();
    const commitImplementation = vi.fn(async () => commitReceipt());
    const states: MutationState[] = [];
    let commit: ReturnType<typeof useCommit> | undefined;
    const Consumer = () => { commit = useCommit(); states.push(useMutationState()); return null; };
    await mount(createElement(TarstateProvider, {
      database,
      commit: commitImplementation,
      optimisticOverlay: () => { throw new TypeError('cannot project this attempt'); }
    }, createElement(Consumer)));

    await act(async () => { await commit?.(transactionAttempt()); });
    expect(commitImplementation).toHaveBeenCalledTimes(1);
    expect(states.at(-1)).toMatchObject({
      pendingCount: 0,
      mutations: [{ state: 'settled', optimisticError: { phase: 'factory', name: 'TypeError', message: 'cannot project this attempt' } }]
    });
  });

  it.each([
    ['appliesTo', (() => ({
      sourceId: 'source:one', sourceBasis: { revision: 0 },
      appliesTo: () => { throw new Error('broken applicability'); },
      project: ({ rows, resultKeys }) => ({ rows, resultKeys })
    })) satisfies OptimisticOverlayFactory<Query, Row>],
    ['project', (() => ({
      sourceId: 'source:one', sourceBasis: { revision: 0 },
      project: () => { throw new Error('broken projection'); }
    })) satisfies OptimisticOverlayFactory<Query, Row>],
    ['result', (() => ({
      sourceId: 'source:one', sourceBasis: { revision: 0 },
      project: () => ({ rows: [], resultKeys: ['orphan'] })
    })) satisfies OptimisticOverlayFactory<Query, Row>]
  ] as const)('throws explicit optimistic %s failures and rolls back the overlay', async (phase, optimisticOverlay) => {
    const database = new TestDatabase();
    const commitImplementation = vi.fn(async () => commitReceipt());
    let commit: ReturnType<typeof useCommit> | undefined;
    let latest: ReactObserverSnapshot<Row> | undefined;
    const Consumer = () => { commit = useCommit(); latest = useQuery(plan); return null; };
    await mount(createElement(TarstateProvider, { database, commit: commitImplementation, optimisticOverlay }, createElement(Consumer)));

    await act(async () => {
      await expect(commit?.(transactionAttempt())).rejects.toThrow('Optimistic overlay ' + phase + ' failed');
    });
    expect(commitImplementation).not.toHaveBeenCalled();
    expect(latest).not.toHaveProperty('optimistic');
  });

  it('recomputes the overlay as a rebase when a newer source basis arrives', async () => {
    const database = new TestDatabase();
    const commitImplementation = () => new Promise<CommitReceipt>(() => undefined);
    const snapshots: ReactObserverSnapshot<Row>[] = [];
    const rebases: boolean[] = [];
    let commit: ReturnType<typeof useCommit> | undefined;
    const overlay: OptimisticOverlayFactory<Query, Row> = () => ({
      sourceId: 'source:one',
      sourceBasis: { incarnation: 'one', revision: 0 },
      project: ({ rows, rebased }) => {
        rebases.push(rebased);
        return { rows: rows.map((row) => ({ ...row, name: row.name + (rebased ? '+rebased' : '+pending') })), resultKeys: rows.map(({ id }) => 'row:' + id) };
      }
    });
    const Consumer = () => { commit = useCommit(); snapshots.push(useQuery(plan)); return null; };
    await mount(createElement(TarstateProvider, { database, commit: commitImplementation, optimisticOverlay: overlay }, createElement(Consumer)));
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
    await mount(createElement(TarstateProvider, { database, commit: commitImplementation, optimisticOverlay: optimisticNames('pending') }, createElement(Consumer)));
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
      commit: () => new Promise<CommitReceipt>((_resolve, reject) => { rejectCommit = reject; }),
      optimisticOverlay: optimisticNames('pending')
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
      commit: async () => ({ ...commitReceipt(), operationId: 'operation:other' }),
      optimisticOverlay: optimisticNames('pending')
    }, createElement(Consumer)));

    await act(async () => {
      await expect(commit?.(transactionAttempt())).rejects.toThrow('Commit receipt identity does not match');
    });
    expect(snapshots.at(-1)).not.toHaveProperty('optimistic');
    expect(states.at(-1)).toMatchObject({ pendingCount: 0, mutations: [{ state: 'failed', error: { message: 'Commit receipt identity does not match its transaction attempt' } }] });
  });

  it('drops overlays with the owning provider runtime without owning observer or database lifecycle', async () => {
    const database = new TestDatabase();
    const project = vi.fn(({ rows }: { readonly rows: readonly Row[] }) => ({ rows: rows.map((row) => ({ ...row, name: row.name + '+pending' })), resultKeys: rows.map(({ id }) => 'row:' + id) }));
    const overlay: OptimisticOverlayFactory<Query, Row> = () => ({ sourceId: 'source:one', sourceBasis: { incarnation: 'one', revision: 0 }, project });
    let commit: ReturnType<typeof useCommit> | undefined;
    let latest: ReactObserverSnapshot<Row> | undefined;
    const Consumer = () => { commit = useCommit(); latest = useQuery(plan); return null; };
    const renderer = await mount(createElement(TarstateProvider, { database, commit: () => new Promise<CommitReceipt>(() => undefined), optimisticOverlay: overlay }, createElement(Consumer)));
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
    await mount(createElement(TarstateProvider, { database, optimisticOverlay: overlay }, createElement(Remounted)));
    expect(remounted).toMatchObject({ state: 'open', current: { rows: [{ id: 1, name: 'one' }] } });
    expect(remounted).not.toHaveProperty('optimistic');
    expect(database.closeCount).toBe(0);
  });
});

const transactionAttempt = (): TransactionAttempt => ({
  operationEpoch: 'epoch:one',
  operationId: 'operation:one',
  attachmentId: 'attachment:one',
  transaction: { id: 'transaction:one', contentHash: 'sha256:transaction' }
});

const commitReceipt = (outcome: CommitReceipt['outcome'] = 'committed'): CommitReceipt => ({
  kind: 'commit',
  receiptVersion: 1,
  operationEpoch: 'epoch:one',
  operationId: 'operation:one',
  transactionHash: 'sha256:transaction',
  intentHash: 'sha256:intent',
  attachmentId: 'attachment:one',
  attachmentFingerprint: 'sha256:attachment',
  sourceId: 'source:one',
  outcome,
  beforeBasis: { incarnation: 'one', revision: 0 },
  ...(outcome === 'committed' ? { afterBasis: { incarnation: 'one', revision: 1 }, durability: 'memory' as const } : {}),
  ...(outcome === 'unknown' ? { durability: 'unknown' as const } : {}),
  statementResults: [],
  issues: []
});

const optimisticNames = (suffix: string): OptimisticOverlayFactory<Query, Row> => () => ({
  sourceId: 'source:one',
  sourceBasis: { incarnation: 'one', revision: 0 },
  appliesTo: ({ plan: candidate }) => candidate.planId === plan.planId,
  project: ({ rows, resultKeys }) => ({ rows: rows.map((row) => ({ ...row, name: row.name + '+' + suffix })), resultKeys })
});
