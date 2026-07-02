import * as Automerge from '@automerge/automerge';
import {
  composeRelationRuntimes,
  type AdapterSnapshot,
  type AdapterSource,
  type ComposedRelationRuntimeVersion,
  type RelationDelta,
  type RelationPatchTarget,
  type RelationRuntime,
  type TarstateDiagnostic
} from '@tarstate/core/adapter';
import type { PredicateData } from '@tarstate/core/query';
import type { RelationRef } from '@tarstate/core/schema';
import type { WritePatch } from '@tarstate/core/write';

export type AutomergeMapPath<
  DocumentShape extends object = Record<string, unknown>
> = readonly [keyof DocumentShape & string, ...string[]];

export type AutomergeMapRelation<
  Relation extends RelationRef = RelationRef,
  DocumentShape extends object = Record<string, unknown>
> = {
  readonly relation: Relation;
  readonly path: AutomergeMapPath<DocumentShape>;
};

export type AutomergeMapStorageCodec = 'map-v1';

export type AutomergeMapStorageOptions = {
  readonly codec?: AutomergeMapStorageCodec;
};

export type AutomergeMapAdapterOptions<
  DocumentShape extends object = Record<string, unknown>
> = {
  readonly doc: Automerge.Doc<DocumentShape>;
  readonly relations: readonly AutomergeMapRelation<RelationRef, DocumentShape>[];
  readonly changeMessage?: string | ((patches: readonly WritePatch[]) => string | undefined);
  readonly storage?: AutomergeMapStorageOptions;
};

export type AutomergeMapSourceOptions<
  DocumentShape extends object = Record<string, unknown>
> = {
  readonly relations: readonly AutomergeMapRelation<RelationRef, DocumentShape>[];
};

export type AutomergeMapSource = AdapterSource<Automerge.Heads>;
export type AutomergeComposedRuntimeVersion<RuntimeVersion = unknown> =
  ComposedRelationRuntimeVersion<readonly [RelationRuntime<Automerge.Heads>, ...RelationRuntime<RuntimeVersion>[]]>;
export type AutomergeRuntimeVersion<RuntimeVersion = never> =
  [RuntimeVersion] extends [never] ? Automerge.Heads : AutomergeComposedRuntimeVersion<RuntimeVersion>;

export type AutomergeMapAdapter<
  DocumentShape extends object = Record<string, unknown>
> = RelationRuntime<Automerge.Heads> & {
  readonly relations: readonly AutomergeMapRelation<RelationRef, DocumentShape>[];
  readonly getDoc: () => Automerge.Doc<DocumentShape>;
  readonly setDoc: (doc: Automerge.Doc<DocumentShape>) => void;
  readonly snapshot: () => AdapterSnapshot<Automerge.Heads>;
  readonly target: RelationPatchTarget<Automerge.Heads>;
  readonly subscribe: (listener: () => void) => () => void;
};

export type AutomergeRelationRuntimeMetadata = {
  readonly relations: readonly RelationRef[];
};

export type AutomergeRelationRuntime<Version = unknown> =
  RelationRuntime<Version> & AutomergeRelationRuntimeMetadata;

export type AutomergeMapRuntimeOptions<
  DocumentShape extends object = Record<string, unknown>,
  RuntimeVersion = never
> = AutomergeMapAdapterOptions<DocumentShape> & {
  readonly runtimes?: readonly AutomergeRelationRuntime<RuntimeVersion>[];
};

export type AutomergeMapRuntime<
  DocumentShape extends object = Record<string, unknown>,
  RuntimeVersion = never
> = RelationRuntime<AutomergeRuntimeVersion<RuntimeVersion>> & {
  readonly kind: 'automergeMapRuntime';
  readonly adapter: AutomergeMapAdapter<DocumentShape>;
  readonly relations: readonly RelationRef[];
  readonly subscribe: (listener: () => void) => () => void;
};

type Row = Record<string, unknown>;
type MutableRecord = Record<string, unknown>;
type StorageKind = 'array' | 'map';
type PathLookup =
  | { readonly status: 'found'; readonly value: unknown }
  | { readonly status: 'missing' }
  | { readonly status: 'invalid'; readonly segment: string; readonly value: unknown };
type MappedCollection = {
  readonly rows: readonly Row[];
  readonly kind: StorageKind;
  readonly diagnostics: readonly TarstateDiagnostic[];
};
type AnyMapRelation = {
  readonly relation: RelationRef;
  readonly path: readonly string[];
};
type RowPlan = {
  readonly mapping: AnyMapRelation;
  readonly kind: StorageKind;
  readonly before: readonly Row[];
  rows: Row[];
  changed: boolean;
};
type PatchOutcome = {
  readonly accepted: boolean;
  readonly applied: boolean;
  readonly diagnostics: readonly TarstateDiagnostic[];
};
type ExprEvalResult =
  | { readonly supported: true; readonly value: unknown }
  | { readonly supported: false; readonly op?: string };
type RowUpdateResult =
  | { readonly supported: true; readonly row: Row }
  | { readonly supported: false; readonly op?: string };

export function defineAutomergeMapRelations<DocumentShape extends object>() {
  return <const Relations extends readonly AutomergeMapRelation<RelationRef, DocumentShape>[]>(
    relations: Relations
  ): Relations => relations;
}

export function automergeMapSource<
  DocumentShape extends object = Record<string, unknown>
>(
  doc: Automerge.Doc<DocumentShape>,
  options: AutomergeMapSourceOptions<DocumentShape>
): AutomergeMapSource {
  return createAutomergeMapSource(() => doc, options.relations);
}

export function automergeMapAdapter<
  DocumentShape extends object = Record<string, unknown>
