import {
  createElement,
  useEffect,
  useMemo,
  type ReactNode
} from 'react';
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
  const runtime = useMemo<Runtime>(() => createRuntime(
    database as unknown as ErasedDatabase,
    normalizeServerQueryObservations(database, serverQueryObservations),
    onDiagnostic
  ), [database, onDiagnostic, serverQueryObservations]);
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
