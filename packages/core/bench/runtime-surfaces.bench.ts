import { bench, describe } from 'vitest';
import {
  validateConstraints,
  check,
  fk,
  req,
  tryTransactConstrained,
  unique
} from '@tarstate/core/experimental/constraints';
import { createDb, tryTransact, type Db } from '@tarstate/core/db';
import {
  maintainMaterializationSnapshots,
  type MaterializationMaintenanceOptions,
  type MaterializationMaintenanceResult,
  materializeSnapshot,
  refreshMaterializationSnapshot
} from '@tarstate/core/experimental/materialization';
import {
  aggregate,
  any,
  as,
  asc,
  avg,
  count,
  desc,
  eq,
  from,
  gt,
  join,
  keyBy,
  max,
  min,
  notAny,
  pipe,
  project,
  sort,
  sum,
  where
} from '@tarstate/core/query';
import { trackTransact } from '@tarstate/core/experimental/runtime';
import { defineSchema, idField, numberField, refField, relation, stringField } from '@tarstate/core/schema';
import { fromObjectSource, type RelationSource } from '@tarstate/core/source';
import { diffQuery, subscribeWatch, watch } from '@tarstate/core/experimental/watch';
import { write } from '@tarstate/core/write';

type Todo = {
  readonly id: string;
  readonly text: string;
  readonly rank: number;
};

type Assignment = {
  readonly id: string;
  readonly todoId: string;
  readonly assignee: string;
};

const schema = defineSchema({
  todos: relation<Todo>({
    key: 'id',
    fields: {
      id: idField('todo'),
      text: stringField(),
      rank: numberField()
    }
  }),
  assignments: relation<Assignment>({
    key: 'id',
    fields: {
      id: idField('assignment'),
      todoId: refField('todos.id'),
      assignee: stringField()
    }
  })
});

const todos = Array.from({ length: 1_000 }, (_, index): Todo => ({
  id: `todo-${index}`,
  text: `Todo ${index}`,
  rank: index
}));

const assignments = todos.map(
  (todo, index): Assignment => ({
    id: `assignment-${index}`,
    todoId: todo.id,
    assignee: index % 2 === 0 ? 'Mina' : 'Noor'
  })
);

const changedTodos = [
  ...todos.slice(0, 500),
  ...todos.slice(510),
  ...Array.from({ length: 10 }, (_, index): Todo => ({
    id: `todo-new-${index}`,
    text: `New todo ${index}`,
    rank: 1_000 + index
  }))
];

const todo = as(schema.todos, 'todo');
const assignment = as(schema.assignments, 'assignment');
const highRankTodos = pipe(
  from(todo),
  where(gt(todo.rank, 500)),
  project({
    id: todo.id,
    text: todo.text,
    rank: todo.rank
  })
);
const keyedHighRankTodos = pipe(highRankTodos, keyBy('id'));
const sortedTodos = pipe(
  from(todo),
  sort(desc(todo.rank), asc(todo.id))
);
const todoAssignments = join(from(assignment), eq(todo.id, assignment.todoId))(from(todo));
const highRankSummary = pipe(
  from(todo),
  where(gt(todo.rank, 500)),
  aggregate({
    aggregates: {
      total: count(),
      textTotal: count(todo.text),
      rankCount: count(todo.rank),
      rankSum: sum(todo.rank),
      averageRank: avg(todo.rank),
      minRank: min(todo.rank),
      maxRank: max(todo.rank),
      hasText: any(todo.text),
      noText: notAny(todo.text)
    }
  })
);

const source = fromObjectSource({ todos, assignments });
const changedSource = fromObjectSource({ todos: changedTodos, assignments });
const constraints = [
  req(schema.todos, 'text'),
  unique(schema.todos, 'id'),
  fk(schema.assignments, 'todoId', schema.todos, 'id')
];
const checkConstraints = [check(from(todo), gt(todo.rank, -1))];
const todoWriter = write(schema.todos);
const assignmentWriter = write(schema.assignments);
const isolatedEqualityJoinMaintenanceIterations = 50;
const isolatedEqualityJoinMaintenanceWarmupIterations = 5;
const isolatedSortedQueryMaintenanceIterations = 50;
const isolatedSortedQueryMaintenanceWarmupIterations = 5;

