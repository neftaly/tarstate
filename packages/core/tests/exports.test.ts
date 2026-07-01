import { describe, expect, expectTypeOf, it } from 'vitest';
import * as core from '@tarstate/core';
import * as adapter from '@tarstate/core/adapter';
import {
  isRelationAdapter,
  tryCommitAdapter,
  type AdapterCommitResult,
  type AdapterSource,
  type RelationAdapter
} from '@tarstate/core/adapter';
import * as constraints from '@tarstate/core/constraints';
import * as db from '@tarstate/core/db';
import { createDb, dbSource, q, transact, type Db } from '@tarstate/core/db';
import * as delta from '@tarstate/core/delta';
import * as diff from '@tarstate/core/diff';
import * as diagnostics from '@tarstate/core/diagnostics';
import * as evaluate from '@tarstate/core/evaluate';
import * as identity from '@tarstate/core/identity';
import * as materialization from '@tarstate/core/materialization';
import * as memoryRuntime from '@tarstate/core/memory-runtime';
import * as query from '@tarstate/core/query';
import { as, eq, from, keyBy, pipe, project, queryKey, where } from '@tarstate/core/query';
import * as runtime from '@tarstate/core/runtime';
import * as schema from '@tarstate/core/schema';
import {
  booleanField,
  defineSchema,
  idField,
  jsonField,
  relation,
  stringField,
  type RelationRef
} from '@tarstate/core/schema';
import * as source from '@tarstate/core/source';
import {
  composeSources,
  fromIndexedObjectSource,
  fromObjectSource,
  isRelationSource,
  type RelationSource
} from '@tarstate/core/source';
import * as store from '@tarstate/core/store';
import { createStore, type Store } from '@tarstate/core/store';
import * as watch from '@tarstate/core/watch';
import * as writeApply from '@tarstate/core/write-apply';
import * as write from '@tarstate/core/write';
import { write as writeRelation, type WritePatch } from '@tarstate/core/write';

type ConsumerTodo = {
  readonly id: string;
  readonly title: string;
  readonly done: boolean;
  readonly metadata: {
    readonly priority: number;
    readonly tags: readonly string[];
  };
};

const consumerSchema = defineSchema({
  todos: relation<ConsumerTodo>({
    key: 'id',
    fields: {
      id: idField('todo'),
      title: stringField(),
      done: booleanField(),
      metadata: jsonField()
    }
  })
});

const consumerTodo = as(consumerSchema.todos, 'todo');
const openTodoSummaries = pipe(
  from(consumerTodo),
  where(eq(consumerTodo.done, false)),
  project({
    id: consumerTodo.id,
    title: consumerTodo.title
  }),
  keyBy('id')
);
const consumerTodos = writeRelation(consumerSchema.todos);

