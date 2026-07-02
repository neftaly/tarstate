import type { TarstateDiagnostic } from './diagnostics.js';
import type { RelationRuntime } from './adapter.js';
import type { RelationDelta } from './delta.js';
import { diffRows, type RowChange, type RowDiffDiagnostic, type RowDiffOptions } from './diff.js';
import { evaluate } from './evaluate.js';
import type { EvaluateOptions } from './evaluate.js';
import { forkDb, type Db } from './db.js';
import {
  demat,
  maintainMaterializations,
  mat,
  materializationForQuery,
  queryRowsFromMaterialization,
  type MaterializationMaintenanceChange,
  type MaterializationMaintenanceResult,
  type SnapshotMaterializationTarget
} from './materialization.js';
import { queryKey, queryRowKeyFields, type Query } from './query.js';
import type { RelationRef } from './schema.js';
import { type RelationSource } from './source.js';
import { asRelationSource, tryRelationSource, type RelationSourceInput } from './source-input.js';

export type WatchDb = RelationSourceInput;

export type WatchDiagnostic = {
  readonly code:
    | 'watch_unsupported'
    | 'change_tracking_unsupported'
    | 'watch_already_closed'
    | 'watch_listener_error';
  readonly message: string;
  readonly surface: 'watch' | 'changeTracking';
  readonly detail?: unknown;
};
export type WatchRuntimeDiagnostic<Row = unknown> = WatchDiagnostic | TarstateDiagnostic | RowDiffDiagnostic<Row>;

export type ChangeSet = {
  readonly deltas?: readonly RelationDelta[];
  readonly diagnostics: readonly WatchDiagnostic[];
};

export type WatchTarget<Row = unknown> = Query<Row> | RelationRef;
export type WatchEvent<Row = unknown> = {
  readonly kind: 'watchEvent';
  readonly id: string;
  readonly targetKey: string;
  readonly target: WatchTarget<Row>;
  readonly changed: boolean;
  readonly previousRows: readonly Row[];
  readonly rows: readonly Row[];
  readonly added: readonly Row[];
  readonly removed: readonly Row[];
  readonly unchanged: readonly Row[];
  readonly rowChanges: readonly RowChange<Row>[];
  readonly changes: ChangeSet;
  readonly diagnostics: readonly WatchRuntimeDiagnostic<Row>[];
};
export type WatchListener<Row = unknown> = (event: WatchEvent<Row>) => void | Promise<void>;
export type WatchOptions<Row = unknown> = EvaluateOptions & RowDiffOptions<Row> & {
  readonly label?: string;
  readonly immediate?: boolean;
};
export type WatchRefreshResult<Row = unknown> = {
  readonly kind: 'watchRefresh';
  readonly id: string;
  readonly targetKey: string;
  readonly target: WatchTarget<Row>;
  readonly delivered: boolean;
  readonly changed: boolean;
  readonly previousRows: readonly Row[];
  readonly rows: readonly Row[];
  readonly added: readonly Row[];
  readonly removed: readonly Row[];
  readonly unchanged: readonly Row[];
  readonly rowChanges: readonly RowChange<Row>[];
  readonly diagnostics: readonly WatchRuntimeDiagnostic<Row>[];
};
export type WatchUnsubscribeResult = {
  readonly kind: 'watchUnsubscribe';
  readonly id: string;
  readonly unsubscribed: boolean;
  readonly diagnostics: readonly WatchDiagnostic[];
};
export type WatchSubscription = {
  readonly kind: 'watchSubscription';
  readonly id: string;
  readonly active: boolean;
  readonly diagnostics: readonly WatchDiagnostic[];
  readonly unsubscribe: () => WatchUnsubscribeResult;
};
export type WatchTargetRegistration<Db extends WatchDb = WatchDb, Row = unknown> = {
  readonly kind: 'watchTarget';
  readonly db: Db;
  readonly target: WatchTarget<Row>;
  readonly handle: WatchHandle<Db, Row>;
  readonly supported: boolean;
  readonly diagnostics: readonly WatchDiagnostic[];
  readonly unwatch: () => UnwatchResult;
  readonly label?: string;
};
export type WatchHandle<Db extends WatchDb = WatchDb, Row = unknown> = {
  readonly kind: 'watch';
  readonly id: string;
  readonly db: Db;
  readonly target: WatchTarget<Row>;
  readonly supported: boolean;
  readonly mode: 'db';
  readonly diagnostics: readonly WatchDiagnostic[];
  readonly refresh: (nextDb?: Db | RelationSource) => Promise<WatchRefreshResult<Row>>;
  readonly unwatch: () => UnwatchResult;
  readonly label?: string;
};
export type RuntimeWatchHandle<Row = unknown> = WatchHandle<RelationSource, Row>;
export type UnwatchResult = {
  readonly kind: 'unwatch';
  readonly id: string;
  readonly closed: boolean;
  readonly diagnostics: readonly WatchDiagnostic[];
};
export type TrackedChange<Row = unknown> = {
  readonly kind: 'trackedChange';
  readonly id: string;
  readonly targetKey: string;
  readonly target: WatchTarget<Row>;
  readonly changed: boolean;
  readonly previousRows: readonly Row[];
  readonly rows: readonly Row[];
  readonly added: readonly Row[];
  readonly removed: readonly Row[];
  readonly unchanged: readonly Row[];
  readonly rowChanges: readonly RowChange<Row>[];
  readonly diagnostics: readonly WatchRuntimeDiagnostic[];
};
export type WatchTargetChange<Row = unknown> = {
  readonly kind: 'watchTargetChange';
  readonly id: string;
  readonly targetKey: string;
  readonly target: WatchTarget<Row>;
  readonly changed: boolean;
  readonly added: readonly Row[];
  readonly removed: readonly Row[];
  readonly unchanged: readonly Row[];
  readonly rowChanges: readonly RowChange<Row>[];
  readonly diagnostics: readonly WatchRuntimeDiagnostic[];
};
export type WatchChangeMap<Row = unknown> = ReadonlyMap<WatchTarget<Row>, WatchTargetChange<Row>>;
export type WatchChangeKeyMap<Row = unknown> = ReadonlyMap<string, WatchTargetChange<Row>>;
export type QueryDiffOptions<Row = unknown> = EvaluateOptions & RowDiffOptions<Row>;
export type QueryDiffDiagnostic<Row = unknown> = TarstateDiagnostic | RowDiffDiagnostic<Row>;
export type QueryDiff<Row = unknown> = {
  readonly kind: 'queryDiff';
  readonly target: Query<Row>;
  readonly queryKey: string;
  readonly beforeVersion?: unknown;
  readonly afterVersion?: unknown;
  readonly beforeRows: readonly Row[];
  readonly afterRows: readonly Row[];
  readonly changed: boolean;
  readonly added: readonly Row[];
  readonly removed: readonly Row[];
  readonly unchanged: readonly Row[];
  readonly rowChanges: readonly RowChange<Row>[];
  readonly diagnostics: readonly QueryDiffDiagnostic<Row>[];
};

