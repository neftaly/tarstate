# Tarstate

Tarstate is a set of hooks for React (and other libs), that lets you query state trees like a database.
It's a fast, disposable way to glue unrelated data sources together.

Note: Tarstate is **alpha quality** software.

Perf and GC targets systems programming and video games.
Work is shared between queries, and aims to be faster than hand-rolled state management at scale.
Adapters are currently provided for Zustand and Automerge.

It also generates JSON-serializable schemas, describing your data in terms of relationships, that TS can read as types. It is intended to support [schema evolution](https://www.inkandswitch.com/cambria/), i.e. so changing your state tree in the future won't break things.

Tarstate was heavily inspired by
[wotbrew/relic](https://github.com/wotbrew/relic), after
[Out of the Tar Pit](http://curtclifton.net/papers/MoseleyMarks06a.pdf).

## Queries

Queries are portable values. The typed authoring helpers preserve exact result
rows and parameters through preparation and into the UI:

```ts
import {
  prepareTypedQuery,
  typedFrom,
  typedOrderBy,
  typedSelect
} from '@tarstate/core/query/authoring';
import { relationLiteral } from '@tarstate/core/schema';
import { schema } from './schema';

const pizzas = relationLiteral(schema, 'pizzas');
const pizza = typedFrom(pizzas, 'pizza');
const pizzaMenuQuery = typedSelect(
  typedOrderBy(pizza, aliases => [{
    value: aliases.pizza.row.name,
    direction: 'asc'
  }]),
  'menu',
  aliases => ({
    name: aliases.pizza.row.name,
    price: aliases.pizza.row.price
  })
);

const queryScope = {
  registryFingerprint: 'registry:application-v1',
  authorityFingerprint: 'authority:application-v1',
  datasetId: 'primary'
} as const;

export const pizzaMenuPlan = await prepareTypedQuery(pizzaMenuQuery, queryScope);
```

Prepared queries are compiled into an Incremental View Maintenance graph. When
data changes, Tarstate updates affected operators and reuses shared work.

## Schemas

Schemas are JSON manifests that describe the shape and relationships of data.
They are different from `json-schema`, and justified by [parse not validate](https://lexi-lambda.github.io/blog/2019/11/05/parse-don-t-validate/). 

Schemas can live alongside (or inside) your data, making versioning almost free:

```ts
import { sealSchema } from '@tarstate/core/schema';

export const schema = await sealSchema({
  "id": "example.pizza-ordering@1",
  "body": {
    "relations": {
      "bases": {
        "relationId": "example.base",
        "key": ["name"],
        "fields": {
          "name": { "type": { "kind": "string" } },
          "style": { "type": { "kind": "string" } }
        }
      },
      "pizzas": {
        "relationId": "example.pizza",
        "key": ["name"],
        "fields": {
          "name": { "type": { "kind": "string" } },
          "base": { "type": { "kind": "ref", "target": { "relationId": "example.base" } } },
          "price": { "type": { "kind": "number" } }
        }
      },
      "toppings": {
        "relationId": "example.topping",
        "key": ["pizza", "name"],
        "fields": {
          "pizza": { "type": { "kind": "ref", "target": { "relationId": "example.pizza" } } },
          "name": { "type": { "kind": "string" } },
          "extra": { "type": { "kind": "boolean" } }
        }
      }
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

## React hooks

Tarstate can read existing state management through a prepared query while
preserving its inferred row type:

```tsx
import { TarstateProvider, useQuery } from '@tarstate/react';
import { pizzaMenuPlan } from './queries';
import { database } from './tarstate';

export function App() {
  return (
    <TarstateProvider database={database}>
      <PizzaMenu />
    </TarstateProvider>
  );
}

function PizzaMenu() {
  const menu = useQuery(pizzaMenuPlan);
  if (menu.state === 'closed') return null;

  return (
    <section>
      <h2>Pizza menu</h2>
      <ul>
        {menu.current.rows.map((row, index) => (
          <li key={menu.current.resultKeys[index]}>
            {row.name} - ${row.price}
          </li>
        ))}
      </ul>
    </section>
  );
}
```

## TS Integration

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
