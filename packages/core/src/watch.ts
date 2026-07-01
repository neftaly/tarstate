import type { TarstateDiagnostic } from './diagnostics.js';
import type { RelationRuntime } from './adapter.js';
import type { RelationDelta } from './delta.js';
import { diffRows, type RowChange, type RowDiffDiagnostic, type RowDiffOptions } from './diff.js';
import type { EvaluateOptions } from './evaluate.js';
import { queryKey, queryRowKeyFields, type ExprData, type OptionalProjection, type PredicateData, type ProjectionData, type Query, type QueryData } from './query.js';
import type { RelationRef } from './schema.js';
import type { RelationSource } from './source.js';

export type WatchDb = object;

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
  readonly mode: 'manual' | 'unsupported';
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
  readonly removedRows: readonly Row[];
  readonly unchangedRows: readonly Row[];
  readonly rowChanges: readonly RowChange<Row>[];
  readonly diagnostics: readonly QueryDiffDiagnostic<Row>[];
};

let nextId = 0;

export function watch<Db extends WatchDb, Row>(
  db: Db,
  target: WatchTarget<Row>,
  listener: WatchListener<Row>,
  options: WatchOptions<Row> = {}
): WatchHandle<Db, Row> {
  const id = `watch-${nextId += 1}`;
  let previousRows: readonly Row[] = [];
  let closed = false;
  const handle: WatchHandle<Db, Row> = {
    kind: 'watch',
    id,
    db,
    target,
    supported: true,
    mode: 'manual',
    diagnostics: [],
    refresh: async (nextDb = db) => {
      if (closed) {
        return {
          ...emptyWatchRefresh(id, target),
          diagnostics: [{ code: 'watch_already_closed', message: 'watch is already closed', surface: 'watch' }]
        };
      }

      const rows = await readTargetRows(nextDb, target);
      const event = buildWatchEvent(id, target, previousRows, rows, options, { diagnostics: [] });
      previousRows = rows;

      try {
        await listener(event);
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
    unwatch: () => {
      closed = true;
      return unwatch(handle);
    },
    ...(options.label === undefined ? {} : { label: options.label })
  };

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
  const handle = watch(db, target, () => undefined, options);
  return {
    kind: 'watchTarget',
    db,
    target,
    handle,
    supported: true,
    diagnostics: handle.diagnostics,
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

export function unwatch(handle: Pick<WatchHandle, 'id'>): UnwatchResult {
  return {
    kind: 'unwatch',
    id: handle.id,
    closed: true,
    diagnostics: []
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
  before: RelationSource,
  after: RelationSource,
  target: Query<Row>,
  options: QueryDiffOptions<Row> = {}
): Promise<QueryDiff<Row>> {
  const beforeRows = await evaluateQuery(before, target);
  const afterRows = await evaluateQuery(after, target);
  const diff = diffRows(beforeRows, afterRows, diffOptionsForTarget(target, options));
  const addedRows = diff.changes.flatMap((change) => change.kind === 'added' ? [change.row] : []);
  const removedRows = diff.changes.flatMap((change) => change.kind === 'removed' ? [change.row] : []);
  const updatedBefore = new Set(diff.changes.flatMap((change) => change.kind === 'updated' ? [change.key] : []));
  const unchangedRows = afterRows.filter((row) => !updatedBefore.has(rowKey(row, diffOptionsForTarget(target, options))));

  return {
    kind: 'queryDiff',
    target,
    queryKey: queryKey(target),
    ...await versions(before, after),
    beforeRows,
    afterRows,
    changed: diff.changes.length > 0,
    addedRows,
    removedRows,
    unchangedRows,
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
    removedRows: [],
    unchangedRows: [],
    rowChanges: [],
    diagnostics: [unsupportedWatchDiagnostic(target)]
  };
}

function unsupportedWatchDiagnostic(target: WatchTarget): WatchDiagnostic {
  return {
    code: 'watch_unsupported',
    message: 'watch implementation has been removed; regenerate this API implementation',
    surface: 'watch',
    detail: target
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
  const diff = diffRows(previousRows, rows, diffOptionsForTarget(target, options));
  return {
    kind: 'watchEvent',
    id,
    target,
    changed: diff.changes.length > 0,
    previousRows,
    rows,
    addedRows: diff.changes.flatMap((change) => change.kind === 'added' ? [change.row] : []),
    removedRows: diff.changes.flatMap((change) => change.kind === 'removed' ? [change.row] : []),
    unchangedRows: rows.filter((row) => !new Set(diff.changes.map((change) => change.key)).has(rowKey(row, diffOptionsForTarget(target, options)))),
    rowChanges: diff.changes,
    changes,
    diagnostics: diff.diagnostics
  };
}

async function readTargetRows<Row>(db: WatchDb | RelationSource, target: WatchTarget<Row>): Promise<readonly Row[]> {
  const source = relationSourceFor(db);
  return isQuery(target) ? evaluateQuery(source, target) : await source.rows(target) as readonly Row[];
}

function relationSourceFor(input: WatchDb | RelationSource): RelationSource {
  if ('rows' in input && typeof input.rows === 'function') return input;
  if ('data' in input && isRecord(input.data)) {
    const data = input.data;
    return {
      relationNames: Object.keys(data),
      rows: (relation) => Array.isArray(data[relation.name]) ? data[relation.name] as readonly unknown[] : []
    };
  }
  return { rows: () => [] };
}

async function evaluateQuery<Row>(source: RelationSource, query: Query<Row>): Promise<readonly Row[]> {
  return await evaluateData(source, query.data, query) as readonly Row[];
}

async function evaluateData(source: RelationSource, data: QueryData, query: Query): Promise<readonly unknown[]> {
  switch (data.op) {
    case 'from': {
      const relation = query.relations[data.relation];
      if (relation === undefined) return [];
      return (await source.rows(relation)).map((row) => ({ [data.alias]: row }));
    }
    case 'where':
      return (await evaluateData(source, data.input, query)).filter((row) => matchesPredicate(row, data.predicate));
    case 'select':
      return (await evaluateData(source, data.input, query)).map((row) => projectRow(row, data.projection));
    case 'keyBy':
    case 'hash':
    case 'btree':
      return evaluateData(source, data.input, query);
    case 'constRows':
      return data.rows;
    default:
      return [];
  }
}

function projectRow(row: unknown, projection: ProjectionData): Record<string, unknown> {
  return Object.fromEntries(Object.entries(projection).map(([field, expr]) => [
    field,
    exprValue(row, projectionExpr(expr))
  ]));
}

function matchesPredicate(row: unknown, predicate: PredicateData): boolean {
  switch (predicate.op) {
    case 'eq':
      return exprValue(row, predicate.left) === exprValue(row, predicate.right);
    case 'neq':
      return exprValue(row, predicate.left) !== exprValue(row, predicate.right);
    case 'and':
      return predicate.predicates.every((item) => matchesPredicate(row, item));
    case 'or':
      return predicate.predicates.some((item) => matchesPredicate(row, item));
    case 'not':
      return !matchesPredicate(row, predicate.predicate);
    default:
      return false;
  }
}

function exprValue(row: unknown, expr: ExprData): unknown {
  switch (expr.op) {
    case 'value':
      return expr.value;
    case 'field': {
      const aliased = isRecord(row) ? row[expr.alias] : undefined;
      return isRecord(aliased) ? aliased[expr.field] : isRecord(row) ? row[expr.field] : undefined;
    }
    case 'tuple':
      return expr.items.map((item) => exprValue(row, item));
    default:
      return undefined;
  }
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

function isQuery(input: unknown): input is Query {
  return typeof input === 'object' && input !== null && 'data' in input && 'relations' in input;
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === 'object' && input !== null;
}

function projectionExpr(input: ProjectionData[string]): ExprData {
  return isOptionalProjection(input) ? input.expr : input;
}

function isOptionalProjection(input: ProjectionData[string]): input is OptionalProjection {
  return 'kind' in input && input.kind === 'optionalProjection';
}
