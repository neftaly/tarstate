import type { RelationRef } from './schema.js';

/** Row type carried by a relation reference. */
export type RelationRow<Relation extends RelationRef> = Relation extends RelationRef<infer Row> ? Row : never;

/** Partial row changes for a relation update patch. */
export type RelationRowUpdate<Relation extends RelationRef> = Partial<RelationRow<Relation>>;

/** Key input accepted by update and delete patches. */
export type RelationKeyInput<Row extends Record<string, unknown>> =
  | Row[keyof Row & string]
  | readonly unknown[]
  | Partial<Row>;

export type InsertPatch<Relation extends RelationRef = RelationRef> = {
  readonly op: 'insert';
  readonly relation: Relation;
  readonly row: RelationRow<Relation>;
  readonly onConflict?: 'error' | 'ignore';
};

export type InsertIgnorePatch<Relation extends RelationRef = RelationRef> = InsertPatch<Relation> & {
  readonly onConflict: 'ignore';
};

export type UpdatePatch<Relation extends RelationRef = RelationRef> = {
  readonly op: 'update';
  readonly relation: Relation;
  readonly key: RelationKeyInput<RelationRow<Relation>>;
  readonly changes: RelationRowUpdate<Relation>;
};

export type UpsertPatch<Relation extends RelationRef = RelationRef> = {
  readonly op: 'upsert';
  readonly relation: Relation;
  readonly row: RelationRow<Relation>;
  readonly mode?: 'replace';
};

export type InsertOrReplacePatch<Relation extends RelationRef = RelationRef> = UpsertPatch<Relation>;

export type InsertOrMergePatch<Relation extends RelationRef = RelationRef> = {
  readonly op: 'upsert';
  readonly relation: Relation;
  readonly row: RelationRowUpdate<Relation>;
  readonly mode: 'merge';
};

/** Alias patch type for insert-or-merge's merge-mode upsert shape. */
export type InsertOrUpdatePatch<Relation extends RelationRef = RelationRef> = InsertOrMergePatch<Relation>;

export type DeletePatch<Relation extends RelationRef = RelationRef> = {
  readonly op: 'delete';
  readonly relation: Relation;
  readonly key: RelationKeyInput<RelationRow<Relation>>;
};

export type DeleteExactPatch<Relation extends RelationRef = RelationRef> = {
  readonly op: 'deleteExact';
  readonly relation: Relation;
  readonly row: RelationRow<Relation>;
};

export type ReplaceAllPatch<Relation extends RelationRef = RelationRef> = {
  readonly op: 'replaceAll';
  readonly relation: Relation;
  readonly rows: readonly RelationRow<Relation>[];
};

/** Canonical mutation patch produced by writer constructors. */
export type WritePatch<Relation extends RelationRef = RelationRef> =
  | InsertPatch<Relation>
  | UpdatePatch<Relation>
  | UpsertPatch<Relation>
  | InsertOrMergePatch<Relation>
  | DeletePatch<Relation>
  | DeleteExactPatch<Relation>
  | ReplaceAllPatch<Relation>;

/** Write transaction input accepted by object-backed write helpers. */
export type WriteInput<Relation extends RelationRef = RelationRef> =
  | WritePatch<Relation>
  | Iterable<WritePatch<Relation>>;

/** Relation-scoped patch constructors. */
export type RelationWriter<Relation extends RelationRef> = {
  readonly insert: (row: RelationRow<Relation>) => InsertPatch<Relation>;
  readonly insertIgnore: (row: RelationRow<Relation>) => InsertIgnorePatch<Relation>;
  readonly update: (
    key: RelationKeyInput<RelationRow<Relation>>,
    changes: RelationRowUpdate<Relation>
  ) => UpdatePatch<Relation>;
  readonly upsert: (row: RelationRow<Relation>) => UpsertPatch<Relation>;
  readonly insertOrReplace: (row: RelationRow<Relation>) => InsertOrReplacePatch<Relation>;
  readonly insertOrMerge: (row: RelationRowUpdate<Relation>) => InsertOrMergePatch<Relation>;
  readonly insertOrUpdate: (row: RelationRowUpdate<Relation>) => InsertOrUpdatePatch<Relation>;
  readonly delete: (key: RelationKeyInput<RelationRow<Relation>>) => DeletePatch<Relation>;
  readonly deleteExact: (row: RelationRow<Relation>) => DeleteExactPatch<Relation>;
  readonly replaceAll: (rows: readonly RelationRow<Relation>[]) => ReplaceAllPatch<Relation>;
};

