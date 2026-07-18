import type { AtomicExternalStore } from '../../external-store.js';
import { notifyObservers } from '../../observer-diagnostics.js';

/**
 * Minimal synchronous atomic store for ephemeral sources and tests. Updater
 * failure and reentrancy preserve state; listener failures are contained after
 * a changed state is committed.
 */
export const createMemoryAtomicExternalStore = <State>(
  initialState: State
): AtomicExternalStore<State> => {
  let state = initialState;
  let updating = false;
  const listeners = new Set<() => void>();

  return {
    getState: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    update: (update) => {
      if (updating) throw new Error('Memory atomic external store does not allow reentrant updates');
      updating = true;
      let next;
      try {
        next = update(state);
      } finally {
        updating = false;
      }
      if (!next.changed) {
        if (!Object.is(next.state, state)) {
          throw new Error('Unchanged memory atomic external-store update must preserve state identity');
        }
        return next.result;
      }
      if (Object.is(next.state, state)) {
        throw new Error('Changed memory atomic external-store update must return distinct state');
      }
      state = next.state;
      notifyObservers(
        listeners,
        (listener) => { listener(); },
        { component: 'external-store', operation: 'memory-store-update' }
      );
      return next.result;
    }
  };
};
