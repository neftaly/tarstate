import * as Automerge from '@automerge/automerge';
import type {
  AdapterCommitResult,
  AdapterSnapshot,
  AdapterSource,
  RelationAdapter,
  TarstateDiagnostic
} from '@tarstate/core/adapter';
import { isJsonValue, type FieldSpec, type RelationRef } from '@tarstate/core/schema';
import type { RelationLookup, RelationRangeLookup } from '@tarstate/core/source';
import { applyWritesAtomic, type MutableObjectSourceData } from '@tarstate/core/write-apply';
import type { WritePatch } from '@tarstate/core/write';

export * from './presence.js';

export type AutomergeDocument<DocumentShape extends Record<string, unknown> = Record<string, unknown>> =
  Automerge.Doc<DocumentShape>;

export type AutomergeMapPath = readonly string[];
export type AutomergeVersion = Automerge.Heads;

export type AutomergeMapRelation<Relation extends RelationRef = RelationRef> = {
  readonly relation: Relation;
  /** Path to the Automerge map whose keys are row keys and whose values are stored row objects. */
  readonly path: AutomergeMapPath;
};

export type AutomergeMapAdapterOptions<
  DocumentShape extends Record<string, unknown> = Record<string, unknown>
> = {
  readonly doc: Automerge.Doc<DocumentShape>;
  readonly relations: readonly AutomergeMapRelation[];
  readonly onDocChange?: (doc: Automerge.Doc<DocumentShape>) => void;
  readonly changeMessage?: string | ((patches: readonly WritePatch[]) => string | undefined);
};

export type AutomergeMapSourceOptions = {
  readonly relations: readonly AutomergeMapRelation[];
};

export type AutomergeMapAdapter<
  DocumentShape extends Record<string, unknown> = Record<string, unknown>
> = RelationAdapter<Automerge.Heads> & {
  readonly relations: readonly AutomergeMapRelation[];
  readonly doc: Automerge.Doc<DocumentShape>;
  readonly getDoc: () => Automerge.Doc<DocumentShape>;
  readonly setDoc: (doc: Automerge.Doc<DocumentShape>) => void;
};

type RelationPlan = {
  readonly relation: RelationRef;
  readonly path: AutomergeMapPath;
  readonly keyFields: readonly string[];
};

type PathState =
  | {
      readonly status: 'map';
      readonly value: Record<string, unknown>;
    }
  | {
      readonly status: 'missing';
    }
  | {
      readonly status: 'blocked';
      readonly path: AutomergeMapPath;
      readonly value: unknown;
    };

type OrderedRangeKind = 'number' | 'string';
type OrderedRangeValue = number | string;
type NormalizedRangeBound = {
  readonly value: OrderedRangeValue;
  readonly inclusive: boolean;
};
type PlanSelectionResult =
  | {
      readonly kind: 'plans';
      readonly plans: readonly RelationPlan[];
    }
  | {
      readonly kind: 'diagnostics';
      readonly diagnostics: readonly TarstateDiagnostic[];
    };

/** Create a Tarstate relation adapter backed by map-shaped relations inside an Automerge document. */
export function automergeMapAdapter<
  DocumentShape extends Record<string, unknown> = Record<string, unknown>
>(options: AutomergeMapAdapterOptions<DocumentShape>): AutomergeMapAdapter<DocumentShape> {
  return new AutomergeMapRelationAdapter(options);
}

/** Alias for callers that prefer the storage-adapter naming convention. */
export const createAutomergeRelationAdapter = automergeMapAdapter;

/** Create a read-only Tarstate source over map-shaped relations inside an Automerge document. */
export function automergeMapSource<
  DocumentShape extends Record<string, unknown> = Record<string, unknown>
>(
  docOrGetDoc: Automerge.Doc<DocumentShape> | (() => Automerge.Doc<DocumentShape>),
  options: AutomergeMapSourceOptions
): AdapterSource<Automerge.Heads> {
  const getDoc = typeof docOrGetDoc === 'function' ? docOrGetDoc : () => docOrGetDoc;
  const plans = relationPlans(options.relations);
  const relationNames = Array.from(plans.keys());
  const source: AdapterSource<Automerge.Heads> = {
    relationNames,
    rows: (relationRef) => {
      const plan = plans.get(relationRef.name);
      return plan === undefined ? [] : validRowsForPlan(getDoc(), plan).rows;
    },
    lookup: (lookup) => lookupRows(getDoc, plans, lookup),
    rangeLookup: (lookup) => rangeLookupRows(getDoc, plans, lookup),
    version: () => Automerge.getHeads(getDoc()),
    diagnostics: () => sourceDiagnostics(getDoc, plans)
  };

  return source;
}

