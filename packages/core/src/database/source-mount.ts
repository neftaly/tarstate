import type { AttachmentCatalog } from '../database.js';

export type DatabaseSourceMountOptions = {
  readonly discoveryEdges?: readonly string[];
};

export type DatabaseSourceMountLease = {
  readonly attachmentId: string;
  readonly sourceId: string;
  readonly discoveryEdges: readonly string[];
  readonly close: () => void;
};

/** Minimal structural protocol shared by official and application database sources. */
export type MountableDatabaseSource = {
  readonly mount: (
    catalog: AttachmentCatalog,
    options?: DatabaseSourceMountOptions
  ) => DatabaseSourceMountLease | Promise<DatabaseSourceMountLease>;
};

/** A dynamically opened source whose lifetime transfers to the following session. */
export type OwnedDatabaseSource = MountableDatabaseSource & {
  readonly close: () => void;
};

export type OpenLinkedDatabaseSourceRequest = {
  readonly sourceId: string;
  readonly attachmentId?: string;
  readonly signal: AbortSignal;
};

export type OpenLinkedDatabaseSource = (
  request: OpenLinkedDatabaseSourceRequest
) => OwnedDatabaseSource | undefined | Promise<OwnedDatabaseSource | undefined>;
