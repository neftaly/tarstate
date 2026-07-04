import * as Automerge from '@automerge/automerge';
import { afterAll, bench, describe } from 'vitest';
import { createMemoryRelationRuntime } from '@tarstate/core/memory-runtime';
import { runtimeSystemRelations } from '@tarstate/core/adapter';
import { createRuntimeStore, type Store, type StoreView } from '@tarstate/core/store';
import { as, asc, eq, from, pipe, sort, value, where, type Query } from '@tarstate/core/query';
import { defineSchema, idField, numberField, optional, refField, relation, stringField } from '@tarstate/core/schema';
import { insertOrReplace, updateByKey, type WritePatch } from '@tarstate/core/write';
import { createAutomergeMapRuntime, defineAutomergeMapRelations, type AutomergeMapRuntime } from '@tarstate/automerge';

type TaskRow = {
  readonly id: string;
  readonly title: string;
  readonly effort: number;
  readonly projectId?: string;
};

type WorkspaceDoc = {
  readonly workspace: {
    readonly tasks: readonly TaskRow[];
  };
};

type StoreScenarioMetrics = {
  readonly label: string;
  commits: number;
  runtimeNotifications: number;
  storeNotifications: number;
  listenerCalls: number;
  snapshotReads: number;
  rowsRead: number;
  interestRows: number;
  netHeapBytes: number;
  positiveHeapBytes: number;
  maxPositiveHeapBytes: number;
  cleanup: () => void;
};

type ChurnMetrics = {
  readonly label: string;
  samples: number;
  subscriptions: number;
  releasedInterestRows: number;
  netHeapBytes: number;
  positiveHeapBytes: number;
  maxPositiveHeapBytes: number;
  cleanup: () => void;
};

const ROW_COUNT = 100;
const PROJECT_COUNT = 8;
const VIEW_COUNT = 8;
const CHURN_VIEW_COUNT = 4;
const PATCH_COUNT = 128;
const BENCH_OPTIONS = {
  time: 30,
  iterations: 1,
  warmupTime: 1,
  warmupIterations: 1
};

const schema = defineSchema({
  tasks: relation<TaskRow>({
    key: 'id',
    fields: {
      id: idField('task'),
      title: stringField(),
      effort: numberField(),
      projectId: optional(refField('projects.id'))
    }
  })
});
const task = as(schema.tasks, 'task');
const projectIds = Array.from({ length: PROJECT_COUNT }, (_, index) => `project-${index}`);
const projectQueries = projectIds.slice(0, VIEW_COUNT).map(projectQueryFor) satisfies readonly Query<TaskRow>[];
const defineWorkspaceRelations = defineAutomergeMapRelations<WorkspaceDoc>();
const taskMapping = defineWorkspaceRelations([
  { relation: schema.tasks, path: ['workspace', 'tasks'] }
]);
const storeMetrics: StoreScenarioMetrics[] = [];
const churnMetrics: ChurnMetrics[] = [];

let rowSink = 0;

describe('Automerge runtime store', () => {
  bench('Automerge runtime store commit + subscribed views', automergeStoreCommitFanout(), BENCH_OPTIONS);
  bench('memory runtime store commit + subscribed views', memoryStoreCommitFanout(), BENCH_OPTIONS);
  bench('Automerge external runtime apply + subscribed views', automergeExternalApplyFanout(), BENCH_OPTIONS);
  bench('Automerge view interest churn', automergeInterestChurn(), BENCH_OPTIONS);
});

afterAll(() => {
  if (storeMetrics.length > 0) {
    console.table(storeMetrics.map((metrics) => ({
      scenario: metrics.label,
      commits: metrics.commits,
      runtimeNotifications: metrics.runtimeNotifications,
      storeNotifications: metrics.storeNotifications,
      listenerCalls: metrics.listenerCalls,
      snapshotReads: metrics.snapshotReads,
      snapshotReadsPerCommit: ratio(metrics.snapshotReads, metrics.commits),
      rowsReadPerCommit: ratio(metrics.rowsRead, metrics.commits),
      activeInterestRows: metrics.interestRows,
      heapNetPerCommit: bytesPerUnit(metrics.netHeapBytes, metrics.commits),
      heapPositivePerCommit: bytesPerUnit(metrics.positiveHeapBytes, metrics.commits),
      maxHeapPositiveSample: bytes(metrics.maxPositiveHeapBytes)
    })));
  }

  if (churnMetrics.length > 0) {
    console.table(churnMetrics.map((metrics) => ({
      scenario: metrics.label,
      samples: metrics.samples,
      subscriptions: metrics.subscriptions,
      subscriptionsPerSample: ratio(metrics.subscriptions, metrics.samples),
      releasedInterestRows: metrics.releasedInterestRows,
      heapNetPerSample: bytesPerUnit(metrics.netHeapBytes, metrics.samples),
      heapPositivePerSample: bytesPerUnit(metrics.positiveHeapBytes, metrics.samples),
      maxHeapPositiveSample: bytes(metrics.maxPositiveHeapBytes)
    })));
  }

  for (const metrics of storeMetrics) metrics.cleanup();
  for (const metrics of churnMetrics) metrics.cleanup();
});