type WatchRecord<Db extends WatchDb = WatchDb, Row = unknown> = {
  db: Db;
  readonly id: string;
  readonly target: WatchTarget<Row>;
  readonly listeners: Set<WatchListener<Row>>;
  readonly options: WatchOptions<Row>;
  readonly dbTracked: boolean;
  active: boolean;
  handle?: WatchHandle<Db, Row>;
};
type WatchMaterializationState<Row = unknown> = {
  readonly query: Query<Row>;
  readonly targetKey: string;
  readonly owners: Set<string>;
  readonly owned: boolean;
};

let nextId = 0;
type AnyWatchRecord = WatchRecord<any, any>;
const watchStore = new WeakMap<object, Set<AnyWatchRecord>>();
const allWatchRecords = new Map<string, AnyWatchRecord>();
const watchMaterializationStore = new WeakMap<object, Map<string, WatchMaterializationState>>();

export function watch<DbValue extends Db>(
  db: DbValue,
  ...targets: readonly WatchTarget[]
): DbValue;
export function watch<DbValue extends WatchDb, Row>(
  db: DbValue,
  target: WatchTarget<Row>,
  listener: WatchListener<Row> | undefined,
  options?: WatchOptions<Row>
): WatchHandle<DbValue, Row>;
export function watch(
  db: WatchDb,
  target: WatchTarget,
  ...rest: readonly (WatchTarget | WatchListener | WatchOptions | undefined)[]
): WatchDb | WatchHandle {
  if (isListenerWatchArgs(rest)) {
    return createWatchHandle(db, target, rest[0] as WatchListener | undefined, rest[1] as WatchOptions | undefined);
  }

  const nextDb = isDb(db) ? forkDb(db) : db;
  const targets = [target, ...rest.filter(isWatchTarget)];
  for (const nextTarget of targets) {
    addDbTrackedWatch(nextDb, nextTarget);
  }
  return nextDb;
}

