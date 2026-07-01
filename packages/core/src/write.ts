import type { PredicateData } from './query.js';
import type { RelationRef } from './schema.js';

/** Row type carried by a relation reference. */
export type RelationRow<Relation extends RelationRef> = Relation extends RelationRef<infer Row> ? Row : never;

/** Partial row changes for a relation update patch. */
export type RelationRowUpdate<Relation extends RelationRef> = Partial<RelationRow<Relation>>;
export type RelationRowUpdateInput<Relation extends RelationRef> =
  | RelationRowUpdate<Relation>
  | ((row: Readonly<RelationRow<Relation>>) => RelationRowUpdate<Relation>);

/** Key input accepted by update and delete patches. */
export type RelationKeyInput = string | number | readonly unknown[];

/** Fields selected for insert-or-merge conflict handling. */
export type RelationMergeInput<Relation extends RelationRef = RelationRef> =
  | 'provided'
  | 'all'
  | readonly (keyof RelationRow<Relation> & string)[];

export type InsertPatch<Relation extends RelationRef = RelationRef> = {
  readonly op: 'insert';
  readonly relation: Relation;
  readonly row: RelationRow<Relation>;
};

export type InsertIgnorePatch<Relation extends RelationRef = RelationRef> = {
  readonly op: 'insertIgnore';
  readonly relation: Relation;
  readonly row: RelationRow<Relation>;
};

export type InsertOrReplacePatch<Relation extends RelationRef = RelationRef> = {
  readonly op: 'insertOrReplace';
  readonly relation: Relation;
  readonly row: RelationRow<Relation>;
};

export type UpdateByKeyPatch<Relation extends RelationRef = RelationRef> = {
  readonly op: 'updateByKey';
  readonly relation: Relation;
  readonly key: RelationKeyInput;
  readonly changes: RelationRowUpdate<Relation>;
};

export type UpdatePatch<Relation extends RelationRef = RelationRef> = {
  readonly op: 'update';
  readonly relation: Relation;
  readonly predicate: PredicateData;
  readonly changes: RelationRowUpdate<Relation>;
};

export type UpdateWherePatch<Relation extends RelationRef = RelationRef> = UpdatePatch<Relation>;

export type InsertOrMergePatch<Relation extends RelationRef = RelationRef> = {
  readonly op: 'insertOrMerge';
  readonly relation: Relation;
  readonly row: RelationRowUpdate<Relation>;
  readonly merge: RelationMergeInput<Relation>;
};

export type InsertOrMergeOptions<Relation extends RelationRef = RelationRef> = {
  readonly merge?: RelationMergeInput<Relation> | ((
    existing: Readonly<RelationRow<Relation>>,
    incoming: Readonly<RelationRowUpdate<Relation>>
  ) => RelationRowUpdate<Relation>);
};

export type InsertOrUpdateOptions<Relation extends RelationRef = RelationRef> = {
  readonly update:
    | RelationRowUpdateInput<Relation>
    | ((
        existing: Readonly<RelationRow<Relation>>,
        incoming: Readonly<RelationRow<Relation>>
      ) => RelationRowUpdate<Relation>);
};

export type InsertOrUpdatePatch<Relation extends RelationRef = RelationRef> = {
  readonly op: 'insertOrUpdate';
  readonly relation: Relation;
  readonly row: RelationRow<Relation>;
  readonly update: RelationRowUpdate<Relation>;
};

export type DeleteByKeyPatch<Relation extends RelationRef = RelationRef> = {
  readonly op: 'deleteByKey';
  readonly relation: Relation;
  readonly key: RelationKeyInput;
};

export type DeletePatch<Relation extends RelationRef = RelationRef> = {
  readonly op: 'delete';
  readonly relation: Relation;
  readonly predicate: PredicateData;
};

export type DeleteWherePatch<Relation extends RelationRef = RelationRef> = DeletePatch<Relation>;

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
  | InsertIgnorePatch<Relation>
  | InsertOrReplacePatch<Relation>
  | UpdateByKeyPatch<Relation>
  | UpdatePatch<Relation>
  | UpdateWherePatch<Relation>
  | InsertOrMergePatch<Relation>
  | InsertOrUpdatePatch<Relation>
  | DeleteByKeyPatch<Relation>
  | DeletePatch<Relation>
  | DeleteWherePatch<Relation>
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
  readonly insertOrReplace: (row: RelationRow<Relation>) => InsertOrReplacePatch<Relation>;
  readonly updateByKey: (
    key: RelationKeyInput,
    changes: RelationRowUpdateInput<Relation>
  ) => UpdateByKeyPatch<Relation>;
  readonly update: (
    predicate: PredicateData,
    changes: RelationRowUpdateInput<Relation>
  ) => UpdatePatch<Relation>;
  readonly updateWhere: (
    predicate: PredicateData,
    changes: RelationRowUpdateInput<Relation>
  ) => UpdateWherePatch<Relation>;
  readonly insertOrMerge: (
    row: RelationRowUpdate<Relation>,
    options?: InsertOrMergeOptions<Relation>
  ) => InsertOrMergePatch<Relation>;
  readonly insertOrUpdate: (
    row: RelationRow<Relation>,
    options: InsertOrUpdateOptions<Relation>
  ) => InsertOrUpdatePatch<Relation>;
  readonly deleteByKey: (key: RelationKeyInput) => DeleteByKeyPatch<Relation>;
  readonly delete: (predicate: PredicateData) => DeletePatch<Relation>;
  readonly deleteWhere: (predicate: PredicateData) => DeleteWherePatch<Relation>;
  readonly deleteExact: (row: RelationRow<Relation>) => DeleteExactPatch<Relation>;
  readonly replaceAll: (rows: readonly RelationRow<Relation>[]) => ReplaceAllPatch<Relation>;
};

