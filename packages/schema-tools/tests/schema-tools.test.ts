import { describe, expect, it } from 'vitest';
import {
  issueCatalog,
  type CapabilityRef,
  type JsonValue
} from '@tarstate/core';
import { sealSchema, sealStorageMapping, type SchemaBody } from '@tarstate/core/schema';
import {
  buildArtifactOutputs,
  checkArtifactOutputs,
  createIssueCodeCatalogArtifact,
  describeDatabase,
  generateSchemaOutputs,
  issueCodeCatalogRef,
  safeParseDatabaseDescription,
  safeParseDatabaseDescriptionText,
  safeParseArtifactBuildBundleText,
  safeParseIssueCodeCatalog,
  safePrepareSchemaArtifact,
  schemaToolsIssueDeclarations,
  type DatabaseDescriptionSnapshot,
  type DatabaseDescriptionBudget
} from '../src/index.js';

const hash = (character: string) => `sha256:${character.repeat(64)}` as const;
const edit: CapabilityRef = { id: 'urn:test:edit', version: '1', contractHash: hash('a') };
const missing: CapabilityRef = { id: 'urn:test:missing', version: '1', contractHash: hash('b') };

const schemaBody = (reverse = false): SchemaBody => {
  const entries = [
    ['players', {
      relationId: 'urn:test:players',
      key: ['id'],
      description: 'Leaderboard players',
      fields: {
        id: { type: { kind: 'integer' as const }, description: 'Stable player key' },
        nickname: { type: { kind: 'string' as const }, optional: true },
        status: { type: { kind: 'string' as const, values: ['active', 'retired'] }, nullable: true },
        joinedAt: { type: { kind: 'instant' as const, precision: 'millisecond' as const } }
      }
    }],
    ['scores', {
      relationId: 'urn:test:scores',
      key: ['player', 'round'],
      fields: {
        player: { type: { kind: 'ref' as const, target: { relationId: 'urn:test:players' } } },
        round: { type: { kind: 'integer' as const } },
        score: { type: { kind: 'decimal' as const } },
        payload: { type: { kind: 'json' as const }, optional: true, nullable: true }
      }
    }]
  ] as const;
  return { description: 'Leaderboard', relations: Object.fromEntries(reverse ? [...entries].reverse() : entries) };
};

const schemaArtifact = async (reverse = false) => sealSchema({ id: 'urn:test:leaderboard', body: schemaBody(reverse) });

const databaseInput = async (): Promise<DatabaseDescriptionSnapshot> => {
  const schema = await schemaArtifact();
  const catalog = await createIssueCodeCatalogArtifact();
  return {
    registryFingerprint: hash('c'),
    basis: {
      dataset: { datasetId: 'dataset:visible', revision: 3 },
      attachments: [{ attachmentId: 'attachment:visible', sourceId: 'source:visible', basis: { incarnation: 'one', revision: 8 } }]
    },
    datasets: [{ datasetId: 'dataset:visible', revision: 3, state: 'settled', attachmentIds: ['attachment:visible', 'attachment:visible'] }],
    relations: [{
      schema: { id: schema.id, contentHash: schema.contentHash, locations: ['https://physical.example/schema'] },
      relationId: 'urn:test:players',
      localName: 'players',
      attachmentId: 'attachment:visible',
      readable: true,
      editCapabilities: [edit, edit],
      missingCapabilities: [missing]
    }],
    commands: [{ id: 'tarstate.command.commit', input: { kind: 'record', fields: { operationId: { kind: 'string' } } }, resultKind: 'tarstate.commit-receipt', resultVersion: 1 }],
    capabilityImplications: [{ provided: edit, implies: missing }],
    issueCodeCatalog: issueCodeCatalogRef(catalog)
  };
};

