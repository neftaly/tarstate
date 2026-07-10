import type { AtomicExternalStore, HydrationState } from '@tarstate/core';
import type { StoreApi } from 'zustand/vanilla';

export type ZustandHydration = {
  readonly hasHydrated: () => boolean;
  readonly onHydrate: (listener: () => void) => () => void;
  readonly onFinishHydration: (listener: () => void) => () => void;
};

export const zustandAtomicExternalStore = <State>(
  store: StoreApi<State>,
  options: { readonly hydration?: ZustandHydration } = {}
): AtomicExternalStore<State> => {
  let hydrationState: HydrationState = options.hydration === undefined || options.hydration.hasHydrated() ? 'ready' : 'loading';
  return {
    getState: store.getState,
    subscribe: (listener) => store.subscribe(listener),
    update: <Result>(fn: (current: State) => { readonly state: State; readonly changed: boolean; readonly result: Result }): Result => {
      let output: { readonly state: State; readonly changed: boolean; readonly result: Result } | undefined;
      store.setState((current) => {
        output = fn(current);
        return output.changed ? output.state : current;
      }, true);
      if (output === undefined) throw new Error('Zustand did not execute its functional setter synchronously');
      return output.result;
    },
    ...(options.hydration === undefined ? {} : {
      hydration: {
        getState: () => {
          // Persistence can finish between adapter creation and subscription.
          // Re-read the authoritative positive signal on every observation.
          if (options.hydration?.hasHydrated()) hydrationState = 'ready';
          return hydrationState;
        },
        subscribe: (listener: () => void) => {
          const stopStart = options.hydration?.onHydrate(() => { hydrationState = 'loading'; listener(); });
          const stopFinish = options.hydration?.onFinishHydration(() => { hydrationState = 'ready'; listener(); });
          return () => { stopStart?.(); stopFinish?.(); };
        }
      }
    })
  };
};
