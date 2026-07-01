import * as Automerge from '@automerge/automerge';
import type {
  AdapterCommitResult,
  AdapterSnapshot,
  AdapterSource,
  RelationAdapter,
  RelationDelta,
  RelationPatchTarget,
  TarstateDiagnostic
} from '@tarstate/core/adapter';
import { isJsonValue, type FieldSpec, type RelationRef } from '@tarstate/core/schema';
import type { PredicateData } from '@tarstate/core/query';
import type { RelationRangeBound } from '@tarstate/core/source';
import type { RelationKeyInput, WritePatch } from '@tarstate/core/write';

export type AutomergeMapPath = readonly string[];

export type AutomergeMapRelation<Relation extends RelationRef = RelationRef> = {
  readonly relation: Relation;
  readonly path: AutomergeMapPath;
};

export type AutomergeMapStorageCodec = 'map-v1';

export type AutomergeMapStorageOptions = {
  readonly codec?: AutomergeMapStorageCodec;
};

export type AutomergeMapAdapterOptions<
  DocumentShape extends Record<string, unknown> = Record<string, unknown>
> = {
  readonly doc: Automerge.Doc<DocumentShape>;
  readonly relations: readonly AutomergeMapRelation[];
  readonly onDocChange?: (doc: Automerge.Doc<DocumentShape>) => void;
  readonly changeMessage?: string | ((patches: readonly WritePatch[]) => string | undefined);
  readonly storage?: AutomergeMapStorageOptions;
};

export type AutomergeMapSourceOptions = {
  readonly relations: readonly AutomergeMapRelation[];
};

export type AutomergeMapSource = AdapterSource<Automerge.Heads>;

export type AutomergeMapAdapter<
  DocumentShape extends Record<string, unknown> = Record<string, unknown>
> = RelationAdapter<Automerge.Heads> & {
  readonly relations: readonly AutomergeMapRelation[];
  readonly getDoc: () => Automerge.Doc<DocumentShape>;
  readonly setDoc: (doc: Automerge.Doc<DocumentShape>) => void;
  readonly snapshot: () => AdapterSnapshot<Automerge.Heads>;
  readonly target: RelationPatchTarget<Automerge.Heads>;
  readonly subscribe: (listener: () => void) => () => void;
};

type RelationRows = {
  readonly rows: readonly Record<string, unknown>[];
  readonly diagnostics: readonly TarstateDiagnostic[];
};

type MutableRelationState = {
  readonly mapping: AutomergeMapRelation;
  readonly rows: Map<string, Record<string, unknown>>;
};

type PlannedApply = {
  readonly states: Map<string, MutableRelationState>;
  readonly deltas: readonly RelationDelta[];
};

type MutableDelta = {
  readonly relation: RelationRef;
  readonly added: unknown[];
  readonly removed: unknown[];
};

export function automergeMapAdapter<
  DocumentShape extends Record<string, unknown> = Record<string, unknown>
>(options: AutomergeMapAdapterOptions<DocumentShape>): AutomergeMapAdapter<DocumentShape> {
  assertMapCodec(options.storage?.codec);

  let currentDoc = options.doc;
  const listeners = new Set<() => void>();
  const relations = options.relations.map((relation) => ({
    relation: relation.relation,
    path: [...relation.path]
  }));
  const relationNames = relations.map((relation) => relation.relation.name);
  const source = automergeMapSource(() => currentDoc, { relations });

  const commit = (patches: readonly WritePatch[]): AdapterCommitResult<Automerge.Heads> => {
    const planned = planPatches(currentDoc, relations, patches);

    if ('diagnostics' in planned) {
      return {
        status: 'rejected',
        patches: patches.length,
        applied: 0,
        deltas: [],
        diagnostics: planned.diagnostics,
        version: Automerge.getHeads(currentDoc)
      };
    }

    const message = typeof options.changeMessage === 'function'
      ? options.changeMessage(patches)
      : options.changeMessage;
    const nextDoc = Automerge.change(
      currentDoc,
      message === undefined ? applyPlannedChanges(planned) : message,
      message === undefined ? undefined : applyPlannedChanges(planned)
    );

    currentDoc = nextDoc;
    options.onDocChange?.(currentDoc);
    for (const listener of listeners) listener();

    return {
      status: 'accepted',
      patches: patches.length,
      applied: patches.length,
      deltas: planned.deltas,
      diagnostics: [],
      version: Automerge.getHeads(currentDoc)
    };
  };
  const target: RelationPatchTarget<Automerge.Heads> = {
    relationNames,
    ownsRelation: (relationName) => relationNames.includes(relationName),
    apply: (patches) => ({ ...commit(patches), durability: 'durable' })
  };

  return {
    relations,
    source,
    target,
    commit,
    getDoc: () => currentDoc,
    setDoc: (doc) => {
      currentDoc = doc;
      for (const listener of listeners) listener();
    },
    snapshot: () => ({ source, version: Automerge.getHeads(currentDoc) }),
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    }
  };
}

