import { stableKey } from './identity.js';
import type { IncrementalRowBatch } from './materialization-plan.js';
import type {
  MaterializationDiagnostic,
  MaterializationNestedRows,
  MaterializationNestedUniqueRows
} from './materialization.js';

export type MaintainedIndexKind = 'hash' | 'btree' | 'unique';

export type MaintainedIndexDefinition = {
  readonly kind: MaintainedIndexKind;
  readonly fields: readonly [string, ...string[]];
};

export type MaintainedHashIndexState<Row = unknown> = {
  readonly kind: 'hash';
  readonly fields: readonly [string, ...string[]];
  readonly lookup: ReadonlyMap<unknown, MaterializationNestedRows<Row>>;
};

export type MaintainedBtreeIndexState<Row = unknown> = {
  readonly kind: 'btree';
  readonly fields: readonly [string, ...string[]];
  readonly lookup: ReadonlyMap<unknown, MaterializationNestedRows<Row>>;
  readonly ordered: readonly unknown[];
};

export type MaintainedUniqueIndexState<Row = unknown> = {
  readonly kind: 'unique';
  readonly fields: readonly [string, ...string[]];
  readonly lookup: ReadonlyMap<unknown, MaterializationNestedUniqueRows<Row>>;
  readonly diagnostics: readonly MaterializationDiagnostic[];
  readonly diagnosticsByTopKey: ReadonlyMap<unknown, readonly MaterializationDiagnostic[]>;
};

export type MaintainedIndexState<Row = unknown> =
  | MaintainedHashIndexState<Row>
  | MaintainedBtreeIndexState<Row>
  | MaintainedUniqueIndexState<Row>;

export type MaintainedIndexes<Row = unknown> = {
  readonly set: ReadonlySet<Row>;
  readonly byKey: ReadonlyMap<string, MaintainedIndexState<Row>>;
};

export function maintainedIndexKey(
  kind: MaintainedIndexKind,
  fields: readonly string[]
): string {
  return stableKey({ kind, fields });
}

export function buildMaintainedIndexes<Row>(
  rows: readonly Row[],
  definitions: readonly MaintainedIndexDefinition[]
): MaintainedIndexes<Row> {
  const byKey = new Map<string, MaintainedIndexState<Row>>();

  for (const definition of definitions) {
    const key = maintainedIndexKey(definition.kind, definition.fields);
    if (byKey.has(key)) {
      continue;
    }
    byKey.set(key, buildMaintainedIndex(rows, definition));
  }

  return {
    set: new Set(rows),
    byKey
  };
}

export function patchMaintainedIndexes<Row>(
  previous: MaintainedIndexes<Row>,
  rows: readonly Row[],
  rowBatches: readonly IncrementalRowBatch<Row>[]
): MaintainedIndexes<Row> {
  if (rowBatches.length === 0) {
    return previous;
  }

  const byKey = new Map<string, MaintainedIndexState<Row>>();
  for (const [key, state] of previous.byKey) {
    byKey.set(key, patchMaintainedIndex(state, rows, rowBatches));
  }

  return {
    set: new Set(rows),
    byKey
  };
}

function buildMaintainedIndex<Row>(
  rows: readonly Row[],
  definition: MaintainedIndexDefinition
): MaintainedIndexState<Row> {
  switch (definition.kind) {
    case 'hash':
      return {
        kind: 'hash',
        fields: definition.fields,
        lookup: buildRowsLookup(rows, definition.fields)
      };
    case 'btree': {
      const lookup = sortRowsLookup(buildRowsLookup(rows, definition.fields));
      return {
        kind: 'btree',
        fields: definition.fields,
        lookup,
        ordered: Array.from(lookup.keys()).sort(compareValues)
      };
    }
    case 'unique':
      return buildUniqueState(rows, definition.fields);
  }
}

function patchMaintainedIndex<Row>(
  state: MaintainedIndexState<Row>,
  rows: readonly Row[],
  rowBatches: readonly IncrementalRowBatch<Row>[]
): MaintainedIndexState<Row> {
  switch (state.kind) {
    case 'hash':
      return patchRowsIndex(state, rows, rowBatches);
    case 'btree':
      return patchBtreeIndex(state, rows, rowBatches);
    case 'unique':
      return patchUniqueIndex(state, rows, rowBatches);
  }
}

function patchRowsIndex<Row>(
  state: MaintainedHashIndexState<Row>,
  rows: readonly Row[],
  rowBatches: readonly IncrementalRowBatch<Row>[]
): MaintainedHashIndexState<Row> {
  const affected = affectedTopKeys(state.fields, rowBatches);
  if (affected.length === 0) {
    return state;
  }

  const lookup = new Map(state.lookup);
  for (const key of affected) {
    replaceRowsBranch(lookup, state.fields, rows, key, false);
  }

  return {
    ...state,
    lookup: orderRowsLookupByRows(lookup, state.fields, rows)
  };
}

