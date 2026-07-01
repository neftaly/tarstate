import { relationDeltas } from './delta.js';
import type { RelationDelta } from './adapter.js';
import type { RelationRef } from './schema.js';

/** Mutable delta accumulator used internally by write before publishing immutable deltas. */
export type RelationDeltaAccumulator = Map<string, MutableRelationDelta>;

type MutableRelationDelta = {
  readonly relation: RelationRef;
  readonly added: unknown[];
  readonly removed: unknown[];
};

/** Create a relation-delta accumulator for one logical change batch. */
export function createRelationDeltaAccumulator(): RelationDeltaAccumulator {
  return new Map();
}

/** Record one added row for a relation. */
export function recordAddedDelta(
  accumulator: RelationDeltaAccumulator,
  relation: RelationRef,
  row: unknown
): void {
  deltaFor(accumulator, relation).added.push(row);
}

/** Record one removed row for a relation. */
export function recordRemovedDelta(
  accumulator: RelationDeltaAccumulator,
  relation: RelationRef,
  row: unknown
): void {
  deltaFor(accumulator, relation).removed.push(row);
}

/** Publish immutable deltas grouped by relation insertion order. */
export function relationDeltasFromAccumulator(accumulator: RelationDeltaAccumulator): readonly RelationDelta[] {
  return relationDeltas(accumulator);
}

function deltaFor(accumulator: RelationDeltaAccumulator, relation: RelationRef): MutableRelationDelta {
  const existing = accumulator.get(relation.name);

  if (existing !== undefined) {
    return existing;
  }

  const delta: MutableRelationDelta = {
    relation,
    added: [],
    removed: []
  };

  accumulator.set(relation.name, delta);
  return delta;
}
