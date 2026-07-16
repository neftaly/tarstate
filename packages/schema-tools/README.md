# @tarstate/schema-tools

Deterministic schema, issue-catalog, and authority-filtered database-description
artifacts for Tarstate v1 tooling and agents.

Install both downloaded Tarstate tarballs:

```sh
npm install \
  ./tarstate-core-0.4.1.tgz \
  ./tarstate-schema-tools-0.4.1.tgz
```

```ts
import { writeFile } from 'node:fs/promises'
import { describeDatabase, generateSchemaOutputs } from '@tarstate/schema-tools'

const description = await describeDatabase(database)
const generated = await generateSchemaOutputs(schemaArtifact)

if (!generated.success) throw new Error(generated.issues[0]?.code)
console.log(description.databaseFingerprint)

await Promise.all([
  writeFile('schema.d.ts', generated.value.typescript),
  writeFile('schema.json', generated.value.jsonSchemaText),
  writeFile('schema.md', generated.value.markdown),
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