export const createAutomergeRelationSource = automergeMapSource;

/** Extract rows from an exact Automerge map path, optionally synthesizing relation keys from map keys. */
export function rowsFromAutomergeMapPath<
  DocumentShape extends Record<string, unknown> = Record<string, unknown>
>(
  doc: Automerge.Doc<DocumentShape>,
  path: AutomergeMapPath,
  relation?: RelationRef
): readonly unknown[] {
  const state = mapAtPath(doc, path);

  if (state.status !== 'map') {
    return [];
  }

  return Object.entries(state.value).map(([storageKey, row]) =>
    relation === undefined ? cloneAutomergeValue(row) : rowFromStorageEntry(relationPlan(relation, path), storageKey, row)
  );
}

class AutomergeMapRelationAdapter<
  DocumentShape extends Record<string, unknown>
> implements AutomergeMapAdapter<DocumentShape> {
  readonly relations: readonly AutomergeMapRelation[];
  readonly source: AdapterSource<Automerge.Heads>;

  private currentDoc: Automerge.Doc<DocumentShape>;
  private readonly plans: ReadonlyMap<string, RelationPlan>;
  private readonly onDocChange: ((doc: Automerge.Doc<DocumentShape>) => void) | undefined;
  private readonly changeMessage: string | ((patches: readonly WritePatch[]) => string | undefined) | undefined;

  constructor(options: AutomergeMapAdapterOptions<DocumentShape>) {
    this.currentDoc = options.doc;
    this.relations = options.relations.map((spec) => ({ relation: spec.relation, path: [...spec.path] }));
    this.plans = relationPlans(this.relations);
    this.onDocChange = options.onDocChange;
    this.changeMessage = options.changeMessage;
    this.source = automergeMapSource(() => this.currentDoc, { relations: this.relations });
  }

  get doc(): Automerge.Doc<DocumentShape> {
    return this.currentDoc;
  }

  getDoc = (): Automerge.Doc<DocumentShape> => this.currentDoc;

  setDoc = (doc: Automerge.Doc<DocumentShape>): void => {
    this.currentDoc = doc;
  };

  snapshot = (): AdapterSnapshot<Automerge.Heads> => {
    const doc = this.currentDoc;
    return {
      source: automergeMapSource(doc, { relations: this.relations }),
      version: Automerge.getHeads(doc)
    };
  };

  commit = (patches: readonly WritePatch[]): AdapterCommitResult<Automerge.Heads> => {
    const patchList = [...patches];
    const touchedPlans = plansForPatches(this.plans, patchList);

    if (touchedPlans.kind === 'plans') {
      const dataResult = mutableDataForPlans(this.currentDoc, touchedPlans.plans);

      if (dataResult.diagnostics.length > 0) {
        return rejectedResult(patchList.length, dataResult.diagnostics, this.version());
      }

      const applyResult = applyWritesAtomic(dataResult.data, patchList);

      if (!applyResult.committed) {
        return rejectedResult(patchList.length, normalizeWriteDiagnostics(applyResult.diagnostics), this.version());
      }

      const storageResult = storageMapsForPlans(dataResult.data, touchedPlans.plans);

      if (storageResult.diagnostics.length > 0) {
        return rejectedResult(patchList.length, storageResult.diagnostics, this.version());
      }

      if (applyResult.deltas.length > 0) {
        const changeMessage = this.messageFor(patchList);

        try {
          const nextDoc =
            changeMessage === undefined
              ? Automerge.change(this.currentDoc, (draft) => replaceStoredMaps(draft, storageResult.maps))
              : Automerge.change(this.currentDoc, changeMessage, (draft) =>
                  replaceStoredMaps(draft, storageResult.maps)
                );
          this.currentDoc = nextDoc;
          this.onDocChange?.(nextDoc);
        } catch (error) {
          return rejectedResult(patchList.length, [changeFailedDiagnostic(error)], this.version());
        }
      }

      return {
        status: 'committed',
        committed: true,
        patches: patchList.length,
        applied: applyResult.applied,
        deltas: applyResult.deltas,
        diagnostics: [],
        version: this.version()
      };
    }

    return rejectedResult(patchList.length, touchedPlans.diagnostics, this.version());
  };

  private version(): Automerge.Heads {
    return Automerge.getHeads(this.currentDoc);
  }

  private messageFor(patches: readonly WritePatch[]): string | undefined {
    return typeof this.changeMessage === 'function' ? this.changeMessage(patches) : this.changeMessage;
  }
}

