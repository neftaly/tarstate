import type { DatasetSnapshot } from './database-model.js';
import type {
  AvailableQueryAttachment,
  DatabaseQueryMaintenanceInput
} from './observer-maintenance-contracts.js';
import type { JsonValue } from './value.js';

const captureFrameMetadata = Symbol('tarstate.capture-frame');

export type CaptureFrameMetadata = {
  readonly frameIdentity: object;
  readonly parameterKey: string;
  readonly runtimeIdentity: object;
};

type FramedDatabaseQueryMaintenanceInput<Query, Projection> =
  DatabaseQueryMaintenanceInput<Query, Projection> & {
    readonly [captureFrameMetadata]: CaptureFrameMetadata;
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
} as FramedDatabaseQueryMaintenanceInput<Query, Projection>);

export const maintenanceFrameMetadataFor = <Query, Projection>(
  input: DatabaseQueryMaintenanceInput<Query, Projection>
): CaptureFrameMetadata | undefined =>
  (input as Partial<FramedDatabaseQueryMaintenanceInput<Query, Projection>>)[captureFrameMetadata];
