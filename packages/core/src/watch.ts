import type { TarstateDiagnostic } from './diagnostics.js';
import type { RelationRuntime } from './adapter.js';
import type { RelationDelta } from './delta.js';
import type { RowChange, RowDiffDiagnostic, RowDiffOptions } from './diff.js';
import type { EvaluateOptions } from './evaluate.js';
import { queryKey, type Query } from './query.js';
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
export type WatchRuntimeDiagnostic = WatchDiagnostic | TarstateDiagnostic | RowDiffDiagnostic;

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
  readonly diagnostics: readonly WatchRuntimeDiagnostic[];
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
  readonly diagnostics: readonly WatchRuntimeDiagnostic[];
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
  _listener: WatchListener<Row>,
  options: WatchOptions<Row> = {}
): WatchHandle<Db, Row> {
  const id = `watch-${nextId += 1}`;
  const handle: WatchHandle<Db, Row> = {
    kind: 'watch',
    id,
    db,
    target,
    supported: false,
    mode: 'unsupported',
    diagnostics: [unsupportedWatchDiagnostic(target)],
    refresh: async () => emptyWatchRefresh(id, target),
    unwatch: () => unwatch(handle),
    ...(options.label === undefined ? {} : { label: options.label })
  };
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
    supported: false,
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
    active: false,
    diagnostics: [unsupportedWatchDiagnostic(handle.target)],
    unsubscribe: () => ({
      kind: 'watchUnsubscribe',
      id: handle.id,
      unsubscribed: false,
      diagnostics: [unsupportedWatchDiagnostic(handle.target)]
    })
  };
}

export async function diffQuery<Row>(
  _before: RelationSource,
  _after: RelationSource,
  target: Query<Row>,
  _options: QueryDiffOptions<Row> = {}
): Promise<QueryDiff<Row>> {
  return {
    kind: 'queryDiff',
    target,
    queryKey: queryKey(target),
    beforeRows: [],
    afterRows: [],
    changed: false,
    addedRows: [],
    removedRows: [],
    unchangedRows: [],
    rowChanges: [],
    diagnostics: []
  };
}

export function diffOptionsForTarget<Row>(
  _target: WatchTarget<Row>,
  options: WatchOptions<Row>
): RowDiffOptions<Row> {
  return options;
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
