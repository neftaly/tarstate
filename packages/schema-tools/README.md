# @tarstate/schema-tools

Prototype generators for agent and IDE workflows built from
`SchemaManifestV1`.

The package validates and canonicalizes manifests through `@tarstate/core`
before emitting artifacts.

```ts
import { emitSchemaArtifacts } from '@tarstate/schema-tools';

const artifactSet = emitSchemaArtifacts(manifest);
```

Default artifact layout:

```text
schema.manifest.json
rows.d.ts
json-schema/<relation>.schema.json
agent-card.md
examples/<relation>.json
```

Intended consumers:

- TypeScript-aware agents and IDEs use `rows.d.ts`.
- JSON editors and tool-call boundaries use `json-schema/*.schema.json`.
- Prompt-building agents use `agent-card.md`.
- Generation and repair loops use `examples/*.json`.

This package does not implement runtime codec behavior, migrations, SQL,
GraphQL, or storage adapters.
