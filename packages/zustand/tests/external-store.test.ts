import { Store as TanStackStore, type StoreActionMap } from '@tanstack/store';
import { acquireExternalStoreRuntime, HostRuntimeRegistry, type AtomicExternalStore } from '@tarstate/core/database';
import { createStore as createZustandStore } from 'zustand/vanilla';
import { createJSONStorage, persist } from 'zustand/middleware';
import { describe, expect, it, vi } from 'vitest';
import { zustandAtomicExternalStore } from '../src/index.js';

type SceneState = {
  readonly selected: string | null;
  readonly moves: number;
  readonly select: (id: string) => void;
};

const createPersistedZustand = () => {
  const storage = new Map<string, string>();
  const store = createZustandStore<SceneState>()(persist(
    (set) => ({ selected: null, moves: 0, select: (id) => set({ selected: id }) }),
    {
      name: 'probability-scene',
      storage: createJSONStorage(() => ({
        getItem: (name) => storage.get(name) ?? null,
        setItem: (name, value) => { storage.set(name, value); },
        removeItem: (name) => { storage.delete(name); }
      })),
      skipHydration: true
    }
  ));
  return store;
};

const host = () => new HostRuntimeRegistry({ trustPolicyId: 'test:zustand' });

const tanStackAtomicStore = <State, Actions extends StoreActionMap>(store: TanStackStore<State, Actions>): AtomicExternalStore<State> => ({
  getState: () => store.get(),
  subscribe: (listener) => {
    const subscription = store.subscribe(listener);
    return () => subscription.unsubscribe();
  },
  update: <Result>(fn: (current: State) => { readonly state: State; readonly changed: boolean; readonly result: Result }): Result => {
    let output: { readonly state: State; readonly changed: boolean; readonly result: Result } | undefined;
    store.setState((current) => {
      output = fn(current);
      return output.changed ? output.state : current;
    });
    if (output === undefined) throw new Error('TanStack Store did not execute its updater synchronously');
    return output.result;
  }
});