/** Build a typed writer for one relation. */
export function write<Relation extends RelationRef>(relation: Relation): RelationWriter<Relation> {
  return {
    insert: (row) => insert(relation, row),
    insertIgnore: (row) => insertIgnore(relation, row),
    insertOrReplace: (row) => insertOrReplace(relation, row),
    updateByKey: (key, changes) => updateByKey(relation, key, changes),
    update: (predicate, changes) => update(relation, predicate, changes),
    updateWhere: (predicate, changes) => updateWhere(relation, predicate, changes),
    insertOrMerge: (row, options) => insertOrMerge(relation, row, options),
    insertOrUpdate: (row, options) => insertOrUpdate(relation, row, options),
    deleteByKey: (key) => deleteByKey(relation, key),
    delete: (predicate) => deleteRows(relation, predicate),
    deleteWhere: (predicate) => deleteWhere(relation, predicate),
    deleteExact: (row) => deleteExact(relation, row),
    replaceAll: (rows) => replaceAll(relation, rows)
  };
}

/** Create an insert patch. */
export function insert<Relation extends RelationRef>(
  relation: Relation,
  row: RelationRow<Relation>
): InsertPatch<Relation>;
export function insert<Relation extends RelationRef>(
  relation: Relation,
  row: RelationRow<Relation>
): InsertPatch<Relation> {
  return { op: 'insert', relation, row };
}

/** Create an insert-ignore patch. */
export function insertIgnore<Relation extends RelationRef>(
  relation: Relation,
  row: RelationRow<Relation>
): InsertIgnorePatch<Relation> {
  return { op: 'insertIgnore', relation, row };
}

/** Create an insert-or-replace patch. */
export function insertOrReplace<Relation extends RelationRef>(
  relation: Relation,
  row: RelationRow<Relation>
): InsertOrReplacePatch<Relation> {
  return { op: 'insertOrReplace', relation, row };
}

/** Create a key update patch. */
export function updateByKey<Relation extends RelationRef>(
  relation: Relation,
  key: RelationKeyInput,
  changes: RelationRowUpdateInput<Relation>
): UpdateByKeyPatch<Relation> {
  return { op: 'updateByKey', relation, key, changes: changes as RelationRowUpdate<Relation> };
}

/**
 * Create a predicate update patch.
 *
 * @remarks Stable write patches are serializable constant set-maps. Computed
 * update expressions are intentionally left to a future explicit API.
 */
export function update<Relation extends RelationRef>(
  relation: Relation,
  predicate: PredicateData,
  changes: RelationRowUpdateInput<Relation>
): UpdatePatch<Relation> {
  return { op: 'update', relation, predicate, changes: changes as RelationRowUpdate<Relation> };
}

/** Compatibility alias for predicate updates. Prefer `update`. */
export function updateWhere<Relation extends RelationRef>(
  relation: Relation,
  predicate: PredicateData,
  changes: RelationRowUpdateInput<Relation>
): UpdateWherePatch<Relation> {
  return update(relation, predicate, changes);
}

/** Create an insert-or-merge patch. */
export function insertOrMerge<Relation extends RelationRef>(
  relation: Relation,
  row: RelationRowUpdate<Relation>,
  options: InsertOrMergeOptions<Relation> = {}
): InsertOrMergePatch<Relation> {
  return { op: 'insertOrMerge', relation, row, merge: (options.merge ?? 'provided') as RelationMergeInput<Relation> };
}

/**
 * Create an insert-or-update patch.
 *
 * Inserts the full row when missing and applies the explicit update fields to an existing row.
 */
export function insertOrUpdate<Relation extends RelationRef>(
  relation: Relation,
  row: RelationRow<Relation>,
  options: InsertOrUpdateOptions<Relation>
): InsertOrUpdatePatch<Relation>;
export function insertOrUpdate<Relation extends RelationRef>(
  relation: Relation,
  row: RelationRow<Relation>,
  options?: InsertOrUpdateOptions<Relation>
): InsertOrUpdatePatch<Relation> {
  if (options === undefined) {
    throw new TypeError('insertOrUpdate requires an explicit { update } descriptor; use insertOrMerge for merge writes');
  }

  return { op: 'insertOrUpdate', relation, row, update: options.update as RelationRowUpdate<Relation> };
}

/** Create a delete patch. */
export function deleteByKey<Relation extends RelationRef>(
  relation: Relation,
  key: RelationKeyInput
): DeleteByKeyPatch<Relation> {
  return { op: 'deleteByKey', relation, key };
}

/** Create a predicate delete patch. */
export function deleteRows<Relation extends RelationRef>(
  relation: Relation,
  predicate: PredicateData
): DeletePatch<Relation> {
  return { op: 'delete', relation, predicate };
}

/** Relic-style predicate delete export. `deleteRows` is easier to import in TypeScript call sites. */
export { deleteRows as delete };

/** Predicate delete alias for query-like call sites. */
export function deleteWhere<Relation extends RelationRef>(
  relation: Relation,
  predicate: PredicateData
): DeleteWherePatch<Relation> {
  return deleteRows(relation, predicate);
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
