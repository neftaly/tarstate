# @tarstate/schema-tools

Deterministic schema, issue-catalog, and authority-filtered database-description
artifacts for Tarstate v1 tooling and agents.

```ts
import { writeFile } from 'node:fs/promises'
import {
  buildArtifactOutputs,
  describeDatabase,
  generateSchemaOutputs,
} from '@tarstate/schema-tools'

const description = await describeDatabase(database)
const generated = await generateSchemaOutputs(schemaArtifact)

if (!generated.success) throw new Error(generated.issues[0]?.code)
console.log(description.databaseFingerprint)

await Promise.all([
  writeFile('schema.ts', generated.value.typescript),
  writeFile('schema.json', generated.value.jsonSchemaText),
  writeFile('schema.md', generated.value.markdown),
])

const portable = await buildArtifactOutputs({
  artifacts: { workspaceSchema, workspaceMapping },
  declarations: { workspace: workspaceDeclaration },
  relations: {
    task: { schema: 'workspaceSchema', relation: 'tasks' },
  },
})

if (!portable.success) throw new Error(portable.issues[0]?.code)
await Promise.all([
  writeFile('artifacts.json', portable.value.bundleJson),
  writeFile('artifact-bindings.ts', portable.value.bindingsTypeScript),
])
```

`describeDatabase` accepts either an already authority-filtered
`DatabaseDescriptionSnapshot` or an object with
`getDatabaseDescriptionSnapshot()`. It normalizes ordering and duplicate
references before hashing and throws `TarstateParseError` for unavailable or
invalid input. `safeParseDatabaseDescription` validates an already sealed
description without throwing, including its fingerprint and parse budget.

Generated declarations embed the exact schema ID and content hash. Generation
returns a `ParseResult`; invalid or over-budget input does not emit partial
files.

`buildArtifactOutputs` is a pure offline compiler: it performs no filesystem
I/O and has no CLI or application convention. It verifies content hashes,
document declarations, exact dependency closure, and the schema references
embedded by mappings, queries, transactions, constraints, and lenses. The JSON
is canonical; the generated module contains exact refs, relation handles, row
types, and key types without embedding whole schema artifacts at runtime.
`checkArtifactOutputs` compares existing text with a fresh build, while
`safeParseArtifactBuildBundleText` verifies generated or transported JSON at a
trust boundary. Attachment-time preparation still validates and compiles
untrusted document artifacts before use.

Applications that ship a generated bundle can prepare its source-neutral
runtime catalog without importing the offline compiler:

```ts
import { prepareArtifactBundle } from '@tarstate/schema-tools/artifact-bundle'
import bundle from './artifacts.json' with { type: 'json' }
import { artifactDeclarationNames } from './artifact-bindings.js'

const prepared = await prepareArtifactBundle(bundle)
if (!prepared.success) throw new Error(prepared.issues[0]?.code)

const attachment = prepared.value.attachment(
  artifactDeclarationNames.workspace,
)
if (!attachment.success) throw new Error(attachment.issues[0]?.code)
```

The selected attachment contains its validated declaration and the minimal
deterministic ID-keyed artifact closure required by that declaration. The
catalog performs no filesystem I/O and does not import an adapter runtime.
