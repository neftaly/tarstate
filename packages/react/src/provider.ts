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
  type DependencyList,
  type ReactElement
} from 'react';
import type { Db } from '@tarstate/core/db';
import type { RelationRuntime } from '@tarstate/core/adapter';
import { createRuntimeStore, createStore } from '@tarstate/core/store';
import type { Store, StoreRuntimeInput } from '@tarstate/core/store';
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
const emptyDependencyList: DependencyList = [];

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

export function useLocalStore(initialDb?: TarstateDbInput): Store {
  const initialDbRef = useRef<TarstateDbInput | undefined>(initialDb);
  const storeRef = useRef<Store | undefined>(undefined);
  if (storeRef.current === undefined) {
    storeRef.current = initialDbRef.current === undefined ? createStore() : createStore(initialDbRef.current);
  }
  const store = storeRef.current;

  useEffect(() => () => {
    store.close();
  }, [store]);

  return store;
}

export function useLocalRuntimeStore<Version>(createInput: () => RelationRuntime<Version>): Store<Version>;
export function useLocalRuntimeStore<Version>(
  createInput: () => RelationRuntime<Version>,
  deps: DependencyList
): Store<Version>;
export function useLocalRuntimeStore<Version>(
  createInput: () => StoreRuntimeInput<Version>
): Store<Version>;
export function useLocalRuntimeStore<Version>(
  createInput: () => StoreRuntimeInput<Version>,
  deps: DependencyList
): Store<Version>;
export function useLocalRuntimeStore<Version>(
  createInput: () => RelationRuntime<Version> | StoreRuntimeInput<Version>,
  deps: DependencyList = emptyDependencyList
): Store<Version> {
  const store = useMemo(() => {
    const input = createInput();
    return createRuntimeStore(isStoreRuntimeInput(input) ? input : { runtime: input });
  }, deps);

  useEffect(() => () => {
    store.close();
  }, [store]);

  return store;
}

function isStoreRuntimeInput<Version>(
  input: RelationRuntime<Version> | StoreRuntimeInput<Version>
): input is StoreRuntimeInput<Version> {
  return 'runtime' in input;
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
