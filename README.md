# Tarstate

Tarstate is a set of hooks for React (and other libs), that lets you query state trees like a database.
It's a fast, disposable way to glue unrelated data sources together.

Perf and GC is optimized for video games and systems programming.
Work is shared between queries, and is faster than hand-rolled state management at scale.

Tarstate is a TypeScript adaptation of
[wotbrew/relic](https://github.com/wotbrew/relic), after
[Out of the Tar Pit](http://curtclifton.net/papers/MoseleyMarks06a.pdf), with an additional schema protocol and IDE/agentic tooling.

## Schemas

Schemas are JSON-compatible manifests that describe the shape of data.
[Schema specification](./docs/schema-spec.md).

This schema describes pizza sizes, pizzas, optional notes, and toppings.

```json
{
  "kind": "tarstate.schema",
  "formatVersion": 1,
  "schemaId": "example.pizzas@1",
  "description": "Pizza ordering data.",
  "relations": {
    "pizzaSizes": {
      "key": "id",
      "fields": {
        "id": { "type": "id", "domain": "example.pizzaSize" },
        "label": { "type": "string" }
      }
    },
    "pizzas": {
      "key": "id",
      "fields": {
        "id": { "type": "id", "domain": "example.pizza" },
        "name": { "type": "string" },
        "sizeId": {
          "type": "ref",
          "target": { "relation": "pizzaSizes", "field": "id" }
        },
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

Example data under that schema can then seed the available sizes:

```json
{
  "pizzaSizes": [
    { "id": "small", "label": "Small" },
    { "id": "medium", "label": "Medium" },
    { "id": "large", "label": "Large" }
  ]
}
```