>(
  options: AutomergeMapAdapterOptions<DocumentShape>
): AutomergeMapAdapter<DocumentShape> {
  let doc = options.doc;
  const listeners = new Set<() => void>();
  const source = createAutomergeMapSource(() => doc, options.relations);
  const relationNames = relationNamesFor(options.relations);

  const notify = () => {
    for (const listener of listeners) listener();
  };
  const getDoc = () => doc;
  const setDoc = (nextDoc: Automerge.Doc<DocumentShape>) => {
    const previousHeads = Automerge.getHeads(doc);
    doc = nextDoc;
    if (!headsEqual(previousHeads, Automerge.getHeads(doc))) notify();
  };
  const snapshot = (): AdapterSnapshot<Automerge.Heads> => {
    const version = Automerge.getHeads(doc);
    const diagnostics = source.diagnostics?.() ?? [];

    return {
      source,
      version,
      ...(diagnostics.length === 0 ? {} : { diagnostics })
    };
  };
  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };
  const target: RelationPatchTarget<Automerge.Heads> = {
    relationNames,
    ownsRelation: (relationName) => options.relations.some((mapping) => mapping.relation.name === relationName),
    apply: (patches) => {
      const patchList = Array.from(patches);
      const beforeDoc = doc;
      const plans = new Map<string, RowPlan>();
      const diagnostics: TarstateDiagnostic[] = [];
      let accepted = 0;
      let applied = 0;

      for (const patch of patchList) {
        const mapping = options.relations.find((candidate) => candidate.relation.name === patch.relation.name);

        if (mapping === undefined) {
          diagnostics.push(unsupportedRelationDiagnostic(patch.relation.name));
          continue;
        }

        const plan = getOrCreatePlan(beforeDoc, mapping, plans);

        if (plan === undefined) {
          diagnostics.push(invalidPathDiagnostic(mapping, getPathValue(beforeDoc, mapping.path)));
          continue;
        }

        const outcome = applyPatchToPlan(plan, patch);
        diagnostics.push(...outcome.diagnostics);
        if (outcome.accepted) accepted += 1;
        if (outcome.applied) applied += 1;
      }

      const status = applyStatus(patchList.length, accepted);
      const changedPlans = status === 'accepted'
        ? Array.from(plans.values()).filter((plan) => plan.changed)
        : [];
      if (changedPlans.length > 0) {
        const message = changeMessageFor(options.changeMessage, patchList);
        const nextDoc = changeDocument(doc, message, (draft) => {
          for (const plan of changedPlans) {
            setPathValue(draft, plan.mapping.path, encodeRows(plan.rows, plan.mapping.relation, plan.kind));
          }
        });

        doc = nextDoc;
        notify();
      }

      const deltas = changedPlans
        .map((plan) => relationDelta(plan.mapping.relation, plan.before, plan.rows))
        .filter((delta): delta is RelationDelta => delta !== undefined);
      const version = Automerge.getHeads(doc);
      const base = {
        patches: patchList.length,
        diagnostics,
        version,
        durability: 'durable' as const
      };

      return status === 'rejected'
        ? { status, ...base, applied: 0, deltas: [] }
        : { status, ...base, applied, deltas };
    }
  };

  void options.storage?.codec;

  return {
    relations: options.relations,
    getDoc,
    setDoc,
    source,
    target,
    snapshot,
    subscribe
  };
}

export function withAutomergeRuntimeRelations<Version>(
  runtime: RelationRuntime<Version>,
  relation: RelationRef
): AutomergeRelationRuntime<Version>;
export function withAutomergeRuntimeRelations<Version>(
  runtime: RelationRuntime<Version>,
  relations: readonly (RelationRef | AutomergeMapRelation)[]
): AutomergeRelationRuntime<Version>;
export function withAutomergeRuntimeRelations<Version>(
  runtime: RelationRuntime<Version>,
  relationOrRelations: RelationRef | readonly (RelationRef | AutomergeMapRelation)[]
): AutomergeRelationRuntime<Version> {
  const relations: readonly RelationRef[] = isReadonlyArray(relationOrRelations)
    ? relationOrRelations.map(relationRefFor)
    : [relationOrRelations];

  return { ...runtime, relations };
}

export function createAutomergeMapRuntime<
  DocumentShape extends object = Record<string, unknown>
>(
  options: AutomergeMapAdapterOptions<DocumentShape> & { readonly runtimes?: readonly [] | undefined }
): AutomergeMapRuntime<DocumentShape>;
export function createAutomergeMapRuntime<
  DocumentShape extends object = Record<string, unknown>,
  RuntimeVersion = unknown
>(
  options: AutomergeMapAdapterOptions<DocumentShape> & {
    readonly runtimes: readonly AutomergeRelationRuntime<RuntimeVersion>[];
  }
): AutomergeMapRuntime<DocumentShape, RuntimeVersion>;
export function createAutomergeMapRuntime<
  DocumentShape extends object = Record<string, unknown>,
  RuntimeVersion = unknown
>(
  options: AutomergeMapAdapterOptions<DocumentShape> & {
    readonly runtimes?: readonly AutomergeRelationRuntime<RuntimeVersion>[] | undefined;
  }
): AutomergeMapRuntime<DocumentShape> | AutomergeMapRuntime<DocumentShape, RuntimeVersion> {
  const adapter = automergeMapAdapter(options);
  const runtimes = options.runtimes ?? [];
  const runtime = runtimes.length === 0
    ? adapter
    : composeRelationRuntimes(adapter, ...runtimes);
  const subscribe = runtime.subscribe ?? adapter.subscribe;

  return {
    kind: 'automergeMapRuntime',
    adapter,
    relations: uniqueRelationRefs([
      ...options.relations.map((mapping) => mapping.relation),
      ...runtimes.flatMap((item) => item.relations)
    ]),
    source: runtime.source,
    ...(runtime.target === undefined ? {} : { target: runtime.target }),
    ...(runtime.snapshot === undefined ? {} : { snapshot: runtime.snapshot }),
    subscribe
  } as AutomergeMapRuntime<DocumentShape, RuntimeVersion>;
}

