import { describe, expect, it } from 'vitest';
import { constrain, hasAttachedConstraints, req, unique } from '@tarstate/core/constraints';
import { createDb, q, tryTransact } from '@tarstate/core/db';
import {
  demat,
  explainMaterialization,
  isMaterialized,
  maintainMaterializationSnapshots,
  mat,
  type MaterializationMaintenanceResult,
  materializationForQuery,
  materializationsFor,
  materializedRowsFor,
  materializedRowsForQuery,
  materializedSourceFor,
  materializeSnapshot,
  refreshMaterializationSnapshot,
  snapshotHashIndex,
  snapshotIndex
} from '@tarstate/core/materialization';
import { evaluate } from '@tarstate/core/evaluate';
import {
  aggregate,
  and,
  as,
  call,
  count,
  eq,
  env,
  extend,
  field,
  from,
  gt,
  gte,
  hash,
  lt,
  lte,
  max,
  min,
  neq,
  not,
  or,
  pipe,
  project,
  queryKey,
  qualify,
  rename,
  sum,
  tuple,
  value,
  where,
  without
} from '@tarstate/core/query';
import type { Query } from '@tarstate/core/query';
import { defineSchema, idField, numberField, relation, stringField } from '@tarstate/core/schema';
import { fromObjectSource, type RelationSource } from '@tarstate/core/source';
import { write, type WritePatch } from '@tarstate/core/write';

type Todo = {
  readonly id: string;
  readonly text: string;
};

type TodoRow = {
  readonly id: string;
  readonly text: string;
};

type Task = {
  readonly id: string;
  readonly status: string;
  readonly priority: string;
  readonly text: string;
  readonly note: string;
};

type WorkItem = {
  readonly id: string;
  readonly status: string;
  readonly bucket: string;
  readonly units: number;
  readonly bonus: number;
};

const schema = defineSchema({
  todos: relation<Todo>({
    key: 'id',
    fields: {
      id: idField('todo'),
      text: stringField()
    }
  }),
  logs: relation<{
    id: string;
    text: string;
  }>({
    key: 'id',
    fields: {
      id: idField('log'),
      text: stringField()
    }
  }),
  tasks: relation<Task>({
    key: 'id',
    fields: {
      id: idField('task'),
      status: stringField(),
      priority: stringField(),
      text: stringField(),
      note: stringField()
    }
  }),
  workItems: relation<WorkItem>({
    key: 'id',
    fields: {
      id: idField('workItem'),
      status: stringField(),
      bucket: stringField(),
      units: numberField(),
      bonus: numberField()
    }
  })
});

const todo = as(schema.todos, 'todo');
const task = as(schema.tasks, 'task');
const workItem = as(schema.workItems, 'workItem');
const rootLabel = field<string>('', 'label');
const rootStatusLabel = field<string>('', 'statusLabel');
const rootSummary = field<readonly unknown[]>('', 'summary');
const todos = write(schema.todos);
const logs = write(schema.logs);
const tasks = write(schema.tasks);
const workItems = write(schema.workItems);
const todoRows = pipe(
  from(todo),
  project({
    id: todo.id,
    text: todo.text
  })
);
const todoALabelRows = pipe(
  from(todo),
  hash(todo.id),
  where(eq(todo.id, 'todo-a')),
  project({
    id: todo.id,
    text: todo.text
  }),
  without('id'),
  rename({ text: 'label' }),
  qualify('view')
);
const openTaskLabels = pipe(
  from(task),
  where(eq(task.status, 'open')),
  project({
    label: task.text
  })
);
const openHighTaskLabels = pipe(
  from(task),
  where(and(eq(task.status, 'open'), eq(task.priority, 'high'))),
  project({
    label: task.text
  })
);
const comparableTaskLabels = pipe(
  from(task),
  where(and(
    neq(task.status, 'closed'),
    gt(task.id, 'task-b'),
    gte(task.id, 'task-c'),
    lt(task.id, 'task-d'),
    lte(task.id, 'task-c')
  )),
  project({
    label: task.text
  })
);
const composedTaskLabels = pipe(
  from(task),
  where(or(eq(task.status, 'closed'), not(eq(task.priority, 'low')))),
  project({
    label: task.text
  })
);
const envTaskLabels = pipe(
  from(task),
  where(and(eq(task.status, env('status')), neq(task.priority, env('excludedPriority')))),
  project({
    label: task.text
  })
);
const openHighTaskLabelsWhereChain = pipe(
  from(task),
  where(eq(task.status, 'open')),
  where(eq(task.priority, 'high')),
  project({
    label: task.text
  })
);
const openTaskExtendedLabels = pipe(
  from(task),
  where(eq(task.status, 'open')),
  extend({
    label: task.text,
    statusLabel: value('visible'),
    summary: tuple(task.id, task.text)
  }),
  project({
    id: task.id,
    label: rootLabel,
    statusLabel: rootStatusLabel,
    summary: rootSummary
  })
);
const baseTaskRows: readonly Task[] = [
  { id: 'task-a', status: 'open', priority: 'high', text: 'Alpha', note: 'first' },
  { id: 'task-b', status: 'closed', priority: 'high', text: 'Beta', note: 'second' },
  { id: 'task-c', status: 'open', priority: 'low', text: 'Gamma', note: 'third' }
];
const baseWorkItemRows: readonly WorkItem[] = [
  { id: 'work-a', status: 'open', bucket: 'alpha', units: 2, bonus: 1 },
  { id: 'work-b', status: 'closed', bucket: 'beta', units: 7, bonus: 2 },
  { id: 'work-c', status: 'open', bucket: 'alpha', units: 5, bonus: 3 }
];

async function expectIncrementalMaintenanceMatchesFull<Row>({
  expected,
  expectedFallback = false,
  id = 'open-task-labels',
  initialRows = baseTaskRows,
  patches,
  query = openTaskLabels as Query<Row>
}: {
  readonly expected?: Partial<MaterializationMaintenanceResult>;
  readonly expectedFallback?: boolean;
  readonly id?: string;
  readonly initialRows?: readonly Task[];
  readonly patches: readonly WritePatch[];
  readonly query?: Query<Row>;
}): Promise<void> {
  const db = createDb({ tasks: initialRows });

  await materializeSnapshot(db, query, { id, mode: 'incremental' });
  expect(materializationForQuery(db, query)).toMatchObject({
    id,
    requestedMode: 'incremental',
    maintenance: 'incremental',
    diagnostics: []
  });

  const transaction = tryTransact(db, patches);
  expect(transaction.diagnostics).toEqual([]);

  const fullRows = (await q(transaction.db, query)).rows;
  const result = await maintainMaterializationSnapshots(db, transaction.db, { deltas: transaction.deltas });
  const expectedDiagnostics = expectedFallback
    ? [
      {
        code: 'materialization_incremental_fallback',
        surface: 'materialization',
        detail: {
          mode: 'incremental',
          fallback: 'recompute',
          id,
          queryKey: queryKey(query),
          reason: expect.any(String)
        }
      }
    ]
    : [];

  expect(result).toMatchObject({
    kind: 'materializationMaintenance',
    maintained: 1,
    diagnostics: expectedDiagnostics,
    sourceVersion: transaction.db.data,
    ...expected
  });
  expect(materializedRowsFor<Row>(transaction.db, id)).toEqual(fullRows);
  expect(materializationForQuery(transaction.db, query)).toMatchObject({
    id,
    requestedMode: 'incremental',
    maintenance: 'incremental',
    diagnostics: []
  });
}

type IncrementalParityCase = {
  readonly name: string;
  readonly expected: Partial<MaterializationMaintenanceResult>;
  readonly expectedFallback?: boolean;
  readonly initialRows?: readonly Task[];
  readonly patches: readonly WritePatch[];
};

const incrementalParityCases: readonly IncrementalParityCase[] = [
  {
    name: 'insert matching',
    patches: [tasks.insert({ id: 'task-d', status: 'open', priority: 'high', text: 'Delta', note: 'fourth' })],
    expected: { recomputed: 0, carried: 0 }
  },
  {
    name: 'insert non-matching',
    patches: [tasks.insert({ id: 'task-d', status: 'closed', priority: 'high', text: 'Delta', note: 'fourth' })],
    expected: { recomputed: 0, carried: 0 }
  },
  {
    name: 'delete matching',
    patches: [tasks.delete('task-a')],
    expected: { recomputed: 0, carried: 0 }
  },
  {
    name: 'delete non-matching',
    patches: [tasks.delete('task-b')],
    expected: { recomputed: 0, carried: 0 }
  },
  {
    name: 'update false-to-true',
    patches: [tasks.update('task-b', { status: 'open' })],
    expected: { recomputed: 1, carried: 0 },
    expectedFallback: true
  },
  {
    name: 'update true-to-false',
    patches: [tasks.update('task-a', { status: 'closed' })],
    expected: { recomputed: 0, carried: 0 }
  },
  {
    name: 'update true-to-true with projected field changed',
    patches: [tasks.update('task-a', { text: 'Alpha updated' })],
    expected: { recomputed: 0, carried: 0 }
  },
  {
    name: 'update true-to-true unchanged',
    patches: [tasks.update('task-a', { note: 'changed' })],
    expected: { recomputed: 0, carried: 0 }
  },
  {
    name: 'update false-to-false',
    patches: [tasks.update('task-b', { text: 'Beta updated', note: 'changed' })],
    expected: { recomputed: 0, carried: 0 }
  },
  {
    name: 'multiple rows in one batch',
    patches: [
      tasks.insert({ id: 'task-d', status: 'open', priority: 'high', text: 'Delta', note: 'fourth' }),
      tasks.insert({ id: 'task-e', status: 'closed', priority: 'high', text: 'Echo', note: 'fifth' }),
      tasks.insert({ id: 'task-f', status: 'open', priority: 'low', text: 'Foxtrot', note: 'sixth' })
    ],
    expected: { recomputed: 0, carried: 0 }
  },
  {
    name: 'multiple mixed rows in one batch',
    patches: [
      tasks.update('task-a', { text: 'Alpha updated' }),
      tasks.delete('task-c'),
      tasks.insert({ id: 'task-d', status: 'open', priority: 'high', text: 'Delta', note: 'fourth' }),
      tasks.update('task-b', { text: 'Beta updated' })
    ],
    expected: { recomputed: 1, carried: 0 },
    expectedFallback: true
  },
  {
    name: 'duplicate projected output rows with deletion',
    initialRows: [
      { id: 'task-a', status: 'open', priority: 'high', text: 'Same', note: 'first' },
      { id: 'task-b', status: 'open', priority: 'high', text: 'Same', note: 'second' },
      { id: 'task-c', status: 'open', priority: 'low', text: 'Gamma', note: 'third' }
    ],
    patches: [tasks.delete('task-a')],
    expected: { recomputed: 0, carried: 0 }
  },
  {
    name: 'duplicate projected output rows with ambiguous projected update',
    initialRows: [
      { id: 'task-a', status: 'open', priority: 'high', text: 'Same', note: 'first' },
      { id: 'task-b', status: 'open', priority: 'high', text: 'Same', note: 'second' },
      { id: 'task-c', status: 'open', priority: 'low', text: 'Gamma', note: 'third' }
    ],
    patches: [tasks.update('task-a', { text: 'Delta' })],
    expected: { recomputed: 1, carried: 0 },
    expectedFallback: true
  }
];

