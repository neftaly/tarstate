import { maintenanceFrameMetadataFor } from './internal-observer-maintenance-frame.js';
import type {
  DatabaseQueryMaintenanceInput,
  QueryMaintenanceReuseDiagnostics
} from './observer-maintenance-contracts.js';
import {
  adoptQueryOccurrenceIds,
  sealOwnedQueryMaintenanceUpdate
} from './internal-query-ownership.js';
import { deepFreezeObserverValue } from './internal-observer-values.js';
import { diffQueryMaintenanceSnapshotValues } from './query-maintenance-diff.js';
import type {
  FunctionRegistry,
  QueryNode,
  RelationInput
} from './query-model.js';
import type { QueryMaintenanceSnapshot, QueryMaintenanceUpdate } from './query-incremental-model.js';
const queryMaintenanceFrameIdentity = Symbol('tarstate.query-maintenance-frame');

type FramedQueryMaintenanceSnapshot = QueryMaintenanceSnapshot & {
  readonly [queryMaintenanceFrameIdentity]: {
    readonly frameIdentity: object;
    readonly runtimeIdentity: object;
  };
};

export type QueryMaintenanceSnapshotDiff = {
  readonly update: QueryMaintenanceUpdate;
  /** Publishes a reusable delta only after its physical application was accepted. */
  readonly accept: () => void;
};

export type QueryMaintenanceSnapshotNormalizer = {
  (input: DatabaseQueryMaintenanceInput<QueryNode, readonly RelationInput[]>): QueryMaintenanceSnapshot;
  readonly diff: (previous: QueryMaintenanceSnapshot, next: QueryMaintenanceSnapshot) => QueryMaintenanceSnapshotDiff;
  readonly getReuseDiagnostics: (runtimeIdentity: object) => QueryMaintenanceReuseDiagnostics;
};

