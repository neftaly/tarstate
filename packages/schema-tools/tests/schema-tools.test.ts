import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, expectTypeOf, it } from 'vitest';
import * as schemaTools from '@tarstate/schema-tools';
import {
  emitSchemaArtifacts,
  type EmitSchemaArtifactsOptions,
  type SchemaArtifactKind,
  type SchemaArtifactSet
} from '@tarstate/schema-tools';
import { isDirectCliRun, runCli } from '@tarstate/schema-tools/cli';
import { emitJsonSchemas } from '../src/json-schema.js';
import { emitTypeScriptRows } from '../src/typescript.js';
import {
  customField,
  defineSchema,
  idField,
  jsonField,
  nullable,
  numberField,
  optional,
  refField,
  relation,
  stringEnumField,
  stringField,
  toSchemaManifest,
  type FieldSpec,
  type SchemaManifestV1
} from '@tarstate/core/schema';

type Customer = {
  readonly id: string;
  readonly email: string;
  readonly archivedAt: string | null;
  readonly displayName?: string | null;
};
type Order = {
  readonly id: string;
  readonly customerId: string;
  readonly status: 'draft' | 'paid';
  readonly total: number;
  readonly attachment: unknown;
  readonly metadata?: readonly string[];
};

const shopSchema = defineSchema({
  customers: relation<Customer>({
    key: 'id',
    fields: {
      id: idField('shop.customer'),
      email: stringField(),
      archivedAt: nullable(stringField()),
      displayName: optional(nullable(stringField()))
    }
  }),
  orders: relation<Order>({
    key: 'id',
    fields: {
      id: idField('shop.order'),
      customerId: refField({ relation: 'customers', field: 'id' }),
      status: stringEnumField(['draft', 'paid'] as const),
      total: customField<number>({ codec: 'shop.money', toScalar: (value) => typeof value === 'number' ? value : null }),
      attachment: customField('shop.blob'),
      metadata: optional(jsonField() as FieldSpec<readonly string[]>)
    }
  }),
  orderLines: relation<{ readonly orderId: string; readonly sku: string; readonly quantity: number }, readonly ['orderId', 'sku']>({
    key: ['orderId', 'sku'] as const,
    fields: {
      orderId: refField({ relation: 'orders', field: 'id' }),
      sku: stringField(),
      quantity: numberField()
    }
  })
});

const shopManifest = toSchemaManifest(shopSchema, {
  schemaId: 'shop@1',
  codecs: {
    'shop.blob': {},
    'shop.money': { scalar: 'number' }
  }
});
const execFileAsync = promisify(execFile);