function createWatchHandle<DbValue extends WatchDb, Row>(
  db: DbValue,
  target: WatchTarget<Row>,
  listener?: WatchListener<Row>,
  options: WatchOptions<Row> = {}
): WatchHandle<DbValue, Row> {
  const record: WatchRecord<DbValue, Row> = {
    db,
    id: `watch-${nextId += 1}`,
    target,
    listeners: listener === undefined ? new Set() : new Set([listener]),
    options,
    dbTracked: false,
    active: true
  };
  const handle = watchHandle(record);
  record.handle = handle;
  const storedRecord = record as AnyWatchRecord;
  addRecord(db, storedRecord);
  ensureWatchMaterialization(db, target, record.id, options);
  allWatchRecords.set(record.id, storedRecord);

  if (options.immediate === true) {
    void handle.refresh(db);
  }

  return handle;
}

export function watchTarget<Db extends WatchDb, Row>(
  db: Db,
  target: WatchTarget<Row>,
  options: WatchOptions<Row> = {}
): WatchTargetRegistration<Db, Row> {
  const handle = watch(db, target, undefined, options);
  return {
    kind: 'watchTarget',
    db,
    target,
    handle,
    supported: true,
    diagnostics: [],
    unwatch: handle.unwatch,
    ...(options.label === undefined ? {} : { label: options.label })
  };
}

export function unwatchTarget<Db extends WatchDb, Row>(
  registration: Pick<WatchTargetRegistration<Db, Row>, 'handle'> | Pick<WatchHandle<Db, Row>, 'id'>
): UnwatchResult {
  return unwatch('handle' in registration ? registration.handle : registration);
}

export function watchChangeMap<Row>(changes: Iterable<TrackedChange<Row>>): WatchChangeMap<Row> {
  const byTarget = new Map<WatchTarget<Row>, WatchTargetChange<Row>>();
  for (const change of changes) {
    const targetChange = watchTargetChange(change);
    const existing = byTarget.get(change.target);
    byTarget.set(change.target, existing === undefined
      ? targetChange
      : mergeWatchTargetChanges(existing, targetChange));
  }
  return byTarget;
}

export function watchChangeKeyMap<Row>(changes: Iterable<TrackedChange<Row>>): WatchChangeKeyMap<Row> {
  const byTargetKey = new Map<string, WatchTargetChange<Row>>();
  for (const change of changes) {
    const targetChange = watchTargetChange(change);
    const existing = byTargetKey.get(change.targetKey);
    byTargetKey.set(change.targetKey, existing === undefined
      ? targetChange
      : mergeWatchTargetChanges(existing, targetChange));
  }
  return byTargetKey;
}

export function watchTargetKey(target: WatchTarget): string {
  return watchTargetIdentity(target);
}

export function isWatchMaterialization(input: unknown, target: WatchTarget): boolean {
  if (!isQuery(target) || !isObject(input)) {
    return false;
  }

  return watchMaterializationStore.get(input)?.get(watchTargetIdentity(target))?.owned === true;
}

function watchTargetChange<Row>(change: TrackedChange<Row>): WatchTargetChange<Row> {
  return {
    kind: 'watchTargetChange',
    id: change.id,
    targetKey: change.targetKey,
    target: change.target,
    changed: change.changed,
    added: change.added,
    removed: change.removed,
    unchanged: change.unchanged,
    rowChanges: change.rowChanges,
    diagnostics: change.diagnostics
  };
}

function mergeWatchTargetChanges<Row>(
  left: WatchTargetChange<Row>,
  right: WatchTargetChange<Row>
): WatchTargetChange<Row> {
  return {
    kind: 'watchTargetChange',
    id: left.id,
    targetKey: left.targetKey,
    target: left.target,
    changed: left.changed || right.changed,
    added: [...left.added, ...right.added],
    removed: [...left.removed, ...right.removed],
    unchanged: [...left.unchanged, ...right.unchanged],
    rowChanges: [...left.rowChanges, ...right.rowChanges],
    diagnostics: [...left.diagnostics, ...right.diagnostics]
  };
}

export function watchRuntime<Version, Row>(
  runtime: RelationRuntime<Version>,
  target: WatchTarget<Row>,
  listener: WatchListener<Row>,
  options: WatchOptions<Row> = {}
): RuntimeWatchHandle<Row> {
  const source = runtime.snapshot?.().source ?? runtime.source;
  return watch(source, target, listener, options);
}