export function automergeMapSource<
  DocumentShape extends Record<string, unknown> = Record<string, unknown>
>(
  docOrGetDoc: Automerge.Doc<DocumentShape> | (() => Automerge.Doc<DocumentShape>),
  options: AutomergeMapSourceOptions
): AutomergeMapSource {
  const getDoc = typeof docOrGetDoc === 'function' ? docOrGetDoc : () => docOrGetDoc;
  const relationNames = options.relations.map((relation) => relation.relation.name);

  return {
    relationNames,
    rows: (relation) => materializeRelation(getDoc(), options.relations, relation).rows,
    lookup: (lookup) => materializeRelation(getDoc(), options.relations, lookup.relation)
      .rows.filter((row) => Object.is(row[lookup.field], lookup.value)),
    rangeLookup: (lookup) => materializeRelation(getDoc(), options.relations, lookup.relation)
      .rows.filter((row) => inRange(row[lookup.field], lookup.lower, lookup.upper)),
    version: () => Automerge.getHeads(getDoc()),
    diagnostics: () => options.relations.flatMap((relation) =>
      materializeMapping(getDoc(), relation).diagnostics
    )
  };
}

function assertMapCodec(codec: AutomergeMapStorageCodec | undefined): void {
  if (codec !== undefined && codec !== 'map-v1') {
    throw new TypeError(`unsupported Automerge map storage codec "${String(codec)}"; expected map-v1`);
  }
}

function materializeRelation(
  doc: unknown,
  mappings: readonly AutomergeMapRelation[],
  relation: RelationRef
): RelationRows {
  const matchingMappings = mappings.filter((mapping) => mapping.relation.name === relation.name);

  return combineRelationRows(matchingMappings.map((mapping) => materializeMapping(doc, mapping)));
}

function materializeMapping(doc: unknown, mapping: AutomergeMapRelation): RelationRows {
  const mapValue = valueAtPath(doc, mapping.path);

  if (mapValue === undefined) {
    return { rows: [], diagnostics: [] };
  }

  if (!isRecord(mapValue)) {
    return {
      rows: [],
      diagnostics: [invalidRowDiagnostic(mapping.relation, undefined, undefined, 'mapped Automerge path is not an object')]
    };
  }

  const rows: Record<string, unknown>[] = [];
  const diagnostics: TarstateDiagnostic[] = [];

  for (const [key, storedRow] of Object.entries(mapValue)) {
    if (!isPlainRecord(storedRow)) {
      diagnostics.push(invalidRowDiagnostic(mapping.relation, undefined, key, 'stored relation row is not an object'));
      continue;
    }

    const row = restoreRowKey(mapping.relation, key, storedRow);
    const rowDiagnostics = validateRow(mapping.relation, row, key);

    if (rowDiagnostics.length === 0) {
      rows.push(row);
    } else {
      diagnostics.push(...rowDiagnostics);
    }
  }

  return { rows, diagnostics };
}

function combineRelationRows(results: readonly RelationRows[]): RelationRows {
  return {
    rows: results.flatMap((result) => result.rows),
    diagnostics: results.flatMap((result) => result.diagnostics)
  };
}

function restoreRowKey(relation: RelationRef, key: string, storedRow: Record<string, unknown>): Record<string, unknown> {
  const row = { ...storedRow };
  const keyFields = relationKeyFields(relation);
  const keyValues = keyFields.length === 1 ? [key] : parseCompositeKey(key);

  for (const [index, field] of keyFields.entries()) {
    row[field] = keyValues[index];
  }

  return row;
}

function storedRowFor(relation: RelationRef, row: Record<string, unknown>): Record<string, unknown> {
  const stored = { ...row };

  for (const field of relationKeyFields(relation)) {
    delete stored[field];
  }

  return stored;
}