const incrementalExtendParityCases: readonly IncrementalParityCase[] = [
  {
    name: 'insert matching',
    patches: [tasks.insert({ id: 'task-d', status: 'open', priority: 'high', text: 'Delta', note: 'fourth' })],
    expected: { recomputed: 0, carried: 0 }
  },
  {
    name: 'delete matching',
    patches: [tasks.delete('task-a')],
    expected: { recomputed: 0, carried: 0 }
  },
  {
    name: 'update true-to-true with extended field changed',
    patches: [tasks.update('task-a', { text: 'Alpha updated' })],
    expected: { recomputed: 0, carried: 0 }
  },
  {
    name: 'update false-to-true',
    patches: [tasks.update('task-b', { status: 'open' })],
    expected: { recomputed: 1, carried: 0 },
    expectedFallback: true
  }
];

const incrementalConjunctionParityCases: readonly IncrementalParityCase[] = [
  {
    name: 'insert matching all filters',
    patches: [tasks.insert({ id: 'task-d', status: 'open', priority: 'high', text: 'Delta', note: 'fourth' })],
    expected: { recomputed: 0, carried: 0 }
  },
  {
    name: 'insert missing second filter',
    patches: [tasks.insert({ id: 'task-d', status: 'open', priority: 'low', text: 'Delta', note: 'fourth' })],
    expected: { recomputed: 0, carried: 0 }
  },
  {
    name: 'delete matching all filters',
    patches: [tasks.delete('task-a')],
    expected: { recomputed: 0, carried: 0 }
  },
  {
    name: 'update false-to-true on second filter',
    patches: [tasks.update('task-c', { priority: 'high' })],
    expected: { recomputed: 1, carried: 0 },
    expectedFallback: true
  },
  {
    name: 'update true-to-false on second filter',
    patches: [tasks.update('task-a', { priority: 'low' })],
    expected: { recomputed: 0, carried: 0 }
  },
  {
    name: 'update true-to-true with projected field changed',
    patches: [tasks.update('task-a', { text: 'Alpha updated' })],
    expected: { recomputed: 0, carried: 0 }
  }
];

const incrementalComparisonParityCases: readonly IncrementalParityCase[] = [
  {
    name: 'insert matching range',
    initialRows: [
      { id: 'task-a', status: 'open', priority: 'high', text: 'Alpha', note: 'first' },
      { id: 'task-b', status: 'closed', priority: 'high', text: 'Beta', note: 'second' }
    ],
    patches: [tasks.insert({ id: 'task-c', status: 'open', priority: 'low', text: 'Gamma', note: 'third' })],
    expected: { recomputed: 0, carried: 0 }
  },
  {
    name: 'delete matching range',
    patches: [tasks.delete('task-c')],
    expected: { recomputed: 0, carried: 0 }
  },
  {
    name: 'update true-to-false range',
    patches: [tasks.update('task-c', { status: 'closed' })],
    expected: { recomputed: 0, carried: 0 }
  },
  {
    name: 'update false-to-true range',
    initialRows: [
      { id: 'task-a', status: 'open', priority: 'high', text: 'Alpha', note: 'first' },
      { id: 'task-b', status: 'closed', priority: 'high', text: 'Beta', note: 'second' },
      { id: 'task-c', status: 'closed', priority: 'low', text: 'Gamma', note: 'third' }
    ],
    patches: [tasks.update('task-c', { status: 'open' })],
    expected: { recomputed: 1, carried: 0 },
    expectedFallback: true
  },
  {
    name: 'update true-to-true range',
    patches: [tasks.update('task-c', { text: 'Gamma updated' })],
    expected: { recomputed: 0, carried: 0 }
  }
];

const incrementalCompositionParityCases: readonly IncrementalParityCase[] = [
  {
    name: 'insert matching composed predicate',
    patches: [tasks.insert({ id: 'task-d', status: 'closed', priority: 'low', text: 'Delta', note: 'fourth' })],
    expected: { recomputed: 0, carried: 0 }
  },
  {
    name: 'insert non-matching composed predicate',
    patches: [tasks.insert({ id: 'task-d', status: 'open', priority: 'low', text: 'Delta', note: 'fourth' })],
    expected: { recomputed: 0, carried: 0 }
  },
  {
    name: 'update false-to-true composed predicate',
    patches: [tasks.update('task-c', { priority: 'high' })],
    expected: { recomputed: 1, carried: 0 },
    expectedFallback: true
  },
  {
    name: 'update true-to-false composed predicate',
    patches: [tasks.update('task-a', { priority: 'low' })],
    expected: { recomputed: 0, carried: 0 }
  }
];