describe('schema outputs', () => {
  it('validates the exact artifact hash before generating deterministic declarations', async () => {
    const first = await schemaArtifact();
    const second = await schemaArtifact(true);
    expect(first.contentHash).toBe(second.contentHash);
    const generatedA = await generateSchemaOutputs(first);
    const generatedB = await generateSchemaOutputs(second);
    expect(generatedA.success).toBe(true);
    expect(generatedB.success).toBe(true);
    if (!generatedA.success || !generatedB.success) throw new Error('generation failed');
    expect(generatedA.value).toEqual(generatedB.value);
    expect(generatedA.value.typescript).toContain('Content hash: ' + first.contentHash);
    expect(generatedA.value.typescript).toContain('readonly nickname?: string;');
    expect(generatedA.value.typescript).toContain('export type ScoresKey = readonly [PlayersKey, number];');
    expect(generatedA.value.jsonSchema).toMatchObject({
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      'x-tarstate-schema-ref': { id: first.id, contentHash: first.contentHash }
    });
    expect(generatedA.value.jsonSchemaText.endsWith('\n')).toBe(true);
    expect(generatedA.value.markdown).toContain('| `nickname` | `string` | yes | no |');

    const stale = { ...first, contentHash: hash('f') };
    await expect(safePrepareSchemaArtifact(stale)).resolves.toMatchObject({ success: false, issues: [{ code: 'artifact.hash_mismatch' }] });
  });

  it('keeps nullable and optional independent in TypeScript and JSON Schema', async () => {
    const generated = await generateSchemaOutputs(await schemaArtifact());
    if (!generated.success) throw new Error('generation failed');
    expect(generated.value.typescript).toContain('readonly status: "active" | "retired" | null;');
    const root = generated.value.jsonSchema as Readonly<Record<string, JsonValue>>;
    const definitions = root.$defs as Readonly<Record<string, JsonValue>>;
    expect(definitions.PlayersRow).toMatchObject({ required: ['id', 'joinedAt', 'status'] });
  });

  it('escapes generated comments and markdown without inventing impossible enum types', async () => {
    const artifact = await sealSchema({ id: 'urn:test:hostile-docs', body: {
      description: 'Title # <tag>\nnext',
      relations: {
        'odd#name': {
          relationId: 'urn:test:`players|x',
          description: 'Break */ then **format**',
          key: ['id`'],
          fields: { 'id`': { type: { kind: 'string' }, description: 'a | b' } }
        }
      }
    } });
    const generated = await generateSchemaOutputs(artifact);
    if (!generated.success) throw new Error('generation failed');
    expect(generated.value.typescript).toContain('Break * / then **format**');
    expect(generated.value.markdown).toContain('# Title \\# \\<tag\\> next');
    expect(generated.value.markdown).toContain('## odd\\#name');
    expect(generated.value.markdown).toContain('`` id` ``');
    expect(generated.value.markdown).toContain('a \\| b');

    const emptyEnum = await sealSchema({ id: 'urn:test:empty-enum', body: {
      relations: { invalid: { relationId: 'urn:test:invalid', key: ['id'], fields: { id: { type: { kind: 'string', values: [] } } } } }
    } });
    await expect(safePrepareSchemaArtifact(emptyEnum)).resolves.toMatchObject({ success: false, issues: [{ code: 'schema.field_invalid', details: { reason: 'empty_enum' } }] });
  });
});

