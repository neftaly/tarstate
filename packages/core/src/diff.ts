import { stableKey, stableValue } from './identity.js';

export type RowChange<Row = unknown> =
  | { readonly kind: 'added'; readonly row: Row; readonly key: string }
  | { readonly kind: 'removed'; readonly row: Row; readonly key: string }
  | { readonly kind: 'updated'; readonly before: Row; readonly after: Row; readonly key: string };

export type RowKeySelector<Row = unknown> = (row: Row) => unknown;
export type RowDiffSide = 'before' | 'after';
export type RowDiffDiagnostic<Row = unknown> = {
  readonly code: 'duplicate_key' | 'invalid_row';
  readonly message: string;
  readonly side: RowDiffSide;
  readonly key?: string;
  readonly row?: Row;
};

export type RowDiffOptions<Row = unknown> = {
  readonly keyBy?: RowKeySelector<Row> | readonly string[];
};

export type RowDiff<Row = unknown> = {
  readonly changes: readonly RowChange<Row>[];
  readonly diagnostics: readonly RowDiffDiagnostic<Row>[];
};

export function diffRows<Row>(
  before: readonly Row[],
  after: readonly Row[],
  options: RowDiffOptions<Row> = {}
): RowDiff<Row> {
  const keyFor = rowKeySelector(options);
  const beforeIndex = indexRows(before, 'before', keyFor);
  const afterIndex = indexRows(after, 'after', keyFor);
  const changes: RowChange<Row>[] = [];

  for (const row of before) {
    const key = keyFor(row);
    if (beforeIndex.duplicates.has(key) || !beforeIndex.rows.has(key)) {
      continue;
    }

    const afterRow = afterIndex.rows.get(key);
    if (afterRow === undefined) {
      changes.push({ kind: 'removed', key, row });
    } else if (stableKey(row) !== stableKey(afterRow)) {
      changes.push({ kind: 'updated', key, before: row, after: afterRow });
    }
  }

  for (const row of after) {
    const key = keyFor(row);
    if (afterIndex.duplicates.has(key) || !afterIndex.rows.has(key) || beforeIndex.rows.has(key)) {
      continue;
    }

    changes.push({ kind: 'added', key, row });
  }

  return {
    changes,
    diagnostics: [...beforeIndex.diagnostics, ...afterIndex.diagnostics]
  };
}

export { stableValue };
export const stableRowKey = stableKey;

export function rowDiffKey<Row>(row: Row, options: RowDiffOptions<Row> = {}): string {
  return rowKeySelector(options)(row);
}

function rowKeySelector<Row>(options: RowDiffOptions<Row>): (row: Row) => string {
  if (typeof options.keyBy === 'function') {
    const selector = options.keyBy;
    return (row) => stableKey(selector(row));
  }

  if (Array.isArray(options.keyBy)) {
    const fields = options.keyBy;
    return (row) => stableKey(fields.map((field) => isRecord(row) ? row[field] : undefined));
  }

  return (row) => stableKey(row);
}

function indexRows<Row>(
  rows: readonly Row[],
  side: RowDiffSide,
  keyFor: (row: Row) => string
): {
  readonly rows: ReadonlyMap<string, Row>;
  readonly duplicates: ReadonlySet<string>;
  readonly diagnostics: readonly RowDiffDiagnostic<Row>[];
} {
  const indexed = new Map<string, Row>();
  const duplicates = new Set<string>();
  const diagnostics: RowDiffDiagnostic<Row>[] = [];

  for (const row of rows) {
    let key: string;
    try {
      key = keyFor(row);
    } catch (error) {
      diagnostics.push({
        code: 'invalid_row',
        message: 'row key selection failed',
        side,
        row,
        ...(error === undefined ? {} : { key: errorMessage(error) })
      });
      continue;
    }

    if (indexed.has(key)) {
      duplicates.add(key);
      indexed.delete(key);
      diagnostics.push({
        code: 'duplicate_key',
        message: `duplicate ${side} row key`,
        side,
        key,
        row
      });
      continue;
    }

    if (!duplicates.has(key)) {
      indexed.set(key, row);
    }
  }

  return { rows: indexed, duplicates, diagnostics };
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === 'object' && input !== null;
}

function errorMessage(input: unknown): string {
  if (input instanceof Error) return input.message;
  return JSON.stringify(input) ?? 'unknown error';
}
