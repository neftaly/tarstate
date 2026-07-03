import * as Automerge from '@automerge/automerge';
import { bench, describe } from 'vitest';
import type { RelationApplyResult, RelationPatchTarget } from '@tarstate/core/adapter';
import { createMemoryRelationRuntime } from '@tarstate/core/memory-runtime';
import { and, eq, field, isMissing, isNull, notNull, value } from '@tarstate/core/query';
import {
  booleanField,
  defineSchema,
  idField,
  nullable,
  numberField,
  optional,
  refField,
  relation,
  stringField
} from '@tarstate/core/schema';
import { write, type WritePatch } from '@tarstate/core/write';
import { automergeMapAdapter, defineAutomergeMapRelations } from '@tarstate/automerge';

type TaskRow = {
  readonly id: string;
  readonly title: string;
  readonly memo?: string | null;
  readonly effort?: number | null;
  readonly done?: boolean;
  readonly projectId?: string;
};

type LabelRow = {
  readonly id: string;
  readonly name: string;
};

interface WorkspaceDoc {
  readonly workspace: {
    readonly tasks: readonly TaskRow[];
    readonly labelsById: Readonly<Record<string, LabelRow>>;
  };
}

const ROW_COUNT = 1_000;
const PREDICATE_BUCKET_COUNT = 384;
const SCRATCH_COUNT = 64;
const PATCH_BATCH_COUNT = 128;
const BENCH_OPTIONS = {
  time: 150,
  iterations: 8,
  warmupTime: 20,
  warmupIterations: 2
};

