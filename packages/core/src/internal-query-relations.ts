import type { QueryRecord, RelationInput, RelationUse } from './query-model.js';

export type IndexedRelationInput = { readonly input: RelationInput; readonly index: number };

export const relationKey = (relation: RelationUse): string =>
  relation.schemaView.id + '\u0000' + relation.schemaView.contentHash + '\u0000' + relation.relationId;

export const relationInputKey = (input: RelationInput): string =>
  relationKey(input.relation) + '\u0000' + (input.attachmentId ?? input.sourceId ?? '');

export const groupRelationInputs = (inputs: readonly RelationInput[]): ReadonlyMap<string, readonly RelationInput[]> => {
  const grouped = new Map<string, RelationInput[]>();
  for (const input of inputs) {
    const key = relationKey(input.relation);
    const group = grouped.get(key);
    if (group === undefined) grouped.set(key, [input]);
    else group.push(input);
  }
  return grouped;
};

export const relationOccurrence = (input: RelationInput, index: number): string => {
  const occurrence = input.occurrenceIds?.[index] ?? relationKey(input.relation) + ':' + index;
  const namespace = input.sourceId ?? input.attachmentId;
  return namespace === undefined ? occurrence : namespace.length + ':' + namespace + occurrence.length + ':' + occurrence;
};

export const indexedRelationInputs = (relations: readonly RelationInput[]): ReadonlyMap<string, IndexedRelationInput> => {
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
