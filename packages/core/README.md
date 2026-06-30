# Tarstate

Tarstate lets you query JSON-shaped data as rows.

Use it when code needs to combine stored records, assignments, visibility, or
other structured data.

```tsx
import {
  as, evaluate, fromObjectSource, refField, from,
  eq, relation, composeSources, maybe, pipe,
  idField, leftJoin, defineSchema, project, stringField,
} from '@tarstate/core'

// Define todo data and relationships.
const schema = defineSchema({
  todos: relation<{ id: string; text: string }>({
    key: 'id',
    fields: { id: idField('todo'), text: stringField() },
  }),
  assignments: relation<{ todoId: string; assignee: string }>({
    key: 'todoId',
    fields: { todoId: refField('todos.id'), assignee: stringField() },
  }),
})

// Pull in data from separate sources.
const todoSource = fromObjectSource({
  todos: [
    { id: 'todo-a', text: 'Buy oat milk' },
    { id: 'todo-b', text: 'Water basil' },
  ],
})
const teamSource = fromObjectSource({
  assignments: [{ todoId: 'todo-a', assignee: 'Mina' }],
})

// Combine the sources for the query.
const source = composeSources(todoSource, teamSource)

const todo = as(schema.todos, 'todo')
const assignment = as(schema.assignments, 'assignment')

// Build the query.
const todoRows = pipe(
  from(todo), // => [{ todo: { id: 'todo-a', ... } }, { todo: { id: 'todo-b', ... } }]
  // leftJoin appends matches from another query.
  leftJoin(from(assignment), eq(todo.id, assignment.todoId)), // => [{ todo: { id: 'todo-a', ... }, assignment: { assignee: 'Mina', ... } }, { todo: { id: 'todo-b', ... } }]
  // project formats the results nicely.
  project({
    id: todo.id,
    text: todo.text,
    assignedTo: maybe(assignment.assignee),
  }), // => [{ id: 'todo-a', assignedTo: 'Mina', ... }, { id: 'todo-b', assignedTo: undefined, ... }]
)

// Run the query against the current data.
const todos = (await evaluate(source, todoRows)).rows
```

## Package Boundary

`@tarstate/core` is the standalone generic query/data library. Keep package
code independent from application schemas, renderers, adapters, and wrappers.

Consumers should import only package exports:

- `@tarstate/core`
- `@tarstate/core/diagnostics`
- `@tarstate/core/evaluate`
- `@tarstate/core/query`
- `@tarstate/core/schema`
- `@tarstate/core/source`
- `@tarstate/core/write`

Do not import `packages/core/src/*`, `@tarstate/core/src/*`, or any other
source-path package internals.

This is not a publishing lane yet. Keep the package private until all release
criteria are true:

1. The public API has stabilized around the root and taxonomy subpath exports.
2. Independent consumers need the package without app code.
3. Tarstate needs an external release cadence.
4. Package export smoke tests cover every public import path.
