import { isRecord, stableKey } from './internal.js';
import type { TarstateDiagnostic } from './diagnostics.js';

export type RowChange<Row = unknown> =
  | { readonly kind: 'added'; readonly row: Row; readonly key: string }
  | { readonly kind: 'removed'; readonly row: Row; readonly key: string }
  | { readonly kind: 'updated'; readonly before: Row; readonly after: Row; readonly key: string };
export type RowKeySelector<Row = unknown> = (row: Row) => unknown;
export type RowDiffSide = 'before' | 'after';
export type RowDiffDiagnostic<Row = unknown> = TarstateDiagnostic & {
  readonly side?: RowDiffSide;
  readonly row?: Row;
};
export type RowDiffOptions<Row = unknown> = {
  readonly keyBy?: RowKeySelector<Row> | readonly string[];
};
export type RowDiff<Row = unknown> = {
  readonly changes: readonly RowChange<Row>[];
  readonly diagnostics: readonly RowDiffDiagnostic<Row>[];
};

export function diffRows<Row>(before: readonly Row[], after: readonly Row[], options: RowDiffOptions<Row> = {}): RowDiff<Row> {
  const diagnostics: RowDiffDiagnostic<Row>[] = [];
  const beforeMap = new Map<string, Row>();
  const afterMap = new Map<string, Row>();
  const duplicateBefore = new Set<string>();
  const duplicateAfter = new Set<string>();

  for (const rowValue of before) {
    const key = rowDiffKey(rowValue, options);
    if (beforeMap.has(key)) duplicateBefore.add(key);
    beforeMap.set(key, rowValue);
  }

  for (const rowValue of after) {
    const key = rowDiffKey(rowValue, options);
    if (afterMap.has(key)) duplicateAfter.add(key);
    afterMap.set(key, rowValue);
  }

  for (const key of duplicateBefore) {
    diagnostics.push({
      code: 'row_invalid',
      severity: 'warning',
      message: `duplicate before row diff key ${key}`,
      side: 'before',
      surface: 'diffRows'
    });
  }

  for (const key of duplicateAfter) {
    diagnostics.push({
      code: 'row_invalid',
      severity: 'warning',
      message: `duplicate after row diff key ${key}`,
      side: 'after',
      surface: 'diffRows'
    });
  }

  const changes: RowChange<Row>[] = [];
  const keys = new Set<string>([...beforeMap.keys(), ...afterMap.keys()]);

  for (const key of keys) {
    const beforeRow = beforeMap.get(key);
    const afterRow = afterMap.get(key);

    if (beforeRow === undefined && afterRow !== undefined) {
      changes.push({ kind: 'added', row: afterRow, key });
      continue;
    }

    if (beforeRow !== undefined && afterRow === undefined) {
      changes.push({ kind: 'removed', row: beforeRow, key });
      continue;
    }

    if (beforeRow !== undefined && afterRow !== undefined && stableKey(beforeRow) !== stableKey(afterRow)) {
      changes.push({ kind: 'updated', before: beforeRow, after: afterRow, key });
    }
  }

  return { changes, diagnostics };
}

export function rowDiffKey<Row>(row: Row, options: RowDiffOptions<Row> = {}): string {
  if (typeof options.keyBy === 'function') return stableKey(options.keyBy(row));
  if (Array.isArray(options.keyBy) && isRecord(row)) return stableKey(options.keyBy.map((fieldName) => row[fieldName]));
  return stableKey(row);
}
