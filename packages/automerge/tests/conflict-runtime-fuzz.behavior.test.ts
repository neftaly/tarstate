import * as Automerge from '@automerge/automerge';
import { describe, expect, it } from 'vitest';
import { runtimeSystemRelations } from '@tarstate/core/adapter';
import {
  defineSchema,
  idField,
  numberField,
  optional,
  relation,
  stringField
} from '@tarstate/core/schema';
import { write } from '@tarstate/core/write';
import {
  automergeChangeAt,
  automergeConflictDiagnostics,
  automergeConflictsAt,
  automergeMapAdapter,
  automergeObjectIdAt,
  automergeView,
  defineAutomergeMapRelations
} from '@tarstate/automerge';

type TaskRow = {
  readonly id: string;
  readonly title: string;
  readonly count?: number;
};

type LabelRow = {
  readonly id: string;
  readonly name: string;
};

type WorkspaceDoc = {
  readonly workspace: {
    readonly tasks: readonly TaskRow[];
    readonly labelsById: Readonly<Record<string, LabelRow>>;
  };
};

const schema = defineSchema({
  tasks: relation<TaskRow>({
    key: 'id',
    fields: {
      id: idField('task'),
      title: stringField(),
      count: optional(numberField())
    }
  }),
  labels: relation<LabelRow>({
    key: 'id',
    fields: {
      id: idField('label'),
      name: stringField()
    }
  })
});

const defineWorkspaceRelations = defineAutomergeMapRelations<WorkspaceDoc>();
const relations = defineWorkspaceRelations([
  { relation: schema.tasks, path: ['workspace', 'tasks'] },
  { relation: schema.labels, path: ['workspace', 'labelsById'] }
]);

const seeds = [0xa100_0001, 0xa100_0002, 0xa100_0003] as const;