function createAutomergeMapSource<DocumentShape extends object>(
  getDoc: () => Automerge.Doc<DocumentShape>,
  relations: readonly AutomergeMapRelation<RelationRef, DocumentShape>[]
): AutomergeMapSource {
  const relationNames = relationNamesFor(relations);

  return {
    relationNames,
    rows: (relationRef) => rowsForRelation(getDoc(), relations, relationRef),
    lookup: (lookup) => rowsForRelation(getDoc(), relations, lookup.relation)
      .filter((row) => Object.is(row[lookup.field], lookup.value)),
    rangeLookup: (lookup) => rowsForRelation(getDoc(), relations, lookup.relation)
      .filter((row) => inRange(row[lookup.field], lookup.lower, lookup.upper)),
    version: () => Automerge.getHeads(getDoc()),
    diagnostics: () => relations.flatMap((mapping) => mappedCollection(getDoc(), mapping).diagnostics)
  };
}

function rowsForRelation<DocumentShape extends object>(
  doc: Automerge.Doc<DocumentShape>,
  relations: readonly AutomergeMapRelation<RelationRef, DocumentShape>[],
  relationRef: RelationRef
): readonly Row[] {
  return relations
    .filter((mapping) => mapping.relation.name === relationRef.name)
    .flatMap((mapping) => mappedCollection(doc, mapping).rows);
}

function mappedCollection<DocumentShape extends object>(
  doc: Automerge.Doc<DocumentShape>,
  mapping: AnyMapRelation
): MappedCollection {
  const lookup = getPathValue(doc, mapping.path);

  if (lookup.status === 'missing') return { rows: [], kind: 'map', diagnostics: [] };
  if (lookup.status === 'invalid') {
    return {
      rows: [],
      kind: 'map',
      diagnostics: [invalidPathDiagnostic(mapping, lookup)]
    };
  }
  if (Array.isArray(lookup.value)) {
    return {
      rows: lookup.value.flatMap((item) => isRecord(item) ? [cloneRow(item)] : []),
      kind: 'array',
      diagnostics: []
    };
  }
  if (isRecord(lookup.value)) {
    return {
      rows: Object.entries(lookup.value).flatMap(([key, value]) => rowFromMapEntry(mapping.relation, key, value)),
      kind: 'map',
      diagnostics: []
    };
  }

  return {
    rows: [],
    kind: 'map',
    diagnostics: [invalidPathDiagnostic(mapping, lookup)]
  };
}

function getOrCreatePlan<DocumentShape extends object>(
  doc: Automerge.Doc<DocumentShape>,
  mapping: AnyMapRelation,
  plans: Map<string, RowPlan>
): RowPlan | undefined {
  const existing = plans.get(mapping.relation.name);
  if (existing !== undefined) return existing;

  const collection = mappedCollection(doc, mapping);
  if (collection.diagnostics.length > 0) return undefined;

  const plan: RowPlan = {
    mapping,
    kind: collection.kind,
    before: collection.rows,
    rows: collection.rows.map(cloneRow),
    changed: false
  };
  plans.set(mapping.relation.name, plan);

  return plan;
}

function applyPatchToPlan(plan: RowPlan, patch: WritePatch): PatchOutcome {
  switch (patch.op) {
    case 'insert':
      return insertRow(plan, patch.row, 'reject');
    case 'insertIgnore':
      return insertRow(plan, patch.row, 'ignore');
    case 'insertOrReplace':
      return upsertRow(plan, patch.row, () => patch.row);
    case 'insertOrMerge':
      return upsertRow(plan, patch.row, (current, incoming) => mergeRows(current, incoming, patch.merge));
    case 'insertOrUpdate':
      return upsertRow(plan, patch.row, (current, incoming) => rowUpdateFor(current, patch.update ?? incoming));
    case 'updateByKey':
      return updateRowByKey(plan, patch.key, patch.changes);
    case 'update':
      return updateRowsByPredicate(plan, patch.predicate, patch.changes);
    case 'deleteByKey':
      return deleteRowByKey(plan, patch.key);
    case 'delete':
      return deleteRowsByPredicate(plan, patch.predicate);
    case 'deleteExact':
      return deleteRowsExact(plan, patch.row);
    case 'replaceAll':
      return replaceRows(plan, patch.rows);
  }
}

function insertRow(plan: RowPlan, rowValue: unknown, duplicateMode: 'reject' | 'ignore'): PatchOutcome {
  const row = coerceRow(rowValue);
  if (row === undefined) return rejected(rowInvalidDiagnostic(plan.mapping.relation.name, rowValue));
  const rowDiagnostics = validatePlanRow(plan, row);
  if (rowDiagnostics.length > 0) return rejected(...rowDiagnostics);

  const key = rowKeyFor(plan.mapping.relation, row);
  if (key === undefined) return rejected(rowKeyDiagnostic(plan.mapping.relation.name, row));

  if (plan.rows.some((item) => rowKeyFor(plan.mapping.relation, item) === key)) {
    return duplicateMode === 'ignore'
      ? accepted(false)
      : rejected(uniqueDiagnostic(plan.mapping.relation.name, row));
  }

  plan.rows = [...plan.rows, row];
  plan.changed = true;
  return accepted(true);
}

