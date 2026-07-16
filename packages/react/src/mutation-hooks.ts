import { useCallback, useContext } from 'react';
import type {
  CommitFunction,
  MutationState,
  MutationStateOptions
} from './contracts.js';
import { CommitActionsContext, useRuntime } from './context.js';
import { useExternalStoreWithSelector } from './use-external-store-with-selector.js';

/** Returns the current provider commit action without replacing the query runtime. */
export const useCommit = (): CommitFunction => {
  const store = useRuntime().mutationStore;
  const actions = useContext(CommitActionsContext);
  const commit = useCallback(
    (attempt: Parameters<CommitFunction>[0]) =>
      store.commit(attempt, actions?.executeCommit, actions?.createOptimisticOverlay),
    [actions?.createOptimisticOverlay, actions?.executeCommit, store]
  );
  if (actions === undefined) throw new Error('Tarstate hooks require a TarstateProvider');
  return commit;
};

/** Observes immutable bounded mutation history, optionally through a render-suppressing selector. */
export function useMutationState(): MutationState;
export function useMutationState<Selected>(options: MutationStateOptions<Selected>): Selected;
export function useMutationState<Selected = MutationState>(
  options?: MutationStateOptions<Selected>
): Selected {
  const store = useRuntime().mutationStore;
  const selectState = options?.selectState ?? identityMutationState<Selected>;
  return useExternalStoreWithSelector(
    store.subscribe,
    store.getSnapshot,
    store.getSnapshot,
    selectState,
    options?.areSelectionsEqual ?? Object.is
  );
}

const identityMutationState = <Selected>(state: MutationState): Selected => state as Selected;