const schema = defineSchema({
  tasks: relation<TaskRow>({
    key: 'id',
    fields: {
      id: idField('task'),
      title: stringField(),
      memo: optional(nullable(stringField())),
      effort: optional(nullable(numberField())),
      done: optional(booleanField()),
      projectId: optional(refField('projects.id'))
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
const taskMapping = defineWorkspaceRelations([
  { relation: schema.tasks, path: ['workspace', 'tasks'] }
]);
const labelMapping = defineWorkspaceRelations([
  { relation: schema.labels, path: ['workspace', 'labelsById'] }
]);
const taskMemo = field<string | null | undefined>('tasks', 'memo');
const taskProjectId = field<string | undefined>('tasks', 'projectId');
const arrayMixedBatches = makeArrayMixedBatches();
const predicateBatches = makePredicateBatches();
const labelBatches = makeLabelBatches();

let resultSink = 0;

describe('Automerge map adapter writes', () => {
  describe('array-backed mapped relation mixed commits', () => {
    bench('Automerge adapter apply', automergeArrayMixedWrites(), BENCH_OPTIONS);
    bench('core memory runtime apply', memoryArrayMixedWrites(), BENCH_OPTIONS);
  });

  describe('predicate update/delete over nullable and missing fields', () => {
    bench('Automerge adapter apply', automergePredicateWrites(), BENCH_OPTIONS);
    bench('core memory runtime apply', memoryPredicateWrites(), BENCH_OPTIONS);
  });

  describe('map-backed mapped relation key writes', () => {
    bench('Automerge adapter apply', automergeMapKeyWrites(), BENCH_OPTIONS);
    bench('core memory runtime apply', memoryMapKeyWrites(), BENCH_OPTIONS);
  });
});

function automergeArrayMixedWrites(): () => void {
  const adapter = automergeMapAdapter({
    doc: workspaceDoc(makeArrayTasks(), {}),
    relations: taskMapping
  });

  return applyBatches(adapter.target, arrayMixedBatches);
}

function memoryArrayMixedWrites(): () => void {
  const runtime = createMemoryRelationRuntime(
    { tasks: makeArrayTasks() },
    { relationNames: [schema.tasks.name] }
  );

  return applyBatches(requiredTarget(runtime.target), arrayMixedBatches);
}

function automergePredicateWrites(): () => void {
  const adapter = automergeMapAdapter({
    doc: workspaceDoc(makePredicateTasks(), {}),
    relations: taskMapping
  });

  return applyBatches(adapter.target, predicateBatches);
}

function memoryPredicateWrites(): () => void {
  const runtime = createMemoryRelationRuntime(
    { tasks: makePredicateTasks() },
    { relationNames: [schema.tasks.name] }
  );

  return applyBatches(requiredTarget(runtime.target), predicateBatches);
}

function automergeMapKeyWrites(): () => void {
  const adapter = automergeMapAdapter({
    doc: workspaceDoc([], labelsById(makeLabels())),
    relations: labelMapping
  });

  return applyBatches(adapter.target, labelBatches);
}

function memoryMapKeyWrites(): () => void {
  const runtime = createMemoryRelationRuntime(
    { labels: makeLabels() },
    { relationNames: [schema.labels.name] }
  );

  return applyBatches(requiredTarget(runtime.target), labelBatches);
}

function applyBatches(
  target: RelationPatchTarget,
  batches: readonly (readonly WritePatch[])[]
): () => void {
  let cursor = 0;

  return () => {
    const batch = batches[cursor % batches.length];
    if (batch === undefined) throw new Error('benchmark patch set is empty');
    cursor += 1;

    const result = target.apply(batch);
    if (isPromiseLike(result)) throw new Error('benchmark target unexpectedly returned a Promise');
    consumeResult(result);
  };
}

function requiredTarget(target: RelationPatchTarget | undefined): RelationPatchTarget {
  if (target === undefined) throw new Error('benchmark runtime target is missing');
  return target;
}

function makeArrayMixedBatches(): readonly (readonly WritePatch[])[] {
  return Array.from({ length: PATCH_BATCH_COUNT }, (_, index) => {
    const rowIndex = (index * 37) % ROW_COUNT;
    const scratchId = `scratch-${index % SCRATCH_COUNT}`;

    return [
      write(schema.tasks).updateByKey(`task-${rowIndex}`, {
        effort: (index * 17) % 10_000,
        done: index % 2 === 0
      }),
      write(schema.tasks).deleteByKey(scratchId),
      write(schema.tasks).insert({
        id: scratchId,
        title: `Scratch ${index}`,
        effort: index,
        projectId: `project-${index % 16}`
      })
    ];
  });
}

function makePredicateBatches(): readonly (readonly WritePatch[])[] {
  return Array.from({ length: PATCH_BATCH_COUNT }, (_, index) => {
    const bucket = `predicate-${index % PREDICATE_BUCKET_COUNT}`;

    return [
      write(schema.tasks).update(and(notNull(taskMemo), eq(taskProjectId, value(bucket))), {
        title: `Present ${index}`
      }),
      write(schema.tasks).update(and(isNull(taskMemo), eq(taskProjectId, value(bucket))), {
        title: `Null ${index}`
      }),
      write(schema.tasks).delete(and(isMissing(taskMemo), eq(taskProjectId, value(bucket)))),
      write(schema.tasks).insert({
        id: `missing-${bucket}`,
        title: `Missing ${index}`,
        projectId: bucket
      })
    ];
  });
}

function makeLabelBatches(): readonly (readonly WritePatch[])[] {
  return Array.from({ length: PATCH_BATCH_COUNT }, (_, index) => {
    const rowIndex = (index * 41) % ROW_COUNT;
    const scratchId = `scratch-label-${index % SCRATCH_COUNT}`;

    return [
      write(schema.labels).updateByKey(`label-${rowIndex}`, {
        name: `Label ${rowIndex}.${index}`
      }),
      write(schema.labels).deleteByKey(scratchId),
      write(schema.labels).insert({
        id: scratchId,
        name: `Scratch label ${index}`
      })
    ];
  });
}

function makeArrayTasks(): readonly TaskRow[] {
  return [
    ...Array.from({ length: ROW_COUNT }, (_, index) => ({
      id: `task-${index}`,
      title: `Task ${index}`,
      memo: index % 5 === 0 ? null : `memo-${index % 97}`,
      effort: index,
      done: index % 3 === 0,
      projectId: `project-${index % 16}`
    })),
    ...Array.from({ length: SCRATCH_COUNT }, (_, index) => ({
      id: `scratch-${index}`,
      title: `Scratch ${index}`,
      effort: index,
      projectId: `project-${index % 16}`
    }))
  ];
}

function makePredicateTasks(): readonly TaskRow[] {
  return Array.from({ length: PREDICATE_BUCKET_COUNT }, (_, index) => {
    const bucket = `predicate-${index}`;

    return [
      {
        id: `present-${bucket}`,
        title: `Present ${index}`,
        memo: `memo-${index}`,
        projectId: bucket
      },
      {
        id: `null-${bucket}`,
        title: `Null ${index}`,
        memo: null,
        projectId: bucket
      },
      {
        id: `missing-${bucket}`,
        title: `Missing ${index}`,
        projectId: bucket
      }
    ];
  }).flat();
}

function makeLabels(): readonly LabelRow[] {
  return [
    ...Array.from({ length: ROW_COUNT }, (_, index) => ({
      id: `label-${index}`,
      name: `Label ${index}`
    })),
    ...Array.from({ length: SCRATCH_COUNT }, (_, index) => ({
      id: `scratch-label-${index}`,
      name: `Scratch label ${index}`
    }))
  ];
}

function workspaceDoc(
  tasks: readonly TaskRow[],
  labelsByIdValue: Readonly<Record<string, LabelRow>>
): Automerge.Doc<WorkspaceDoc> {
  return Automerge.from({
    workspace: {
      tasks,
      labelsById: labelsByIdValue
    }
  });
}

function labelsById(rows: readonly LabelRow[]): Readonly<Record<string, LabelRow>> {
  return Object.fromEntries(rows.map((row) => [row.id, row]));
}

function isPromiseLike(input: unknown): input is PromiseLike<unknown> {
  return typeof input === 'object'
    && input !== null
    && 'then' in input
    && typeof (input as { readonly then?: unknown }).then === 'function';
}

function consumeResult(result: RelationApplyResult): void {
  resultSink = (
    resultSink
    + result.patches
    + result.applied
    + result.deltas.length
    + result.diagnostics.length
    + (result.version === undefined ? 0 : 1)
  ) % Number.MAX_SAFE_INTEGER;
  if (result.status !== 'accepted') {
    throw new Error(result.diagnostics.map((diagnostic) => diagnostic.message).join('; '));
  }
  if (resultSink < 0) throw new Error('unreachable benchmark sink');
}
