import { describe, expect, expectTypeOf, it } from 'vitest';
import * as core from '@tarstate/core';
import {
  isRelationAdapter,
  tryApplyRelationPatches,
  tryCommitAdapter,
  type AdapterCommitResult,
  type AdapterSource,
  type RelationAdapter
} from '@tarstate/core/adapter';
import * as db from '@tarstate/core/db';
import { createDb, dbSource, q, stripMeta, transact, type Db } from '@tarstate/core/db';
import * as query from '@tarstate/core/query';
import { as, eq, from, keyBy, pipe, project, where } from '@tarstate/core/query';
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
import {
  composeSources,
  fromObjectSource,
  isRelationSource,
  type RelationSource
} from '@tarstate/core/source';
import * as store from '@tarstate/core/store';
import { createStore, type Store } from '@tarstate/core/store';
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
  it('keeps root convenience exports aligned with stable consumer subpaths', () => {
    expect(core.defineSchema).toBe(schema.defineSchema);
    expect(core.from).toBe(query.from);
    expect(core.createDb).toBe(db.createDb);
    expect(core.createStore).toBe(store.createStore);
    expect(core.write).toBe(write.write);
    expect(core.tryApplyRelationPatches).toBe(tryApplyRelationPatches);
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
        consumerTodos.insertOrUpdate(
          {
            id: 'todo-a',
            title: 'Alpha',
            done: false,
            metadata: { priority: 1, tags: ['seed'] }
          },
          { update: { done: true } }
        )
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
    const dbBackedSource = dbSource(nextDb);
    const composedSource: RelationSource = composeSources(dbBackedSource, fromObjectSource({ todos: [] }));
    const nextData = stripMeta(nextDb);

    expect(isRelationSource(composedSource)).toBe(true);
    expect(Array.from(await composedSource.rows(consumerSchema.todos))).toEqual(nextData.todos);

    let committedPatches = 0;
    const adapterSource: AdapterSource<number> = {
      ...fromObjectSource(nextData),
      version: () => 7
    };
    const relationAdapter: RelationAdapter<number> = {
      source: adapterSource,
      commit: (patches) => {
        const patchList = Array.from(patches);
        committedPatches += patchList.length;
        const commitResult: AdapterCommitResult<number> = {
          status: 'accepted',
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

    const commitReport = await tryCommitAdapter(relationAdapter, [consumerTodos.deleteByKey('todo-b')]);

    expectTypeOf(commitReport.source).toMatchTypeOf<AdapterSource<number>>();
    if (commitReport.status === 'accepted') {
    }
    expect(commitReport.source).toBe(adapterSource);
    expect(commitReport).toMatchObject({
      status: 'accepted',
      patches: 1,
      applied: 1,
      diagnostics: [],
      version: 8
    });
    expect(committedPatches).toBe(1);
  });
});
