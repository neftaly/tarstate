import type { AtomicExternalStore } from '@tarstate/core';
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
  const hydration = options.hydration;
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
    ...(hydration === undefined ? {} : {
      hydration: {
        getState: () => hydration.hasHydrated() ? 'ready' : 'loading',
        subscribe: (listener: () => void) => {
          const stopStart = hydration.onHydrate(listener);
          const stopFinish = hydration.onFinishHydration(listener);
          return () => { stopStart(); stopFinish(); };
        }
      }
    })
  };
};
