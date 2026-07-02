import type { RelationDelta } from './adapter.js';
import type { TarstateDiagnostic } from './diagnostics.js';
import { diffRows, rowDiffKey, type RowChange, type RowDiffDiagnostic, type RowDiffOptions, type RowKeySelector } from './diff.js';
import { evaluate, type EvaluateOptions } from './evaluate.js';
import { stableKey } from './identity.js';
import { queryKey, queryRowKeyFields, type Query } from './query.js';
import type { RelationSource } from './source.js';

export type DerivationTarget<Row = unknown> = {
  readonly kind: 'query';
  readonly id?: string;
  readonly query: Query<Row>;
  readonly identity?: DerivationRowIdentityInput<Row>;
  readonly indexes?: readonly DerivationIndexDefinition<Row>[];
};

export type DerivationInput = {
  readonly source: RelationSource;
  readonly deltas?: readonly RelationDelta[];
  readonly version?: unknown;
};

export type DerivationRowIdentityInput<Row = unknown> =
  | 'structural'
  | RowKeySelector<Row>
  | readonly [string, ...string[]];

export type DerivationRowIdentity<Row = unknown> =
  | { readonly kind: 'structural' }
  | { readonly kind: 'fields'; readonly fields: readonly [string, ...string[]] }
  | { readonly kind: 'selector'; readonly keyFor: RowKeySelector<Row> };

export type DerivationIndexKind = 'hash' | 'btree' | 'unique';

export type DerivationIndexDefinition<Row = unknown> = {
  readonly id?: string;
  readonly kind: DerivationIndexKind;
  readonly fields: readonly [string, ...string[]];
  readonly keyFor?: RowKeySelector<Row>;
};

export type DerivationIndexState<Row = unknown> =
  | {
      readonly kind: 'hash';
      readonly id: string;
      readonly definition: DerivationIndexDefinition<Row>;
      readonly lookup: ReadonlyMap<string, readonly Row[]>;
      readonly diagnostics: readonly DerivationIndexDiagnostic<Row>[];
    }
  | {
      readonly kind: 'btree';
      readonly id: string;
      readonly definition: DerivationIndexDefinition<Row>;
      readonly lookup: ReadonlyMap<string, readonly Row[]>;
      readonly orderedKeys: readonly string[];
      readonly diagnostics: readonly DerivationIndexDiagnostic<Row>[];
    }
  | {
      readonly kind: 'unique';
      readonly id: string;
      readonly definition: DerivationIndexDefinition<Row>;
      readonly lookup: ReadonlyMap<string, Row>;
      readonly diagnostics: readonly DerivationIndexDiagnostic<Row>[];
    };

export type DerivationIndexDiagnostic<Row = unknown> = TarstateDiagnostic & {
  readonly code: 'derivation_index_duplicate_key' | 'derivation_index_invalid_row';
  readonly detail?: {
    readonly index: string;
    readonly row?: Row;
    readonly error?: unknown;
  };
};

export type DerivedRowsDelta<Row = unknown> = {
  readonly kind: 'derivedRows';
  readonly inputDeltas: readonly RelationDelta[];
  readonly rowChanges: readonly RowChange<Row>[];
  readonly addedRows: readonly Row[];
  readonly removedRows: readonly Row[];
  readonly updatedRows: readonly { readonly before: Row; readonly after: Row }[];
  readonly diagnostics: readonly RowDiffDiagnostic<Row>[];
};

export type DerivationSnapshot<Row = unknown> = {
  readonly kind: 'derivationSnapshot';
  readonly target: DerivationTarget<Row>;
  readonly targetKey: string;
  readonly rowIdentity: DerivationRowIdentity<Row>;
  readonly rows: readonly Row[];
  readonly rowsByKey: ReadonlyMap<string, Row>;
  readonly indexes: ReadonlyMap<string, DerivationIndexState<Row>>;
  readonly diagnostics: readonly DerivationDiagnostic<Row>[];
  readonly version?: unknown;
};

export type DerivationRefresh<Row = unknown> = {
  readonly kind: 'derivationRefresh';
  readonly previous: DerivationSnapshot<Row>;
  readonly snapshot: DerivationSnapshot<Row>;
  readonly delta: DerivedRowsDelta<Row>;
  readonly changed: boolean;
  readonly diagnostics: readonly DerivationDiagnostic<Row>[];
};

export type DerivationDiagnostic<Row = unknown> =
  | TarstateDiagnostic
  | RowDiffDiagnostic<Row>
  | DerivationIndexDiagnostic<Row>;

export type DerivationOptions = EvaluateOptions;
export type DerivedRowsSnapshotOptions<Row = unknown> = {
  readonly diagnostics?: readonly DerivationDiagnostic<Row>[];
  readonly version?: unknown;
};
export type DerivedRowsRefreshOptions<Row = unknown> = DerivedRowsSnapshotOptions<Row> & {
  readonly inputDeltas?: readonly RelationDelta[];
};

