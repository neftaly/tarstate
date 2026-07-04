import * as Automerge from '@automerge/automerge';
import { describe, expect, it } from 'vitest';
import { evaluate } from '@tarstate/core/evaluate';
import { createMemoryRelationRuntime } from '@tarstate/core/memory-runtime';
import {
  aggregate,
  clauses,
  count,
  eq,
  field,
  from,
  join,
  pipe,
  project,
  sum,
  value,
  where,
  type Query
} from '@tarstate/core/query';
import {
  booleanField,
  defineSchema,
  idField,
  jsonField,
  nullable,
  numberField,
  optional,
  refField,
  relation,
  stringField,
  type JsonValue
} from '@tarstate/core/schema';
import type { RelationSource } from '@tarstate/core/source';
import { write, type WritePatch } from '@tarstate/core/write';
import { automergeMapAdapter, defineAutomergeMapRelations } from '@tarstate/automerge';
import { canonicalRows, choose, chooseFromSet, mulberry32, randomInt } from './fuzz-helpers.js';

type ProjectRow = {
  readonly id: string;
  readonly name: string;
  readonly budget?: number | null;
  readonly active: boolean;
  readonly meta?: JsonValue;
};

type TaskRow = {
  readonly id: string;
  readonly projectId: string;
  readonly title: string;
  readonly estimate: number;
  readonly done: boolean;
  readonly meta?: JsonValue;
};

type CommentRow = {
  readonly id: string;
  readonly taskId: string;
  readonly body: string;
  readonly flagged: boolean;
  readonly meta?: JsonValue;
};

type WorkspaceDoc = {
  readonly workspace: {
    readonly projectsById: Readonly<Record<string, ProjectRow>>;
    readonly tasks: readonly TaskRow[];
    readonly comments: readonly CommentRow[];
  };
};

type FuzzState = {
  readonly projectIds: Set<string>;
  readonly taskIds: Set<string>;
  readonly commentIds: Set<string>;
  nextProject: number;
  nextTask: number;
  nextComment: number;
};

type QueryCase = {
  readonly label: string;
  readonly query: Query<unknown>;
};

const schema = defineSchema({
  projects: relation<ProjectRow>({
    key: 'id',
    fields: {
      id: idField('project'),
      name: stringField(),
      budget: optional(nullable(numberField())),
      active: booleanField(),
      meta: optional(nullable(jsonField()))
    }
  }),
  tasks: relation<TaskRow>({
    key: 'id',
    fields: {
      id: idField('task'),
      projectId: refField('projects.id'),
      title: stringField(),
      estimate: numberField(),
      done: booleanField(),
      meta: optional(nullable(jsonField()))
    }
  }),
  comments: relation<CommentRow>({
    key: 'id',
    fields: {
      id: idField('comment'),
      taskId: refField('tasks.id'),
      body: stringField(),
      flagged: booleanField(),
      meta: optional(nullable(jsonField()))
    }
  })
});

const defineWorkspaceRelations = defineAutomergeMapRelations<WorkspaceDoc>();
const relations = defineWorkspaceRelations([
  { relation: schema.projects, path: ['workspace', 'projectsById'] },
  { relation: schema.tasks, path: ['workspace', 'tasks'] },
  { relation: schema.comments, path: ['workspace', 'comments'] }
]);

const seeds = [0xd1ff_0001, 0xd1ff_0002, 0xd1ff_0003] as const;
const relationNames = [schema.projects.name, schema.tasks.name, schema.comments.name] as const;

const taskId = field<string>('tasks', 'id');
const taskProjectId = field<string>('tasks', 'projectId');
const taskTitle = field<string>('tasks', 'title');
const taskEstimate = field<number>('tasks', 'estimate');
const taskDone = field<boolean>('tasks', 'done');
const projectId = field<string>('projects', 'id');
const projectName = field<string>('projects', 'name');
const projectActive = field<boolean>('projects', 'active');
const commentId = field<string>('comments', 'id');
const commentTaskId = field<string>('comments', 'taskId');
const commentFlagged = field<boolean>('comments', 'flagged');

