import type { RowChange, RowDiff, RowDiffDiagnostic } from './diff.js';
import { stableKey } from './identity.js';

export type MaterializationRowDiffOptions = {
  readonly keyBy?: readonly string[];
};

export type MaterializationRowIndex<Row = unknown> = {
  readonly indexByKey: ReadonlyMap<string, number>;
  readonly duplicates: ReadonlySet<string>;
  readonly diagnostics: readonly RowDiffDiagnostic<Row>[];
};

export function diffMaterializationRows<Row>(
  before: readonly Row[],
  after: readonly Row[],
  options: MaterializationRowDiffOptions = {}
): RowDiff<Row> {
  const keyFor = materializationRowKeySelector(options);
  const beforeIndex = indexMaterializationRows(before, 'before', keyFor);
  const afterIndex = indexMaterializationRows(after, 'after', keyFor);
  const changes: RowChange<Row>[] = [];

  for (const row of before) {
    const key = keyFor(row);
    if (beforeIndex.duplicates.has(key) || !beforeIndex.rows.has(key)) {
      continue;
    }

    const afterRow = afterIndex.rows.get(key);
    if (afterRow === undefined) {
      changes.push({ kind: 'removed', key, row });
    } else if (materializationStableKey(row) !== materializationStableKey(afterRow)) {
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

export function materializationRowIndex<Row>(
  rows: readonly Row[],
  options: MaterializationRowDiffOptions = {}
): MaterializationRowIndex<Row> {
  const keyFor = materializationRowKeySelector(options);
  const indexByKey = new Map<string, number>();
  const duplicates = new Set<string>();
  const diagnostics: RowDiffDiagnostic<Row>[] = [];

  rows.forEach((row, index) => {
    let key: string;
    try {
      key = keyFor(row);
    } catch (error) {
      diagnostics.push({
        code: 'invalid_row',
        message: 'row key selection failed',
        side: 'after',
        row,
        ...(error === undefined ? {} : { key: materializationErrorMessage(error) })
      });
      return;
    }

    if (indexByKey.has(key)) {
      duplicates.add(key);
      indexByKey.delete(key);
      diagnostics.push({
        code: 'duplicate_key',
        message: 'duplicate after row key',
        side: 'after',
        key,
        row
      });
      return;
    }

    if (!duplicates.has(key)) {
      indexByKey.set(key, index);
    }
  });

  return { indexByKey, duplicates, diagnostics };
}

export function materializationRowKey<Row>(
  row: Row,
  options: MaterializationRowDiffOptions = {}
): string {
  return materializationRowKeySelector(options)(row);
}

export function materializationStableKey(value: unknown): string {
  return stableKey(materializationStableValue(value));
}

function materializationRowKeySelector<Row>(
  options: MaterializationRowDiffOptions
): (row: Row) => string {
  if (options.keyBy === undefined) {
    return (row) => materializationStableKey(row);
  }

  const fields = options.keyBy;
  return (row) => materializationStableKey(fields.map((field) => isRecord(row) ? row[field] : undefined));
}

function indexMaterializationRows<Row>(
  rows: readonly Row[],
  side: 'before' | 'after',
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
        ...(error === undefined ? {} : { key: materializationErrorMessage(error) })
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

function materializationStableValue(value: unknown): unknown {
  if (value instanceof Set) {
    return {
      $tarstate: 'set',
      values: Array.from(value, materializationStableValue)
    };
  }

  if (Array.isArray(value)) {
    return value.map(materializationStableValue);
  }

  if (!isRecord(value)) {
    return value;
  }

  return Object.fromEntries(Object.keys(value).sort().map((key) => [
    key,
    materializationStableValue(value[key])
  ]));
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === 'object' && input !== null;
}

function materializationErrorMessage(input: unknown): string {
  if (input instanceof Error) return input.message;
  return JSON.stringify(input) ?? 'unknown error';
}
