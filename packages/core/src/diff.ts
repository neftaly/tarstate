import { stableKey, stableValue } from './identity.js';

export type RowChange<Row = unknown> =
  | {
      readonly op: 'insert';
      readonly key: string;
      readonly after: Row;
    }
  | {
      readonly op: 'delete';
      readonly key: string;
      readonly before: Row;
    }
  | {
      readonly op: 'update';
      readonly key: string;
      readonly before: Row;
      readonly after: Row;
    };

export type RowKeySelector<Row = unknown> = (row: Row) => unknown;
export type RowDiffSide = 'before' | 'after';
export type RowDiffDiagnostic<Row = unknown> = {
  readonly code: 'row_key_missing' | 'row_key_duplicate';
  readonly message: string;
  readonly surface: 'diff';
  readonly side: RowDiffSide;
  readonly key?: string;
  readonly field?: string;
  readonly detail?: {
    readonly row?: Row;
    readonly rows?: readonly Row[];
    readonly count?: number;
    readonly reason?: 'missing' | 'undefined' | 'invalid_row' | 'undefined_key';
    readonly keyFields?: readonly string[];
  };
};

export type RowDiffOptions<Row = unknown> = {
  readonly rowKey?: RowKeySelector<Row>;
  readonly keyFields?: readonly string[];
};

type RowChangeDiff<Row> = {
  readonly rowChanges: readonly RowChange<Row>[];
  readonly diagnostics: readonly RowDiffDiagnostic<Row>[];
};
type StructuralRowSets<Row> = Pick<RowDiff<Row>, 'addedRows' | 'removedRows' | 'unchangedRows'>;
type StructuralRowDiff<Row> = Pick<RowDiff<Row>, 'addedRows' | 'removedRows' | 'unchangedRows' | 'rowChanges'>;
type RowKeyResult =
  | {
      readonly kind: 'valid';
      readonly key: string;
    }
  | {
      readonly kind: 'missing';
      readonly field?: string;
      readonly reason: 'missing' | 'undefined' | 'invalid_row' | 'undefined_key';
    };
type KeyedRowEntry<Row> = {
  readonly row: Row;
  readonly key: RowKeyResult;
};
type RowChangeKeyer<Row> =
  | {
      readonly kind: 'structural';
    }
  | {
      readonly kind: 'rowKey';
      readonly keyForRow: (row: Row) => RowKeyResult;
    }
  | {
      readonly kind: 'fields';
      readonly keyFields: readonly string[];
      readonly keyForRow: (row: Row) => RowKeyResult;
    };

export type RowDiff<Row = unknown> = {
  readonly addedRows: readonly Row[];
  readonly removedRows: readonly Row[];
  readonly unchangedRows: readonly Row[];
  readonly rowChanges: readonly RowChange<Row>[];
  readonly rowChangeDiagnostics?: readonly RowDiffDiagnostic<Row>[];
};

export function diffRows<Row>(
  beforeRows: readonly Row[],
  afterRows: readonly Row[],
  options: RowDiffOptions<Row> = {}
): RowDiff<Row> {
  const keyForRow = rowChangeKey(options);

  if (keyForRow.kind === 'structural') {
    return diffRowsStructurally(beforeRows, afterRows, true);
  }

  const structuralDiff = diffRowsStructurally(beforeRows, afterRows);
  const rowChangeDiff = diffKeyedRowChanges(beforeRows, afterRows, keyForRow);

  return {
    ...structuralDiff,
    rowChanges: rowChangeDiff.rowChanges,
    ...(rowChangeDiff.diagnostics.length === 0 ? {} : { rowChangeDiagnostics: rowChangeDiff.diagnostics })
  };
}

function diffRowsStructurally<Row>(
  beforeRows: readonly Row[],
  afterRows: readonly Row[],
  includeRowChanges: true
): StructuralRowDiff<Row>;
function diffRowsStructurally<Row>(
  beforeRows: readonly Row[],
  afterRows: readonly Row[],
  includeRowChanges?: false
): StructuralRowSets<Row>;
function diffRowsStructurally<Row>(
  beforeRows: readonly Row[],
  afterRows: readonly Row[],
  includeRowChanges = false
): StructuralRowSets<Row> | StructuralRowDiff<Row> {
  const beforeBuckets = new Map<string, { readonly rows: Row[]; next: number }>();
  const addedRows: Row[] = [];
  const unchangedRows: Row[] = [];
  const rowChanges: RowChange<Row>[] | undefined = includeRowChanges ? [] : undefined;

  for (const row of beforeRows) {
    const key = stableRowKey(row);
    const bucket = beforeBuckets.get(key);

    if (bucket === undefined) {
      beforeBuckets.set(key, { rows: [row], next: 0 });
    } else {
      bucket.rows.push(row);
    }
  }

  for (const row of afterRows) {
    const key = stableRowKey(row);
    const bucket = beforeBuckets.get(key);

    if (bucket !== undefined && bucket.next < bucket.rows.length) {
      unchangedRows.push(bucket.rows[bucket.next] as Row);
      bucket.next += 1;
    } else {
      addedRows.push(row);
      rowChanges?.push({ op: 'insert', key, after: row });
    }
  }

  const removedRows: Row[] = [];

  for (const [key, bucket] of beforeBuckets) {
    for (const row of bucket.rows.slice(bucket.next)) {
      removedRows.push(row);
      rowChanges?.push({ op: 'delete', key, before: row });
    }
  }

  return rowChanges === undefined
    ? { addedRows, removedRows, unchangedRows }
    : { addedRows, removedRows, unchangedRows, rowChanges };
}