describe('portable artifact builds', () => {
  const manifest = async (reverse = false) => {
    const schema = await schemaArtifact(reverse);
    const mapping = await sealStorageMapping({
      id: 'urn:test:leaderboard:mapping',
      dependencies: [{ id: schema.id, contentHash: schema.contentHash }],
      body: {
        schema: { id: schema.id, contentHash: schema.contentHash },
        model: 'json-tree-v1',
        relations: {
          'urn:test:players': {
            collection: { kind: 'object-map', path: ['players'], absent: 'empty' },
            keys: { id: { kind: 'map-key', onMismatch: 'reject' } },
            fields: {
              nickname: { path: ['nickname'], write: { kind: 'read-only' } },
              status: { path: ['status'], write: { kind: 'read-only' } },
              joinedAt: { path: ['joinedAt'], write: { kind: 'read-only' } }
            }
          }
        }
      }
    });
    const artifacts = reverse
      ? { leaderboardMapping: mapping, leaderboardSchema: schema }
      : { leaderboardSchema: schema, leaderboardMapping: mapping };
    return {
      artifacts,
      declarations: {
        leaderboard: {
          formatVersion: 1 as const,
          storageSchema: { id: schema.id, contentHash: schema.contentHash },
          projection: {
            kind: 'storage-mapping' as const,
            storageMapping: { id: mapping.id, contentHash: mapping.contentHash }
          }
        }
      },
      relations: {
        player: { schema: 'leaderboardSchema', relation: 'players' }
      }
    };
  };

  it('emits deterministic closed JSON and exact relation bindings from typed authoring', async () => {
    const first = await buildArtifactOutputs(await manifest());
    const second = await buildArtifactOutputs(await manifest(true));
    expect(first.success).toBe(true);
    expect(second.success).toBe(true);
    if (!first.success || !second.success) throw new Error('artifact build failed');
    expect(first.value).toEqual(second.value);
    expect(first.value.bindingsTypeScript).toContain(
      "import type { LiteralRelation, SchemaKey, SchemaRow } from '@tarstate/core/schema';"
    );
    expect(first.value.bindingsTypeScript).toContain('export const playerRelation = {');
    expect(first.value.bindingsTypeScript).toContain('export type PlayerRow = SchemaRow<');
    expect(first.value.bindingsTypeScript).not.toContain(' as Schema');
    expect(first.value.bundleJson.endsWith('\n')).toBe(true);
    await expect(safeParseArtifactBuildBundleText(first.value.bundleJson)).resolves.toEqual({
      success: true,
      value: first.value.bundle,
      issues: []
    });
    await expect(checkArtifactOutputs(await manifest(), first.value)).resolves.toMatchObject({ success: true });
    await expect(checkArtifactOutputs(await manifest(), {
      ...first.value,
      bindingsTypeScript: first.value.bindingsTypeScript + '// stale\n'
    })).resolves.toMatchObject({
      success: false,
      issues: [{ code: 'schema_tools.artifact_build_stale', details: { outputs: ['bindingsTypeScript'] } }]
    });
  });

  it('rejects tampering, missing semantic references, and conflicting artifact IDs', async () => {
    const built = await buildArtifactOutputs(await manifest());
    if (!built.success) throw new Error('artifact build failed');
    const tampered = JSON.parse(built.value.bundleJson) as {
      artifacts: { body: { description?: string } }[];
    };
    tampered.artifacts[0]!.body.description = 'tampered';
    await expect(safeParseArtifactBuildBundleText(JSON.stringify(tampered))).resolves.toMatchObject({
      success: false,
      issues: [{ code: 'artifact.hash_mismatch' }]
    });

    const complete = await manifest();
    await expect(buildArtifactOutputs({ artifacts: {
      leaderboardMapping: complete.artifacts.leaderboardMapping
    } })).resolves.toMatchObject({
      success: false,
      issues: [{ code: 'schema_tools.artifact_build_invalid', details: { reason: 'closure' } }]
    });

    const conflicting = await sealSchema({
      id: 'urn:test:leaderboard',
      body: { relations: { other: {
        relationId: 'urn:test:other',
        key: ['id'],
        fields: { id: { type: { kind: 'string' } } }
      } } }
    });
    await expect(buildArtifactOutputs({ artifacts: {
      original: complete.artifacts.leaderboardSchema,
      conflicting
    } })).resolves.toMatchObject({
      success: false,
      issues: [{ code: 'schema_tools.artifact_build_invalid', details: { reason: 'conflicting_artifact_id' } }]
    });
  });
});

describe('issue catalog', () => {
  it('seals every public issue code into a deterministic, machine-readable artifact', async () => {
    const first = await createIssueCodeCatalogArtifact({ descriptions: { 'artifact.invalid_json': 'Malformed JSON text.' } });
    const second = await createIssueCodeCatalogArtifact({ descriptions: { 'artifact.invalid_json': 'Malformed JSON text.' } });
    expect(first).toEqual(second);
    expect(Object.keys(first.body.codes)).toEqual([...new Set([...issueCatalog.keys(), ...schemaToolsIssueDeclarations.map(({ code }) => code)])].sort());
    expect(first.body.codes['artifact.invalid_json']).toMatchObject({ phase: 'parse', retry: ['after_input'], description: 'Malformed JSON text.' });
    await expect(safeParseIssueCodeCatalog(first)).resolves.toMatchObject({ success: true, value: first });
    await expect(safeParseIssueCodeCatalog({ ...first, contentHash: hash('f') })).resolves.toMatchObject({ success: false, issues: [{ code: 'schema_tools.issue_catalog_hash_mismatch' }] });
    await expect(createIssueCodeCatalogArtifact({ descriptions: { 'typo.unknown': 'Ignored before this boundary was strict.' } })).rejects.toThrow(/unknown issue code/);
    await expect(createIssueCodeCatalogArtifact({ id: '' })).rejects.toThrow(/must not be empty/);

    const entry = first.body.codes['artifact.invalid_json'];
    if (entry === undefined) throw new Error('fixture issue missing');
    const duplicateRetry = { ...first, body: { codes: { ...first.body.codes, 'artifact.invalid_json': { ...entry, retry: ['after_input', 'after_input'] } } } };
    await expect(safeParseIssueCodeCatalog(duplicateRetry)).resolves.toMatchObject({ success: false, issues: [{ code: 'schema_tools.issue_catalog_invalid' }] });
  });
});

