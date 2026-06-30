import {
  applyWrites,
  as,
  booleanField,
  defineSchema,
  eq,
  evaluate,
  from,
  fromObjectSource,
  idField,
  leftJoin,
  maybe,
  pipe,
  project,
  refField,
  relation,
  stringField,
  type MutableObjectSourceData,
  type Query,
  type QueryResult,
  write,
  type WriteApplyResult,
  type WritePatch
} from '@tarstate/core';

export type TodoRow = {
  readonly id: string;
  readonly text: string;
  readonly done: boolean;
};

export type WriterRow = {
  readonly id: string;
  readonly name: string;
};

export type TodoWriterRow = {
  readonly todoId: string;
  readonly writerId: string;
};

export type TodoDemoRow = {
  readonly id: string;
  readonly text: string;
  readonly done: boolean;
  readonly writer: string | undefined;
};

export type PatchLogEntry = {
  readonly index: number;
  readonly op: WritePatch['op'];
  readonly relation: string;
  readonly intent: string;
  readonly summary: string;
};

export type WriterActionScenario = {
  readonly title: string;
  readonly description: string;
  readonly actions: readonly {
    readonly intent: string;
    readonly patch: WritePatch;
  }[];
};

export type TarstateDemoSnapshot = {
  readonly schema: readonly {
    readonly name: string;
    readonly key: string;
    readonly fields: readonly string[];
  }[];
  readonly sourceRows: MutableObjectSourceData;
  readonly query: Query<TodoDemoRow>;
  readonly queryResult: QueryResult<TodoDemoRow>;
  readonly writerScenario: WriterActionScenario;
  readonly patches: readonly WritePatch[];
  readonly patchLog: readonly PatchLogEntry[];
  readonly writeResult: WriteApplyResult;
  readonly nextRows: MutableObjectSourceData;
  readonly nextQueryResult: QueryResult<TodoDemoRow>;
};

export const todoSchema = defineSchema({
  todos: relation<TodoRow>({
    key: 'id',
    fields: {
      id: idField('todo'),
      text: stringField(),
      done: booleanField()
    }
  }),
  writers: relation<WriterRow>({
    key: 'id',
    fields: {
      id: idField('writer'),
      name: stringField()
    }
  }),
  todoWriters: relation<TodoWriterRow>({
    key: 'todoId',
    fields: {
      todoId: refField('todos.id'),
      writerId: refField('writers.id')
    }
  })
});

const todo = as(todoSchema.todos, 'todo');
const todoWriter = as(todoSchema.todoWriters, 'todoWriter');
const writer = as(todoSchema.writers, 'writer');

export const todoQuery = pipe(
  from(todo),
  leftJoin(from(todoWriter), eq(todo.id, todoWriter.todoId)),
  leftJoin(from(writer), eq(todoWriter.writerId, writer.id)),
  project({
    id: todo.id,
    text: todo.text,
    done: todo.done,
    writer: maybe(writer.name)
  })
);

export function seedSourceRows(): MutableObjectSourceData {
  return {
    todos: [
      { id: 'todo-a', text: 'Sketch relation schema', done: true },
      { id: 'todo-b', text: 'Evaluate a query over object rows', done: false },
      { id: 'todo-c', text: 'Apply writer patches', done: false }
    ],
    todoWriters: [
      { todoId: 'todo-a', writerId: 'writer-mina' },
      { todoId: 'todo-c', writerId: 'writer-jules' }
    ],
    writers: [
      { id: 'writer-mina', name: 'Mina' },
      { id: 'writer-jules', name: 'Jules' }
    ]
  };
}

export function buildDemoPatches(): readonly WritePatch[] {
  return buildWriterActionScenario().actions.map((action) => action.patch);
}

export function buildWriterActionScenario(): WriterActionScenario {
  const todos = write(todoSchema.todos);
  const todoWriters = write(todoSchema.todoWriters);

  return {
    title: 'Writer batch: finish, add, assign, unassign',
    description: 'A single ordered batch updates one todo, inserts one todo, upserts its writer link, and deletes one stale writer link.',
    actions: [
      {
        intent: 'Mark the object-backed query work complete.',
        patch: todos.update('todo-b', { done: true })
      },
      {
        intent: 'Add a follow-up todo for the next adapter boundary.',
        patch: todos.insert({ id: 'todo-d', text: 'Keep Automerge as a planned adapter', done: false })
      },
      {
        intent: 'Assign the new todo to an existing writer.',
        patch: todoWriters.upsert({ todoId: 'todo-d', writerId: 'writer-mina' })
      },
      {
        intent: 'Remove the stale writer assignment from the patching task.',
        patch: todoWriters.delete('todo-c')
      }
    ]
  };
}

export async function createTarstateDemoSnapshot(): Promise<TarstateDemoSnapshot> {
  const sourceRows = seedSourceRows();
  const queryResult = await evaluate(fromObjectSource(sourceRows), todoQuery);
  const writerScenario = buildWriterActionScenario();
  const patches = writerScenario.actions.map((action) => action.patch);
  const nextRows = cloneRows(sourceRows);
  const writeResult = applyWrites(nextRows, patches);
  const nextQueryResult = await evaluate(fromObjectSource(nextRows), todoQuery);

  return {
    schema: Object.values(todoSchema).map((relationRef) => ({
      name: relationRef.name,
      key: formatRelationKey(relationRef.key),
      fields: Object.keys(relationRef.fields)
    })),
    sourceRows,
    query: todoQuery,
    queryResult,
    writerScenario,
    patches,
    patchLog: writerScenario.actions.map((action, index) => describePatch(action.patch, action.intent, index)),
    writeResult,
    nextRows,
    nextQueryResult
  };
}

function formatRelationKey(key: unknown): string {
  return Array.isArray(key) ? key.join(', ') : String(key);
}

function cloneRows(rows: MutableObjectSourceData): MutableObjectSourceData {
  return Object.fromEntries(Object.entries(rows).map(([name, values]) => [name, values.map((value) => ({ ...(value as Record<string, unknown>) }))]));
}

function describePatch(patch: WritePatch, intent: string, index: number): PatchLogEntry {
  switch (patch.op) {
    case 'insert':
      return { index: index + 1, op: patch.op, relation: patch.relation.name, intent, summary: `insert ${JSON.stringify(patch.row)}` };
    case 'update':
      return { index: index + 1, op: patch.op, relation: patch.relation.name, intent, summary: `update ${JSON.stringify(patch.key)} with ${JSON.stringify(patch.changes)}` };
    case 'upsert':
      return { index: index + 1, op: patch.op, relation: patch.relation.name, intent, summary: `upsert ${JSON.stringify(patch.row)}` };
    case 'delete':
      return { index: index + 1, op: patch.op, relation: patch.relation.name, intent, summary: `delete ${JSON.stringify(patch.key)}` };
  }
}
