import * as Automerge from '@automerge/automerge';
import { describe, expect, expectTypeOf, it } from 'vitest';
import { isRelationAdapter, tryApplyRelationPatches, tryCommitAdapter } from '@tarstate/core/adapter';
import {
  booleanField,
  defineSchema,
  idField,
  numberField,
  relation,
  stringField
} from '@tarstate/core/schema';
import { write } from '@tarstate/core/write';
import {
  automergeMapAdapter,
  automergeMapSource,
  type AutomergeMapAdapter,
  type AutomergeMapSource
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

type OptionalTaskDocument = {
  readonly workspace?: {
    readonly tasks?: Record<string, StoredTaskRow>;
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

describe('automerge map adapter contract', () => {
  it('exposes the public map adapter API only from @tarstate/automerge', async () => {
    const api = await import('@tarstate/automerge');
    const doc = taskDoc({});
    const adapter = automergeMapAdapter<TaskDocument>({ doc, relations: taskRelations });

    expect(api.automergeMapAdapter).toBe(automergeMapAdapter);
    expect(api.automergeMapSource).toBe(automergeMapSource);
    expect('createAutomergeMapAdapter' in api).toBe(false);
    expect('createAutomergeRelationSource' in api).toBe(false);
    expect(adapter.getDoc()).toBe(doc);
    expect(isRelationAdapter(adapter)).toBe(true);
    expectTypeOf(automergeMapAdapter<TaskDocument>).returns.toMatchTypeOf<AutomergeMapAdapter<TaskDocument>>();
    expectTypeOf(automergeMapSource<TaskDocument>).returns.toMatchTypeOf<AutomergeMapSource>();
  });

  it('reads map-v1 rows, restores row keys, supports lookups, versions, and invalid-row diagnostics', async () => {
    const doc = Automerge.from<{ readonly workspace: { readonly tasks: Record<string, unknown> } }>({
      workspace: {
        tasks: {
          'task-a': { title: 'Draft contract', done: false, rank: 1 },
          'task-b': { title: 'Ship adapter', done: true, rank: 3 },
          'task-c': { title: 'Missing done', rank: 2 },
          'task-d': 'not a relation row'
        }
      }
    });
    const source = automergeMapSource(doc, { relations: taskRelations });

    expect(source.relationNames).toEqual(['tasks']);
    expect(await source.version?.()).toEqual(Automerge.getHeads(doc));
    expect(await source.rows(schema.tasks)).toEqual([
      { id: 'task-a', title: 'Draft contract', done: false, rank: 1 },
      { id: 'task-b', title: 'Ship adapter', done: true, rank: 3 }
    ]);
    expect(await source.lookup?.({ relation: schema.tasks, field: 'id', value: 'task-b' })).toEqual([
      { id: 'task-b', title: 'Ship adapter', done: true, rank: 3 }
    ]);
    expect(await source.rangeLookup?.({
      relation: schema.tasks,
      field: 'rank',
      lower: { value: 2, inclusive: true },
      upper: { value: 4, inclusive: false }
    })).toEqual([{ id: 'task-b', title: 'Ship adapter', done: true, rank: 3 }]);
    expect(await source.diagnostics?.()).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'invalid_row', relation: 'tasks', field: 'done' }),
      expect.objectContaining({ code: 'invalid_row', relation: 'tasks' })
    ]));
  });

  it('commits insert, update, and delete as one Automerge change with relation deltas', async () => {
    const doc = taskDoc({
      'task-a': { title: 'Draft contract', done: false, rank: 1 },
      'task-c': { title: 'Remove old note', done: false, rank: 4 }
    });
    let changedDoc: Automerge.Doc<TaskDocument> | undefined;
    const adapter = automergeMapAdapter<TaskDocument>({
      doc,
      relations: taskRelations,
      onDocChange: (nextDoc) => {
        changedDoc = nextDoc;
      }
    });
    const beforeHeads = Automerge.getHeads(adapter.getDoc());

    const result = await tryCommitAdapter(adapter, [
      tasks.updateByKey('task-a', { done: true }),
      tasks.insert({ id: 'task-b', title: 'Ship adapter', done: false, rank: 2 }),
      tasks.deleteByKey('task-c')
    ], { readVersion: true });

    expect(result).toMatchObject({
      status: 'accepted',
      patches: 3,
      applied: 3,
      diagnostics: []
    });
    expect(result.version).toEqual(Automerge.getHeads(adapter.getDoc()));
    expect(result.version).not.toEqual(beforeHeads);
    expect(changedDoc).toBe(adapter.getDoc());
    expect(result.deltas.map((delta) => delta.relation.name)).toEqual(['tasks']);
    expect(await adapter.source.rows(schema.tasks)).toEqual([
      { id: 'task-a', title: 'Draft contract', done: true, rank: 1 },
      { id: 'task-b', title: 'Ship adapter', done: false, rank: 2 }
    ]);
  });

  it('applies replaceAll through the runtime target with a durable normalized report', async () => {
    const adapter = automergeMapAdapter<TaskDocument>({
      doc: taskDoc({
        'task-a': { title: 'Draft contract', done: false, rank: 1 },
        'task-b': { title: 'Ship adapter', done: false, rank: 2 }
      }),
      relations: taskRelations
    });

    const result = await tryApplyRelationPatches(adapter, [
      tasks.replaceAll([{ id: 'task-z', title: 'Regenerate implementation', done: false, rank: 9 }])
    ], { readVersion: true });

    expect(result).toMatchObject({
      status: 'accepted',
      patches: 1,
      applied: 1,
      diagnostics: [],
      durability: 'durable'
    });
    expect(result.version).toEqual(Automerge.getHeads(adapter.getDoc()));
    expect(result.deltas.map((delta) => delta.relation.name)).toEqual(['tasks']);
    expect(await adapter.source.rows(schema.tasks)).toEqual([
      { id: 'task-z', title: 'Regenerate implementation', done: false, rank: 9 }
    ]);
  });

  it('rejects invalid write batches atomically without mutating the Automerge document', async () => {
    const adapter = automergeMapAdapter<TaskDocument>({
      doc: taskDoc({ 'task-a': { title: 'Draft contract', done: false, rank: 1 } }),
      relations: taskRelations
    });
    const beforeDoc = adapter.getDoc();
    const beforeHeads = Automerge.getHeads(beforeDoc);

    const result = await tryCommitAdapter(adapter, [
      tasks.updateByKey('task-a', { done: true }),
      tasks.deleteByKey('task-missing')
    ], { readVersion: true });

    expect(result).toMatchObject({
      status: 'rejected',
      patches: 2,
      applied: 0,
      deltas: []
    });
    expect(result.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'missing_ref', relation: 'tasks' })
    ]));
    expect(adapter.getDoc()).toBe(beforeDoc);
    expect(Automerge.getHeads(adapter.getDoc())).toEqual(beforeHeads);
    expect(await adapter.source.rows(schema.tasks)).toEqual([
      { id: 'task-a', title: 'Draft contract', done: false, rank: 1 }
    ]);
  });

  it('creates missing nested map paths when inserting into an empty document', async () => {
    const adapter = automergeMapAdapter<OptionalTaskDocument>({
      doc: Automerge.from<OptionalTaskDocument>({}),
      relations: taskRelations
    });
    const beforeHeads = Automerge.getHeads(adapter.getDoc());

    const result = await tryCommitAdapter(adapter, [
      tasks.insert({ id: 'task-a', title: 'Create nested path', done: false, rank: 1 })
    ], { readVersion: true });

    expect(result).toMatchObject({
      status: 'accepted',
      patches: 1,
      applied: 1,
      diagnostics: []
    });
    expect(result.version).toEqual(Automerge.getHeads(adapter.getDoc()));
    expect(result.version).not.toEqual(beforeHeads);
    expect(adapter.getDoc().workspace?.tasks?.['task-a']).toEqual({
      title: 'Create nested path',
      done: false,
      rank: 1
    });
    expect(await adapter.source.rows(schema.tasks)).toEqual([
      { id: 'task-a', title: 'Create nested path', done: false, rank: 1 }
    ]);
  });

  it('replaceAll removes stale keys, writes replacement rows, and advances heads once', async () => {
    const adapter = automergeMapAdapter<TaskDocument>({
      doc: taskDoc({
        'task-a': { title: 'Remove me', done: false, rank: 1 },
        'task-b': { title: 'Keep with edits', done: false, rank: 2 }
      }),
      relations: taskRelations
    });
    const beforeHeads = Automerge.getHeads(adapter.getDoc());

    const result = await tryCommitAdapter(adapter, [
      tasks.replaceAll([
        { id: 'task-b', title: 'Kept with edits', done: true, rank: 20 },
        { id: 'task-c', title: 'Added replacement', done: false, rank: 30 }
      ])
    ], { readVersion: true });

    expect(result).toMatchObject({
      status: 'accepted',
      patches: 1,
      applied: 1,
      diagnostics: []
    });
    expect(result.deltas.map((delta) => delta.relation.name)).toEqual(['tasks']);
    expect(result.version).toEqual(Automerge.getHeads(adapter.getDoc()));
    expect(result.version).not.toEqual(beforeHeads);
    expect(adapter.getDoc().workspace.tasks).toEqual({
      'task-b': { title: 'Kept with edits', done: true, rank: 20 },
      'task-c': { title: 'Added replacement', done: false, rank: 30 }
    });
  });

  it('reports missing-key deletes as atomic no-ops with preserved heads', async () => {
    const adapter = automergeMapAdapter<TaskDocument>({
      doc: taskDoc({ 'task-a': { title: 'Keep me', done: false, rank: 1 } }),
      relations: taskRelations
    });
    const beforeDoc = adapter.getDoc();
    const beforeHeads = Automerge.getHeads(beforeDoc);

    const result = await tryCommitAdapter(adapter, [
      tasks.deleteByKey('task-missing')
    ], { readVersion: true });

    expect(result).toMatchObject({
      status: 'rejected',
      patches: 1,
      applied: 0,
      deltas: [],
      diagnostics: [expect.objectContaining({ code: 'missing_ref', relation: 'tasks' })],
      version: beforeHeads
    });
    expect(adapter.getDoc()).toBe(beforeDoc);
    expect(Automerge.getHeads(adapter.getDoc())).toEqual(beforeHeads);
    expect(await adapter.source.rows(schema.tasks)).toEqual([
      { id: 'task-a', title: 'Keep me', done: false, rank: 1 }
    ]);
  });

  it('rejects invalid inserted rows without mutating the Automerge document', async () => {
    const adapter = automergeMapAdapter<TaskDocument>({
      doc: taskDoc({ 'task-a': { title: 'Keep me', done: false, rank: 1 } }),
      relations: taskRelations
    });
    const beforeDoc = adapter.getDoc();
    const beforeHeads = Automerge.getHeads(beforeDoc);

    const result = await tryCommitAdapter(adapter, [
      tasks.insert(taskRow({ id: 'task-b', title: 'Missing required fields' }))
    ], { readVersion: true });

    expect(result).toMatchObject({
      status: 'rejected',
      patches: 1,
      applied: 0,
      deltas: [],
      diagnostics: [expect.objectContaining({ code: 'invalid_row', relation: 'tasks' })],
      version: beforeHeads
    });
    expect(adapter.getDoc()).toBe(beforeDoc);
    expect(Automerge.getHeads(adapter.getDoc())).toEqual(beforeHeads);
    expect(await adapter.source.rows(schema.tasks)).toEqual([
      { id: 'task-a', title: 'Keep me', done: false, rank: 1 }
    ]);
  });

  it('treats missing source paths as empty relations without diagnostics', async () => {
    const source = automergeMapSource(Automerge.from<OptionalTaskDocument>({}), { relations: taskRelations });

    expect(await source.rows(schema.tasks)).toEqual([]);
    expect(await source.lookup?.({ relation: schema.tasks, field: 'id', value: 'task-a' })).toEqual([]);
    expect(await source.diagnostics?.()).toEqual([]);
  });

  it('keeps valid rows readable while reporting malformed map rows', async () => {
    const doc = Automerge.from<{ readonly workspace: { readonly tasks: Record<string, unknown> } }>({
      workspace: {
        tasks: {
          'task-a': { title: 'Readable row', done: false, rank: 1 },
          'task-b': { title: { text: 'not a string' }, done: false, rank: 2 },
          'task-c': ['not', 'a', 'row']
        }
      }
    });
    const source = automergeMapSource(doc, { relations: taskRelations });

    expect(await source.rows(schema.tasks)).toEqual([
      { id: 'task-a', title: 'Readable row', done: false, rank: 1 }
    ]);
    expect(await source.diagnostics?.()).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'invalid_row', relation: 'tasks', field: 'title' }),
      expect.objectContaining({ code: 'invalid_row', relation: 'tasks' })
    ]));
  });
});

function taskRow(row: unknown): TaskRow {
  return row as TaskRow;
}
