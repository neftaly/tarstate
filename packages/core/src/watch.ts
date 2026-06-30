import type { TarstateDiagnostic } from './diagnostics.js';
import type { RelationRuntime } from './adapter.js';
import type { RelationDelta } from './delta.js';
import { diffRows, type RowChange, type RowDiff, type RowDiffDiagnostic, type RowDiffOptions } from './diff.js';
import { evaluate, type EvaluateOptions } from './evaluate.js';
import { queryKey, type Query } from './query.js';
import type { RelationRef } from './schema.js';
import { tryRelationSource } from './source-input.js';
import type { RelationSource } from './source.js';
import {
  addWatchSubscriber,
  closeWatch,
  currentWatchOwner,
  deliverWatchEvent,
  isWatchClosed,
  nextWatchId,
  registerWatch,
  transferWatchRegistration
} from './watch-registry.js';
import { readWatchRows } from './watch-read.js';

/** Structural database-like object accepted by watch declarations. */
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
  /** True when the event diff has any added, removed, or row-change entries. */
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
  /** True when the refresh diff has any added, removed, or row-change entries. */
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
  /** True when the tracked diff has any added, removed, or row-change entries. */
  readonly changed: boolean;
  readonly previousRows: readonly Row[];
  readonly rows: readonly Row[];
  readonly addedRows: readonly Row[];
  readonly removedRows: readonly Row[];
  readonly unchangedRows: readonly Row[];
  readonly rowChanges: readonly RowChange<Row>[];
  readonly diagnostics: readonly WatchRuntimeDiagnostic[];
};

export type QueryDiffOptions<Row = unknown> = EvaluateOptions & RowDiffOptions<Row>;

export type QueryDiff<Row = unknown> = {
  readonly kind: 'queryDiff';
  readonly target: Query<Row>;
  readonly queryKey: string;
  readonly beforeVersion?: unknown;
  readonly afterVersion?: unknown;
  readonly beforeRows: readonly Row[];
  readonly afterRows: readonly Row[];
  readonly addedRows: readonly Row[];
  readonly removedRows: readonly Row[];
  readonly unchangedRows: readonly Row[];
  readonly rowChanges: readonly RowChange<Row>[];
  readonly diagnostics: readonly TarstateDiagnostic[];
};

/**
 * Declare a manual watch over a readable DB/source target.
 *
 * @remarks This is not a reactive subscription or async stream. Each `refresh` re-evaluates
 * the target against the provided/current DB/source snapshot, diffs it against the previous
 * refresh, and can report experimental keyed `rowChanges`. Additional callbacks registered
 * with `subscribeWatch` are delivered only when this refresh or a real tracked-change path
 * emits a watch event.
 */
export function watch<Db extends WatchDb, Row>(
  db: Db,
  target: WatchTarget<Row>,
  listener: WatchListener<Row>,
  options: WatchOptions<Row> = {}
): WatchHandle<Db, Row> {
  const id = nextWatchId();
  const source = sourceForWatch(db);
  const supported = source !== undefined;
  const diagnostics = supported ? [] : [unsupportedWatchDiagnostic(target)];
  let previousRows: readonly Row[] = [];
  const setPreviousRows = (rows: readonly Row[]): void => {
    previousRows = rows;
  };

  const refresh = async (nextDb?: Db | RelationSource): Promise<WatchRefreshResult<Row>> => {
    if (isWatchClosed(id)) {
      return closedWatchRefreshResult(id, target, previousRows);
    }

    const nextSource = sourceForWatch(nextDb ?? currentWatchOwner(id) ?? db);

    if (nextSource === undefined) {
      return unsupportedWatchRefreshResult(id, target, previousRows);
    }

    const result = await readWatchRows(nextSource, target, options);
    const rows = result.rows;
    const previous = previousRows;
    const rowDiff = diffRows(previous, rows, diffOptionsForTarget(target, options));
    const diagnostics = [...result.diagnostics, ...rowChangeDiagnostics(rowDiff)];
    const resultDiff = visibleRowDiff(rowDiff);
    const event: WatchEvent<Row> = {
      kind: 'watchEvent',
      id,
      target,
      changed: rowDiffChanged(resultDiff),
      previousRows: previous,
      rows,
      ...resultDiff,
      changes: emptyChangeSet(),
      diagnostics
    };

    const refreshResult = (listenerDiagnostics: readonly WatchDiagnostic[] = []): WatchRefreshResult<Row> => ({
      kind: 'watchRefresh',
      id,
      target,
      delivered: listenerDiagnostics.length === 0,
      changed: rowDiffChanged(resultDiff),
      previousRows: previous,
      rows,
      ...resultDiff,
      diagnostics: [...diagnostics, ...listenerDiagnostics]
    });

    if (isWatchClosed(id)) {
      return closedWatchRefreshResult(id, target, previous);
    }

    if (nextDb !== undefined) {
      transferWatchRegistration(id, nextDb);
    }

    setPreviousRows(rows);
    const listenerDiagnostics = await deliverWatchEvent(listener, event);

    return refreshResult(listenerDiagnostics);
  };

  const handle: WatchHandle<Db, Row> = {
    kind: 'watch',
    id,
    db,
    target,
    supported,
    mode: supported ? 'manual' : 'unsupported',
    diagnostics,
    refresh,
    unwatch: () => closeWatchHandle(id),
    ...(options.label === undefined ? {} : { label: options.label })
  };

  if (supported) {
    registerWatch(db, {
      id,
      target,
      listener: listener as WatchListener,
      options: options as WatchOptions,
      setPreviousRows: setPreviousRows as (rows: readonly unknown[]) => void
    });
  }

  if (options.immediate === true && supported) {
    void refresh().catch(() => undefined);
  }

  return handle;
}