function upsertRow(
  plan: RowPlan,
  rowValue: unknown,
  nextRow: (current: Row, incoming: Row) => unknown
): PatchOutcome {
  const row = coerceRow(rowValue);
  if (row === undefined) return rejected(rowInvalidDiagnostic(plan.mapping.relation.name, rowValue));
  const rowDiagnostics = validatePlanRow(plan, row);
  if (rowDiagnostics.length > 0) return rejected(...rowDiagnostics);

  const key = rowKeyFor(plan.mapping.relation, row);
  if (key === undefined) return rejected(rowKeyDiagnostic(plan.mapping.relation.name, row));

  const index = plan.rows.findIndex((item) => rowKeyFor(plan.mapping.relation, item) === key);
  if (index === -1) {
    plan.rows = [...plan.rows, row];
    plan.changed = true;
    return accepted(true);
  }

  const next = nextRow(cloneRow(plan.rows[index] ?? row), cloneRow(row));
  let merged: Row | undefined;
  if (isRowUpdateResult(next)) {
    if (!next.supported) {
      return rejected(unsupportedUpdateExpressionDiagnostic(plan.mapping.relation.name, next.op));
    }
    merged = next.row;
  } else {
    merged = coerceRow(next);
  }
  if (merged === undefined) return rejected(rowInvalidDiagnostic(plan.mapping.relation.name, rowValue));
  const mergedDiagnostics = validatePlanRow(plan, merged);
  if (mergedDiagnostics.length > 0) return rejected(...mergedDiagnostics);

  const mergedKey = rowKeyFor(plan.mapping.relation, merged);
  if (mergedKey !== key) return rejected(rowKeyDiagnostic(plan.mapping.relation.name, merged));
  if (valuesEqual(plan.rows[index], merged)) return accepted(false);

  plan.rows = replaceAt(plan.rows, index, merged);
  plan.changed = true;
  return accepted(true);
}

function updateRowByKey(plan: RowPlan, keyValue: unknown, changes: unknown): PatchOutcome {
  const key = keyValueFor(plan.mapping.relation, keyValue);
  if (key === undefined) return rejected(rowKeyDiagnostic(plan.mapping.relation.name, keyValue));

  const index = plan.rows.findIndex((item) => rowKeyFor(plan.mapping.relation, item) === key);
  if (index === -1) return accepted(false);

  const current = plan.rows[index];
  if (current === undefined) return accepted(false);

  const updateResult = rowUpdateFor(current, changes);
  if (!updateResult.supported) return rejected(unsupportedUpdateExpressionDiagnostic(plan.mapping.relation.name, updateResult.op));

  const updated = updateResult.row;
  if (updated === undefined) return rejected(rowInvalidDiagnostic(plan.mapping.relation.name, changes));
  const updateDiagnostics = validatePlanRow(plan, updated);
  if (updateDiagnostics.length > 0) return rejected(...updateDiagnostics);
  if (rowKeyFor(plan.mapping.relation, updated) !== key) return rejected(rowKeyDiagnostic(plan.mapping.relation.name, updated));
  if (valuesEqual(current, updated)) return accepted(false);

  plan.rows = replaceAt(plan.rows, index, updated);
  plan.changed = true;
  return accepted(true);
}

function updateRowsByPredicate(plan: RowPlan, predicate: PredicateData, changes: unknown): PatchOutcome {
  const matches = matchingIndexes(plan.rows, predicate);
  if (!matches.supported) return rejected(unsupportedPredicateDiagnostic(plan.mapping.relation.name, matches.op));
  if (matches.indexes.length === 0) return accepted(false);

  const nextRows = [...plan.rows];
  let changed = false;

  for (const index of matches.indexes) {
    const current = nextRows[index];
    if (current === undefined) continue;

    const updateResult = rowUpdateFor(current, changes);
    if (!updateResult.supported) return rejected(unsupportedUpdateExpressionDiagnostic(plan.mapping.relation.name, updateResult.op));

    const updated = updateResult.row;
    const updateDiagnostics = validatePlanRow(plan, updated);
    if (updateDiagnostics.length > 0) return rejected(...updateDiagnostics);
    if (rowKeyFor(plan.mapping.relation, updated) !== rowKeyFor(plan.mapping.relation, current)) {
      return rejected(rowKeyDiagnostic(plan.mapping.relation.name, updated));
    }
    if (!valuesEqual(current, updated)) {
      nextRows[index] = updated;
      changed = true;
    }
  }

  if (!changed) return accepted(false);
  plan.rows = nextRows;
  plan.changed = true;
  return accepted(true);
}

function deleteRowByKey(plan: RowPlan, keyValue: unknown): PatchOutcome {
  const key = keyValueFor(plan.mapping.relation, keyValue);
  if (key === undefined) return rejected(rowKeyDiagnostic(plan.mapping.relation.name, keyValue));

  const nextRows = plan.rows.filter((item) => rowKeyFor(plan.mapping.relation, item) !== key);
  if (nextRows.length === plan.rows.length) return accepted(false);

  plan.rows = nextRows;
  plan.changed = true;
  return accepted(true);
}

function deleteRowsByPredicate(plan: RowPlan, predicate: PredicateData): PatchOutcome {
  const matches = matchingIndexes(plan.rows, predicate);
  if (!matches.supported) return rejected(unsupportedPredicateDiagnostic(plan.mapping.relation.name, matches.op));
  if (matches.indexes.length === 0) return accepted(false);

  const matchSet = new Set(matches.indexes);
  plan.rows = plan.rows.filter((_, index) => !matchSet.has(index));
  plan.changed = true;
  return accepted(true);
}

function deleteRowsExact(plan: RowPlan, exact: unknown): PatchOutcome {
  const row = coerceRow(exact);
  if (row === undefined) return rejected(rowInvalidDiagnostic(plan.mapping.relation.name, exact));

  const nextRows = plan.rows.filter((current) => !rowsExactlyMatch(current, row));
  if (nextRows.length === plan.rows.length) return accepted(false);

  plan.rows = nextRows;
  plan.changed = true;
  return accepted(true);
}