function planPatches(
  doc: unknown,
  mappings: readonly AutomergeMapRelation[],
  patches: readonly WritePatch[]
): PlannedApply | { readonly diagnostics: readonly TarstateDiagnostic[] } {
  const states = new Map<string, MutableRelationState>();
  const deltas = new Map<string, MutableDelta>();
  const diagnostics: TarstateDiagnostic[] = [];

  for (const mapping of mappings) {
    const materialized = materializeMapping(doc, mapping);
    const rows = new Map<string, Record<string, unknown>>();

    for (const row of materialized.rows) {
      rows.set(rowMapKey(mapping.relation, row), row);
    }

    states.set(mapping.relation.name, { mapping, rows });
  }

  for (const patch of patches) {
    const state = states.get(patch.relation.name);

    if (state === undefined) {
      diagnostics.push({
        code: 'missing_ref',
        relation: patch.relation.name,
        message: `relation "${patch.relation.name}" is not mapped by this Automerge adapter`
      });
      continue;
    }

    diagnostics.push(...planPatch(state, patch, deltas));
  }

  return diagnostics.length === 0
    ? { states, deltas: publishDeltas(deltas) }
    : { diagnostics };
}

function planPatch(
  state: MutableRelationState,
  patch: WritePatch,
  deltas: Map<string, MutableDelta>
): readonly TarstateDiagnostic[] {
  switch (patch.op) {
    case 'insert':
      return planInsert(state, patch.row, deltas, 'reject');
    case 'insertIgnore':
      return planInsert(state, patch.row, deltas, 'ignore');
    case 'insertOrReplace':
      return planInsert(state, patch.row, deltas, 'replace');
    case 'insertOrUpdate':
      return state.rows.has(rowMapKey(state.mapping.relation, patch.row))
        ? planUpdateByKey(state, rowMapKey(state.mapping.relation, patch.row), patch.update, deltas)
        : planInsert(state, patch.row, deltas, 'reject');
    case 'insertOrMerge':
      return planInsertOrMerge(state, patch.row, patch.merge, deltas);
    case 'updateByKey':
      return planUpdateByKey(state, keyInputMapKey(patch.key), patch.changes, deltas);
    case 'update':
      return planPredicateUpdate(state, patch.predicate, patch.changes, deltas);
    case 'deleteByKey':
      return planDeleteByKey(state, keyInputMapKey(patch.key), deltas);
    case 'delete':
      return planPredicateDelete(state, patch.predicate, deltas);
    case 'deleteExact':
      return planDeleteExact(state, patch.row, deltas);
    case 'replaceAll':
      return planReplaceAll(state, patch.rows, deltas);
  }
}

function planInsert(
  state: MutableRelationState,
  row: Record<string, unknown>,
  deltas: Map<string, MutableDelta>,
  conflict: 'reject' | 'ignore' | 'replace'
): readonly TarstateDiagnostic[] {
  const diagnostics = firstDiagnostic(validateRow(
    state.mapping.relation,
    row,
    String(rowKeyValue(state.mapping.relation, row))
  ));

  if (diagnostics.length > 0) {
    return diagnostics;
  }

  const key = rowMapKey(state.mapping.relation, row);
  const existing = state.rows.get(key);

  if (existing !== undefined && conflict === 'reject') {
    return [{
      code: 'duplicate_key',
      relation: state.mapping.relation.name,
      key,
      message: `relation "${state.mapping.relation.name}" already has row "${key}"`
    }];
  }

  if (existing !== undefined && conflict === 'ignore') {
    return [];
  }

  if (existing !== undefined) {
    recordRemoved(deltas, state.mapping.relation, existing);
  }

  state.rows.set(key, { ...row });
  recordAdded(deltas, state.mapping.relation, row);
  return [];
}

function planInsertOrMerge(
  state: MutableRelationState,
  row: Record<string, unknown>,
  merge: unknown,
  deltas: Map<string, MutableDelta>
): readonly TarstateDiagnostic[] {
  const keyDiagnostics = validateKeyFields(state.mapping.relation, row);

  if (keyDiagnostics.length > 0) {
    return keyDiagnostics;
  }

  const key = rowMapKey(state.mapping.relation, row);
  const existing = state.rows.get(key);

  if (existing === undefined) {
    return planInsert(state, row, deltas, 'reject');
  }

  const fields = mergeFields(state.mapping.relation, row, merge);
  const changes = Object.fromEntries(fields.map((field) => [field, row[field]]));

  return planUpdateByKey(state, key, changes, deltas);
}

