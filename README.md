# Tarstate

Tarstate is a set of hooks for React (and other libs), that lets you query state trees like a database.
It's a fast, disposable way to glue unrelated data sources together.

Perf and GC is optimized for video games and systems programming.
Work is shared between queries, and is faster than hand-rolled state management at scale.

Tarstate is a TypeScript adaptation of
[wotbrew/relic](https://github.com/wotbrew/relic), after
[Out of the Tar Pit](http://curtclifton.net/papers/MoseleyMarks06a.pdf), with an additional schema protocol and IDE/agentic tooling.

## Development

Use Node.js 24.12 or newer and pnpm 10.33.2. With Corepack:

```sh
corepack enable
pnpm install
pnpm dev
pnpm check
```

The real estate example lives in `apps/real-estate`.

## Schemas

Schemas are JSON-compatible manifests that describe the shape of data.
[Schema specification](./docs/schema-spec.md).

This ordering slice keeps pizza bases, menu pizzas, and toppings as separate
relations.

```json
{
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
}
```
