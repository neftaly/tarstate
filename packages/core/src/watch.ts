import type { TarstateDiagnostic } from './diagnostics.js';
import type { RelationRuntime } from './adapter.js';
import type { RelationDelta } from './delta.js';
import { diffRows, type RowChange, type RowDiffDiagnostic, type RowDiffOptions } from './diff.js';
import { evaluate } from './evaluate.js';
import type { EvaluateOptions } from './evaluate.js';
import { forkDb, type Db } from './db.js';
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
  readonly target: WatchTarget<Row>;
  readonly changed: boolean;
  readonly previousRows: readonly Row[];
  readonly rows: readonly Row[];
  readonly addedRows: readonly Row[];
  readonly deletedRows: readonly Row[];
  readonly removedRows: readonly Row[];
  readonly unchangedRows: readonly Row[];
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
  readonly target: WatchTarget<Row>;
  readonly delivered: boolean;
  readonly changed: boolean;
  readonly previousRows: readonly Row[];
  readonly rows: readonly Row[];
  readonly addedRows: readonly Row[];
  readonly deletedRows: readonly Row[];
  readonly removedRows: readonly Row[];
  readonly unchangedRows: readonly Row[];
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
  readonly target: WatchTarget<Row>;
  readonly changed: boolean;
  readonly previousRows: readonly Row[];
  readonly rows: readonly Row[];
  readonly addedRows: readonly Row[];
  readonly deletedRows: readonly Row[];
  readonly removedRows: readonly Row[];
  readonly unchangedRows: readonly Row[];
  readonly rowChanges: readonly RowChange<Row>[];
  readonly diagnostics: readonly WatchRuntimeDiagnostic[];
};
export type WatchTargetChange<Row = unknown> = {
  readonly kind: 'watchTargetChange';
  readonly id: string;
  readonly target: WatchTarget<Row>;
  readonly changed: boolean;
  readonly addedRows: readonly Row[];
  readonly deletedRows: readonly Row[];
  readonly removedRows: readonly Row[];
  readonly unchangedRows: readonly Row[];
  readonly rowChanges: readonly RowChange<Row>[];
  readonly diagnostics: readonly WatchRuntimeDiagnostic[];
};
export type WatchChangeMap<Row = unknown> = ReadonlyMap<WatchTarget<Row>, WatchTargetChange<Row>>;
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
  readonly addedRows: readonly Row[];
  readonly deletedRows: readonly Row[];
  readonly removedRows: readonly Row[];
  readonly unchangedRows: readonly Row[];
  readonly rowChanges: readonly RowChange<Row>[];
  readonly diagnostics: readonly QueryDiffDiagnostic<Row>[];
};

type WatchRecord<Db extends WatchDb = WatchDb, Row = unknown> = {
  db: Db;
  readonly id: string;
  readonly target: WatchTarget<Row>;
  readonly listener: WatchListener<Row>;
  readonly options: WatchOptions<Row>;
  readonly dbTracked: boolean;
  active: boolean;
  handle?: WatchHandle<Db, Row>;
};

let nextId = 0;
type AnyWatchRecord = WatchRecord<any, any>;
const watchStore = new WeakMap<object, Set<AnyWatchRecord>>();
const allWatchRecords = new Map<string, AnyWatchRecord>();

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
    listener: listener ?? (() => undefined),
    options,
    dbTracked: false,
    active: true
  };
  const handle = watchHandle(record);
  record.handle = handle;
  const storedRecord = record as AnyWatchRecord;
  addRecord(db, storedRecord);
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
    byTarget.set(change.target, {
      kind: 'watchTargetChange',
      id: change.id,
      target: change.target,
      changed: change.changed,
      addedRows: change.addedRows,
      deletedRows: change.deletedRows,
      removedRows: change.removedRows,
      unchangedRows: change.unchangedRows,
      rowChanges: change.rowChanges,
      diagnostics: change.diagnostics
    });
  }
  return byTarget;
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
  _listener: WatchListener<Row>
): WatchSubscription {
  return {
    kind: 'watchSubscription',
    id: handle.id,
    active: handle.supported,
    diagnostics: [],
    unsubscribe: () => ({
      kind: 'watchUnsubscribe',
      id: handle.id,
      unsubscribed: true,
      diagnostics: []
    })
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
    addedRows: diff.changes.flatMap((change) => change.kind === 'added' ? [change.row] : []),
    deletedRows: diff.changes.flatMap((change) => change.kind === 'removed' ? [change.row] : []),
    removedRows: diff.changes.flatMap((change) => change.kind === 'removed' ? [change.row] : []),
    unchangedRows: afterRows.filter((row) => !changedKeys.has(rowKey(row, diffOptionsForTarget(target, options)))),
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
    record.db = next as WatchDb;
    addRecord(next, record);
  }
}

