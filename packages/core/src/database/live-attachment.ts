import type { AttachmentProjection } from '../attachment/model.js';
import type { AttachmentLease, AttachmentCatalog } from '../database.js';
import type { LogicalProjectionDemand } from '../query/projection-demand.js';
import type { ObservableSource, SourceSnapshot } from '../source-state.js';
import type {
  DatabaseSourceMountOptions,
  DatabaseSourceMountLease,
  OwnedDatabaseSource
} from './source-mount.js';

export type LiveAttachmentDatabase<Service extends object, Snapshot> = Service
  & Omit<OwnedDatabaseSource, 'mount'>
  & {
  readonly attachmentId: string;
  readonly sourceId: string;
  readonly getSnapshot: () => Snapshot;
  readonly subscribe: (listener: () => void) => () => void;
  readonly mount: (
    catalog: AttachmentCatalog,
    options?: DatabaseSourceMountOptions
  ) => DatabaseSourceMountLease;
};

export type LiveAttachmentDatabaseInput<Storage, Projection, Service extends object, Snapshot> = {
  readonly attachmentId: string;
  readonly incarnation: string;
  readonly authorityScope: string;
  readonly service: Service;
  readonly preparation: {
    readonly writable: boolean;
    readonly schemaViewIds: readonly string[];
    readonly project: (
      snapshot: SourceSnapshot<Storage>,
      demand?: LogicalProjectionDemand
    ) => AttachmentProjection<Projection>;
  };
  readonly source: ObservableSource<Storage> & { readonly close: () => void };
  readonly deriveSnapshot: (source: SourceSnapshot<Storage>) => Snapshot;
  readonly sameSnapshot: (left: Snapshot, right: Snapshot) => boolean;
  readonly closedSnapshot: Snapshot;
};

/** Source-neutral lifecycle shell shared by official attached database adapters. */
export const createLiveAttachmentDatabase = <Storage, Projection, Service extends object, Snapshot>(
  input: LiveAttachmentDatabaseInput<Storage, Projection, Service, Snapshot>
): LiveAttachmentDatabase<Service, Snapshot> => {
  const attachmentId = input.attachmentId;
  const sourceId = input.source.sourceId;
  const listeners = new Set<() => void>();
  const leases = new Set<AttachmentLease<Storage, Projection>>();
  let closed = false;
  let dirty = false;
  let snapshot: Snapshot | undefined;
  let unsubscribeSource: (() => void) | undefined;

  const notify = (): void => {
    for (const listener of Array.from(listeners)) {
      try {
        listener();
      } catch { /* Listener failures cannot block peers or source progress. */ }
    }
  };
  const refresh = (): boolean => {
    if ((!dirty && snapshot !== undefined) || closed) return false;
    const next = input.deriveSnapshot(input.source.snapshot());
    dirty = false;
    if (snapshot !== undefined && input.sameSnapshot(snapshot, next)) return false;
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
    ...input.service,
    attachmentId,
    sourceId,
    getSnapshot: () => {
      if (closed) return input.closedSnapshot;
      if (unsubscribeSource === undefined) dirty = true;
      refresh();
      return snapshot as Snapshot;
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
    mount: (catalog: AttachmentCatalog, options = {}): DatabaseSourceMountLease => {
      if (closed) throw new Error('Attached database is closed');
      const discoveryEdges = Object.freeze([...new Set(options.discoveryEdges ?? [])].sort());
      const lease = catalog.attach<Storage, Projection>({
        attachmentId,
        incarnation: input.incarnation,
        sourceId,
        source: input.source,
        authorityScope: input.authorityScope,
        discoveryEdges,
        preparation: input.preparation
      });
      leases.add(lease);
      let leaseClosed = false;
      return Object.freeze({
        attachmentId,
        sourceId,
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
      const subscription = unsubscribeSource;
      unsubscribeSource = undefined;
      snapshot = input.closedSnapshot;
      notify();
      listeners.clear();

      let firstCleanupFailure: { readonly error: unknown } | undefined;
      const attemptCleanup = (cleanup: (() => void) | undefined): void => {
        if (cleanup === undefined) return;
        try {
          cleanup();
        } catch (error) {
          firstCleanupFailure ??= { error };
        }
      };
      attemptCleanup(subscription);
      for (const lease of leases) attemptCleanup(() => lease.close());
      leases.clear();
      attemptCleanup(() => input.source.close());
      if (firstCleanupFailure !== undefined) throw firstCleanupFailure.error;
    }
  });
};