describe('tarstate core public exports', () => {
  it('keeps the root convenience barrel and taxonomy subpath imports available', () => {
    expect(core).toHaveProperty('defineSchema');
    expect(adapter).toHaveProperty('isRelationAdapter');
    expect(adapter).toHaveProperty('isRelationRuntime');
    expect(adapter).toHaveProperty('tryCommitAdapter');
    expect(adapter).toHaveProperty('tryApplyRelationPatches');
    expect(adapter).toHaveProperty('relationApplyResultFromAdapterCommit');
    expect(adapter).toHaveProperty('composeRelationRuntimes');
    expect(core).toHaveProperty('isRelationAdapter');
    expect(core).toHaveProperty('isRelationRuntime');
    expect(core).toHaveProperty('tryCommitAdapter');
    expect(core).toHaveProperty('tryApplyRelationPatches');
    expect(core).toHaveProperty('relationApplyResultFromAdapterCommit');
    expect(core).toHaveProperty('composeRelationRuntimes');
    expect(constraints).toHaveProperty('constrain');
    expect(constraints).toHaveProperty('tryTransactConstrained');
    expect(db).toHaveProperty('qMany');
    expect(db).not.toHaveProperty('tryTransactConstrained');
    expect(delta).toHaveProperty('relationDeltas');
    expect(diff).toHaveProperty('diffRows');
    expect(diagnostics).toBeDefined();
    expect(evaluate).toHaveProperty('evaluate');
    expect(identity).toHaveProperty('stableKey');
    expect(materialization).toHaveProperty('explainMaterialization');
    expect(materialization).toHaveProperty('materializedRowsFor');
    expect(materialization).toHaveProperty('materializedRowsForQuery');
    expect(materialization).toHaveProperty('materializedSourceFor');
    expect(materialization).toHaveProperty('readMaterializedQuery');
    expect(materialization).toHaveProperty('snapshotIndex');
    expect(materialization).toHaveProperty('snapshotHashIndex');
    expect(core).toHaveProperty('materializedRowsFor');
    expect(core).toHaveProperty('materializedSourceFor');
    expect(core).toHaveProperty('readMaterializedQuery');
    expect(core).toHaveProperty('snapshotHashIndex');
    expect(core).toHaveProperty('createMemoryRelationRuntime');
    expect(memoryRuntime).toHaveProperty('createMemoryRelationRuntime');
    expect(materialization).not.toHaveProperty('index');
    expect(materialization).not.toHaveProperty('materializationIndex');
    expect(core).not.toHaveProperty('index');
    expect(core).not.toHaveProperty('materializationIndex');
    expect(query).toHaveProperty('from');
    expect(query).toHaveProperty('keyBy');
    expect(core).toHaveProperty('keyBy');
    expect(query).toHaveProperty('setConcat');
    expect(runtime).toHaveProperty('trackTransact');
    expect(runtime).toHaveProperty('trackRuntimeCommit');
    expect(core).toHaveProperty('trackRuntimeCommit');
    expect(schema).toHaveProperty('relation');
    expect(schema).toHaveProperty('jsonField');
    expect(source).toHaveProperty('fromObjectSource');
    expect(source).not.toHaveProperty('asRelationSource');
    expect(store).toHaveProperty('createStore');
    expect(core).toHaveProperty('createStore');
    expect(watch).toHaveProperty('watch');
    expect(watch).toHaveProperty('watchRuntime');
    expect(watch).toHaveProperty('subscribeWatch');
    expect(core).toHaveProperty('watchRuntime');
    expect(core).toHaveProperty('subscribeWatch');
    expect(watch).not.toHaveProperty('trackWatchedChanges');
    expect(watch).not.toHaveProperty('transferWatchRegistrations');
    expect(writeApply).toHaveProperty('applyWrites');
    expect(writeApply).toHaveProperty('applyWritesAtomic');
    expect(write).toHaveProperty('write');
    expect(write).toHaveProperty('insertOrUpdate');
    expect(write).toHaveProperty('deleteExact');
    expect(write).toHaveProperty('replaceAll');
    expect(write).not.toHaveProperty('applyWrites');
    expect(core).toHaveProperty('insertOrUpdate');
    expect(core).toHaveProperty('deleteExact');
    expect(core).toHaveProperty('replaceAll');
    expect(core).not.toHaveProperty('applyWrites');
  });

  it('keeps the stable subpath teaching path consumable from package imports', async () => {
    expectTypeOf(consumerSchema.todos).toMatchTypeOf<RelationRef<ConsumerTodo>>();

    const insertPatch = consumerTodos.insert({
      id: 'todo-b',
      title: 'Beta',
      done: false,
      metadata: { priority: 2, tags: ['api'] }
    });

    expectTypeOf(insertPatch).toMatchTypeOf<WritePatch<typeof consumerSchema.todos>>();

    const nextDb = transact(
      createDb({
        todos: [
          {
            id: 'todo-a',
            title: 'Alpha',
            done: false,
            metadata: { priority: 1, tags: ['seed'] }
          }
        ]
      }),
      [
        insertPatch,
        consumerTodos.insertOrUpdate({ id: 'todo-a', done: true })
      ]
    );

    expectTypeOf(nextDb).toMatchTypeOf<Db>();

    const result = await q(nextDb, openTodoSummaries);
    const consumerStore = createStore(nextDb);

    expect(result).toEqual({
      rows: [{ id: 'todo-b', title: 'Beta' }],
      diagnostics: []
    });
    expectTypeOf(consumerStore).toMatchTypeOf<Store>();
    await expect(consumerStore.view(openTodoSummaries).rows()).resolves.toEqual([
      { id: 'todo-b', title: 'Beta' }
    ]);
    expect(queryKey(openTodoSummaries)).toContain('query:');

    const dbBackedSource = dbSource(nextDb);
    const composedSource: RelationSource = composeSources(dbBackedSource, fromObjectSource({ todos: [] }));
    const indexedSource = fromIndexedObjectSource(nextDb.data);

    expect(isRelationSource(composedSource)).toBe(true);
    expect(Array.from(await composedSource.rows(consumerSchema.todos))).toEqual(nextDb.data.todos);
    expect(await indexedSource.lookup?.({ relation: consumerSchema.todos, field: 'id', value: 'todo-b' })).toEqual([
      {
        id: 'todo-b',
        title: 'Beta',
        done: false,
        metadata: { priority: 2, tags: ['api'] }
      }
    ]);

    let committedPatches = 0;
    const adapterSource: AdapterSource<number> = {
      ...fromObjectSource(nextDb.data),
      version: () => 7
    };
    const relationAdapter: RelationAdapter<number> = {
      source: adapterSource,
      commit: (patches) => {
        const patchList = Array.from(patches);
        committedPatches += patchList.length;
        const commitResult: AdapterCommitResult<number> = {
          status: 'committed',
          committed: true,
          patches: patchList.length,
          applied: patchList.length,
          deltas: [],
          diagnostics: [],
          version: 8
        };

        return commitResult;
      }
    };

    expect(isRelationAdapter(relationAdapter)).toBe(true);

    const commitReport = await tryCommitAdapter(relationAdapter, [consumerTodos.delete('todo-b')]);

    expectTypeOf(commitReport.source).toMatchTypeOf<AdapterSource<number>>();
    if (commitReport.status === 'committed') {
      expectTypeOf(commitReport.committed).toEqualTypeOf<true>();
    }
    expect(commitReport.source).toBe(adapterSource);
    expect(commitReport).toMatchObject({
      status: 'committed',
      committed: true,
      patches: 1,
      applied: 1,
      diagnostics: [],
      version: 8
    });
    expect(committedPatches).toBe(1);
  });
});
