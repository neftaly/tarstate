import { dbSource, type Db } from './db.js';
import { isRelationSource, type RelationSource } from './source.js';

export type RelationSourceInput = RelationSource | Db;

export function asRelationSource(input: RelationSourceInput): RelationSource {
  return isRelationSource(input) ? input : dbSource(input);
}

export function tryRelationSource(input: unknown): RelationSource | undefined {
  return isRelationSource(input) ? input : isDbLike(input) ? dbSource(input as Db) : undefined;
}

function isDbLike(input: unknown): input is Db {
  return typeof input === 'object' && input !== null && 'data' in input && 'env' in input;
}