type EqualityJoinMaintenanceState = {
  readonly previous: Db;
  readonly next: Db;
  readonly options: MaterializationMaintenanceOptions;
};

type SortedQueryMaintenanceState = {
  readonly previous: Db;
  readonly next: Db;
  readonly options: MaterializationMaintenanceOptions;
};

async function prepareEqualityJoinMaintenanceState(): Promise<EqualityJoinMaintenanceState> {
  const previous = createDb({ todos, assignments });

  await materializeSnapshot(previous, todoAssignments, { id: 'todo-assignments', mode: 'incremental' });
  const transaction = tryTransact(previous, [
    assignmentWriter.updateByKey('assignment-750', { assignee: 'Ari' })
  ]);

  if (transaction.diagnostics.length > 0) {
    throw new Error(`equality join maintenance transaction produced ${transaction.diagnostics.length} diagnostic(s)`);
  }

  return {
    previous,
    next: transaction.db,
    options: { deltas: transaction.deltas }
  };
}

async function prepareEqualityJoinMaintenanceStates(count: number): Promise<readonly EqualityJoinMaintenanceState[]> {
  const states: EqualityJoinMaintenanceState[] = [];

  for (let index = 0; index < count; index += 1) {
    states.push(await prepareEqualityJoinMaintenanceState());
  }

  return states;
}

async function prepareSortedQueryMaintenanceState(): Promise<SortedQueryMaintenanceState> {
  const previous = createDb({ todos, assignments });

  await materializeSnapshot(previous, sortedTodos, { id: 'sorted-todos', mode: 'incremental' });
  const transaction = tryTransact(previous, [
    todoWriter.updateByKey('todo-250', { rank: 1_250 })
  ]);

  if (transaction.diagnostics.length > 0) {
    throw new Error(`sorted query maintenance transaction produced ${transaction.diagnostics.length} diagnostic(s)`);
  }

  return {
    previous,
    next: transaction.db,
    options: { deltas: transaction.deltas }
  };
}

async function prepareSortedQueryMaintenanceStates(count: number): Promise<readonly SortedQueryMaintenanceState[]> {
  const states: SortedQueryMaintenanceState[] = [];

  for (let index = 0; index < count; index += 1) {
    states.push(await prepareSortedQueryMaintenanceState());
  }

  return states;
}

function assertIncrementalEqualityJoinMaintenanceResults(
  results: readonly MaterializationMaintenanceResult[]
): void {
  for (const [index, result] of results.entries()) {
    if (result.maintained !== 1 || result.recomputed !== 0 || result.diagnostics.length > 0) {
      throw new Error(
        `equality join maintenance sample ${index} did not stay incremental: ` +
        `${result.maintained} maintained, ${result.recomputed} recomputed, ` +
        `${result.diagnostics.length} diagnostic(s)`
      );
    }
  }
}

function assertIncrementalSortedQueryMaintenanceResults(
  results: readonly MaterializationMaintenanceResult[]
): void {
  if (results.length === 0) {
    return;
  }

  const summary = results.reduce(
    (accumulator, result) => {
      accumulator.maintained += result.maintained;
      accumulator.recomputed += result.recomputed;
      accumulator.carried += result.carried;

      for (const change of result.changes) {
        if (change.update === 'incremental') {
          accumulator.incrementalChanges += 1;
        } else if (change.update === 'recomputed') {
          accumulator.recomputedChanges += 1;
        } else if (change.update === 'carried') {
          accumulator.carriedChanges += 1;
        }

        for (const diagnostic of change.diagnostics) {
          if (diagnostic.code === 'materialization_incremental_fallback') {
            accumulator.fallbackDiagnostics += 1;
          } else if (diagnostic.code === 'materialization_unsupported') {
            accumulator.unsupportedDiagnostics += 1;
          }
        }
      }

      return accumulator;
    },
    {
      maintained: 0,
      recomputed: 0,
      carried: 0,
      incrementalChanges: 0,
      recomputedChanges: 0,
      carriedChanges: 0,
      fallbackDiagnostics: 0,
      unsupportedDiagnostics: 0
    }
  );

  console.info(
    '[runtime-surfaces] sorted query materialization maintenance after setup over 1k rows: ' +
    `${results.length} sample(s), ${summary.incrementalChanges} incremental change(s), ` +
    `${summary.recomputedChanges} recomputed change(s), ${summary.carriedChanges} carried change(s), ` +
    `${summary.fallbackDiagnostics} fallback diagnostic(s), ` +
    `${summary.unsupportedDiagnostics} unsupported diagnostic(s), ` +
    `${summary.maintained} maintained, ${summary.recomputed} recomputed, ${summary.carried} carried`
  );

  if (summary.recomputedChanges > 0 || summary.fallbackDiagnostics > 0 || summary.unsupportedDiagnostics > 0) {
    throw new Error(
      'expected sorted query maintenance benchmark samples to stay incremental after setup, ' +
      `got ${summary.recomputedChanges} recompute(s), ` +
      `${summary.fallbackDiagnostics} fallback diagnostic(s), and ` +
      `${summary.unsupportedDiagnostics} unsupported diagnostic(s)`
    );
  }
}

