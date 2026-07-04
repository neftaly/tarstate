import {
  Fragment,
  createContext,
  createElement,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactElement
} from 'react';
import type { Db } from '@tarstate/core/db';
import { createStore } from '@tarstate/core/store';
import type { Store } from '@tarstate/core/store';
import { areStoreSnapshotsEqual } from './equality.js';
import { stableSnapshotReader } from './snapshot.js';
import type {
  OwnedStoreState,
  ResetKey,
  TarstateCommit,
  TarstateDbInput,
  TarstateDbSnapshot,
  TarstateProviderProps
} from './types.js';

const TarstateContext = createContext<Store | undefined>(undefined);

export function TarstateProvider({ store, initialDb, resetKey, children }: TarstateProviderProps): ReactElement {
  const initialDbRef = useRef<TarstateDbInput | undefined>(initialDb);
  initialDbRef.current = initialDb;

  const ownedStoreRef = useRef<OwnedStoreState | undefined>(undefined);
  const [ownedStoreState, setOwnedStoreState] = useState<OwnedStoreState | undefined>(() => {
    if (store !== undefined) return undefined;
    const ownedStore = createOwnedStore(initialDb, resetKey);
    ownedStoreRef.current = ownedStore;
    return ownedStore;
  });

  useEffect(() => {
    if (store !== undefined) {
      closeOwnedStore(ownedStoreRef.current);
      ownedStoreRef.current = undefined;
      setOwnedStoreState(undefined);
      return undefined;
    }

    const current = ownedStoreRef.current;
    if (current === undefined || current.resetKey !== resetKey) {
      const next = createOwnedStore(initialDbRef.current, resetKey);
      closeOwnedStore(current);
      ownedStoreRef.current = next;
      setOwnedStoreState(next);
    }

    return () => {
      closeOwnedStore(ownedStoreRef.current);
      ownedStoreRef.current = undefined;
    };
  }, [store, resetKey]);

  const activeStore = store ?? ownedStoreState?.store;
  if (activeStore === undefined) return createElement(Fragment);

  return createElement(TarstateContext.Provider, { value: activeStore }, children);
}

export function useTarstateStore(): Store {
  const store = useContext(TarstateContext);
  if (store === undefined) {
    throw new Error('@tarstate/react hooks must be used within a TarstateProvider');
  }
  return store;
}

export function useTarstateSnapshot(): TarstateDbSnapshot {
  const store = useTarstateStore();
  const subscribe = useCallback((listener: () => void) => store.subscribe(listener), [store]);
  const getSnapshot = useMemo(
    () => stableSnapshotReader(() => store.getSnapshot(), areStoreSnapshotsEqual),
    [store]
  );

  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

export function useDb(): Db {
  return useTarstateSnapshot().db;
}

export function useCommit(): TarstateCommit {
  return useTarstateStore().commit;
}

function createOwnedStore(initialDb: TarstateDbInput | undefined, resetKey: ResetKey): OwnedStoreState {
  return {
    store: initialDb === undefined ? createStore() : createStore(initialDb),
    resetKey
  };
}

function closeOwnedStore(ownedStore: OwnedStoreState | undefined): void {
  ownedStore?.store.close();
}