describe('automerge conflict/head/runtime edge fuzz', () => {
  it.each(seeds)('keeps map and array-backed scalar conflicts inspectable %#', (seed) => {
    const merged = scalarConflictDoc(seed);
    const adapter = automergeMapAdapter({ doc: merged, relations, runtimeId: `conflict-${seed}` });

    expect(() => adapter.source.rows(schema.tasks)).not.toThrow();
    expect(() => adapter.source.rows(schema.labels)).not.toThrow();
    expect(() => adapter.source.diagnostics?.()).not.toThrow();
    expect(() => adapter.source.rows(runtimeSystemRelations.diagnostics)).not.toThrow();

    expect(adapter.source.rows(schema.tasks)).toHaveLength(2);
    expect(adapter.source.rows(schema.labels)).toHaveLength(2);
    expect(adapter.source.diagnostics?.()).toEqual([]);
    expect(adapter.source.rows(runtimeSystemRelations.diagnostics)).toEqual([]);

    assertConflictStable(merged, ['workspace', 'tasks', 0, 'title'], [
      `left-title-${seed}`,
      `right-title-${seed}`
    ]);
    assertConflictStable(merged, ['workspace', 'labelsById', 'label-1', 'name'], [
      `left-label-${seed}`,
      `right-label-${seed}`
    ]);
  });

  it('keeps delete-vs-update and missing conflict paths diagnostic-only', () => {
    const merged = deleteVsUpdateDoc();
    const adapter = automergeMapAdapter({ doc: merged, relations, runtimeId: 'delete-vs-update' });

    expect(() => adapter.source.rows(schema.tasks)).not.toThrow();
    expect(() => adapter.source.diagnostics?.()).not.toThrow();
    expect(adapter.source.rows(schema.tasks)).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'task-1' })
    ]));
    expect(adapter.source.rows(runtimeSystemRelations.diagnostics)).toEqual([]);

    expect(() => automergeConflictsAt(workspaceDoc(), ['workspace', 'tasks', 0, 'missingTitle'])).not.toThrow();
    expect(() => automergeConflictDiagnostics(workspaceDoc(), [
      ['workspace', 'tasks', 0, 'missingTitle']
    ], { relation: 'tasks', field: 'title', surface: 'test' })).not.toThrow();
    expect(automergeConflictsAt(workspaceDoc(), ['workspace', 'tasks', 0, 'missingTitle'])).toEqual([]);
    expect(automergeConflictDiagnostics(workspaceDoc(), [
      ['workspace', 'tasks', 0, 'missingTitle']
    ])).toEqual([]);
  });

  it('surfaces invalid mapped topology through source diagnostics and rejects writes atomically', async () => {
    const adapter = automergeMapAdapter({ doc: workspaceDoc(), relations, runtimeId: 'bad-topology' });
    const badDoc = incompatibleTopologyDoc();
    adapter.setDoc(badDoc);
    const beforeDoc = adapter.getDoc();
    const beforeHeads = Automerge.getHeads(beforeDoc);

    expect(() => adapter.source.rows(schema.tasks)).not.toThrow();
    expect(() => adapter.source.rows(schema.labels)).not.toThrow();
    expect(adapter.source.rows(schema.tasks)).toEqual([]);
    expect(adapter.source.rows(schema.labels)).toEqual([]);
    expect(adapter.source.diagnostics?.()).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'runtime_unsupported', relation: 'tasks' }),
      expect.objectContaining({ code: 'runtime_unsupported', relation: 'labels' })
    ]));
    expect(adapter.source.rows(runtimeSystemRelations.diagnostics)).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'runtime_unsupported', relation: 'tasks' }),
      expect.objectContaining({ code: 'runtime_unsupported', relation: 'labels' })
    ]));

    const result = await adapter.target.apply([
      write(schema.labels).insertOrReplace({ id: 'label-new', name: 'Should not commit' }),
      write(schema.tasks).insertOrReplace({ id: 'task-new', title: 'Should reject' })
    ]);

    expect(result.status).toBe('rejected');
    expect(result.applied).toBe(0);
    expect(result.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'runtime_unsupported', relation: 'labels' }),
      expect.objectContaining({ code: 'runtime_unsupported', relation: 'tasks' })
    ]));
    expect(adapter.getDoc()).toBe(beforeDoc);
    expect(Automerge.getHeads(adapter.getDoc())).toEqual(beforeHeads);
    expect(adapter.source.rows(schema.labels)).toEqual([]);
    expect(adapter.source.rows(schema.tasks)).toEqual([]);
  });

  it('handles stale object ids, deleted paths, invalid heads, and later writes without partial mutation', async () => {
    const adapter = automergeMapAdapter({ doc: workspaceDoc(), relations, runtimeId: 'stale-objects' });
    const taskObjectId = adapter.objectIdFor(schema.tasks, 'task-1');
    const labelObjectId = adapter.objectIdFor(schema.labels, 'label-1');
    expect(taskObjectId).toBe(automergeObjectIdAt(adapter.getDoc(), ['workspace', 'tasks', 0]));
    expect(labelObjectId).toBe(automergeObjectIdAt(adapter.getDoc(), ['workspace', 'labelsById', 'label-1']));

    adapter.setDoc(Automerge.change(adapter.getDoc(), (draft) => {
      (draft.workspace.tasks as TaskRow[]).splice(0, 1);
      delete (draft.workspace.labelsById as Record<string, LabelRow>)['label-1'];
    }));

    expect(taskObjectId === null ? null : adapter.pathForObjectId(taskObjectId)).toBeNull();
    expect(labelObjectId === null ? null : adapter.pathForObjectId(labelObjectId)).toBeNull();
    expect(adapter.objectReferenceFor(schema.tasks, 'task-1')).toBeNull();
    expect(adapter.objectReferenceFor(schema.labels, 'label-1')).toBeNull();
    expect(automergeObjectIdAt(adapter.getDoc(), ['workspace', 'tasks', 0])).not.toBe(taskObjectId);
    expect(automergeObjectIdAt(adapter.getDoc(), ['workspace', 'labelsById', 'label-1'])).toBeNull();
    expect(automergeConflictsAt(adapter.getDoc(), ['workspace', 'tasks', 0, 'title'])).toEqual([]);

    const invalidHeads = ['not-a-valid-head'];
    expect(() => automergeView(adapter.getDoc(), invalidHeads)).toThrow();
    expect(() => automergeChangeAt(adapter.getDoc(), invalidHeads, (draft) => {
      (draft.workspace.tasks as TaskRow[]).push({ id: 'bad-head-write', title: 'Nope' });
    })).toThrow();

    const beforeDoc = adapter.getDoc();
    const result = await adapter.target.apply([
      write(schema.tasks).insertOrReplace({ id: 'task-2', title: 'Committed after stale state' }),
      write(schema.tasks).updateByKey('task-2', { title: null as never })
    ]);

    expect(result.status).toBe('rejected');
    expect(result.applied).toBe(0);
    expect(result.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'field_invalid', relation: 'tasks', field: 'title' })
    ]));
    expect(adapter.getDoc()).toBe(beforeDoc);
    expect(adapter.source.rows(schema.tasks)).toEqual([
      { id: 'task-2', title: 'Todo', count: 2 }
    ]);
  });

  it('rejects missing path writes after external deletion without recreating topology', async () => {
    const adapter = automergeMapAdapter({ doc: workspaceDoc(), relations });
    adapter.setDoc(Automerge.change(adapter.getDoc(), (draft) => {
      delete (draft.workspace as unknown as Record<string, unknown>).tasks;
    }));
    const beforeDoc = adapter.getDoc();
    const beforeHeads = Automerge.getHeads(beforeDoc);

    expect(adapter.source.rows(schema.tasks)).toEqual([]);
    expect(adapter.source.diagnostics?.()).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'runtime_unsupported', relation: 'tasks' })
    ]));

    const result = await adapter.target.apply([
      write(schema.tasks).insertOrReplace({ id: 'task-restored', title: 'Do not recreate' })
    ]);

    expect(result.status).toBe('rejected');
    expect(result.applied).toBe(0);
    expect(result.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'runtime_unsupported', relation: 'tasks' })
    ]));
    expect(adapter.getDoc()).toBe(beforeDoc);
    expect(Automerge.getHeads(adapter.getDoc())).toEqual(beforeHeads);
    expect('tasks' in adapter.getDoc().workspace).toBe(false);
  });
});