function relationPlans(relations: readonly AutomergeMapRelation[]): ReadonlyMap<string, RelationPlan> {
  const plans = new Map<string, RelationPlan>();

  for (const spec of relations) {
    plans.set(spec.relation.name, relationPlan(spec.relation, spec.path));
  }

  return plans;
}

function relationPlan(relation: RelationRef, path: AutomergeMapPath): RelationPlan {
  return {
    relation,
    path: [...path],
    keyFields: typeof relation.key === 'string' ? [relation.key] : relation.key
  };
}

function plansForPatches(
  plans: ReadonlyMap<string, RelationPlan>,
  patches: readonly WritePatch[]
): PlanSelectionResult {
  const touched = new Map<string, RelationPlan>();
  const diagnostics: TarstateDiagnostic[] = [];

  for (const patch of patches) {
    const plan = plans.get(patch.relation.name);

    if (plan === undefined) {
      diagnostics.push({
        code: 'source_error',
        message: `automerge adapter does not own relation ${patch.relation.name}`,
        relation: patch.relation.name
      });
      continue;
    }

    touched.set(plan.relation.name, plan);
  }

  return diagnostics.length === 0
    ? { kind: 'plans', plans: Array.from(touched.values()) }
    : { kind: 'diagnostics', diagnostics };
}

function mutableDataForPlans(
  doc: Automerge.Doc<Record<string, unknown>>,
  plans: readonly RelationPlan[]
): {
  readonly data: MutableObjectSourceData;
  readonly diagnostics: readonly TarstateDiagnostic[];
} {
  const data: MutableObjectSourceData = {};
  const diagnostics: TarstateDiagnostic[] = [];

  for (const plan of plans) {
    const result = validRowsForPlan(doc, plan);

    if (result.diagnostics.length > 0) {
      diagnostics.push(...result.diagnostics);
      continue;
    }

    data[plan.relation.name] = [...result.rows];
  }

  return { data, diagnostics };
}

function storageMapsForPlans(
  data: MutableObjectSourceData,
  plans: readonly RelationPlan[]
): {
  readonly maps: readonly {
    readonly path: AutomergeMapPath;
    readonly rows: Record<string, unknown>;
  }[];
  readonly diagnostics: readonly TarstateDiagnostic[];
} {
  const diagnostics: TarstateDiagnostic[] = [];
  const maps = plans.map((plan) => ({
    path: plan.path,
    rows: rowsToStorageMap(plan, data[plan.relation.name] ?? [], diagnostics)
  }));

  return { maps, diagnostics };
}

function rowsToStorageMap(
  plan: RelationPlan,
  rows: readonly unknown[],
  diagnostics: TarstateDiagnostic[]
): Record<string, unknown> {
  const output: Record<string, unknown> = {};

  for (const row of rows) {
    if (!isRecord(row)) {
      diagnostics.push({
        code: 'invalid_row',
        message: `row for relation ${plan.relation.name} is not an object`,
        relation: plan.relation.name,
        detail: row
      });
      continue;
    }

    const storageKey = storageKeyForRow(plan, row, diagnostics);

    if (storageKey === undefined) {
      continue;
    }

    if (Object.hasOwn(output, storageKey)) {
      diagnostics.push({
        code: 'duplicate_key',
        message: `duplicate key ${storageKey} in relation ${plan.relation.name}`,
        relation: plan.relation.name,
        key: storageKey
      });
      continue;
    }

    output[storageKey] = rowWithoutKeyFields(plan, row);
  }

  return output;
}

