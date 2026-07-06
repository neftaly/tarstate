import * as Automerge from '@automerge/automerge';
import type {
  DocHandle,
  DocHandleRemoteHeadsPayload,
  PeerMetadata,
  Repo,
  StorageId
} from '@automerge/automerge-repo';
import {
  composeRelationRuntimes,
  type AdapterSnapshot,
  type AdapterSource,
  type ComposedRelationRuntimeVersion,
  type RelationDelta,
  type RelationRuntimeInterest,
  type RelationLookup,
  type RelationPatchTarget,
  type RelationRangeLookup,
  type RelationRuntime,
  type RelationRuntimeListener,
  type RelationRuntimeNotification,
  type RuntimeConflictRow,
  type RuntimeDiagnosticRow,
  type RuntimeHistoryRow,
  type RuntimeInterestRow,
  type RuntimeObjectLocationRow,
  type RuntimePeerRow,
  type RuntimeSourceRow,
  type RuntimeStorageRow,
  type RuntimeSyncRow,
  type RuntimeSystemState,
  runtimeSystemRelationList,
  runtimeSystemSource,
  runtimeSystemRelations,
  type TarstateDiagnostic
} from '@tarstate/core/adapter';
import { evaluate, type EvaluateEnv } from '@tarstate/core/evaluate';
import type { PredicateData, Query } from '@tarstate/core/query';
import {
  type CustomFieldSpec,
  type FieldSpec,
  type RelationRef
} from '@tarstate/core/schema';
import {
  relationFieldCompareToBound,
  relationFieldKeyValue,
  relationFieldLookupMatches,
  relationFieldReadValue,
  relationFieldValueInRange,
  relationFieldValueMatchesSpec,
  relationKeyFields,
  relationKeyInputKey,
  relationKeyInputMatchesRow,
  relationKeyInputValues,
  relationRowKey,
  relationRowKeyMatchesRow,
  type RelationKeyInput,
  validateRelationRow
} from '@tarstate/core/relation';
import type { WritePatch } from '@tarstate/core/write';

import type {
  AutomergeObjectPath,
  AutomergeObjectReference,
  AutomergeObjectReferenceOptions
} from './fields.js';
import {
  compareValues,
  isPlainObjectLike,
  isRecord,
  stableKey,
  stableStringify,
  valuesEqual
} from './value.js';

export {
  automergeBytesField,
  automergeCounterField,
  automergeDateField,
  automergeObjectReferenceField,
  automergeTextField
} from './fields.js';
export type {
  AutomergeCounterValue,
  AutomergeObjectPath,
  AutomergeObjectReference,
  AutomergeObjectReferenceOptions,
  AutomergeTextValue
} from './fields.js';

const runtimeSystemRelationNameSet = new Set(runtimeSystemRelationList.map((relationRef) => relationRef.name));

export type AutomergeMapPath<
  DocumentShape extends object = Record<string, unknown>
> = readonly [keyof DocumentShape & string, ...string[]];
export type AutomergePropertyPath = readonly [Automerge.Prop, ...Automerge.Prop[]];
export type AutomergeConflict = {
  readonly opId: string;
  readonly value: unknown;
};
export type AutomergeConflictDiagnosticOptions = {
  readonly relation?: string;
  readonly field?: string;
  readonly surface?: string;
};
export type AutomergeAnchoredPath = readonly [Automerge.ObjID, ...Automerge.Prop[]];
export type AutomergeObjectLocation = {
  readonly objectId: Automerge.ObjID;
  readonly path: AutomergeObjectPath;
  readonly parentObjectId?: Automerge.ObjID;
  readonly prop?: Automerge.Prop;
  readonly documentId?: string;
  readonly branch?: string;
  readonly heads?: Automerge.Heads;
  readonly relation?: string;
  readonly key?: unknown;
  readonly detail?: unknown;
};

export type AutomergeMapRelation<
  Relation extends RelationRef = RelationRef,
  DocumentShape extends object = Record<string, unknown>
> = {
  readonly relation: Relation;
  readonly path: AutomergeMapPath<DocumentShape>;
};

export type AutomergeMapEnvInput = EvaluateEnv | (() => EvaluateEnv | undefined);
export type AutomergeObjectLocationOptions<
  DocumentShape extends object = Record<string, unknown>
> = {
  readonly relations?: readonly AutomergeMapRelation<RelationRef, DocumentShape>[];
  readonly documentId?: string;
  readonly branch?: string;
  readonly heads?: Automerge.Heads;
  readonly detail?: unknown;
};
export type AutomergeMapAdapterOptions<
  DocumentShape extends object = Record<string, unknown>
> = {
  readonly doc: Automerge.Doc<DocumentShape>;
  readonly relations: readonly AutomergeMapRelation<RelationRef, DocumentShape>[];
  readonly changeMessage?: string | ((patches: readonly WritePatch[]) => string | undefined);
  readonly env?: AutomergeMapEnvInput;
  readonly runtimeId?: string;
  readonly system?: RuntimeSystemState | (() => RuntimeSystemState);
};

export type AutomergeDocHandleRuntimeOptions<
  DocumentShape extends object = Record<string, unknown>
> = Omit<AutomergeMapAdapterOptions<DocumentShape>, 'doc'> & {
  readonly handle: DocHandle<DocumentShape>;
  readonly repo?: Repo;
};

export type AutomergeMapSourceOptions<
  DocumentShape extends object = Record<string, unknown>
> = {
  readonly relations: readonly AutomergeMapRelation<RelationRef, DocumentShape>[];
  readonly runtimeId?: string;
  readonly system?: RuntimeSystemState | (() => RuntimeSystemState);
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
  readonly objectIdFor: (relation: RelationRef, key: unknown) => Automerge.ObjID | null;
  readonly pathForObjectId: (objectId: Automerge.ObjID) => AutomergeObjectPath | null;
  readonly objectReferenceFor: (relation: RelationRef, key: unknown) => AutomergeObjectReference | null;
  readonly snapshot: () => AdapterSnapshot<Automerge.Heads>;
  readonly target: RelationPatchTarget<Automerge.Heads>;
  readonly subscribe: (listener: RelationRuntimeListener) => () => void;
};

export type AutomergeDocHandleRuntime<
  DocumentShape extends object = Record<string, unknown>
> = Omit<AutomergeMapAdapter<DocumentShape>, 'setDoc'> & {
  readonly kind: 'automergeDocHandleRuntime';
  readonly handle: DocHandle<DocumentShape>;
  readonly close: () => void;
};

export type AutomergeDocHandleAdapterOptions<
  DocumentShape extends object = Record<string, unknown>
> = AutomergeDocHandleRuntimeOptions<DocumentShape>;
export type AutomergeDocHandleAdapter<
  DocumentShape extends object = Record<string, unknown>
> = Omit<AutomergeMapAdapter<DocumentShape>, 'setDoc'> & {
  readonly handle: DocHandle<DocumentShape>;
  readonly close: () => void;
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
  readonly subscribe: (listener: RelationRuntimeListener) => () => void;
};

type Row = Record<string, unknown>;
type MutableRecord = Record<string, unknown>;
type StorageKind = 'array' | 'map';
const automergeNativeFieldKind = Symbol.for('tarstate.automerge.nativeFieldKind');
type RelationKeyLookup = {
  readonly rowKey: string;
  readonly storageKey: string;
};
type PathLookup =
  | { readonly status: 'found'; readonly value: unknown }
  | { readonly status: 'missing' }
  | { readonly status: 'invalid'; readonly segment: string; readonly value: unknown };
type MappedCollection = {
  readonly rows: readonly Row[];
  readonly kind: StorageKind;
  readonly diagnostics: readonly TarstateDiagnostic[];
};
type MappedRelationRows = {
  readonly relation: RelationRef;
  readonly rows: readonly Row[];
  readonly equalityIndexes: Map<string, ReadonlyMap<string, readonly Row[]>>;
  readonly rangeIndexes: Map<string, readonly IndexedRangeRow[]>;
};
type IndexedRangeRow = {
  readonly row: Row;
  readonly ordinal: number;
  readonly value: unknown;
};
type AutomergeMapSourceSnapshot = {
  readonly heads: Automerge.Heads;
  readonly byRelation: ReadonlyMap<string, MappedRelationRows>;
  readonly diagnostics: readonly TarstateDiagnostic[];
};
type AutomergeMapSourceSnapshotCache = {
  readonly current: () => AutomergeMapSourceSnapshot;
};
type AnyMapRelation = {
  readonly relation: RelationRef;
  readonly path: readonly string[];
};
type MappedObjectLocation = {
  readonly relation: string;
  readonly key?: unknown;
};
type RowPlan = {
  readonly mapping: AnyMapRelation;
  readonly kind: StorageKind;
  readonly before: readonly Row[];
  readonly nativeCounterIncrements: NativeCounterIncrement[];
  rows: readonly Row[];
  changed: boolean;
};
type NativeCounterIncrement = {
  readonly rowKey: string;
  readonly field: string;
  amount: number;
};
type RowPlanResult =
  | { readonly plan: RowPlan; readonly diagnostics: readonly [] }
  | { readonly plan?: undefined; readonly diagnostics: readonly TarstateDiagnostic[] };
type PatchOutcome = {
  readonly accepted: boolean;
  readonly applied: boolean;
  readonly diagnostics: readonly TarstateDiagnostic[];
};
type ExprEvalResult =
  | { readonly supported: true; readonly value: unknown; readonly diagnostics?: readonly TarstateDiagnostic[] }
  | { readonly supported: false; readonly op?: string; readonly diagnostics?: readonly TarstateDiagnostic[] };
type RowUpdateResult =
  | { readonly supported: true; readonly row: Row; readonly diagnostics: readonly TarstateDiagnostic[] }
  | { readonly supported: false; readonly op?: string; readonly diagnostics: readonly TarstateDiagnostic[] };
type MatchingIndexesResult =
  | { readonly supported: true; readonly indexes: readonly number[]; readonly diagnostics: readonly TarstateDiagnostic[] }
  | { readonly supported: false; readonly op?: string; readonly diagnostics: readonly TarstateDiagnostic[] };
type PatchEvaluationContext<DocumentShape extends object = Record<string, unknown>> = {
  readonly doc: Automerge.Doc<DocumentShape>;
  readonly relations: readonly AnyMapRelation[];
  readonly plans: Map<string, RowPlan>;
  readonly env: () => EvaluateEnv | undefined;
};
type AutomergeApplyContext = {
  readonly env?: EvaluateEnv;
};
type AutomergeDocumentDriver<DocumentShape extends object> = {
  readonly getDoc: () => Automerge.Doc<DocumentShape>;
  readonly setDoc?: (doc: Automerge.Doc<DocumentShape>) => void;
  readonly change: (
    message: string | undefined,
    callback: Automerge.ChangeFn<DocumentShape>
  ) => Automerge.Doc<DocumentShape>;
  readonly subscribe?: (listener: () => void) => () => void;
  readonly notifyAfterChange: boolean;
};
type AutomergeMapAdapterRuntimeOptions<
  DocumentShape extends object = Record<string, unknown>
> = Omit<AutomergeMapAdapterOptions<DocumentShape>, 'doc'> & {
  readonly handle?: DocHandle<DocumentShape>;
  readonly repo?: Repo;
};
type AutomergeObjectLocationSnapshot = {
  readonly heads: Automerge.Heads;
  readonly locationByObjectId: ReadonlyMap<Automerge.ObjID, AutomergeObjectLocation>;
  readonly runtimeRows: readonly RuntimeObjectLocationRow[];
};
type AutomergeObjectLocationSnapshotCache = {
  readonly current: () => AutomergeObjectLocationSnapshot;
};
type AutomergeRepoSystemState = {
  readonly state: () => RuntimeSystemState;
  readonly close: () => void;
};
type AutomergeRepoStorageMetric = {
  readonly type: 'doc-loaded' | 'doc-saved' | 'doc-compacted';
  readonly documentId: string;
  readonly durationMillis?: number;
  readonly numOps?: number;
  readonly numChanges?: number;
  readonly sinceHeads?: readonly string[];
  readonly savedHeads?: readonly string[];
};

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
  const dataSource = createAutomergeMapSource(() => doc, options.relations);
  const runtimeId = options.runtimeId ?? 'automergeMapSource';
  return withAutomergeSystemSource(
    () => doc,
    dataSource,
    options.relations,
    runtimeId,
    new Map(),
    options.system,
    createObjectLocationSnapshotCache(() => doc, options.relations, runtimeId)
  );
}

export function automergeMapAdapter<
  DocumentShape extends object = Record<string, unknown>
>(
  options: AutomergeMapAdapterOptions<DocumentShape>
): AutomergeMapAdapter<DocumentShape> {
  let doc = options.doc;
  const adapter = createAutomergeMapAdapter(options, {
    getDoc: () => doc,
    setDoc: (nextDoc) => {
      doc = nextDoc;
    },
    change: (message, callback) => {
      doc = changeDocument(doc, message, callback);
      return doc;
    },
    notifyAfterChange: true
  });

  return adapter as AutomergeMapAdapter<DocumentShape>;
}

