import { comparePortableStrings } from '../../portable-order.js';
import type { QueryRecord } from '../model.js';
import type { ScopedRow } from './evaluation-context.js';
import {
  isOwnedQueryLogicalContainer,
  sealOwnedQueryLogicalContainer,
  sealOwnedQueryScope
} from './ownership.js';

export const visibleRow = (row: ScopedRow): QueryRecord => {
  const aliases = Object.keys(row.scope);
  if (aliases.length === 1) return row.scope[aliases[0] as string] as QueryRecord;
  return row.scope as unknown as QueryRecord;
};

export const resultKey = (row: ScopedRow): string => row.identity;

export const provenanceEntryIdentity = (alias: string, occurrence: string): string =>
  alias.length + ':' + alias + occurrence.length + ':' + occurrence;

export const queryRowIdentity = (provenance: ScopedRow['provenance']): string => {
  const aliases = Object.keys(provenance);
  if (aliases.length === 0) return '';
  if (aliases.length > 1) aliases.sort(comparePortableStrings);
  let identity = '';
  for (const alias of aliases) {
    identity += provenanceEntryIdentity(alias, provenance[alias]?.occurrence ?? '');
  }
  return identity;
};

export const scopedRow = (
  scope: ScopedRow['scope'],
  provenance: ScopedRow['provenance'],
  origin?: string
): ScopedRow => {
  for (const record of Object.values(scope)) {
    if (!isOwnedQueryLogicalContainer(record)) {
      sealOwnedQueryLogicalContainer(Object.freeze(record));
    }
  }
  return {
    scope: sealOwnedQueryScope(scope),
    provenance,
    identity: queryRowIdentity(provenance),
    origin
  };
};

export const replaceScopedAlias = (
  row: ScopedRow,
  alias: string,
  record: QueryRecord
): ScopedRow => {
  if (!isOwnedQueryLogicalContainer(record)) {
    sealOwnedQueryLogicalContainer(Object.freeze(record));
  }
  return {
    ...row,
    scope: sealOwnedQueryScope({ ...row.scope, [alias]: record }),
    origin: resultKey(row)
  };
};

export const rowsByResultKey = (
  rows: readonly ScopedRow[]
): Map<string, ScopedRow> => {
  const indexed = new Map<string, ScopedRow>();
  for (const row of rows) indexed.set(resultKey(row), row);
  return indexed;
};

export const resultKeyPositions = (
  rows: readonly ScopedRow[]
): Map<string, number> => {
  const indexed = new Map<string, number>();
  for (let index = 0; index < rows.length; index += 1) {
    indexed.set(resultKey(rows[index] as ScopedRow), index);
  }
  return indexed;
};

export const rowReferencePositions = (
  rows: readonly ScopedRow[]
): Map<ScopedRow, number> => {
  const indexed = new Map<ScopedRow, number>();
  for (let index = 0; index < rows.length; index += 1) {
    indexed.set(rows[index] as ScopedRow, index);
  }
  return indexed;
};

export type IndexedScopedRow = {
  readonly row: ScopedRow;
  readonly index: number;
};

export const indexedRowsByResultKey = (
  rows: readonly ScopedRow[]
): Map<string, IndexedScopedRow> => {
  const indexed = new Map<string, IndexedScopedRow>();
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index] as ScopedRow;
    indexed.set(resultKey(row), { row, index });
  }
  return indexed;
};