function storageKeyForRow(
  plan: RelationPlan,
  row: Record<string, unknown>,
  diagnostics: TarstateDiagnostic[]
): string | undefined {
  const values: unknown[] = [];

  for (const fieldName of plan.keyFields) {
    const value = row[fieldName];

    if (value === undefined) {
      diagnostics.push({
        code: 'invalid_row',
        message: `missing key field ${fieldName} in relation ${plan.relation.name}`,
        relation: plan.relation.name,
        field: fieldName
      });
      return undefined;
    }

    values.push(value);
  }

  if (values.length === 1 && typeof values[0] === 'string') {
    return values[0];
  }

  return JSON.stringify(values);
}

function rowWithoutKeyFields(plan: RelationPlan, row: Record<string, unknown>): Record<string, unknown> {
  const output = cloneAutomergeValue(row) as Record<string, unknown>;

  for (const keyField of plan.keyFields) {
    delete output[keyField];
  }

  return output;
}

function rowFromStorageEntry(plan: RelationPlan, storageKey: string, value: unknown): unknown {
  if (!isRecord(value)) {
    return cloneAutomergeValue(value);
  }

  const row = cloneAutomergeValue(value) as Record<string, unknown>;
  const keyValues = keyValuesFromStorageKey(plan, storageKey);

  for (const [index, fieldName] of plan.keyFields.entries()) {
    row[fieldName] = keyValues[index];
  }

  return row;
}

function keyValuesFromStorageKey(plan: RelationPlan, storageKey: string): readonly unknown[] {
  if (plan.keyFields.length === 1 && isStringLikeKeyField(plan)) {
    return [storageKey];
  }

  try {
    const parsed = JSON.parse(storageKey) as unknown;
    return Array.isArray(parsed) ? parsed : [storageKey];
  } catch {
    return [storageKey];
  }
}

function isStringLikeKeyField(plan: RelationPlan): boolean {
  const keyField = plan.keyFields[0];
  const valueKind = keyField === undefined ? undefined : plan.relation.fields[keyField]?.valueKind;
  return valueKind === 'string' || valueKind === 'id' || valueKind === 'ref';
}

function validRowsForPlan(
  doc: Automerge.Doc<Record<string, unknown>>,
  plan: RelationPlan
): {
  readonly rows: readonly unknown[];
  readonly diagnostics: readonly TarstateDiagnostic[];
} {
  const state = mapAtPath(doc, plan.path);
  const rows: unknown[] = [];
  const diagnostics: TarstateDiagnostic[] = [];

  if (state.status === 'missing') {
    return { rows, diagnostics };
  }

  if (state.status === 'blocked') {
    diagnostics.push(pathBlockedDiagnostic(state.path, state.value));
    return { rows, diagnostics };
  }

  for (const [storageKey, storedRow] of Object.entries(state.value)) {
    const row = rowFromStorageEntry(plan, storageKey, storedRow);
    const rowDiagnostics = rowDiagnosticsForPlan(plan, row, storageKey);

    if (rowDiagnostics.length > 0) {
      diagnostics.push(...rowDiagnostics);
      continue;
    }

    rows.push(row);
  }

  return { rows, diagnostics };
}

function lookupRows(
  getDoc: () => Automerge.Doc<Record<string, unknown>>,
  plans: ReadonlyMap<string, RelationPlan>,
  lookup: RelationLookup
): readonly unknown[] | undefined {
  const plan = plans.get(lookup.relation.name);

  if (plan === undefined) {
    return undefined;
  }

  const output: unknown[] = [];

  for (const row of validRowsForPlan(getDoc(), plan).rows) {
    if (!isRecord(row)) {
      return undefined;
    }

    if (sameLookupValue(row[lookup.field], lookup.value)) {
      output.push(row);
    }
  }

  return output;
}

function rangeLookupRows(
  getDoc: () => Automerge.Doc<Record<string, unknown>>,
  plans: ReadonlyMap<string, RelationPlan>,
  lookup: RelationRangeLookup
): readonly unknown[] | undefined {
  const plan = plans.get(lookup.relation.name);

  if (plan === undefined || (lookup.lower === undefined && lookup.upper === undefined)) {
    return undefined;
  }

  const rangeKind = orderedRangeKindFor(lookup.relation.fields[lookup.field]?.valueKind);

  if (rangeKind === undefined) {
    return undefined;
  }

  const lower = normalizeRangeBound(lookup.lower, rangeKind);
  const upper = normalizeRangeBound(lookup.upper, rangeKind);

  if ((lookup.lower !== undefined && lower === undefined) || (lookup.upper !== undefined && upper === undefined)) {
    return undefined;
  }

  const output: unknown[] = [];

  for (const row of validRowsForPlan(getDoc(), plan).rows) {
    if (!isRecord(row)) {
      return undefined;
    }

    const value = orderedRangeValue(row[lookup.field], rangeKind);

    if (value === undefined) {
      return undefined;
    }

    if (valueWithinRange(value, lower, upper)) {
      output.push(row);
    }
  }

  return output;
}