/**
 * Bridge a host-driven relation runtime invalidation callback into a normal manual watch.
 *
 * @remarks This does not synthesize relation deltas or create an async event stream. Host
 * invalidation only calls `refresh` against `runtime.snapshot?.().source ?? runtime.source`.
 */
export function watchRuntime<Version, Row>(
  runtime: RelationRuntime<Version>,
  target: WatchTarget<Row>,
  listener: WatchListener<Row>,
  options: WatchOptions<Row> = {}
): RuntimeWatchHandle<Row> {
  const handle = watch(runtimeWatchSource(runtime), target, listener, options);

  if (handle.supported && runtime.subscribe !== undefined) {
    registerRuntimeHostSubscription(handle.id, runtime.subscribe(() => {
      if (!isWatchClosed(handle.id)) {
        void handle.refresh(runtimeWatchSource(runtime)).catch(() => undefined);
      }
    }));
  }

  return {
    ...handle,
    refresh: (nextSource?: RelationSource) => {
      if (nextSource === undefined && isWatchClosed(handle.id)) {
        return handle.refresh();
      }

      return handle.refresh(nextSource ?? runtimeWatchSource(runtime));
    },
    unwatch: () => closeWatchHandle(handle.id)
  };
}

/** Close a watch handle created by `watch`. */
export function unwatch(handle: Pick<WatchHandle, 'id'>): UnwatchResult {
  return closeWatchHandle(handle.id);
}

/**
 * Subscribe an additional callback to events emitted by an existing watch handle.
 *
 * Listener delivery is keyed by function identity: subscribing the same callback
 * more than once still calls it at most once per event. Each subscription handle
 * must be unsubscribed before that callback is removed.
 */
export function subscribeWatch<Row>(
  handle: Pick<WatchHandle<WatchDb, Row>, 'id' | 'supported' | 'target'>,
  listener: WatchListener<Row>
): WatchSubscription {
  if (!handle.supported) {
    return inactiveWatchSubscription(handle.id, [unsupportedWatchDiagnostic(handle.target)]);
  }

  if (isWatchClosed(handle.id)) {
    return inactiveWatchSubscription(handle.id, [closedWatchDiagnostic(handle.id)]);
  }

  const removeSubscriber = addWatchSubscriber(handle.id, listener);

  if (removeSubscriber === undefined) {
    return inactiveWatchSubscription(handle.id, [closedWatchDiagnostic(handle.id)]);
  }

  return {
    kind: 'watchSubscription',
    id: handle.id,
    active: true,
    diagnostics: [],
    unsubscribe: () => ({
      kind: 'watchUnsubscribe',
      id: handle.id,
      unsubscribed: removeSubscriber(),
      diagnostics: []
    })
  };
}

/**
 * Evaluate a query before and after a state change and return a coarse result-row diff.
 *
 * @remarks This is a one-shot helper, not a subscription or incremental tracker. Rows are compared
 * as a structural multiset using the same stable JSON-style keying as the evaluator's set operators.
 */
export async function diffQuery<Row>(
  sourceBefore: RelationSource,
  sourceAfter: RelationSource,
  query: Query<Row>,
  options: QueryDiffOptions<Row> = {}
): Promise<QueryDiff<Row>> {
  const versionDiagnostics: TarstateDiagnostic[] = [];
  const [before, after, beforeVersion, afterVersion] = await Promise.all([
    evaluate(sourceBefore, query, options),
    evaluate(sourceAfter, query, options),
    readSourceVersion(sourceBefore, 'before', versionDiagnostics),
    readSourceVersion(sourceAfter, 'after', versionDiagnostics)
  ]);

  const rowDiff = diffRows(before.rows, after.rows, options);

  return {
    kind: 'queryDiff',
    target: query,
    queryKey: queryKey(query),
    ...(beforeVersion === undefined ? {} : { beforeVersion }),
    ...(afterVersion === undefined ? {} : { afterVersion }),
    beforeRows: before.rows,
    afterRows: after.rows,
    ...visibleRowDiff(rowDiff),
    diagnostics: [...before.diagnostics, ...after.diagnostics, ...versionDiagnostics]
  };
}

