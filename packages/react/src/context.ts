import { createContext, useContext } from 'react';
import type {
  CommitFunction,
  ErasedCreateOptimisticOverlay,
  ObservableDatabase
} from './contracts.js';
import type { Runtime } from './runtime.js';

export type CommitActions = {
  readonly executeCommit: CommitFunction | undefined;
  readonly createOptimisticOverlay: ErasedCreateOptimisticOverlay | undefined;
};

export const TarstateContext = createContext<Runtime | undefined>(undefined);
export const CommitActionsContext = createContext<CommitActions | undefined>(undefined);

export const useRuntime = (): Runtime => {
  const runtime = useContext(TarstateContext);
  if (runtime === undefined) throw new Error('Tarstate hooks require a TarstateProvider');
  return runtime;
};

/** Returns the borrowed database without asserting an application-selected query or row type. */
export const useDatabase = (): ObservableDatabase => useRuntime().database;
