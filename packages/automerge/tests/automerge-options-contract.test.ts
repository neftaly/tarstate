import * as Automerge from '@automerge/automerge';
import { describe, expect, it } from 'vitest';
import { tryApplyRelationPatches, tryCommitAdapter } from '@tarstate/core/adapter';
import {
  booleanField,
  defineSchema,
  idField,
  numberField,
  relation,
  stringField
} from '@tarstate/core/schema';
import { write, type WritePatch } from '@tarstate/core/write';
import {
  automergeMapAdapter,
  automergeMapSource
} from '@tarstate/automerge';

type TaskRow = {
  readonly id: string;
  readonly title: string;
  readonly done: boolean;
  readonly rank: number;
};

type ProjectRow = {
  readonly id: string;
  readonly name: string;
  readonly priority: number;
};

type StoredTaskRow = Omit<TaskRow, 'id'> & { readonly id?: string };
type StoredProjectRow = Omit<ProjectRow, 'id'> & { readonly id?: string };

type WorkspaceDocument = {
  readonly workspace: {
    readonly tasks: Record<string, StoredTaskRow>;
    readonly projects: Record<string, StoredProjectRow>;
  };
  readonly archive: {
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
  }),
  projects: relation<ProjectRow>({
    key: 'id',
    fields: {
      id: idField('project'),
      name: stringField(),
      priority: numberField()
    }
  })
});

const taskRelations = [{ relation: schema.tasks, path: ['workspace', 'tasks'] }] as const;
const workspaceRelations = [
  { relation: schema.tasks, path: ['workspace', 'tasks'] },
  { relation: schema.projects, path: ['workspace', 'projects'] }
] as const;
const archivedTaskRelations = [{ relation: schema.tasks, path: ['archive', 'tasks'] }] as const;
const tasks = write(schema.tasks);
const projects = write(schema.projects);

function workspaceDoc(input: {
  readonly tasks?: Record<string, StoredTaskRow>;
  readonly projects?: Record<string, StoredProjectRow>;
  readonly archivedTasks?: Record<string, StoredTaskRow>;
} = {}): Automerge.Doc<WorkspaceDocument> {
  return Automerge.from<WorkspaceDocument>({
    workspace: {
      tasks: input.tasks ?? {},
      projects: input.projects ?? {}
    },
    archive: {
      tasks: input.archivedTasks ?? {}
    }
  });
}

function latestChangeMessage<DocumentShape>(doc: Automerge.Doc<DocumentShape>): string | null | undefined {
  return Automerge.getHistory(doc).at(-1)?.change.message;
}

