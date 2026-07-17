import type { ArtifactRef } from '../artifacts.js';
import type { LogicalProjectionDemand } from '../query/projection-demand.js';

export type StorageProjectionSelection = {
  readonly relationIds: ReadonlySet<string>;
  readonly fieldsByRelation: ReadonlyMap<string, ReadonlySet<string>>;
};

export const selectStorageProjection = (
  demand: LogicalProjectionDemand | undefined,
  schemaView: ArtifactRef,
  availableRelationIds: readonly string[]
): StorageProjectionSelection | undefined => {
  if (demand === undefined) return undefined;
  const available = new Set(availableRelationIds);
  const fieldsByRelation = new Map<string, Set<string>>();
  for (const requested of demand.relations) {
    if (requested.relation.schemaView.id !== schemaView.id
      || requested.relation.schemaView.contentHash !== schemaView.contentHash
      || !available.has(requested.relation.relationId)) continue;
    let fields = fieldsByRelation.get(requested.relation.relationId);
    if (fields === undefined) {
      fields = new Set();
      fieldsByRelation.set(requested.relation.relationId, fields);
    }
    for (const field of requested.fields) fields.add(field);
  }
  return {
    relationIds: new Set(fieldsByRelation.keys()),
    fieldsByRelation
  };
};
