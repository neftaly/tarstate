import type { RelationRef } from './schema.js';

export type RelationDelta<Relation extends RelationRef = RelationRef> = {
  readonly relation: Relation;
  readonly added: readonly unknown[];
  readonly removed: readonly unknown[];
};

export const relationDeltas = (...deltas: readonly RelationDelta[]): readonly RelationDelta[] => deltas;
export const relationDeltaNames = (deltas: readonly RelationDelta[]): readonly string[] =>
  Array.from(new Set(deltas.map((delta) => delta.relation.name)));
