import { describe, expect, it, vi } from 'vitest';
import {
  acquireExternalStoreRuntime,
  type AtomicExternalStore,
  type HydrationState
} from '../src/external-store.js';
import { HostRuntimeRegistry } from '../src/host.js';

type CounterState = { readonly count: number };

const host = () => new HostRuntimeRegistry({ trustPolicyId: 'test:external-store' });

const createAtomicStore = <State>(initial: State) => {
  let state = initial;
  const listeners = new Set<() => void>();
  let activeSubscriptions = 0;
  const store: AtomicExternalStore<State> = {
    getState: () => state,
    subscribe: (listener) => {
      activeSubscriptions += 1;
      listeners.add(listener);
      return () => {
        if (!listeners.delete(listener)) return;
        activeSubscriptions -= 1;
      };
    },
    update: (fn) => {
      const next = fn(state);
      if (next.changed) {
        state = next.state;
        for (const listener of listeners) listener();
      }
      return next.result;
    }
  };
  return {
    store,
    get activeSubscriptions() { return activeSubscriptions; },
    externalUpdate(next: State) {
      state = next;
      for (const listener of listeners) listener();
    },
    directMutation(next: State) { state = next; }
  };
};

describe('production external-store runtime', () => {
  it('commits synchronously at an exact basis with one revision and coherent notification', () => {
    const atomic = createAtomicStore<CounterState>({ count: 0 });
    const lease = acquireExternalStoreRuntime({
      registry: host(),
      sourceId: 'source:counter',
      store: atomic.store,
      storeIdentity: atomic
    });
    const listener = vi.fn(() => {
      expect(lease.runtime.snapshot()).toMatchObject({ basis: { revision: 1 }, storage: { count: 1 } });
    });
    lease.runtime.subscribe(listener);

    const before = lease.runtime.snapshot().basis;
    const receipt = lease.runtime.commit(before, (state) => ({
      state: { count: state.count + 1 },
      changed: true,
      result: 'updated' as const
    }));

    expect(receipt).toMatchObject({
      outcome: 'committed',
      changed: true,
      result: 'updated',
      beforeBasis: before,
      afterBasis: { incarnation: before.incarnation, revision: 1 }
    });
    expect(listener).toHaveBeenCalledTimes(1);
    lease.release();
  });

  it('observes legitimate external updates and rejects an exact stale basis', () => {
    const atomic = createAtomicStore<CounterState>({ count: 0 });
    const lease = acquireExternalStoreRuntime({
      registry: host(),
      sourceId: 'source:external-update',
      store: atomic.store,
      storeIdentity: atomic
    });
    const stale = lease.runtime.snapshot().basis;
    atomic.externalUpdate({ count: 1 });

    expect(lease.runtime.snapshot()).toMatchObject({ basis: { revision: 1 }, storage: { count: 1 } });
    expect(lease.runtime.commit(stale, (state) => ({ state, changed: false, result: undefined }))).toMatchObject({
      outcome: 'rejected',
      beforeBasis: { revision: 1 },
      issues: [{ code: 'transaction.expected_basis_stale', sourceId: 'source:external-update' }]
    });
    lease.release();
  });

  it('shares within one host, isolates hosts, and rejects identity conflicts only within a host', () => {
    const atomic = createAtomicStore<CounterState>({ count: 0 });
    const firstHost = host();
    const secondHost = host();
    const first = acquireExternalStoreRuntime({ registry: firstHost, sourceId: 'source:shared', store: atomic.store, storeIdentity: atomic });
    const second = acquireExternalStoreRuntime({ registry: firstHost, sourceId: 'source:shared', store: atomic.store, storeIdentity: atomic });
    const isolated = acquireExternalStoreRuntime({ registry: secondHost, sourceId: 'source:shared', store: atomic.store, storeIdentity: atomic });

    expect(second.runtime).toBe(first.runtime);
    expect(first.runtime.leaseCount).toBe(2);
    expect(isolated.runtime).not.toBe(first.runtime);
    expect(isolated.runtime.incarnation).not.toBe(first.runtime.incarnation);
    expect(atomic.activeSubscriptions).toBe(2);

    const conflicting = createAtomicStore<CounterState>({ count: 10 });
    expect(() => acquireExternalStoreRuntime({
      registry: firstHost,
      sourceId: 'source:shared',
      store: conflicting.store,
      storeIdentity: conflicting
    })).toThrow(/different live source identity/);
    const allowedInAnotherHost = acquireExternalStoreRuntime({
      registry: host(),
      sourceId: 'source:shared',
      store: conflicting.store,
      storeIdentity: conflicting
    });

    first.release();
    second.release();
    isolated.release();
    allowedInAnotherHost.release();
  });

  it('unsubscribes only after the last release, never closes the borrowed store, and rotates incarnation', () => {
    const atomic = createAtomicStore<CounterState>({ count: 0 });
    const registry = host();
    const first = acquireExternalStoreRuntime({ registry, sourceId: 'source:reattach', store: atomic.store, storeIdentity: atomic });
    const second = acquireExternalStoreRuntime({ registry, sourceId: 'source:reattach', store: atomic.store, storeIdentity: atomic });
    const oldRuntime = first.runtime;
    const oldIncarnation = oldRuntime.incarnation;

    first.release();
    expect(atomic.activeSubscriptions).toBe(1);
    second.release();
    expect(atomic.activeSubscriptions).toBe(0);
    expect(oldRuntime.snapshot()).toMatchObject({ state: 'closed', freshness: 'none' });

    // The application still owns and can use the store after Tarstate detaches.
    atomic.externalUpdate({ count: 4 });
    expect(atomic.store.getState()).toEqual({ count: 4 });

    const reattached = acquireExternalStoreRuntime({ registry, sourceId: 'source:reattach', store: atomic.store, storeIdentity: atomic });
    expect(reattached.runtime.incarnation).not.toBe(oldIncarnation);
    expect(reattached.runtime.snapshot()).toMatchObject({ basis: { revision: 0 }, storage: { count: 4 } });
    reattached.release();
  });

  it('preserves basis and notification for no-op commits and leaves direct mutation outside the protocol', () => {
    const atomic = createAtomicStore<CounterState>({ count: 0 });
    const lease = acquireExternalStoreRuntime({
      registry: host(),
      sourceId: 'source:no-op',
      store: atomic.store,
      storeIdentity: atomic
    });
    const listener = vi.fn();
    lease.runtime.subscribe(listener);
    const basis = lease.runtime.snapshot().basis;

    expect(lease.runtime.commit(basis, (state) => ({ state, changed: false, result: 'same' }))).toMatchObject({
      outcome: 'committed',
      changed: false,
      beforeBasis: basis,
      afterBasis: basis
    });
    atomic.directMutation({ count: 99 });
    expect(lease.runtime.snapshot()).toMatchObject({ basis, storage: { count: 99 } });
    expect(listener).not.toHaveBeenCalled();
    lease.release();
  });

  it('rejects an adapter that does not execute its atomic updater synchronously', () => {
    const store: AtomicExternalStore<CounterState> = {
      getState: () => ({ count: 0 }),
      subscribe: () => () => undefined,
      update: <Result>() => undefined as Result
    };
    const lease = acquireExternalStoreRuntime({
      registry: host(),
      sourceId: 'source:delayed-updater',
      store,
      storeIdentity: store
    });
    const basis = lease.runtime.snapshot().basis;

    expect(() => lease.runtime.commit(basis, (state) => ({ state, changed: false, result: undefined })))
      .toThrow(/invoke its updater synchronously/);
    expect(lease.runtime.snapshot().basis).toEqual(basis);
    lease.release();
  });

  it('adopts hydration that completes during setup and reports later transitions exactly once', () => {
    let hydration: HydrationState = 'loading';
    let reads = 0;
    const hydrationListeners = new Set<() => void>();
    const atomic = createAtomicStore<CounterState>({ count: 0 });
    const store: AtomicExternalStore<CounterState> = {
      ...atomic.store,
      hydration: {
        getState: () => {
          reads += 1;
          if (reads === 2) hydration = 'ready';
          return hydration;
        },
        subscribe: (listener) => {
          hydrationListeners.add(listener);
          return () => { hydrationListeners.delete(listener); };
        }
      }
    };
    const lease = acquireExternalStoreRuntime({ registry: host(), sourceId: 'source:hydration', store, storeIdentity: atomic });
    expect(lease.runtime.snapshot()).toMatchObject({ state: 'ready', freshness: 'current', basis: { revision: 0 } });

    const listener = vi.fn();
    lease.runtime.subscribe(listener);
    hydration = 'failed';
    for (const hydrationListener of hydrationListeners) hydrationListener();
    expect(lease.runtime.snapshot()).toMatchObject({
      state: 'failed',
      freshness: 'none',
      basis: { revision: 1 },
      issues: [{ code: 'source.hydration_failed' }]
    });
    expect(listener).toHaveBeenCalledTimes(1);
    lease.release();
  });
});