export function unwatch<DbValue extends Db>(
  db: DbValue,
  ...targets: readonly WatchTarget[]
): DbValue;
export function unwatch(handle: Pick<WatchHandle, 'id'>): UnwatchResult;
export function unwatch(
  handleOrDb: Db | Pick<WatchHandle, 'id'>,
  ...targets: readonly WatchTarget[]
): Db | UnwatchResult {
  if (isDb(handleOrDb) && targets.length > 0) {
    const nextDb = forkDb(handleOrDb);
    removeDbTrackedWatches(nextDb, targets);
    return nextDb;
  }

  const handle = handleOrDb as Pick<WatchHandle, 'id'>;
  const record = findRecord(handle.id);
  if (record !== undefined) {
    record.active = false;
    record.listeners.clear();
    releaseWatchMaterialization(record.db, record.target, record.id);
    removeRecord(record.db, record);
    allWatchRecords.delete(record.id);
  }

  return {
    kind: 'unwatch',
    id: handle.id,
    closed: record !== undefined,
    diagnostics: record === undefined
      ? [{ code: 'watch_already_closed', message: 'watch is already closed', surface: 'watch' }]
      : []
  };
}

export function subscribeWatch<Row>(
  handle: Pick<WatchHandle<WatchDb, Row>, 'id' | 'supported' | 'target'>,
  listener: WatchListener<Row>
): WatchSubscription {
  const record = findRecord(handle.id) as WatchRecord<WatchDb, Row> | undefined;
  if (!handle.supported || record === undefined || !record.active) {
    const diagnostics: readonly WatchDiagnostic[] = [
      { code: 'watch_already_closed', message: 'watch is already closed', surface: 'watch' }
    ];
    return {
      kind: 'watchSubscription',
      id: handle.id,
      active: false,
      diagnostics,
      unsubscribe: () => ({
        kind: 'watchUnsubscribe',
        id: handle.id,
        unsubscribed: false,
        diagnostics
      })
    };
  }

  let subscribed = true;
  record.listeners.add(listener);
  return {
    kind: 'watchSubscription',
    id: handle.id,
    active: true,
    diagnostics: [],
    unsubscribe: () => {
      const unsubscribed = unsubscribeWatchListener(record, listener, () => subscribed, (value) => {
        subscribed = value;
      });
      return {
        kind: 'watchUnsubscribe',
        id: handle.id,
        unsubscribed,
        diagnostics: unsubscribed || record.active
          ? []
          : [{ code: 'watch_already_closed', message: 'watch is already closed', surface: 'watch' }]
      };
    }
  };
}

export async function diffQuery<Row>(
  before: RelationSourceInput,
  after: RelationSourceInput,
  target: Query<Row>,
  options: QueryDiffOptions<Row> = {}
): Promise<QueryDiff<Row>> {
  const beforeSource = asRelationSource(before);
  const afterSource = asRelationSource(after);
  const beforeRows = await readTargetRows(beforeSource, target, options);
  const afterRows = await readTargetRows(afterSource, target, options);
  const diff = diffRows(beforeRows, afterRows, diffOptionsForTarget(target, options));
  const changedKeys = new Set(diff.changes.map((change) => change.key));

  return {
    kind: 'queryDiff',
    target,
    queryKey: queryKey(target),
    ...await versions(beforeSource, afterSource),
    beforeRows,
    afterRows,
    changed: diff.changes.length > 0,
    added: diff.changes.flatMap((change) => change.kind === 'added' ? [change.row] : []),
    removed: diff.changes.flatMap((change) => change.kind === 'removed' ? [change.row] : []),
    unchanged: afterRows.filter((row) => !changedKeys.has(rowKey(row, diffOptionsForTarget(target, options)))),
    rowChanges: diff.changes,
    diagnostics: diff.diagnostics
  };
}

export function diffOptionsForTarget<Row>(
  target: WatchTarget<Row>,
  options: WatchOptions<Row>
): RowDiffOptions<Row> {
  if (options.keyBy !== undefined) return options;
  if (isQuery(target)) {
    const fields = queryRowKeyFields(target);
    return fields === undefined ? options : { ...options, keyBy: fields };
  }
  const fields = Array.isArray(target.key) ? target.key : [target.key];
  return { ...options, keyBy: fields };
}

