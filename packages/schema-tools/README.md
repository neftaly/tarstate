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
```

Intended consumers:

- TypeScript-aware agents and IDEs use `rows.d.ts`.
- Tarstate schema registries, publishing, and reproducible builds use
  `schema.manifest.json`.
- JSON editors and tool-call boundaries use `json-schema/*.schema.json` for
  relation row validation.

This package does not implement runtime codec behavior, migrations, SQL,
GraphQL, or storage adapters.