function replaceRows(plan: RowPlan, rowsValue: readonly unknown[]): PatchOutcome {
  const rows: Row[] = [];
  const seenKeys = new Set<string>();

  for (const item of rowsValue) {
    const row = coerceRow(item);
    if (row === undefined) return rejected(rowInvalidDiagnostic(plan.mapping.relation.name, item));
    const rowDiagnostics = validatePlanRow(plan, row);
    if (rowDiagnostics.length > 0) return rejected(...rowDiagnostics);

    const key = rowKeyFor(plan.mapping.relation, row);
    if (key === undefined) return rejected(rowKeyDiagnostic(plan.mapping.relation.name, row));
    if (seenKeys.has(key)) return rejected(uniqueDiagnostic(plan.mapping.relation.name, row));

    seenKeys.add(key);
    rows.push(row);
  }

  if (valuesEqual(plan.rows, rows)) return accepted(false);
  plan.rows = rows;
  plan.changed = true;
  return accepted(true);
}

function mergeRows(current: Row, incoming: Row, merge: unknown): RowUpdateResult {
  if (Array.isArray(merge)) {
    return {
      supported: true,
      row: {
        ...current,
        ...Object.fromEntries(merge.map((field) => [String(field), incoming[String(field)]]))
      }
    };
  }
  if (typeof merge === 'function') {
    const baseline = cloneRow(current);
    return rowUpdateFor(baseline, merge(cloneRow(current), cloneRow(incoming)));
  }
  return rowUpdateFor(current, incoming);
}

function rowUpdateFor(current: Row, changes: unknown): RowUpdateResult {
  const update = typeof changes === 'function'
    ? changes(cloneRow(current))
    : changes;

  if (!isRecord(update)) return { supported: true, row: cloneRow(current) };

  const evaluated = evaluateUpdateMap(update, current);
  if (!evaluated.supported) return evaluated;

  return { supported: true, row: { ...current, ...evaluated.row } };
}

function evaluateUpdateMap(update: Record<string, unknown>, current: Row): RowUpdateResult {
  const evaluated: MutableRecord = {};

  for (const [fieldName, fieldValue] of Object.entries(update)) {
    if (!isExprData(fieldValue)) {
      evaluated[fieldName] = cloneValue(fieldValue);
      continue;
    }

    const result = evaluateExpr(fieldValue, current);
    if (!result.supported) return result;
    evaluated[fieldName] = cloneValue(result.value);
  }

  return { supported: true, row: evaluated };
}

function isRowUpdateResult(input: unknown): input is RowUpdateResult {
  return isRecord(input) && typeof input.supported === 'boolean' && ('row' in input || 'op' in input);
}

function matchingIndexes(
  rows: readonly Row[],
  predicate: PredicateData
): { readonly supported: true; readonly indexes: readonly number[] } | { readonly supported: false; readonly op?: string } {
  const indexes: number[] = [];

  for (const [index, row] of rows.entries()) {
    const result = evaluatePredicate(predicate, row);
    if (!result.supported) return result.op === undefined
      ? { supported: false }
      : { supported: false, op: result.op };
    if (result.value === true) indexes.push(index);
  }

  return { supported: true, indexes };
}

function evaluatePredicate(predicate: PredicateData, row: Row): ExprEvalResult {
  return evaluateExpr(predicate, row);
}

function evaluateExpr(expr: unknown, row: Row): ExprEvalResult {
  if (!isRecord(expr) || typeof expr.op !== 'string') return { supported: true, value: expr };

  switch (expr.op) {
    case 'value':
      return { supported: true, value: expr.value };
    case 'field':
      return typeof expr.field === 'string'
        ? { supported: true, value: row[expr.field] }
        : { supported: false, op: expr.op };
    case 'self':
      return { supported: true, value: row };
    case 'maybe':
      return evaluateExpr(expr.expr, row);
    case 'tuple':
      return evaluateTuple(expr.values, row);
    case 'call':
      return evaluateCall(expr, row);
    case 'eq':
    case 'neq':
    case 'lt':
    case 'lte':
    case 'gt':
    case 'gte':
      return evaluateComparison(expr.op, expr.left, expr.right, row);
    case 'and':
      return evaluateAnd(expr.predicates, row);
    case 'or':
      return evaluateOr(expr.predicates, row);
    case 'not': {
      const result = evaluateExpr(expr.predicate, row);
      return result.supported ? { supported: true, value: result.value !== true } : result;
    }
    case 'isNull': {
      const result = evaluateExpr(expr.expr, row);
      return result.supported ? { supported: true, value: result.value === null } : result;
    }
    case 'notNull': {
      const result = evaluateExpr(expr.expr, row);
      return result.supported ? { supported: true, value: result.value !== null && result.value !== undefined } : result;
    }
    case 'isMissing': {
      const result = evaluateExpr(expr.expr, row);
      return result.supported ? { supported: true, value: result.value === undefined } : result;
    }
    case 'notMissing': {
      const result = evaluateExpr(expr.expr, row);
      return result.supported ? { supported: true, value: result.value !== undefined } : result;
    }
    default:
      return { supported: false, op: expr.op };
  }
}

function evaluateTuple(input: unknown, row: Row): ExprEvalResult {
  if (!Array.isArray(input)) return { supported: false, op: 'tuple' };

  const values: unknown[] = [];
  for (const item of input) {
    const result = evaluateExpr(item, row);
    if (!result.supported) return result;
    values.push(result.value);
  }

  return { supported: true, value: values };
}