export function transferWatches(previous: unknown, next: unknown): void {
  if (!isObject(previous) || !isObject(next)) {
    return;
  }

  const records = watchStore.get(previous);
  if (records === undefined) {
    return;
  }

  const active = Array.from(records).filter((record) => record.active);
  for (const record of active) {
    transferWatchMaterialization(previous, next, record);
    record.db = next as WatchDb;
    addRecord(next, record);
    removeRecord(previous, record);
  }
}

export async function trackedChangesForDbTransition(
  before: WatchDb,
  after: WatchDb,
  deltas: readonly RelationDelta[] = [],
  materializationChanges: readonly MaterializationMaintenanceChange[] = []
): Promise<{
  readonly changes: readonly TrackedChange[];
  readonly diagnostics: readonly WatchRuntimeDiagnostic[];
}> {
  const records = activeRecordsForTransition(before, after);
  const materializedChanges = materializationChangesByTarget(materializationChanges);
  const changes: TrackedChange[] = [];
  const diagnostics: WatchRuntimeDiagnostic[] = [];

  for (const record of records) {
    const materializedChange = isQuery(record.target)
      ? materializedChanges.get(watchTargetIdentity(record.target)) as MaterializationMaintenanceChange | undefined
      : undefined;
    const event = materializedChange === undefined
      ? buildWatchEvent(
        record.id,
        record.target,
        await readTargetRows(before, record.target, record.options),
        await readTargetRows(after, record.target, record.options),
        record.options,
        { deltas, diagnostics: [] }
      )
      : buildWatchEventFromMaterializationChange(
        record.id,
        record.target,
        materializedChange,
        record.options,
        { deltas, diagnostics: [] }
      );
    if (!event.changed) {
      continue;
    }

    changes.push(trackedChangeFromWatchEvent(event));
    diagnostics.push(...event.diagnostics);

    diagnostics.push(...await deliverWatchEvent(record, event));
  }

  return { changes, diagnostics };
}

function watchHandle<Db extends WatchDb, Row>(record: WatchRecord<Db, Row>): WatchHandle<Db, Row> {
  return {
    kind: 'watch',
    id: record.id,
    get db() {
      return record.db;
    },
    target: record.target,
    supported: true,
    mode: 'db',
    diagnostics: [],
    refresh: async (nextDb = record.db) => {
      if (!record.active) {
        return {
          ...emptyWatchRefresh(record.id, record.target),
          diagnostics: [{ code: 'watch_already_closed', message: 'watch is already closed', surface: 'watch' }]
        };
      }

      const event = materializedRefreshEvent(record, nextDb)
        ?? buildWatchEvent(
          record.id,
          record.target,
          await readTargetRows(record.db, record.target, record.options),
          await readTargetRows(nextDb, record.target, record.options),
          record.options,
          { diagnostics: [] }
        );
      const deliveryDiagnostics = await deliverWatchEvent(record, event);
      if (deliveryDiagnostics.length === 0) {
        return { ...event, kind: 'watchRefresh', delivered: true };
      }

      return {
        ...event,
        kind: 'watchRefresh',
        delivered: false,
        diagnostics: [...event.diagnostics, ...deliveryDiagnostics]
      };
    },
    unwatch: () => unwatch(record),
    ...(record.options.label === undefined ? {} : { label: record.options.label })
  };
}

export function trackedChangeFromMaterializationChange<Row>(
  change: MaterializationMaintenanceChange<Row>,
  options: WatchOptions<Row> = {},
  id = change.id
): TrackedChange<Row> {
  return trackedChangeFromWatchEvent(buildWatchEventFromMaterializationChange(
    id,
    change.query,
    change,
    options,
    { diagnostics: [] }
  ));
}

function trackedChangeFromWatchEvent<Row>(event: WatchEvent<Row>): TrackedChange<Row> {
  return {
    kind: 'trackedChange',
    id: event.id,
    targetKey: event.targetKey,
    target: event.target,
    changed: event.changed,
    previousRows: event.previousRows,
    rows: event.rows,
    added: event.added,
    removed: event.removed,
    unchanged: event.unchanged,
    rowChanges: event.rowChanges,
    diagnostics: event.diagnostics
  };
}