export function automergeDocHandleAdapter<
  DocumentShape extends object = Record<string, unknown>
>(
  options: AutomergeDocHandleAdapterOptions<DocumentShape>
): AutomergeDocHandleAdapter<DocumentShape> {
  const adapter = createAutomergeMapAdapter(options, {
    getDoc: () => options.handle.doc() as Automerge.Doc<DocumentShape>,
    change: (message, callback) => {
      if (message === undefined) {
        options.handle.change(callback as never);
      } else {
        options.handle.change(callback as never, { message } as never);
      }
      return options.handle.doc() as Automerge.Doc<DocumentShape>;
    },
    subscribe: (listener) => {
      options.handle.on('change', listener);
      return () => {
        options.handle.off('change', listener);
      };
    },
    notifyAfterChange: false
  });

  const { setDoc: _setDoc, ...withoutSetDoc } = adapter;

  return {
    ...withoutSetDoc,
    handle: options.handle,
    close: adapter.close
  };
}

export function createAutomergeDocHandleRuntime<
  DocumentShape extends object = Record<string, unknown>
>(
  options: AutomergeDocHandleRuntimeOptions<DocumentShape>
): AutomergeDocHandleRuntime<DocumentShape> {
  return {
    kind: 'automergeDocHandleRuntime',
    ...automergeDocHandleAdapter(options)
  };
}

export function automergeObjectId(input: unknown, prop?: Automerge.Prop): Automerge.ObjID | null {
  return Automerge.getObjectId(input, prop);
}

export function automergeObjectReference(input: AutomergeObjectReference): AutomergeObjectReference {
  return {
    ...input,
    ...(input.path === undefined ? {} : { path: [...input.path] }),
    ...(input.heads === undefined ? {} : { heads: [...input.heads] })
  };
}

export function automergeObjectReferenceAt<DocumentShape extends object>(
  doc: Automerge.Doc<DocumentShape>,
  path: AutomergeObjectPath = [],
  options: AutomergeObjectReferenceOptions = {}
): AutomergeObjectReference | null {
  const objectId = automergeObjectIdAt(doc, path);
  return objectId === null
    ? null
    : automergeObjectReference({
      objectId,
      path: [...path],
      heads: options.heads ?? Automerge.getHeads(doc),
      ...(options.documentId === undefined ? {} : { documentId: options.documentId }),
      ...(options.branch === undefined ? {} : { branch: options.branch }),
      ...(options.relation === undefined ? {} : { relation: options.relation }),
      ...(options.key === undefined ? {} : { key: options.key }),
      ...(options.detail === undefined ? {} : { detail: options.detail })
    });
}

export function automergePathForObjectId<DocumentShape extends object>(
  doc: Automerge.Doc<DocumentShape>,
  objectId: Automerge.ObjID
): AutomergeObjectPath | null {
  const location = automergeObjectLocations(doc).find((row) => row.objectId === objectId);
  return location === undefined ? null : [...location.path];
}

export function automergeObjectLocations<DocumentShape extends object>(
  doc: Automerge.Doc<DocumentShape>,
  options: AutomergeObjectLocationOptions<DocumentShape> = {}
): readonly AutomergeObjectLocation[] {
  return automergeObjectLocationRows(doc, options);
}

function createAutomergeMapAdapter<
  DocumentShape extends object = Record<string, unknown>
>(
  options: AutomergeMapAdapterRuntimeOptions<DocumentShape>,
  driver: AutomergeDocumentDriver<DocumentShape>
): AutomergeMapAdapter<DocumentShape> & { readonly close: () => void } {
  const listeners = new Set<RelationRuntimeListener>();
  const interests = new Map<string, RuntimeInterestRow>();
  const dataSource = createAutomergeMapSource(driver.getDoc, options.relations);
  const runtimeId = options.runtimeId ?? 'automergeMapRuntime';
  let closed = false;
  const notify = (notification?: RelationRuntimeNotification) => {
    if (closed) return;
    for (const listener of listeners) listener(notification);
  };
  const repoSystem = options.repo === undefined || options.handle === undefined
    ? undefined
    : createAutomergeRepoSystemState({
      repo: options.repo,
      handle: options.handle,
      runtimeId,
      getDoc: driver.getDoc,
      notify
    });
  const objectLocationCache = createObjectLocationSnapshotCache(
    driver.getDoc,
    options.relations,
    runtimeId
  );
  const source = withAutomergeSystemSource(
    driver.getDoc,
    dataSource,
    options.relations,
    runtimeId,
    interests,
    options.system,
    objectLocationCache,
    options.handle?.documentId,
    repoSystem?.state
  );
  const relationNames = relationNamesFor(options.relations);
  const stopDriver = driver.subscribe?.(notify);
  const getDoc = driver.getDoc;
  const setDoc = (nextDoc: Automerge.Doc<DocumentShape>) => {
    if (driver.setDoc === undefined) return;
    const previousHeads = Automerge.getHeads(driver.getDoc());
    driver.setDoc(nextDoc);
    if (!headsEqual(previousHeads, Automerge.getHeads(driver.getDoc()))) notify();
  };
  const snapshot = (): AdapterSnapshot<Automerge.Heads> => {
    const doc = driver.getDoc();
    const version = Automerge.getHeads(doc);
    const snapshotDataSource = createAutomergeMapSource(() => doc, options.relations);
    const snapshotSource = withAutomergeSystemSource(
      () => doc,
      snapshotDataSource,
      options.relations,
      runtimeId,
      interests,
      options.system,
      createObjectLocationSnapshotCache(() => doc, options.relations, runtimeId),
      options.handle?.documentId,
      repoSystem?.state
    );
    const diagnostics = snapshotSource.diagnostics?.() ?? [];

    return {
      source: snapshotSource,
      version,
      ...(diagnostics.length === 0 ? {} : { diagnostics })
    };
  };
  const subscribe = (listener: RelationRuntimeListener) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };
  const retainInterest = (interest: RelationRuntimeInterest) => {
    const retainedAt = Date.now();
    const interestRelationNames = Array.from(new Set([
      runtimeSystemRelations.interests.name,
      ...interest.relationNames.filter((relationName) => runtimeSystemRelationNameSet.has(relationName))
    ]));
    interests.set(interest.id, {
      id: interest.id,
      runtime: runtimeId,
      queryKey: interest.queryKey,
      state: 'active',
      relationNames: interest.relationNames,
      subscriberCount: 1,
      retainedAt
    });
    notify({ relationNames: interestRelationNames });
    let retained = true;

    return () => {
      if (!retained) return;
      retained = false;
      interests.delete(interest.id);
      notify({ relationNames: interestRelationNames });
    };
  };
  const objectIdFor = (relation: RelationRef, key: unknown) =>
    objectIdForRelation(driver.getDoc(), options.relations, relation, key);
  const pathForObjectId = (objectId: Automerge.ObjID) =>
    pathForObjectIdFromSnapshot(objectLocationCache.current(), objectId);
  const objectReferenceFor = (relation: RelationRef, key: unknown) => {
    const objectId = objectIdFor(relation, key);
    if (objectId === null) return null;
    const snapshot = objectLocationCache.current();
    const location = snapshot.locationByObjectId.get(objectId);

    return automergeObjectReference({
      objectId,
      ...(location === undefined ? {} : { path: [...location.path] }),
      heads: snapshot.heads,
      relation: relation.name,
      ...(key === undefined ? {} : { key })
    });
  };
  const target: RelationPatchTarget<Automerge.Heads> = {
    relationNames,
    ownsRelation: (relationName) => options.relations.some((mapping) => mapping.relation.name === relationName),
    apply: (patches: readonly WritePatch[], applyContext?: AutomergeApplyContext) => {
      const patchList = patches;
      const beforeDoc = driver.getDoc();
      const plans = new Map<string, RowPlan>();
      const context: PatchEvaluationContext<DocumentShape> = {
        doc: beforeDoc,
        relations: options.relations,
        plans,
        env: () => applyContext?.env ?? automergeMapEnv(options.env)
      };
      const diagnostics: TarstateDiagnostic[] = [];
      let accepted = 0;
      let applied = 0;

      for (const patch of patchList) {
        const mapping = options.relations.find((candidate) => candidate.relation.name === patch.relation.name);

        if (mapping === undefined) {
          diagnostics.push(unsupportedRelationDiagnostic(patch.relation.name));
          continue;
        }

        const planResult = getOrCreatePlan(beforeDoc, mapping, plans);
        diagnostics.push(...planResult.diagnostics);

        if (planResult.plan === undefined) continue;

        const outcome = applyPatchToPlan(planResult.plan, patch, context);
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
        driver.change(message, (draft) => {
          for (const plan of changedPlans) {
            applyRowsToDraft(draft, plan);
          }
        });

        if (driver.notifyAfterChange) notify();
      }

      const deltas = changedPlans
        .map((plan) => relationDelta(plan.mapping.relation, plan.before, plan.rows))
        .filter((delta): delta is RelationDelta => delta !== undefined);
      const version = Automerge.getHeads(driver.getDoc());
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

  return {
    relations: options.relations,
    getDoc,
    setDoc,
    objectIdFor,
    pathForObjectId,
    objectReferenceFor,
    source,
    target,
    snapshot,
    subscribe,
    retainInterest,
    close: () => {
      closed = true;
      listeners.clear();
      stopDriver?.();
      repoSystem?.close();
    }
  };
}

export function automergeView<DocumentShape extends object>(
  doc: Automerge.Doc<DocumentShape>,
  heads: Automerge.Heads
): Automerge.Doc<DocumentShape> {
  return Automerge.view(doc, heads);
}

export function automergeFork<DocumentShape extends object>(
  doc: Automerge.Doc<DocumentShape>
): Automerge.Doc<DocumentShape> {
  return Automerge.clone(doc);
}

export function automergeChangeAt<DocumentShape extends object>(
  doc: Automerge.Doc<DocumentShape>,
  heads: Automerge.Heads,
  change: Automerge.ChangeFn<DocumentShape>,
  options?: string | Automerge.ChangeOptions<DocumentShape>
): Automerge.ChangeAtResult<DocumentShape> {
  return options === undefined
    ? Automerge.changeAt(doc, heads, change)
    : Automerge.changeAt(doc, heads, options, change);
}

export function automergeMerge<DocumentShape extends object>(
  local: Automerge.Doc<DocumentShape>,
  remote: Automerge.Doc<DocumentShape>
): Automerge.Doc<DocumentShape> {
  return Automerge.merge(local, remote);
}

export function automergeObjectIdAt<DocumentShape extends object>(
  doc: Automerge.Doc<DocumentShape>,
  path: AutomergeObjectPath = []
): Automerge.ObjID | null {
  const value = valueAtPropertyPath(doc, path);
  return value.found ? Automerge.getObjectId(value.value) : null;
}

export function automergeConflictsAt<DocumentShape extends object>(
  doc: Automerge.Doc<DocumentShape>,
  path: AutomergePropertyPath
): readonly AutomergeConflict[] {
  const parent = valueAtPropertyPath(doc, path.slice(0, -1));
  const prop = path[path.length - 1];
  if (!parent.found || prop === undefined) return [];

  const conflicts = Automerge.getConflicts(
    parent.value as Automerge.Doc<Record<string, unknown>>,
    prop
  );
  if (conflicts === undefined) return [];

  return Object.entries(conflicts).map(([opId, value]) => ({ opId, value }));
}

export function automergeConflictDiagnostics<DocumentShape extends object>(
  doc: Automerge.Doc<DocumentShape>,
  paths: readonly AutomergePropertyPath[],
  options: AutomergeConflictDiagnosticOptions = {}
): readonly TarstateDiagnostic[] {
  return paths.flatMap((path) => {
    const conflicts = automergeConflictsAt(doc, path);
    if (conflicts.length === 0) return [];

    return [{
      code: 'automerge_conflict',
      severity: 'warning',
      message: `Automerge conflict at "${formatAutomergePath(path)}"`,
      ...(options.relation === undefined ? {} : { relation: options.relation }),
      ...(options.field === undefined ? {} : { field: options.field }),
      surface: options.surface ?? 'automerge',
      detail: { path, conflicts }
    }];
  });
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
  const relations: readonly RelationRef[] = Array.isArray(relationOrRelations)
    ? relationOrRelations.map(relationRefFor)
    : [relationOrRelations as RelationRef];

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
      ...runtimes.flatMap((item) => item.relations),
      ...runtimeSystemRelationList
    ]),
    source: runtime.source,
    ...(runtime.target === undefined ? {} : { target: runtime.target }),
    ...(runtime.snapshot === undefined ? {} : { snapshot: runtime.snapshot }),
    subscribe,
    ...(runtime.retainInterest === undefined ? {} : { retainInterest: runtime.retainInterest })
  } as AutomergeMapRuntime<DocumentShape, RuntimeVersion>;
}