function automergeStoreCommitFanout(): () => Promise<void> {
  const runtime = createAutomergeRuntime();
  return commitFanoutScenario(
    'Automerge runtime store commit + subscribed views',
    createRuntimeStore({ runtime }),
    (index) => [taskPatchAt(index)],
    () => runtime
  );
}

function memoryStoreCommitFanout(): () => Promise<void> {
  return commitFanoutScenario(
    'memory runtime store commit + subscribed views',
    createRuntimeStore({
      runtime: createMemoryRelationRuntime(
        { tasks: makeTasks() },
        { relationNames: [schema.tasks.name] }
      ),
      relations: [schema.tasks]
    }),
    (index) => [taskPatchAt(index)]
  );
}

function automergeExternalApplyFanout(): () => Promise<void> {
  const runtime = createAutomergeRuntime();
  const store = createRuntimeStore({ runtime });
  const target = runtime.target;
  if (target === undefined) throw new Error('Automerge runtime target is missing');

  return commitFanoutScenario(
    'Automerge external runtime apply + subscribed views',
    store,
    (index) => [externalTaskPatchAt(index)],
    () => runtime,
    async (patches) => {
      await Promise.resolve(target.apply(patches));
    }
  );
}

function commitFanoutScenario(
  label: string,
  store: Store,
  patchAt: (index: number) => readonly WritePatch[],
  runtime?: () => AutomergeMapRuntime<WorkspaceDoc>,
  applyPatches?: (patches: readonly WritePatch[]) => Promise<void>
): () => Promise<void> {
  const metrics = makeStoreMetrics(label);
  storeMetrics.push(metrics);

  const runtimeValue = runtime?.();
  const unsubscribeRuntime = runtimeValue?.subscribe?.(() => {
    metrics.runtimeNotifications += 1;
  }) ?? (() => undefined);
  const unsubscribeStore = store.subscribe(() => {
    metrics.storeNotifications += 1;
  });
  const views = projectQueries.map((query) => store.view(query));
  const unsubscribers = views.map((view) => view.subscribe(() => {
    metrics.listenerCalls += 1;
    readView(view, metrics);
  }));
  let cursor = 0;

  metrics.interestRows = interestRowCount(store);
  metrics.runtimeNotifications = 0;
  metrics.storeNotifications = 0;
  metrics.cleanup = () => {
    for (const unsubscribe of unsubscribers) unsubscribe();
    unsubscribeStore();
    unsubscribeRuntime();
    store.close();
  };

  return async () => {
    const heapBefore = process.memoryUsage().heapUsed;
    const patches = patchAt(cursor);
    if (applyPatches === undefined) {
      await store.commit(patches);
    } else {
      await applyPatches(patches);
    }
    cursor = (cursor + 1) % PATCH_COUNT;
    metrics.commits += 1;

    for (const view of views) readView(view, metrics);
    metrics.interestRows = runtime === undefined ? 0 : interestRowCount(store);
    recordStoreHeapSample(metrics, process.memoryUsage().heapUsed - heapBefore);
  };
}

function automergeInterestChurn(): () => void {
  const runtime = createAutomergeRuntime();
  const store = createRuntimeStore({ runtime });
  const metrics: ChurnMetrics = {
    label: 'Automerge view interest churn',
    samples: 0,
    subscriptions: 0,
    releasedInterestRows: 0,
    netHeapBytes: 0,
    positiveHeapBytes: 0,
    maxPositiveHeapBytes: 0,
    cleanup: () => undefined
  };
  churnMetrics.push(metrics);
  let cursor = 0;

  metrics.cleanup = () => {
    store.close();
  };

  return () => {
    const heapBefore = process.memoryUsage().heapUsed;
    const views = Array.from({ length: CHURN_VIEW_COUNT }, (_, index) => {
      const query = projectQueries[(cursor + index) % projectQueries.length];
      if (query === undefined) throw new Error('benchmark query set is empty');
      return store.view(query);
    });
    const unsubscribers = views.map((view) => view.subscribe(() => undefined));
    const activeInterestRows = interestRowCount(store);
    if (activeInterestRows === 0) throw new Error('Automerge runtime did not retain view interests');

    for (const view of views) consume(view.getSnapshot().rows);
    for (const unsubscribe of unsubscribers) unsubscribe();
    metrics.releasedInterestRows += interestRowCount(store);
    metrics.samples += 1;
    metrics.subscriptions += unsubscribers.length;
    cursor = (cursor + CHURN_VIEW_COUNT) % projectQueries.length;
    recordChurnHeapSample(metrics, process.memoryUsage().heapUsed - heapBefore);
  };
}

