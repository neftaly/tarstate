import * as Automerge from '@automerge/automerge';
import { describe, expect, it } from 'vitest';
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
import { write, type WritePatch } from '@tarstate/core/write';
import {
  automergeMapAdapter,
  automergeMapSource,
  defineAutomergeMapRelations
} from '@tarstate/automerge';
import { canonicalRows, choose, mulberry32, randomInt, shuffle } from './fuzz-helpers.js';

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

type ConvergenceCase = {
  readonly seed: number;
  readonly peerCount: 2 | 3 | 4;
};

type ConvergedRun = {
  readonly docs: readonly Automerge.Doc<WorkspaceDoc>[];
  readonly heads: readonly string[];
  readonly state: MaterializedState;
};

type MaterializedState = {
  readonly projects: readonly unknown[];
  readonly tasks: readonly unknown[];
  readonly comments: readonly unknown[];
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

const seeds = [0xc0de_1001, 0xc0de_1002, 0xc0de_1003] as const;
const peerCounts = [2, 3, 4] as const;
const convergenceCases = seeds.flatMap((seed) => peerCounts.map((peerCount): ConvergenceCase => ({
  seed,
  peerCount
})));

const projectIds = ['project-a', 'project-b', 'project-c', 'project-d'] as const;
const taskIds = ['task-a', 'task-b', 'task-c', 'task-d', 'task-e', 'task-f'] as const;
const commentIds = ['comment-a', 'comment-b', 'comment-c', 'comment-d', 'comment-e'] as const;

describe('automerge convergence fuzz', () => {
  it.each(convergenceCases)('converges peers and merge orders %#', async ({ seed, peerCount }) => {
    const base = initialDoc();
    const localDocs = await Promise.all(Array.from({ length: peerCount }, (_, peer) =>
      editedPeerDoc(base, seed, peer, peerCount)
    ));

    const first = converge(localDocs, seed, peerCount, 0);
    const second = converge(localDocs, seed, peerCount, 1);

    assertConverged(first, `seed ${seed} peers ${peerCount} order 0`);
    assertConverged(second, `seed ${seed} peers ${peerCount} order 1`);
    expect(second.heads, `seed ${seed} peers ${peerCount} final heads`).toEqual(first.heads);
    expect(second.state, `seed ${seed} peers ${peerCount} final state`).toEqual(first.state);
  });
});

async function editedPeerDoc(
  base: Automerge.Doc<WorkspaceDoc>,
  seed: number,
  peer: number,
  peerCount: number
): Promise<Automerge.Doc<WorkspaceDoc>> {
  const adapter = automergeMapAdapter({
    doc: Automerge.clone(base),
    relations,
    runtimeId: `convergence-${seed}-${peerCount}-${peer}`
  });
  const next = mulberry32(seed ^ Math.imul(peer + 1, 0x9e37_79b1));

  for (let step = 0; step < 12; step += 1) {
    const patch = fuzzPatch(seed, peer, step, next);
    const result = await adapter.target.apply([patch]);

    expect(result.status, `seed ${seed} peer ${peer} step ${step} status`).toBe('accepted');
    expect(result.diagnostics, `seed ${seed} peer ${peer} step ${step} diagnostics`).toEqual([]);
  }

  return adapter.getDoc();
}

function converge(
  docs: readonly Automerge.Doc<WorkspaceDoc>[],
  seed: number,
  peerCount: number,
  orderVariant: number
): ConvergedRun {
  const peers = [...docs];

  for (let round = 0; round < 8; round += 1) {
    if (headsConverged(peers)) break;

    for (const [left, right] of pairOrder(peerCount, seed, orderVariant, round)) {
      const leftDoc = peers[left] as Automerge.Doc<WorkspaceDoc>;
      const rightDoc = peers[right] as Automerge.Doc<WorkspaceDoc>;
      const mergedLeft = Automerge.merge(Automerge.clone(leftDoc), Automerge.clone(rightDoc));
      const mergedRight = Automerge.merge(Automerge.clone(rightDoc), Automerge.clone(leftDoc));
      peers[left] = mergedLeft;
      peers[right] = mergedRight;
    }
  }

  return {
    docs: peers,
    heads: sortedHeads(peers[0] as Automerge.Doc<WorkspaceDoc>),
    state: materializedState(peers[0] as Automerge.Doc<WorkspaceDoc>, `order ${orderVariant} peer 0`)
  };
}

function assertConverged(run: ConvergedRun, label: string): void {
  const expectedHeads = run.heads;
  const expectedState = run.state;

  for (const [peer, doc] of run.docs.entries()) {
    expect(sortedHeads(doc), `${label} peer ${peer} heads`).toEqual(expectedHeads);
    expect(materializedState(doc, `${label} peer ${peer}`), `${label} peer ${peer} state`).toEqual(expectedState);
  }
}

function pairOrder(
  peerCount: number,
  seed: number,
  orderVariant: number,
  round: number
): readonly (readonly [number, number])[] {
  const next = mulberry32(seed ^ Math.imul(orderVariant + 1, 0xa5a5_1001) ^ Math.imul(round + 1, 0x1f12_3bb5));
  const pairs: [number, number][] = [];

  for (let left = 0; left < peerCount; left += 1) {
    for (let right = left + 1; right < peerCount; right += 1) {
      pairs.push(next() < 0.5 ? [left, right] : [right, left]);
    }
  }

  return shuffle(next, pairs);
}

function fuzzPatch(seed: number, peer: number, step: number, next: () => number): WritePatch {
  switch (choose(next, ['projects', 'tasks', 'comments'] as const)) {
    case 'projects':
      return fuzzProjectPatch(seed, peer, step, next);
    case 'tasks':
      return fuzzTaskPatch(seed, peer, step, next);
    default:
      return fuzzCommentPatch(seed, peer, step, next);
  }
}

function fuzzProjectPatch(seed: number, peer: number, step: number, next: () => number): WritePatch {
  const id = choose(next, projectIds);

  switch (choose(next, ['insert', 'insert', 'update', 'delete'] as const)) {
    case 'insert':
      return write(schema.projects).insertOrReplace(projectRow(id, seed, peer, step, next));
    case 'update':
      return write(schema.projects).updateByKey(id, projectUpdate(seed, peer, step, next));
    default:
      return write(schema.projects).deleteByKey(id);
  }
}

function fuzzTaskPatch(seed: number, peer: number, step: number, next: () => number): WritePatch {
  const id = choose(next, taskIds);

  switch (choose(next, ['insert', 'insert', 'update', 'delete'] as const)) {
    case 'insert':
      return write(schema.tasks).insertOrReplace(taskRow(id, seed, peer, step, next));
    case 'update':
      return write(schema.tasks).updateByKey(id, taskUpdate(seed, peer, step, next));
    default:
      return write(schema.tasks).deleteByKey(id);
  }
}

function fuzzCommentPatch(seed: number, peer: number, step: number, next: () => number): WritePatch {
  const id = choose(next, commentIds);

  switch (choose(next, ['insert', 'insert', 'update', 'delete'] as const)) {
    case 'insert':
      return write(schema.comments).insertOrReplace(commentRow(id, seed, peer, step, next));
    case 'update':
      return write(schema.comments).updateByKey(id, commentUpdate(seed, peer, step, next));
    default:
      return write(schema.comments).deleteByKey(id);
  }
}

function projectRow(id: string, seed: number, peer: number, step: number, next: () => number): ProjectRow {
  const budget = choose(next, [undefined, null, -5, 0, 10, 42.5] as const);
  const meta = next() < 0.75 ? randomJson(seed, peer, step, next, 3) : undefined;
  return {
    id,
    name: choose(next, ['', 'alpha', 'beta', `project ${peer}-${step}`, 'quote " slash \\'] as const),
    active: next() >= 0.35,
    ...(budget === undefined ? {} : { budget }),
    ...(meta === undefined ? {} : { meta })
  };
}

function taskRow(id: string, seed: number, peer: number, step: number, next: () => number): TaskRow {
  const meta = next() < 0.75 ? randomJson(seed, peer, step, next, 3) : undefined;
  return {
    id,
    projectId: choose(next, projectIds),
    title: choose(next, ['', 'draft', 'ready', `task ${peer}-${step}`, 'line\nbreak'] as const),
    estimate: choose(next, [-8, -1, 0, 2, 5.5, 13] as const),
    done: next() >= 0.55,
    ...(meta === undefined ? {} : { meta })
  };
}

function commentRow(id: string, seed: number, peer: number, step: number, next: () => number): CommentRow {
  const meta = next() < 0.7 ? randomJson(seed, peer, step, next, 2) : undefined;
  return {
    id,
    taskId: choose(next, taskIds),
    body: choose(next, ['', 'ok', 'needs review', `comment ${peer}-${step}`, 'tabs\tand\nlines'] as const),
    flagged: next() >= 0.65,
    ...(meta === undefined ? {} : { meta })
  };
}

function projectUpdate(seed: number, peer: number, step: number, next: () => number): Partial<ProjectRow> {
  switch (randomInt(next, 4)) {
    case 0:
      return { name: choose(next, ['', 'renamed', `project update ${peer}-${step}`] as const) };
    case 1:
      return { active: next() >= 0.5 };
    case 2:
      return { budget: choose(next, [null, -1, 0, 64, 128.5] as const) };
    default:
      return { meta: randomJson(seed, peer, step, next, 3) };
  }
}

function taskUpdate(seed: number, peer: number, step: number, next: () => number): Partial<TaskRow> {
  switch (randomInt(next, 5)) {
    case 0:
      return { title: choose(next, ['', 'updated', `task update ${peer}-${step}`] as const) };
    case 1:
      return { projectId: choose(next, projectIds) };
    case 2:
      return { estimate: choose(next, [-13, 0, 1, 3.5, 21] as const) };
    case 3:
      return { done: next() >= 0.5 };
    default:
      return { meta: randomJson(seed, peer, step, next, 3) };
  }
}

function commentUpdate(seed: number, peer: number, step: number, next: () => number): Partial<CommentRow> {
  switch (randomInt(next, 4)) {
    case 0:
      return { body: choose(next, ['', 'updated', `comment update ${peer}-${step}`, 'quote "'] as const) };
    case 1:
      return { taskId: choose(next, taskIds) };
    case 2:
      return { flagged: next() >= 0.5 };
    default:
      return { meta: randomJson(seed, peer, step, next, 2) };
  }
}

function initialDoc(): Automerge.Doc<WorkspaceDoc> {
  const projects: readonly ProjectRow[] = [
    { id: 'project-a', name: 'Alpha', budget: 10, active: true, meta: { tags: ['base', 'alpha'] } },
    { id: 'project-b', name: 'Beta', budget: null, active: false, meta: { nested: { empty: [] } } }
  ];

  return Automerge.from({
    workspace: {
      projectsById: Object.fromEntries(projects.map((row) => [row.id, row])),
      tasks: [
        { id: 'task-a', projectId: 'project-a', title: 'Draft', estimate: 1, done: false, meta: { priority: 1 } },
        { id: 'task-b', projectId: 'project-b', title: '', estimate: 0, done: true, meta: [null, true, ''] }
      ],
      comments: [
        { id: 'comment-a', taskId: 'task-a', body: 'first', flagged: false, meta: { votes: [1, 2] } },
        { id: 'comment-b', taskId: 'task-b', body: '', flagged: true }
      ]
    }
  });
}

function materializedState(doc: Automerge.Doc<WorkspaceDoc>, label: string): MaterializedState {
  const source = automergeMapSource(doc, { relations });

  expect(source.diagnostics?.() ?? [], `${label} source diagnostics`).toEqual([]);

  return {
    projects: canonicalRows(source.rows(schema.projects)),
    tasks: canonicalRows(source.rows(schema.tasks)),
    comments: canonicalRows(source.rows(schema.comments))
  };
}

function headsConverged(docs: readonly Automerge.Doc<WorkspaceDoc>[]): boolean {
  const first = stableHeadKey(docs[0] as Automerge.Doc<WorkspaceDoc>);
  return docs.every((doc) => stableHeadKey(doc) === first);
}

function sortedHeads(doc: Automerge.Doc<WorkspaceDoc>): readonly string[] {
  return [...Automerge.getHeads(doc)].sort();
}

function stableHeadKey(doc: Automerge.Doc<WorkspaceDoc>): string {
  return sortedHeads(doc).join('\0');
}

function randomJson(seed: number, peer: number, step: number, next: () => number, depth: number): JsonValue {
  if (depth <= 0) return choose(next, [null, true, false, '', 'json', -1, 0, seed % 17, peer, step] as const);

  switch (randomInt(next, 6)) {
    case 0:
      return choose(next, [null, true, false, '', 'json', -1, 0, seed % 17, peer, step] as const);
    case 1:
      return [randomJson(seed, peer, step, next, depth - 1), randomJson(seed, peer, step, next, depth - 1)];
    case 2:
      return { note: randomJson(seed, peer, step, next, depth - 1), count: randomInt(next, 5) };
    case 3:
      return { awkward: { emptyArray: [], emptyObject: {}, text: 'quote "' } };
    case 4:
      return [];
    default:
      return {};
  }
}
