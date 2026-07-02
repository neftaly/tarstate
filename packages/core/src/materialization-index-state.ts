import { stableKey } from './identity.js';
import type {
  MaterializationDiagnostic,
  MaterializationNestedRows,
  MaterializationNestedUniqueRows
} from './materialization.js';

export type MaintainedIndexKind = 'hash' | 'btree' | 'unique';

export type MaintainedIndexValueResult = {
  readonly value: unknown;
  readonly diagnostics?: readonly MaterializationDiagnostic[];
};

export type MaintainedIndexPart = {
  readonly label: string;
  readonly identity: string;
  readonly field?: string;
  readonly value: (row: unknown) => MaintainedIndexValueResult;
};

export type MaintainedIndexDefinition = {
  readonly kind: MaintainedIndexKind;
  readonly fields: readonly [string, ...string[]];
  readonly parts?: readonly [MaintainedIndexPart, ...MaintainedIndexPart[]];
  readonly diagnostics?: readonly MaterializationDiagnostic[];
};

export type MaintainedHashIndexState<Row = unknown> = {
  readonly kind: 'hash';
  readonly fields: readonly [string, ...string[]];
  readonly parts?: readonly [MaintainedIndexPart, ...MaintainedIndexPart[]];
  readonly definitionDiagnostics: readonly MaterializationDiagnostic[];
  readonly diagnostics: readonly MaterializationDiagnostic[];
  readonly lookup: ReadonlyMap<unknown, MaterializationNestedRows<Row>>;
};

export type MaintainedBtreeIndexState<Row = unknown> = {
  readonly kind: 'btree';
  readonly fields: readonly [string, ...string[]];
  readonly parts?: readonly [MaintainedIndexPart, ...MaintainedIndexPart[]];
  readonly definitionDiagnostics: readonly MaterializationDiagnostic[];
  readonly diagnostics: readonly MaterializationDiagnostic[];
  readonly lookup: ReadonlyMap<unknown, MaterializationNestedRows<Row>>;
  readonly ordered: readonly unknown[];
};

export type MaintainedUniqueIndexState<Row = unknown> = {
  readonly kind: 'unique';
  readonly fields: readonly [string, ...string[]];
  readonly parts?: readonly [MaintainedIndexPart, ...MaintainedIndexPart[]];
  readonly definitionDiagnostics: readonly MaterializationDiagnostic[];
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
  fields: readonly string[],
  expressionIdentities?: readonly string[]
): string {
  return expressionIdentities === undefined
    ? stableKey({ kind, fields })
    : stableKey({ kind, expressions: expressionIdentities });
}

function maintainedIndexDefinitionKey(definition: MaintainedIndexDefinition): string {
  return maintainedIndexKey(
    definition.kind,
    definition.fields,
    definition.parts?.map((part) => part.identity)
  );
}

