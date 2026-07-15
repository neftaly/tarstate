import {
  queryObservationKey,
  type ObserverDiagnosticReporter,
  type ObserverSnapshot
} from '@tarstate/core/database/observer';
import type {
  ErasedDatabase,
  ObservableDatabase,
  ServerQueryObservation
} from './contracts.js';
import { MutationStore } from './mutation-store.js';
import { OptimisticOverlayStore } from './optimistic-store.js';
import { runReactCleanups } from './shared.js';

export type Runtime = {
  readonly database: ErasedDatabase;
  readonly serverQuerySnapshots: ReadonlyMap<string, ObserverSnapshot<unknown>>;
  readonly mutationStore: MutationStore;
  readonly overlayStore: OptimisticOverlayStore;
  readonly onDiagnostic: ObserverDiagnosticReporter | undefined;
  readonly acquire: () => () => void;
};

export const createRuntime = (
  database: ErasedDatabase,
  serverQuerySnapshots: ReadonlyMap<string, ObserverSnapshot<unknown>>,
  onDiagnostic: ObserverDiagnosticReporter | undefined
): Runtime => {
  let mutationStore: MutationStore | undefined;
  const overlayStore = new OptimisticOverlayStore((mutationId, error) => mutationStore?.recordOptimisticError(mutationId, error), onDiagnostic);
  mutationStore = new MutationStore(overlayStore, onDiagnostic);
  let acquisitions = 0;
  let closeGeneration = 0;
  let closed = false;
  return {
    database,
    serverQuerySnapshots,
    mutationStore,
    overlayStore,
    onDiagnostic,
    acquire: () => {
      if (closed) throw new Error('Tarstate provider runtime is closed');
      acquisitions += 1;
      closeGeneration += 1;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        acquisitions -= 1;
        const generation = ++closeGeneration;
        queueMicrotask(() => {
          if (closed || acquisitions !== 0 || generation !== closeGeneration) return;
          closed = true;
          runReactCleanups([() => mutationStore.close(), () => overlayStore.close()], 'react-provider', 'release-runtime', onDiagnostic);
        });
      };
    }
  };
};

export const normalizeServerQueryObservations = <Query, Row>(database: ObservableDatabase<Query, Row>, observations: readonly ServerQueryObservation<Query, Row>[]): ReadonlyMap<string, ObserverSnapshot<unknown>> => {
  const output = new Map<string, ObserverSnapshot<unknown>>();
  for (const observation of observations) {
    const key = queryObservationKey(database, observation.request);
    if (output.has(key)) throw new Error('Duplicate server observation: ' + key);
    output.set(key, observation.snapshot);
  }
  return output;
};