/** Build a typed writer for one relation. */
export function write<Relation extends RelationRef>(relation: Relation): RelationWriter<Relation> {
  return {
    insert: (row) => insert(relation, row),
    insertIgnore: (row) => insertIgnore(relation, row),
    update: (key, changes) => update(relation, key, changes),
    upsert: (row) => upsert(relation, row),
    insertOrReplace: (row) => insertOrReplace(relation, row),
    insertOrMerge: (row) => insertOrMerge(relation, row),
    insertOrUpdate: (row) => insertOrUpdate(relation, row),
    delete: (key) => deleteRow(relation, key),
    deleteExact: (row) => deleteExact(relation, row),
    replaceAll: (rows) => replaceAll(relation, rows)
  };
}

/** Create an insert patch. */
export function insert<Relation extends RelationRef>(
  relation: Relation
): (row: RelationRow<Relation>) => InsertPatch<Relation>;
export function insert<Relation extends RelationRef>(
  relation: Relation,
  row: RelationRow<Relation>
): InsertPatch<Relation>;
export function insert<Relation extends RelationRef>(
  relation: Relation,
  row?: RelationRow<Relation>
): InsertPatch<Relation> | ((row: RelationRow<Relation>) => InsertPatch<Relation>) {
  if (row === undefined) {
    return (nextRow) => insert(relation, nextRow);
  }

  return { op: 'insert', relation, row };
}

/** Create an insert-ignore patch. */
export function insertIgnore<Relation extends RelationRef>(
  relation: Relation,
  row: RelationRow<Relation>
): InsertIgnorePatch<Relation> {
  return { op: 'insert', relation, row, onConflict: 'ignore' };
}

/** Create an update patch. */
export function update<Relation extends RelationRef>(
  relation: Relation,
  key: RelationKeyInput<RelationRow<Relation>>,
  changes: RelationRowUpdate<Relation>
): UpdatePatch<Relation> {
  return { op: 'update', relation, key, changes };
}

/** Create an upsert patch. */
export function upsert<Relation extends RelationRef>(
  relation: Relation,
  row: RelationRow<Relation>
): UpsertPatch<Relation> {
  return { op: 'upsert', relation, row };
}

/** Create an insert-or-replace patch. Alias for upsert. */
export function insertOrReplace<Relation extends RelationRef>(
  relation: Relation,
  row: RelationRow<Relation>
): InsertOrReplacePatch<Relation> {
  return upsert(relation, row);
}

/** Create an insert-or-merge patch. */
export function insertOrMerge<Relation extends RelationRef>(
  relation: Relation,
  row: RelationRowUpdate<Relation>
): InsertOrMergePatch<Relation> {
  return { op: 'upsert', relation, row, mode: 'merge' };
}

/**
 * Create an insert-or-update patch.
 *
 * Alias for insert-or-merge: inserts a full row when missing and merges supplied fields into an existing row.
 */
export function insertOrUpdate<Relation extends RelationRef>(
  relation: Relation,
  row: RelationRowUpdate<Relation>
): InsertOrUpdatePatch<Relation> {
  return insertOrMerge(relation, row);
}

/** Create a delete patch. */
export function deleteRow<Relation extends RelationRef>(
  relation: Relation,
  key: RelationKeyInput<RelationRow<Relation>>
): DeletePatch<Relation> {
  return { op: 'delete', relation, key };
}

/** Create a delete-exact patch that only removes a row when all supplied values match. */
export function deleteExact<Relation extends RelationRef>(
  relation: Relation,
  row: RelationRow<Relation>
): DeleteExactPatch<Relation> {
  return { op: 'deleteExact', relation, row };
}

/** Create a replace-all patch for one relation. */
export function replaceAll<Relation extends RelationRef>(
  relation: Relation,
  rows: readonly RelationRow<Relation>[]
): ReplaceAllPatch<Relation> {
  return { op: 'replaceAll', relation, rows };
}

/** Return an iterable patch batch from either a single patch or patch iterable. */
export function writeInputPatches<Relation extends RelationRef>(
  input: WriteInput<Relation>
): Iterable<WritePatch<Relation>> {
  return isWritePatch(input) ? [input] : input;
}

/** Runtime guard for object-shaped write patches. */
export function isWritePatch(input: unknown): input is WritePatch {
  return isRecord(input) && typeof input.op === 'string' && 'relation' in input;
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === 'object' && input !== null && !Array.isArray(input);
}