function diffKeyedRowChanges<Row>(
  beforeRows: readonly Row[],
  afterRows: readonly Row[],
  keyForRow: Exclude<RowChangeKeyer<Row>, { readonly kind: 'structural' }>
): RowChangeDiff<Row> {
  const beforeEntries = beforeRows.map((row): KeyedRowEntry<Row> => ({ row, key: keyForRow.keyForRow(row) }));
  const afterEntries = afterRows.map((row): KeyedRowEntry<Row> => ({ row, key: keyForRow.keyForRow(row) }));
  const duplicateKeys = new Set<string>();
  const diagnostics = [
    ...missingKeyDiagnostics(beforeEntries, 'before', keyForRow),
    ...missingKeyDiagnostics(afterEntries, 'after', keyForRow),
    ...duplicateKeyDiagnostics(beforeEntries, 'before', keyForRow, duplicateKeys),
    ...duplicateKeyDiagnostics(afterEntries, 'after', keyForRow, duplicateKeys)
  ];
  const beforeByKey = uniqueRowsByKey(beforeEntries, duplicateKeys);
  const afterByKey = uniqueRowsByKey(afterEntries, duplicateKeys);
  const fallbackBeforeRows = beforeEntries.filter((entry) => !hasUsableKey(entry, duplicateKeys)).map((entry) => entry.row);
  const fallbackAfterRows = afterEntries.filter((entry) => !hasUsableKey(entry, duplicateKeys)).map((entry) => entry.row);
  const fallbackDiff = diffRowsStructurally(fallbackBeforeRows, fallbackAfterRows);
  const fallbackAddedRows = rowCounts(fallbackDiff.addedRows);
  const fallbackRemovedRows = rowCounts(fallbackDiff.removedRows);
  const rowChanges: RowChange<Row>[] = [];

  for (const entry of afterEntries) {
    if (hasUsableKey(entry, duplicateKeys)) {
      const before = beforeByKey.get(entry.key.key);

      if (before !== undefined) {
        if (stableRowKey(before.row) !== stableRowKey(entry.row)) {
          rowChanges.push({ op: 'update', key: entry.key.key, before: before.row, after: entry.row });
        }
      } else {
        rowChanges.push({ op: 'insert', key: entry.key.key, after: entry.row });
      }
    } else if (consumeRow(fallbackAddedRows, entry.row)) {
      rowChanges.push({ op: 'insert', key: stableRowKey(entry.row), after: entry.row });
    }
  }

  for (const entry of beforeEntries) {
    if (hasUsableKey(entry, duplicateKeys)) {
      if (!afterByKey.has(entry.key.key)) {
        rowChanges.push({ op: 'delete', key: entry.key.key, before: entry.row });
      }
    } else if (consumeRow(fallbackRemovedRows, entry.row)) {
      rowChanges.push({ op: 'delete', key: stableRowKey(entry.row), before: entry.row });
    }
  }

  return { rowChanges, diagnostics };
}

function rowChangeKey<Row>(options: RowDiffOptions<Row>): RowChangeKeyer<Row> {
  if (options.rowKey !== undefined) {
    const rowKey = options.rowKey;
    return {
      kind: 'rowKey',
      keyForRow: (row) => {
        const key = rowKey(row);
        return key === undefined ? { kind: 'missing', reason: 'undefined_key' } : { kind: 'valid', key: stableRowKey(key) };
      }
    };
  }

  if (options.keyFields !== undefined) {
    const keyFields = options.keyFields;
    return {
      kind: 'fields',
      keyFields,
      keyForRow: (row) => fieldKey(row, keyFields)
    };
  }

  return { kind: 'structural' };
}

