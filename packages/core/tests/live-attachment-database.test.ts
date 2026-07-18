import { describe, expect, it, vi } from 'vitest';
import { createLiveAttachmentDatabase } from '../src/database/live-attachment.js';
import { AttachmentCatalog } from '../src/database.js';
import type { SourceSnapshot } from '../src/source-state.js';

type Storage = { readonly value: number };
type Snapshot = { readonly state: 'open'; readonly value: number } | { readonly state: 'closed' };

describe('live attachment database lifecycle', () => {
  it('deduplicates snapshots, subscribes lazily, mounts, and closes through source ownership', () => {
    let storage: Storage = { value: 1 };
    let revision = 0;
    const listeners = new Set<() => void>();
    let sourceOwner: object;
    const close = vi.fn(function (this: object) {
      expect(this).toBe(sourceOwner);
    });
    const source = {
      sourceId: 'source:live-shell',
      snapshot: (): SourceSnapshot<Storage> => ({
        sourceId: 'source:live-shell',
        operationEpoch: 'epoch:live-shell',
        basis: { revision },
        state: 'ready',
        freshness: 'current',
        storage,
        issues: []
      }),
      subscribe: (listener: () => void) => {
        listeners.add(listener);
        return () => { listeners.delete(listener); };
      },
      close
    };
    sourceOwner = source;
    const deriveSnapshot = vi.fn((snapshot: SourceSnapshot<Storage>): Snapshot => ({
      state: 'open',
      value: snapshot.storage?.value ?? -1
    }));
    const database = createLiveAttachmentDatabase({
      attachmentId: 'attachment:live-shell',
      incarnation: 'incarnation:live-shell',
      authorityScope: 'scope:live-shell',
      service: { ping: () => 'pong' as const },
      preparation: {
        writable: true,
        schemaViewIds: [],
        project: () => ({ state: 'ready', value: [], issues: [] })
      },
      source,
      deriveSnapshot,
      sameSnapshot: (left, right) => left.state === right.state
        && (left.state === 'closed' || (right.state === 'open' && left.value === right.value)),
      closedSnapshot: { state: 'closed' }
    });

    expect(database.ping()).toBe('pong');
    const initial = database.getSnapshot();
    expect(initial).toEqual({ state: 'open', value: 1 });
    expect(database.getSnapshot()).toBe(initial);

    const observer = vi.fn();
    const unsubscribe = database.subscribe(observer);
    expect(listeners.size).toBe(1);
    for (const listener of listeners) listener();
    expect(observer).not.toHaveBeenCalled();
    storage = { value: 2 };
    revision += 1;
    for (const listener of listeners) listener();
    expect(observer).toHaveBeenCalledOnce();
    expect(database.getSnapshot()).toEqual({ state: 'open', value: 2 });
    unsubscribe();
    expect(listeners.size).toBe(0);

    const catalog = new AttachmentCatalog();
    const mount = database.mount(catalog);
    expect(catalog.sourceCount()).toBe(1);
    database.close();
    expect(database.getSnapshot()).toEqual({ state: 'closed' });
    expect(catalog.sourceCount()).toBe(0);
    expect(close).toHaveBeenCalledOnce();
    mount.close();
  });
});