export async function trackedChangesForDbTransition(
  before: WatchDb,
  after: WatchDb,
  deltas: readonly RelationDelta[] = []
): Promise<{
  readonly changes: readonly TrackedChange[];
  readonly diagnostics: readonly WatchRuntimeDiagnostic[];
}> {
  const records = activeRecordsFor(before);
  const changes: TrackedChange[] = [];
  const diagnostics: WatchRuntimeDiagnostic[] = [];

  for (const record of records) {
    const previousRows = await readTargetRows(before, record.target, record.options);
    const rows = await readTargetRows(after, record.target, record.options);
    const event = buildWatchEvent(record.id, record.target, previousRows, rows, record.options, {
      deltas,
      diagnostics: []
    });
    changes.push({
      kind: 'trackedChange',
      id: event.id,
      target: event.target,
      changed: event.changed,
      previousRows: event.previousRows,
      rows: event.rows,
      addedRows: event.addedRows,
      deletedRows: event.deletedRows,
      removedRows: event.removedRows,
      unchangedRows: event.unchangedRows,
      rowChanges: event.rowChanges,
      diagnostics: event.diagnostics
    });
    diagnostics.push(...event.diagnostics);

    try {
      await record.listener(event);
    } catch (error) {
      const diagnostic = listenerDiagnostic(error);
      diagnostics.push(diagnostic);
    }
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

      const previousRows = await readTargetRows(record.db, record.target, record.options);
      const rows = await readTargetRows(nextDb, record.target, record.options);
      const event = buildWatchEvent(record.id, record.target, previousRows, rows, record.options, { diagnostics: [] });
      try {
        await record.listener(event);
        return { ...event, kind: 'watchRefresh', delivered: true };
      } catch (error) {
        return {
          ...event,
          kind: 'watchRefresh',
          delivered: false,
          diagnostics: [...event.diagnostics, listenerDiagnostic(error)]
        };
      }
    },
    unwatch: () => unwatch(record),
    ...(record.options.label === undefined ? {} : { label: record.options.label })
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
  return {
    kind: 'watchEvent',
    id,
    target,
    changed: diff.changes.length > 0,
    previousRows,
    rows,
    addedRows: diff.changes.flatMap((change) => change.kind === 'added' ? [change.row] : []),
    deletedRows: diff.changes.flatMap((change) => change.kind === 'removed' ? [change.row] : []),
    removedRows: diff.changes.flatMap((change) => change.kind === 'removed' ? [change.row] : []),
    unchangedRows: rows.filter((row) => !changedKeys.has(rowKey(row, diffOptions))),
    rowChanges: diff.changes,
    changes,
    diagnostics: diff.diagnostics
  };
}

async function readTargetRows<Row>(
  db: WatchDb | RelationSource,
  target: WatchTarget<Row>,
  options: EvaluateOptions = {}
): Promise<readonly Row[]> {
  const source = tryRelationSource(db) ?? emptySource();
  return isQuery(target)
    ? (await evaluate(source, target, options)).rows
    : await source.rows(target) as readonly Row[];
}

function emptyWatchRefresh<Row>(id: string, target: WatchTarget<Row>): WatchRefreshResult<Row> {
  return {
    kind: 'watchRefresh',
    id,
    target,
    delivered: false,
    changed: false,
    previousRows: [],
    rows: [],
    addedRows: [],
    deletedRows: [],
    removedRows: [],
    unchangedRows: [],
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
    listener: () => undefined,
    options: {},
    dbTracked: true,
    active: true
  });
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
    }
  }

  if (records.size === 0) {
    watchStore.delete(db);
  }
}

function activeRecordsFor(input: unknown): readonly AnyWatchRecord[] {
  return isObject(input)
    ? Array.from(watchStore.get(input) ?? []).filter((record) => record.active)
    : [];
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
