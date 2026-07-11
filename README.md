# Tarstate

Tarstate is a set of hooks for React (and other libs), that lets you query state trees like a database.
It's a fast, disposable way to glue unrelated data sources together.

Note: Tarstate is **alpha quality** software.

Perf and GC targets systems programming and video games.
Work is shared between queries, and aims to be faster than hand-rolled state management at scale.
Adaptors are currently provided for Zustand and Automerge.

It also generates JSON-serializable schemas, describing your data in terms of relationships, that TS can read as types. It is intended to support [schema evolution](https://www.inkandswitch.com/cambria/), i.e. so changing your state tree in the future won't break things.

Tarstate was heavily inspired by
[wotbrew/relic](https://github.com/wotbrew/relic), after
[Out of the Tar Pit](http://curtclifton.net/papers/MoseleyMarks06a.pdf).

## Queries

Queries are portable values composed with `pipe`. This one joins pizzas to
their bases, sorts the menu by name, and selects the fields the UI needs:

```ts
import { aggregate, compare, field, from, join, orderBy, pipe, select } from '@tarstate/core';
import { schema } from './schema';

const base = from({ schemaView: schema, relationId: 'example.base' }, 'base');
const pizza = from({ schemaView: schema, relationId: 'example.pizza' }, 'pizza');

export const pizzaMenuQuery = pipe(
  pizza,
  join(base, 'inner', compare(
    'eq',
    field('pizza', 'base'),
    { kind: 'array', items: [field('base', 'name')] }
  )),
  orderBy([{ value: field('pizza', 'name'), direction: 'asc' }]),
  select('menu', {
    name: field('pizza', 'name'),
    style: field('base', 'style'),
    price: field('pizza', 'price')
  })
);
```

Queries are compiled into an Incremental View Maintenance graph, so work is shared.
When data changes, it updates only the affected operators, and processing is reused:

```ts
export const menuSummaryQuery = pipe(
  pizza,
  join(base, 'inner', compare(
    'eq',
    field('pizza', 'base'),
    { kind: 'array', items: [field('base', 'name')] }
  )),
  // --- The query is free before this line ---
  aggregate('summary', {}, {
    pizzaCount: { kind: 'aggregate', op: 'count' },
    averagePrice: {
      kind: 'aggregate',
      op: 'average',
      value: field('pizza', 'price')
    }
  })
);
```

## Schemas

[Schemas](./docs/v1/README.md#identity-storage-and-compatibility) are JSON manifests that describe the shape of data. 
They are different from `json-schema`, and justified by [parse not validate](https://lexi-lambda.github.io/blog/2019/11/05/parse-don-t-validate/). 

Schemas can live alongside (or inside) your data, making versioning almost free:

```ts
import { sealSchema } from '@tarstate/core';

export const schema = await sealSchema({
  "id": "example.pizza-ordering@1",
  "body": {
    "relations": {
    "bases": { "relationId": "example.base", "key": ["name"], "fields": {
      "name": { "type": { "kind": "string" } },
      "style": { "type": { "kind": "string" } }
    } },
    "pizzas": { "relationId": "example.pizza", "key": ["name"], "fields": {
      "name": { "type": { "kind": "string" } },
      "base": { "type": { "kind": "ref", "target": { "relationId": "example.base" } } },
      "price": { "type": { "kind": "number" } }
    } },
    "toppings": { "relationId": "example.topping", "key": ["pizza", "name"], "fields": {
      "pizza": { "type": { "kind": "ref", "target": { "relationId": "example.pizza" } } },
      "name": { "type": { "kind": "string" } },
      "extra": { "type": { "kind": "boolean" } } } }
    }
  }
});

export const initialState = {
  bases: [
    { name: 'thin', style: 'Neapolitan' },
    { name: 'pan', style: 'Detroit' }
  ],
  pizzas: [
    { name: 'margherita', base: ['thin'], price: 18 },
    { name: 'pepperoni', base: ['thin'], price: 21 }
  ],
  toppings: [
    { pizza: ['margherita'], name: 'mozzarella', extra: false },
    { pizza: ['margherita'], name: 'basil', extra: false },
    { pizza: ['pepperoni'], name: 'pepperoni', extra: true }
  ]
}
```

### TS Integration

Schemas should be your source-of-truth for types. You can generate TypeScript declarations whenever they change:

```ts
import { writeFile } from 'node:fs/promises';
import { generateSchemaOutputs } from '@tarstate/schema-tools';
import { schema } from './schema';

const generated = await generateSchemaOutputs(schema);
if (!generated.success) throw new Error(generated.issues[0]?.code);

await writeFile('src/generated/tarstate/rows.d.ts', generated.value.typescript);
```

This script writes `src/generated/tarstate/rows.d.ts`. As it's in `src`, TypeScript and most IDEs will see the automatic types.

## React hooks

Tarstate can read and write existing state management, making views more consise, and actions easier to reason about:

```tsx
import { TarstateProvider, useCommit, useQuery } from '@tarstate/react';
import { database, executeCommit } from './tarstate';

export function App() {
  return (
    <TarstateProvider database={database} executeCommit={executeCommit}>
      <PizzaMenu />
    </TarstateProvider>
  );
}

function PizzaMenu() {
  const menu = useQuery(pizzaMenuQuery); // TODO: Check works
  const commit = useCommit();
  // const makeDetroitStyle = ...

  return (
    <section>
      <h2>Pizza menu</h2>
      <ul>
        {menu.current.rows.map((row, index) => (
          <li key={menu.current.resultKeys[index]}>
            {row.name} ({row.style}) - ${row.price}
            <button type="button" onClick={() => void commit(makeDetroitStyle(row.name))}>
              make Detroit style
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
```