const queries: readonly QueryCase[] = [
  { label: 'project scan', query: from(schema.projects) as Query<unknown> },
  { label: 'task scan', query: from(schema.tasks) as Query<unknown> },
  { label: 'comment scan', query: from(schema.comments) as Query<unknown> },
  {
    label: 'active project where',
    query: pipe(
      from(schema.projects),
      where(eq(projectActive, value(true))),
      project({ id: projectId, name: projectName, active: projectActive })
    ) as Query<unknown>
  },
  {
    label: 'task project join',
    query: pipe(
      from(schema.tasks),
      join(from(schema.projects), clauses<TaskRow, ProjectRow>({ projectId: 'id' })),
      project({
        taskId,
        projectId: taskProjectId,
        projectName,
        title: taskTitle,
        estimate: taskEstimate,
        done: taskDone
      })
    ) as Query<unknown>
  },
  {
    label: 'comment task join',
    query: pipe(
      from(schema.comments),
      join(from(schema.tasks), clauses<CommentRow, TaskRow>({ taskId: 'id' })),
      project({
        commentId,
        taskId: commentTaskId,
        taskTitle,
        flagged: commentFlagged
      })
    ) as Query<unknown>
  },
  {
    label: 'task aggregate',
    query: pipe(
      from(schema.tasks),
      aggregate({
        groupBy: { projectId: taskProjectId },
        aggregates: {
          taskCount: count(),
          doneCount: count(eq(taskDone, value(true))),
          totalEstimate: sum(taskEstimate)
        }
      })
    ) as Query<unknown>
  }
];

describe('automerge differential runtime fuzz', () => {
  it.each(seeds)('matches core memory runtime query results %#', async (seed) => {
    const initial = initialRows();
    const automerge = automergeMapAdapter({
      doc: initialDoc(initial),
      relations,
      runtimeId: `differential-${seed}`
    });
    const memory = createMemoryRelationRuntime({
      [schema.projects.name]: initial.projects,
      [schema.tasks.name]: initial.tasks,
      [schema.comments.name]: initial.comments
    }, { relationNames });
    const memoryTarget = memory.target;
    const next = mulberry32(seed);
    const state = initialState(initial);

    if (memoryTarget === undefined) throw new Error('expected writable memory runtime');

    assertQueryParity(automerge.source, memory.source, `seed ${seed} initial`);

    for (let step = 0; step < 48; step += 1) {
      const patch = fuzzPatch(state, seed, step, next);
      const automergeResult = await automerge.target.apply([patch]);
      const memoryResult = await memoryTarget.apply([patch]);

      expect(automergeResult.status, `seed ${seed} step ${step} automerge status`).toBe('accepted');
      expect(memoryResult.status, `seed ${seed} step ${step} memory status`).toBe('accepted');
      expect(automergeResult.diagnostics, `seed ${seed} step ${step} automerge diagnostics`).toEqual([]);
      expect(memoryResult.diagnostics, `seed ${seed} step ${step} memory diagnostics`).toEqual([]);

      assertQueryParity(automerge.source, memory.source, `seed ${seed} step ${step}`);
    }

    assertQueryParity(automerge.source, memory.source, `seed ${seed} final`);
  });
});

function assertQueryParity(
  automergeSource: RelationSource,
  memorySource: RelationSource,
  label: string
): void {
  for (const queryCase of queries) {
    const automergeResult = evaluate(automergeSource, queryCase.query);
    const memoryResult = evaluate(memorySource, queryCase.query);

    expect(automergeResult.diagnostics, `${label} ${queryCase.label} automerge diagnostics`).toEqual([]);
    expect(memoryResult.diagnostics, `${label} ${queryCase.label} memory diagnostics`).toEqual([]);
    expect(canonicalRows(automergeResult.rows), `${label} ${queryCase.label}`).toEqual(
      canonicalRows(memoryResult.rows)
    );
  }
}

function fuzzPatch(state: FuzzState, seed: number, step: number, next: () => number): WritePatch {
  switch (choose(next, ['projects', 'tasks', 'comments'] as const)) {
    case 'projects':
      return fuzzProjectPatch(state, seed, step, next);
    case 'tasks':
      return fuzzTaskPatch(state, seed, step, next);
    default:
      return fuzzCommentPatch(state, seed, step, next);
  }
}