export const createQueryMaintenanceSnapshotNormalizer = (functions: FunctionRegistry | undefined): QueryMaintenanceSnapshotNormalizer => {
  const maxParameterSnapshotsPerFrame = 256;
  const normalizedAttachments = new WeakMap<object, readonly RelationInput[]>();
  const frames = new WeakMap<object, {
    readonly normalized: Pick<QueryMaintenanceSnapshot, 'relations' | 'basis' | 'membershipRevision'>;
    readonly parameters: Map<string, QueryMaintenanceSnapshot>;
  }>();
  const deltas = new WeakMap<object, WeakMap<object, QueryMaintenanceUpdate>>();
  const reuseDiagnostics = new WeakMap<object, { computedFrameDeltaCount: number; reusedFrameDeltaCount: number }>();
  const normalize = (input: DatabaseQueryMaintenanceInput<QueryNode, readonly RelationInput[]>): QueryMaintenanceSnapshot => {
    const metadata = maintenanceFrameMetadataFor(input);
    if (metadata === undefined) return normalizeQueryMaintenanceSnapshot(input, functions, normalizedAttachments);
    let frame = frames.get(metadata.frameIdentity);
    if (frame === undefined) {
      frame = { normalized: normalizeQueryMaintenanceFrame(input, normalizedAttachments), parameters: new Map() };
      frames.set(metadata.frameIdentity, frame);
    }
    const cached = frame.parameters.get(metadata.parameterKey);
    if (cached !== undefined) {
      // Map insertion order is the deterministic recency list.
      frame.parameters.delete(metadata.parameterKey);
      frame.parameters.set(metadata.parameterKey, cached);
      return cached;
    }
    const normalized: FramedQueryMaintenanceSnapshot = {
      ...frame.normalized,
      parameters: input.parameters,
      ...(functions === undefined ? {} : { functions }),
      [queryMaintenanceFrameIdentity]: Object.freeze({
        frameIdentity: metadata.frameIdentity,
        runtimeIdentity: metadata.runtimeIdentity
      })
    };
    if (frame.parameters.size >= maxParameterSnapshotsPerFrame) {
      const leastRecentlyUsed = frame.parameters.keys().next().value;
      if (leastRecentlyUsed !== undefined) frame.parameters.delete(leastRecentlyUsed);
    }
    frame.parameters.set(metadata.parameterKey, normalized);
    return normalized;
  };
  normalize.diff = (previous: QueryMaintenanceSnapshot, next: QueryMaintenanceSnapshot): QueryMaintenanceSnapshotDiff => {
    const previousMetadata = (previous as Partial<FramedQueryMaintenanceSnapshot>)[queryMaintenanceFrameIdentity];
    const nextMetadata = (next as Partial<FramedQueryMaintenanceSnapshot>)[queryMaintenanceFrameIdentity];
    if (previousMetadata === undefined || nextMetadata === undefined || previousMetadata.runtimeIdentity !== nextMetadata.runtimeIdentity) {
      return { update: diffQueryMaintenanceSnapshotValues(previous, next), accept: () => undefined };
    }
    const { frameIdentity: previousFrame, runtimeIdentity } = previousMetadata;
    const { frameIdentity: nextFrame } = nextMetadata;

    // Parameters and capabilities remain cohort-local even though the captured
    // relation frame is shared. Validate them before consulting the frame cache.
    diffQueryMaintenanceSnapshotValues({ ...previous, relations: [] }, { ...next, relations: [] });
    const prior = deltas.get(previousFrame)?.get(nextFrame);
    if (prior !== undefined) {
      const diagnostics = reuseDiagnostics.get(runtimeIdentity) ?? { computedFrameDeltaCount: 0, reusedFrameDeltaCount: 0 };
      diagnostics.reusedFrameDeltaCount += 1;
      reuseDiagnostics.set(runtimeIdentity, diagnostics);
      return { update: prior, accept: () => undefined };
    }

    // Observer projections deliberately permit getter-backed values. Detach
    // them once before publication; physical runtimes recognize the resulting
    // frozen update and do not traverse it a second time.
    const update = sealOwnedQueryMaintenanceUpdate(
      deepFreezeObserverValue(diffQueryMaintenanceSnapshotValues(previous, next))
    );
    const diagnostics = reuseDiagnostics.get(runtimeIdentity) ?? { computedFrameDeltaCount: 0, reusedFrameDeltaCount: 0 };
    diagnostics.computedFrameDeltaCount += 1;
    reuseDiagnostics.set(runtimeIdentity, diagnostics);
    return {
      update,
      accept: () => {
        let from = deltas.get(previousFrame);
        if (from === undefined) {
          from = new WeakMap();
          deltas.set(previousFrame, from);
        }
        if (!from.has(nextFrame)) from.set(nextFrame, update);
      }
    };
  };
  normalize.getReuseDiagnostics = (runtimeIdentity: object) => Object.freeze({
    computedFrameDeltaCount: reuseDiagnostics.get(runtimeIdentity)?.computedFrameDeltaCount ?? 0,
    reusedFrameDeltaCount: reuseDiagnostics.get(runtimeIdentity)?.reusedFrameDeltaCount ?? 0
  });
  return normalize;
};

const normalizeQueryMaintenanceSnapshot = (
  input: DatabaseQueryMaintenanceInput<QueryNode, readonly RelationInput[]>,
  functions: FunctionRegistry | undefined,
  normalizedAttachments: WeakMap<object, readonly RelationInput[]>
): QueryMaintenanceSnapshot => ({
  ...normalizeQueryMaintenanceFrame(input, normalizedAttachments),
  parameters: input.parameters,
  ...(functions === undefined ? {} : { functions })
});

const normalizeQueryMaintenanceFrame = (
  input: DatabaseQueryMaintenanceInput<QueryNode, readonly RelationInput[]>,
  normalizedAttachments: WeakMap<object, readonly RelationInput[]>
): Pick<QueryMaintenanceSnapshot, 'relations' | 'basis' | 'membershipRevision'> => ({
  relations: input.attachments.flatMap((available) => {
    const cached = normalizedAttachments.get(available);
    if (cached !== undefined) return cached;
    const { member, snapshot, projection } = available;
    const normalized = Object.freeze(projection.map((relation) => Object.freeze({
      ...relation,
      ...(relation.occurrenceIds === undefined ? {} : { occurrenceIds: adoptQueryOccurrenceIds(relation.occurrenceIds) }),
      sourceId: member.sourceId,
      attachmentId: member.attachmentId,
      basis: snapshot.basis
    })));
    normalizedAttachments.set(available, normalized);
    return normalized;
  }),
  basis: {
    dataset: { datasetId: input.dataset.datasetId, revision: input.dataset.revision },
    attachments: input.attachments.map(({ member, snapshot }) => ({ attachmentId: member.attachmentId, sourceId: member.sourceId, basis: snapshot.basis }))
  },
  membershipRevision: input.dataset.revision
});