describe('production external-store adapter', () => {
  it('re-reads hasHydrated after adapter creation', () => {
    const store = createPersistedZustand();
    let hydrated = false;
    const external = zustandAtomicExternalStore(store, {
      hydration: {
        hasHydrated: () => hydrated,
        onHydrate: () => () => undefined,
        onFinishHydration: () => () => undefined
      }
    });
    expect(external.hydration?.getState()).toBe('loading');
    hydrated = true;
    expect(external.hydration?.getState()).toBe('ready');
  });

  it('derives restarted hydration directly from the persistence source', () => {
    const store = createPersistedZustand();
    let hydrated = true;
    const starts = new Set<() => void>();
    const finishes = new Set<() => void>();
    const external = zustandAtomicExternalStore(store, {
      hydration: {
        hasHydrated: () => hydrated,
        onHydrate: (listener) => { starts.add(listener); return () => { starts.delete(listener); }; },
        onFinishHydration: (listener) => { finishes.add(listener); return () => { finishes.delete(listener); }; }
      }
    });
    const listener = vi.fn();
    const unsubscribe = external.hydration?.subscribe(listener);
    expect(external.hydration?.getState()).toBe('ready');

    hydrated = false;
    for (const notify of starts) notify();
    expect(external.hydration?.getState()).toBe('loading');
    hydrated = true;
    for (const notify of finishes) notify();
    expect(external.hydration?.getState()).toBe('ready');
    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe?.();
    expect(starts.size).toBe(0);
    expect(finishes.size).toBe(0);
  });

  it('rolls back partial hydration subscriptions and attempts every cleanup', () => {
    const store = createPersistedZustand();
    const stopStart = vi.fn();
    const failed = zustandAtomicExternalStore(store, {
      hydration: {
        hasHydrated: () => false,
        onHydrate: () => stopStart,
        onFinishHydration: () => { throw new Error('finish registration failed'); }
      }
    });
    expect(() => failed.hydration?.subscribe(() => undefined)).toThrow('finish registration failed');
    expect(stopStart).toHaveBeenCalledOnce();

    const stopFinish = vi.fn();
    const cleanupFailure = zustandAtomicExternalStore(store, {
      hydration: {
        hasHydrated: () => false,
        onHydrate: () => () => { throw new Error('start cleanup failed'); },
        onFinishHydration: () => stopFinish
      }
    });
    expect(() => cleanupFailure.hydration?.subscribe(() => undefined)()).toThrow('start cleanup failed');
    expect(stopFinish).toHaveBeenCalledOnce();
  });

  it('tracks real Zustand persistence hydration even when hydrated data equals initial state', async () => {
    const store = createPersistedZustand();
    const external = zustandAtomicExternalStore(store, { hydration: store.persist });
    const lease = acquireExternalStoreRuntime({ registry: host(), sourceId: 'source:zustand:hydration', store: external, storeIdentity: store });
    const listener = vi.fn();
    lease.runtime.subscribe(listener);
    expect(lease.runtime.snapshot()).toMatchObject({ state: 'loading', freshness: 'none', basis: { revision: 0 } });
    await store.persist.rehydrate();
    expect(lease.runtime.snapshot()).toMatchObject({ state: 'ready', freshness: 'current', basis: { revision: 1 }, storage: { selected: null, moves: 0 } });
    expect(listener).toHaveBeenCalledTimes(1);
    lease.release();
  });

  it('preserves Zustand actions and emits one coherent notification/revision per atomic commit', () => {
    const store = createPersistedZustand();
    const external = zustandAtomicExternalStore(store);
    const storeListener = vi.fn();
    store.subscribe(storeListener);
    const lease = acquireExternalStoreRuntime({ registry: host(), sourceId: 'source:zustand:commit', store: external, storeIdentity: store });
    const runtimeListener = vi.fn();
    lease.runtime.subscribe(runtimeListener);
    const before = lease.runtime.snapshot().basis;
    const action = store.getState().select;
    const receipt = lease.runtime.commit(before, (state) => ({ state: { ...state, moves: state.moves + 1 }, changed: true, result: 'planned' as const }));
    expect(receipt).toMatchObject({ outcome: 'committed', changed: true, result: 'planned', beforeBasis: { revision: 0 }, afterBasis: { revision: 1 } });
    expect(store.getState()).toMatchObject({ moves: 1, select: action });
    expect(storeListener).toHaveBeenCalledTimes(1);
    expect(runtimeListener).toHaveBeenCalledTimes(1);
    lease.release();
  });

  it('observes external Zustand actions synchronously and rejects stale commits', () => {
    const store = createPersistedZustand();
    const lease = acquireExternalStoreRuntime({ registry: host(), sourceId: 'source:zustand:external', store: zustandAtomicExternalStore(store), storeIdentity: store });
    const stale = lease.runtime.snapshot().basis;
    store.getState().select('piece:queen');
    expect(lease.runtime.snapshot()).toMatchObject({ basis: { revision: 1 }, storage: { selected: 'piece:queen' } });
    expect(lease.runtime.commit(stale, (state) => ({ state, changed: false, result: null }))).toMatchObject({ outcome: 'rejected', issues: [{ code: 'transaction.expected_basis_stale' }] });
    lease.release();
  });

  it('adapts the Probability-style TanStack Store without relocating its actions', () => {
    type ProbabilityState = { readonly scene: string; readonly moves: number };
    const store = new TanStackStore<ProbabilityState, { move: (scene: string) => void }>(
      { scene: 'origin', moves: 0 },
      ({ setState }) => ({ move: (scene) => setState((state) => ({ scene, moves: state.moves + 1 })) })
    );
    const lease = acquireExternalStoreRuntime({ registry: host(), sourceId: 'source:tanstack:probability', store: tanStackAtomicStore(store), storeIdentity: store });
    const listener = vi.fn();
    lease.runtime.subscribe(listener);
    store.actions.move('tableau');
    expect(lease.runtime.snapshot()).toMatchObject({ state: 'ready', basis: { revision: 1 }, storage: { scene: 'tableau', moves: 1 } });
    const action = store.actions.move;
    const receipt = lease.runtime.commit(lease.runtime.snapshot().basis, (state) => ({ state: { ...state, scene: 'foundation', moves: state.moves + 1 }, changed: true, result: 1 }));
    expect(receipt).toMatchObject({ outcome: 'committed', afterBasis: { revision: 2 } });
    expect(store.actions.move).toBe(action);
    expect(store.state).toEqual({ scene: 'foundation', moves: 2 });
    expect(listener).toHaveBeenCalledTimes(2);
    lease.release();
  });

  it('shares one runtime/subscription across databases and rotates incarnation after last release', () => {
    const store = createPersistedZustand();
    const external = zustandAtomicExternalStore(store);
    const registry = host();
    let activeSubscriptions = 0;
    const counted: AtomicExternalStore<SceneState> = {
      ...external,
      subscribe: (listener) => {
        activeSubscriptions += 1;
        const unsubscribe = external.subscribe(listener);
        return () => { activeSubscriptions -= 1; unsubscribe(); };
      }
    };
    const first = acquireExternalStoreRuntime({ registry, sourceId: 'source:shared', store: counted, storeIdentity: store });
    const second = acquireExternalStoreRuntime({ registry, sourceId: 'source:shared', store: counted, storeIdentity: store });
    expect(second.runtime).toBe(first.runtime);
    expect(first.runtime.leaseCount).toBe(2);
    expect(activeSubscriptions).toBe(1);
    const incarnation = first.runtime.incarnation;
    first.release();
    expect(activeSubscriptions).toBe(1);
    second.release();
    expect(activeSubscriptions).toBe(0);
    const reattached = acquireExternalStoreRuntime({ registry, sourceId: 'source:shared', store: counted, storeIdentity: store });
    expect(reattached.runtime.incarnation).not.toBe(incarnation);
    reattached.release();
  });

  it('rejects a second live store for one source ID and never closes borrowed stores', () => {
    const firstStore = createPersistedZustand();
    const secondStore = createPersistedZustand();
    const registry = host();
    const first = acquireExternalStoreRuntime({ registry, sourceId: 'source:identity', store: zustandAtomicExternalStore(firstStore), storeIdentity: firstStore });
    expect(() => acquireExternalStoreRuntime({ registry, sourceId: 'source:identity', store: zustandAtomicExternalStore(secondStore), storeIdentity: secondStore })).toThrow(/different live source identity/);
    first.release();
    firstStore.getState().select('still-owned');
    expect(firstStore.getState().selected).toBe('still-owned');
  });

  it('makes direct mutation visibly outside the protocol rather than inventing a revision', () => {
    const store = createPersistedZustand();
    const lease = acquireExternalStoreRuntime({ registry: host(), sourceId: 'source:invalid-mutation', store: zustandAtomicExternalStore(store), storeIdentity: store });
    const state = store.getState() as { selected: string | null; moves: number; select: (id: string) => void };
    state.moves = 99;
    expect(lease.runtime.snapshot()).toMatchObject({ basis: { revision: 0 }, storage: { moves: 99 } });
    lease.release();
  });

  it('does not notify or advance basis for changed:false', () => {
    const store = createPersistedZustand();
    const lease = acquireExternalStoreRuntime({ registry: host(), sourceId: 'source:no-op', store: zustandAtomicExternalStore(store), storeIdentity: store });
    const listener = vi.fn();
    lease.runtime.subscribe(listener);
    const receipt = lease.runtime.commit(lease.runtime.snapshot().basis, (state) => ({ state, changed: false, result: 'same' }));
    expect(receipt).toMatchObject({ outcome: 'committed', changed: false, beforeBasis: { revision: 0 }, afterBasis: { revision: 0 } });
    expect(listener).not.toHaveBeenCalled();
    lease.release();
  });
});