describe('runtime surfaces', () => {
  bench('validate req + unique + fk over 1k rows', async () => {
    await validateConstraints(source, constraints);
  });

  bench('validate query-bound check over 1k rows', async () => {
    await validateConstraints(source, checkConstraints);
  });

  bench('constrained transaction insert over 1k rows', async () => {
    await tryTransactConstrained(
      createDb({ todos, assignments }),
      [todoWriter.insert({ id: 'todo-extra', text: 'Extra todo', rank: 1_001 })],
      constraints
    );
  });

  bench('snapshot materialization over 1k rows', async () => {
    await materializeSnapshot(createDb({ todos, assignments }), highRankTodos);
  });

  bench('refresh snapshot materialization over changed 1k rows', async () => {
    let sourceRows: readonly Todo[] = todos;
    const refreshSource: RelationSource = {
      rows: (relation) => relation.name === 'todos' ? sourceRows : assignments
    };

    await materializeSnapshot(refreshSource, highRankTodos, { id: 'high-rank' });
    sourceRows = changedTodos;
    await refreshMaterializationSnapshot(refreshSource, 'high-rank');
  });

  bench('incremental aggregate maintenance for count/count(expr)/sum/avg/min/max/any/notAny over 1k rows', async () => {
    const db = createDb({ todos, assignments });

    await materializeSnapshot(db, highRankSummary, { id: 'high-rank-summary', mode: 'incremental' });
    const transaction = tryTransact(db, [
      todoWriter.insert({ id: 'todo-extra', text: 'Extra todo', rank: 1_010 }),
      todoWriter.updateByKey('todo-750', { rank: 760 })
    ]);
    await maintainMaterializationSnapshots(db, transaction.db, { deltas: transaction.deltas });
  });

  bench('incremental equality join materialize + maintain over 1k rows', async () => {
    const db = createDb({ todos, assignments });

    await materializeSnapshot(db, todoAssignments, { id: 'todo-assignments', mode: 'incremental' });
    const transaction = tryTransact(db, [
      assignmentWriter.updateByKey('assignment-750', { assignee: 'Ari' })
    ]);
    await maintainMaterializationSnapshots(db, transaction.db, { deltas: transaction.deltas });
  });

  {
    let stateIndex = 0;
    let states: readonly EqualityJoinMaintenanceState[] = [];
    let results: MaterializationMaintenanceResult[] = [];

    bench('incremental equality join maintenance after setup over 1k rows', async () => {
      const state = states[stateIndex];

      stateIndex += 1;
      if (state === undefined) {
        throw new Error('missing prepared equality join maintenance state');
      }

      results.push(await maintainMaterializationSnapshots(state.previous, state.next, state.options));
    }, {
      iterations: isolatedEqualityJoinMaintenanceIterations,
      time: 0,
      warmupIterations: isolatedEqualityJoinMaintenanceWarmupIterations,
      warmupTime: 0,
      setup: async (_task, mode) => {
        const iterations = mode === 'run'
          ? isolatedEqualityJoinMaintenanceIterations
          : isolatedEqualityJoinMaintenanceWarmupIterations;

        stateIndex = 0;
        results = [];
        // Tinybench probes the task once before collecting samples to detect async functions.
        states = await prepareEqualityJoinMaintenanceStates(iterations + 1);
      },
      teardown: () => {
        assertIncrementalEqualityJoinMaintenanceResults(results);
      }
    });
  }

  {
    let stateIndex = 0;
    let states: readonly SortedQueryMaintenanceState[] = [];
    let results: MaterializationMaintenanceResult[] = [];

    bench('incremental sorted query materialization maintenance after setup over 1k rows', async () => {
      const state = states[stateIndex];

      stateIndex += 1;
      if (state === undefined) {
        throw new Error('missing prepared sorted query maintenance state');
      }

      results.push(await maintainMaterializationSnapshots(state.previous, state.next, state.options));
    }, {
      iterations: isolatedSortedQueryMaintenanceIterations,
      time: 0,
      warmupIterations: isolatedSortedQueryMaintenanceWarmupIterations,
      warmupTime: 0,
      setup: async (_task, mode) => {
        const iterations = mode === 'run'
          ? isolatedSortedQueryMaintenanceIterations
          : isolatedSortedQueryMaintenanceWarmupIterations;

        stateIndex = 0;
        results = [];
        // Tinybench probes the task once before collecting samples to detect async functions.
        states = await prepareSortedQueryMaintenanceStates(iterations + 1);
      },
      teardown: () => {
        assertIncrementalSortedQueryMaintenanceResults(results);
      }
    });
  }

  bench('query diff over changed 1k rows', async () => {
    await diffQuery(source, changedSource, highRankTodos);
  });

  bench('keyed query diff over changed 1k rows', async () => {
    await diffQuery(source, changedSource, keyedHighRankTodos);
  });

  bench('manual watch refresh over changed 1k rows', async () => {
    const handle = watch(source, highRankTodos, () => undefined);

    await handle.refresh();
    await handle.refresh(changedSource);
    handle.unwatch();
  });

  bench('manual watch refresh fan-out to 16 callbacks over changed 1k rows', async () => {
    let deliveries = 0;
    const handle = watch(source, highRankTodos, () => {
      deliveries += 1;
    });
    const subscriptions = Array.from(
      { length: 16 },
      () => subscribeWatch(handle, () => {
        deliveries += 1;
      })
    );

    await handle.refresh();
    await handle.refresh(changedSource);
    for (const subscription of subscriptions) {
      subscription.unsubscribe();
    }
    handle.unwatch();

    if (deliveries !== 34) {
      throw new Error(`watch fan-out delivered ${deliveries} callbacks`);
    }
  });

  bench('track watched transaction over 1k rows', async () => {
    const db = createDb({ todos, assignments });
    const handle = watch(db, highRankTodos, () => undefined);

    await trackTransact(db, (current) =>
      tryTransact(current, [todoWriter.insert({ id: 'todo-extra', text: 'Extra todo', rank: 1_001 })])
    );
    handle.unwatch();
  });

  bench('track direct relation transaction using deltas over 1k rows', async () => {
    const db = createDb({ todos, assignments });
    const handle = watch(db, schema.todos, () => undefined);

    await trackTransact(db, (current) =>
      tryTransact(current, [
        todoWriter.updateByKey('todo-750', { text: 'Todo 750 updated' }),
        todoWriter.deleteByKey('todo-751')
      ])
    );
    handle.unwatch();
  });

  bench('track unrelated transaction with watched query over 1k rows', async () => {
    const db = createDb({ todos, assignments });
    const handle = watch(db, highRankTodos, () => undefined);

    await trackTransact(db, (current) =>
      tryTransact(current, [
        assignmentWriter.insert({ id: 'assignment-extra', todoId: 'todo-1', assignee: 'Ari' })
      ])
    );
    handle.unwatch();
  });

  bench('track transaction maintaining snapshot over 1k rows', async () => {
    const db = createDb({ todos, assignments });

    await materializeSnapshot(db, highRankTodos, { id: 'high-rank' });
    await trackTransact(db, (current) =>
      tryTransact(current, [todoWriter.insert({ id: 'todo-extra', text: 'Extra todo', rank: 1_001 })])
    );
  });

  bench('track unrelated transaction carrying snapshot over 1k rows', async () => {
    const db = createDb({ todos, assignments });

    await materializeSnapshot(db, highRankTodos, { id: 'high-rank' });
    await trackTransact(db, (current) =>
      tryTransact(current, [
        assignmentWriter.insert({ id: 'assignment-extra', todoId: 'todo-1', assignee: 'Ari' })
      ])
    );
  });
});