export async function deriveSnapshot<Row>(
  target: DerivationTarget<Row>,
  input: DerivationInput,
  options: DerivationOptions = {}
): Promise<DerivationSnapshot<Row>> {
  const result = await evaluate(input.source, target.query, options);
  return deriveSnapshotFromRows(target, result.rows, {
    diagnostics: result.diagnostics,
    version: input.version
  });
}

export function deriveSnapshotFromRows<Row>(
  target: DerivationTarget<Row>,
  rows: readonly Row[],
  options: DerivedRowsSnapshotOptions<Row> = {}
): DerivationSnapshot<Row> {
  const rowIdentity = rowIdentityForTarget(target);
  const rowsByKey = indexSnapshotRows(rows, rowIdentity);
  const indexes = buildDerivationIndexes(rows, target.indexes ?? []);
  const indexDiagnostics = Array.from(indexes.values()).flatMap((index) => index.diagnostics);

  return snapshotValue(target, {
    rowIdentity,
    rows,
    rowsByKey,
    indexes,
    diagnostics: [...(options.diagnostics ?? []), ...indexDiagnostics],
    version: options.version
  });
}

export async function refreshDerivedSnapshot<Row>(
  previous: DerivationSnapshot<Row>,
  input: DerivationInput,
  options: DerivationOptions = {}
): Promise<DerivationRefresh<Row>> {
  const snapshot = await deriveSnapshot(previous.target, input, options);
  return refreshValue(previous, snapshot, input.deltas ?? []);
}

export function refreshDerivedSnapshotFromRows<Row>(
  previous: DerivationSnapshot<Row>,
  rows: readonly Row[],
  options: DerivedRowsRefreshOptions<Row> = {}
): DerivationRefresh<Row> {
  const snapshot = deriveSnapshotFromRows(previous.target, rows, {
    ...(options.diagnostics === undefined ? {} : { diagnostics: options.diagnostics }),
    ...(options.version === undefined ? {} : { version: options.version })
  });
  return refreshValue(previous, snapshot, options.inputDeltas ?? []);
}

function refreshValue<Row>(
  previous: DerivationSnapshot<Row>,
  snapshot: DerivationSnapshot<Row>,
  inputDeltas: readonly RelationDelta[]
): DerivationRefresh<Row> {
  const diff = diffRows(previous.rows, snapshot.rows, diffOptionsForIdentity(snapshot.rowIdentity));
  const delta: DerivedRowsDelta<Row> = {
    kind: 'derivedRows',
    inputDeltas,
    rowChanges: diff.changes,
    addedRows: diff.changes.flatMap((change) => change.kind === 'added' ? [change.row] : []),
    removedRows: diff.changes.flatMap((change) => change.kind === 'removed' ? [change.row] : []),
    updatedRows: diff.changes.flatMap((change) =>
      change.kind === 'updated' ? [{ before: change.before, after: change.after }] : []
    ),
    diagnostics: diff.diagnostics
  };
  const diagnostics = [...snapshot.diagnostics, ...diff.diagnostics];

  return {
    kind: 'derivationRefresh',
    previous,
    snapshot: {
      ...snapshot,
      diagnostics
    },
    delta,
    changed: diff.changes.length > 0,
    diagnostics
  };
}

export function derivationTargetKey<Row>(target: DerivationTarget<Row>): string {
  return target.id ?? queryKey(target.query);
}

export function rowKeyForSnapshot<Row>(snapshot: DerivationSnapshot<Row>, row: Row): string {
  return rowDiffKey(row, diffOptionsForIdentity(snapshot.rowIdentity));
}

export function rowsForDerivationIndex<Row>(
  snapshot: DerivationSnapshot<Row>,
  indexId: string,
  values: readonly unknown[]
): readonly Row[] | undefined {
  const index = snapshot.indexes.get(indexId);
  if (index === undefined) {
    return undefined;
  }

  const key = stableKey(values);
  if (index.kind === 'unique') {
    const row = index.lookup.get(key);
    return row === undefined ? undefined : [row];
  }

  return index.lookup.get(key);
}

function rowIdentityForTarget<Row>(target: DerivationTarget<Row>): DerivationRowIdentity<Row> {
  if (target.identity === 'structural') {
    return { kind: 'structural' };
  }

  if (typeof target.identity === 'function') {
    return { kind: 'selector', keyFor: target.identity };
  }

  if (Array.isArray(target.identity)) {
    return { kind: 'fields', fields: target.identity };
  }

  const queryFields = queryRowKeyFields(target.query);
  if (isNonEmptyFields(queryFields)) {
    return { kind: 'fields', fields: queryFields };
  }

  return { kind: 'structural' };
}

