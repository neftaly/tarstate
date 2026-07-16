import type { ArtifactRef } from '../artifacts.js';
import type { CapabilityRef, Issue } from '../issues.js';
import type { AtomicSource, StorageBinding } from '../source-protocol.js';
import type { SourceLifecycleState } from '../source-state.js';

/** Portable declaration governing how one document becomes a logical attachment. */
export type DocumentDeclaration = {
  readonly formatVersion: 1;
  readonly storageSchema: ArtifactRef;
  readonly projection: { readonly kind: 'storage-mapping'; readonly storageMapping: ArtifactRef } | { readonly kind: 'storage-binding'; readonly storageBinding: CapabilityRef };
  readonly constraints?: { readonly set: ArtifactRef; readonly mode: 'audit' | 'required' };
};

export type AttachmentProjection<Projection> =
  | { readonly state: 'ready'; readonly value: Projection; readonly issues: readonly Issue[] }
  | { readonly state: Exclude<SourceLifecycleState, 'ready'>; readonly issues: readonly Issue[] };

/** Host composition of a live source with its authority-scoped logical views. */
export type Attachment<Storage = unknown, Command = unknown> = {
  readonly attachmentId: string;
  readonly incarnation: string;
  readonly sourceId: string;
  readonly source: AtomicSource<Storage, Command>;
  readonly storageBindings: readonly StorageBinding<Storage, Command>[];
  readonly schemaViews: readonly ArtifactRef[];
  readonly authorityScope: string;
  readonly capabilities?: readonly CapabilityRef[];
};
