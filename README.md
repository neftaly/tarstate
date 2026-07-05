# Tarstate

Tarstate is a set of hooks for React (and other languages), that lets you query your state trees like a database.
It's a fast, disposable way to glue unrelated data sources together.

Work is shared between queries, and is faster than hand-rolled state management at scale.
Perf and GC is optimized for video games and systems programming.

Tarstate is a TypeScript adaptation of
[wotbrew/relic](https://github.com/wotbrew/relic), after
[Out of the Tar Pit](http://curtclifton.net/papers/MoseleyMarks06a.pdf). 

## Schemas

Schemas are JSON-compatible manifests that describe the shape of data.
[Schema specification](./docs/schema-spec.md).

This schema describes pizzas with names, sizes, optional notes, and toppings.
The `size` field is a string because enum fields are not part of the v1 schema
manifest.

```json
{
  "kind": "tarstate.schema",
  "formatVersion": 1,
  "schemaId": "example.pizzas@1",
  "description": "Pizza ordering data.",
  "relations": {
    "pizzas": {
      "key": "id",
      "fields": {
        "id": { "type": "id", "domain": "pizza" },
        "name": { "type": "string" },
        "size": { "type": "string" },
        "notes": { "type": "string", "optional": true }
      }
    },
    "toppings": {
      "key": ["pizzaId", "name"],
      "fields": {
        "pizzaId": {
          "type": "ref",
          "target": { "relation": "pizzas", "field": "id" }
        },
        "name": { "type": "string" },
        "extra": { "type": "boolean" }
      }
    }
  }
}
```

Use schemas for:

- durable app state docs
- runtime projections
- intent payload relation sets
- presence, failure, and diagnostic relation streams
- app manifest advertised state contracts

Don't use schemas for:

- capability authorization
- policy decisions
- local UI-only state that never crosses a boundary
- executable validation logic
- changing every Automerge update