function createAutomergeMapSource<DocumentShape extends object>(
  getDoc: () => Automerge.Doc<DocumentShape>,
  relations: readonly AutomergeMapRelation<RelationRef, DocumentShape>[]
): AutomergeMapSource {
  const relationNames = relationNamesFor(relations);
  const snapshotCache = createMapSourceSnapshotCache(getDoc, relations);

  return {
    relationNames,
    rows: (relationRef) => rowsForRelationSnapshot(snapshotCache.current(), relationRef),
    lookup: (lookup) => lookupRowsForRelationSnapshot(snapshotCache.current(), lookup),
    rangeLookup: (lookup) => rangeRowsForRelationSnapshot(snapshotCache.current(), lookup),
    version: () => Automerge.getHeads(getDoc()),
    diagnostics: () => snapshotCache.current().diagnostics
  };
}

function withAutomergeSystemSource<DocumentShape extends object>(
  getDoc: () => Automerge.Doc<DocumentShape>,
  dataSource: AutomergeMapSource,
  relations: readonly AutomergeMapRelation<RelationRef, DocumentShape>[],
  runtimeId: string,
  interests: ReadonlyMap<string, RuntimeInterestRow>,
  input?: RuntimeSystemState | (() => RuntimeSystemState),
  objectLocationCache = createObjectLocationSnapshotCache(getDoc, relations, runtimeId),
  documentId?: string,
  repoSystemState?: () => RuntimeSystemState
): AutomergeMapSource {
  const extraState = (): RuntimeSystemState | undefined => typeof input === 'function' ? input() : input;
  const repoState = (): RuntimeSystemState | undefined => repoSystemState?.();
  const sourceRows = (): readonly RuntimeSourceRow[] => [
    {
      id: `${runtimeId}:source:document`,
      runtime: runtimeId,
      source: 'automerge.document',
      state: 'ready',
      message: `${relations.length} mapped relation${relations.length === 1 ? '' : 's'}`
    },
    ...(extraState()?.sources ?? [])
  ];
  const adapterDiagnosticRows = (): readonly RuntimeDiagnosticRow[] =>
    (dataSource.diagnostics?.() ?? []).map((diagnosticValue, index) => ({
      id: `${runtimeId}:diagnostic:${index}`,
      runtime: runtimeId,
      source: 'automerge.document',
      code: diagnosticValue.code,
      severity: diagnosticValue.severity ?? 'info',
      message: diagnosticValue.message,
      ...(diagnosticValue.surface === undefined ? {} : { surface: diagnosticValue.surface }),
      ...(diagnosticValue.relation === undefined ? {} : { relation: diagnosticValue.relation }),
      ...(diagnosticValue.detail === undefined ? {} : { detail: diagnosticValue.detail })
    }));
  const diagnosticState = (): RuntimeSystemState => ({
    diagnostics: [
      ...adapterDiagnosticRows(),
      ...(extraState()?.diagnostics ?? [])
    ]
  });
  const diagnosticSource = runtimeSystemSource(diagnosticState);
  const diagnosticRows = (): readonly RuntimeDiagnosticRow[] =>
    diagnosticSource.rows(runtimeSystemRelations.diagnostics) as readonly RuntimeDiagnosticRow[];
  const syncRows = (): readonly RuntimeSyncRow[] => {
    const repo = repoState();
    const extra = extraState();
    return [
      {
        id: `${runtimeId}:sync:local-heads`,
        runtime: runtimeId,
        state: 'synced',
        ...(documentId === undefined ? {} : { documentId }),
        localHeads: Automerge.getHeads(getDoc())
      },
      ...(repo?.sync ?? []),
      ...(extra?.sync ?? [])
    ];
  };
  const interestRows = (): readonly RuntimeInterestRow[] => [
    ...Array.from(interests.values()),
    ...(repoState()?.interests ?? []),
    ...(extraState()?.interests ?? [])
  ];
  const peerRows = (): readonly RuntimePeerRow[] => [
    ...(repoState()?.peers ?? []),
    ...(extraState()?.peers ?? [])
  ];
  const storageRows = (): readonly RuntimeStorageRow[] => [
    ...(repoState()?.storage ?? []),
    ...(extraState()?.storage ?? [])
  ];
  const objectLocationRows = (): readonly RuntimeObjectLocationRow[] => {
    const extraObjectLocations = extraState()?.objectLocations ?? [];
    return extraObjectLocations.length === 0
      ? objectLocationCache.current().runtimeRows
      : [...extraObjectLocations, ...objectLocationCache.current().runtimeRows];
  };
  const conflictRows = (): readonly RuntimeConflictRow[] => [
    ...runtimeConflictRowsForMappedRelations(getDoc(), relations, runtimeId, documentId),
    ...(repoState()?.conflicts ?? []),
    ...(extraState()?.conflicts ?? [])
  ];
  const historyRows = (): readonly RuntimeHistoryRow[] => [
    ...(hasRuntimeHistoryInterest(interests) ? automergeHistoryRows(getDoc(), runtimeId, documentId) : []),
    ...(repoState()?.history ?? []),
    ...(extraState()?.history ?? [])
  ];
  const systemState = (): RuntimeSystemState => {
    const extra = extraState();

    return {
      sources: sourceRows(),
      diagnostics: diagnosticState().diagnostics ?? [],
      sync: syncRows(),
      interests: interestRows(),
      peers: peerRows(),
      conflicts: conflictRows(),
      history: historyRows(),
      ...(extra?.objectLocations === undefined ? {} : { objectLocations: extra.objectLocations }),
      storage: storageRows()
    };
  };
  const systemSource = runtimeSystemSource(systemState);
  const relationNames = Array.from(new Set([
    ...(dataSource.relationNames ?? []),
    ...runtimeSystemRelationList.map((relationRef) => relationRef.name)
  ]));
  const isSystemRelation = (relationRef: RelationRef): boolean => runtimeSystemRelationNameSet.has(relationRef.name);
  const systemRows = (relationRef: RelationRef): readonly unknown[] => {
    switch (relationRef.name) {
      case runtimeSystemRelations.sources.name:
        return sourceRows();
      case runtimeSystemRelations.diagnostics.name:
        return diagnosticRows();
      case runtimeSystemRelations.peers.name:
        return peerRows();
      case runtimeSystemRelations.sync.name:
        return syncRows();
      case runtimeSystemRelations.conflicts.name:
        return conflictRows();
      case runtimeSystemRelations.history.name:
        return historyRows();
      case runtimeSystemRelations.objectLocations.name:
        return objectLocationRows();
      case runtimeSystemRelations.storage.name:
        return storageRows();
      case runtimeSystemRelations.interests.name:
        return interestRows();
      default:
        return systemSource.rows(relationRef);
    }
  };

  return {
    relationNames,
    rows: (relationRef) => isSystemRelation(relationRef)
      ? systemRows(relationRef)
      : dataSource.rows(relationRef),
    lookup: (lookup) => isSystemRelation(lookup.relation)
      ? systemRows(lookup.relation).filter((row) => isRecord(row)
        && relationFieldLookupMatches(lookup.relation.fields[lookup.field], row[lookup.field], lookup.value))
      : dataSource.lookup?.(lookup) ?? dataSource.rows(lookup.relation)
        .filter((row) => isRecord(row)
          && relationFieldLookupMatches(lookup.relation.fields[lookup.field], row[lookup.field], lookup.value)),
    rangeLookup: (lookup) => isSystemRelation(lookup.relation)
      ? systemRows(lookup.relation).filter((row) => isRecord(row)
        && relationFieldValueInRange(lookup.relation.fields[lookup.field], row[lookup.field], lookup.lower, lookup.upper))
      : dataSource.rangeLookup?.(lookup) ?? dataSource.rows(lookup.relation)
        .filter((row) => isRecord(row)
          && relationFieldValueInRange(lookup.relation.fields[lookup.field], row[lookup.field], lookup.lower, lookup.upper)),
    version: () => dataSource.version?.() ?? Automerge.getHeads(getDoc()),
    ...(dataSource.diagnostics === undefined ? {} : { diagnostics: dataSource.diagnostics })
  };
}

function hasRuntimeHistoryInterest(interests: ReadonlyMap<string, RuntimeInterestRow>): boolean {
  for (const interest of interests.values()) {
    if (
      interest.state === 'active'
      && interest.relationNames.includes(runtimeSystemRelations.history.name)
    ) {
      return true;
    }
  }

  return false;
}

function automergeHistoryRows<DocumentShape extends object>(
  doc: Automerge.Doc<DocumentShape>,
  runtimeId: string,
  documentId?: string
): readonly RuntimeHistoryRow[] {
  return Automerge.getHistory(doc).map(({ change }): RuntimeHistoryRow => ({
    id: `${runtimeId}:history:${change.hash}`,
    runtime: runtimeId,
    ...(documentId === undefined ? {} : { documentId }),
    hash: change.hash,
    actor: change.actor,
    ...(change.message === null ? {} : { message: change.message }),
    ...(Number.isFinite(change.time) ? { time: change.time } : {}),
    deps: change.deps,
    detail: {
      seq: change.seq,
      startOp: change.startOp,
      opCount: change.ops.length
    }
  }));
}

function createAutomergeRepoSystemState<DocumentShape extends object>(options: {
  readonly repo: Repo;
  readonly handle: DocHandle<DocumentShape>;
  readonly runtimeId: string;
  readonly getDoc: () => Automerge.Doc<DocumentShape>;
  readonly notify: (notification?: RelationRuntimeNotification) => void;
}): AutomergeRepoSystemState {
  const remoteStorageIds = new Set<string>();
  let localStorageId: string | undefined;
  let storageError: string | undefined;
  let lastStorageMetric: AutomergeRepoStorageMetric | undefined;

  const peerStorageIds = () => {
    const ids: string[] = [];
    for (const peerId of options.repo.peers) {
      const storageId = peerMetadataFor(options.repo, peerId)?.storageId;
      if (storageId !== undefined) ids.push(String(storageId));
    }
    return ids;
  };
  const readStorageId = () => {
    if (options.repo.storageSubsystem === undefined) return;
    options.repo.storageId()
      .then((storageId) => {
        if (storageId === undefined || localStorageId === String(storageId)) return;
        localStorageId = String(storageId);
        options.notify({ relationNames: [runtimeSystemRelations.storage.name] });
      })
      .catch((error: unknown) => {
        storageError = error instanceof Error ? error.message : String(error);
        options.notify({ relationNames: [runtimeSystemRelations.storage.name] });
      });
  };
  const onRemoteHeads = (payload: DocHandleRemoteHeadsPayload) => {
    remoteStorageIds.add(String(payload.storageId));
    options.notify({ relationNames: [runtimeSystemRelations.sync.name] });
  };
  const onPeer = () => {
    for (const storageId of peerStorageIds()) remoteStorageIds.add(storageId);
    options.notify({ relationNames: [runtimeSystemRelations.peers.name, runtimeSystemRelations.sync.name] });
  };
  const onStorageMetric = (metric: unknown) => {
    if (!isRepoStorageMetric(metric) || metric.documentId !== String(options.handle.documentId)) return;
    lastStorageMetric = metric;
    options.notify({ relationNames: [runtimeSystemRelations.storage.name] });
  };

  for (const storageId of peerStorageIds()) remoteStorageIds.add(storageId);
  readStorageId();
  options.handle.on('remote-heads', onRemoteHeads);
  options.repo.networkSubsystem.on('peer', onPeer);
  options.repo.networkSubsystem.on('peer-disconnected', onPeer);
  options.repo.on('doc-metrics', onStorageMetric);

  return {
    state: () => ({
      peers: runtimePeerRowsFromRepo(options.repo, options.runtimeId),
      sync: runtimeSyncRowsFromRepo({
        repo: options.repo,
        handle: options.handle,
        runtimeId: options.runtimeId,
        localHeads: safeAutomergeHeads(options.getDoc),
        storageIds: Array.from(new Set([...peerStorageIds(), ...remoteStorageIds]))
      }),
      storage: runtimeStorageRowsFromRepo({
        repo: options.repo,
        runtimeId: options.runtimeId,
        localStorageId,
        storageError,
        lastStorageMetric
      })
    }),
    close: () => {
      options.handle.off('remote-heads', onRemoteHeads);
      options.repo.networkSubsystem.off('peer', onPeer);
      options.repo.networkSubsystem.off('peer-disconnected', onPeer);
      options.repo.off('doc-metrics', onStorageMetric);
    }
  };
}

function runtimePeerRowsFromRepo(repo: Repo, runtime: string): readonly RuntimePeerRow[] {
  return repo.peers.map((peerId): RuntimePeerRow => {
    const metadata = peerMetadataFor(repo, peerId);
    return {
      id: `${runtime}:peer:${String(peerId)}`,
      runtime,
      peerId: String(peerId),
      state: 'connected',
      connected: true,
      ...(metadata?.isEphemeral === undefined ? {} : { ephemeral: metadata.isEphemeral }),
      ...(metadata === undefined || Object.keys(metadata).length === 0 ? {} : { detail: { metadata } })
    };
  });
}