function patchBtreeIndex<Row>(
  state: MaintainedBtreeIndexState<Row>,
  rows: readonly Row[],
  rowBatches: readonly IncrementalRowBatch<Row>[]
): MaintainedBtreeIndexState<Row> {
  const affected = affectedTopKeys(state.fields, rowBatches);
  if (affected.length === 0) {
    return state;
  }

  const lookup = new Map(state.lookup);
  for (const key of affected) {
    replaceRowsBranch(lookup, state.fields, rows, key, true);
  }

  const sorted = sortRowsLookup(lookup);
  return {
    ...state,
    lookup: sorted,
    ordered: Array.from(sorted.keys()).sort(compareValues)
  };
}

function patchUniqueIndex<Row>(
  state: MaintainedUniqueIndexState<Row>,
  rows: readonly Row[],
  rowBatches: readonly IncrementalRowBatch<Row>[]
): MaintainedUniqueIndexState<Row> {
  const affected = affectedTopKeys(state.fields, rowBatches);
  if (affected.length === 0) {
    return state;
  }

  const lookup = new Map(state.lookup);
  const diagnosticsByTopKey = new Map(state.diagnosticsByTopKey);
  for (const key of affected) {
    replaceUniqueBranch(lookup, diagnosticsByTopKey, state.fields, rows, key);
  }

  const orderedLookup = orderUniqueLookupByRows(lookup, state.fields, rows);
  return {
    ...state,
    lookup: orderedLookup,
    diagnosticsByTopKey,
    diagnostics: diagnosticsForUniqueLookup(orderedLookup, diagnosticsByTopKey)
  };
}

function buildRowsLookup<Row>(
  rows: readonly Row[],
  fields: readonly string[]
): ReadonlyMap<unknown, MaterializationNestedRows<Row>> {
  const lookup = new Map<unknown, MaterializationNestedRows<Row>>();
  for (const row of rows) {
    addRowToRowsLookup(lookup, fields, row);
  }
  return lookup;
}

function addRowToRowsLookup<Row>(
  lookup: Map<unknown, MaterializationNestedRows<Row>>,
  fields: readonly string[],
  row: Row
): void {
  if (fields.length === 0) {
    return;
  }

  let cursor = lookup;
  for (let index = 0; index < fields.length; index += 1) {
    const key = fieldValue(row, fields[index] as string);
    if (index === fields.length - 1) {
      const existing = cursor.get(key);
      const rows = existing instanceof Set ? existing : new Set<Row>();
      rows.add(row);
      cursor.set(key, rows);
      return;
    }

    const existing = cursor.get(key);
    const next = existing instanceof Map ? existing : new Map<unknown, MaterializationNestedRows<Row>>();
    cursor.set(key, next);
    cursor = next;
  }
}

function replaceRowsBranch<Row>(
  lookup: Map<unknown, MaterializationNestedRows<Row>>,
  fields: readonly string[],
  rows: readonly Row[],
  key: unknown,
  sorted: boolean
): void {
  const topRows = rowsForTopKey(rows, fields, key);
  if (topRows.length === 0) {
    lookup.delete(key);
    return;
  }

  if (fields.length === 1) {
    lookup.set(key, new Set(topRows));
    return;
  }

  const branch = buildRowsLookup(topRows, fields.slice(1));
  lookup.set(key, sorted ? sortRowsLookup(branch) : branch);
}

function buildUniqueState<Row>(
  rows: readonly Row[],
  fields: readonly [string, ...string[]]
): MaintainedUniqueIndexState<Row> {
  const lookup = new Map<unknown, MaterializationNestedUniqueRows<Row>>();
  const diagnosticsByTopKey = new Map<unknown, readonly MaterializationDiagnostic[]>();

  for (const key of topKeysForRows(rows, fields)) {
    replaceUniqueBranch(lookup, diagnosticsByTopKey, fields, rows, key);
  }

  return {
    kind: 'unique',
    fields,
    lookup,
    diagnosticsByTopKey,
    diagnostics: diagnosticsForUniqueLookup(lookup, diagnosticsByTopKey)
  };
}

function replaceUniqueBranch<Row>(
  lookup: Map<unknown, MaterializationNestedUniqueRows<Row>>,
  diagnosticsByTopKey: Map<unknown, readonly MaterializationDiagnostic[]>,
  fields: readonly string[],
  rows: readonly Row[],
  key: unknown
): void {
  const topRows = rowsForTopKey(rows, fields, key);
  if (topRows.length === 0) {
    lookup.delete(key);
    diagnosticsByTopKey.delete(key);
    return;
  }

  const diagnostics: MaterializationDiagnostic[] = [];
  if (fields.length === 1) {
    lookup.set(key, topRows[0] as Row);
    for (let index = 1; index < topRows.length; index += 1) {
      diagnostics.push(uniqueDuplicateDiagnostic(fields, key));
    }
  } else {
    const branch = new Map<unknown, MaterializationNestedUniqueRows<Row>>();
    for (const row of topRows) {
      addRowToUniqueLookup(branch, fields.slice(1), fields, row, diagnostics);
    }
    lookup.set(key, branch);
  }

  if (diagnostics.length === 0) {
    diagnosticsByTopKey.delete(key);
  } else {
    diagnosticsByTopKey.set(key, diagnostics);
  }
}

