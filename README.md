# Tarstate

Tarstate is **Alpha quality** software.

Tarstate is a set of hooks for React (and other libs), that lets you query state trees like a database.
It's a fast, disposable way to glue unrelated data sources together.

It also generates JSON-serializable schemas, describing your data in terms of relationships, that typescript can read as types. This is different from `JSON schema`, which [validates not parses](https://lexi-lambda.github.io/blog/2019/11/05/parse-don-t-validate/). It is intended to support [schema evolution](https://www.inkandswitch.com/cambria/), i.e. so changing your state tree in the future won't break things.

Perf and GC targets systems programming and video games.
Work is shared between queries, and is faster than hand-rolled state management at scale.

Tarstate is a TypeScript adaptation of
[wotbrew/relic](https://github.com/wotbrew/relic), after
[Out of the Tar Pit](http://curtclifton.net/papers/MoseleyMarks06a.pdf), with an additional schema protocol, and IDE/agentic tooling.

## Schemas

[Schemas](./docs/schema-spec.md) are JSON-compatible manifests that describe the shape of data.

```js
import { hydrateSchemaManifest } from '@tarstate/core/schema';

const schema = hydrateSchemaManifest({
  "kind": "tarstate.schema",
  "formatVersion": 1,
  "schemaId": "example.pizza-ordering@1",
  "relations": {
    "bases": { "key": "name", "fields": {
      "name": { "type": "string" },
      "style": { "type": "string" }
    } },
    "pizzas": { "key": "name", "fields": {
      "name": { "type": "string" },
      "base": { "type": "ref", "target": { "relation": "bases", "field": "name" } },
      "price": { "type": "number" }
    } },
    "toppings": { "key": ["pizza", "name"], "fields": {
      "pizza": { "type": "ref", "target": { "relation": "pizzas", "field": "name" } },
      "name": { "type": "string" },
      "extra": { "type": "boolean" } } }
  }
})
```

### TS Integration

Run this command when the schema changes:

```sh
tarstate-schema generate src/schema.manifest.json --out src/generated/tarstate --artifacts typescript
```

It writes `src/generated/tarstate/rows.d.ts`. Because that file is under
`src`, TypeScript and most IDEs will see the automatic types.

## React example

Rendered inside a `TarstateProvider`, this component reads a joined pizza menu
and commits writes through the same store.

```tsx
import { useTarstateMutation, useView } from '@tarstate/react';
import { as, asc, eq, from, join, pipe, select, sort } from '@tarstate/core/query';
import { updateByKey } from '@tarstate/core/write';
import type { RelationRef } from '@tarstate/core/schema';
import type { SchemaRows } from './generated/tarstate/rows';

const relations = schema as {
  readonly [Name in keyof SchemaRows]: RelationRef<SchemaRows[Name]>;
};

const base = as(relations.bases, 'base');
const pizza = as(relations.pizzas, 'pizza');

// Read pizzas with their base style and price.
const pizzaMenu = pipe(
  from(pizza),
  join(from(base), eq(pizza.row.base, base.row.name)),
  sort(asc(pizza.row.name)),
  select({
    base: pizza.row.base,
    name: pizza.row.name,
    style: base.row.style,
    price: pizza.row.price
  })
);

export function App() {
  const menu = useView(pizzaMenu);
  
  const mutation = useTarstateMutation();
  const makeDetroitStyle = (pizzaName: string) =>
    mutation.commit(
      updateByKey(
        relations.pizzas,
        pizzaName,
        { base: 'pan' }
      )
    );

  return (
    <section>
      <h2>Pizza menu</h2>
      <ul>
        {menu.rows.map((row) => (
          <li key={row.name}>
            {row.name} ({row.style}) - ${row.price}
            <button type="button" onClick={() => makeDetroitStyle(row.name)}>
              make Detroit style
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
```
