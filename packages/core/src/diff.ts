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
  _before: readonly Row[],
  _after: readonly Row[],
  _options: RowDiffOptions<Row> = {}
): RowDiff<Row> {
  return {
    changes: [],
    diagnostics: []
  };
}

export { stableValue };
export const stableRowKey = stableKey;
