import * as Automerge from '@automerge/automerge';
import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  booleanField,
  defineSchema,
  idField,
  numberField,
  relation,
  stringField
} from '@tarstate/core/schema';
import { as, eq, from, pipe, project, where } from '@tarstate/core/query';
import { write } from '@tarstate/core/write';
import {
  automergeDb,
  automergeMapAdapter,
  automergeMapSource,
  type AutomergeDb
} from '@tarstate/automerge';

type TaskRow = {
  readonly id: string;
  readonly title: string;
  readonly done: boolean;
  readonly rank: number;
};

type StoredTaskRow = Omit<TaskRow, 'id'> & { readonly id?: string };

type TaskDocument = {
  readonly workspace: {
    readonly tasks: Record<string, StoredTaskRow>;
  };
};

const schema = defineSchema({
  tasks: relation<TaskRow>({
    key: 'id',
    fields: {
      id: idField('task'),
      title: stringField(),
      done: booleanField(),
      rank: numberField()
    }
  })
});

const taskRelations = [{ relation: schema.tasks, path: ['workspace', 'tasks'] }] as const;
const tasks = write(schema.tasks);

function taskDoc(tasksById: Record<string, StoredTaskRow>): Automerge.Doc<TaskDocument> {
  return Automerge.from<TaskDocument>({ workspace: { tasks: tasksById } });
}

describe('automerge Relic DB integration', () => {
  it('exposes Automerge-backed DB helpers beside the package-level map runtime', async () => {
    const api = await import('@tarstate/automerge');
    const relic = automergeDb<TaskDocument>(taskDoc({}), { relations: taskRelations });

    expect(api.automergeDb).toBe(automergeDb);
    expect(api.automergeMapAdapter).toBe(automergeMapAdapter);
    expect(api.automergeMapSource).toBe(automergeMapSource);
    expect(relic.kind).toBe('automergeDb');
    expect(relic.adapter.getDoc()).toBe(relic.getDoc());
    expectTypeOf(automergeDb<TaskDocument>).returns.toMatchTypeOf<AutomergeDb<TaskDocument>>();
  });

  it('creates a core Db snapshot from map-v1 storage and queries it with q', async () => {
    const task = as(schema.tasks, 'task');
    const query = pipe(
      from(task),
      where(eq(task.done, false)),
      project({ id: task.id, title: task.title })
    );
    const relic = automergeDb<TaskDocument>(taskDoc({
      'task-a': { title: 'Draft contract', done: false, rank: 1 },
      'task-b': { title: 'Ship adapter', done: true, rank: 2 }
    }), { relations: taskRelations, env: { tenant: 'acme' } });

    const snapshot = await relic.getSnapshot();

    expect(snapshot.db.env).toEqual({ tenant: 'acme' });
    expect(snapshot.db.data.tasks).toEqual([
      { id: 'task-a', title: 'Draft contract', done: false, rank: 1 },
      { id: 'task-b', title: 'Ship adapter', done: true, rank: 2 }
    ]);
    await expect(relic.q(query)).resolves.toMatchObject({
      rows: [{ id: 'task-a', title: 'Draft contract' }],
      diagnostics: []
    });
  });

  it('transacts through core write inputs, updates Automerge heads and returns the next Db', async () => {
    const relic = automergeDb<TaskDocument>(taskDoc({
      'task-a': { title: 'Draft contract', done: false, rank: 1 }
    }), { relations: taskRelations });
    const beforeHeads = Automerge.getHeads(relic.getDoc());

    const nextDb = await relic.transact((db) => {
      const firstTask = db.data.tasks?.[0] as TaskRow | undefined;
      return [
        tasks.updateByKey(firstTask?.id ?? 'task-a', { done: true }),
        tasks.insert({ id: 'task-b', title: 'Ship Relic API', done: false, rank: 2 })
      ];
    });
    const afterHeads = Automerge.getHeads(relic.getDoc());

    expect(afterHeads).not.toEqual(beforeHeads);
    expect(nextDb.data.tasks).toEqual([
      { id: 'task-a', title: 'Draft contract', done: true, rank: 1 },
      { id: 'task-b', title: 'Ship Relic API', done: false, rank: 2 }
    ]);
    expect(relic.getDoc().workspace.tasks).toEqual({
      'task-a': { title: 'Draft contract', done: true, rank: 1 },
      'task-b': { title: 'Ship Relic API', done: false, rank: 2 }
    });
  });

  it('reports rejected transactions without mutating the Automerge document', async () => {
    const relic = automergeDb<TaskDocument>(taskDoc({
      'task-a': { title: 'Draft contract', done: false, rank: 1 }
    }), { relations: taskRelations });
    const beforeDoc = relic.getDoc();
    const beforeHeads = Automerge.getHeads(beforeDoc);

    const result = await relic.tryTransact([
      tasks.updateByKey('task-a', { done: true }),
      tasks.deleteByKey('missing')
    ]);

    expect(result).toMatchObject({
      kind: 'automergeDbTransaction',
      committed: false,
      patches: 2,
      applied: 0,
      deltas: []
    });
    expect(result.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'missing_ref', relation: 'tasks' })
    ]));
    expect(relic.getDoc()).toBe(beforeDoc);
    expect(Automerge.getHeads(relic.getDoc())).toEqual(beforeHeads);
    await expect(relic.db()).resolves.toMatchObject({
      data: {
        tasks: [{ id: 'task-a', title: 'Draft contract', done: false, rank: 1 }]
      }
    });
  });

  it('materializes and watches over the Automerge source', async () => {
    const task = as(schema.tasks, 'task');
    const query = pipe(from(task), project({ id: task.id, done: task.done }));
    const relic = automergeDb<TaskDocument>(taskDoc({
      'task-a': { title: 'Draft contract', done: false, rank: 1 }
    }), { relations: taskRelations });
    const events: (readonly unknown[])[] = [];
    const handle = relic.watch(query, (event) => {
      events.push(event.rows);
    }, { keyBy: ['id'] });

    const materialized = await relic.mat(query, { id: 'task-status' });
    expect(materialized).toMatchObject({
      kind: 'automergeDbMaterialization',
      id: 'task-status',
      rows: [{ id: 'task-a', done: false }],
      diagnostics: []
    });

    await expect(handle.refresh()).resolves.toMatchObject({
      changed: true,
      rows: [{ id: 'task-a', done: false }]
    });
    await relic.transact(tasks.updateByKey('task-a', { done: true }));
    await expect(handle.refresh()).resolves.toMatchObject({
      changed: true,
      previousRows: [{ id: 'task-a', done: false }],
      rows: [{ id: 'task-a', done: true }]
    });
    expect(events).toEqual([
      [{ id: 'task-a', done: false }],
      [{ id: 'task-a', done: true }]
    ]);
  });
});
