import type { RelationKeyValue } from '@tarstate/core/db';
import { from, lookup as lookupQuery } from '@tarstate/core/query';
import type { Query } from '@tarstate/core/query';
import type { RelationRef } from '@tarstate/core/schema';
import { isPlainRecord } from './equality.js';
import type { RelationRow } from './types.js';

export function isRelationRef(input: unknown): input is RelationRef {
  return typeof input === 'object'
    && input !== null
    && 'kind' in input
    && input.kind === 'relation';
}

export function relationKeyQuery<Relation extends RelationRef>(
  relation: Relation,
  key: RelationKeyValue<Relation>
): Query<RelationRow<Relation>> {
  return typeof relation.key === 'string' && isQueryKeyValue(key)
    ? lookupQuery(
      relation as RelationRef<Record<string, unknown>, string>,
      relation.key,
      key
    ) as Query<RelationRow<Relation>>
    : from(relation) as Query<RelationRow<Relation>>;
}

export function relationKeyMatches<Row>(relation: RelationRef, row: Row, key: unknown): boolean {
  if (typeof row !== 'object' || row === null) return false;
  const rowRecord = row as Record<string, unknown>;
  const relationKey = relation.key;

  if (typeof relationKey !== 'string') {
    return Array.isArray(key)
      && relationKey.length === key.length
      && relationKey.every((fieldName, index) => Object.is(rowRecord[fieldName], key[index]));
  }

  return Object.is(rowRecord[relationKey], key);
}

function isQueryKeyValue(input: unknown): boolean {
  if (input === undefined || input === null || typeof input === 'string' || typeof input === 'boolean') return true;
  if (typeof input === 'number') return Number.isFinite(input);
  if (typeof input === 'function' || typeof input === 'bigint' || typeof input === 'symbol') return false;
  if (Array.isArray(input)) return input.every(isQueryKeyValue);
  if (!isPlainRecord(input)) return false;
  return Object.values(input).every(isQueryKeyValue);
}
