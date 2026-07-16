import type * as Automerge from '@automerge/automerge';
import type {
  ReadyAttachmentPreparation
} from '@tarstate/core/attachment/adapter';
import type {
  DatabaseTransactionService,
  LogicalRelationRow
} from '@tarstate/core/transactions';
import type { AttachmentLease } from '@tarstate/core/database';
import type { RelationInput } from '@tarstate/core/query/model';
import type { WritableLogicalState } from '@tarstate/core/source';
import type { AutomergeAtomicSource } from '../adapter/atomic-source.js';
import type { AutomergeDatabase, AutomergeDatabaseSnapshot } from './model.js';
import {
  databaseSnapshot,
  sameDatabaseSnapshot,
  type AutomergeAttachmentProjector
} from '../attachment/projection.js';

export const createLiveAutomergeDatabase = <T extends object>(input: {
  readonly attachmentId: string;
  readonly incarnation: string;
  readonly authorityScope: string;
  readonly transactions: DatabaseTransactionService;
  readonly preparation: ReadyAttachmentPreparation<Automerge.Doc<T>, readonly RelationInput[], WritableLogicalState>;
  readonly source: AutomergeAtomicSource<T>;
  readonly projector: AutomergeAttachmentProjector<T>;
}): AutomergeDatabase => {
  const listeners = new Set<() => void>();
  const leases = new Set<AttachmentLease<Automerge.Doc<T>, readonly RelationInput[]>>();
  const logicalRows = new WeakMap<object, readonly LogicalRelationRow[]>();
  let closed = false;
  let dirty = false;
  let snapshot = databaseSnapshot(input.source.snapshot(), input.projector, logicalRows);
  let unsubscribeSource: (() => void) | undefined;

  const notify = (): void => {
    for (const listener of Array.from(listeners)) {
      try { listener(); } catch { /* Listener failures cannot block peers or source progress. */ }
    }
  };
  const refresh = (): boolean => {
    if (!dirty || closed) return false;
    const next = databaseSnapshot(input.source.snapshot(), input.projector, logicalRows);
    dirty = false;
    if (sameDatabaseSnapshot(snapshot, next)) return false;
    snapshot = next;
    return true;
  };
  const startSourceSubscription = (): void => {
    if (unsubscribeSource !== undefined) return;
    unsubscribeSource = input.source.subscribe(() => {
      dirty = true;
      if (listeners.size > 0 && refresh()) notify();
    });
  };

  return Object.freeze({
    ...input.transactions,
    getSnapshot: () => {
      if (unsubscribeSource === undefined) dirty = true;
      refresh();
      return snapshot;
    },
    subscribe: (listener: () => void) => {
      if (closed) return () => undefined;
      listeners.add(listener);
      dirty = true;
      startSourceSubscription();
      return () => {
        listeners.delete(listener);
        if (listeners.size > 0) return;
        unsubscribeSource?.();
        unsubscribeSource = undefined;
      };
    },
    mount: (catalog, options = {}) => {
      if (closed) throw new Error('Automerge database is closed');
      const discoveryEdges = Object.freeze([...new Set(options.discoveryEdges ?? [])].sort());
      const lease = catalog.attach({
        attachmentId: input.attachmentId,
        incarnation: input.incarnation,
        sourceId: input.source.sourceId,
        source: input.source,
        authorityScope: input.authorityScope,
        discoveryEdges,
        preparation: input.preparation
      });
      leases.add(lease);
      let leaseClosed = false;
      return Object.freeze({
        attachmentId: input.attachmentId,
        sourceId: input.source.sourceId,
        discoveryEdges,
        close: () => {
          if (leaseClosed) return;
          leaseClosed = true;
          leases.delete(lease);
          lease.close();
        }
      });
    },
    close: () => {
      if (closed) return;
      closed = true;
      unsubscribeSource?.();
      unsubscribeSource = undefined;
      for (const lease of Array.from(leases)) lease.close();
      leases.clear();
      snapshot = closedDatabaseSnapshot;
      notify();
      listeners.clear();
      input.source.close();
    }
  } satisfies AutomergeDatabase);
};

const closedDatabaseSnapshot: AutomergeDatabaseSnapshot = Object.freeze({ state: 'closed' });
