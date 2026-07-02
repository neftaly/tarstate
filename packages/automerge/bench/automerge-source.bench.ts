import * as Automerge from '@automerge/automerge';
import { bench, describe } from 'vitest';
import { evaluate } from '@tarstate/core/evaluate';
import { eq, field, from, gte, pipe, value, where, type Query } from '@tarstate/core/query';
import {
  defineSchema,
  idField,
  numberField,
  optional,
  relation,
  stringField
} from '@tarstate/core/schema';
import { automergeMapSource, defineAutomergeMapRelations } from '@tarstate/automerge';

type TaskRow = {
  readonly id: string;
  readonly title: string;
  readonly effort?: number;
  readonly projectId?: string;
};

type WorkspaceDoc = {
  readonly workspace: {
    readonly tasks: readonly TaskRow[];
  };
};

const ROW_COUNT = 5_000;
const PROJECT_COUNT = 100;
const QUERY_VARIANT_COUNT = 10;
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
      effort: optional(numberField()),
      projectId: optional(stringField())
    }
  })
});
const defineWorkspaceRelations = defineAutomergeMapRelations<WorkspaceDoc>();
const taskMapping = defineWorkspaceRelations([
  { relation: schema.tasks, path: ['workspace', 'tasks'] }
]);
const projectIds = Array.from({ length: PROJECT_COUNT }, (_, index) => `project-${index}`);
const rows = makeTasks(ROW_COUNT);
const doc: Automerge.Doc<WorkspaceDoc> = Automerge.from({
  workspace: {
    tasks: rows
  }
});
const source = automergeMapSource(doc, { relations: taskMapping });
const lookupQueries = projectIds.slice(0, QUERY_VARIANT_COUNT).map((projectId) =>
  pipe(
    from(schema.tasks),
    where(eq(field<string>('tasks', 'projectId'), value(projectId)))
  )
) satisfies readonly Query<unknown>[];
const rangeQueries = Array.from({ length: QUERY_VARIANT_COUNT }, (_, index) => 2_500 + index * 100).map((effort) =>
  pipe(
    from(schema.tasks),
    where(gte(field<number>('tasks', 'effort'), value(effort)))
  )
) satisfies readonly Query<unknown>[];

let rowSink = 0;
let queryCursor = 0;

describe('Automerge map source', () => {
  bench('rows', () => {
    consume(source.rows(schema.tasks));
  }, BENCH_OPTIONS);

  bench('lookup', () => {
    const projectId = projectIds[queryCursor % QUERY_VARIANT_COUNT] ?? 'project-0';
    queryCursor += 1;
    consume(source.lookup?.({ relation: schema.tasks, field: 'projectId', value: projectId }) ?? []);
  }, BENCH_OPTIONS);

  bench('rangeLookup', () => {
    const lower = 2_500 + (queryCursor % QUERY_VARIANT_COUNT) * 100;
    queryCursor += 1;
    consume(source.rangeLookup?.({
      relation: schema.tasks,
      field: 'effort',
      lower: { value: lower, inclusive: true }
    }) ?? []);
  }, BENCH_OPTIONS);

  bench('query lookup pushdown', evaluateQueries(lookupQueries), BENCH_OPTIONS);
  bench('query rangeLookup pushdown', evaluateQueries(rangeQueries), BENCH_OPTIONS);
});

function evaluateQueries(queries: readonly Query<unknown>[]): () => void {
  return () => {
    const query = queries[queryCursor % queries.length];
    if (query === undefined) throw new Error('benchmark query set is empty');
    queryCursor += 1;

    const result = evaluate(source, query);
    if (result.diagnostics.length > 0) {
      throw new Error(result.diagnostics.map((diagnostic) => diagnostic.message).join('; '));
    }
    consume(result.rows);
  };
}

function makeTasks(count: number): readonly TaskRow[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `task-${index}`,
    title: `Task ${index}`,
    effort: index,
    projectId: projectIds[index % projectIds.length] ?? 'project-0'
  }));
}

function consume(resultRows: readonly unknown[]): void {
  rowSink = (rowSink + resultRows.length) % Number.MAX_SAFE_INTEGER;
  if (rowSink < 0) throw new Error('unreachable benchmark sink');
}
