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

export type OpenLinkedDatabaseSourceRequest = {
  readonly sourceId: string;
  readonly attachmentId?: string;
  readonly signal: AbortSignal;
};

export type OpenLinkedDatabaseSource = (
  request: OpenLinkedDatabaseSourceRequest
) => MountableDatabaseSource | undefined | Promise<MountableDatabaseSource | undefined>;