function planUpdateByKey(
  state: MutableRelationState,
  key: string,
  changes: Record<string, unknown>,
  deltas: Map<string, MutableDelta>
): readonly TarstateDiagnostic[] {
  const existing = state.rows.get(key);

  if (existing === undefined) {
    return [missingRowDiagnostic(state.mapping.relation, key)];
  }

  const updated = { ...existing, ...changes };
  const diagnostics = firstDiagnostic(validateRow(state.mapping.relation, updated, key));

  if (diagnostics.length > 0) {
    return diagnostics;
  }

  const updatedKey = rowMapKey(state.mapping.relation, updated);

  if (updatedKey !== key) {
    return [invalidRowDiagnostic(state.mapping.relation, relationKeyFields(state.mapping.relation)[0], key, 'updates cannot change relation keys')];
  }

  state.rows.set(key, updated);
  recordRemoved(deltas, state.mapping.relation, existing);
  recordAdded(deltas, state.mapping.relation, updated);
  return [];
}

function planPredicateUpdate(
  state: MutableRelationState,
  predicate: PredicateData,
  changes: Record<string, unknown>,
  deltas: Map<string, MutableDelta>
): readonly TarstateDiagnostic[] {
  const diagnostics: TarstateDiagnostic[] = [];

  for (const [key, row] of Array.from(state.rows.entries())) {
    const match = evaluatePredicate(predicate, row);

    if (match === undefined) {
      return [unsupportedPredicateDiagnostic(state.mapping.relation)];
    }

    if (match) {
      diagnostics.push(...planUpdateByKey(state, key, changes, deltas));
    }
  }

  return diagnostics;
}

function planDeleteByKey(
  state: MutableRelationState,
  key: string,
  deltas: Map<string, MutableDelta>
): readonly TarstateDiagnostic[] {
  const existing = state.rows.get(key);

  if (existing === undefined) {
    return [missingRowDiagnostic(state.mapping.relation, key)];
  }

  state.rows.delete(key);
  recordRemoved(deltas, state.mapping.relation, existing);
  return [];
}

function planPredicateDelete(
  state: MutableRelationState,
  predicate: PredicateData,
  deltas: Map<string, MutableDelta>
): readonly TarstateDiagnostic[] {
  for (const [key, row] of Array.from(state.rows.entries())) {
    const match = evaluatePredicate(predicate, row);

    if (match === undefined) {
      return [unsupportedPredicateDiagnostic(state.mapping.relation)];
    }

    if (match) {
      state.rows.delete(key);
      recordRemoved(deltas, state.mapping.relation, row);
    }
  }

  return [];
}

function planDeleteExact(
  state: MutableRelationState,
  row: Record<string, unknown>,
  deltas: Map<string, MutableDelta>
): readonly TarstateDiagnostic[] {
  const key = rowMapKey(state.mapping.relation, row);
  const existing = state.rows.get(key);

  if (existing === undefined || !deepEqual(existing, row)) {
    return [missingRowDiagnostic(state.mapping.relation, key)];
  }

  state.rows.delete(key);
  recordRemoved(deltas, state.mapping.relation, existing);
  return [];
}

function planReplaceAll(
  state: MutableRelationState,
  rows: readonly Record<string, unknown>[],
  deltas: Map<string, MutableDelta>
): readonly TarstateDiagnostic[] {
  const diagnostics: TarstateDiagnostic[] = [];
  const replacement = new Map<string, Record<string, unknown>>();

  for (const row of rows) {
    const key = rowMapKey(state.mapping.relation, row);
    const rowDiagnostics = firstDiagnostic(validateRow(state.mapping.relation, row, key));

    if (rowDiagnostics.length > 0) {
      diagnostics.push(...rowDiagnostics);
      continue;
    }

    if (replacement.has(key)) {
      diagnostics.push({
        code: 'duplicate_key',
        relation: state.mapping.relation.name,
        key,
        message: `replacement rows contain duplicate key "${key}"`
      });
      continue;
    }

    replacement.set(key, { ...row });
  }

  if (diagnostics.length > 0) {
    return diagnostics;
  }

  for (const row of state.rows.values()) {
    recordRemoved(deltas, state.mapping.relation, row);
  }

  for (const row of replacement.values()) {
    recordAdded(deltas, state.mapping.relation, row);
  }

  state.rows.clear();
  for (const [key, row] of replacement) {
    state.rows.set(key, row);
  }

  return [];
}