describe('database descriptions', () => {
  it('normalizes visible facts, strips locations, computes an exact fingerprint, and round-trips', async () => {
    const description = await describeDatabase(await databaseInput());
    expect(description.kind).toBe('tarstate.database-description');
    expect(description.datasets[0]?.attachmentIds).toEqual(['attachment:visible']);
    expect(description.relations[0]).toMatchObject({ schema: { id: 'urn:test:leaderboard' }, editCapabilities: [edit] });
    expect(description.relations[0]?.schema).not.toHaveProperty('locations');
    expect(Object.isFrozen(description)).toBe(true);
    expect(Object.isFrozen(description.relations)).toBe(true);
    await expect(safeParseDatabaseDescription(description)).resolves.toMatchObject({ success: true, value: description });

    const changed = await describeDatabase({ ...(await databaseInput()), basis: { dataset: { datasetId: 'dataset:visible', revision: 4 }, attachments: [] } });
    expect(changed.databaseFingerprint).not.toBe(description.databaseFingerprint);
  });

  it('describes a database through its explicit authority-filtered snapshot seam', async () => {
    const input = await databaseInput();
    const description = await describeDatabase({ getDatabaseDescriptionSnapshot: () => input });
    expect(description).toMatchObject({ kind: 'tarstate.database-description', basis: input.basis });
    await expect(describeDatabase({ getDatabaseDescriptionSnapshot: () => undefined })).rejects.toMatchObject({ issues: [{ code: 'schema_tools.database_description_unavailable', phase: 'resolve', retry: 'after_refresh' }] });
    await expect(describeDatabase({ getDatabaseDescriptionSnapshot: () => { throw new Error('host failed'); } })).rejects.toMatchObject({ issues: [{ code: 'schema_tools.database_description_unavailable', phase: 'resolve', retry: 'after_refresh' }] });
    await expect(describeDatabase({ getDatabaseDescriptionSnapshot: () => ({ ...input, basis: null }) })).rejects.toMatchObject({ issues: [{ code: 'schema_tools.database_description_invalid' }] });
  });

  it('rejects tampering, hidden physical fields, duplicate JSON members, and bounded overflow', async () => {
    const description = await describeDatabase(await databaseInput());
    await expect(safeParseDatabaseDescription({ ...description, registryFingerprint: hash('d') })).resolves.toMatchObject({ success: false, issues: [{ code: 'schema_tools.database_description_hash_mismatch' }] });
    const leaked = { ...description, relations: [{ ...description.relations[0], locator: ['secret', 1] }] };
    await expect(safeParseDatabaseDescription(leaked)).resolves.toMatchObject({ success: false, issues: [{ code: 'schema_tools.database_description_invalid' }] });
    const text = JSON.stringify(description).replace('"kind":"tarstate.database-description"', '"kind":"tarstate.database-description","kind":"tarstate.database-description"');
    await expect(safeParseDatabaseDescriptionText(text)).resolves.toMatchObject({ success: false, issues: [{ code: 'artifact.duplicate_member' }] });

    const budget: DatabaseDescriptionBudget = {
      maxBytes: 2_000_000,
      maxDepth: 64,
      maxArrayMembers: 100_000,
      maxObjectMembers: 100_000,
      maxTotalMembers: 500_000,
      maxDependencies: 1,
      maxDatasets: 0,
      maxRelations: 100,
      maxCommands: 10,
      maxCapabilities: 100,
      maxAttachmentReferences: 100
    };
    await expect(safeParseDatabaseDescription(description, budget)).resolves.toMatchObject({ success: false, issues: [{ code: 'artifact.budget_exceeded', details: { budget: 'maxDatasets' } }] });
  });

  it('contains only authority-visible input and no privileged execution surface', async () => {
    const input = await databaseInput();
    const description = await describeDatabase({ ...input, relations: input.relations.filter(({ attachmentId }) => attachmentId === 'attachment:visible') });
    const serialized = JSON.stringify(description);
    expect(serialized).not.toContain('physical.example');
    expect(serialized).not.toContain('authorityToken');
    expect(Object.keys(description.commands[0] ?? {})).toEqual(['id', 'input', 'resultKind', 'resultVersion']);
  });
});
