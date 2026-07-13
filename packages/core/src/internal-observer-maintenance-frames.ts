import type { DatasetSnapshot } from './database.js';
import type { AvailableQueryAttachment } from './internal-observer-dataset-capture.js';
import type {
  DatabaseQueryMaintenanceInput,
  QueryMaintenanceReuseDiagnostics
} from './internal-observer-query-maintenance-contracts.js';
import { deepFreezeObserverValue } from './internal-observer-values.js';
import { adoptQueryOccurrenceIds } from './internal-query-ownership.js';
import { diffQueryMaintenanceSnapshots } from './query-maintenance-diff.js';
import type {
  FunctionRegistry,
  QueryMaintenanceSnapshot,
  QueryMaintenanceUpdate,
  QueryNode,
  RelationInput
} from './query-model.js';
import type { JsonValue } from './value.js';

const captureFrameMetadata = Symbol('tarstate.capture-frame');
const queryMaintenanceFrameIdentity = Symbol('tarstate.query-maintenance-frame');

type CaptureFrameMetadata = {
  readonly frameIdentity: object;
  readonly parameterKey: string;
  readonly runtimeIdentity: object;
};

type InternalDatabaseQueryMaintenanceInput<Query, Projection> = DatabaseQueryMaintenanceInput<Query, Projection> & {
  readonly [captureFrameMetadata]: CaptureFrameMetadata;
};

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

export const maintenanceInputWithFrame = <Query, Projection>(
  query: Query,
  parameters: Readonly<Record<string, JsonValue>>,
  dataset: DatasetSnapshot,
  attachments: readonly AvailableQueryAttachment<Projection>[],
  metadata: CaptureFrameMetadata
): DatabaseQueryMaintenanceInput<Query, Projection> => ({
  query,
  parameters,
  dataset,
  attachments,
  [captureFrameMetadata]: Object.freeze(metadata)
} as InternalDatabaseQueryMaintenanceInput<Query, Projection>);

export const createQueryMaintenanceSnapshotNormalizer = (functions: FunctionRegistry | undefined): QueryMaintenanceSnapshotNormalizer => {
  const maxParameterSnapshotsPerFrame = 256;
  const frames = new WeakMap<object, {
    readonly normalized: Pick<QueryMaintenanceSnapshot, 'relations' | 'basis' | 'membershipRevision'>;
    readonly parameters: Map<string, QueryMaintenanceSnapshot>;
  }>();
  const deltas = new WeakMap<object, WeakMap<object, QueryMaintenanceUpdate>>();
  const reuseDiagnostics = new WeakMap<object, { computedFrameDeltaCount: number; reusedFrameDeltaCount: number }>();
  const normalize = (input: DatabaseQueryMaintenanceInput<QueryNode, readonly RelationInput[]>): QueryMaintenanceSnapshot => {
    const metadata = (input as Partial<InternalDatabaseQueryMaintenanceInput<QueryNode, readonly RelationInput[]>>)[captureFrameMetadata];
    if (metadata === undefined) return normalizeQueryMaintenanceSnapshot(input, functions);
    let frame = frames.get(metadata.frameIdentity);
    if (frame === undefined) {
      frame = { normalized: normalizeQueryMaintenanceFrame(input), parameters: new Map() };
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
      return { update: diffQueryMaintenanceSnapshots(previous, next), accept: () => undefined };
    }
    const { frameIdentity: previousFrame, runtimeIdentity } = previousMetadata;
    const { frameIdentity: nextFrame } = nextMetadata;

    // Parameters and capabilities remain cohort-local even though the captured
    // relation frame is shared. Validate them before consulting the frame cache.
    diffQueryMaintenanceSnapshots({ ...previous, relations: [] }, { ...next, relations: [] });
    const prior = deltas.get(previousFrame)?.get(nextFrame);
    if (prior !== undefined) {
      const diagnostics = reuseDiagnostics.get(runtimeIdentity) ?? { computedFrameDeltaCount: 0, reusedFrameDeltaCount: 0 };
      diagnostics.reusedFrameDeltaCount += 1;
      reuseDiagnostics.set(runtimeIdentity, diagnostics);
      return { update: prior, accept: () => undefined };
    }

    // The diff contains source-owned nested values until this frame cache
    // adopts and freezes it for reuse across parameter cohorts.
    const update = deepFreezeObserverValue(diffQueryMaintenanceSnapshots(previous, next));
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
  functions: FunctionRegistry | undefined
): QueryMaintenanceSnapshot => ({
  ...normalizeQueryMaintenanceFrame(input),
  parameters: input.parameters,
  ...(functions === undefined ? {} : { functions })
});

const normalizeQueryMaintenanceFrame = (
  input: DatabaseQueryMaintenanceInput<QueryNode, readonly RelationInput[]>
): Pick<QueryMaintenanceSnapshot, 'relations' | 'basis' | 'membershipRevision'> => ({
  relations: input.attachments.flatMap(({ member, snapshot, projection }) => projection.map((relation) => ({
    ...relation,
    ...(relation.occurrenceIds === undefined ? {} : { occurrenceIds: adoptQueryOccurrenceIds(relation.occurrenceIds) }),
    sourceId: member.sourceId,
    attachmentId: member.attachmentId,
    basis: snapshot.basis
  }))),
  basis: {
    dataset: { datasetId: input.dataset.datasetId, revision: input.dataset.revision },
    attachments: input.attachments.map(({ member, snapshot }) => ({ attachmentId: member.attachmentId, sourceId: member.sourceId, basis: snapshot.basis }))
  },
  membershipRevision: input.dataset.revision
});