function runtimeSyncRowsFromRepo<DocumentShape extends object>(options: {
  readonly repo: Repo;
  readonly handle: DocHandle<DocumentShape>;
  readonly runtimeId: string;
  readonly localHeads: readonly string[] | undefined;
  readonly storageIds: readonly string[];
}): readonly RuntimeSyncRow[] {
  return options.storageIds.map((storageId): RuntimeSyncRow => {
    const syncInfo = options.handle.getSyncInfo(storageId as StorageId);
    const peerId = peerIdForStorageId(options.repo, storageId);
    return {
      id: `${options.runtimeId}:sync:remote:${storageId}`,
      runtime: options.runtimeId,
      state: syncInfo === undefined ? 'unknown' : 'synced',
      documentId: String(options.handle.documentId),
      storageId,
      ...(peerId === undefined ? {} : { peerId }),
      ...(options.localHeads === undefined ? {} : { localHeads: options.localHeads }),
      ...(syncInfo?.lastHeads === undefined ? {} : { remoteHeads: [...syncInfo.lastHeads] }),
      ...(syncInfo?.lastSyncTimestamp === undefined ? {} : { updatedAt: syncInfo.lastSyncTimestamp }),
      detail: {
        source: 'automerge.repo.getSyncInfo'
      }
    };
  });
}

function runtimeStorageRowsFromRepo(options: {
  readonly repo: Repo;
  readonly runtimeId: string;
  readonly localStorageId: string | undefined;
  readonly storageError: string | undefined;
  readonly lastStorageMetric: AutomergeRepoStorageMetric | undefined;
}): readonly RuntimeStorageRow[] {
  if (options.repo.storageSubsystem === undefined) return [];

  const storage = options.localStorageId ?? 'automerge.repo.storage';
  return [{
    id: `${options.runtimeId}:storage:${storage}`,
    runtime: options.runtimeId,
    storage,
    state: options.storageError !== undefined ? 'failed' : options.lastStorageMetric === undefined ? 'idle' : 'synced',
    durability: 'durable',
    ...(options.storageError === undefined ? {} : { lastError: options.storageError }),
    detail: {
      source: 'automerge.repo.storageSubsystem',
      ...(options.localStorageId === undefined ? {} : { storageId: options.localStorageId }),
      ...(options.lastStorageMetric === undefined ? {} : { lastCompleted: options.lastStorageMetric })
    }
  }];
}

function peerMetadataFor(repo: Repo, peerId: unknown): PeerMetadata | undefined {
  return repo.peerMetadataByPeerId[String(peerId) as keyof Repo['peerMetadataByPeerId']];
}

function peerIdForStorageId(repo: Repo, storageId: string): string | undefined {
  for (const peerId of repo.peers) {
    if (String(peerMetadataFor(repo, peerId)?.storageId) === storageId) return String(peerId);
  }

  return undefined;
}

function safeAutomergeHeads<DocumentShape extends object>(
  getDoc: () => Automerge.Doc<DocumentShape>
): readonly string[] | undefined {
  try {
    return Automerge.getHeads(getDoc());
  } catch {
    return undefined;
  }
}

function isRepoStorageMetric(input: unknown): input is AutomergeRepoStorageMetric {
  if (!isRecord(input) || typeof input.type !== 'string' || typeof input.documentId !== 'string') return false;
  return input.type === 'doc-loaded' || input.type === 'doc-saved' || input.type === 'doc-compacted';
}

function decodeRelationRow(relation: RelationRef, row: Row): Row {
  const decoded: Row = {};
  for (const [fieldName, value] of Object.entries(row)) {
    decoded[fieldName] = relationFieldReadValue(relation.fields[fieldName], cloneValue(value));
  }
  return decoded;
}

function decodedFieldLookupMatches(spec: FieldSpec | undefined, fieldValue: unknown, lookupValue: unknown): boolean {
  if (spec?.valueKind !== 'custom' || spec.custom?.toScalar === undefined) {
    return relationFieldLookupMatches(spec, fieldValue, lookupValue);
  }
  if (Object.is(fieldValue, lookupValue)) return true;
  if (!relationFieldValueMatchesSpec(spec, lookupValue)) return false;
  return Object.is(fieldValue, relationFieldReadValue(spec, lookupValue));
}

function decodedFieldValueInRange(
  spec: FieldSpec | undefined,
  fieldValue: unknown,
  lower: RelationRangeLookup['lower'],
  upper: RelationRangeLookup['upper']
): boolean {
  if (lower !== undefined) {
    const comparisonValue = decodedFieldCompareToBound(spec, fieldValue, lower.value);
    if (comparisonValue === undefined || comparisonValue < 0 || (comparisonValue === 0 && !lower.inclusive)) return false;
  }
  if (upper !== undefined) {
    const comparisonValue = decodedFieldCompareToBound(spec, fieldValue, upper.value);
    if (comparisonValue === undefined || comparisonValue > 0 || (comparisonValue === 0 && !upper.inclusive)) return false;
  }
  return true;
}

function decodedFieldCompareToBound(
  spec: FieldSpec | undefined,
  fieldValue: unknown,
  boundValue: unknown
): number | undefined {
  if (spec?.valueKind !== 'custom' || spec.custom?.toScalar === undefined) {
    return relationFieldCompareToBound(spec, fieldValue, boundValue);
  }
  const decodedBoundValue = relationFieldValueMatchesSpec(spec, boundValue)
    ? relationFieldReadValue(spec, boundValue)
    : boundValue;
  return compareValues(fieldValue, decodedBoundValue);
}

function customSpecForField(spec: FieldSpec | undefined): CustomFieldSpec | undefined {
  return spec !== undefined && (spec.valueKind as string) === 'custom'
    ? (spec as { readonly custom?: CustomFieldSpec }).custom
    : undefined;
}

function nativeAutomergeFieldKind(spec: FieldSpec | undefined): string | undefined {
  const custom = customSpecForField(spec);
  return custom === undefined
    ? undefined
    : (custom as Record<symbol, string | undefined>)[automergeNativeFieldKind] ?? nativeAutomergeFieldKindForCodec(custom.codec);
}

function nativeAutomergeFieldKindForCodec(codec: string): string | undefined {
  return codec === 'automerge.text' || codec === 'automerge.counter' ? codec : undefined;
}

function createMapSourceSnapshotCache<DocumentShape extends object>(
  getDoc: () => Automerge.Doc<DocumentShape>,
  relations: readonly AnyMapRelation[]
): AutomergeMapSourceSnapshotCache {
  let cached: AutomergeMapSourceSnapshot | undefined;

  return {
    current: () => {
      const doc = getDoc();
      const heads = Automerge.getHeads(doc);
      if (cached !== undefined && headsEqual(cached.heads, heads)) return cached;

      cached = mapSourceSnapshot(doc, heads, relations);
      return cached;
    }
  };
}

function mapSourceSnapshot<DocumentShape extends object>(
  doc: Automerge.Doc<DocumentShape>,
  heads: Automerge.Heads,
  relations: readonly AnyMapRelation[]
): AutomergeMapSourceSnapshot {
  const byRelation = new Map<string, {
    readonly relation: RelationRef;
    readonly rows: Row[];
    readonly equalityIndexes: Map<string, ReadonlyMap<string, readonly Row[]>>;
    readonly rangeIndexes: Map<string, readonly IndexedRangeRow[]>;
  }>();
  const diagnostics: TarstateDiagnostic[] = [];

  for (const mapping of relations) {
    const collection = mappedCollection(doc, mapping);
    diagnostics.push(...collection.diagnostics);

    let relationRows = byRelation.get(mapping.relation.name);
    if (relationRows === undefined) {
      relationRows = {
        relation: mapping.relation,
        rows: [],
        equalityIndexes: new Map(),
        rangeIndexes: new Map()
      };
      byRelation.set(mapping.relation.name, relationRows);
    }

    for (const row of collection.rows) relationRows.rows.push(decodeRelationRow(mapping.relation, row));
  }

  return {
    heads,
    byRelation,
    diagnostics
  };
}

function rowsForRelationSnapshot(
  snapshot: AutomergeMapSourceSnapshot,
  relationRef: RelationRef
): readonly Row[] {
  return mappedRowsForRelation(snapshot, relationRef)?.rows ?? [];
}

function lookupRowsForRelationSnapshot(
  snapshot: AutomergeMapSourceSnapshot,
  lookup: RelationLookup
): readonly Row[] {
  const relationRows = mappedRowsForRelation(snapshot, lookup.relation);
  if (relationRows === undefined) return [];

  const spec = lookup.relation.fields[lookup.field];
  const key = equalityIndexKey(spec, lookup.value);
  if (key === undefined) {
    return relationRows.rows.filter((row) =>
      decodedFieldLookupMatches(spec, row[lookup.field], lookup.value));
  }

  return equalityIndexFor(relationRows, lookup.field, spec).get(key) ?? [];
}

function rangeRowsForRelationSnapshot(
  snapshot: AutomergeMapSourceSnapshot,
  lookup: RelationRangeLookup
): readonly Row[] {
  const relationRows = mappedRowsForRelation(snapshot, lookup.relation);
  if (relationRows === undefined) return [];

  const spec = lookup.relation.fields[lookup.field];
  if (!canRangeIndex(spec)) {
    return relationRows.rows.filter((row) =>
      decodedFieldValueInRange(spec, row[lookup.field], lookup.lower, lookup.upper));
  }
  if (lookup.lower === undefined && lookup.upper === undefined) return relationRows.rows;

  const index = rangeIndexFor(relationRows, lookup.field, spec);
  if (index === undefined) {
    return relationRows.rows.filter((row) =>
      decodedFieldValueInRange(spec, row[lookup.field], lookup.lower, lookup.upper));
  }
  const lowerIndex = lookup.lower === undefined
    ? 0
    : lowerBoundRangeIndex(index, spec, lookup.lower.value, lookup.lower.inclusive);
  const upperIndex = lookup.upper === undefined
    ? index.length
    : upperBoundRangeIndex(index, spec, lookup.upper.value, lookup.upper.inclusive);

  const entries: IndexedRangeRow[] = [];
  for (let indexValue = lowerIndex; indexValue < upperIndex; indexValue += 1) {
    const entry = index[indexValue];
    if (entry !== undefined && decodedFieldValueInRange(spec, entry.row[lookup.field], lookup.lower, lookup.upper)) {
      entries.push(entry);
    }
  }
  entries.sort((left, right) => left.ordinal - right.ordinal);
  return entries.map((entry) => entry.row);
}

function mappedRowsForRelation(
  snapshot: AutomergeMapSourceSnapshot,
  relationRef: RelationRef
): MappedRelationRows | undefined {
  return snapshot.byRelation.get(relationRef.name);
}

function equalityIndexFor(
  relationRows: MappedRelationRows,
  field: string,
  spec: FieldSpec | undefined
): ReadonlyMap<string, readonly Row[]> {
  const existing = relationRows.equalityIndexes.get(field);
  if (existing !== undefined) return existing;

  const mutable = new Map<string, Row[]>();
  for (const row of relationRows.rows) {
    const key = equalityIndexKey(spec, row[field]);
    if (key === undefined) continue;

    const bucket = mutable.get(key);
    if (bucket === undefined) mutable.set(key, [row]);
    else bucket.push(row);
  }

  relationRows.equalityIndexes.set(field, mutable);
  return mutable;
}

function equalityIndexKey(
  spec: FieldSpec | undefined,
  value: unknown
): string | undefined {
  const custom = customSpecForField(spec);
  if (custom?.compare !== undefined) return undefined;
  if (custom?.toScalar !== undefined) return objectIsIndexKey(value);
  if (custom?.stableKey !== undefined) return `custom:${custom.stableKey(value)}`;
  return objectIsIndexKey(value);
}

function objectIsIndexKey(value: unknown): string | undefined {
  if (value === undefined) return 'undefined';
  if (value === null) return 'null';
  switch (typeof value) {
    case 'string':
      return `string:${value}`;
    case 'number':
      if (Number.isNaN(value)) return 'number:NaN';
      return Object.is(value, -0) ? 'number:-0' : `number:${value}`;
    case 'boolean':
      return `boolean:${value}`;
    case 'bigint':
      return `bigint:${value.toString()}`;
    default:
      return undefined;
  }
}

function canRangeIndex(spec: FieldSpec | undefined): boolean {
  const custom = customSpecForField(spec);
  return custom === undefined || custom.compare !== undefined || custom.toScalar !== undefined;
}