export function diffOptionsForTarget<Row>(
  target: WatchTarget<Row>,
  options: RowDiffOptions<Row>
): RowDiffOptions<Row> {
  if (isRelationTarget(target)) {
    return { keyFields: relationKeyFields(target) };
  }

  return {
    ...(options.rowKey === undefined ? {} : { rowKey: options.rowKey }),
    ...(options.keyFields === undefined ? {} : { keyFields: options.keyFields })
  };
}

function sourceForWatch(input: WatchDb | RelationSource): RelationSource | undefined {
  return tryRelationSource(input);
}

const runtimeHostUnsubscribers = new Map<string, () => void>();

function runtimeWatchSource<Version>(runtime: RelationRuntime<Version>): RelationSource {
  return runtime.snapshot?.().source ?? runtime.source;
}

function registerRuntimeHostSubscription(id: string, unsubscribe: () => void): void {
  runtimeHostUnsubscribers.set(id, unsubscribe);
}

function closeWatchHandle(id: string): UnwatchResult {
  const unsubscribeRuntimeHost = runtimeHostUnsubscribers.get(id);
  runtimeHostUnsubscribers.delete(id);
  unsubscribeRuntimeHost?.();

  return closeWatch(id);
}

function unsupportedWatchRefreshResult<Row>(
  id: string,
  target: WatchTarget<Row>,
  previousRows: readonly Row[]
): WatchRefreshResult<Row> {
  return {
    kind: 'watchRefresh',
    id,
    target,
    delivered: false,
    changed: false,
    previousRows,
    rows: previousRows,
    addedRows: [],
    removedRows: [],
    unchangedRows: previousRows,
    rowChanges: [],
    diagnostics: [unsupportedWatchDiagnostic(target)]
  };
}

function closedWatchRefreshResult<Row>(
  id: string,
  target: WatchTarget<Row>,
  previousRows: readonly Row[]
): WatchRefreshResult<Row> {
  return {
    kind: 'watchRefresh',
    id,
    target,
    delivered: false,
    changed: false,
    previousRows,
    rows: previousRows,
    addedRows: [],
    removedRows: [],
    unchangedRows: previousRows,
    rowChanges: [],
    diagnostics: [closedWatchDiagnostic(id)]
  };
}

function inactiveWatchSubscription(id: string, diagnostics: readonly WatchDiagnostic[]): WatchSubscription {
  return {
    kind: 'watchSubscription',
    id,
    active: false,
    diagnostics,
    unsubscribe: () => ({
      kind: 'watchUnsubscribe',
      id,
      unsubscribed: false,
      diagnostics
    })
  };
}

function closedWatchDiagnostic(id: string): WatchDiagnostic {
  return {
    code: 'watch_already_closed',
    message: `watch ${id} is already closed`,
    surface: 'watch'
  };
}

function emptyChangeSet(): ChangeSet {
  return { diagnostics: [] };
}

function visibleRowDiff<Row>(
  rowDiff: RowDiff<Row>
): Pick<RowDiff<Row>, 'addedRows' | 'removedRows' | 'unchangedRows' | 'rowChanges'> {
  return {
    addedRows: rowDiff.addedRows,
    removedRows: rowDiff.removedRows,
    unchangedRows: rowDiff.unchangedRows,
    rowChanges: rowDiff.rowChanges
  };
}

function rowDiffChanged<Row>(rowDiff: Pick<RowDiff<Row>, 'addedRows' | 'removedRows' | 'rowChanges'>): boolean {
  return rowDiff.addedRows.length > 0 || rowDiff.removedRows.length > 0 || rowDiff.rowChanges.length > 0;
}

function rowChangeDiagnostics<Row>(rowDiff: RowDiff<Row>): readonly RowDiffDiagnostic<Row>[] {
  return rowDiff.rowChangeDiagnostics ?? [];
}

function relationKeyFields(relation: RelationRef): readonly string[] {
  return typeof relation.key === 'string' ? [relation.key] : relation.key;
}

function isRelationTarget(input: WatchTarget): input is RelationRef {
  return typeof input === 'object' && input !== null && 'kind' in input && input.kind === 'relation';
}

function unsupportedWatchDiagnostic(target: WatchTarget): WatchDiagnostic {
  return {
    code: 'watch_unsupported',
    message: 'watch target cannot be refreshed because the DB/source is not readable',
    surface: 'watch',
    detail: { target }
  };
}

async function readSourceVersion(
  source: RelationSource,
  label: 'before' | 'after',
  diagnostics: TarstateDiagnostic[]
): Promise<unknown> {
  try {
    const version = await source.version?.();
    return version;
  } catch (error) {
    diagnostics.push({
      code: 'source_error',
      message: `${label} source version failed`,
      detail: error
    });
    return undefined;
  }
}