function workspaceDoc(): Automerge.Doc<WorkspaceDoc> {
  return Automerge.from({
    workspace: {
      tasks: [
        { id: 'task-1', title: 'Draft', count: 1 },
        { id: 'task-2', title: 'Todo', count: 2 }
      ],
      labelsById: {
        'label-1': { id: 'label-1', name: 'Urgent' },
        'label-2': { id: 'label-2', name: 'Later' }
      }
    }
  });
}

function scalarConflictDoc(seed: number): Automerge.Doc<WorkspaceDoc> {
  const base = workspaceDoc();
  let left = Automerge.clone(base);
  let right = Automerge.clone(base);

  left = Automerge.change(left, (draft) => {
    const firstTask = draft.workspace.tasks[0] as { title: string };
    firstTask.title = `left-title-${seed}`;
    (draft.workspace.labelsById['label-1'] as { name: string }).name = `left-label-${seed}`;
  });
  right = Automerge.change(right, (draft) => {
    const firstTask = draft.workspace.tasks[0] as { title: string };
    firstTask.title = `right-title-${seed}`;
    (draft.workspace.labelsById['label-1'] as { name: string }).name = `right-label-${seed}`;
  });

  return Automerge.merge(left, right);
}

function deleteVsUpdateDoc(): Automerge.Doc<WorkspaceDoc> {
  const base = workspaceDoc();
  let deleted = Automerge.clone(base);
  let updated = Automerge.clone(base);

  deleted = Automerge.change(deleted, (draft) => {
    delete (draft.workspace.tasks[0] as { title?: string }).title;
  });
  updated = Automerge.change(updated, (draft) => {
    const firstTask = draft.workspace.tasks[0] as { title: string };
    firstTask.title = 'updated-after-fork';
  });

  return Automerge.merge(deleted, updated);
}

function incompatibleTopologyDoc(): Automerge.Doc<WorkspaceDoc> {
  return Automerge.from({
    workspace: {
      tasks: 'not-an-array',
      labelsById: 42
    }
  }) as unknown as Automerge.Doc<WorkspaceDoc>;
}

function assertConflictStable(
  doc: Automerge.Doc<WorkspaceDoc>,
  path: readonly [Automerge.Prop, ...Automerge.Prop[]],
  expectedValues: readonly string[]
): void {
  const first = automergeConflictsAt(doc, path);
  const second = automergeConflictsAt(doc, path);
  const diagnostics = automergeConflictDiagnostics(doc, [path], {
    relation: String(path[0]),
    field: String(path[path.length - 1])
  });

  expect(first).toEqual(second);
  expect(first.map((conflict) => conflict.value).sort(compareStrings)).toEqual([...expectedValues].sort(compareStrings));
  expect(first.every((conflict) => typeof conflict.opId === 'string' && conflict.opId.length > 0)).toBe(true);
  expect(diagnostics).toEqual([
    expect.objectContaining({
      code: 'automerge_conflict',
      severity: 'warning',
      detail: expect.objectContaining({ path, conflicts: first })
    })
  ]);
}

function compareStrings(left: unknown, right: unknown): number {
  return String(left).localeCompare(String(right));
}