function rangeIndexFor(
  relationRows: MappedRelationRows,
  field: string,
  spec: FieldSpec | undefined
): readonly IndexedRangeRow[] | undefined {
  const existing = relationRows.rangeIndexes.get(field);
  if (existing !== undefined) return existing;
  if (relationRows.rows.some((row) => !hasStableRangeComparison(spec, row[field]))) return undefined;

  const index = relationRows.rows
    .map((row, ordinal): IndexedRangeRow => ({ row, ordinal, value: row[field] }))
    .sort((left, right) => compareRangeRows(spec, left, right));
  relationRows.rangeIndexes.set(field, index);
  return index;
}

function compareRangeRows(spec: FieldSpec | undefined, left: IndexedRangeRow, right: IndexedRangeRow): number {
  const compared = decodedFieldCompareToBound(spec, left.value, right.value) ?? 0;
  return compared === 0 ? left.ordinal - right.ordinal : compared;
}

function hasStableRangeComparison(spec: FieldSpec | undefined, value: unknown): boolean {
  const compared = decodedFieldCompareToBound(spec, value, value);
  return compared !== undefined && Number.isFinite(compared);
}

function lowerBoundRangeIndex(
  index: readonly IndexedRangeRow[],
  spec: FieldSpec | undefined,
  value: unknown,
  inclusive: boolean
): number {
  let low = 0;
  let high = index.length;
  while (low < high) {
    const mid = low + Math.floor((high - low) / 2);
    const compared = decodedFieldCompareToBound(spec, index[mid]?.value, value) ?? 0;
    if (compared < 0 || (compared === 0 && !inclusive)) low = mid + 1;
    else high = mid;
  }
  return low;
}

function upperBoundRangeIndex(
  index: readonly IndexedRangeRow[],
  spec: FieldSpec | undefined,
  value: unknown,
  inclusive: boolean
): number {
  let low = 0;
  let high = index.length;
  while (low < high) {
    const mid = low + Math.floor((high - low) / 2);
    const compared = decodedFieldCompareToBound(spec, index[mid]?.value, value) ?? 0;
    if (compared < 0 || (compared === 0 && inclusive)) low = mid + 1;
    else high = mid;
  }
  return low;
}

function objectIdForRelation<DocumentShape extends object>(
  doc: Automerge.Doc<DocumentShape>,
  relations: readonly AnyMapRelation[],
  relationRef: RelationRef,
  keyValue: unknown
): Automerge.ObjID | null {
  const keyLookup = relationKeyLookupFor(relationRef, keyValue);
  if (keyLookup === undefined) return null;

  for (const mapping of relations) {
    if (mapping.relation.name !== relationRef.name) continue;

    const lookup = getPathValue(doc, mapping.path);
    if (lookup.status !== 'found') continue;

    if (isRecord(lookup.value)) {
      const objectId = objectIdForMapKey(mapping.relation, lookup.value, keyLookup);
      if (objectId !== undefined) return objectId;
    }

    const values = Array.isArray(lookup.value)
      ? lookup.value
      : isRecord(lookup.value)
        ? Object.values(lookup.value)
        : [];
    for (const value of values) {
      if (currentRowKey(mapping.relation, value) === keyLookup.rowKey) return Automerge.getObjectId(value);
    }
  }

  return null;
}

function objectIdForMapKey(
  relation: RelationRef,
  values: Record<string, unknown>,
  keyLookup: RelationKeyLookup
): Automerge.ObjID | undefined {
  if (!Object.prototype.hasOwnProperty.call(values, keyLookup.storageKey)) return undefined;

  const value = values[keyLookup.storageKey];
  if (currentRowKey(relation, value) !== keyLookup.rowKey) return undefined;

  return Automerge.getObjectId(value) ?? undefined;
}

function automergeObjectLocationRows<DocumentShape extends object>(
  doc: Automerge.Doc<DocumentShape>,
  options: AutomergeObjectLocationOptions<DocumentShape>
): readonly AutomergeObjectLocation[] {
  const heads = options.heads ?? Automerge.getHeads(doc);
  const relations = options.relations ?? [];
  const rows: AutomergeObjectLocation[] = [];
  const seen = new Set<Automerge.ObjID>();

  const visit = (
    value: unknown,
    path: readonly Automerge.Prop[],
    parentObjectId?: Automerge.ObjID,
    prop?: Automerge.Prop
  ): void => {
    const objectId = Automerge.getObjectId(value);
    if (objectId === null || seen.has(objectId)) return;

    seen.add(objectId);
    const mapped = mappedObjectLocation(relations, path, value);
    rows.push({
      objectId,
      path: [...path],
      ...(parentObjectId === undefined ? {} : { parentObjectId }),
      ...(prop === undefined ? {} : { prop }),
      ...(options.documentId === undefined ? {} : { documentId: options.documentId }),
      ...(options.branch === undefined ? {} : { branch: options.branch }),
      ...(heads.length === 0 ? {} : { heads }),
      ...(mapped === undefined ? {} : mapped),
      ...(options.detail === undefined ? {} : { detail: options.detail })
    });

    if (Array.isArray(value)) {
      for (const [index, item] of value.entries()) {
        visit(item, [...path, index], objectId, index);
      }
      return;
    }

    if (!isRecord(value)) return;

    for (const [key, item] of Object.entries(value)) {
      visit(item, [...path, key], objectId, key);
    }
  };

  visit(doc, []);
  return rows;
}

function createObjectLocationSnapshotCache<DocumentShape extends object>(
  getDoc: () => Automerge.Doc<DocumentShape>,
  relations: readonly AutomergeMapRelation<RelationRef, DocumentShape>[],
  runtimeId: string
): AutomergeObjectLocationSnapshotCache {
  let cached: AutomergeObjectLocationSnapshot | undefined;

  return {
    current: () => {
      const doc = getDoc();
      const heads = Automerge.getHeads(doc);
      if (cached !== undefined && headsEqual(cached.heads, heads)) return cached;

      const locations = automergeObjectLocationRows(doc, { heads, relations });
      const locationByObjectId = new Map(locations.map((location) => [location.objectId, location]));
      cached = {
        heads,
        locationByObjectId,
        runtimeRows: runtimeObjectLocationRowsFromLocations(locations, runtimeId)
      };

      return cached;
    }
  };
}

function pathForObjectIdFromSnapshot(
  snapshot: AutomergeObjectLocationSnapshot,
  objectId: Automerge.ObjID
): AutomergeObjectPath | null {
  const location = snapshot.locationByObjectId.get(objectId);
  return location === undefined ? null : [...location.path];
}

function runtimeObjectLocationRowsFromLocations(
  locations: readonly AutomergeObjectLocation[],
  runtime: string
): readonly RuntimeObjectLocationRow[] {
  return locations.map((location): RuntimeObjectLocationRow => ({
    id: `${runtime}:object:${location.objectId}`,
    runtime,
    objectId: location.objectId,
    path: formatRuntimeObjectPath(location.path),
    pathSegments: location.path,
    ...(location.parentObjectId === undefined ? {} : { parentObjectId: location.parentObjectId }),
    ...(location.prop === undefined ? {} : { prop: location.prop }),
    ...(location.documentId === undefined ? {} : { documentId: location.documentId }),
    ...(location.branch === undefined ? {} : { branch: location.branch }),
    ...(location.heads === undefined ? {} : { heads: location.heads }),
    ...(location.relation === undefined ? {} : { relation: location.relation }),
    ...(location.key === undefined ? {} : { key: location.key }),
    ...(location.detail === undefined ? {} : { detail: location.detail })
  }));
}

function runtimeConflictRowsForMappedRelations<DocumentShape extends object>(
  doc: Automerge.Doc<DocumentShape>,
  relations: readonly AutomergeMapRelation<RelationRef, DocumentShape>[],
  runtime: string,
  documentId?: string
): readonly RuntimeConflictRow[] {
  const rows: RuntimeConflictRow[] = [];

  for (const mapping of relations) {
    const lookup = getPathValue(doc, mapping.path);
    if (lookup.status !== 'found') continue;

    const entries = Array.isArray(lookup.value)
      ? lookup.value.map((value, index) => ({ path: [...mapping.path, index] as readonly Automerge.Prop[], value }))
      : isRecord(lookup.value)
        ? Object.entries(lookup.value).map(([key, value]) => ({ path: [...mapping.path, key] as readonly Automerge.Prop[], value }))
        : [];

    for (const entry of entries) {
      if (!isRecord(entry.value)) continue;

      const key = relationKeyValue(mapping.relation, entry.value);
      for (const fieldName of Object.keys(mapping.relation.fields)) {
        const path = [...entry.path, fieldName] as unknown as AutomergePropertyPath;
        const conflicts = automergeConflictsAt(doc, path);
        if (conflicts.length === 0) continue;

        const fieldSpec = mapping.relation.fields[fieldName];
        const pathText = formatRuntimeObjectPath(path);
        rows.push({
          id: `${runtime}:conflict:${pathText}`,
          runtime,
          path: pathText,
          ...(documentId === undefined ? {} : { documentId }),
          relation: mapping.relation.name,
          field: fieldName,
          conflictCount: conflicts.length,
          values: conflicts.map((conflict) => relationFieldReadValue(fieldSpec, conflict.value)),
          detail: {
            pathSegments: path,
            ...(key === undefined ? {} : { key }),
            conflicts
          }
        });
      }
    }
  }

  return rows;
}

function mappedObjectLocation(
  relations: readonly AnyMapRelation[],
  path: readonly Automerge.Prop[],
  value: unknown
): MappedObjectLocation | undefined {
  if (!isRecord(value)) return undefined;

  for (const mapping of relations) {
    if (!isDirectChildPath(mapping.path, path)) continue;

    const key = relationKeyValue(mapping.relation, value);
    return key === undefined
      ? { relation: mapping.relation.name }
      : { relation: mapping.relation.name, key };
  }

  return undefined;
}

function relationKeyValue(relation: RelationRef, row: Row): unknown {
  const keyValues = relationKeyFields(relation)
    .map((fieldName) => relationFieldKeyValue(relation.fields[fieldName], row[fieldName]));

  return keyValues.some((value) => value === undefined || value === null)
    ? undefined
    : keyValues.length === 1
      ? keyValues[0]
      : keyValues;
}

function isDirectChildPath(parent: readonly string[], child: readonly Automerge.Prop[]): boolean {
  return child.length === parent.length + 1
    && parent.every((segment, index) => child[index] === segment);
}

function stagedSourceFor(context: PatchEvaluationContext): AdapterSource<Automerge.Heads> {
  const relationNames = relationNamesFor(context.relations);

  return {
    relationNames,
    rows: (relationRef) => stagedRowsForRelation(context, relationRef),
    lookup: (lookup) => stagedRowsForRelation(context, lookup.relation)
      .filter((row) => decodedFieldLookupMatches(lookup.relation.fields[lookup.field], row[lookup.field], lookup.value)),
    rangeLookup: (lookup) => stagedRowsForRelation(context, lookup.relation)
      .filter((row) => decodedFieldValueInRange(lookup.relation.fields[lookup.field], row[lookup.field], lookup.lower, lookup.upper)),
    version: () => Automerge.getHeads(context.doc),
    diagnostics: () => context.relations.flatMap((mapping) =>
      context.plans.has(mapping.relation.name) ? [] : mappedCollection(context.doc, mapping).diagnostics)
  };
}

function stagedRowsForRelation(context: PatchEvaluationContext, relationRef: RelationRef): readonly Row[] {
  const plan = context.plans.get(relationRef.name);
  return plan === undefined
    ? context.relations
      .filter((mapping) => mapping.relation.name === relationRef.name)
      .flatMap((mapping) => mappedCollection(context.doc, mapping).rows
        .map((row) => decodeRelationRow(mapping.relation, row)))
    : plan.rows.map((row) => decodeRelationRow(relationRef, row));
}