function addRowToUniqueLookup<Row>(
  lookup: Map<unknown, MaterializationNestedUniqueRows<Row>>,
  fields: readonly string[],
  fullFields: readonly string[],
  row: Row,
  diagnostics: MaterializationDiagnostic[]
): void {
  if (fields.length === 0) {
    return;
  }

  let cursor = lookup;
  for (let index = 0; index < fields.length; index += 1) {
    const key = fieldValue(row, fields[index] as string);
    if (index === fields.length - 1) {
      if (cursor.has(key)) {
        diagnostics.push(uniqueDuplicateDiagnostic(fullFields, key));
        return;
      }
      cursor.set(key, row);
      return;
    }

    const existing = cursor.get(key);
    const next = existing instanceof Map ? existing : new Map<unknown, MaterializationNestedUniqueRows<Row>>();
    cursor.set(key, next);
    cursor = next;
  }
}

function affectedTopKeys<Row>(
  fields: readonly string[],
  rowBatches: readonly IncrementalRowBatch<Row>[]
): readonly unknown[] {
  const field = fields[0];
  if (field === undefined) {
    return [];
  }

  const keys: unknown[] = [];
  for (const batch of rowBatches) {
    for (const row of [...batch.beforeRows, ...batch.afterRows]) {
      const key = fieldValue(row, field);
      if (!keys.some((candidate) => sameMapKey(candidate, key))) {
        keys.push(key);
      }
    }
  }
  return keys;
}

function rowsForTopKey<Row>(
  rows: readonly Row[],
  fields: readonly string[],
  key: unknown
): readonly Row[] {
  const field = fields[0];
  return field === undefined
    ? []
    : rows.filter((row) => sameMapKey(fieldValue(row, field), key));
}

function topKeysForRows<Row>(
  rows: readonly Row[],
  fields: readonly string[]
): readonly unknown[] {
  const field = fields[0];
  if (field === undefined) {
    return [];
  }

  const keys: unknown[] = [];
  for (const row of rows) {
    const key = fieldValue(row, field);
    if (!keys.some((candidate) => sameMapKey(candidate, key))) {
      keys.push(key);
    }
  }
  return keys;
}

function orderRowsLookupByRows<Row>(
  lookup: ReadonlyMap<unknown, MaterializationNestedRows<Row>>,
  fields: readonly string[],
  rows: readonly Row[]
): ReadonlyMap<unknown, MaterializationNestedRows<Row>> {
  const ordered = new Map<unknown, MaterializationNestedRows<Row>>();
  for (const key of topKeysForRows(rows, fields)) {
    const value = lookup.get(key);
    if (value !== undefined || lookup.has(key)) {
      ordered.set(key, value as MaterializationNestedRows<Row>);
    }
  }
  return ordered;
}

function orderUniqueLookupByRows<Row>(
  lookup: ReadonlyMap<unknown, MaterializationNestedUniqueRows<Row>>,
  fields: readonly string[],
  rows: readonly Row[]
): ReadonlyMap<unknown, MaterializationNestedUniqueRows<Row>> {
  const ordered = new Map<unknown, MaterializationNestedUniqueRows<Row>>();
  for (const key of topKeysForRows(rows, fields)) {
    const value = lookup.get(key);
    if (value !== undefined || lookup.has(key)) {
      ordered.set(key, value as MaterializationNestedUniqueRows<Row>);
    }
  }
  return ordered;
}

function diagnosticsForUniqueLookup<Row>(
  lookup: ReadonlyMap<unknown, MaterializationNestedUniqueRows<Row>>,
  diagnosticsByTopKey: ReadonlyMap<unknown, readonly MaterializationDiagnostic[]>
): readonly MaterializationDiagnostic[] {
  const diagnostics: MaterializationDiagnostic[] = [];
  for (const key of lookup.keys()) {
    diagnostics.push(...(diagnosticsByTopKey.get(key) ?? []));
  }
  return diagnostics;
}

function sortRowsLookup<Row>(
  lookup: ReadonlyMap<unknown, MaterializationNestedRows<Row>>
): ReadonlyMap<unknown, MaterializationNestedRows<Row>> {
  return new Map(
    Array.from(lookup.entries())
      .sort(([left], [right]) => compareValues(left, right))
      .map(([key, value]) => [
        key,
        value instanceof Map ? sortRowsLookup(value) : value
      ])
  );
}

function uniqueDuplicateDiagnostic(fields: readonly string[], key: unknown): MaterializationDiagnostic {
  return {
    code: 'materialization_index_unsupported',
    message: `unique materialization index has duplicate value for ${fields.join(',')}`,
    surface: 'materialization',
    detail: { fields, key }
  };
}

function fieldValue(row: unknown, field: string): unknown {
  return isRecord(row) ? row[field] : undefined;
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === 'object' && input !== null && !Array.isArray(input);
}

function sameMapKey(left: unknown, right: unknown): boolean {
  return left === right || (Number.isNaN(left) && Number.isNaN(right));
}

function compareValues(left: unknown, right: unknown): number {
  if (left === right) return 0;
  if (left === undefined || left === null) return -1;
  if (right === undefined || right === null) return 1;
  return left < right ? -1 : 1;
}
