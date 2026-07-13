# Tarstate

Tarstate is a set of hooks for React (and other libs), that lets you query state trees like a database.
It's a fast, disposable way to glue unrelated data sources together.

Note: Tarstate is **alpha quality** software.

**Requirements:** Node.js 24.12 or newer and a package manager compatible with
your project. From this checkout, run `pnpm install`, `pnpm build`, then
`node examples/quickstart.ts`. Consumers can install the downloaded core release
tarball with `pnpm add ./tarstate-core-0.3.0.tgz`.

Perf and GC targets systems programming and video games.
Work is shared between queries, and aims to be faster than hand-rolled state management at scale.
Adapters are currently provided for Zustand and Automerge.

It also generates JSON-serializable schemas, describing your data in terms of relationships, that TS can read as types. It is intended to support [schema evolution](https://www.inkandswitch.com/cambria/), i.e. so changing your state tree in the future won't break things.

Tarstate was heavily inspired by
[wotbrew/relic](https://github.com/wotbrew/relic), after
[Out of the Tar Pit](http://curtclifton.net/papers/MoseleyMarks06a.pdf).

## Quick start

This complete example defines a schema and query, exposes application state as
a source, projects that source through an attachment, and observes it through a
database. The checked source lives at
[`examples/quickstart.ts`](./examples/quickstart.ts) and runs with the checkout
commands above. In another project, copy it after installing the core release
tarball, then run it with Node.

```ts
import {
  AttachmentCatalog,
  DatabaseView,
  DatasetMembership,
  createIncrementalDatabaseQueryMaintenance,
  prepareTypedQuery,
  prepareManualReadOnlyAttachment,
  relationLiteral,
  sealSchema,
  schemaLiteral,
  typedFrom,
  typedSelect,
  type ObservableSource,
  type RelationInput,
  type SourceSnapshot
} from '@tarstate/core';

const registryFingerprint = 'registry:quickstart';
const authorityFingerprint = 'authority:public';
const datasetId = 'menu';
const sourceId = 'source:pizzas';
const attachmentId = 'attachment:pizzas';

const schemaBody = schemaLiteral({
  relations: {
    pizzas: {
      relationId: 'example.pizza',
      key: ['name'],
      fields: {
        name: { type: { kind: 'string' } },
        price: { type: { kind: 'number' } }
      }
    }
  }
});
const schema = await sealSchema({
  id: 'example.pizza-ordering@1',
  body: schemaBody
});
const schemaView = { id: schema.id, contentHash: schema.contentHash };
const pizzaRows = [
  { name: 'margherita', price: 18 },
  { name: 'pepperoni', price: 21 }
] as const;

const pizzas = relationLiteral(schemaView, schemaBody, 'pizzas');
const pizza = typedFrom(pizzas, 'pizza');
const pizzaMenuQuery = typedSelect(
  pizza,
  'menu',
  aliases => ({
    name: aliases.pizza.row.name,
    price: aliases.pizza.row.price
  })
);

const pizzaMenuPlan = await prepareTypedQuery(pizzaMenuQuery, {
  registryFingerprint,
  authorityFingerprint,
  datasetId
});

type Storage = { readonly pizzas: typeof pizzaRows };
const snapshot = (): SourceSnapshot<Storage> => ({
  sourceId,
  operationEpoch: 'epoch:quickstart',
  basis: { incarnation: 'pizzas:one', revision: 0 },
  state: 'ready',
  freshness: 'current',
  storage: { pizzas: pizzaRows },
  issues: []
});
const source: ObservableSource<Storage> = {
  sourceId,
  snapshot,
  subscribe: () => () => undefined
};

const attachments = new AttachmentCatalog();
const attachmentLease = attachments.attach({
  attachmentId,
  incarnation: 'attachment:pizzas:one',
  sourceId,
  source,
  authorityScope: 'public',
  discoveryEdges: [],
  preparation: prepareManualReadOnlyAttachment<Storage, readonly RelationInput[]>({
    schemaViewIds: [schemaView.id],
    project: current => {
      if (current.storage === undefined) {
        return {
          state: current.state === 'ready' ? 'failed' : current.state,
          issues: current.issues
        };
      }
      return {
        state: 'ready',
        value: [{
          relation: { schemaView, relationId: pizzas.relationId },
          rows: current.storage.pizzas,
          occurrenceIds: current.storage.pizzas.map(row => `pizza:${row.name}`),
          completeness: 'exact',
          sourceId,
          attachmentId,
          basis: current.basis
        }],
        issues: []
      };
    }
  })
});
const membership = new DatasetMembership({
  datasetId,
  state: 'settled',
  members: [{
    attachmentId,
    sourceId,
    expectation: 'required',
    discoveryEdges: []
  }]
});
const database = new DatabaseView({
  authorityScope: 'public',
  authorityFingerprint,
  registryFingerprint,
  attachments,
  datasets: [membership],
  canRead: (viewScope, attachmentScope) => viewScope === attachmentScope,
  createQueryMaintenance: createIncrementalDatabaseQueryMaintenance()
});

const observer = database.observe({ plan: pizzaMenuPlan });
const result = observer.getSnapshot();
if (result.state !== 'open') throw new Error('Quickstart observer closed unexpectedly');
console.log(result.current.rows);

observer.close();
database.close();
attachmentLease.close();
```

Prepared queries are compiled into an Incremental View Maintenance graph. When
data changes, Tarstate updates affected operators and reuses shared work.

## Queries

Queries are portable values. Typed authoring helpers preserve exact result rows
and parameters through preparation and into framework adapters. The quick start
uses a read-only manual projection for clarity; production adapters can prepare
artifact-backed writable attachments instead.

## Schemas

[Schemas](./docs/v1/README.md#identity-storage-and-compatibility) are JSON manifests that describe the shape of data. 
They are different from `json-schema`, and justified by [parse not validate](https://lexi-lambda.github.io/blog/2019/11/05/parse-don-t-validate/). 

Schemas can live alongside (or inside) your data, making versioning almost free:

```ts
import { relationDeclaration, referenceTo, schemaLiteral, sealSchema } from '@tarstate/core';

const bases = relationDeclaration({
  relationId: 'example.base',
  key: ['name'],
  fields: {
    name: { type: { kind: 'string' } },
    style: { type: { kind: 'string' } }
  }
});

const pizzas = relationDeclaration({
  relationId: 'example.pizza',
  key: ['name'],
  fields: {
    name: { type: { kind: 'string' } },
    base: { type: referenceTo(bases) },
    price: { type: { kind: 'number' } }
  }
});

export const schemaBody = schemaLiteral({
  relations: {
    bases,
    pizzas,
    toppings: {
      relationId: 'example.topping',
      key: ['pizza', 'name'],
      fields: {
        pizza: { type: referenceTo(pizzas) },
        name: { type: { kind: 'string' } },
        extra: { type: { kind: 'boolean' } }
      }
    }
  }
});

export const schema = await sealSchema({
  id: 'example.pizza-ordering@1',
  body: schemaBody
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