function sourceDiagnostics(
  getDoc: () => Automerge.Doc<Record<string, unknown>>,
  plans: ReadonlyMap<string, RelationPlan>
): readonly TarstateDiagnostic[] {
  const diagnostics: TarstateDiagnostic[] = [];

  for (const plan of plans.values()) {
    diagnostics.push(...validRowsForPlan(getDoc(), plan).diagnostics);
  }

  return diagnostics;
}

function rowDiagnosticsForPlan(
  plan: RelationPlan,
  row: unknown,
  storageKey: string
): readonly TarstateDiagnostic[] {
  const diagnostics: TarstateDiagnostic[] = [];
  const relationName = plan.relation.name;

  if (!isRecord(row)) {
    diagnostics.push({
      code: 'invalid_row',
      message: `row for relation ${relationName} is not an object`,
      relation: relationName,
      key: storageKey,
      detail: row
    });
    return diagnostics;
  }

  for (const [fieldName, spec] of Object.entries(plan.relation.fields)) {
    const hasField = Object.hasOwn(row, fieldName);
    const value = row[fieldName];

    if (!hasField || value === undefined) {
      if (!spec.optional) {
        diagnostics.push({
          code: 'invalid_row',
          message: `missing required field ${fieldName} in relation ${relationName}`,
          relation: relationName,
          field: fieldName,
          key: storageKey
        });
      }
      continue;
    }

    if (value === null) {
      if (!spec.nullable) {
        diagnostics.push({
          code: 'invalid_row',
          message: `null field ${fieldName} is not nullable in relation ${relationName}`,
          relation: relationName,
          field: fieldName,
          key: storageKey
        });
      }
      continue;
    }

    if (!fieldValueMatches(spec, value)) {
      diagnostics.push({
        code: 'invalid_row',
        message: `invalid field ${fieldName} in relation ${relationName}`,
        relation: relationName,
        field: fieldName,
        key: storageKey,
        detail: value
      });
    }
  }

  return diagnostics;
}

function fieldValueMatches(spec: FieldSpec, value: unknown): boolean {
  switch (spec.valueKind) {
    case 'string':
    case 'id':
    case 'ref':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number';
    case 'boolean':
      return typeof value === 'boolean';
    case 'anchoredPath':
      return Array.isArray(value);
    case 'json':
      return isJsonValue(value);
  }
}

function replaceStoredMaps(
  draft: Record<string, unknown>,
  maps: readonly {
    readonly path: AutomergeMapPath;
    readonly rows: Record<string, unknown>;
  }[]
): void {
  for (const map of maps) {
    replaceStoredMap(draft, map.path, map.rows);
  }
}

function replaceStoredMap(draft: Record<string, unknown>, path: AutomergeMapPath, rows: Record<string, unknown>): void {
  if (path.length === 0) {
    replaceMapContents(draft, rows);
    return;
  }

  const parent = ensureMapPath(draft, path.slice(0, -1));
  const leaf = path.at(-1);

  if (leaf !== undefined) {
    parent[leaf] = rows;
  }
}

function replaceMapContents(target: Record<string, unknown>, rows: Record<string, unknown>): void {
  for (const key of Object.keys(target)) {
    delete target[key];
  }

  for (const [key, value] of Object.entries(rows)) {
    target[key] = value;
  }
}

function ensureMapPath(draft: Record<string, unknown>, path: AutomergeMapPath): Record<string, unknown> {
  let current = draft;

  for (const segment of path) {
    const next = current[segment];

    if (isRecord(next)) {
      current = next;
      continue;
    }

    const created: Record<string, unknown> = {};
    current[segment] = created;
    current = created;
  }

  return current;
}