function diffOptionsForIdentity<Row>(identity: DerivationRowIdentity<Row>): RowDiffOptions<Row> {
  switch (identity.kind) {
    case 'fields':
      return { keyBy: identity.fields };
    case 'selector':
      return { keyBy: identity.keyFor };
    case 'structural':
      return {};
  }
}

function indexSnapshotRows<Row>(
  rows: readonly Row[],
  identity: DerivationRowIdentity<Row>
): ReadonlyMap<string, Row> {
  const output = new Map<string, Row>();
  const options = diffOptionsForIdentity(identity);

  for (const row of rows) {
    const key = rowDiffKey(row, options);
    if (!output.has(key)) {
      output.set(key, row);
    }
  }

  return output;
}

function buildDerivationIndexes<Row>(
  rows: readonly Row[],
  definitions: readonly DerivationIndexDefinition<Row>[]
): ReadonlyMap<string, DerivationIndexState<Row>> {
  const indexes = new Map<string, DerivationIndexState<Row>>();

  for (const definition of definitions) {
    const id = derivationIndexId(definition);
    if (!indexes.has(id)) {
      indexes.set(id, buildDerivationIndex(id, definition, rows));
    }
  }

  return indexes;
}

function buildDerivationIndex<Row>(
  id: string,
  definition: DerivationIndexDefinition<Row>,
  rows: readonly Row[]
): DerivationIndexState<Row> {
  const diagnostics: DerivationIndexDiagnostic<Row>[] = [];

  if (definition.kind === 'unique') {
    const lookup = new Map<string, Row>();
    const duplicates = new Set<string>();

    for (const row of rows) {
      const key = keyForDerivationIndex(definition, row, id, diagnostics);
      if (key === undefined) {
        continue;
      }

      if (lookup.has(key)) {
        duplicates.add(key);
        lookup.delete(key);
        diagnostics.push(duplicateIndexDiagnostic(id, key, row));
        continue;
      }

      if (!duplicates.has(key)) {
        lookup.set(key, row);
      }
    }

    return { kind: 'unique', id, definition, lookup, diagnostics };
  }

  const lookup = new Map<string, Row[]>();
  for (const row of rows) {
    const key = keyForDerivationIndex(definition, row, id, diagnostics);
    if (key === undefined) {
      continue;
    }

    const bucket = lookup.get(key);
    if (bucket === undefined) {
      lookup.set(key, [row]);
    } else {
      bucket.push(row);
    }
  }

  if (definition.kind === 'btree') {
    return {
      kind: 'btree',
      id,
      definition,
      lookup,
      orderedKeys: Array.from(lookup.keys()).sort(),
      diagnostics
    };
  }

  return { kind: 'hash', id, definition, lookup, diagnostics };
}

function keyForDerivationIndex<Row>(
  definition: DerivationIndexDefinition<Row>,
  row: Row,
  indexId: string,
  diagnostics: DerivationIndexDiagnostic<Row>[]
): string | undefined {
  try {
    return definition.keyFor === undefined
      ? stableKey(definition.fields.map((field) => isRecord(row) ? row[field] : undefined))
      : stableKey(definition.keyFor(row));
  } catch (error) {
    diagnostics.push({
      code: 'derivation_index_invalid_row',
      message: 'derivation index key selection failed',
      key: indexId,
      detail: { index: indexId, row, error }
    });
    return undefined;
  }
}

function derivationIndexId<Row>(definition: DerivationIndexDefinition<Row>): string {
  return definition.id ?? stableKey({
    kind: definition.kind,
    fields: definition.fields
  });
}

function duplicateIndexDiagnostic<Row>(
  indexId: string,
  rowKey: string,
  row: Row
): DerivationIndexDiagnostic<Row> {
  return {
    code: 'derivation_index_duplicate_key',
    message: 'unique derivation index has duplicate key',
    key: rowKey,
    detail: { index: indexId, row }
  };
}

function snapshotValue<Row>(
  target: DerivationTarget<Row>,
  value: {
    readonly rowIdentity: DerivationRowIdentity<Row>;
    readonly rows: readonly Row[];
    readonly rowsByKey: ReadonlyMap<string, Row>;
    readonly indexes: ReadonlyMap<string, DerivationIndexState<Row>>;
    readonly diagnostics: readonly DerivationDiagnostic<Row>[];
    readonly version?: unknown;
  }
): DerivationSnapshot<Row> {
  return {
    kind: 'derivationSnapshot',
    target,
    targetKey: derivationTargetKey(target),
    rowIdentity: value.rowIdentity,
    rows: value.rows,
    rowsByKey: value.rowsByKey,
    indexes: value.indexes,
    diagnostics: value.diagnostics,
    ...(value.version === undefined ? {} : { version: value.version })
  };
}

function isNonEmptyFields(input: readonly string[] | undefined): input is readonly [string, ...string[]] {
  return input !== undefined && input.length > 0;
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === 'object' && input !== null && !Array.isArray(input);
}