function createAutomergeRuntime(): AutomergeMapRuntime<WorkspaceDoc> {
  return createAutomergeMapRuntime({
    doc: workspaceDoc(),
    relations: taskMapping,
    runtimeId: 'bench-workspace'
  });
}

function makeStoreMetrics(label: string): StoreScenarioMetrics {
  return {
    label,
    commits: 0,
    runtimeNotifications: 0,
    storeNotifications: 0,
    listenerCalls: 0,
    snapshotReads: 0,
    rowsRead: 0,
    interestRows: 0,
    netHeapBytes: 0,
    positiveHeapBytes: 0,
    maxPositiveHeapBytes: 0,
    cleanup: () => undefined
  };
}

function projectQueryFor(projectId: string): Query<TaskRow> {
  return pipe(
    from(task),
    where(eq(task.projectId, value(projectId))),
    sort(asc(task.id))
  );
}

function workspaceDoc(): Automerge.Doc<WorkspaceDoc> {
  return Automerge.from({
    workspace: {
      tasks: makeTasks()
    }
  });
}

function makeTasks(): readonly TaskRow[] {
  return Array.from({ length: ROW_COUNT }, (_, index) => ({
    id: `task-${index}`,
    title: `Task ${index}`,
    effort: (index * 17) % 10_000,
    projectId: projectIds[index % projectIds.length] ?? 'project-0'
  }));
}

function taskPatchAt(index: number): WritePatch {
  const rowIndex = (index * 37) % ROW_COUNT;
  return updateByKey(schema.tasks, `task-${rowIndex}`, {
    title: `Task ${rowIndex}.${index}`,
    effort: (index * 101) % 10_000
  });
}

function externalTaskPatchAt(index: number): WritePatch {
  const rowIndex = (index * 53) % ROW_COUNT;
  return insertOrReplace(schema.tasks, {
    id: `task-${rowIndex}`,
    title: `External ${rowIndex}.${index}`,
    effort: (index * 211) % 10_000,
    projectId: projectIds[rowIndex % projectIds.length] ?? 'project-0'
  });
}

function readView(view: StoreView<unknown>, metrics: StoreScenarioMetrics): void {
  const snapshot = view.getSnapshot();
  metrics.snapshotReads += 1;
  metrics.rowsRead += snapshot.rows.length;
  consume(snapshot.rows);
}

function interestRowCount(store: Store): number {
  return store.query(runtimeSystemRelations.interests).rows.length;
}

function consume(rows: readonly unknown[]): void {
  rowSink = (rowSink + rows.length) % Number.MAX_SAFE_INTEGER;
  if (rowSink < 0) throw new Error('unreachable benchmark sink');
}

function recordStoreHeapSample(metrics: StoreScenarioMetrics, heapDelta: number): void {
  const positiveHeapDelta = Math.max(0, heapDelta);
  metrics.netHeapBytes += heapDelta;
  metrics.positiveHeapBytes += positiveHeapDelta;
  metrics.maxPositiveHeapBytes = Math.max(metrics.maxPositiveHeapBytes, positiveHeapDelta);
}

function recordChurnHeapSample(metrics: ChurnMetrics, heapDelta: number): void {
  const positiveHeapDelta = Math.max(0, heapDelta);
  metrics.netHeapBytes += heapDelta;
  metrics.positiveHeapBytes += positiveHeapDelta;
  metrics.maxPositiveHeapBytes = Math.max(metrics.maxPositiveHeapBytes, positiveHeapDelta);
}

function ratio(valueValue: number, count: number): string {
  return (valueValue / Math.max(1, count)).toFixed(1);
}

function bytesPerUnit(byteCount: number, count: number): string {
  return bytes(byteCount / Math.max(1, count));
}

function bytes(byteCount: number): string {
  const abs = Math.abs(byteCount);
  if (abs < 1_024) return `${byteCount.toFixed(0)} B`;
  if (abs < 1_048_576) return `${(byteCount / 1_024).toFixed(1)} KiB`;
  return `${(byteCount / 1_048_576).toFixed(2)} MiB`;
}
