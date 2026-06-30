import { bench, describe } from 'vitest';
import {
  validateConstraints,
  check,
  fk,
  req,
  tryTransactConstrained,
  unique
} from '@tarstate/core/constraints';
import { createDb, tryTransact } from '@tarstate/core/db';
import {
  maintainMaterializationSnapshots,
  materializeSnapshot,
  refreshMaterializationSnapshot
} from '@tarstate/core/materialization';
import { aggregate, as, count, from, gt, max, min, pipe, project, sum, where } from '@tarstate/core/query';
import { trackTransact } from '@tarstate/core/runtime';
import { defineSchema, idField, numberField, refField, relation, stringField } from '@tarstate/core/schema';
import { fromObjectSource, type RelationSource } from '@tarstate/core/source';
import { diffQuery, subscribeWatch, watch } from '@tarstate/core/watch';
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
const highRankTodos = pipe(
  from(todo),
  where(gt(todo.rank, 500)),
  project({
    id: todo.id,
    text: todo.text,
    rank: todo.rank
  })
);
const highRankSummary = pipe(
  from(todo),
  where(gt(todo.rank, 500)),
  aggregate({
    aggregates: {
      total: count(),
      rankSum: sum(todo.rank),
      minRank: min(todo.rank),
      maxRank: max(todo.rank)
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

  bench('incremental aggregate maintenance for count/sum/min/max over 1k rows', async () => {
    const db = createDb({ todos, assignments });

    await materializeSnapshot(db, highRankSummary, { id: 'high-rank-summary', mode: 'incremental' });
    const transaction = tryTransact(db, [
      todoWriter.insert({ id: 'todo-extra', text: 'Extra todo', rank: 1_010 }),
      todoWriter.update('todo-750', { rank: 760 })
    ]);
    await maintainMaterializationSnapshots(db, transaction.db, { deltas: transaction.deltas });
  });

  bench('query diff over changed 1k rows', async () => {
    await diffQuery(source, changedSource, highRankTodos);
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