function fieldKey(row: unknown, fields: readonly string[]): RowKeyResult {
  if (!isRecord(row)) {
    return { kind: 'missing', reason: 'invalid_row' };
  }

  for (const field of fields) {
    if (!(field in row)) {
      return { kind: 'missing', field, reason: 'missing' };
    }

    if (row[field] === undefined) {
      return { kind: 'missing', field, reason: 'undefined' };
    }
  }

  if (fields.length === 1) {
    return { kind: 'valid', key: stableRowKey(row[fields[0] as string]) };
  }

  return { kind: 'valid', key: stableRowKey(Object.fromEntries(fields.map((field) => [field, row[field]]))) };
}

function missingKeyDiagnostics<Row>(
  entries: readonly KeyedRowEntry<Row>[],
  side: RowDiffSide,
  keyForRow: Exclude<RowChangeKeyer<Row>, { readonly kind: 'structural' }>
): RowDiffDiagnostic<Row>[] {
  const keyFields = keyForRow.kind === 'fields' ? keyForRow.keyFields : undefined;

  return entries.flatMap((entry) => {
    if (entry.key.kind !== 'missing') {
      return [];
    }

    return [
      {
        code: 'row_key_missing',
        message: missingKeyMessage(side, entry.key),
        surface: 'diff',
        side,
        ...(entry.key.field === undefined ? {} : { field: entry.key.field }),
        detail: {
          row: entry.row,
          reason: entry.key.reason,
          ...(keyFields === undefined ? {} : { keyFields })
        }
      }
    ];
  });
}

function duplicateKeyDiagnostics<Row>(
  entries: readonly KeyedRowEntry<Row>[],
  side: RowDiffSide,
  keyForRow: Exclude<RowChangeKeyer<Row>, { readonly kind: 'structural' }>,
  duplicateKeys: Set<string>
): RowDiffDiagnostic<Row>[] {
  const keyFields = keyForRow.kind === 'fields' ? keyForRow.keyFields : undefined;
  const buckets = new Map<string, Row[]>();

  for (const entry of entries) {
    if (entry.key.kind !== 'valid') {
      continue;
    }

    const rows = buckets.get(entry.key.key);

    if (rows === undefined) {
      buckets.set(entry.key.key, [entry.row]);
    } else {
      rows.push(entry.row);
    }
  }

  const diagnostics: RowDiffDiagnostic<Row>[] = [];

  for (const [key, rows] of buckets) {
    if (rows.length <= 1) {
      continue;
    }

    duplicateKeys.add(key);
    diagnostics.push({
      code: 'row_key_duplicate',
      message: `${side} row change key ${key} is duplicated`,
      surface: 'diff',
      side,
      key,
      detail: {
        rows,
        count: rows.length,
        ...(keyFields === undefined ? {} : { keyFields })
      }
    });
  }

  return diagnostics;
}

function missingKeyMessage(side: RowDiffSide, key: Extract<RowKeyResult, { readonly kind: 'missing' }>): string {
  if (key.field !== undefined) {
    return `${side} row change key field ${key.field} is ${key.reason === 'missing' ? 'missing' : 'undefined'}`;
  }

  return key.reason === 'invalid_row'
    ? `${side} row change key cannot be read from a non-object row`
    : `${side} row change key is undefined`;
}

function uniqueRowsByKey<Row>(
  entries: readonly KeyedRowEntry<Row>[],
  duplicateKeys: ReadonlySet<string>
): Map<string, { readonly row: Row }> {
  const rowsByKey = new Map<string, { readonly row: Row }>();

  for (const entry of entries) {
    if (hasUsableKey(entry, duplicateKeys)) {
      rowsByKey.set(entry.key.key, { row: entry.row });
    }
  }

  return rowsByKey;
}

function hasUsableKey<Row>(
  entry: KeyedRowEntry<Row>,
  duplicateKeys: ReadonlySet<string>
): entry is KeyedRowEntry<Row> & { readonly key: Extract<RowKeyResult, { readonly kind: 'valid' }> } {
  return entry.key.kind === 'valid' && !duplicateKeys.has(entry.key.key);
}

function rowCounts<Row>(rows: readonly Row[]): Map<string, number> {
  const counts = new Map<string, number>();

  for (const row of rows) {
    const key = stableRowKey(row);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  return counts;
}

function consumeRow<Row>(counts: Map<string, number>, row: Row): boolean {
  const key = stableRowKey(row);
  const count = counts.get(key) ?? 0;

  if (count <= 0) {
    return false;
  }

  if (count === 1) {
    counts.delete(key);
  } else {
    counts.set(key, count - 1);
  }

  return true;
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === 'object' && input !== null && !Array.isArray(input);
}

export { stableValue };
export const stableRowKey = stableKey;
