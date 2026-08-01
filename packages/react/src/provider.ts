import {
  useCallback,
  createElement,
  useEffect,
  useMemo,
  useRef,
  type ReactNode
} from 'react';
import type { ObserverDiagnosticReporter, ObserverSnapshot } from '@tarstate/core/database/observer';
import type {
  ErasedCreateOptimisticOverlay,
  ErasedDatabase,
  ServerQueryObservation,
  TarstateProviderProps
} from './contracts.js';
import { CommitActionsContext, TarstateContext, type CommitActions } from './context.js';
import {
  createRuntime,
  normalizeServerQueryObservations,
  type Runtime
} from './runtime.js';

const emptyServerQueryObservations: readonly ServerQueryObservation[] = Object.freeze([]);

/** Borrows a database. Unmounting never closes the database or its sources. */
export const TarstateProvider = <Query, Row>({
  database,
  executeCommit,
  createOptimisticOverlay,
  serverQueryObservations = emptyServerQueryObservations as readonly ServerQueryObservation<Query, Row>[],
  onDiagnostic,
  children
}: TarstateProviderProps<Query, Row>): ReactNode => {
  const diagnosticRef = useRef(onDiagnostic);
  useEffect(() => {
    diagnosticRef.current = onDiagnostic;
  }, [onDiagnostic]);
  const reportDiagnostic = useCallback<ObserverDiagnosticReporter>((diagnostic) => {
    diagnosticRef.current?.(diagnostic);
  }, []);
  const normalizedServerSnapshots = useMemo(
    () => normalizeServerQueryObservations(database, serverQueryObservations),
    [database, serverQueryObservations]
  );
  const serverSnapshotsRef = useRef(normalizedServerSnapshots);
  if (!sameServerSnapshots(serverSnapshotsRef.current, normalizedServerSnapshots)) {
    serverSnapshotsRef.current = normalizedServerSnapshots;
  }
  const serverQuerySnapshots = serverSnapshotsRef.current;
  const runtime = useMemo<Runtime>(() => createRuntime(
    database as unknown as ErasedDatabase,
    serverQuerySnapshots,
    reportDiagnostic
  ), [database, reportDiagnostic, serverQuerySnapshots]);
  const actions = useMemo<CommitActions>(() => ({
    executeCommit,
    createOptimisticOverlay: createOptimisticOverlay as ErasedCreateOptimisticOverlay | undefined
  }), [executeCommit, createOptimisticOverlay]);
  useEffect(() => runtime.acquire(), [runtime]);
  return createElement(
    TarstateContext.Provider,
    { value: runtime },
    createElement(CommitActionsContext.Provider, { value: actions }, children)
  );
};

const sameServerSnapshots = (
  left: ReadonlyMap<string, ObserverSnapshot<unknown>>,
  right: ReadonlyMap<string, ObserverSnapshot<unknown>>
): boolean => {
  if (left.size !== right.size) return false;
  for (const [key, snapshot] of left) {
    if (!right.has(key) || !Object.is(snapshot, right.get(key))) return false;
  }
  return true;
};
