import type { QueryRecord, RelationInput, RelationUse } from '../model.js';
import { stringTupleKey } from '../../internal-string-key.js';

export type IndexedRelationInput = { readonly input: RelationInput; readonly index: number };

export const relationKey = (relation: RelationUse): string =>
  stringTupleKey(relation.schemaView.id, relation.schemaView.contentHash, relation.relationId);

export const relationInputIdentity = (relation: RelationUse, namespace = ''): string =>
  stringTupleKey(relationKey(relation), namespace);

export const relationInputKey = (input: RelationInput): string =>
  relationInputIdentity(input.relation, input.attachmentId ?? input.sourceId);

export const namespacedOccurrence = (
  namespace: string | undefined,
  occurrence: string
): string => namespace === undefined
  ? occurrence
  : namespace.length + ':' + namespace + occurrence.length + ':' + occurrence;

const groupedRelationInputs = new WeakMap<readonly RelationInput[], ReadonlyMap<string, readonly RelationInput[]>>();

export const groupRelationInputs = (inputs: readonly RelationInput[]): ReadonlyMap<string, readonly RelationInput[]> => {
  const cached = groupedRelationInputs.get(inputs);
  if (cached !== undefined) return cached;
  const grouped = new Map<string, RelationInput[]>();
  for (const input of inputs) {
    const key = relationKey(input.relation);
    const group = grouped.get(key);
    if (group === undefined) grouped.set(key, [input]);
    else group.push(input);
  }
  if (Object.isFrozen(inputs)) groupedRelationInputs.set(inputs, grouped);
  return grouped;
};

export const relationOccurrence = (input: RelationInput, index: number): string => {
  const occurrence = input.occurrenceIds?.[index] ?? relationKey(input.relation) + ':' + index;
  return namespacedOccurrence(input.sourceId ?? input.attachmentId, occurrence);
};

export const indexedRelationInputs = (relations: readonly RelationInput[]): Map<string, IndexedRelationInput> => {
  const output = new Map<string, IndexedRelationInput>();
  relations.forEach((input, index) => {
    const identity = relationInputKey(input);
    if (output.has(identity)) throw new TypeError('Duplicate relation input identity: ' + input.relation.relationId);
    output.set(identity, { input, index });
  });
  return output;
};

export const indexedRelationRows = (input: RelationInput): ReadonlyMap<string, { readonly index: number; readonly row: QueryRecord }> => {
  if (input.rows.length > 0 && input.occurrenceIds === undefined) throw new TypeError('Relation changes require occurrence IDs: ' + input.relation.relationId);
  const output = new Map<string, { readonly index: number; readonly row: QueryRecord }>();
  input.rows.forEach((row, index) => {
    const occurrenceId = input.occurrenceIds?.[index];
    if (occurrenceId === undefined || output.has(occurrenceId)) throw new TypeError('Invalid occurrence identity: ' + input.relation.relationId);
    output.set(occurrenceId, { index, row });
  });
  return output;
};