function evaluateCall(expr: Record<string, unknown>, row: Row): ExprEvalResult {
  const fn = expr.fn;
  if (!isHostFunction(fn)) return { supported: false, op: 'call' };
  const argsInput = expr.args;
  if (!Array.isArray(argsInput)) return { supported: false, op: 'call' };

  const args: unknown[] = [];
  for (const arg of argsInput) {
    const result = evaluateExpr(arg, row);
    if (!result.supported) return result;
    args.push(result.value);
  }

  return { supported: true, value: fn.fn(...args) };
}

function evaluateComparison(op: string, leftExpr: unknown, rightExpr: unknown, row: Row): ExprEvalResult {
  const left = evaluateExpr(leftExpr, row);
  if (!left.supported) return left;

  const right = evaluateExpr(rightExpr, row);
  if (!right.supported) return right;

  switch (op) {
    case 'eq':
      return { supported: true, value: valuesEqual(left.value, right.value) };
    case 'neq':
      return { supported: true, value: !valuesEqual(left.value, right.value) };
    case 'lt':
      return { supported: true, value: compareValues(left.value, right.value) < 0 };
    case 'lte':
      return { supported: true, value: compareValues(left.value, right.value) <= 0 };
    case 'gt':
      return { supported: true, value: compareValues(left.value, right.value) > 0 };
    case 'gte':
      return { supported: true, value: compareValues(left.value, right.value) >= 0 };
    default:
      return { supported: false, op };
  }
}

function evaluateAnd(input: unknown, row: Row): ExprEvalResult {
  if (!Array.isArray(input)) return { supported: false, op: 'and' };

  for (const item of input) {
    const result = evaluateExpr(item, row);
    if (!result.supported) return result;
    if (result.value !== true) return { supported: true, value: false };
  }

  return { supported: true, value: true };
}

function evaluateOr(input: unknown, row: Row): ExprEvalResult {
  if (!Array.isArray(input)) return { supported: false, op: 'or' };

  for (const item of input) {
    const result = evaluateExpr(item, row);
    if (!result.supported) return result;
    if (result.value === true) return { supported: true, value: true };
  }

  return { supported: true, value: false };
}

function accepted(applied: boolean): PatchOutcome {
  return { accepted: true, applied, diagnostics: [] };
}

function rejected(...diagnostics: readonly TarstateDiagnostic[]): PatchOutcome {
  return { accepted: false, applied: false, diagnostics };
}

function relationDelta(relation: RelationRef, before: readonly Row[], after: readonly Row[]): RelationDelta | undefined {
  const beforeRows = keyedRows(relation, before);
  const afterRows = keyedRows(relation, after);
  const removed: Row[] = [];
  const added: Row[] = [];

  for (const [key, row] of beforeRows) {
    const next = afterRows.get(key);
    if (next === undefined || !valuesEqual(row, next)) removed.push(row);
  }

  for (const [key, row] of afterRows) {
    const previous = beforeRows.get(key);
    if (previous === undefined || !valuesEqual(previous, row)) added.push(row);
  }

  return removed.length === 0 && added.length === 0
    ? undefined
    : { relation, removed, added };
}

function keyedRows(relation: RelationRef, rows: readonly Row[]): Map<string, Row> {
  return new Map(rows.map((row, index) => [rowKeyFor(relation, row) ?? `row:${index}:${stableStringify(row)}`, row]));
}

function getPathValue(root: unknown, path: readonly string[]): PathLookup {
  let current = root;

  for (const segment of path) {
    if (current === undefined || current === null) return { status: 'missing' };

    if (Array.isArray(current)) {
      const index = arrayIndex(segment);
      if (index === undefined) return { status: 'invalid', segment, value: current };
      current = current[index];
      continue;
    }

    if (!isRecord(current)) return { status: 'invalid', segment, value: current };
    current = current[segment];
  }

  return current === undefined
    ? { status: 'missing' }
    : { status: 'found', value: current };
}

function setPathValue(root: unknown, path: readonly string[], value: unknown): void {
  let current = root;

  for (const [index, segment] of path.entries()) {
    const isLeaf = index === path.length - 1;

    if (Array.isArray(current)) {
      const arrayItem = arrayIndex(segment);
      if (arrayItem === undefined) return;
      if (isLeaf) {
        current[arrayItem] = value;
        return;
      }
      if (current[arrayItem] === undefined || current[arrayItem] === null) current[arrayItem] = {};
      current = current[arrayItem];
      continue;
    }

    if (!isRecord(current)) return;
    const record = current as MutableRecord;

    if (isLeaf) {
      record[segment] = value;
      return;
    }

    if (record[segment] === undefined || record[segment] === null) record[segment] = {};
    current = record[segment];
  }
}

function rowFromMapEntry(relation: RelationRef, key: string, value: unknown): readonly Row[] {
  if (!isRecord(value)) return [];

  const row = cloneRow(value);
  const keyFields = relationKeyFields(relation);
  if (keyFields.length === 1 && row[keyFields[0] ?? ''] === undefined) {
    const field = keyFields[0];
    if (field !== undefined) row[field] = key;
  }

  return [row];
}

function encodeRows(rows: readonly Row[], relation: RelationRef, kind: StorageKind): unknown {
  if (kind === 'array') return rows.map(cloneValue);

  return Object.fromEntries(rows.map((row) => [storageKeyForRow(relation, row), cloneValue(row)]));
}

function coerceRow(input: unknown): Row | undefined {
  return isRecord(input) ? cloneRow(input) : undefined;
}

function validatePlanRow(plan: RowPlan, row: Row): readonly TarstateDiagnostic[] {
  return validateRelationRowForAutomerge(plan.mapping.relation, row);
}

