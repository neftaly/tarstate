import { describe, expect, expectTypeOf, it, vi } from 'vitest';
import {
  createMemoryAtomicExternalStore,
  type OpenExternalStoreDatabaseOptions
} from '@tarstate/core/database/external-store';

type State = { readonly count: number };

describe('memory atomic external store', () => {
  it('commits changed state and notifies each current subscriber once', () => {
    const store = createMemoryAtomicExternalStore<State>({ count: 0 });
    const first = vi.fn();
    const second = vi.fn();
    const unsubscribeFirst = store.subscribe(first);
    store.subscribe(second);

    expect(store.update((current) => ({
      state: { count: current.count + 1 },
      changed: true,
      result: 'updated'
    }))).toBe('updated');
    expect(store.getState()).toEqual({ count: 1 });
    expect(first).toHaveBeenCalledOnce();
    expect(second).toHaveBeenCalledOnce();

    unsubscribeFirst();
    unsubscribeFirst();
    store.update((current) => ({ state: { count: current.count + 1 }, changed: true, result: undefined }));
    expect(first).toHaveBeenCalledOnce();
    expect(second).toHaveBeenCalledTimes(2);
  });

  it('preserves identity without notification for unchanged updates', () => {
    const initial = { count: 0 };
    const store = createMemoryAtomicExternalStore(initial);
    const listener = vi.fn();
    store.subscribe(listener);

    expect(store.update((current) => ({ state: current, changed: false, result: 7 }))).toBe(7);
    expect(store.getState()).toBe(initial);
    expect(listener).not.toHaveBeenCalled();
    expect(() => store.update(() => ({ state: { count: 0 }, changed: false, result: undefined })))
      .toThrow(/preserve state identity/);
  });

  it('rolls back throwing updaters and rejects nested atomic updates', () => {
    const initial = { count: 0 };
    const store = createMemoryAtomicExternalStore(initial);

    expect(() => store.update(() => { throw new Error('failed update'); })).toThrow('failed update');
    expect(store.getState()).toBe(initial);
    expect(() => store.update((current) => {
      store.update(() => ({ state: { count: 2 }, changed: true, result: undefined }));
      return { state: current, changed: false, result: undefined };
    })).toThrow(/reentrant updates/);
    expect(store.getState()).toBe(initial);
  });

  it('contains listener failures after the state is committed', () => {
    const store = createMemoryAtomicExternalStore<State>({ count: 0 });
    const peer = vi.fn();
    store.subscribe(() => { throw new Error('listener failed'); });
    store.subscribe(peer);

    store.update(() => ({ state: { count: 1 }, changed: true, result: undefined }));
    expect(store.getState()).toEqual({ count: 1 });
    expect(peer).toHaveBeenCalledOnce();
  });

  it('needs no separate identity at the standard database opener', () => {
    const store = createMemoryAtomicExternalStore<State>({ count: 0 });
    const input = {
      store
    } satisfies Pick<OpenExternalStoreDatabaseOptions<State>, 'store'>;

    expectTypeOf(input.store).toEqualTypeOf<typeof store>();
  });
});