describe('schema tools artifacts', () => {
  it('keeps the package root API focused on artifact emission', () => {
    expect(Object.keys(schemaTools)).toEqual(['emitSchemaArtifacts']);
  });

  it('keeps artifact options and results readonly at the type boundary', () => {
    const selectedArtifacts = ['typescript', 'json-schema'] as const satisfies readonly SchemaArtifactKind[];
    const options = { artifacts: selectedArtifacts } satisfies EmitSchemaArtifactsOptions;
    const artifactSet = emitSchemaArtifacts(shopManifest, options);

    expectTypeOf(artifactSet).toEqualTypeOf<SchemaArtifactSet>();
    expect(artifactSet.artifacts.map((artifact) => artifact.path)).toEqual([
      'rows.d.ts',
      'json-schema/customers.schema.json',
      'json-schema/orderLines.schema.json',
      'json-schema/orders.schema.json'
    ]);
  });

  it('emits TypeScript row types for IDE and coding-agent feedback', () => {
    const output = emitTypeScriptRows(shopManifest);

    expect(output).toContain('export type CustomersRow = {');
    expect(output).toContain('export type NonNullJsonValue = Exclude<JsonPrimitive, null> | readonly JsonValue[] | { readonly [key: string]: JsonValue };');
    expect(output).toContain('readonly archivedAt: string | null;');
    expect(output).toContain('readonly displayName?: string | null;');
    expect(output).toContain('export type ShopBlobValue = unknown;');
    expect(output).toContain('export type ShopMoneyValue = unknown;');
    expect(output).toContain('readonly attachment: ShopBlobValue;');
    expect(output).toContain('readonly status: "draft" | "paid";');
    expect(output).toContain('readonly total: ShopMoneyValue;');
    expect(output).toContain('readonly metadata?: NonNullJsonValue;');
    expect(output).toContain('export type OrderLinesKey = readonly [OrderLinesRow["orderId"], OrderLinesRow["sku"]];');
    expect(output).toContain('export type SchemaRows = {');
    expect(output).toContain('readonly orders: OrdersRow;');
    expect(output).toContain('export type SchemaKeys = {');
    expect(output).toContain('readonly orders: OrdersKey;');
  });

  it('emits strict JSON Schemas with Tarstate extensions for refs and codecs', () => {
    const schemas = emitJsonSchemas(shopManifest);
    const orderSchema = schemas.orders;

    expect(orderSchema?.additionalProperties).toBe(false);
    expect(orderSchema?.required).toEqual(['attachment', 'customerId', 'id', 'status', 'total']);
    expect(orderSchema?.properties).toEqual(expect.objectContaining({
      attachment: expect.objectContaining({
        not: { type: 'null' },
        'x-tarstate-codec': 'shop.blob'
      }),
      customerId: expect.objectContaining({
        type: 'string',
        'x-tarstate-ref': 'customers.id',
        'x-tarstate-ref-target': { relation: 'customers', field: 'id' }
      }),
      status: expect.objectContaining({
        type: 'string',
        enum: ['draft', 'paid']
      }),
      total: expect.objectContaining({
        type: 'number',
        'x-tarstate-codec': 'shop.money',
        'x-tarstate-codec-scalar': 'number'
      })
    }));
    expect(schemas.customers?.properties).toEqual(expect.objectContaining({
      displayName: expect.objectContaining({ type: ['string', 'null'] })
    }));

    const nullScalarManifest = {
      kind: 'tarstate.schema',
      formatVersion: 1,
      schemaId: 'null-scalar@1',
      codecs: { 'shop.deletedMarker': { scalar: 'null' } },
      relations: {
        rows: {
          key: 'id',
          fields: {
            id: { type: 'string' },
            marker: { type: 'custom', codec: 'shop.deletedMarker' },
            nullableMarker: { type: 'custom', codec: 'shop.deletedMarker', nullable: true }
          }
        }
      }
    } satisfies SchemaManifestV1;
    expect(emitJsonSchemas(nullScalarManifest).rows?.properties).toEqual(expect.objectContaining({
      marker: expect.objectContaining({ type: 'null', 'x-tarstate-codec-scalar': 'null' }),
      nullableMarker: expect.objectContaining({ type: 'null', 'x-tarstate-codec-scalar': 'null' })
    }));
  });

  it('builds the default schema artifact layout', () => {
    const artifactSet = emitSchemaArtifacts(shopManifest);

    expect(artifactSet.artifacts.map((artifact) => artifact.path)).toEqual([
      'schema.manifest.json',
      'rows.d.ts',
      'json-schema/customers.schema.json',
      'json-schema/orderLines.schema.json',
      'json-schema/orders.schema.json'
    ]);
    expect(artifactSet.artifacts.find((artifact) => artifact.path === 'schema.manifest.json')?.content).toContain('"schemaId":"shop@1"');
    expect(() => emitSchemaArtifacts(shopManifest, {
      artifacts: ['madeUp' as never]
    })).toThrow('Unknown schema artifact');
    expect(() => emitSchemaArtifacts(shopManifest, {
      artifacts: ['examples' as never]
    })).toThrow('Unknown schema artifact');
    expect(() => emitSchemaArtifacts(shopManifest, {
      artifacts: ['prompt-card' as never]
    })).toThrow('Unknown schema artifact');
  });

  it('publishes compiled entrypoints for native tools', async () => {
    const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as {
      readonly files?: readonly string[];
      readonly exports?: {
        readonly '.'?: unknown;
        readonly './cli'?: unknown;
      };
      readonly bin?: Readonly<Record<string, string>>;
    };

    expect(packageJson.files).toEqual(['dist', '!dist/.tsbuildinfo']);
    expect(packageJson.exports?.['.']).toEqual({
      types: './dist/index.d.ts',
      default: './dist/index.js'
    });
    expect(packageJson.exports?.['./cli']).toEqual({
      types: './dist/cli.d.ts',
      default: './dist/cli.js'
    });
    expect(packageJson.bin?.['tarstate-schema']).toBe('./dist/cli.js');
  });

  it('writes selected artifacts through the CLI', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'tarstate-schema-tools-'));
    try {
      const manifestPath = path.join(dir, 'schema.manifest.json');
      const outDir = path.join(dir, 'out');
      await writeFile(manifestPath, JSON.stringify(shopManifest), 'utf8');

      await runCli(['generate', manifestPath, '--out', outDir, '--artifacts', 'typescript,json-schema']);

      expect(await readFile(path.join(outDir, 'rows.d.ts'), 'utf8')).toContain('export type SchemaRows');
      expect(await readFile(path.join(outDir, 'json-schema', 'orders.schema.json'), 'utf8')).toContain('"x-tarstate-relation": "orders"');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('rejects removed CLI artifacts', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'tarstate-schema-tools-'));
    try {
      const manifestPath = path.join(dir, 'schema.manifest.json');
      await writeFile(manifestPath, JSON.stringify(shopManifest), 'utf8');

      await expect(runCli(['generate', manifestPath, '--artifacts', 'examples'])).rejects.toThrow('Unknown artifact "examples"');
      await expect(runCli(['generate', manifestPath, '--artifacts', 'prompt-card'])).rejects.toThrow('Unknown artifact "prompt-card"');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('recognizes symlinked bin entrypoints as direct CLI runs', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'tarstate-schema-cli-bin-'));
    try {
      const distDir = path.join(dir, 'dist');
      const binDir = path.join(dir, 'node_modules', '.bin');
      const cliPath = path.join(distDir, 'cli.js');
      const binPath = path.join(binDir, 'tarstate-schema');
      await mkdir(distDir, { recursive: true });
      await mkdir(binDir, { recursive: true });
      await writeFile(cliPath, '#!/usr/bin/env node\n', 'utf8');
      await symlink(cliPath, binPath);

      expect(binPath).not.toBe(cliPath);
      expect(isDirectCliRun(pathToFileURL(cliPath).href, binPath)).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('runs the compiled CLI through a symlinked bin entrypoint', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'tarstate-schema-cli-dist-bin-'));
    try {
      const cliPath = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
      const binDir = path.join(dir, 'node_modules', '.bin');
      const binPath = path.join(binDir, 'tarstate-schema');
      const manifestPath = path.join(dir, 'schema.manifest.json');
      const outDir = path.join(dir, 'out');
      await mkdir(binDir, { recursive: true });
      await symlink(cliPath, binPath);
      await writeFile(manifestPath, JSON.stringify(shopManifest), 'utf8');

      await execFileAsync(process.execPath, [
        binPath,
        'generate',
        manifestPath,
        '--out',
        outDir,
        '--artifacts',
        'json-schema'
      ]);

      expect(await readFile(path.join(outDir, 'json-schema', 'orders.schema.json'), 'utf8')).toContain('"x-tarstate-relation": "orders"');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