function validateRelationRowForAutomerge(relation: RelationRef, row: Row): readonly TarstateDiagnostic[] {
  const diagnostics: TarstateDiagnostic[] = [];

  for (const [fieldName, spec] of Object.entries(relation.fields)) {
    const hasField = Object.prototype.hasOwnProperty.call(row, fieldName);
    const fieldValue = row[fieldName];

    if (!hasField || fieldValue === undefined) {
      if (!spec.optional) diagnostics.push(fieldMissingDiagnostic(relation.name, fieldName, false));
      continue;
    }

    if (fieldValue === null) {
      if (!spec.nullable) diagnostics.push(fieldInvalidDiagnostic(
        relation.name,
        fieldName,
        `relation "${relation.name}" field "${fieldName}" must not be null`,
        fieldValue
      ));
      continue;
    }

    if (!fieldValueMatchesSpec(spec, fieldValue)) {
      diagnostics.push(fieldInvalidDiagnostic(
        relation.name,
        fieldName,
        `relation "${relation.name}" field "${fieldName}" must be ${fieldSpecDescription(spec)}`,
        fieldValue
      ));
    }
  }

  for (const keyField of relationKeyFields(relation)) {
    if (row[keyField] === undefined || row[keyField] === null) {
      diagnostics.push(fieldMissingDiagnostic(relation.name, keyField, true));
    }
  }

  return diagnostics;
}

function fieldValueMatchesSpec(spec: RelationRef['fields'][string], value: unknown): boolean {
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
    default:
      return true;
  }
}

function fieldSpecDescription(spec: RelationRef['fields'][string]): string {
  switch (spec.valueKind) {
    case 'id':
    case 'ref':
    case 'anchoredPath':
      return 'a string';
    case 'json':
      return 'a JSON value';
    default:
      return `a ${spec.valueKind}`;
  }
}

function isJsonValue(input: unknown): boolean {
  if (input === null || typeof input === 'string' || typeof input === 'number' || typeof input === 'boolean') return true;
  if (Array.isArray(input)) return input.every(isJsonValue);
  return isRecord(input) && Object.values(input).every(isJsonValue);
}

function cloneRow(input: Record<string, unknown>): Row {
  return Object.fromEntries(Object.entries(input).map(([key, value]) => [key, cloneValue(value)]));
}

function cloneValue(input: unknown): unknown {
  if (Array.isArray(input)) return input.map(cloneValue);
  if (isRecord(input) && isPlainObjectLike(input)) return cloneRow(input);
  return input;
}

function relationKeyFields(relation: RelationRef): readonly string[] {
  return typeof relation.key === 'string' ? [relation.key] : relation.key;
}

function rowKeyFor(relation: RelationRef, row: Row): string | undefined {
  const values = relationKeyFields(relation).map((field) => row[field]);
  return values.some((value) => value === undefined) ? undefined : stableStringify(values);
}

function keyValueFor(relation: RelationRef, keyValue: unknown): string | undefined {
  const fields = relationKeyFields(relation);
  const values = fields.length === 1 && (!Array.isArray(keyValue) || keyValue.length !== 1)
    ? [keyValue]
    : Array.isArray(keyValue)
      ? keyValue
      : undefined;

  return values !== undefined && values.length === fields.length
    ? stableStringify(values)
    : undefined;
}

function storageKeyForRow(relation: RelationRef, row: Row): string {
  const fields = relationKeyFields(relation);
  const values = fields.map((field) => row[field]);

  if (fields.length === 1) {
    const value = values[0];
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value);
  }

  return stableStringify(values);
}

function relationNamesFor(relations: readonly { readonly relation: RelationRef }[]): readonly string[] {
  return Array.from(new Set(relations.map((mapping) => mapping.relation.name)));
}

function relationRefFor(input: RelationRef | AutomergeMapRelation): RelationRef {
  return isMapRelation(input) ? input.relation : input;
}

function isMapRelation(input: RelationRef | AutomergeMapRelation): input is AutomergeMapRelation {
  return 'path' in input;
}

function uniqueRelationRefs(relations: readonly RelationRef[]): readonly RelationRef[] {
  const byName = new Map<string, RelationRef>();

  for (const relation of relations) {
    if (!byName.has(relation.name)) byName.set(relation.name, relation);
  }

  return Array.from(byName.values());
}

function isReadonlyArray<Value>(input: Value | readonly Value[]): input is readonly Value[] {
  return Array.isArray(input);
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === 'object' && input !== null && !Array.isArray(input);
}

function isExprData(input: unknown): input is Record<string, unknown> & { readonly op: string } {
  return isRecord(input) && typeof input.op === 'string';
}

function isHostFunction(input: unknown): input is { readonly fn: (...args: readonly unknown[]) => unknown } {
  return isRecord(input) && input.kind === 'hostFunction' && typeof input.fn === 'function';
}

function isPlainObjectLike(input: Record<string, unknown>): boolean {
  const prototype = Object.getPrototypeOf(input);
  return prototype === Object.prototype || prototype === null;
}

function valuesEqual(left: unknown, right: unknown): boolean {
  return stableStringify(left) === stableStringify(right);
}

function rowsExactlyMatch(left: Row, right: Row): boolean {
  return stableKey(left) === stableKey(right);
}

function stableKey(input: unknown): string {
  if (input === undefined) return '~undefined';
  if (input === null || typeof input === 'string' || typeof input === 'number' || typeof input === 'boolean') {
    return JSON.stringify(input);
  }
  if (typeof input === 'bigint') return `~bigint:${input.toString()}`;
  if (typeof input === 'symbol') return `~symbol:${String(input.description)}`;
  if (typeof input === 'function') return `~function:${input.name}`;
  if (Array.isArray(input)) return `[${input.map(stableKey).join(',')}]`;
  if (isRecord(input)) {
    return `{${Object.keys(input).sort().map((key) => `${JSON.stringify(key)}:${stableKey(input[key])}`).join(',')}}`;
  }

  return JSON.stringify(String(input as string | number | boolean | bigint | null | undefined));
}

