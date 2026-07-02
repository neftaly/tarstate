import { StrictMode, createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TarstateProvider, useTarstateStore } from '@tarstate/react';
import type { TarstateDiagnostic } from '@tarstate/core';
import type { Db } from '@tarstate/core/db';
import type { Query } from '@tarstate/core/query';
import type { RelationRef } from '@tarstate/core/schema';
import type {
  Store,
  StoreCommitResult,
  StoreSnapshot,
  StoreView
} from '@tarstate/core/store';

const storeFactory = vi.hoisted(() => {
  type MockStoreRecord = {
    readonly input: unknown;
    readonly store: Store;
    readonly close: ReturnType<typeof vi.fn>;
  };
  const records: MockStoreRecord[] = [];
  const createStore = vi.fn((input?: unknown): Store => {
    const close = vi.fn();
    const diagnostics: readonly TarstateDiagnostic[] = [];
    const db = createMockDb(input);
    const source = {
      relationNames: [],
      rows: () => []
    };
    const snapshot: StoreSnapshot = {
      db,
      source,
      revision: 0,
      diagnostics
    };
    const commit = (async (): Promise<StoreCommitResult> => ({
      status: 'accepted',
      reflected: true,
      effects: {
        patches: 0,
        applied: 0,
        deltas: [],
        diagnostics
      },
      snapshot,
      diagnostics
    })) as Store['commit'];
    const createView = <Row,>(query: Query<Row>): StoreView<Row> => ({
      query,
      queryKey: 'mock-query',
      getSnapshot: () => ({
        rows: [],
        diagnostics,
        revision: 0,
        queryKey: 'mock-query'
      }),
      subscribe: () => () => undefined,
      refresh: async () => ({
        rows: [],
        diagnostics,
        revision: 0,
        queryKey: 'mock-query'
      })
    });
    const store = {
      getSnapshot: () => snapshot,
      subscribe: () => () => undefined,
      query: <Row,>(_target: Query<Row> | RelationRef, _options?: unknown) => ({
        rows: [],
        diagnostics,
        revision: 0
      }),
      queries: (() => {
        throw new Error('mock store does not implement queries');
      }) as Store['queries'],
      whatIf: (() => {
        throw new Error('mock store does not implement whatIf');
      }) as Store['whatIf'],
      view: createView,
      commit,
      refresh: async () => snapshot,
      close
    } satisfies Store;

    records.push({ input, store, close });
    return store;
  });

  function createMockDb(input: unknown): Db {
    if (isDb(input)) return input;
    return {
      data: isRecord(input) ? input as Db['data'] : {},
      env: {}
    };
  }

  function isDb(input: unknown): input is Db {
    return isRecord(input) && isRecord(input.data) && isRecord(input.env);
  }

  function isRecord(input: unknown): input is Record<string, unknown> {
    return typeof input === 'object' && input !== null && !Array.isArray(input);
  }

  return {
    createStore,
    records
  };
});

vi.mock('@tarstate/core/store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tarstate/core/store')>();
  return {
    ...actual,
    createStore: storeFactory.createStore
  };
});

describe('TarstateProvider lifecycle', () => {
  afterEach(() => {
    storeFactory.createStore.mockClear();
    storeFactory.records.length = 0;
  });

  it('creates, resets, and closes provider-owned stores', () => {
    const seenStores: Store[] = [];

    function Probe() {
      seenStores.push(useTarstateStore());
      return null;
    }

    const seedA = { items: [{ id: 'item-a' }] };
    const seedB = { items: [{ id: 'item-b' }] };
    let renderer: ReactTestRenderer | undefined;

    act(() => {
      renderer = create(createElement(
        StrictMode,
        undefined,
        createElement(TarstateProvider, { initialDb: seedA, resetKey: 'a' }, createElement(Probe))
      ));
    });

    const firstActiveStore = seenStores.at(-1);
    expect(firstActiveStore).toBeDefined();
    expect(activeRecord(firstActiveStore).close).not.toHaveBeenCalled();

    act(() => {
      renderer?.update(createElement(
        StrictMode,
        undefined,
        createElement(TarstateProvider, { initialDb: seedB, resetKey: 'b' }, createElement(Probe))
      ));
    });

    const secondActiveStore = seenStores.at(-1);
    expect(secondActiveStore).toBeDefined();
    expect(secondActiveStore).not.toBe(firstActiveStore);
    expect(activeRecord(firstActiveStore).close).toHaveBeenCalledTimes(1);
    expect(activeRecord(secondActiveStore).close).not.toHaveBeenCalled();
    expect(storeFactory.records.some((record) => record.input === seedA)).toBe(true);
    expect(storeFactory.records.some((record) => record.input === seedB)).toBe(true);

    act(() => {
      renderer?.unmount();
    });

    expect(activeRecord(secondActiveStore).close).toHaveBeenCalledTimes(1);
  });

  it('uses external stores without creating or closing owned stores', () => {
    const external = createExternalMockStore();
    let capturedStore: Store | undefined;

    function Probe() {
      capturedStore = useTarstateStore();
      return null;
    }

    let renderer: ReactTestRenderer | undefined;
    act(() => {
      renderer = create(createElement(TarstateProvider, { store: external.store }, createElement(Probe)));
    });
    act(() => {
      renderer?.unmount();
    });

    expect(capturedStore).toBe(external.store);
    expect(storeFactory.createStore).not.toHaveBeenCalled();
    expect(external.close).not.toHaveBeenCalled();
  });
});

function activeRecord(store: Store | undefined): { readonly close: ReturnType<typeof vi.fn> } {
  const record = storeFactory.records.find((item) => item.store === store);
  if (record === undefined) throw new Error('store was not created by the mocked factory');
  return record;
}

function createExternalMockStore(): { readonly store: Store; readonly close: ReturnType<typeof vi.fn> } {
  const close = vi.fn();
  const diagnostics: readonly TarstateDiagnostic[] = [];
  const snapshot: StoreSnapshot = {
    db: { data: {}, env: {} },
    source: {
      relationNames: [],
      rows: () => []
    },
    revision: 0,
    diagnostics
  };
  const store = {
    getSnapshot: () => snapshot,
    subscribe: () => () => undefined,
    query: <Row,>(_target: Query<Row> | RelationRef, _options?: unknown) => ({
      rows: [],
      diagnostics,
      revision: 0
    }),
    queries: (() => {
      throw new Error('external mock store does not implement queries');
    }) as Store['queries'],
    whatIf: (() => {
      throw new Error('external mock store does not implement whatIf');
    }) as Store['whatIf'],
    view: <Row,>(query: Query<Row>) => ({
      query,
      queryKey: 'external-query',
      getSnapshot: () => ({
        rows: [],
        diagnostics,
        revision: 0,
        queryKey: 'external-query'
      }),
      subscribe: () => () => undefined,
      refresh: async () => ({
        rows: [],
        diagnostics,
        revision: 0,
        queryKey: 'external-query'
      })
    }),
    commit: (async (): Promise<StoreCommitResult> => ({
      status: 'accepted',
      reflected: true,
      effects: {
        patches: 0,
        applied: 0,
        deltas: [],
        diagnostics
      },
      snapshot,
      diagnostics
    })) as Store['commit'],
    refresh: async () => snapshot,
    close
  } satisfies Store;

  return { store, close };
}