function fuzzProjectPatch(state: FuzzState, seed: number, step: number, next: () => number): WritePatch {
  const operation = state.projectIds.size === 0 ? 'insert' : choose(next, ['insert', 'update', 'delete'] as const);

  if (operation === 'insert') {
    const id = next() < 0.3 && state.projectIds.size > 0
      ? chooseFromSet(next, state.projectIds)
      : `project-${seed}-${state.nextProject++}`;
    state.projectIds.add(id);
    return write(schema.projects).insertOrReplace(projectRow(id, step, next));
  }

  const id = next() < 0.85 ? chooseFromSet(next, state.projectIds) : `project-missing-${step}`;
  if (operation === 'delete') {
    state.projectIds.delete(id);
    return write(schema.projects).deleteByKey(id);
  }

  return write(schema.projects).updateByKey(id, projectUpdate(step, next));
}

function fuzzTaskPatch(state: FuzzState, seed: number, step: number, next: () => number): WritePatch {
  const operation = state.taskIds.size === 0 ? 'insert' : choose(next, ['insert', 'update', 'delete'] as const);

  if (operation === 'insert') {
    const id = next() < 0.25 && state.taskIds.size > 0
      ? chooseFromSet(next, state.taskIds)
      : `task-${seed}-${state.nextTask++}`;
    state.taskIds.add(id);
    return write(schema.tasks).insertOrReplace(taskRow(id, state, step, next));
  }

  const id = next() < 0.9 ? chooseFromSet(next, state.taskIds) : `task-missing-${step}`;
  if (operation === 'delete') {
    state.taskIds.delete(id);
    return write(schema.tasks).deleteByKey(id);
  }

  return write(schema.tasks).updateByKey(id, taskUpdate(state, step, next));
}

function fuzzCommentPatch(state: FuzzState, seed: number, step: number, next: () => number): WritePatch {
  const operation = state.commentIds.size === 0 ? 'insert' : choose(next, ['insert', 'update', 'delete'] as const);

  if (operation === 'insert') {
    const id = next() < 0.25 && state.commentIds.size > 0
      ? chooseFromSet(next, state.commentIds)
      : `comment-${seed}-${state.nextComment++}`;
    state.commentIds.add(id);
    return write(schema.comments).insertOrReplace(commentRow(id, state, step, next));
  }

  const id = next() < 0.9 ? chooseFromSet(next, state.commentIds) : `comment-missing-${step}`;
  if (operation === 'delete') {
    state.commentIds.delete(id);
    return write(schema.comments).deleteByKey(id);
  }

  return write(schema.comments).updateByKey(id, commentUpdate(state, step, next));
}

function projectRow(id: string, step: number, next: () => number): ProjectRow {
  const budget = choose(next, [undefined, null, 0, 10, 99.5, -5] as const);
  const meta = next() < 0.75 ? randomJson(next, 3) : undefined;
  return {
    id,
    name: choose(next, ['', 'alpha', 'beta project', `project ${step}`, 'quote " slash \\'] as const),
    active: next() >= 0.4,
    ...(budget === undefined ? {} : { budget }),
    ...(meta === undefined ? {} : { meta })
  };
}

function taskRow(id: string, state: FuzzState, step: number, next: () => number): TaskRow {
  const meta = next() < 0.8 ? randomJson(next, 3) : undefined;
  return {
    id,
    projectId: projectIdFor(state, step, next),
    title: choose(next, ['', 'draft', 'in progress', `task ${step}`, 'line\nbreak'] as const),
    estimate: choose(next, [-3, 0, 1, 2.5, 8, 13] as const),
    done: next() >= 0.55,
    ...(meta === undefined ? {} : { meta })
  };
}

function commentRow(id: string, state: FuzzState, step: number, next: () => number): CommentRow {
  const meta = next() < 0.7 ? randomJson(next, 2) : undefined;
  return {
    id,
    taskId: taskIdFor(state, step, next),
    body: choose(next, ['', 'ok', 'needs review', `comment ${step}`, 'tabs\tand\nlines'] as const),
    flagged: next() >= 0.65,
    ...(meta === undefined ? {} : { meta })
  };
}