function stableStringify(input: unknown): string {
  return JSON.stringify(normalizeForStableStringify(input));
}

function normalizeForStableStringify(input: unknown): unknown {
  if (Array.isArray(input)) return input.map(normalizeForStableStringify);
  if (isRecord(input) && isPlainObjectLike(input)) {
    return Object.fromEntries(Object.keys(input)
      .sort()
      .map((key) => [key, normalizeForStableStringify(input[key])]));
  }

  return input;
}

function compareValues(left: unknown, right: unknown): number {
  if (typeof left === 'number' && typeof right === 'number') return left - right;
  if (typeof left === 'string' && typeof right === 'string') return left.localeCompare(right);
  if (left instanceof Date && right instanceof Date) return left.getTime() - right.getTime();
  return String(left).localeCompare(String(right));
}

function inRange(
  value: unknown,
  lower: { readonly value: unknown; readonly inclusive: boolean } | undefined,
  upper: { readonly value: unknown; readonly inclusive: boolean } | undefined
): boolean {
  if (lower !== undefined) {
    const compared = compareValues(value, lower.value);
    if (compared < 0 || (compared === 0 && !lower.inclusive)) return false;
  }
  if (upper !== undefined) {
    const compared = compareValues(value, upper.value);
    if (compared > 0 || (compared === 0 && !upper.inclusive)) return false;
  }

  return true;
}

function arrayIndex(segment: string): number | undefined {
  const index = Number(segment);
  return Number.isInteger(index) && index >= 0 && String(index) === segment ? index : undefined;
}

function changeMessageFor(
  changeMessage: AutomergeMapAdapterOptions['changeMessage'],
  patches: readonly WritePatch[]
): string | undefined {
  return typeof changeMessage === 'function' ? changeMessage(patches) : changeMessage;
}

function changeDocument<DocumentShape extends object>(
  doc: Automerge.Doc<DocumentShape>,
  message: string | undefined,
  callback: Automerge.ChangeFn<DocumentShape>
): Automerge.Doc<DocumentShape> {
  return message === undefined
    ? Automerge.change(doc, callback)
    : Automerge.change(doc, { message }, callback);
}

function headsEqual(left: Automerge.Heads, right: Automerge.Heads): boolean {
  if (left.length !== right.length) return false;
  const rightHeads = new Set(right);
  return left.every((head) => rightHeads.has(head));
}

function replaceAt(rows: readonly Row[], index: number, row: Row): Row[] {
  return rows.map((item, itemIndex) => itemIndex === index ? row : item);
}

function applyStatus(patches: number, accepted: number): 'accepted' | 'rejected' {
  if (patches === 0) return 'accepted';
  if (accepted === patches) return 'accepted';
  return 'rejected';
}

function unsupportedRelationDiagnostic(relation: string): TarstateDiagnostic {
  return {
    code: 'runtime_unsupported',
    severity: 'warning',
    relation,
    surface: 'automergeMapAdapter',
    message: `Automerge map adapter has no mapping for relation "${relation}"`
  };
}

function unsupportedPredicateDiagnostic(relation: string, op: string | undefined): TarstateDiagnostic {
  return {
    code: 'runtime_unsupported',
    severity: 'warning',
    relation,
    surface: 'automergeMapAdapter',
    message: `Automerge map adapter cannot apply predicate${op === undefined ? '' : ` op "${op}"`}`
  };
}

function unsupportedUpdateExpressionDiagnostic(relation: string, op: string | undefined): TarstateDiagnostic {
  return {
    code: 'runtime_unsupported',
    severity: 'warning',
    relation,
    surface: 'automergeMapAdapter',
    message: `Automerge map adapter cannot apply update expression${op === undefined ? '' : ` op "${op}"`}`
  };
}

function invalidPathDiagnostic(
  mapping: AnyMapRelation,
  lookup: PathLookup
): TarstateDiagnostic {
  return {
    code: 'runtime_unsupported',
    severity: 'warning',
    relation: mapping.relation.name,
    surface: 'automergeMapAdapter',
    message: `Automerge map relation "${mapping.relation.name}" path "${mapping.path.join('.')}" is not an array or map`,
    detail: lookup
  };
}

function rowInvalidDiagnostic(relation: string, row: unknown): TarstateDiagnostic {
  return {
    code: 'row_invalid',
    severity: 'error',
    relation,
    surface: 'automergeMapAdapter',
    message: `Automerge map adapter expected an object row for relation "${relation}"`,
    detail: row
  };
}

function rowKeyDiagnostic(relation: string, detail: unknown): TarstateDiagnostic {
  return {
    code: 'row_invalid',
    severity: 'error',
    relation,
    surface: 'automergeMapAdapter',
    message: `Automerge map adapter could not resolve a complete key for relation "${relation}"`,
    detail
  };
}

function fieldMissingDiagnostic(relation: string, field: string, keyField: boolean): TarstateDiagnostic {
  return {
    code: 'field_missing',
    severity: 'error',
    relation,
    field,
    surface: 'automergeMapAdapter',
    message: keyField
      ? `relation "${relation}" key field "${field}" is missing`
      : `relation "${relation}" row is missing required field "${field}"`
  };
}

function fieldInvalidDiagnostic(relation: string, field: string, message: string, detail: unknown): TarstateDiagnostic {
  return {
    code: 'field_invalid',
    severity: 'error',
    relation,
    field,
    surface: 'automergeMapAdapter',
    message,
    detail
  };
}

function uniqueDiagnostic(relation: string, row: Row): TarstateDiagnostic {
  return {
    code: 'unique',
    severity: 'warning',
    relation,
    surface: 'automergeMapAdapter',
    message: `Automerge map adapter rejected a duplicate key for relation "${relation}"`,
    detail: row
  };
}