function mapAtPath(input: unknown, path: AutomergeMapPath): PathState {
  let current = input;
  const visited: string[] = [];

  for (const segment of path) {
    if (!isRecord(current)) {
      return { status: 'blocked', path: visited, value: current };
    }

    visited.push(segment);

    if (!Object.hasOwn(current, segment) || current[segment] === undefined) {
      return { status: 'missing' };
    }

    current = current[segment];
  }

  return isRecord(current) ? { status: 'map', value: current } : { status: 'blocked', path, value: current };
}

function normalizeWriteDiagnostics(diagnostics: readonly TarstateDiagnostic[]): readonly TarstateDiagnostic[] {
  return diagnostics.map((diagnostic) => {
    if (diagnostic.code !== 'invalid_row' || !diagnostic.message.startsWith('missing row ')) {
      return diagnostic;
    }

    const normalizedKey = normalizedDiagnosticKey(diagnostic.key);

    return {
      ...diagnostic,
      code: 'missing_ref',
      ...(normalizedKey === undefined ? {} : { key: normalizedKey })
    };
  });
}

function normalizedDiagnosticKey(key: string | undefined): string | undefined {
  if (key === undefined) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(key) as unknown;

    if (Array.isArray(parsed) && parsed.length === 1 && typeof parsed[0] === 'string') {
      return parsed[0];
    }
  } catch {
    return key;
  }

  return key;
}

function orderedRangeKindFor(valueKind: string | undefined): OrderedRangeKind | undefined {
  switch (valueKind) {
    case 'number':
      return 'number';
    case 'id':
    case 'ref':
    case 'string':
      return 'string';
    default:
      return undefined;
  }
}

function normalizeRangeBound(
  bound: RelationRangeLookup['lower'] | undefined,
  rangeKind: OrderedRangeKind
): NormalizedRangeBound | undefined {
  if (bound === undefined) {
    return undefined;
  }

  const value = orderedRangeValue(bound.value, rangeKind);

  return value === undefined ? undefined : { value, inclusive: bound.inclusive };
}

function orderedRangeValue(value: unknown, rangeKind: OrderedRangeKind): OrderedRangeValue | undefined {
  switch (rangeKind) {
    case 'number':
      return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
    case 'string':
      return typeof value === 'string' ? value : undefined;
  }
}

function valueWithinRange(
  value: OrderedRangeValue,
  lower: NormalizedRangeBound | undefined,
  upper: NormalizedRangeBound | undefined
): boolean {
  if (lower !== undefined) {
    const comparison = compareOrderedRangeValues(value, lower.value);

    if (comparison < 0 || (!lower.inclusive && comparison === 0)) {
      return false;
    }
  }

  if (upper !== undefined) {
    const comparison = compareOrderedRangeValues(value, upper.value);

    if (comparison > 0 || (!upper.inclusive && comparison === 0)) {
      return false;
    }
  }

  return true;
}

function compareOrderedRangeValues(left: OrderedRangeValue, right: OrderedRangeValue): number {
  if (left === right) {
    return 0;
  }

  return left < right ? -1 : 1;
}

function sameLookupValue(left: unknown, right: unknown): boolean {
  return left === right || (left !== left && right !== right);
}

function rejectedResult(
  patches: number,
  diagnostics: readonly TarstateDiagnostic[],
  version: Automerge.Heads
): AdapterCommitResult<Automerge.Heads> {
  return {
    status: 'rejected',
    committed: false,
    patches,
    applied: 0,
    deltas: [],
    diagnostics,
    version
  };
}

function pathBlockedDiagnostic(path: AutomergeMapPath, value: unknown): TarstateDiagnostic {
  return {
    code: 'source_error',
    message: `automerge path ${formatPath(path)} is not a map`,
    detail: value
  };
}

function changeFailedDiagnostic(error: unknown): TarstateDiagnostic {
  return {
    code: 'source_error',
    message: 'automerge change failed',
    detail: error
  };
}

function formatPath(path: AutomergeMapPath): string {
  return path.length === 0 ? '<root>' : path.join('.');
}

function cloneAutomergeValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(cloneAutomergeValue);
  }

  if (!isRecord(value) || Object.prototype.toString.call(value) !== '[object Object]') {
    return value;
  }

  const output: Record<string, unknown> = {};

  for (const [key, nestedValue] of Object.entries(value)) {
    output[key] = cloneAutomergeValue(nestedValue);
  }

  return output;
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === 'object' && input !== null && !Array.isArray(input);
}
