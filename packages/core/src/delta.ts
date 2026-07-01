import type { RelationDelta } from './adapter.js';
import type { RelationRef } from './schema.js';

export type { RelationDelta } from './adapter.js';

type RelationDeltaInput<Relation extends RelationRef = RelationRef> =
  | Iterable<RelationDelta<Relation>>
  | ReadonlyMap<string, RelationDelta<Relation>>;

/** Publish immutable delta snapshots from adapter-produced relation deltas. */
export function relationDeltas<Relation extends RelationRef>(
  deltas: RelationDeltaInput<Relation>
): readonly RelationDelta<Relation>[] {
  const values = isRelationDeltaMap(deltas) ? deltas.values() : deltas;

  return Object.freeze(Array.from(values, immutableRelationDelta));
}

/** Return relation names changed by a delta batch. */
export function relationDeltaNames(deltas: readonly RelationDelta[]): ReadonlySet<string> {
  return new Set(deltas.map((delta) => delta.relation.name));
}

function immutableRelationDelta<Relation extends RelationRef>(delta: RelationDelta<Relation>): RelationDelta<Relation> {
  return Object.freeze({
    relation: delta.relation,
    added: Object.freeze([...delta.added]),
    removed: Object.freeze([...delta.removed])
  });
}

function isRelationDeltaMap<Relation extends RelationRef>(
  input: RelationDeltaInput<Relation>
): input is ReadonlyMap<string, RelationDelta<Relation>> {
  return (
    typeof input === 'object' &&
    input !== null &&
    typeof (input as ReadonlyMap<string, RelationDelta<Relation>>).get === 'function'
  );
}
