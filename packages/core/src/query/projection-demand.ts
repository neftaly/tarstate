import type { ArtifactRef } from '../artifacts.js';
import { canonicalizeJson } from '../canonical-json.js';
import { comparePortableStrings } from '../portable-order.js';
import type { JsonValue } from '../value.js';

export type RelationFieldDemand = {
  readonly relation: {
    readonly schemaView: ArtifactRef;
    readonly relationId: string;
  };
  readonly fields: readonly string[];
};

/** Conservative logical fields needed by one prepared query. Omission means full projection. */
export type LogicalProjectionDemand = {
  readonly relations: readonly RelationFieldDemand[];
};

export const projectionDemandKey = (demand: LogicalProjectionDemand | undefined): string =>
  demand === undefined ? 'full' : canonicalizeJson(demand as unknown as JsonValue);

export const ownLogicalProjectionDemand = (
  relations: ReadonlyMap<string, {
    readonly relation: RelationFieldDemand['relation'];
    readonly fields: ReadonlySet<string>;
  }>
): LogicalProjectionDemand => Object.freeze({
  relations: Object.freeze([...relations.values()]
    .sort((left, right) => comparePortableStrings(relationIdentity(left.relation), relationIdentity(right.relation)))
    .map(({ relation, fields }) => Object.freeze({
      relation: Object.freeze({
        schemaView: Object.freeze({
          id: relation.schemaView.id,
          contentHash: relation.schemaView.contentHash
        }),
        relationId: relation.relationId
      }),
      fields: Object.freeze([...fields].sort(comparePortableStrings))
    })))
});

export const relationDemandIdentity = (relation: RelationFieldDemand['relation']): string =>
  canonicalizeJson([
    relation.schemaView.id,
    relation.schemaView.contentHash,
    relation.relationId
  ]);

const relationIdentity = relationDemandIdentity;
