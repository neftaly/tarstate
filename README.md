# Tarstate

Tarstate is a relational interface for React (and other libraries) that lets
you query local-first state trees like a database. It's a way to glue unrelated
data sources together without hiding their ownership or atomic boundaries.

Tarstate is **alpha quality** software.

It uses JSON-serializable schemas to describe data in terms of relationships
and can generate TypeScript declarations and other deterministic artifacts.
Schemas describe logical data rather than physical storage, which allows
storage mappings and schema lenses to evolve independently.

Incremental maintenance shares work between observers. Performance and GC are
tracked with the repository benchmarks.

Tarstate is inspired by [wotbrew/relic](https://github.com/wotbrew/relic) and
[Out of the Tar Pit](http://curtclifton.net/papers/MoseleyMarks06a.pdf).

## TS integration

`@tarstate/schema-tools` generates TypeScript, JSON Schema, and Markdown from a
prepared schema artifact:

```ts
import { generateSchemaOutputs } from '@tarstate/schema-tools'

const generated = await generateSchemaOutputs(schemaArtifact)
if (!generated.success) throw new Error(generated.issues[0]?.code)

await writeOutputs({
  'schema.d.ts': generated.value.typescript,
  'schema.json': generated.value.jsonSchemaText,
  'schema.md': generated.value.markdown,
})
```

Generated declarations include the exact schema ID and content hash.

## Schemas

Schemas are portable artifacts containing stable relation identities, keys,
references, value domains, and promised edit capabilities.

```ts
import { referenceTo, relationDeclaration, schemaLiteral } from '@tarstate/core'

const bases = relationDeclaration({
  relationId: 'example.base',
  key: ['name'],
  fields: {
    name: { type: { kind: 'string' } },
    style: { type: { kind: 'string' } },
  },
})

export const schema = schemaLiteral({
  relations: {
    bases,
    pizzas: {
      relationId: 'example.pizza',
      key: ['name'],
      fields: {
        name: { type: { kind: 'string' } },
        base: { type: referenceTo(bases) },
        price: { type: { kind: 'integer' } },
      },
    },
  },
})
```

Sources attach to these logical relations through trusted storage bindings.
Automerge documents are the primary durable source; Zustand and similar stores
attach through the generic atomic external-store protocol.

## React example

The React provider borrows a prepared database from the application. Tarstate
then subscribes to immutable query observations from that database.

```tsx
import { TarstateProvider, useQuery } from '@tarstate/react'

function PizzaMenu() {
  const menu = useQuery(pizzaMenuPlan, {
    parameters: { maximumPrice: 25 },
    selectSnapshot: snapshot =>
      snapshot.state === 'open' ? snapshot.current.rows : [],
  })

  return (
    <section>
      <h2>Pizza menu</h2>
      <ul>
        {menu.map(row => (
          <li key={row.name}>
            {row.name} ({row.style}) — ${row.price}
          </li>
        ))}
      </ul>
    </section>
  )
}

root.render(
  <TarstateProvider database={database} executeCommit={executeCommit}>
    <PizzaMenu />
  </TarstateProvider>,
)
```

Queries may span sources, but writes are atomic within one source. Query
observations distinguish exact, lower-bound, and unknown results; commits
return structured receipts instead of hiding conflicts or uncertain outcomes.

## Development

Tarstate requires Node.js 24.12 or newer and uses pnpm.

```sh
pnpm install
pnpm check
```

The [v1 specification](docs/v1/README.md) is the source of truth. Package guides
cover [core](packages/core/README.md),
[Automerge](packages/automerge/README.md),
[Zustand](packages/zustand/README.md),
[React](packages/react/README.md), and
[schema tooling](packages/schema-tools/README.md).