describe('automerge adapter option contracts', () => {
  it('records a string changeMessage on the Automerge commit history', async () => {
    const adapter = automergeMapAdapter<WorkspaceDocument>({
      doc: workspaceDoc(),
      relations: taskRelations,
      changeMessage: 'insert task through adapter'
    });

    const result = await tryCommitAdapter(adapter, [
      tasks.insert({ id: 'task-a', title: 'Draft contract', done: false, rank: 1 })
    ], { readVersion: true });

    expect(result).toMatchObject({ status: 'accepted', diagnostics: [] });
    expect(result.version).toEqual(Automerge.getHeads(adapter.getDoc()));
    expect(latestChangeMessage(adapter.getDoc())).toBe('insert task through adapter');
  });

  it('computes changeMessage from the committed write patch batch', async () => {
    const messages: string[] = [];
    const adapter = automergeMapAdapter<WorkspaceDocument>({
      doc: workspaceDoc({ tasks: { 'task-a': { title: 'Draft contract', done: false, rank: 1 } } }),
      relations: taskRelations,
      changeMessage: (patches: readonly WritePatch[]) => {
        const message = `automerge:${patches.map((patch) => patch.op).join(',')}`;
        messages.push(message);
        return message;
      }
    });

    const result = await adapter.target.apply([
      tasks.updateByKey('task-a', { done: true }),
      tasks.insert({ id: 'task-b', title: 'Ship adapter', done: false, rank: 2 })
    ]);

    expect(result).toMatchObject({ status: 'accepted', diagnostics: [] });
    expect(messages).toEqual(['automerge:updateByKey,insert']);
    expect(latestChangeMessage(adapter.getDoc())).toBe('automerge:updateByKey,insert');
  });

  it('accepts explicit map-v1 storage codec and rejects unsupported codecs during setup', async () => {
    const source = automergeMapSource(workspaceDoc({
      tasks: { 'task-a': { title: 'Readable task', done: false, rank: 1 } }
    }), { relations: taskRelations });

    const adapter = automergeMapAdapter<WorkspaceDocument>({
      doc: workspaceDoc(),
      relations: taskRelations,
      storage: { codec: 'map-v1' }
    });

    expect(await source.rows(schema.tasks)).toEqual([
      { id: 'task-a', title: 'Readable task', done: false, rank: 1 }
    ]);
    expect(adapter.snapshot().version).toEqual(Automerge.getHeads(adapter.getDoc()));
    expect(() => automergeMapAdapter<WorkspaceDocument>({
      doc: workspaceDoc(),
      relations: taskRelations,
      storage: {
        // @ts-expect-error unsupported codec values should still be rejected at runtime.
        codec: 'json-lines'
      }
    })).toThrow(/codec|unsupported|map-v1/i);
  });

  it('setDoc publishes external replacements through source rows, version, snapshot, and subscribers', async () => {
    const adapter = automergeMapAdapter<WorkspaceDocument>({
      doc: workspaceDoc({ tasks: { 'task-a': { title: 'Before sync', done: false, rank: 1 } } }),
      relations: taskRelations
    });
    let notifications = 0;
    const unsubscribe = adapter.subscribe(() => {
      notifications += 1;
    });
    const replacement = workspaceDoc({
      tasks: { 'task-b': { title: 'After sync', done: true, rank: 2 } }
    });

    try {
      adapter.setDoc(replacement);

      expect(notifications).toBe(1);
      expect(adapter.getDoc()).toBe(replacement);
      expect(await adapter.source.rows(schema.tasks)).toEqual([
        { id: 'task-b', title: 'After sync', done: true, rank: 2 }
      ]);
      expect(await adapter.source.version?.()).toEqual(Automerge.getHeads(replacement));
      expect(adapter.snapshot().version).toEqual(Automerge.getHeads(replacement));
    } finally {
      unsubscribe();
    }
  });

  it('keeps multiple relation map paths isolated for reads and writes in one document', async () => {
    const adapter = automergeMapAdapter<WorkspaceDocument>({
      doc: workspaceDoc({
        tasks: { 'task-a': { title: 'Task row', done: false, rank: 1 } },
        projects: { 'project-a': { name: 'Project row', priority: 2 } },
        archivedTasks: { 'task-archived': { title: 'Archived row', done: true, rank: 9 } }
      }),
      relations: workspaceRelations
    });

    const result = await tryApplyRelationPatches(adapter, [
      tasks.insert({ id: 'task-b', title: 'New task', done: false, rank: 3 }),
      projects.updateByKey('project-a', { priority: 5 })
    ], { readVersion: true });

    expect(result).toMatchObject({ status: 'accepted', diagnostics: [] });
    expect(await adapter.source.rows(schema.tasks)).toEqual([
      { id: 'task-a', title: 'Task row', done: false, rank: 1 },
      { id: 'task-b', title: 'New task', done: false, rank: 3 }
    ]);
    expect(await adapter.source.rows(schema.projects)).toEqual([
      { id: 'project-a', name: 'Project row', priority: 5 }
    ]);
    expect(adapter.getDoc().workspace.tasks['task-b']).toEqual({ title: 'New task', done: false, rank: 3 });
    expect(adapter.getDoc().workspace.projects['project-a']).toEqual({ name: 'Project row', priority: 5 });
    expect(adapter.getDoc().archive.tasks).toEqual({
      'task-archived': { title: 'Archived row', done: true, rank: 9 }
    });
  });

  it('treats separate mappings for the same relation as separate map paths', async () => {
    const workspaceSource = automergeMapSource(workspaceDoc({
      tasks: { 'task-live': { title: 'Live row', done: false, rank: 1 } },
      archivedTasks: { 'task-archived': { title: 'Archived row', done: true, rank: 9 } }
    }), { relations: taskRelations });
    const archiveSource = automergeMapSource(workspaceDoc({
      tasks: { 'task-live': { title: 'Live row', done: false, rank: 1 } },
      archivedTasks: { 'task-archived': { title: 'Archived row', done: true, rank: 9 } }
    }), { relations: archivedTaskRelations });

    expect(await workspaceSource.rows(schema.tasks)).toEqual([
      { id: 'task-live', title: 'Live row', done: false, rank: 1 }
    ]);
    expect(await archiveSource.rows(schema.tasks)).toEqual([
      { id: 'task-archived', title: 'Archived row', done: true, rank: 9 }
    ]);
  });

  it('preserves external heads through setDoc and advances them after subsequent writes', async () => {
    const replacement = Automerge.change(workspaceDoc(), 'external task import', (doc) => {
      doc.workspace.tasks['task-a'] = { title: 'Imported row', done: false, rank: 1 };
    });
    const replacementHeads = Automerge.getHeads(replacement);
    const adapter = automergeMapAdapter<WorkspaceDocument>({
      doc: workspaceDoc(),
      relations: taskRelations
    });

    adapter.setDoc(replacement);

    expect(await adapter.source.version?.()).toEqual(replacementHeads);
    expect(adapter.snapshot().version).toEqual(replacementHeads);

    const result = await tryCommitAdapter(adapter, [
      tasks.updateByKey('task-a', { done: true })
    ], { readVersion: true });

    expect(result).toMatchObject({ status: 'accepted', diagnostics: [] });
    expect(result.version).toEqual(Automerge.getHeads(adapter.getDoc()));
    expect(result.version).not.toEqual(replacementHeads);
    expect(latestChangeMessage(adapter.getDoc())).not.toBe('external task import');
    expect(await adapter.source.rows(schema.tasks)).toEqual([
      { id: 'task-a', title: 'Imported row', done: true, rank: 1 }
    ]);
  });
});
