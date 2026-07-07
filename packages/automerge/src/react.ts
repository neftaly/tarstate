import type * as Automerge from '@automerge/automerge';
import type { DocHandle } from '@automerge/automerge-repo';
import type { RelationRef } from '@tarstate/core/schema';
import type { Store } from '@tarstate/core/store';
import { useLocalRuntimeStore } from '@tarstate/react';
import {
  createAutomergeDocHandleRuntime,
  type AutomergeDocHandleRuntimeOptions,
  type AutomergeMapRelationInput,
  type AutomergeRelationDocument
} from './index.js';

export type UseAutomergeDocHandleStoreOptions<
  DocumentShape extends object = Record<string, unknown>
> = Omit<AutomergeDocHandleRuntimeOptions<DocumentShape>, 'handle' | 'relations'> & {
  readonly resetKey?: unknown;
};

export function useAutomergeDocHandleStore<const Relations extends Readonly<Record<string, RelationRef>>>(
  handle: DocHandle<AutomergeRelationDocument<Relations>>,
  relations: Relations,
  options?: UseAutomergeDocHandleStoreOptions<AutomergeRelationDocument<Relations>>
): Store<Automerge.Heads>;
export function useAutomergeDocHandleStore<DocumentShape extends object>(
  handle: DocHandle<DocumentShape>,
  relations: AutomergeMapRelationInput<DocumentShape>,
  options?: UseAutomergeDocHandleStoreOptions<DocumentShape>
): Store<Automerge.Heads>;
export function useAutomergeDocHandleStore<DocumentShape extends object>(
  handle: DocHandle<DocumentShape>,
  relations: AutomergeMapRelationInput<DocumentShape>,
  options: UseAutomergeDocHandleStoreOptions<DocumentShape> = {}
): Store<Automerge.Heads> {
  const { resetKey, ...runtimeOptions } = options;

  return useLocalRuntimeStore(
    () =>
      createAutomergeDocHandleRuntime({
        ...runtimeOptions,
        handle,
        relations
      }),
    [
      handle,
      relations,
      runtimeOptions.changeMessage,
      runtimeOptions.env,
      runtimeOptions.repo,
      runtimeOptions.runtimeId,
      runtimeOptions.system,
      resetKey
    ]
  );
}