function applyPlannedChanges<DocumentShape extends Record<string, unknown>>(
  planned: PlannedApply
): (doc: DocumentShape) => void {
  return (draft) => {
    for (const state of planned.states.values()) {
      const map = ensureMutableMapAtPath(draft, state.mapping.path);

      for (const key of Object.keys(map)) {
        delete map[key];
      }

      for (const [key, row] of state.rows) {
        map[key] = storedRowFor(state.mapping.relation, row);
      }
    }
  };
}

function ensureMutableMapAtPath(root: Record<string, unknown>, path: readonly string[]): Record<string, unknown> {
  let current = root;

  for (const segment of path) {
    const next = current[segment];

    if (!isRecord(next)) {
      current[segment] = {};
    }

    current = current[segment] as Record<string, unknown>;
  }

  return current;
}

function valueAtPath(root: unknown, path: readonly string[]): unknown {
  let current = root;

  for (const segment of path) {
    if (!isRecord(current)) {
      return undefined;
    }

    current = current[segment];
  }

  return current;
}

function validateRow(relation: RelationRef, row: Record<string, unknown>, key?: string): readonly TarstateDiagnostic[] {
  const diagnostics: TarstateDiagnostic[] = [];

  for (const [field, spec] of Object.entries(relation.fields)) {
    const value = row[field];

    if (!isFieldValueValid(spec, value)) {
      diagnostics.push(invalidRowDiagnostic(relation, field, key, `invalid value for field "${field}"`));
    }
  }

  return diagnostics;
}

function firstDiagnostic(diagnostics: readonly TarstateDiagnostic[]): readonly TarstateDiagnostic[] {
  const [diagnostic] = diagnostics;
  return diagnostic === undefined ? [] : [diagnostic];
}

function validateKeyFields(relation: RelationRef, row: Record<string, unknown>): readonly TarstateDiagnostic[] {
  return relationKeyFields(relation).flatMap((field) =>
    isFieldValueValid(relation.fields[field], row[field])
      ? []
      : [invalidRowDiagnostic(relation, field, undefined, `invalid value for key field "${field}"`)]
  );
}

function isFieldValueValid(spec: FieldSpec | undefined, value: unknown): boolean {
  if (spec === undefined) {
    return true;
  }

  if (value === undefined) {
    return spec.optional;
  }

  if (value === null) {
    return spec.nullable;
  }

  switch (spec.valueKind) {
    case 'string':
    case 'id':
    case 'ref':
    case 'anchoredPath':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'json':
      return isJsonValue(value);
  }
}

function rowMapKey(relation: RelationRef, row: Record<string, unknown>): string {
  const fields = relationKeyFields(relation);
  const values = fields.map((field) => row[field]);

  return fields.length === 1 ? String(values[0]) : JSON.stringify(values);
}

function rowKeyValue(relation: RelationRef, row: Record<string, unknown>): unknown {
  const fields = relationKeyFields(relation);
  const values = fields.map((field) => row[field]);

  return fields.length === 1 ? values[0] : values;
}

function keyInputMapKey(key: RelationKeyInput): string {
  return Array.isArray(key) ? JSON.stringify(key) : String(key);
}

function parseCompositeKey(key: string): readonly unknown[] {
  try {
    const parsed: unknown = JSON.parse(key);
    return Array.isArray(parsed) ? parsed : [key];
  } catch {
    return [key];
  }
}

function relationKeyFields(relation: RelationRef): readonly string[] {
  const key = relation.key;
  return Array.isArray(key) ? key : [key as string];
}

function mergeFields(relation: RelationRef, row: Record<string, unknown>, merge: unknown): readonly string[] {
  const keyFields = new Set(relationKeyFields(relation));

  if (Array.isArray(merge)) {
    return merge.filter((field): field is string => typeof field === 'string' && !keyFields.has(field));
  }

  if (merge === 'all') {
    return Object.keys(relation.fields).filter((field) => !keyFields.has(field) && field in row);
  }

  return Object.keys(row).filter((field) => !keyFields.has(field));
}

function evaluatePredicate(predicate: PredicateData, row: Record<string, unknown>): boolean | undefined {
  switch (predicate.op) {
    case 'and': {
      for (const child of predicate.predicates) {
        const value = evaluatePredicate(child, row);
        if (value === undefined || !value) return value;
      }
      return true;
    }
    case 'or': {
      let unsupported = false;
      for (const child of predicate.predicates) {
        const value = evaluatePredicate(child, row);
        if (value === true) return true;
        if (value === undefined) unsupported = true;
      }
      return unsupported ? undefined : false;
    }
    case 'not': {
      const value = evaluatePredicate(predicate.predicate, row);
      return value === undefined ? undefined : !value;
    }
    default: {
      const left = evaluatePredicateExpr(predicate.left, row);
      const right = evaluatePredicateExpr(predicate.right, row);

      if (left.unsupported || right.unsupported) {
        return undefined;
      }

      return compareValues(left.value, right.value, predicate.op);
    }
  }
}