function projectUpdate(step: number, next: () => number): Partial<ProjectRow> {
  switch (randomInt(next, 4)) {
    case 0:
      return { name: choose(next, ['renamed', '', `project update ${step}`] as const) };
    case 1:
      return { active: next() >= 0.5 };
    case 2:
      return { budget: choose(next, [null, -1, 0, 42, 120.25] as const) };
    default:
      return { meta: randomJson(next, 3) };
  }
}

function taskUpdate(state: FuzzState, step: number, next: () => number): Partial<TaskRow> {
  switch (randomInt(next, 5)) {
    case 0:
      return { title: choose(next, ['updated', '', `task update ${step}`] as const) };
    case 1:
      return { projectId: projectIdFor(state, step, next) };
    case 2:
      return { estimate: choose(next, [-8, 0, 1, 3.5, 21] as const) };
    case 3:
      return { done: next() >= 0.5 };
    default:
      return { meta: randomJson(next, 3) };
  }
}

function commentUpdate(state: FuzzState, step: number, next: () => number): Partial<CommentRow> {
  switch (randomInt(next, 4)) {
    case 0:
      return { body: choose(next, ['updated', '', `comment update ${step}`, 'quote "'] as const) };
    case 1:
      return { taskId: taskIdFor(state, step, next) };
    case 2:
      return { flagged: next() >= 0.5 };
    default:
      return { meta: randomJson(next, 2) };
  }
}

function projectIdFor(state: FuzzState, step: number, next: () => number): string {
  return state.projectIds.size > 0 && next() < 0.85
    ? chooseFromSet(next, state.projectIds)
    : `project-orphan-${step % 5}`;
}

function taskIdFor(state: FuzzState, step: number, next: () => number): string {
  return state.taskIds.size > 0 && next() < 0.85
    ? chooseFromSet(next, state.taskIds)
    : `task-orphan-${step % 7}`;
}

function initialRows(): {
  readonly projects: readonly ProjectRow[];
  readonly tasks: readonly TaskRow[];
  readonly comments: readonly CommentRow[];
} {
  return {
    projects: [
      { id: 'project-a', name: 'Alpha', budget: 10, active: true, meta: { tags: ['seed', 'alpha'] } },
      { id: 'project-b', name: '', budget: null, active: false, meta: { nested: { empty: [] } } }
    ],
    tasks: [
      { id: 'task-a', projectId: 'project-a', title: 'Draft', estimate: 1, done: false, meta: { priority: 1 } },
      { id: 'task-b', projectId: 'project-a', title: '', estimate: 0, done: true, meta: [null, true, ''] },
      { id: 'task-c', projectId: 'project-b', title: 'Review', estimate: -2, done: false }
    ],
    comments: [
      { id: 'comment-a', taskId: 'task-a', body: 'first', flagged: false, meta: { votes: [1, 2] } },
      { id: 'comment-b', taskId: 'task-b', body: '', flagged: true },
      { id: 'comment-c', taskId: 'task-missing', body: 'orphan', flagged: false, meta: null }
    ]
  };
}

function initialDoc(initial: ReturnType<typeof initialRows>): Automerge.Doc<WorkspaceDoc> {
  return Automerge.from({
    workspace: {
      projectsById: Object.fromEntries(initial.projects.map((row) => [row.id, row])),
      tasks: initial.tasks,
      comments: initial.comments
    }
  });
}

function initialState(initial: ReturnType<typeof initialRows>): FuzzState {
  return {
    projectIds: new Set(initial.projects.map((row) => row.id)),
    taskIds: new Set(initial.tasks.map((row) => row.id)),
    commentIds: new Set(initial.comments.map((row) => row.id)),
    nextProject: 0,
    nextTask: 0,
    nextComment: 0
  };
}

function randomJson(next: () => number, depth: number): JsonValue {
  if (depth <= 0) return choose(next, [null, true, false, '', 'json', -1, 0, 7.5] as const);

  switch (randomInt(next, 6)) {
    case 0:
      return choose(next, [null, true, false, '', 'json', -1, 0, 7.5] as const);
    case 1:
      return [randomJson(next, depth - 1), randomJson(next, depth - 1)];
    case 2:
      return { note: randomJson(next, depth - 1), count: randomInt(next, 5) };
    case 3:
      return { awkward: { emptyArray: [], emptyObject: {}, text: 'quote "' } };
    case 4:
      return [];
    default:
      return {};
  }
}