function buildWatchEvent<Row>(
  id: string,
  target: WatchTarget<Row>,
  previousRows: readonly Row[],
  rows: readonly Row[],
  options: WatchOptions<Row>,
  changes: ChangeSet
): WatchEvent<Row> {
  const diffOptions = diffOptionsForTarget(target, options);
  const diff = diffRows(previousRows, rows, diffOptions);
  const changedKeys = new Set(diff.changes.map((change) => change.key));
  const added = rowsAddedByChanges(diff.changes, target);
  const removed = rowsRemovedByChanges(diff.changes, target);
  return {
    kind: 'watchEvent',
    id,
    targetKey: watchTargetIdentity(target),
    target,
    changed: diff.changes.length > 0,
    previousRows,
    rows,
    added,
    removed,
    unchanged: rows.filter((row) => !changedKeys.has(rowKey(row, diffOptions))),
    rowChanges: diff.changes,
    changes,
    diagnostics: diff.diagnostics
  };
}

function buildWatchEventFromRows<Row>(
  id: string,
  target: WatchTarget<Row>,
  previousRows: readonly Row[],
  rows: readonly Row[],
  rowChanges: readonly RowChange<Row>[],
  options: WatchOptions<Row>,
  changes: ChangeSet,
  diagnostics: readonly WatchRuntimeDiagnostic<Row>[]
): WatchEvent<Row> {
  const diffOptions = diffOptionsForTarget(target, options);
  const changedKeys = new Set(rowChanges.map((change) => change.key));
  const added = rowsAddedByChanges(rowChanges, target);
  const removed = rowsRemovedByChanges(rowChanges, target);
  return {
    kind: 'watchEvent',
    id,
    targetKey: watchTargetIdentity(target),
    target,
    changed: rowChanges.length > 0,
    previousRows,
    rows,
    added,
    removed,
    unchanged: rows.filter((row) => !changedKeys.has(rowKey(row, diffOptions))),
    rowChanges,
    changes,
    diagnostics
  };
}

function buildWatchEventFromMaterializationChange<Row>(
  id: string,
  target: WatchTarget<Row>,
  change: MaterializationMaintenanceChange<Row>,
  options: WatchOptions<Row>,
  changes: ChangeSet
): WatchEvent<Row> {
  return buildWatchEventFromRows(
    id,
    target,
    change.previousRowsAvailable ? change.previousRows ?? [] : [],
    change.rows,
    change.rowChanges,
    options,
    changes,
    change.diagnostics
  );
}

function materializedRefreshEvent<Db extends WatchDb, Row>(
  record: WatchRecord<Db, Row>,
  nextDb: Db | RelationSource
): WatchEvent<Row> | undefined {
  if (!isQuery(record.target) || record.db === nextDb || !isObject(record.db) || !isObject(nextDb)) {
    return undefined;
  }

  const materializations = maintainMaterializations(
    record.db as SnapshotMaterializationTarget,
    nextDb as SnapshotMaterializationTarget
  );
  const change = materializationChangeForTarget(materializations, record.target);
  return change === undefined
    ? undefined
    : buildWatchEventFromMaterializationChange(
      record.id,
      record.target,
      change,
      record.options,
      { diagnostics: [] }
    );
}

function rowsAddedByChanges<Row>(
  changes: readonly RowChange<Row>[],
  target: WatchTarget<Row>
): readonly Row[] {
  return changes.flatMap((change) => {
    if (change.kind === 'added') return [change.row];
    if (change.kind === 'updated' && isRelationRef(target)) return [change.after];
    return [];
  });
}

function rowsRemovedByChanges<Row>(
  changes: readonly RowChange<Row>[],
  target: WatchTarget<Row>
): readonly Row[] {
  return changes.flatMap((change) => {
    if (change.kind === 'removed') return [change.row];
    if (change.kind === 'updated' && isRelationRef(target)) return [change.before];
    return [];
  });
}

async function readTargetRows<Row>(
  db: WatchDb | RelationSource,
  target: WatchTarget<Row>,
  options: EvaluateOptions = {}
): Promise<readonly Row[]> {
  const source = tryRelationSource(db) ?? emptySource();
  if (!isQuery(target)) {
    return await source.rows(target) as readonly Row[];
  }

  const materializedRows = queryRowsFromMaterialization(db, target, options);
  return materializedRows ?? (await evaluate(source, target, options)).rows;
}

function emptyWatchRefresh<Row>(id: string, target: WatchTarget<Row>): WatchRefreshResult<Row> {
  return {
    kind: 'watchRefresh',
    id,
    targetKey: watchTargetIdentity(target),
    target,
    delivered: false,
    changed: false,
    previousRows: [],
    rows: [],
    added: [],
    removed: [],
    unchanged: [],
    rowChanges: [],
    diagnostics: []
  };
}

