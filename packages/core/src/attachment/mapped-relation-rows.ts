import type { SchemaBody } from '../schema.js';
import type { LiteralRelation, SchemaRow } from '../schema-authoring.js';
import type { MappedDatabaseResult } from './mapped-database-projection.js';

type StringKey<Value> = Extract<keyof Value, string>;
type MappedFields = MappedDatabaseResult['rows'][number]['fields'];

const relationRowsByResult = new WeakMap<
  MappedDatabaseResult,
  Map<string, readonly MappedFields[]>
>();

/**
 * Selects typed rows after verifying that the result and relation share one exact schema view.
 * This does not strengthen the result's readiness or completeness evidence.
 */
export const mappedRelationRows = <
  const Body extends SchemaBody,
  const Name extends StringKey<Body['relations']>
>(
  result: MappedDatabaseResult,
  relation: LiteralRelation<Body, Name>
): readonly SchemaRow<Body, Name>[] => {
  if (result.schemaView.id !== relation.schemaView.id
    || result.schemaView.contentHash !== relation.schemaView.contentHash) {
    throw new TypeError('Mapped relation belongs to a different schema view');
  }
  let byRelation = relationRowsByResult.get(result);
  const cached = byRelation?.get(relation.relationId);
  if (cached !== undefined) return cached as readonly SchemaRow<Body, Name>[];
  const rows: MappedFields[] = [];
  for (const row of result.rows) {
    if (row.relationId === relation.relationId) {
      rows.push(row.fields);
    }
  }
  const selected = Object.freeze(rows);
  if (byRelation === undefined) {
    byRelation = new Map();
    relationRowsByResult.set(result, byRelation);
  }
  byRelation.set(relation.relationId, selected);
  return selected as readonly SchemaRow<Body, Name>[];
};