function evaluatePredicateExpr(
  expr: PredicateData extends infer _Predicate ? { readonly op: string } & Record<string, unknown> : never,
  row: Record<string, unknown>
): { readonly unsupported: boolean; readonly value?: unknown } {
  if (expr.op === 'field' && typeof expr.field === 'string') {
    return { unsupported: false, value: row[expr.field] };
  }

  if (expr.op === 'value') {
    return { unsupported: false, value: expr.value };
  }

  return { unsupported: true };
}

function compareValues(left: unknown, right: unknown, op: 'eq' | 'neq' | 'lt' | 'lte' | 'gt' | 'gte'): boolean {
  const canCompare = comparable(left, right);
  const comparableLeft = left as string | number;
  const comparableRight = right as string | number;

  switch (op) {
    case 'eq':
      return Object.is(left, right);
    case 'neq':
      return !Object.is(left, right);
    case 'lt':
      return canCompare && comparableLeft < comparableRight;
    case 'lte':
      return canCompare && comparableLeft <= comparableRight;
    case 'gt':
      return canCompare && comparableLeft > comparableRight;
    case 'gte':
      return canCompare && comparableLeft >= comparableRight;
  }
}

function comparable(left: unknown, right: unknown): left is string | number {
  return (typeof left === 'string' && typeof right === 'string') ||
    (typeof left === 'number' && typeof right === 'number');
}

function inRange(value: unknown, lower?: RelationRangeBound, upper?: RelationRangeBound): boolean {
  if (lower !== undefined && !boundMatches(value, lower, 'lower')) {
    return false;
  }

  if (upper !== undefined && !boundMatches(value, upper, 'upper')) {
    return false;
  }

  return true;
}

function boundMatches(value: unknown, bound: RelationRangeBound, side: 'lower' | 'upper'): boolean {
  if (!comparable(value, bound.value)) {
    return false;
  }

  const comparableValue = value as string | number;
  const comparableBound = bound.value as string | number;

  if (side === 'lower') {
    return bound.inclusive ? comparableValue >= comparableBound : comparableValue > comparableBound;
  }

  return bound.inclusive ? comparableValue <= comparableBound : comparableValue < comparableBound;
}

function recordAdded(deltas: Map<string, MutableDelta>, relation: RelationRef, row: unknown): void {
  deltaFor(deltas, relation).added.push(row);
}

function recordRemoved(deltas: Map<string, MutableDelta>, relation: RelationRef, row: unknown): void {
  deltaFor(deltas, relation).removed.push(row);
}

function deltaFor(deltas: Map<string, MutableDelta>, relation: RelationRef): MutableDelta {
  const existing = deltas.get(relation.name);

  if (existing !== undefined) {
    return existing;
  }

  const delta = { relation, added: [], removed: [] };
  deltas.set(relation.name, delta);
  return delta;
}

function publishDeltas(deltas: Map<string, MutableDelta>): readonly RelationDelta[] {
  return Array.from(deltas.values(), (delta) => ({
    relation: delta.relation,
    added: [...delta.added],
    removed: [...delta.removed]
  }));
}

function invalidRowDiagnostic(
  relation: RelationRef,
  field: string | undefined,
  key: string | undefined,
  message: string
): TarstateDiagnostic {
  return {
    code: 'invalid_row',
    relation: relation.name,
    ...(field === undefined ? {} : { field }),
    ...(key === undefined ? {} : { key }),
    message
  };
}

function missingRowDiagnostic(relation: RelationRef, key: string): TarstateDiagnostic {
  return {
    code: 'missing_ref',
    relation: relation.name,
    key,
    message: `relation "${relation.name}" has no row "${key}"`
  };
}

function unsupportedPredicateDiagnostic(relation: RelationRef): TarstateDiagnostic {
  return {
    code: 'unsupported_expression',
    relation: relation.name,
    message: `relation "${relation.name}" write predicate is not supported by the Automerge adapter`
  };
}

function deepEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === 'object' && input !== null && !Array.isArray(input);
}

function isPlainRecord(input: unknown): input is Record<string, unknown> {
  return isRecord(input) && Object.prototype.toString.call(input) === '[object Object]';
}