function addRecord(input: unknown, record: AnyWatchRecord): void {
  if (!isObject(input)) {
    return;
  }

  const records = watchStore.get(input) ?? new Set<AnyWatchRecord>();
  records.add(record);
  watchStore.set(input, records);
}

function addDbTrackedWatch<Row>(db: WatchDb, target: WatchTarget<Row>): void {
  const id = watchTargetIdentity(target);
  if (activeRecordsFor(db).some((record) => record.dbTracked && record.id === id)) {
    return;
  }

  addRecord(db, {
    db,
    id,
    target,
    listeners: new Set(),
    options: {},
    dbTracked: true,
    active: true
  });
  ensureWatchMaterialization(db, target, id);
}

function ensureWatchMaterialization<Row>(
  db: WatchDb,
  target: WatchTarget<Row>,
  ownerId: string,
  options: EvaluateOptions = {}
): void {
  if (!isQuery(target) || !isObject(db)) {
    return;
  }

  const targetKey = watchTargetIdentity(target);
  const states = watchMaterializationStore.get(db) ?? new Map<string, WatchMaterializationState>();
  let state = states.get(targetKey) as WatchMaterializationState<Row> | undefined;
  if (state === undefined) {
    const owned = materializationForQuery(db, target) === undefined;
    if (owned) {
      mat(db as SnapshotMaterializationTarget, target, { id: targetKey, ...options });
    }

    state = {
      query: target,
      targetKey,
      owners: new Set<string>(),
      owned
    };
    states.set(targetKey, state);
    watchMaterializationStore.set(db, states);
  }

  state.owners.add(ownerId);
}

function releaseWatchMaterialization<Row>(
  db: WatchDb,
  target: WatchTarget<Row>,
  ownerId: string
): void {
  if (!isQuery(target) || !isObject(db)) {
    return;
  }

  const states = watchMaterializationStore.get(db);
  const targetKey = watchTargetIdentity(target);
  const state = states?.get(targetKey);
  if (states === undefined || state === undefined) {
    return;
  }

  state.owners.delete(ownerId);
  if (state.owners.size > 0) {
    return;
  }

  states.delete(targetKey);
  if (state.owned) {
    demat(db, target);
  }
  if (states.size === 0) {
    watchMaterializationStore.delete(db);
  }
}

function transferWatchMaterialization(
  previous: object,
  next: object,
  record: AnyWatchRecord
): void {
  if (!isQuery(record.target)) {
    return;
  }

  const targetKey = watchTargetIdentity(record.target);
  const previousStates = watchMaterializationStore.get(previous);
  const previousState = previousStates?.get(targetKey);
  if (previousStates === undefined || previousState === undefined || !previousState.owners.has(record.id)) {
    return;
  }

  previousState.owners.delete(record.id);
  if (previousState.owners.size === 0) {
    previousStates.delete(targetKey);
    if (previousState.owned) {
      demat(previous, record.target);
    }
    if (previousStates.size === 0) {
      watchMaterializationStore.delete(previous);
    }
  }

  const nextStates = watchMaterializationStore.get(next) ?? new Map<string, WatchMaterializationState>();
  let nextState = nextStates.get(targetKey);
  if (nextState === undefined) {
    if (previousState.owned && materializationForQuery(next, record.target) === undefined) {
      mat(next as SnapshotMaterializationTarget, record.target, {
        id: targetKey,
        ...record.options
      });
    }

    nextState = {
      query: record.target,
      targetKey,
      owners: new Set<string>(),
      owned: previousState.owned
    };
    nextStates.set(targetKey, nextState);
    watchMaterializationStore.set(next, nextStates);
  }

  nextState.owners.add(record.id);
}

function removeRecord(input: unknown, record: AnyWatchRecord): void {
  if (!isObject(input)) {
    return;
  }

  const records = watchStore.get(input);
  if (records === undefined) {
    return;
  }

  records.delete(record);
  if (records.size === 0) {
    watchStore.delete(input);
  }
}

function removeDbTrackedWatches(db: WatchDb, targets: readonly WatchTarget[]): void {
  if (!isObject(db)) {
    return;
  }

  const records = watchStore.get(db);
  if (records === undefined) {
    return;
  }

  const ids = new Set(targets.map(watchTargetIdentity));
  for (const record of Array.from(records)) {
    if (ids.has(record.id)) {
      records.delete(record);
      record.active = false;
      releaseWatchMaterialization(db, record.target, record.id);
    }
  }

  if (records.size === 0) {
    watchStore.delete(db);
  }
}