describe('tarstate materialization', () => {
  it('explains snapshot and supported incremental materialization plans without evaluating rows', () => {
    expect(explainMaterialization(todoRows)).toMatchObject({
      kind: 'materializationExplanation',
      queryKey: queryKey(todoRows),
      query: todoRows,
      requestedMode: 'snapshot',
      maintenance: 'snapshot',
      dependencies: ['todos'],
      diagnostics: []
    });

    expect(explainMaterialization(openTaskLabels, { mode: 'incremental' })).toMatchObject({
      kind: 'materializationExplanation',
      queryKey: queryKey(openTaskLabels),
      query: openTaskLabels,
      requestedMode: 'incremental',
      maintenance: 'incremental',
      dependencies: ['tasks'],
      diagnostics: []
    });
  });

  it('explains incremental fallback with diagnostics instead of pretending unsupported queries are incremental', () => {
    const labels = pipe(
      from(task),
      where(eq(call('normalize', task.status), 'open')),
      project({ label: task.text })
    );

    expect(explainMaterialization(labels, { mode: 'incremental' })).toMatchObject({
      kind: 'materializationExplanation',
      queryKey: queryKey(labels),
      query: labels,
      requestedMode: 'incremental',
      maintenance: 'snapshot',
      dependencies: ['tasks'],
      diagnostics: [
        {
          code: 'materialization_unsupported',
          surface: 'materialization',
          detail: {
            mode: 'incremental',
            queryKey: queryKey(labels),
            reason: 'where is limited to base-field comparisons against literal/env values with and/or/not composition'
          }
        }
      ]
    });
  });

  it('materializes snapshot rows through mat', async () => {
    const db = createDb({
      todos: [
        { id: 'todo-a', text: 'Buy oat milk' },
        { id: 'todo-b', text: 'Water basil' }
      ]
    });

    await expect(mat(db, todoRows, { id: 'todos-view' })).resolves.toBe(db);

    expect(isMaterialized(db)).toBe(true);
    expect(materializedRowsFor(db, 'todos-view')).toEqual([
      { id: 'todo-a', text: 'Buy oat milk' },
      { id: 'todo-b', text: 'Water basil' }
    ]);
    expect(materializationsFor(db)).toMatchObject([
      {
        kind: 'materialization',
        id: 'todos-view',
        queryKey: queryKey(todoRows),
        requestedMode: 'snapshot',
        maintenance: 'snapshot',
        diagnostics: []
      }
    ]);
  });

  it('materializes constraint attachments through mat and clears them with demat', async () => {
    const db = createDb({
      todos: [{ id: 'todo-a', text: 'Buy oat milk' }]
    });
    const constraints = constrain(req(schema.todos, 'text'), unique(schema.todos, 'id'));

    await expect(mat(db, constraints)).resolves.toBe(db);

    expect(isMaterialized(db)).toBe(true);
    expect(hasAttachedConstraints(db)).toBe(true);
    expect(materializationsFor(db)).toEqual([]);

    expect(demat(db)).toBe(db);
    expect(isMaterialized(db)).toBe(false);
    expect(hasAttachedConstraints(db)).toBe(false);
  });

  it('materializes snapshot rows for an object-backed db', async () => {
    const db = createDb({
      todos: [
        { id: 'todo-a', text: 'Buy oat milk' },
        { id: 'todo-b', text: 'Water basil' }
      ]
    });

    await expect(materializeSnapshot(db, todoRows, { id: 'todos-view', name: 'Todos' })).resolves.toBe(db);

    expect(materializedRowsFor<TodoRow>(db, 'todos-view')).toEqual([
      { id: 'todo-a', text: 'Buy oat milk' },
      { id: 'todo-b', text: 'Water basil' }
    ]);
    expect(materializationsFor(db)).toMatchObject([
      {
        kind: 'materialization',
        id: 'todos-view',
        queryKey: queryKey(todoRows),
        requestedMode: 'snapshot',
        maintenance: 'snapshot',
        sourceVersion: db.data,
        diagnostics: [],
        name: 'Todos'
      }
    ]);
    const indexResult = snapshotIndex<TodoRow>(db, 'todos-view');
    expect(indexResult).toMatchObject({
      kind: 'materializationIndex',
      id: 'todos-view',
      queryKey: queryKey(todoRows),
      indexed: true,
      diagnostics: [],
      index: { kind: 'set' }
    });
    expect(Array.from(indexResult.index?.rows ?? [])).toEqual([
      { id: 'todo-a', text: 'Buy oat milk' },
      { id: 'todo-b', text: 'Water basil' }
    ]);
  });

  it('builds a hash lookup from cached snapshot rows', async () => {
    const db = createDb({
      todos: [
        { id: 'todo-a', text: 'Same label' },
        { id: 'todo-b', text: 'Same label' },
        { id: 'todo-c', text: 'Unique label' }
      ]
    });

    await materializeSnapshot(db, todoRows, { id: 'todos-view' });

    const indexResult = snapshotHashIndex<TodoRow>(db, 'todos-view', 'text');
    expect(indexResult).toMatchObject({
      kind: 'materializationHashIndex',
      id: 'todos-view',
      queryKey: queryKey(todoRows),
      indexed: true,
      diagnostics: [],
      index: { kind: 'hash', field: 'text' }
    });
    expect(indexResult.index?.lookup.get('Same label')).toEqual([
      { id: 'todo-a', text: 'Same label' },
      { id: 'todo-b', text: 'Same label' }
    ]);
    expect(indexResult.index?.lookup.get('Unique label')).toEqual([
      { id: 'todo-c', text: 'Unique label' }
    ]);
    expect(indexResult.index?.lookup.get('Missing label')).toBeUndefined();
  });

  it('reads snapshot metadata and rows by structural query key', async () => {
    const db = createDb({
      todos: [
        { id: 'todo-a', text: 'Buy oat milk' },
        { id: 'todo-b', text: 'Water basil' }
      ]
    });

    await materializeSnapshot(db, todoRows);

    const metadata = materializationForQuery(db, todoRows);
    expect(metadata).toMatchObject({
      kind: 'materialization',
      queryKey: queryKey(todoRows),
      maintenance: 'snapshot'
    });
    expect(metadata?.id).toMatch(/^mat:/);
    expect(materializedRowsForQuery<TodoRow>(db, todoRows)).toEqual([
      { id: 'todo-a', text: 'Buy oat milk' },
      { id: 'todo-b', text: 'Water basil' }
    ]);

    expect(demat(db, metadata)).toBe(db);
    expect(materializationForQuery(db, todoRows)).toBeUndefined();
    expect(materializedRowsForQuery(db, todoRows)).toBeUndefined();
  });

  it('exposes cached snapshot rows as a read-only relation source', async () => {
    const db = createDb({
      todos: [
        { id: 'todo-a', text: 'Buy oat milk' },
        { id: 'todo-b', text: 'Water basil' }
      ],
      logs: [{ id: 'log-a', text: 'unchanged' }]
    });

    await materializeSnapshot(db, todoRows, { id: 'todos-view' });

    const source = materializedSourceFor<TodoRow>(db, 'todos-view', { relationName: 'todos' });

    expect(source.relationNames).toEqual(['todos']);
    expect(source.lookup).toBeUndefined();
    expect(source.rangeLookup).toBeUndefined();
    await expect(evaluate(source, todoRows)).resolves.toEqual({
      rows: [
        { id: 'todo-a', text: 'Buy oat milk' },
        { id: 'todo-b', text: 'Water basil' }
      ],
      diagnostics: []
    });
    expect(Array.from(await source.rows(schema.logs))).toEqual([]);
  });

  it('reports missing materialization diagnostics from snapshot sources', async () => {
    const db = createDb();
    const source = materializedSourceFor<TodoRow>(db, 'missing-view', { relationName: 'todos' });

    await expect(evaluate(source, todoRows)).resolves.toMatchObject({
      rows: [],
      diagnostics: [
        {
          code: 'materialization_missing',
          surface: 'materialization',
          detail: { target: 'missing-view' }
        }
      ]
    });
  });

  it('reports unsupported index diagnostics when metadata exists without cached rows', async () => {
    const db = createDb({
      todos: [{ id: 'todo-a', text: 'Alpha' }]
    });

    await materializeSnapshot(db, todoRows, { id: 'todos-view' });
    const metadata = materializationForQuery(db, todoRows);

    if (metadata === undefined) {
      throw new Error('expected snapshot metadata');
    }

    (metadata as { id: string }).id = 'todos-view-missing-cache';

    const source = materializedSourceFor<TodoRow>(db, metadata, { relationName: 'todos' });

    await expect(evaluate(source, todoRows)).resolves.toMatchObject({
      rows: [],
      diagnostics: [
        {
          code: 'materialization_index_unsupported',
          surface: 'materialization',
          detail: { id: 'todos-view-missing-cache', queryKey: queryKey(todoRows) }
        }
      ]
    });
  });

  it('uses exactly one relation name from options, metadata name, or metadata id', async () => {
    const namedDb = createDb({
      todos: [{ id: 'todo-a', text: 'Buy oat milk' }]
    });

    await materializeSnapshot(namedDb, todoRows, { id: 'todos-view', name: 'todos_named' });

    const namedSource = materializedSourceFor<TodoRow>(namedDb, 'todos-view');

    expect(namedSource.relationNames).toEqual(['todos_named']);
    expect(Array.from(await namedSource.rows({ ...schema.todos, name: 'todos_named' }))).toEqual([
      { id: 'todo-a', text: 'Buy oat milk' }
    ]);
    expect(Array.from(await namedSource.rows(schema.todos))).toEqual([]);

    const overrideSource = materializedSourceFor<TodoRow>(namedDb, 'todos-view', { relationName: 'todos' });

    expect(overrideSource.relationNames).toEqual(['todos']);
    expect(Array.from(await overrideSource.rows(schema.todos))).toEqual([
      { id: 'todo-a', text: 'Buy oat milk' }
    ]);

    const idDb = createDb({
      todos: [{ id: 'todo-b', text: 'Water basil' }]
    });

    await materializeSnapshot(idDb, todoRows, { id: 'todos-id-view' });

    const idSource = materializedSourceFor<TodoRow>(idDb, 'todos-id-view');

    expect(idSource.relationNames).toEqual(['todos-id-view']);
  });

  it('passes evaluator options through snapshot materialization', async () => {
    const db = createDb({
      todos: [{ id: 'todo-a', text: 'Buy oat milk' }]
    });
    const projected = pipe(
      from(todo),
      project({
        id: todo.id,
        label: call('label', todo.text)
      })
    );

    await materializeSnapshot(db, projected, {
      id: 'todos-labels',
      functions: {
        label: (value) => `todo:${String(value)}`
      }
    });

    expect(materializedRowsFor(db, 'todos-labels')).toEqual([
      { id: 'todo-a', label: 'todo:Buy oat milk' }
    ]);
  });


  it('materializes snapshot rows for a relation source', async () => {
    const source = fromObjectSource({
      todos: [{ id: 'todo-a', text: 'Buy oat milk' }]
    });

    await expect(materializeSnapshot(source, todoRows, { id: 'todos-source-view' })).resolves.toBe(source);

    expect(materializedRowsFor<TodoRow>(source, 'todos-source-view')).toEqual([
      { id: 'todo-a', text: 'Buy oat milk' }
    ]);
  });

  it('materializes rows and records diagnostics when source version fails', async () => {
    const versionError = new Error('version unavailable');
    const source: RelationSource = {
      rows: (relationRef) => relationRef.name === 'todos' ? [{ id: 'todo-a', text: 'Buy oat milk' }] : [],
      version: () => {
        throw versionError;
      }
    };

    await expect(materializeSnapshot(source, todoRows, { id: 'todos-source-view' })).resolves.toBe(source);

    expect(materializedRowsFor<TodoRow>(source, 'todos-source-view')).toEqual([
      { id: 'todo-a', text: 'Buy oat milk' }
    ]);
    expect(materializationsFor(source)).toMatchObject([
      {
        id: 'todos-source-view',
        diagnostics: [
          {
            code: 'source_error',
            message: 'source version failed',
            detail: versionError
          }
        ]
      }
    ]);
    expect(materializationsFor(source)[0]).not.toHaveProperty('sourceVersion');
  });

  it('refreshes existing snapshot materialization rows and metadata', async () => {
    let rows: readonly Todo[] = [{ id: 'todo-a', text: 'Buy oat milk' }];
    let version = 'v1';
    const source = {
      rows: () => rows,
      version: () => version
    };

    await materializeSnapshot(source, todoRows, { id: 'todos-source-view' });
    rows = [
      { id: 'todo-a', text: 'Buy oat milk' },
      { id: 'todo-b', text: 'Water basil' }
    ];
    version = 'v2';

    await expect(refreshMaterializationSnapshot(source, 'todos-source-view')).resolves.toMatchObject({
      kind: 'materializationRefresh',
      id: 'todos-source-view',
      queryKey: queryKey(todoRows),
      refreshed: true,
      rows: [
        { id: 'todo-a', text: 'Buy oat milk' },
        { id: 'todo-b', text: 'Water basil' }
      ],
      diagnostics: [],
      sourceVersion: 'v2'
    });
    expect(materializedRowsFor<TodoRow>(source, 'todos-source-view')).toEqual([
      { id: 'todo-a', text: 'Buy oat milk' },
      { id: 'todo-b', text: 'Water basil' }
    ]);
    expect(snapshotHashIndex<TodoRow>(source, 'todos-source-view', 'id').index?.lookup.get('todo-b')).toEqual([
      { id: 'todo-b', text: 'Water basil' }
    ]);
    expect(materializationsFor(source)).toMatchObject([
      {
        id: 'todos-source-view',
        maintenance: 'snapshot',
        sourceVersion: 'v2',
        diagnostics: []
      }
    ]);
  });

  it('refreshes snapshots by structural query key and reports missing targets', async () => {
    const db = createDb({
      todos: [{ id: 'todo-a', text: 'Buy oat milk' }]
    });

    await materializeSnapshot(db, todoRows);

    await expect(refreshMaterializationSnapshot(db, todoRows)).resolves.toMatchObject({
      kind: 'materializationRefresh',
      queryKey: queryKey(todoRows),
      refreshed: true,
      rows: [{ id: 'todo-a', text: 'Buy oat milk' }],
      diagnostics: []
    });
    const metadata = materializationForQuery(db, todoRows);

    if (metadata === undefined) {
      throw new Error('expected snapshot metadata');
    }

    await expect(refreshMaterializationSnapshot(db, metadata)).resolves.toMatchObject({
      kind: 'materializationRefresh',
      queryKey: queryKey(todoRows),
      refreshed: true,
      rows: [{ id: 'todo-a', text: 'Buy oat milk' }],
      diagnostics: []
    });
    await expect(refreshMaterializationSnapshot(db, 'missing-view')).resolves.toMatchObject({
      kind: 'materializationRefresh',
      id: 'missing-view',
      refreshed: false,
      rows: [],
      diagnostics: [{ code: 'materialization_missing', surface: 'materialization' }]
    });
  });

  it('maintains snapshot materializations onto a transaction result', async () => {
    const db = createDb({
      todos: [{ id: 'todo-a', text: 'Buy oat milk' }]
    });

    await materializeSnapshot(db, todoRows, { id: 'todos-view', name: 'Todos' });
    const transaction = tryTransact(db, [
      todos.insert({ id: 'todo-b', text: 'Water basil' })
    ]);

    const result = await maintainMaterializationSnapshots(db, transaction.db, { deltas: transaction.deltas });

    expect(result).toMatchObject({
      kind: 'materializationMaintenance',
      maintained: 1,
      recomputed: 1,
      carried: 0,
      diagnostics: [],
      sourceVersion: transaction.db.data
    });
    expect(result.changes).toEqual([
      {
        kind: 'materializationMaintenanceChange',
        update: 'recomputed',
        id: 'todos-view',
        queryKey: queryKey(todoRows),
        maintenance: 'snapshot',
        previousRowsAvailable: true,
        previousRows: [{ id: 'todo-a', text: 'Buy oat milk' }],
        rows: [
          { id: 'todo-a', text: 'Buy oat milk' },
          { id: 'todo-b', text: 'Water basil' }
        ],
        addedRows: [{ id: 'todo-b', text: 'Water basil' }],
        removedRows: [],
        diagnostics: []
      }
    ]);
    expect(materializedRowsFor<TodoRow>(transaction.db, 'todos-view')).toEqual([
      { id: 'todo-a', text: 'Buy oat milk' },
      { id: 'todo-b', text: 'Water basil' }
    ]);
    expect(materializationsFor(transaction.db)).toMatchObject([
      {
        id: 'todos-view',
        queryKey: queryKey(todoRows),
        requestedMode: 'snapshot',
        maintenance: 'snapshot',
        diagnostics: [],
        name: 'Todos',
        sourceVersion: transaction.db.data
      }
    ]);
  });

  it('carries attached constraints through materialization maintenance', async () => {
    const db = createDb({
      todos: [{ id: 'todo-a', text: 'Buy oat milk' }]
    });
    const constraints = constrain(req(schema.todos, 'text'), unique(schema.todos, 'id'));

    await mat(db, constraints);
    const transaction = tryTransact(db, [
      todos.insert({ id: 'todo-b', text: 'Water basil' })
    ]);

    await expect(maintainMaterializationSnapshots(db, transaction.db, { deltas: transaction.deltas })).resolves
      .toMatchObject({
        kind: 'materializationMaintenance',
        maintained: 0,
        recomputed: 0,
        carried: 0,
        changes: [],
        diagnostics: []
      });
    expect(hasAttachedConstraints(transaction.db)).toBe(true);
  });

  it('reports missing previous snapshot rows without fake row deltas', async () => {
    const db = createDb({
      todos: [{ id: 'todo-a', text: 'Alpha' }]
    });

    await materializeSnapshot(db, todoRows, { id: 'todos-view' });
    const metadata = materializationForQuery(db, todoRows);

    if (metadata === undefined) {
      throw new Error('expected snapshot metadata');
    }

    (metadata as { id: string }).id = 'todos-view-missing-cache';
    const transaction = tryTransact(db, [
      todos.insert({ id: 'todo-b', text: 'Beta' })
    ]);

    const result = await maintainMaterializationSnapshots(db, transaction.db, { deltas: transaction.deltas });

    expect(result).toMatchObject({
      kind: 'materializationMaintenance',
      maintained: 1,
      recomputed: 1,
      carried: 0,
      diagnostics: [],
      sourceVersion: transaction.db.data
    });
    expect(result.changes).toEqual([
      {
        kind: 'materializationMaintenanceChange',
        update: 'recomputed',
        id: 'todos-view-missing-cache',
        queryKey: queryKey(todoRows),
        maintenance: 'snapshot',
        previousRowsAvailable: false,
        previousRows: undefined,
        rows: [
          { id: 'todo-a', text: 'Alpha' },
          { id: 'todo-b', text: 'Beta' }
        ],
        addedRows: [],
        removedRows: [],
        diagnostics: []
      }
    ]);
    expect(materializedRowsFor<TodoRow>(transaction.db, 'todos-view-missing-cache')).toEqual([
      { id: 'todo-a', text: 'Alpha' },
      { id: 'todo-b', text: 'Beta' }
    ]);
  });

  it('incrementally maintains affected supported snapshot rows from relation deltas', async () => {
    const db = createDb({
      todos: [
        { id: 'todo-a', text: 'Alpha' },
        { id: 'todo-b', text: 'Beta' }
      ]
    });

    await materializeSnapshot(db, todoALabelRows, { id: 'todo-a-label', mode: 'incremental' });
    const transaction = tryTransact(db, [
      todos.update('todo-a', { text: 'Alpha updated' }),
      todos.insert({ id: 'todo-c', text: 'Gamma' })
    ]);

    const result = await maintainMaterializationSnapshots(db, transaction.db, { deltas: transaction.deltas });

    expect(result).toMatchObject({
      kind: 'materializationMaintenance',
      maintained: 1,
      recomputed: 0,
      carried: 0,
      diagnostics: [],
      sourceVersion: transaction.db.data
    });
    expect(result.changes).toEqual([
      {
        kind: 'materializationMaintenanceChange',
        update: 'incremental',
        id: 'todo-a-label',
        queryKey: queryKey(todoALabelRows),
        maintenance: 'incremental',
        previousRowsAvailable: true,
        previousRows: [{ view: { label: 'Alpha' } }],
        rows: [{ view: { label: 'Alpha updated' } }],
        addedRows: [{ view: { label: 'Alpha updated' } }],
        removedRows: [{ view: { label: 'Alpha' } }],
        diagnostics: []
      }
    ]);
    expect(materializedRowsFor(transaction.db, 'todo-a-label')).toEqual([
      { view: { label: 'Alpha updated' } }
    ]);
    expect(materializationsFor(transaction.db)).toMatchObject([
      {
        id: 'todo-a-label',
        requestedMode: 'incremental',
        maintenance: 'incremental',
        diagnostics: [],
        sourceVersion: transaction.db.data
      }
    ]);
  });

  it('carries unaffected incremental snapshots without recomputing', async () => {
    const db = createDb({
      todos: [{ id: 'todo-a', text: 'Alpha' }],
      logs: []
    });

    await materializeSnapshot(db, todoALabelRows, { id: 'todo-a-label', mode: 'incremental' });
    const transaction = tryTransact(db, [
      logs.insert({ id: 'log-a', text: 'unrelated write' })
    ]);

    const result = await maintainMaterializationSnapshots(db, transaction.db, { deltas: transaction.deltas });

    expect(result).toMatchObject({
      kind: 'materializationMaintenance',
      maintained: 1,
      recomputed: 0,
      carried: 1,
      diagnostics: [],
      sourceVersion: transaction.db.data
    });
    expect(result.changes).toEqual([
      {
        kind: 'materializationMaintenanceChange',
        update: 'carried',
        id: 'todo-a-label',
        queryKey: queryKey(todoALabelRows),
        maintenance: 'incremental',
        previousRowsAvailable: true,
        previousRows: [{ view: { label: 'Alpha' } }],
        rows: [{ view: { label: 'Alpha' } }],
        addedRows: [],
        removedRows: [],
        diagnostics: []
      }
    ]);
    expect(materializedRowsFor(transaction.db, 'todo-a-label')).toEqual([
      { view: { label: 'Alpha' } }
    ]);
  });

  for (const testCase of incrementalParityCases) {
    it(`keeps supported incremental filter/project rows equal to full recompute for ${testCase.name}`, async () => {
      await expectIncrementalMaintenanceMatchesFull(testCase);
    });
  }

  for (const testCase of incrementalExtendParityCases) {
    it(`keeps supported incremental extend rows equal to full recompute for ${testCase.name}`, async () => {
      await expectIncrementalMaintenanceMatchesFull({
        ...testCase,
        id: 'open-task-extended-labels',
        query: openTaskExtendedLabels
      });
    });
  }

  for (const testCase of incrementalConjunctionParityCases) {
    it(`keeps supported incremental conjunctive filters equal to full recompute for ${testCase.name}`, async () => {
      await expectIncrementalMaintenanceMatchesFull({
        ...testCase,
        id: 'open-high-task-labels',
        query: openHighTaskLabels
      });
    });
  }

  for (const testCase of incrementalConjunctionParityCases) {
    it(`keeps supported incremental chained filters equal to full recompute for ${testCase.name}`, async () => {
      await expectIncrementalMaintenanceMatchesFull({
        ...testCase,
        id: 'open-high-task-labels-chain',
        query: openHighTaskLabelsWhereChain
      });
    });
  }

  for (const testCase of incrementalComparisonParityCases) {
    it(`keeps supported incremental comparison filters equal to full recompute for ${testCase.name}`, async () => {
      await expectIncrementalMaintenanceMatchesFull({
        ...testCase,
        id: 'comparable-task-labels',
        query: comparableTaskLabels
      });
    });
  }

  for (const testCase of incrementalCompositionParityCases) {
    it(`keeps supported incremental composed filters equal to full recompute for ${testCase.name}`, async () => {
      await expectIncrementalMaintenanceMatchesFull({
        ...testCase,
        id: 'composed-task-labels',
        query: composedTaskLabels
      });
    });
  }

  it('keeps supported incremental env filters honest across same-env and changed-env maintenance', async () => {
    const envOptions = { env: { status: 'open', excludedPriority: 'low' } };
    const db = createDb({ tasks: baseTaskRows });

    await materializeSnapshot(db, envTaskLabels, {
      id: 'env-task-labels',
      mode: 'incremental',
      ...envOptions
    });
    expect(materializationForQuery(db, envTaskLabels)).toMatchObject({
      id: 'env-task-labels',
      requestedMode: 'incremental',
      maintenance: 'incremental',
      diagnostics: []
    });

    const transaction = tryTransact(db, [
      tasks.update('task-a', { text: 'Alpha updated' }),
      tasks.insert({ id: 'task-d', status: 'closed', priority: 'high', text: 'Delta', note: 'fourth' })
    ]);
    expect(transaction.diagnostics).toEqual([]);

    const sameEnvRows = (await q(transaction.db, envTaskLabels, envOptions)).rows;
    const sameEnvResult = await maintainMaterializationSnapshots(db, transaction.db, {
      deltas: transaction.deltas,
      ...envOptions
    });

    expect(sameEnvResult).toMatchObject({
      kind: 'materializationMaintenance',
      maintained: 1,
      recomputed: 0,
      carried: 0,
      diagnostics: [],
      sourceVersion: transaction.db.data
    });
    expect(materializedRowsFor(transaction.db, 'env-task-labels')).toEqual(sameEnvRows);

    const envChangedDb = createDb({ tasks: baseTaskRows });
    const envChangedNext = createDb({ tasks: baseTaskRows });
    const changedEnvOptions = { env: { status: 'closed', excludedPriority: 'low' } };

    await materializeSnapshot(envChangedDb, envTaskLabels, {
      id: 'env-task-labels',
      mode: 'incremental',
      ...envOptions
    });

    const changedEnvRows = (await q(envChangedNext, envTaskLabels, changedEnvOptions)).rows;
    const changedEnvResult = await maintainMaterializationSnapshots(envChangedDb, envChangedNext, {
      deltas: [],
      ...changedEnvOptions
    });

    expect(changedEnvResult).toMatchObject({
      kind: 'materializationMaintenance',
      maintained: 1,
      recomputed: 1,
      carried: 0,
      diagnostics: [
        {
          code: 'materialization_incremental_fallback',
          surface: 'materialization',
          detail: {
            mode: 'incremental',
            fallback: 'recompute',
            id: 'env-task-labels',
            queryKey: queryKey(envTaskLabels),
            reason: 'incremental predicate env inputs changed'
          }
        }
      ],
      sourceVersion: envChangedNext.data
    });
    expect(materializedRowsFor(envChangedNext, 'env-task-labels')).toEqual(changedEnvRows);
  });

  it('keeps unsupported incremental chained where predicates diagnostic-backed', async () => {
    const db = createDb({ tasks: baseTaskRows });
    const functions = {
      identity: (input: unknown) => input
    };
    const labels = pipe(
      from(task),
      where(eq(task.status, 'open')),
      where(eq(call('identity', task.priority), 'high')),
      project({
        label: task.text
      })
    );

    await materializeSnapshot(db, labels, {
      id: 'open-task-chained-call-filter-labels',
      mode: 'incremental',
      functions
    });
    expect(materializationForQuery(db, labels)).toMatchObject({
      id: 'open-task-chained-call-filter-labels',
      requestedMode: 'incremental',
      maintenance: 'snapshot',
      diagnostics: [
        {
          code: 'materialization_unsupported',
          surface: 'materialization',
          detail: {
            mode: 'incremental',
            reason: 'where is limited to base-field comparisons against literal/env values with and/or/not composition',
            queryKey: queryKey(labels)
          }
        }
      ]
    });

    const transaction = tryTransact(db, [
      tasks.update('task-a', { text: 'Alpha updated' })
    ]);
    expect(transaction.diagnostics).toEqual([]);

    const fullRows = (await q(transaction.db, labels, { functions })).rows;

    await expect(
      maintainMaterializationSnapshots(db, transaction.db, {
        deltas: transaction.deltas,
        functions
      })
    ).resolves.toMatchObject({
      kind: 'materializationMaintenance',
      maintained: 1,
      recomputed: 1,
      carried: 0,
      diagnostics: [{ code: 'materialization_unsupported', surface: 'materialization' }],
      sourceVersion: transaction.db.data
    });
    expect(materializedRowsFor(transaction.db, 'open-task-chained-call-filter-labels')).toEqual(fullRows);
  });

  it('keeps output-phase incremental where operators diagnostic-backed', async () => {
    const db = createDb({ tasks: baseTaskRows });
    const labels = pipe(
      from(task),
      where(eq(task.status, 'open')),
      project({
        label: task.text
      }),
      where(eq(rootLabel, 'Alpha'))
    );

    await materializeSnapshot(db, labels, {
      id: 'open-task-output-filter-labels',
      mode: 'incremental'
    });
    expect(materializationForQuery(db, labels)).toMatchObject({
      id: 'open-task-output-filter-labels',
      requestedMode: 'incremental',
      maintenance: 'snapshot',
      diagnostics: [
        {
          code: 'materialization_unsupported',
          surface: 'materialization',
          detail: {
            mode: 'incremental',
            reason: 'where is only supported before projection transforms',
            queryKey: queryKey(labels)
          }
        }
      ]
    });

    const transaction = tryTransact(db, [
      tasks.update('task-a', { text: 'Alpha updated' })
    ]);
    expect(transaction.diagnostics).toEqual([]);

    const fullRows = (await q(transaction.db, labels)).rows;

    await expect(
      maintainMaterializationSnapshots(db, transaction.db, { deltas: transaction.deltas })
    ).resolves.toMatchObject({
      kind: 'materializationMaintenance',
      maintained: 1,
      recomputed: 1,
      carried: 0,
      diagnostics: [{ code: 'materialization_unsupported', surface: 'materialization' }],
      sourceVersion: transaction.db.data
    });
    expect(materializedRowsFor(transaction.db, 'open-task-output-filter-labels')).toEqual(fullRows);
  });

  it('keeps unsupported incremental conjunction predicates diagnostic-backed', async () => {
    const db = createDb({ tasks: baseTaskRows });
    const functions = {
      identity: (input: unknown) => input
    };
    const labels = pipe(
      from(task),
      where(and(eq(task.status, 'open'), eq(call('identity', task.priority), 'high'))),
      project({
        label: task.text
      })
    );

    await materializeSnapshot(db, labels, {
      id: 'open-task-call-filter-labels',
      mode: 'incremental',
      functions
    });
    expect(materializationForQuery(db, labels)).toMatchObject({
      id: 'open-task-call-filter-labels',
      requestedMode: 'incremental',
      maintenance: 'snapshot',
      diagnostics: [
        {
          code: 'materialization_unsupported',
          surface: 'materialization',
          detail: {
            mode: 'incremental',
            reason: 'where is limited to base-field comparisons against literal/env values with and/or/not composition',
            queryKey: queryKey(labels)
          }
        }
      ]
    });

    const transaction = tryTransact(db, [
      tasks.update('task-a', { text: 'Alpha updated' })
    ]);
    expect(transaction.diagnostics).toEqual([]);

    const fullRows = (await q(transaction.db, labels, { functions })).rows;

    await expect(
      maintainMaterializationSnapshots(db, transaction.db, {
        deltas: transaction.deltas,
        functions
      })
    ).resolves.toMatchObject({
      kind: 'materializationMaintenance',
      maintained: 1,
      recomputed: 1,
      carried: 0,
      diagnostics: [{ code: 'materialization_unsupported', surface: 'materialization' }],
      sourceVersion: transaction.db.data
    });
    expect(materializedRowsFor(transaction.db, 'open-task-call-filter-labels')).toEqual(fullRows);
  });

  it('keeps unsupported incremental extend calls diagnostic-backed', async () => {
    const db = createDb({ tasks: baseTaskRows });
    const labels = pipe(
      from(task),
      where(eq(task.status, 'open')),
      extend({
        label: call('label', task.text)
      }),
      project({
        label: rootLabel
      })
    );

    await materializeSnapshot(db, labels, {
      id: 'open-task-call-labels',
      mode: 'incremental',
      functions: {
        label: (value) => `task:${String(value)}`
      }
    });
    expect(materializationForQuery(db, labels)).toMatchObject({
      id: 'open-task-call-labels',
      requestedMode: 'incremental',
      maintenance: 'snapshot',
      diagnostics: [
        {
          code: 'materialization_unsupported',
          surface: 'materialization',
          detail: {
            mode: 'incremental',
            reason: 'extend is limited to field, literal, and tuple expressions',
            queryKey: queryKey(labels)
          }
        }
      ]
    });

    const transaction = tryTransact(db, [
      tasks.update('task-a', { text: 'Alpha updated' })
    ]);
    expect(transaction.diagnostics).toEqual([]);

    await expect(
      maintainMaterializationSnapshots(db, transaction.db, {
        deltas: transaction.deltas,
        functions: {
          label: (value) => `task:${String(value)}`
        }
      })
    ).resolves.toMatchObject({
      kind: 'materializationMaintenance',
      maintained: 1,
      recomputed: 1,
      carried: 0,
      diagnostics: [{ code: 'materialization_unsupported', surface: 'materialization' }],
      sourceVersion: transaction.db.data
    });
    expect(materializedRowsFor(transaction.db, 'open-task-call-labels')).toEqual([
      { label: 'task:Alpha updated' },
      { label: 'task:Gamma' }
    ]);
  });

  it('incrementally maintains ungrouped count aggregates from relation deltas', async () => {
    const db = createDb({ tasks: baseTaskRows });
    const counts = pipe(
      from(task),
      where(eq(task.status, 'open')),
      aggregate({
        aggregates: {
          total: count(),
          duplicateTotal: count()
        }
      })
    );

    await materializeSnapshot(db, counts, { id: 'open-task-counts', mode: 'incremental' });

    expect(materializedRowsFor(db, 'open-task-counts')).toEqual([{ total: 2, duplicateTotal: 2 }]);
    expect(materializationForQuery(db, counts)).toMatchObject({
      id: 'open-task-counts',
      requestedMode: 'incremental',
      maintenance: 'incremental',
      diagnostics: []
    });

    const transaction = tryTransact(db, [
      tasks.insert({ id: 'task-d', status: 'open', priority: 'high', text: 'Delta', note: 'fourth' }),
      tasks.update('task-b', { status: 'open' }),
      tasks.delete('task-c')
    ]);
    expect(transaction.diagnostics).toEqual([]);

    const fullRows = (await q(transaction.db, counts)).rows;
    const result = await maintainMaterializationSnapshots(db, transaction.db, { deltas: transaction.deltas });

    expect(result).toMatchObject({
      kind: 'materializationMaintenance',
      maintained: 1,
      recomputed: 0,
      carried: 0,
      diagnostics: [],
      sourceVersion: transaction.db.data
    });
    expect(materializedRowsFor(transaction.db, 'open-task-counts')).toEqual(fullRows);
    expect(materializationForQuery(transaction.db, counts)).toMatchObject({
      id: 'open-task-counts',
      requestedMode: 'incremental',
      maintenance: 'incremental',
      diagnostics: []
    });
  });

  it('incrementally maintains grouped count aggregates for unambiguous group changes', async () => {
    const db = createDb({ tasks: baseTaskRows });
    const counts = pipe(
      from(task),
      aggregate({
        groupBy: {
          status: task.status,
          bucket: tuple(task.status, value('tasks'))
        },
        aggregates: {
          total: count()
        }
      })
    );

    await materializeSnapshot(db, counts, { id: 'task-status-counts', mode: 'incremental' });

    expect(materializationForQuery(db, counts)).toMatchObject({
      id: 'task-status-counts',
      requestedMode: 'incremental',
      maintenance: 'incremental',
      diagnostics: []
    });

    const transaction = tryTransact(db, [
      tasks.insert({ id: 'task-d', status: 'blocked', priority: 'low', text: 'Delta', note: 'fourth' }),
      tasks.insert({ id: 'task-e', status: 'open', priority: 'high', text: 'Echo', note: 'fifth' }),
      tasks.delete('task-b')
    ]);
    expect(transaction.diagnostics).toEqual([]);

    const fullRows = (await q(transaction.db, counts)).rows;
    const result = await maintainMaterializationSnapshots(db, transaction.db, { deltas: transaction.deltas });

    expect(result).toMatchObject({
      kind: 'materializationMaintenance',
      maintained: 1,
      recomputed: 0,
      carried: 0,
      diagnostics: [],
      sourceVersion: transaction.db.data
    });
    expect(materializedRowsFor(transaction.db, 'task-status-counts')).toEqual(fullRows);
  });

  it('falls back to recompute for grouped count aggregate changes with ambiguous group order', async () => {
    const db = createDb({ tasks: baseTaskRows });
    const counts = pipe(
      from(task),
      aggregate({
        groupBy: {
          status: task.status
        },
        aggregates: {
          total: count()
        }
      })
    );

    await materializeSnapshot(db, counts, { id: 'task-status-counts', mode: 'incremental' });

    const transaction = tryTransact(db, [
      tasks.delete('task-a')
    ]);
    expect(transaction.diagnostics).toEqual([]);

    const fullRows = (await q(transaction.db, counts)).rows;
    const result = await maintainMaterializationSnapshots(db, transaction.db, { deltas: transaction.deltas });

    expect(result).toMatchObject({
      kind: 'materializationMaintenance',
      maintained: 1,
      recomputed: 1,
      carried: 0,
      diagnostics: [
        {
          code: 'materialization_incremental_fallback',
          surface: 'materialization',
          detail: {
            mode: 'incremental',
            fallback: 'recompute',
            id: 'task-status-counts',
            queryKey: queryKey(counts),
            reason: expect.any(String)
          }
        }
      ],
      sourceVersion: transaction.db.data
    });
    expect(materializedRowsFor(transaction.db, 'task-status-counts')).toEqual(fullRows);
    expect(materializationForQuery(transaction.db, counts)).toMatchObject({
      id: 'task-status-counts',
      requestedMode: 'incremental',
      maintenance: 'incremental',
      diagnostics: []
    });
  });

  it('incrementally maintains ungrouped sum aggregates from relation deltas', async () => {
    const db = createDb({ workItems: baseWorkItemRows });
    const totals = pipe(
      from(workItem),
      where(eq(workItem.status, 'open')),
      aggregate({
        aggregates: {
          total: count(),
          totalUnits: sum(workItem.units),
          duplicateUnits: sum(workItem.units),
          constantUnits: sum(value(2))
        }
      })
    );

    await materializeSnapshot(db, totals, { id: 'open-work-totals', mode: 'incremental' });

    expect(materializedRowsFor(db, 'open-work-totals')).toEqual([
      { total: 2, totalUnits: 7, duplicateUnits: 7, constantUnits: 4 }
    ]);
    expect(materializationForQuery(db, totals)).toMatchObject({
      id: 'open-work-totals',
      requestedMode: 'incremental',
      maintenance: 'incremental',
      diagnostics: []
    });

    const transaction = tryTransact(db, [
      workItems.insert({ id: 'work-d', status: 'open', bucket: 'gamma', units: 4, bonus: 1 }),
      workItems.update('work-b', { status: 'open', units: 8 }),
      workItems.update('work-c', { units: 6 }),
      workItems.delete('work-a')
    ]);
    expect(transaction.diagnostics).toEqual([]);

    const fullRows = (await q(transaction.db, totals)).rows;
    const result = await maintainMaterializationSnapshots(db, transaction.db, { deltas: transaction.deltas });

    expect(result).toMatchObject({
      kind: 'materializationMaintenance',
      maintained: 1,
      recomputed: 0,
      carried: 0,
      diagnostics: [],
      sourceVersion: transaction.db.data
    });
    expect(materializedRowsFor(transaction.db, 'open-work-totals')).toEqual(fullRows);
  });

  it('incrementally maintains grouped sum aggregates for unambiguous group changes', async () => {
    const db = createDb({ workItems: baseWorkItemRows });
    const totals = pipe(
      from(workItem),
      aggregate({
        groupBy: {
          bucket: workItem.bucket
        },
        aggregates: {
          total: count(),
          totalUnits: sum(workItem.units),
          totalBonus: sum(workItem.bonus)
        }
      })
    );

    await materializeSnapshot(db, totals, { id: 'work-bucket-totals', mode: 'incremental' });

    expect(materializationForQuery(db, totals)).toMatchObject({
      id: 'work-bucket-totals',
      requestedMode: 'incremental',
      maintenance: 'incremental',
      diagnostics: []
    });

    const transaction = tryTransact(db, [
      workItems.insert({ id: 'work-d', status: 'open', bucket: 'gamma', units: 4, bonus: 1 }),
      workItems.insert({ id: 'work-e', status: 'open', bucket: 'alpha', units: 3, bonus: 4 }),
      workItems.delete('work-b')
    ]);
    expect(transaction.diagnostics).toEqual([]);

    const fullRows = (await q(transaction.db, totals)).rows;
    const result = await maintainMaterializationSnapshots(db, transaction.db, { deltas: transaction.deltas });

    expect(result).toMatchObject({
      kind: 'materializationMaintenance',
      maintained: 1,
      recomputed: 0,
      carried: 0,
      diagnostics: [],
      sourceVersion: transaction.db.data
    });
    expect(materializedRowsFor(transaction.db, 'work-bucket-totals')).toEqual(fullRows);
  });

  it('incrementally maintains grouped sum aggregates for same-group value updates', async () => {
    const db = createDb({ workItems: baseWorkItemRows });
    const totals = pipe(
      from(workItem),
      aggregate({
        groupBy: {
          bucket: workItem.bucket
        },
        aggregates: {
          total: count(),
          totalUnits: sum(workItem.units)
        }
      })
    );

    await materializeSnapshot(db, totals, { id: 'work-bucket-units', mode: 'incremental' });

    const transaction = tryTransact(db, [
      workItems.update('work-a', { units: 9 })
    ]);
    expect(transaction.diagnostics).toEqual([]);

    const fullRows = (await q(transaction.db, totals)).rows;
    const result = await maintainMaterializationSnapshots(db, transaction.db, { deltas: transaction.deltas });

    expect(result).toMatchObject({
      kind: 'materializationMaintenance',
      maintained: 1,
      recomputed: 0,
      carried: 0,
      diagnostics: [],
      sourceVersion: transaction.db.data
    });
    expect(materializedRowsFor(transaction.db, 'work-bucket-units')).toEqual(fullRows);
  });

  it('incrementally maintains ungrouped min/max aggregates from relation deltas', async () => {
    const db = createDb({ workItems: baseWorkItemRows });
    const extrema = pipe(
      from(workItem),
      where(eq(workItem.status, 'open')),
      aggregate({
        aggregates: {
          total: count(),
          minUnits: min(workItem.units),
          duplicateMinUnits: min(workItem.units),
          maxUnits: max(workItem.units),
          constantMin: min(value(2))
        }
      })
    );

    await materializeSnapshot(db, extrema, { id: 'open-work-extrema', mode: 'incremental' });

    expect(materializedRowsFor(db, 'open-work-extrema')).toEqual([
      { total: 2, minUnits: 2, duplicateMinUnits: 2, maxUnits: 5, constantMin: 2 }
    ]);
    expect(materializationForQuery(db, extrema)).toMatchObject({
      id: 'open-work-extrema',
      requestedMode: 'incremental',
      maintenance: 'incremental',
      diagnostics: []
    });

    const transaction = tryTransact(db, [
      workItems.insert({ id: 'work-d', status: 'open', bucket: 'gamma', units: 1, bonus: 1 }),
      workItems.update('work-c', { units: 6 }),
      workItems.update('work-b', { status: 'open', units: 8 })
    ]);
    expect(transaction.diagnostics).toEqual([]);

    const fullRows = (await q(transaction.db, extrema)).rows;
    const result = await maintainMaterializationSnapshots(db, transaction.db, { deltas: transaction.deltas });

    expect(result).toMatchObject({
      kind: 'materializationMaintenance',
      maintained: 1,
      recomputed: 0,
      carried: 0,
      diagnostics: [],
      sourceVersion: transaction.db.data
    });
    expect(materializedRowsFor(transaction.db, 'open-work-extrema')).toEqual(fullRows);
  });

  it('incrementally maintains grouped min/max aggregates for unambiguous group changes', async () => {
    const db = createDb({ workItems: baseWorkItemRows });
    const extrema = pipe(
      from(workItem),
      aggregate({
        groupBy: {
          bucket: workItem.bucket
        },
        aggregates: {
          total: count(),
          minUnits: min(workItem.units),
          maxUnits: max(workItem.units)
        }
      })
    );

    await materializeSnapshot(db, extrema, { id: 'work-bucket-extrema', mode: 'incremental' });

    expect(materializationForQuery(db, extrema)).toMatchObject({
      id: 'work-bucket-extrema',
      requestedMode: 'incremental',
      maintenance: 'incremental',
      diagnostics: []
    });

    const transaction = tryTransact(db, [
      workItems.insert({ id: 'work-d', status: 'open', bucket: 'alpha', units: 1, bonus: 1 }),
      workItems.insert({ id: 'work-e', status: 'open', bucket: 'gamma', units: 4, bonus: 1 }),
      workItems.update('work-c', { units: 6 }),
      workItems.delete('work-b')
    ]);
    expect(transaction.diagnostics).toEqual([]);

    const fullRows = (await q(transaction.db, extrema)).rows;
    const result = await maintainMaterializationSnapshots(db, transaction.db, { deltas: transaction.deltas });

    expect(result).toMatchObject({
      kind: 'materializationMaintenance',
      maintained: 1,
      recomputed: 0,
      carried: 0,
      diagnostics: [],
      sourceVersion: transaction.db.data
    });
    expect(materializedRowsFor(transaction.db, 'work-bucket-extrema')).toEqual(fullRows);
  });

  it('falls back when removing the cached min/max extremum would require a group rescan', async () => {
    const db = createDb({ workItems: baseWorkItemRows });
    const extrema = pipe(
      from(workItem),
      where(eq(workItem.status, 'open')),
      aggregate({
        aggregates: {
          total: count(),
          minUnits: min(workItem.units),
          maxUnits: max(workItem.units)
        }
      })
    );

    await materializeSnapshot(db, extrema, { id: 'open-work-extrema', mode: 'incremental' });

    const transaction = tryTransact(db, [
      workItems.delete('work-c')
    ]);
    expect(transaction.diagnostics).toEqual([]);

    const fullRows = (await q(transaction.db, extrema)).rows;
    const result = await maintainMaterializationSnapshots(db, transaction.db, { deltas: transaction.deltas });

    expect(result).toMatchObject({
      kind: 'materializationMaintenance',
      maintained: 1,
      recomputed: 1,
      carried: 0,
      diagnostics: [
        {
          code: 'materialization_incremental_fallback',
          surface: 'materialization',
          detail: {
            mode: 'incremental',
            fallback: 'recompute',
            id: 'open-work-extrema',
            queryKey: queryKey(extrema),
            reason: 'removed max aggregate value may have determined the cached max for maxUnits'
          }
        }
      ],
      sourceVersion: transaction.db.data
    });
    expect(materializedRowsFor(transaction.db, 'open-work-extrema')).toEqual(fullRows);
  });

  it('falls back for grouped sum removals without cached count cardinality', async () => {
    const db = createDb({ workItems: baseWorkItemRows });
    const totals = pipe(
      from(workItem),
      aggregate({
        groupBy: {
          bucket: workItem.bucket
        },
        aggregates: {
          totalUnits: sum(workItem.units)
        }
      })
    );

    await materializeSnapshot(db, totals, { id: 'work-bucket-sums', mode: 'incremental' });

    expect(materializationForQuery(db, totals)).toMatchObject({
      id: 'work-bucket-sums',
      requestedMode: 'incremental',
      maintenance: 'incremental',
      diagnostics: []
    });

    const transaction = tryTransact(db, [
      workItems.delete('work-a')
    ]);
    expect(transaction.diagnostics).toEqual([]);

    const fullRows = (await q(transaction.db, totals)).rows;
    const result = await maintainMaterializationSnapshots(db, transaction.db, { deltas: transaction.deltas });

    expect(result).toMatchObject({
      kind: 'materializationMaintenance',
      maintained: 1,
      recomputed: 1,
      carried: 0,
      diagnostics: [
        {
          code: 'materialization_incremental_fallback',
          surface: 'materialization',
          detail: {
            mode: 'incremental',
            fallback: 'recompute',
            id: 'work-bucket-sums',
            queryKey: queryKey(totals),
            reason: 'cached aggregate snapshot is missing count() needed to determine removed group cardinality'
          }
        }
      ],
      sourceVersion: transaction.db.data
    });
    expect(materializedRowsFor(transaction.db, 'work-bucket-sums')).toEqual(fullRows);
  });

  it('keeps sum aggregate options diagnostic-backed without incremental maintenance', async () => {
    const db = createDb({ workItems: baseWorkItemRows });
    const totals = pipe(
      from(workItem),
      aggregate({
        aggregates: {
          totalUnits: sum(workItem.units, { distinct: true })
        }
      })
    );

    await materializeSnapshot(db, totals, { id: 'distinct-work-sums', mode: 'incremental' });

    expect(materializedRowsFor(db, 'distinct-work-sums')).toEqual([{ totalUnits: 14 }]);
    expect(materializationForQuery(db, totals)).toMatchObject({
      id: 'distinct-work-sums',
      requestedMode: 'incremental',
      maintenance: 'snapshot',
      diagnostics: [
        {
          code: 'materialization_unsupported',
          surface: 'materialization',
          detail: {
            mode: 'incremental',
            reason: 'aggregate maintenance is limited to count() without inputs/options and sum/min/max(field-or-supported-expr) without options',
            queryKey: queryKey(totals)
          }
        }
      ]
    });
  });

  it('keeps count aggregate inputs diagnostic-backed without incremental maintenance', async () => {
    const db = createDb({ tasks: baseTaskRows });
    const counts = pipe(
      from(task),
      aggregate({
        aggregates: {
          total: count(task.text)
        }
      })
    );

    await materializeSnapshot(db, counts, { id: 'task-text-counts', mode: 'incremental' });

    expect(materializedRowsFor(db, 'task-text-counts')).toEqual([{ total: 3 }]);
    expect(materializationForQuery(db, counts)).toMatchObject({
      id: 'task-text-counts',
      requestedMode: 'incremental',
      maintenance: 'snapshot',
      diagnostics: [
        {
          code: 'materialization_unsupported',
          surface: 'materialization',
          detail: {
            mode: 'incremental',
            reason: 'aggregate maintenance is limited to count() without inputs/options and sum/min/max(field-or-supported-expr) without options',
            queryKey: queryKey(counts)
          }
        }
      ]
    });
  });

  it('recomputes supported incremental snapshots when deltas are omitted', async () => {
    const db = createDb({ tasks: baseTaskRows });

    await materializeSnapshot(db, openTaskLabels, { id: 'open-task-labels', mode: 'incremental' });
    const transaction = tryTransact(db, [
      tasks.update('task-a', { text: 'Alpha updated' })
    ]);
    expect(transaction.diagnostics).toEqual([]);

    const fullRows = (await q(transaction.db, openTaskLabels)).rows;
    const result = await maintainMaterializationSnapshots(db, transaction.db);

    expect(result).toMatchObject({
      kind: 'materializationMaintenance',
      maintained: 1,
      recomputed: 1,
      carried: 0,
      diagnostics: [],
      sourceVersion: transaction.db.data
    });
    expect(materializedRowsFor(transaction.db, 'open-task-labels')).toEqual(fullRows);
  });

  it('carries supported incremental snapshots for empty and no-op deltas', async () => {
    const emptyDeltaDb = createDb({ tasks: baseTaskRows });
    const emptyDeltaNext = createDb({ tasks: baseTaskRows });

    await materializeSnapshot(emptyDeltaDb, openTaskLabels, { id: 'open-task-labels', mode: 'incremental' });
    const emptyDeltaRows = (await q(emptyDeltaNext, openTaskLabels)).rows;
    const emptyDeltaResult = await maintainMaterializationSnapshots(emptyDeltaDb, emptyDeltaNext, { deltas: [] });

    expect(emptyDeltaResult).toMatchObject({
      kind: 'materializationMaintenance',
      maintained: 1,
      recomputed: 0,
      carried: 1,
      diagnostics: [],
      sourceVersion: emptyDeltaNext.data
    });
    expect(materializedRowsFor(emptyDeltaNext, 'open-task-labels')).toEqual(emptyDeltaRows);

    const noOpDeltaDb = createDb({ tasks: baseTaskRows });
    const noOpDeltaNext = createDb({ tasks: baseTaskRows });

    await materializeSnapshot(noOpDeltaDb, openTaskLabels, { id: 'open-task-labels', mode: 'incremental' });
    const noOpDeltaRows = (await q(noOpDeltaNext, openTaskLabels)).rows;
    const noOpDeltaResult = await maintainMaterializationSnapshots(noOpDeltaDb, noOpDeltaNext, {
      deltas: [{ relation: schema.tasks, added: [], removed: [] }]
    });

    expect(noOpDeltaResult).toMatchObject({
      kind: 'materializationMaintenance',
      maintained: 1,
      recomputed: 0,
      carried: 1,
      diagnostics: [],
      sourceVersion: noOpDeltaNext.data
    });
    expect(materializedRowsFor(noOpDeltaNext, 'open-task-labels')).toEqual(noOpDeltaRows);
  });

  it('carries unaffected snapshot materializations without recomputing when deltas miss dependencies', async () => {
    const db = createDb({
      todos: [{ id: 'todo-a', text: 'Buy oat milk' }],
      logs: []
    });

    await materializeSnapshot(db, todoRows, { id: 'todos-view' });
    const transaction = tryTransact(db, [
      logs.insert({ id: 'log-a', text: 'unrelated write' })
    ]);

    await expect(maintainMaterializationSnapshots(db, transaction.db, { deltas: transaction.deltas })).resolves.toMatchObject({
      kind: 'materializationMaintenance',
      maintained: 1,
      recomputed: 0,
      carried: 1,
      diagnostics: [],
      sourceVersion: transaction.db.data
    });
    expect(materializedRowsFor<TodoRow>(transaction.db, 'todos-view')).toEqual([
      { id: 'todo-a', text: 'Buy oat milk' }
    ]);
  });

  it('falls back to recompute for unsupported snapshot queries', async () => {
    const db = createDb({
      todos: [{ id: 'todo-a', text: 'Alpha' }]
    });
    const labels = pipe(
      from(todo),
      project({
        id: todo.id,
        label: call('label', todo.text)
      })
    );

    await materializeSnapshot(db, labels, {
      id: 'todo-labels',
      functions: {
        label: (value) => `todo:${String(value)}`
      }
    });
    const transaction = tryTransact(db, [
      todos.update('todo-a', { text: 'Beta' })
    ]);

    await expect(
      maintainMaterializationSnapshots(db, transaction.db, {
        deltas: transaction.deltas,
        functions: {
          label: (value) => `todo:${String(value)}`
        }
      })
    ).resolves.toMatchObject({
      kind: 'materializationMaintenance',
      maintained: 1,
      recomputed: 1,
      carried: 0,
      diagnostics: [],
      sourceVersion: transaction.db.data
    });
    expect(materializedRowsFor(transaction.db, 'todo-labels')).toEqual([
      { id: 'todo-a', label: 'todo:Beta' }
    ]);
  });

  it('demat removes snapshot rows and metadata', async () => {
    const db = createDb({
      todos: [{ id: 'todo-a', text: 'Buy oat milk' }]
    });

    await materializeSnapshot(db, todoRows, { id: 'todos-view' });

    expect(materializedRowsFor<TodoRow>(db, 'todos-view')).toEqual([{ id: 'todo-a', text: 'Buy oat milk' }]);
    expect(demat(db, 'todos-view')).toBe(db);
    expect(isMaterialized(db)).toBe(false);
    expect(materializationsFor(db)).toEqual([]);
    expect(materializedRowsFor(db, 'todos-view')).toBeUndefined();
  });

  it('keeps unsupported incremental materializations diagnostic-backed', async () => {
    const db = createDb({
      todos: [{ id: 'todo-a', text: 'Buy oat milk' }]
    });
    const labels = pipe(
      from(todo),
      project({
        id: todo.id,
        label: call('label', todo.text)
      })
    );

    await mat(db, todoRows, { id: 'todos-live', mode: 'incremental' });

    expect(materializedRowsFor(db, 'todos-live')).toEqual([{ id: 'todo-a', text: 'Buy oat milk' }]);
    expect(materializationsFor(db)).toMatchObject([
      {
        id: 'todos-live',
        requestedMode: 'incremental',
        maintenance: 'incremental',
        diagnostics: []
      }
    ]);

    await materializeSnapshot(db, labels, {
      id: 'todo-labels-live',
      mode: 'incremental',
      functions: {
        label: (value) => `todo:${String(value)}`
      }
    });
    expect(materializedRowsFor(db, 'todo-labels-live')).toEqual([
      { id: 'todo-a', label: 'todo:Buy oat milk' }
    ]);
    expect(materializationForQuery(db, labels)).toMatchObject({
      id: 'todo-labels-live',
      requestedMode: 'incremental',
      maintenance: 'snapshot',
      diagnostics: [{ code: 'materialization_unsupported', surface: 'materialization' }]
    });

    const transaction = tryTransact(db, [
      todos.update('todo-a', { text: 'Water basil' })
    ]);

    await expect(
      maintainMaterializationSnapshots(db, transaction.db, {
        deltas: transaction.deltas,
        functions: {
          label: (value) => `todo:${String(value)}`
        }
      })
    ).resolves.toMatchObject({
      kind: 'materializationMaintenance',
      maintained: 2,
      recomputed: 1,
      carried: 0,
      diagnostics: [{ code: 'materialization_unsupported', surface: 'materialization' }],
      sourceVersion: transaction.db.data
    });
    expect(materializedRowsFor(transaction.db, 'todo-labels-live')).toEqual([
      { id: 'todo-a', label: 'todo:Water basil' }
    ]);
    expect(materializationForQuery(transaction.db, labels)).toMatchObject({
      id: 'todo-labels-live',
      requestedMode: 'incremental',
      maintenance: 'snapshot',
      diagnostics: [{ code: 'materialization_unsupported', surface: 'materialization' }]
    });
  });

  it('returns explicit diagnostics for missing materialization indexes', () => {
    const db = createDb();

    expect(snapshotIndex(db, 'missing-view')).toMatchObject({
      kind: 'materializationIndex',
      id: 'missing-view',
      indexed: false,
      diagnostics: [{ code: 'materialization_missing', surface: 'materialization' }]
    });
    expect(snapshotHashIndex(db, 'missing-view', 'id')).toMatchObject({
      kind: 'materializationHashIndex',
      id: 'missing-view',
      indexed: false,
      diagnostics: [{ code: 'materialization_missing', surface: 'materialization' }]
    });
  });

  it('returns explicit diagnostics when cached rows cannot form a hash index', async () => {
    const db = createDb({
      todos: [{ id: 'todo-a', text: 'Buy oat milk' }]
    });

    await materializeSnapshot(db, todoRows, { id: 'todos-view' });

    expect(snapshotHashIndex(db, 'todos-view', 'missing')).toMatchObject({
      kind: 'materializationHashIndex',
      id: 'todos-view',
      queryKey: queryKey(todoRows),
      indexed: false,
      diagnostics: [
        {
          code: 'materialization_index_unsupported',
          surface: 'materialization',
          detail: { id: 'todos-view', queryKey: queryKey(todoRows), field: 'missing', rowIndex: 0 }
        }
      ]
    });
  });
});
