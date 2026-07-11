# Tarstate

Tarstate is a set of hooks for React (and other libs), that lets you query state trees like a database.
It's a fast, disposable way to glue unrelated data sources together.

Tarstate is **alpha quality** software.

It also generates JSON-serializable schemas, describing your data in terms of relationships, that typescript can read as types. This is different from `json-schema`, and justified by [parse not validate](https://lexi-lambda.github.io/blog/2019/11/05/parse-don-t-validate/). It is intended to support [schema evolution](https://www.inkandswitch.com/cambria/), i.e. so changing your state tree in the future won't break things.

Perf and GC targets systems programming and video games.
Work is shared between queries, and aims to be faster than hand-rolled state management at scale.

Tarstate was heavily inspired by
[wotbrew/relic](https://github.com/wotbrew/relic), after
[Out of the Tar Pit](http://curtclifton.net/papers/MoseleyMarks06a.pdf).

### TS Integration

Generate TypeScript declarations when the schema changes:

```ts
import { writeFile } from 'node:fs/promises';
import { generateSchemaOutputs } from '@tarstate/schema-tools';
import { schema } from './schema';

const generated = await generateSchemaOutputs(schema);
if (!generated.success) throw new Error(generated.issues[0]?.code);

await writeFile('src/generated/tarstate/rows.d.ts', generated.value.typescript);
```

It writes `src/generated/tarstate/rows.d.ts`. Because that file is under
`src`, TypeScript and most IDEs will see the automatic types.

## Schemas

[Schemas](./docs/v1/README.md#identity-storage-and-compatibility) are JSON-compatible manifests that describe the shape of data.

```ts
import { sealSchema, type SchemaBody } from '@tarstate/core';

export const schemaDefinition = {
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
} satisfies { id: string; body: SchemaBody };

export const schema = await sealSchema(schemaDefinition);

export const initialState = {
  bases: [
    { name: 'thin', style: 'Neapolitan' },
    { name: 'pan', style: 'Detroit' }
  ],
  pizzas: [
    { name: 'margherita', base: 'thin', price: 18 },
    { name: 'pepperoni', base: 'thin', price: 21 }
  ],
  toppings: [
    { pizza: 'margherita', name: 'mozzarella', extra: false },
    { pizza: 'margherita', name: 'basil', extra: false },
    { pizza: 'pepperoni', name: 'pepperoni', extra: true }
  ]
}
```

## Queries

Queries are portable values composed with `pipe`. This one joins pizzas to
their bases, sorts the menu by name, and selects the fields the UI needs.

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

Tarstate compiles queries into an incremental view maintenance (IVM) graph, so
that work is shared.
When data changes, it updates only affected operators; joins reuse indexes and
propagation stops when an operator's result is unchanged.

```ts
export const menuSummaryQuery = pipe(
  pizzaMenuQuery,
  // Before this line, this query is free
  aggregate('summary', {}, {
    pizzaCount: { kind: 'aggregate', op: 'count' },
    averagePrice: {
      kind: 'aggregate',
      op: 'average',
      value: field('menu', 'price')
    }
  })
);
```

## React example

```tsx
import { TarstateProvider, useCommit, useQuery } from '@tarstate/react';
import { database, executeCommit, makeDetroitStyle, pizzaMenuPlan } from './tarstate';

export function App() {
  return (
    <TarstateProvider database={database} executeCommit={executeCommit}>
      <PizzaMenu />
    </TarstateProvider>
  );
}

function PizzaMenu() {
  const menu = useQuery(pizzaMenuPlan);
  const commit = useCommit();
  if (menu.state !== 'open') return null;

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