function activeRecordsFor(input: unknown): readonly AnyWatchRecord[] {
  return isObject(input)
    ? Array.from(watchStore.get(input) ?? []).filter((record) => record.active && record.db === input)
    : [];
}

function activeRecordsForTransition(before: WatchDb, after: WatchDb): readonly AnyWatchRecord[] {
  const byId = new Map<string, AnyWatchRecord>();
  for (const record of activeRecordsFor(before)) {
    byId.set(record.id, record);
  }
  for (const record of activeRecordsFor(after)) {
    byId.set(record.id, record);
  }
  return Array.from(byId.values());
}

function materializationChangesByTarget(
  changes: readonly MaterializationMaintenanceChange[]
): ReadonlyMap<string, MaterializationMaintenanceChange> {
  const byTarget = new Map<string, MaterializationMaintenanceChange>();
  for (const change of changes) {
    byTarget.set(watchTargetIdentity(change.query), change);
  }
  return byTarget;
}

function materializationChangeForTarget<Row>(
  materializations: MaterializationMaintenanceResult,
  target: Query<Row>
): MaterializationMaintenanceChange<Row> | undefined {
  return materializationChangesByTarget(materializations.changes).get(watchTargetIdentity(target)) as
    | MaterializationMaintenanceChange<Row>
    | undefined;
}

async function deliverWatchEvent<Db extends WatchDb, Row>(
  record: WatchRecord<Db, Row>,
  event: WatchEvent<Row>
): Promise<readonly WatchDiagnostic[]> {
  const diagnostics: WatchDiagnostic[] = [];
  for (const listener of record.listeners) {
    try {
      await listener(event);
    } catch (error) {
      diagnostics.push(listenerDiagnostic(error));
    }
  }
  return diagnostics;
}

function unsubscribeWatchListener<Db extends WatchDb, Row>(
  record: WatchRecord<Db, Row>,
  listener: WatchListener<Row>,
  isSubscribed: () => boolean,
  setSubscribed: (value: boolean) => void
): boolean {
  if (!isSubscribed() || !record.active) {
    setSubscribed(false);
    return false;
  }

  setSubscribed(false);
  return record.listeners.delete(listener);
}

function findRecord(id: string): AnyWatchRecord | undefined {
  return allWatchRecords.get(id);
}

async function versions(before: RelationSource, after: RelationSource): Promise<{
  readonly beforeVersion?: unknown;
  readonly afterVersion?: unknown;
}> {
  return {
    ...(before.version === undefined ? {} : { beforeVersion: await before.version() }),
    ...(after.version === undefined ? {} : { afterVersion: await after.version() })
  };
}

function rowKey<Row>(row: Row, options: RowDiffOptions<Row>): string {
  return diffRows([], [row], options).changes[0]?.key ?? JSON.stringify(row);
}

function listenerDiagnostic(detail: unknown): WatchDiagnostic {
  return {
    code: 'watch_listener_error',
    message: detail instanceof Error ? detail.message : String(detail),
    surface: 'watch',
    detail
  };
}

function emptySource(): RelationSource {
  return { rows: () => [] };
}

function isListenerWatchArgs(
  args: readonly (WatchTarget | WatchListener | WatchOptions | undefined)[]
): boolean {
  return args.length > 0 && (typeof args[0] === 'function' || args[0] === undefined);
}

function isQuery(input: unknown): input is Query {
  return isObject(input) && 'data' in input && 'relations' in input;
}

function isWatchTarget(input: WatchTarget | WatchListener | WatchOptions | undefined): input is WatchTarget {
  return isQuery(input) || isRelationRef(input);
}

function isRelationRef(input: unknown): input is RelationRef {
  return isObject(input) &&
    (input as { readonly kind?: unknown }).kind === 'relation' &&
    typeof (input as { readonly name?: unknown }).name === 'string' &&
    isObject((input as { readonly fields?: unknown }).fields);
}

function isDb(input: unknown): input is Db {
  return isObject(input) && 'data' in input && 'env' in input;
}

function isObject(input: unknown): input is object {
  return typeof input === 'object' && input !== null;
}

function watchTargetIdentity(target: WatchTarget): string {
  if (isQuery(target)) {
    return queryKey(target);
  }

  return `relation:${target.name}:${JSON.stringify(target.key)}`;
}