export function buildMaintainedIndexes<Row>(
  rows: readonly Row[],
  definitions: readonly MaintainedIndexDefinition[]
): MaintainedIndexes<Row> {
  const byKey = new Map<string, MaintainedIndexState<Row>>();

  for (const definition of definitions) {
    const key = maintainedIndexDefinitionKey(definition);
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

function buildMaintainedIndex<Row>(
  rows: readonly Row[],
  definition: MaintainedIndexDefinition
): MaintainedIndexState<Row> {
  if (definition.parts !== undefined) {
    return buildExpressionMaintainedIndex(rows, {
      ...definition,
      parts: definition.parts
    });
  }

  switch (definition.kind) {
    case 'hash':
      return {
        kind: 'hash',
        fields: definition.fields,
        definitionDiagnostics: definition.diagnostics ?? [],
        diagnostics: definition.diagnostics ?? [],
        lookup: buildRowsLookup(rows, definition.fields)
      };
    case 'btree': {
      const lookup = sortRowsLookup(buildRowsLookup(rows, definition.fields));
      return {
        kind: 'btree',
        fields: definition.fields,
        definitionDiagnostics: definition.diagnostics ?? [],
        diagnostics: definition.diagnostics ?? [],
        lookup,
        ordered: Array.from(lookup.keys()).sort(compareValues)
      };
    }
    case 'unique':
      return buildUniqueState(rows, definition.fields);
  }
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
    definitionDiagnostics: [],
    lookup,
    diagnosticsByTopKey,
    diagnostics: diagnosticsForUniqueLookup(lookup, diagnosticsByTopKey)
  };
}

function buildExpressionMaintainedIndex<Row>(
  rows: readonly Row[],
  definition: MaintainedIndexDefinition & { readonly parts: readonly [MaintainedIndexPart, ...MaintainedIndexPart[]] }
): MaintainedIndexState<Row> {
  switch (definition.kind) {
    case 'hash': {
      const built = buildExpressionRowsLookup(rows, definition.parts);
      return {
        kind: 'hash',
        fields: definition.fields,
        parts: definition.parts,
        definitionDiagnostics: definition.diagnostics ?? [],
        diagnostics: [...(definition.diagnostics ?? []), ...built.diagnostics],
        lookup: built.lookup
      };
    }
    case 'btree': {
      const built = buildExpressionRowsLookup(rows, definition.parts);
      const lookup = sortRowsLookup(built.lookup);
      return {
        kind: 'btree',
        fields: definition.fields,
        parts: definition.parts,
        definitionDiagnostics: definition.diagnostics ?? [],
        diagnostics: [...(definition.diagnostics ?? []), ...built.diagnostics],
        lookup,
        ordered: Array.from(lookup.keys()).sort(compareValues)
      };
    }
    case 'unique': {
      const built = buildExpressionUniqueLookup(rows, definition.fields, definition.parts);
      return {
        kind: 'unique',
        fields: definition.fields,
        parts: definition.parts,
        definitionDiagnostics: definition.diagnostics ?? [],
        lookup: built.lookup,
        diagnosticsByTopKey: built.diagnosticsByTopKey,
        diagnostics: [
          ...(definition.diagnostics ?? []),
          ...diagnosticsForUniqueLookup(built.lookup, built.diagnosticsByTopKey)
        ]
      };
    }
  }
}

function buildExpressionRowsLookup<Row>(
  rows: readonly Row[],
  parts: readonly [MaintainedIndexPart, ...MaintainedIndexPart[]]
): {
  readonly lookup: ReadonlyMap<unknown, MaterializationNestedRows<Row>>;
  readonly diagnostics: readonly MaterializationDiagnostic[];
} {
  const lookup = new Map<unknown, MaterializationNestedRows<Row>>();
  const diagnostics: MaterializationDiagnostic[] = [];
  for (const row of rows) {
    const keyed = expressionKeyValues(row, parts);
    diagnostics.push(...keyed.diagnostics);
    addRowToRowsLookupByValues(lookup, keyed.values, row);
  }
  return { lookup, diagnostics };
}

function buildExpressionUniqueLookup<Row>(
  rows: readonly Row[],
  fields: readonly [string, ...string[]],
  parts: readonly [MaintainedIndexPart, ...MaintainedIndexPart[]]
): {
  readonly lookup: ReadonlyMap<unknown, MaterializationNestedUniqueRows<Row>>;
  readonly diagnosticsByTopKey: ReadonlyMap<unknown, readonly MaterializationDiagnostic[]>;
} {
  const lookup = new Map<unknown, MaterializationNestedUniqueRows<Row>>();
  const diagnosticsByTopKey = new Map<unknown, MaterializationDiagnostic[]>();

  for (const row of rows) {
    const keyed = expressionKeyValues(row, parts);
    if (keyed.diagnostics.length > 0) {
      const topKey = keyed.values[0];
      const diagnostics = diagnosticsByTopKey.get(topKey) ?? [];
      diagnostics.push(...keyed.diagnostics);
      diagnosticsByTopKey.set(topKey, diagnostics);
    }
    addRowToUniqueLookupByValues(lookup, fields, keyed.values, row, diagnosticsByTopKey);
  }

  return { lookup, diagnosticsByTopKey };
}

function expressionKeyValues(
  row: unknown,
  parts: readonly [MaintainedIndexPart, ...MaintainedIndexPart[]]
): {
  readonly values: readonly unknown[];
  readonly diagnostics: readonly MaterializationDiagnostic[];
} {
  const values: unknown[] = [];
  const diagnostics: MaterializationDiagnostic[] = [];

  for (const part of parts) {
    const result = part.value(row);
    values.push(result.value);
    diagnostics.push(...result.diagnostics ?? []);
  }

  return { values, diagnostics };
}

function addRowToRowsLookupByValues<Row>(
  lookup: Map<unknown, MaterializationNestedRows<Row>>,
  values: readonly unknown[],
  row: Row
): void {
  let cursor = lookup;
  for (let index = 0; index < values.length; index += 1) {
    const key = values[index];
    if (index === values.length - 1) {
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

function addRowToUniqueLookupByValues<Row>(
  lookup: Map<unknown, MaterializationNestedUniqueRows<Row>>,
  fields: readonly string[],
  values: readonly unknown[],
  row: Row,
  diagnosticsByTopKey: Map<unknown, MaterializationDiagnostic[]>
): void {
  let cursor = lookup;
  for (let index = 0; index < values.length; index += 1) {
    const key = values[index];
    if (index === values.length - 1) {
      if (cursor.has(key)) {
        const topKey = values[0];
        const diagnostics = diagnosticsByTopKey.get(topKey) ?? [];
        diagnostics.push(uniqueDuplicateDiagnostic(fields, key));
        diagnosticsByTopKey.set(topKey, diagnostics);
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
