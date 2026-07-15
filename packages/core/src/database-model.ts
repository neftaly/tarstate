import type { AttachmentProjection } from './attachment-model.js';
import type { ObservableSource, SourceSnapshot } from './source-state.js';

export type DatabaseAttachment<Storage = unknown, Projection = unknown> = {
  readonly attachmentId: string;
  readonly incarnation: string;
  readonly sourceId: string;
  readonly source: ObservableSource<Storage>;
  readonly authorityScope: string;
  readonly writable: boolean;
  readonly schemaViewIds: readonly string[];
  readonly discoveryEdges: readonly string[];
  readonly project: (snapshot: SourceSnapshot<Storage>) => AttachmentProjection<Projection>;
};

export type DatasetMember = {
  readonly attachmentId: string;
  readonly sourceId: string;
  readonly expectation: 'required' | 'optional';
  readonly discoveryEdges: readonly string[];
};

export type DatasetSnapshot = {
  readonly datasetId: string;
  readonly revision: number;
  readonly state: 'open' | 'settled';
  readonly members: readonly DatasetMember[];
};