function mappedCollection<DocumentShape extends object>(
  doc: Automerge.Doc<DocumentShape>,
  mapping: AnyMapRelation
): MappedCollection {
  // Relation scan order is unspecified, matching Relic semantics; consumers that
  // need stable ordering must express it in the query, e.g. with ORDER BY.
  const lookup = getPathValue(doc, mapping.path);

  if (lookup.status !== 'found') {
    return {
      rows: [],
      kind: 'map',
      diagnostics: [invalidPathDiagnostic(mapping, lookup)]
    };
  }
  if (Array.isArray(lookup.value)) {
    const rows = lookup.value.filter(isRecord).map(cloneRow);

    return {
      rows,
      kind: 'array',
      diagnostics: validateCollectionRows(mapping.relation, rows)
    };
  }
  if (isRecord(lookup.value)) {
    const rows = Object.values(lookup.value).filter(isRecord).map(cloneRow);

    return {
      rows,
      kind: 'map',
      diagnostics: validateCollectionRows(mapping.relation, rows)
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
): RowPlanResult {
  const existing = plans.get(mapping.relation.name);
  if (existing !== undefined) return { plan: existing, diagnostics: [] };

  const collection = mappedCollection(doc, mapping);
  if (collection.diagnostics.length > 0) return { diagnostics: collection.diagnostics };

  const plan: RowPlan = {
    mapping,
    kind: collection.kind,
    before: collection.rows,
    nativeCounterIncrements: [],
    rows: collection.rows,
    changed: false
  };
  plans.set(mapping.relation.name, plan);

  return { plan, diagnostics: [] };
}

function applyPatchToPlan(plan: RowPlan, patch: WritePatch, context: PatchEvaluationContext): PatchOutcome {
  switch (patch.op) {
    case 'insert':
      return insertRow(plan, patch.row, 'reject');
    case 'insertIgnore':
      return insertRow(plan, patch.row, 'ignore');
    case 'insertOrReplace':
      return upsertRow(plan, patch.row, () => patch.row);
    case 'insertOrMerge':
      return upsertRow(plan, patch.row, (current, incoming) => mergeRows(current, incoming, patch.merge, plan, context));
    case 'insertOrUpdate':
      return upsertRow(plan, patch.row, (current, incoming) => rowUpdateFor(current, patch.update ?? incoming, plan, context));
    case 'updateByKey':
      return updateRowByKey(plan, patch.key, patch.changes, context);
    case 'incrementByKey':
      return incrementRowByKey(plan, patch.key, patch.field, patch.amount, context);
    case 'update':
      return updateRowsByPredicate(plan, patch.predicate, patch.changes, context);
    case 'deleteByKey':
      return deleteRowByKey(plan, patch.key);
    case 'delete':
      return deleteRowsByPredicate(plan, patch.predicate, context);
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

  const key = relationRowKey(plan.mapping.relation, row);
  if (key === undefined) return rejected(rowKeyDiagnostic(plan.mapping.relation.name, row));

  if (plan.rows.some((item) => relationRowKeyMatchesRow(plan.mapping.relation, item, row))) {
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

  const key = relationRowKey(plan.mapping.relation, row);
  if (key === undefined) return rejected(rowKeyDiagnostic(plan.mapping.relation.name, row));

  const index = plan.rows.findIndex((item) => relationRowKeyMatchesRow(plan.mapping.relation, item, row));
  if (index === -1) {
    plan.rows = [...plan.rows, row];
    plan.changed = true;
    return accepted(true);
  }

  const next = nextRow(cloneRow(plan.rows[index] ?? row), cloneRow(row));
  let merged: Row | undefined;
  let expressionDiagnostics: readonly TarstateDiagnostic[] = [];
  if (isRowUpdateResult(next)) {
    expressionDiagnostics = next.diagnostics;
    if (hasErrorDiagnostics(expressionDiagnostics)) return rejected(...expressionDiagnostics);
    if (!next.supported) {
      return rejected(...expressionDiagnostics, unsupportedUpdateExpressionDiagnostic(plan.mapping.relation.name, next.op));
    }
    merged = next.row;
  } else {
    merged = coerceRow(next);
  }
  if (merged === undefined) return rejected(rowInvalidDiagnostic(plan.mapping.relation.name, rowValue));
  const mergedDiagnostics = validatePlanRow(plan, merged);
  if (mergedDiagnostics.length > 0) return rejected(...expressionDiagnostics, ...mergedDiagnostics);

  const mergedKey = relationRowKey(plan.mapping.relation, merged);
  if (mergedKey !== key) return rejected(...expressionDiagnostics, rowKeyDiagnostic(plan.mapping.relation.name, merged));
  if (valuesEqual(plan.rows[index], merged)) return accepted(false, expressionDiagnostics);

  plan.rows = replaceAt(plan.rows, index, merged);
  plan.changed = true;
  return accepted(true, expressionDiagnostics);
}

function updateRowByKey(plan: RowPlan, keyValue: unknown, changes: unknown, context: PatchEvaluationContext): PatchOutcome {
  const key = relationKeyInputKey(plan.mapping.relation, keyValue);
  if (key === undefined) return rejected(rowKeyDiagnostic(plan.mapping.relation.name, keyValue));
  const keyInput = keyValue as RelationKeyInput;

  const index = plan.rows.findIndex((item) => relationKeyInputMatchesRow(plan.mapping.relation, keyInput, item));
  if (index === -1) return accepted(false);

  const current = plan.rows[index];
  if (current === undefined) return accepted(false);

  const updateResult = rowUpdateFor(current, changes, plan, context);
  if (hasErrorDiagnostics(updateResult.diagnostics)) return rejected(...updateResult.diagnostics);
  if (!updateResult.supported) {
    return rejected(...updateResult.diagnostics, unsupportedUpdateExpressionDiagnostic(plan.mapping.relation.name, updateResult.op));
  }

  const updated = updateResult.row;
  if (updated === undefined) return rejected(...updateResult.diagnostics, rowInvalidDiagnostic(plan.mapping.relation.name, changes));
  const updateDiagnostics = validatePlanRow(plan, updated);
  if (updateDiagnostics.length > 0) return rejected(...updateResult.diagnostics, ...updateDiagnostics);
  if (!relationKeyInputMatchesRow(plan.mapping.relation, keyInput, updated)) {
    return rejected(...updateResult.diagnostics, rowKeyDiagnostic(plan.mapping.relation.name, updated));
  }
  if (valuesEqual(current, updated)) return accepted(false, updateResult.diagnostics);

  plan.rows = replaceAt(plan.rows, index, updated);
  plan.changed = true;
  return accepted(true, updateResult.diagnostics);
}

function incrementRowByKey(
  plan: RowPlan,
  keyValue: unknown,
  fieldName: string,
  amount: number,
  context: PatchEvaluationContext
): PatchOutcome {
  const relation = plan.mapping.relation;
  const key = relationKeyInputKey(relation, keyValue);
  if (key === undefined) return rejected(rowKeyDiagnostic(relation.name, keyValue));
  const keyInput = keyValue as RelationKeyInput;

  const fieldSpec = relation.fields[fieldName];
  if (fieldSpec === undefined) {
    return rejected(fieldInvalidDiagnostic(
      relation.name,
      fieldName,
      `relation "${relation.name}" does not define field "${fieldName}"`,
      fieldName
    ));
  }
  if (nativeAutomergeFieldKind(fieldSpec) !== 'automerge.counter') {
    return rejected(fieldInvalidDiagnostic(
      relation.name,
      fieldName,
      `relation "${relation.name}" field "${fieldName}" must be an Automerge counter field`,
      fieldName
    ));
  }
  if (typeof amount !== 'number' || !Number.isFinite(amount)) {
    return rejected(fieldInvalidDiagnostic(
      relation.name,
      fieldName,
      `increment amount for relation "${relation.name}" field "${fieldName}" must be a finite number`,
      amount
    ));
  }

  const index = plan.rows.findIndex((item) => relationKeyInputMatchesRow(relation, keyInput, item));
  if (index === -1) return rejected(rowMissingForIncrementDiagnostic(relation, keyValue, fieldName));

  const current = plan.rows[index];
  if (current === undefined) return rejected(rowMissingForIncrementDiagnostic(relation, keyValue, fieldName));
  if (!Object.prototype.hasOwnProperty.call(current, fieldName) || current[fieldName] === undefined) {
    return rejected(fieldMissingDiagnostic(relation.name, fieldName));
  }

  const currentValue = current[fieldName];
  const currentNumber = Number(currentValue);
  if (!Number.isFinite(currentNumber)) {
    return rejected(fieldInvalidDiagnostic(
      relation.name,
      fieldName,
      `relation "${relation.name}" field "${fieldName}" must contain a finite number before it can be incremented`,
      currentValue
    ));
  }

  const nativeRow = nativeRowForPlanKey(context.doc, plan, key);
  const nativeValue = nativeRow?.[fieldName];
  if (!Automerge.isCounter(nativeValue)) {
    return rejected(fieldInvalidDiagnostic(
      relation.name,
      fieldName,
      `relation "${relation.name}" field "${fieldName}" must be stored as an Automerge Counter before native increment can be applied`,
      nativeValue
    ));
  }

  const nextValue = currentNumber + amount;
  if (!Number.isFinite(nextValue)) {
    return rejected(fieldInvalidDiagnostic(
      relation.name,
      fieldName,
      `increment result for relation "${relation.name}" field "${fieldName}" must be finite`,
      nextValue
    ));
  }

  const next = { ...current, [fieldName]: nextValue };
  if (relationKeyFields(relation).includes(fieldName) && !relationKeyInputMatchesRow(relation, keyInput, next)) {
    return rejected(fieldInvalidDiagnostic(
      relation.name,
      fieldName,
      `incrementing relation "${relation.name}" key field "${fieldName}" would change row identity`,
      next
    ));
  }

  const nextDiagnostics = validatePlanRow(plan, next);
  if (nextDiagnostics.length > 0) return rejected(...nextDiagnostics);
  if (valuesEqual(current, next)) return accepted(false);

  plan.rows = replaceAt(plan.rows, index, next);
  plan.changed = true;
  recordNativeCounterIncrement(plan, key, fieldName, amount);
  return accepted(true);
}

function updateRowsByPredicate(
  plan: RowPlan,
  predicate: PredicateData,
  changes: unknown,
  context: PatchEvaluationContext
): PatchOutcome {
  const matches = matchingIndexes(plan.rows, predicate, plan, context);
  if (hasErrorDiagnostics(matches.diagnostics)) return rejected(...matches.diagnostics);
  if (!matches.supported) {
    return rejected(...matches.diagnostics, unsupportedPredicateDiagnostic(plan.mapping.relation.name, matches.op));
  }
  if (matches.indexes.length === 0) return accepted(false);

  const nextRows = [...plan.rows];
  let changed = false;
  const diagnostics = [...matches.diagnostics];

  for (const index of matches.indexes) {
    const current = nextRows[index];
    if (current === undefined) continue;

    const updateResult = rowUpdateFor(current, changes, plan, context);
    diagnostics.push(...updateResult.diagnostics);
    if (hasErrorDiagnostics(updateResult.diagnostics)) return rejected(...diagnostics);
    if (!updateResult.supported) {
      return rejected(...diagnostics, unsupportedUpdateExpressionDiagnostic(plan.mapping.relation.name, updateResult.op));
    }

    const updated = updateResult.row;
    const updateDiagnostics = validatePlanRow(plan, updated);
    if (updateDiagnostics.length > 0) return rejected(...diagnostics, ...updateDiagnostics);
    if (!relationRowKeyMatchesRow(plan.mapping.relation, updated, current)) {
      return rejected(...diagnostics, rowKeyDiagnostic(plan.mapping.relation.name, updated));
    }
    if (!valuesEqual(current, updated)) {
      nextRows[index] = updated;
      changed = true;
    }
  }

  if (!changed) return accepted(false, diagnostics);
  plan.rows = nextRows;
  plan.changed = true;
  return accepted(true, diagnostics);
}

function deleteRowByKey(plan: RowPlan, keyValue: unknown): PatchOutcome {
  const key = relationKeyInputKey(plan.mapping.relation, keyValue);
  if (key === undefined) return rejected(rowKeyDiagnostic(plan.mapping.relation.name, keyValue));
  const keyInput = keyValue as RelationKeyInput;

  const nextRows = plan.rows.filter((item) => !relationKeyInputMatchesRow(plan.mapping.relation, keyInput, item));
  if (nextRows.length === plan.rows.length) return accepted(false);

  plan.rows = nextRows;
  plan.changed = true;
  return accepted(true);
}

function deleteRowsByPredicate(plan: RowPlan, predicate: PredicateData, context: PatchEvaluationContext): PatchOutcome {
  const matches = matchingIndexes(plan.rows, predicate, plan, context);
  if (hasErrorDiagnostics(matches.diagnostics)) return rejected(...matches.diagnostics);
  if (!matches.supported) {
    return rejected(...matches.diagnostics, unsupportedPredicateDiagnostic(plan.mapping.relation.name, matches.op));
  }
  if (matches.indexes.length === 0) return accepted(false, matches.diagnostics);

  const matchSet = new Set(matches.indexes);
  plan.rows = plan.rows.filter((_, index) => !matchSet.has(index));
  plan.changed = true;
  return accepted(true, matches.diagnostics);
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

    const key = relationRowKey(plan.mapping.relation, row);
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

function mergeRows(
  current: Row,
  incoming: Row,
  merge: unknown,
  plan: RowPlan,
  context: PatchEvaluationContext
): RowUpdateResult {
  if (Array.isArray(merge)) {
    return {
      supported: true,
      row: {
        ...current,
        ...Object.fromEntries(merge.map((field) => [String(field), incoming[String(field)]]))
      },
      diagnostics: []
    };
  }
  if (typeof merge === 'function') {
    const baseline = cloneRow(current);
    return rowUpdateFor(baseline, merge(cloneRow(current), cloneRow(incoming)), plan, context);
  }
  return rowUpdateFor(current, incoming, plan, context);
}

function rowUpdateFor(
  current: Row,
  changes: unknown,
  plan: RowPlan,
  context: PatchEvaluationContext
): RowUpdateResult {
  const update = typeof changes === 'function'
    ? changes(cloneRow(current))
    : changes;

  if (!isRecord(update)) {
    return {
      supported: false,
      diagnostics: [updateInvalidDiagnostic(plan.mapping.relation.name, update)]
    };
  }

  const evaluated = evaluateUpdateMap(update, current, plan, context);
  if (!evaluated.supported) return evaluated;

  return { supported: true, row: { ...current, ...evaluated.row }, diagnostics: evaluated.diagnostics };
}

function evaluateUpdateMap(
  update: Record<string, unknown>,
  current: Row,
  plan: RowPlan,
  context: PatchEvaluationContext
): RowUpdateResult {
  const evaluated: MutableRecord = {};
  const diagnostics: TarstateDiagnostic[] = [];

  for (const [fieldName, fieldValue] of Object.entries(update)) {
    if (!isExprData(fieldValue)) {
      evaluated[fieldName] = cloneValue(fieldValue);
      continue;
    }

    const result = evaluateExpr(fieldValue, current, plan.mapping.relation, context);
    diagnostics.push(...(result.diagnostics ?? []));
    if (hasErrorDiagnostics(result.diagnostics ?? [])) return { supported: false, op: fieldValue.op, diagnostics };
    if (!result.supported) return unsupportedRowUpdateResult(result.op, diagnostics);
    evaluated[fieldName] = cloneValue(result.value);
  }

  return { supported: true, row: evaluated, diagnostics };
}

function isRowUpdateResult(input: unknown): input is RowUpdateResult {
  return isRecord(input)
    && typeof input.supported === 'boolean'
    && (input.supported === false || 'row' in input || 'op' in input);
}

function matchingIndexes(
  rows: readonly Row[],
  predicate: PredicateData,
  plan: RowPlan,
  context: PatchEvaluationContext
): MatchingIndexesResult {
  const indexes: number[] = [];
  const diagnostics: TarstateDiagnostic[] = [];

  for (const [index, row] of rows.entries()) {
    const result = evaluateExpr(predicate, row, plan.mapping.relation, context);
    diagnostics.push(...(result.diagnostics ?? []));
    if (hasErrorDiagnostics(result.diagnostics ?? [])) return unsupportedMatchingIndexesResult(exprResultOp(result), diagnostics);
    if (!result.supported) return result.op === undefined
      ? { supported: false, diagnostics }
      : unsupportedMatchingIndexesResult(result.op, diagnostics);
    if (result.value === true) indexes.push(index);
  }

  return { supported: true, indexes, diagnostics };
}

function evaluateExpr(
  expr: unknown,
  row: Row,
  relation: RelationRef,
  context: PatchEvaluationContext
): ExprEvalResult {
  if (!isRecord(expr) || typeof expr.op !== 'string') return { supported: true, value: expr };

  switch (expr.op) {
    case 'value':
      return { supported: true, value: expr.value };
    case 'env':
      return typeof expr.name === 'string'
        ? { supported: true, value: context.env()?.[expr.name] }
        : { supported: true, value: undefined };
    case 'field':
      return typeof expr.field === 'string'
        ? { supported: true, value: rowValueForFieldExpr(row, relation, expr) }
        : { supported: false, op: expr.op };
    case 'self':
      return { supported: true, value: row };
    case 'maybe':
      return evaluateExpr(expr.expr, row, relation, context);
    case 'tuple':
      return evaluateTuple(expr.values, row, relation, context);
    case 'call':
      return evaluateCall(expr, row, relation, context);
    case 'sel':
    case 'sel1':
      return evaluateSelectionExpr(expr, row, context);
    case 'eq':
    case 'neq':
    case 'lt':
    case 'lte':
    case 'gt':
    case 'gte':
      return evaluateComparison(expr.op, expr.left, expr.right, row, relation, context);
    case 'and':
      return evaluateAnd(expr.predicates, row, relation, context);
    case 'or':
      return evaluateOr(expr.predicates, row, relation, context);
    case 'not': {
      const result = evaluateExpr(expr.predicate, row, relation, context);
      return result.supported ? supportedExpr(result.value !== true, result.diagnostics) : result;
    }
    case 'isNull': {
      const result = evaluateExpr(expr.expr, row, relation, context);
      return result.supported ? supportedExpr(result.value === null, result.diagnostics) : result;
    }
    case 'notNull': {
      const result = evaluateExpr(expr.expr, row, relation, context);
      return result.supported ? supportedExpr(result.value !== null && result.value !== undefined, result.diagnostics) : result;
    }
    case 'isMissing': {
      const result = evaluateExpr(expr.expr, row, relation, context);
      return result.supported ? supportedExpr(result.value === undefined, result.diagnostics) : result;
    }
    case 'notMissing': {
      const result = evaluateExpr(expr.expr, row, relation, context);
      return result.supported ? supportedExpr(result.value !== undefined, result.diagnostics) : result;
    }
    default:
      return { supported: false, op: expr.op };
  }
}

function evaluateTuple(
  input: unknown,
  row: Row,
  relation: RelationRef,
  context: PatchEvaluationContext
): ExprEvalResult {
  return evaluateExprList(input, 'tuple', row, relation, context);
}

function evaluateCall(
  expr: Record<string, unknown>,
  row: Row,
  relation: RelationRef,
  context: PatchEvaluationContext
): ExprEvalResult {
  const fn = expr.fn;
  if (!isHostFunction(fn)) return { supported: false, op: 'call' };
  const argsResult = evaluateExprList(expr.args, 'call', row, relation, context);
  if (!argsResult.supported) return argsResult;

  return {
    supported: true,
    value: fn.fn(...(argsResult.value as unknown[])),
    diagnostics: argsResult.diagnostics ?? []
  };
}

function evaluateExprList(
  input: unknown,
  op: string,
  row: Row,
  relation: RelationRef,
  context: PatchEvaluationContext
): ExprEvalResult {
  if (!Array.isArray(input)) return { supported: false, op };

  const values: unknown[] = [];
  const diagnostics: TarstateDiagnostic[] = [];
  for (const item of input) {
    const result = evaluateExpr(item, row, relation, context);
    diagnostics.push(...(result.diagnostics ?? []));
    if (hasErrorDiagnostics(result.diagnostics ?? [])) return unsupportedExprResult(exprResultOp(result), diagnostics);
    if (!result.supported) return result;
    values.push(result.value);
  }

  return { supported: true, value: values, diagnostics };
}

function evaluateSelectionExpr(expr: Record<string, unknown>, row: Row, context: PatchEvaluationContext): ExprEvalResult {
  const query = queryForSelectionExpr(expr);
  if (query === undefined) return { supported: true, value: expr.op === 'sel1' ? undefined : [] };

  const envValue = context.env();
  const result = evaluate(stagedSourceFor(context), query, envValue === undefined ? {} : { env: envValue });
  if (hasErrorDiagnostics(result.diagnostics)) {
    return unsupportedExprResult(typeof expr.op === 'string' ? expr.op : undefined, result.diagnostics);
  }

  const rows = result.rows.filter((inner) => correlationMatches(expr.correlation, row, inner));
  return {
    supported: true,
    value: expr.op === 'sel1' ? rows[0] : rows,
    diagnostics: result.diagnostics
  };
}

function evaluateComparison(
  op: string,
  leftExpr: unknown,
  rightExpr: unknown,
  row: Row,
  relation: RelationRef,
  context: PatchEvaluationContext
): ExprEvalResult {
  const left = evaluateExpr(leftExpr, row, relation, context);
  if (!left.supported) return left;

  const right = evaluateExpr(rightExpr, row, relation, context);
  if (!right.supported) return right;
  const diagnostics = [...(left.diagnostics ?? []), ...(right.diagnostics ?? [])];
  if (hasErrorDiagnostics(diagnostics)) return { supported: false, op, diagnostics };

  switch (op) {
    case 'eq':
      return { supported: true, value: valuesEqual(left.value, right.value), diagnostics };
    case 'neq':
      return { supported: true, value: !valuesEqual(left.value, right.value), diagnostics };
    case 'lt':
      return { supported: true, value: compareValues(left.value, right.value) < 0, diagnostics };
    case 'lte':
      return { supported: true, value: compareValues(left.value, right.value) <= 0, diagnostics };
    case 'gt':
      return { supported: true, value: compareValues(left.value, right.value) > 0, diagnostics };
    case 'gte':
      return { supported: true, value: compareValues(left.value, right.value) >= 0, diagnostics };
    default:
      return { supported: false, op };
  }
}

function evaluateAnd(
  input: unknown,
  row: Row,
  relation: RelationRef,
  context: PatchEvaluationContext
): ExprEvalResult {
  return evaluateBooleanList(input, 'and', false, row, relation, context);
}

function evaluateOr(
  input: unknown,
  row: Row,
  relation: RelationRef,
  context: PatchEvaluationContext
): ExprEvalResult {
  return evaluateBooleanList(input, 'or', true, row, relation, context);
}

function evaluateBooleanList(
  input: unknown,
  op: 'and' | 'or',
  shortCircuitValue: boolean,
  row: Row,
  relation: RelationRef,
  context: PatchEvaluationContext
): ExprEvalResult {
  if (!Array.isArray(input)) return { supported: false, op };

  const diagnostics: TarstateDiagnostic[] = [];
  for (const item of input) {
    const result = evaluateExpr(item, row, relation, context);
    diagnostics.push(...(result.diagnostics ?? []));
    if (hasErrorDiagnostics(result.diagnostics ?? [])) return unsupportedExprResult(exprResultOp(result), diagnostics);
    if (!result.supported) return result;
    if ((result.value === true) === shortCircuitValue) return { supported: true, value: shortCircuitValue, diagnostics };
  }

  return { supported: true, value: !shortCircuitValue, diagnostics };
}

function supportedExpr(value: unknown, diagnostics: readonly TarstateDiagnostic[] | undefined): ExprEvalResult {
  return diagnostics === undefined ? { supported: true, value } : { supported: true, value, diagnostics };
}

function unsupportedExprResult(op: string | undefined, diagnostics: readonly TarstateDiagnostic[]): ExprEvalResult {
  return op === undefined
    ? { supported: false, diagnostics }
    : { supported: false, op, diagnostics };
}

function unsupportedRowUpdateResult(op: string | undefined, diagnostics: readonly TarstateDiagnostic[]): RowUpdateResult {
  return op === undefined
    ? { supported: false, diagnostics }
    : { supported: false, op, diagnostics };
}

function unsupportedMatchingIndexesResult(
  op: string | undefined,
  diagnostics: readonly TarstateDiagnostic[]
): MatchingIndexesResult {
  return op === undefined
    ? { supported: false, diagnostics }
    : { supported: false, op, diagnostics };
}

function accepted(applied: boolean, diagnostics: readonly TarstateDiagnostic[] = []): PatchOutcome {
  return { accepted: true, applied, diagnostics };
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
  return new Map(rows.map((row, index) => [relationRowKey(relation, row) ?? `row:${index}:${stableStringify(row)}`, row]));
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

function valueAtPropertyPath(
  root: unknown,
  path: readonly Automerge.Prop[]
): { readonly found: true; readonly value: unknown } | { readonly found: false } {
  let current = root;

  for (const segment of path) {
    if (current === undefined || current === null) return { found: false };
    if (Array.isArray(current)) {
      if (typeof segment !== 'number') return { found: false };
      current = current[segment];
      continue;
    }
    if (!isRecord(current)) return { found: false };

    current = current[segment];
  }

  return current === undefined
    ? { found: false }
    : { found: true, value: current };
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
      if (current[arrayItem] === undefined || current[arrayItem] === null) return;
      current = current[arrayItem];
      continue;
    }

    if (!isRecord(current)) return;
    const record = current as MutableRecord;

    if (isLeaf) {
      record[segment] = value;
      return;
    }

    if (record[segment] === undefined || record[segment] === null) return;
    current = record[segment];
  }
}

function applyRowsToDraft(root: unknown, plan: RowPlan): void {
  const lookup = getPathValue(root, plan.mapping.path);
  if (lookup.status !== 'found') {
    setPathValue(root, plan.mapping.path, encodeRows(plan.rows, plan.mapping.relation, plan.kind));
    return;
  }

  if (plan.kind === 'array' && Array.isArray(lookup.value)) {
    applyArrayRowsToDraft(root, lookup.value, plan);
    return;
  }

  if (plan.kind === 'map' && isRecord(lookup.value)) {
    applyMapRowsToDraft(root, lookup.value, plan);
    return;
  }

  setPathValue(root, plan.mapping.path, encodeRows(plan.rows, plan.mapping.relation, plan.kind));
}

function applyMapRowsToDraft(root: unknown, collection: Record<string, unknown>, plan: RowPlan): void {
  const desired = new Map(plan.rows.map((row) => [storageKeyForRow(plan.mapping.relation, row), row]));

  for (const key of Object.keys(collection)) {
    const row = desired.get(key);
    if (row === undefined) {
      delete collection[key];
      continue;
    }

    const current = collection[key];
    if (isRecord(current)) {
      patchRowObject(root, [...plan.mapping.path, key], plan, current, row);
    } else {
      collection[key] = encodeRow(row, plan.mapping.relation);
    }
    desired.delete(key);
  }

  for (const [key, row] of desired) {
    collection[key] = encodeRow(row, plan.mapping.relation);
  }
}

function applyArrayRowsToDraft(root: unknown, collection: unknown[], plan: RowPlan): void {
  if (!arrayRowsCanBePatchedWithoutMoving(collection, plan)) {
    setPathValue(root, plan.mapping.path, encodeRows(plan.rows, plan.mapping.relation, plan.kind));
    return;
  }

  const desiredKeys = new Set(plan.rows.map((row) => relationRowKey(plan.mapping.relation, row)));
  for (let index = collection.length - 1; index >= 0; index -= 1) {
    const rowKey = currentRowKey(plan.mapping.relation, collection[index]);
    if (rowKey === undefined || !desiredKeys.has(rowKey)) {
      Automerge.deleteAt(collection, index, 1);
    }
  }

  for (const [index, row] of plan.rows.entries()) {
    const current = collection[index];
    if (currentRowKey(plan.mapping.relation, current) !== relationRowKey(plan.mapping.relation, row)) {
      Automerge.insertAt(collection, index, encodeRow(row, plan.mapping.relation));
      continue;
    }

    if (isRecord(current)) {
      patchRowObject(root, [...plan.mapping.path, index], plan, current, row);
    } else {
      collection[index] = encodeRow(row, plan.mapping.relation);
    }
  }
}

function arrayRowsCanBePatchedWithoutMoving(collection: readonly unknown[], plan: RowPlan): boolean {
  const currentKeys = collection.map((row) => currentRowKey(plan.mapping.relation, row));
  const desiredKeys = plan.rows.map((row) => relationRowKey(plan.mapping.relation, row));
  const currentKeySet = new Set(currentKeys.filter((key): key is string => key !== undefined));
  const desiredKeySet = new Set(desiredKeys.filter((key): key is string => key !== undefined));
  const keptCurrentKeys = currentKeys.filter((key): key is string => key !== undefined && desiredKeySet.has(key));
  const keptDesiredKeys = desiredKeys.filter((key): key is string => key !== undefined && currentKeySet.has(key));

  return keptCurrentKeys.length === keptDesiredKeys.length
    && keptCurrentKeys.every((key, index) => key === keptDesiredKeys[index]);
}

function patchRowObject(
  root: unknown,
  rowPath: readonly Automerge.Prop[],
  plan: RowPlan,
  target: Record<string, unknown>,
  row: Row
): void {
  const relation = plan.mapping.relation;
  const rowKey = relationRowKey(relation, row);

  for (const key of Object.keys(target)) {
    if (!Object.prototype.hasOwnProperty.call(row, key)) delete target[key];
  }

  for (const [key, value] of Object.entries(row)) {
    const spec = relation.fields[key];
    if (fieldValuesEqual(spec, target[key], value)) continue;
    if (updateTextFieldValue(root, [...rowPath, key], spec, target[key], value)) continue;
    const incrementAmount = rowKey === undefined ? undefined : nativeCounterIncrementAmount(plan, rowKey, key);
    if (
      incrementAmount !== undefined
      && applyNativeCounterIncrement(spec, target, key, incrementAmount)
      && fieldValuesEqual(spec, target[key], value)
    ) {
      continue;
    }
    target[key] = fieldWriteValue(spec, value);
  }
}

function fieldValuesEqual(spec: FieldSpec | undefined, current: unknown, next: unknown): boolean {
  return valuesEqual(relationFieldReadValue(spec, current), next);
}

function updateTextFieldValue(
  root: unknown,
  path: readonly Automerge.Prop[],
  spec: FieldSpec | undefined,
  current: unknown,
  next: unknown
): boolean {
  if (nativeAutomergeFieldKind(spec) !== 'automerge.text') return false;
  // Automerge 3.2.6 updateText targets string/text objects by path; ImmutableString is a scalar and throws.
  if (typeof current !== 'string' || typeof next !== 'string') return false;

  Automerge.updateText(root as Automerge.Doc<unknown>, [...path], next);
  return true;
}

function currentRowKey(relation: RelationRef, input: unknown): string | undefined {
  return isRecord(input) ? relationRowKey(relation, input) : undefined;
}

function nativeRowForPlanKey(doc: unknown, plan: RowPlan, key: string): Record<string, unknown> | undefined {
  const lookup = getPathValue(doc, plan.mapping.path);
  if (lookup.status !== 'found') return undefined;

  if (Array.isArray(lookup.value)) {
    return lookup.value.find((item): item is Record<string, unknown> =>
      isRecord(item) && currentRowKey(plan.mapping.relation, item) === key);
  }

  if (isRecord(lookup.value)) {
    return Object.values(lookup.value).find((item): item is Record<string, unknown> =>
      isRecord(item) && currentRowKey(plan.mapping.relation, item) === key);
  }

  return undefined;
}

function recordNativeCounterIncrement(plan: RowPlan, rowKey: string, field: string, amount: number): void {
  if (amount === 0) return;
  const existing = plan.nativeCounterIncrements.find((increment) =>
    increment.rowKey === rowKey && increment.field === field);
  if (existing === undefined) {
    plan.nativeCounterIncrements.push({ rowKey, field, amount });
  } else {
    existing.amount += amount;
  }
}

function nativeCounterIncrementAmount(plan: RowPlan, rowKey: string, field: string): number | undefined {
  const amount = plan.nativeCounterIncrements
    .filter((increment) => increment.rowKey === rowKey && increment.field === field)
    .reduce((sum, increment) => sum + increment.amount, 0);

  return amount === 0 ? undefined : amount;
}

function applyNativeCounterIncrement(
  spec: FieldSpec | undefined,
  target: Record<string, unknown>,
  field: string,
  amount: number
): boolean {
  if (nativeAutomergeFieldKind(spec) !== 'automerge.counter') return false;
  const counter = target[field];
  if (!Automerge.isCounter(counter)) return false;

  counter.increment(amount);
  return true;
}

function validateCollectionRows(relation: RelationRef, rows: readonly Row[]): readonly TarstateDiagnostic[] {
  return rows.flatMap((row) => validateRelationRow(relation, row));
}

function encodeRows(rows: readonly Row[], relation: RelationRef, kind: StorageKind): unknown {
  if (kind === 'array') return rows.map((row) => encodeRow(row, relation));

  return Object.fromEntries(rows.map((row) => [storageKeyForRow(relation, row), encodeRow(row, relation)]));
}

function encodeRow(row: Row, relation: RelationRef): Row {
  return Object.fromEntries(Object.entries(row).map(([fieldName, value]) => [
    fieldName,
    fieldWriteValue(relation.fields[fieldName], value)
  ]));
}

function fieldWriteValue(spec: FieldSpec | undefined, value: unknown): unknown {
  const custom = customSpecForField(spec);
  if (custom?.fromScalar === undefined || value === null || value === undefined) return cloneValue(value);
  return custom.fromScalar(value);
}

function coerceRow(input: unknown): Row | undefined {
  return isRecord(input) ? cloneRow(input) : undefined;
}

function validatePlanRow(plan: RowPlan, row: Row): readonly TarstateDiagnostic[] {
  return validateRelationRow(plan.mapping.relation, row);
}

function cloneRow(input: Record<string, unknown>): Row {
  return Object.fromEntries(Object.entries(input).map(([key, value]) => [key, cloneValue(value)]));
}

function cloneValue(input: unknown): unknown {
  if (Array.isArray(input)) return input.map(cloneValue);
  if (isRecord(input) && isPlainObjectLike(input)) return cloneRow(input);
  return input;
}

function relationKeyLookupFor(relation: RelationRef, keyValue: unknown): RelationKeyLookup | undefined {
  const rowKey = relationKeyInputKey(relation, keyValue);
  if (rowKey === undefined) return undefined;

  const values = relationKeyInputValues(relation, keyValue);
  if (values === undefined) return undefined;

  return {
    rowKey,
    storageKey: storageKeyForValues(values)
  };
}

function storageKeyForValues(values: readonly unknown[]): string {
  if (values.length === 1) {
    const value = values[0];
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value);
  }

  return stableKey(values);
}

function storageKeyForRow(relation: RelationRef, row: Row): string {
  const values = relationKeyFields(relation).map((field) => relationFieldKeyValue(relation.fields[field], row[field]));
  return storageKeyForValues(values);
}

function relationNamesFor(relations: readonly { readonly relation: RelationRef }[]): readonly string[] {
  return Array.from(new Set(relations.map((mapping) => mapping.relation.name)));
}

function relationRefFor(input: RelationRef | AutomergeMapRelation): RelationRef {
  return 'path' in input ? input.relation : input;
}

function uniqueRelationRefs(relations: readonly RelationRef[]): readonly RelationRef[] {
  const byName = new Map<string, RelationRef>();

  for (const relation of relations) {
    if (!byName.has(relation.name)) byName.set(relation.name, relation);
  }

  return Array.from(byName.values());
}

function automergeMapEnv(input: AutomergeMapEnvInput | undefined): EvaluateEnv | undefined {
  return typeof input === 'function' ? input() : input;
}

function rowValueForFieldExpr(row: Row, relation: RelationRef, expr: Record<string, unknown>): unknown {
  const fieldName = typeof expr.field === 'string' ? expr.field : undefined;
  if (fieldName === undefined) return undefined;

  const alias = typeof expr.alias === 'string' ? expr.alias : 'row';
  return rowLocalAliases(relation).includes(alias)
    ? relationFieldReadValue(relation.fields[fieldName], row[fieldName])
    : undefined;
}

function rowLocalAliases(relation: RelationRef): readonly string[] {
  return ['row', relation.name, ...relationPredicateAliases(relation.name)];
}

function relationPredicateAliases(relationName: string): readonly string[] {
  if (relationName.endsWith('ies')) return [relationName.slice(0, -3) + 'y'];
  if (relationName.endsWith('s') && relationName.length > 1) return [relationName.slice(0, -1)];
  return [];
}

function queryForSelectionExpr(expr: Record<string, unknown>): Query<unknown> | undefined {
  if (!isRecord(expr.query)) return undefined;

  return {
    data: expr.query as Query['data'],
    relations: (isRecord(expr.relations) ? expr.relations : {}) as Query['relations']
  };
}

function correlationMatches(correlation: unknown, outer: Row, inner: unknown): boolean {
  if (!isRecord(correlation)) return true;
  if (!isRecord(inner)) return false;

  return Object.entries(correlation).every(([outerField, innerField]) =>
    typeof innerField === 'string' && Object.is(outer[outerField], inner[innerField]));
}

function hasErrorDiagnostics(diagnostics: readonly TarstateDiagnostic[]): boolean {
  return diagnostics.some((diagnostic) => diagnostic.severity === 'error');
}

function exprResultOp(result: ExprEvalResult): string | undefined {
  return result.supported ? undefined : result.op;
}

function isExprData(input: unknown): input is Record<string, unknown> & { readonly op: string } {
  return isRecord(input) && typeof input.op === 'string';
}

function isHostFunction(input: unknown): input is { readonly fn: (...args: readonly unknown[]) => unknown } {
  return isRecord(input) && input.kind === 'hostFunction' && typeof input.fn === 'function';
}

function rowsExactlyMatch(left: Row, right: Row): boolean {
  return stableKey(left) === stableKey(right);
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

function formatAutomergePath(path: readonly Automerge.Prop[]): string {
  return path.map((segment) => typeof segment === 'number' ? `[${segment}]` : segment).join('.');
}

function formatRuntimeObjectPath(path: readonly Automerge.Prop[]): string {
  return path.length === 0 ? '$' : formatAutomergePath(path);
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

function updateInvalidDiagnostic(relation: string, update: unknown): TarstateDiagnostic {
  return {
    code: 'row_invalid',
    severity: 'error',
    relation,
    surface: 'automergeMapAdapter',
    message: `Automerge map adapter expected an object update for relation "${relation}"`,
    detail: update
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

function rowMissingForIncrementDiagnostic(relation: RelationRef, key: unknown, field: string): TarstateDiagnostic {
  return {
    code: 'row_invalid',
    severity: 'error',
    relation: relation.name,
    field,
    surface: 'automergeMapAdapter',
    message: `relation "${relation.name}" does not contain a row for increment key ${String(relationKeyInputKey(relation, key) ?? '<invalid>')}`,
    detail: key
  };
}

function fieldMissingDiagnostic(relation: string, field: string): TarstateDiagnostic {
  return {
    code: 'field_missing',
    severity: 'error',
    relation,
    field,
    surface: 'automergeMapAdapter',
    message: `relation "${relation}" row is missing required field "${field}"`
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
