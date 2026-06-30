import { fromObjectSource, isRelationSource, type RelationSource } from './source.js';

export type ObjectBackedRelationData = {
  readonly data: Record<string, readonly unknown[]>;
};

export type RelationSourceInput = RelationSource | ObjectBackedRelationData;

export function asRelationSource(input: RelationSourceInput): RelationSource {
  return isRelationSource(input) ? input : fromObjectSource(input.data);
}

export function tryRelationSource(input: unknown): RelationSource | undefined {
  if (isRelationSource(input)) {
    return input;
  }

  if (isObjectBackedRelationData(input)) {
    return fromObjectSource(input.data);
  }

  return undefined;
}

export function isObjectBackedRelationData(input: unknown): input is ObjectBackedRelationData {
  const candidate = input as { readonly data?: unknown };
  return isRecord(input) && isRecord(candidate.data);
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === 'object' && input !== null && !Array.isArray(input);
}
