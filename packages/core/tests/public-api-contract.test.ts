import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  incrementByKey as rootIncrementByKey,
  index as rootMaterializedIndex,
  runtimeSystemRelations,
  runtimeSystemSource,
  stringEnumField as rootStringEnumField,
  toSchemaManifest as rootToSchemaManifest,
  type IncrementByKeyPatch as RootIncrementByKeyPatch,
  type RelationRefRow as RootRelationRefRow,
  type SchemaManifestV1 as RootSchemaManifestV1,
  type RuntimeHistoryRow,
  type RuntimeObjectLocationRow,
  type RuntimeSystemState,
  type MaterializedIndex as RootMaterializedIndex,
  type RelationNumericField as RootRelationNumericField,
  type StoreCommitEffects as RootStoreCommitEffects,
  type StoreCommitSnapshot as RootStoreCommitSnapshot,
  type StoreSnapshot as RootStoreSnapshot
} from '@tarstate/core';
import * as adapterApi from '@tarstate/core/adapter';
import * as constraintsApi from '@tarstate/core/constraints';
import {
  check,
  constrain,
  fk,
  req,
  unique,
  type ConstraintData,
  type ConstraintOptions,
  type ConstraintSet
} from '@tarstate/core/constraints';
import * as dbApi from '@tarstate/core/db';
import {
  createDb,
  exists,
  q,
  qMany,
  qManyResult,
  qResult,
  row,
  transact,
  tryTransact,
  type DbQueryOptions,
  type DbQuerySortKey,
  type DbOptions,
  type DbTransactionResult,
  type QueryBatchResult,
  type QueryBatchRows,
  type QueryBatchTargetObject,
  type QueryBatchTargetOptions,
  type QueryBatchTargetRow
} from '@tarstate/core/db';
import {
  diagnostic,
  type TarstateCoreDiagnosticCode,
  type TarstateDiagnostic,
  type TarstateDiagnosticCode,
  type TarstateDiagnosticMode,
  type TarstateDiagnosticOptions,
  type TarstateDiagnosticSeverity
} from '@tarstate/core/diagnostics';
import { relationDeltaNames, relationDeltas, type RelationDelta } from '@tarstate/core/delta';
import { rowKey, validateRelationRow, type EvaluateOptions, type QueryResult } from '@tarstate/core/evaluate';
import {
  demat,
  index as materializedIndex,
  mat,
  type MaterializedHashIndex,
  type MaterializedIndex,
  type MaterializationInput,
  type MaterializationTarget,
  type MaterializationTargetValue,
  type MaterializedTarget,
  type MaterializedDb
} from '@tarstate/core/materialization';
import {
  aggregate,
  any as anyAggregate,
  as,
  clauses,
  correlate,
  count,
  eq,
  field,
  from,
  gt,
  hash,
  isMissing,
  isNull,
  join,
  leftJoin,
  maybe,
  notMissing,
  notAny,
  notNull,
  pipe,
  project,
  sel,
  sel1,
  self,
  sum,
  value,
  where,
  type ExprData,
  type PredicateData,
  type Query
} from '@tarstate/core/query';
import * as relationApi from '@tarstate/core/relation';
import type {
  TrackRuntimeCommitResult,
  TrackRuntimeCommitSupportedResult,
  TrackRuntimeCommitUnsupportedResult,
  TrackTransactResult
} from '@tarstate/core/runtime';
import {
  booleanField,
  canonicalSchemaManifest,
  customField,
  defineSchema,
  hydrateSchemaManifest,
  idField,
  isJsonValue,
  nullable,
  numberField,
  opaqueField,
  optional,
  refField,
  relation,
  SchemaManifestValidationError,
  stringEnumField,
  stringField,
  stringifyCanonicalSchemaManifest,
  toSchemaManifest,
  validateSchemaManifest,
  type CustomFieldSpec,
  type HydratedSchema,
  type HydrateSchemaManifestOptions,
  type HydrateSchemaManifestResult,
  type RelationRefRow,
  type RuntimeCodec,
  type SchemaManifestV1
} from '@tarstate/core/schema';
import {
  createStore,
  type StoreCommitResult,
  type StoreCommitEffects,
  type StoreCommitSnapshot,
  type StoreSnapshot,
  type StoreViewSnapshot
} from '@tarstate/core/store';
import {
  deleteByKey,
  deleteExact,
  incrementByKey,
  insert,
  seed,
  updateByKey,
  write,
  type DeleteByKeyPatch,
  type IncrementByKeyPatch,
  type RelationKeyInput,
  type RelationNumericField,
  type SchemaSeedInput,
  type SchemaSeedPatches,
  type UpdateByKeyPatch
} from '@tarstate/core/write';
import {
  diffQuery,
  subscribeWatch,
  unwatch,
  watch,
  watchTarget,
  type QueryDiff,
  type TrackedChange,
  type UnwatchResult,
  type WatchEvent,
  type WatchHandle,
  type WatchRefreshResult,
  type WatchSubscription,
  type WatchTargetChange,
  type WatchTargetRegistration,
  type WatchUnsubscribeResult
} from '@tarstate/core/watch';

type Account = {
  readonly id: string;
  readonly name: string;
  readonly kind: string;
};

type Entry = {
  readonly id: string;
  readonly accountId: string;
  readonly amount: number;
  readonly memo: string;
};

type QueryRow<Input> = Input extends Query<infer Row> ? Row : never;
type HasKind<Input> = Input extends { readonly kind: unknown } ? true : false;
type IsAny<Input> = 0 extends (1 & Input) ? true : false;

const schema = defineSchema({
  accounts: relation<Account>({
    key: 'id',
    fields: {
      id: stringField(),
      name: stringField(),
      kind: stringField()
    }
  }),
  entries: relation<Entry>({
    key: 'id',
    fields: {
      id: stringField(),
      accountId: stringField(),
      amount: numberField(),
      memo: stringField()
    }
  })
});

const openingDb = createDb({
  accounts: [
    { id: 'cash', name: 'Cash', kind: 'asset' },
    { id: 'sales', name: 'Sales', kind: 'income' }
  ],
  entries: [
    { id: 'e1', accountId: 'cash', amount: 120, memo: 'invoice paid' },
    { id: 'e2', accountId: 'sales', amount: -120, memo: 'invoice paid' }
  ]
});

describe('public API contracts', () => {
  it('exports shared relation helpers from the relation subpath', () => {
    expect(relationApi.relationKeyFields(schema.accounts)).toEqual(['id']);
    expect(typeof relationApi.relationRowKey).toBe('function');
    expect(typeof relationApi.relationKeyInputMatchesRow).toBe('function');
    expect(typeof relationApi.validateRelationRow).toBe('function');
  });

  it('keeps schema JSON boundary on JSON-compatible values only', () => {
    expect(isJsonValue({ nested: ['value', 1, true, null] })).toBe(true);
    expect(isJsonValue([1, { ok: false }])).toBe(true);
    expect(isJsonValue(Number.MAX_SAFE_INTEGER)).toBe(true);
    expect(isJsonValue(() => undefined)).toBe(false);
    expect(isJsonValue({ callback: () => undefined })).toBe(false);
    expect(isJsonValue(undefined)).toBe(false);
    expect(isJsonValue(Number.NaN)).toBe(false);
    expect(isJsonValue(Number.POSITIVE_INFINITY)).toBe(false);
    expect(isJsonValue(Number.NEGATIVE_INFINITY)).toBe(false);
    expect(isJsonValue(new Date('2026-01-01T00:00:00.000Z'))).toBe(false);
    expect(isJsonValue(new Map())).toBe(false);
    expect(isJsonValue(new Set())).toBe(false);
    expect(isJsonValue(new Uint8Array([1]))).toBe(false);

    const nullPrototypeRecord = Object.create(null) as Record<string, unknown>;
    nullPrototypeRecord.ok = true;
    expect(isJsonValue(nullPrototypeRecord)).toBe(true);

    class Box {
      readonly value = 'not plain JSON';
    }
    expect(isJsonValue(new Box())).toBe(false);

    const sparseArray: unknown[] = [];
    sparseArray[1] = 'present';
    expect(isJsonValue(sparseArray)).toBe(false);

    const arrayWithExtraProperty = [1] as unknown[] & { extra?: string };
    arrayWithExtraProperty.extra = 'dropped by JSON.stringify';
    expect(isJsonValue(arrayWithExtraProperty)).toBe(false);

    const cyclicRecord: Record<string, unknown> = {};
    cyclicRecord.self = cyclicRecord;
    expect(isJsonValue(cyclicRecord)).toBe(false);

    let sharedDescriptorReads = 0;
    const sharedSubtree = new Proxy({ ok: true }, {
      getOwnPropertyDescriptor(target, property) {
        sharedDescriptorReads += 1;
        return Reflect.getOwnPropertyDescriptor(target, property);
      }
    });
    expect(isJsonValue({ left: sharedSubtree, right: sharedSubtree, nested: [sharedSubtree, sharedSubtree] })).toBe(true);
    expect(sharedDescriptorReads).toBe(1);

    let accessorInvoked = false;
    const recordWithAccessor = {};
    Object.defineProperty(recordWithAccessor, 'value', {
      enumerable: true,
      get() {
        accessorInvoked = true;
        return 'not read';
      }
    });
    expect(isJsonValue(recordWithAccessor)).toBe(false);
    expect(accessorInvoked).toBe(false);

    const hostileRecord = new Proxy({}, {
      ownKeys() {
        throw new Error('do not inspect me');
      }
    });
    expect(isJsonValue(hostileRecord)).toBe(false);

    const hostileArray = new Proxy([1], {
      getOwnPropertyDescriptor() {
        throw new Error('do not inspect me');
      }
    });
    expect(isJsonValue(hostileArray)).toBe(false);
  });

  it('exports, canonicalizes, and hydrates schema manifests', () => {
    type Pizza = {
      readonly id: string;
      readonly name: string;
      readonly size: string;
      readonly notes?: string;
    };
    type Topping = {
      readonly pizzaId: string;
      readonly name: string;
      readonly extra: boolean;
    };
    type Price = {
      readonly id: string;
      readonly amount: { readonly cents: number; readonly currency: string };
    };
    const moneyCodec = {
      codec: 'food.money',
      description: 'Money amount',
      toScalar: (value: unknown) =>
        typeof value === 'object'
        && value !== null
        && 'cents' in value
        && 'currency' in value
          ? `${String(value.currency)}:${String(value.cents)}`
          : null
    } satisfies RuntimeCodec;
    const menuSchema = defineSchema({
      pizzas: relation<Pizza>({
        key: 'id',
        fields: {
          id: idField('food.pizza'),
          name: stringField(),
          size: stringField(),
          notes: optional(stringField())
        }
      }),
      toppings: relation<Topping, readonly ['pizzaId', 'name']>({
        key: ['pizzaId', 'name'] as const,
        fields: {
          pizzaId: refField({ relation: 'pizzas', field: 'id' }),
          name: stringField(),
          extra: booleanField()
        }
      }),
      prices: relation<Price>({
        key: 'id',
        fields: {
          id: idField('food.price'),
          amount: customField<Price['amount']>({
            codec: 'food.money',
            description: 'Money amount',
            toScalar: moneyCodec.toScalar
          })
        }
      })
    });

    const manifest = toSchemaManifest(menuSchema, {
      schemaId: 'food.menu@1',
      metadata: { revision: -0, tags: ['dinner'] }
    });

    expectTypeOf<RootSchemaManifestV1>().toEqualTypeOf<SchemaManifestV1>();
    expect(rootToSchemaManifest(menuSchema, { schemaId: 'food.menu@1', metadata: { revision: -0, tags: ['dinner'] } })).toEqual(manifest);
    expect(manifest).toEqual({
      kind: 'tarstate.schema',
      formatVersion: 1,
      schemaId: 'food.menu@1',
      relations: {
        pizzas: {
          key: 'id',
          fields: {
            id: { type: 'id', domain: 'food.pizza' },
            name: { type: 'string' },
            notes: { type: 'string', optional: true },
            size: { type: 'string' }
          }
        },
        prices: {
          key: 'id',
          fields: {
            amount: { type: 'custom', codec: 'food.money' },
            id: { type: 'id', domain: 'food.price' }
          }
        },
        toppings: {
          key: ['pizzaId', 'name'],
          fields: {
            extra: { type: 'boolean' },
            name: { type: 'string' },
            pizzaId: { type: 'ref', target: { relation: 'pizzas', field: 'id' } }
          }
        }
      },
      codecs: {
        'food.money': { description: 'Money amount', keyable: true }
      },
      metadata: { revision: 0, tags: ['dinner'] }
    } satisfies SchemaManifestV1);

    const hydrated = hydrateSchemaManifest(manifest, { codecs: { 'food.money': moneyCodec } });
    expect(hydrated.pizzas?.name).toBe('pizzas');
    expect(hydrated.toppings?.fields.pizzaId?.ref).toEqual({ relation: 'pizzas', field: 'id' });
    expect(hydrated.prices?.fields.amount?.custom?.codec).toBe('food.money');
    expect(hydrated.prices?.fields.amount?.custom).not.toHaveProperty('kind');
    expect(hydrated.prices?.fields.amount?.custom?.toScalar?.({ currency: 'NZD', cents: 2400 })).toBe('NZD:2400');
    const collectedHydration = hydrateSchemaManifest(manifest, {
      diagnosticMode: 'collect',
      codecs: { 'food.money': moneyCodec }
    });
    expectTypeOf<typeof collectedHydration>().toEqualTypeOf<HydrateSchemaManifestResult>();
    expect(collectedHydration.diagnostics).toEqual([]);
    expect(collectedHydration.schema?.prices?.name).toBe('prices');
    const broadHydrationOptions: HydrateSchemaManifestOptions = {
      diagnosticMode: 'collect',
      codecs: { 'food.money': moneyCodec }
    };
    const broadHydration = hydrateSchemaManifest(manifest, broadHydrationOptions);
    expectTypeOf<typeof broadHydration>().toEqualTypeOf<HydratedSchema | HydrateSchemaManifestResult>();
    expect((broadHydration as HydrateSchemaManifestResult).schema?.prices?.name).toBe('prices');

    const runtimeManifest = toSchemaManifest(runtimeSystemRelations, { schemaId: 'tarstate.runtime@1' });
    expect(validateSchemaManifest(runtimeManifest)).toEqual([]);
    expect(runtimeManifest.relations['tarstate.runtime.objectLocations']?.fields.parentObjectId).toEqual({
      type: 'id',
      domain: 'tarstate.runtime.object',
      optional: true
    });

    const invalidCodecSchema = defineSchema({
      notes: relation<{ readonly id: string; readonly body: unknown }>({
        key: 'id',
        fields: {
          id: stringField(),
          body: customField({ codec: '' })
        }
      })
    });
    try {
      toSchemaManifest(invalidCodecSchema, { schemaId: 'bad.codec@1' });
      throw new Error('expected schema manifest export to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(SchemaManifestValidationError);
      expect((error as SchemaManifestValidationError).diagnostics.map((diagnosticValue) => diagnosticValue.code)).toContain('schema_manifest.invalid_codec');
    }
  });

  it('treats string enum fields as first-class schema semantics', () => {
    const fsSchema = defineSchema({
      nodes: relation({
        key: 'id',
        description: 'Filesystem nodes.',
        metadata: { source: 'fs' },
        fields: {
          id: idField('fsNodePath'),
          name: stringField(),
          kind: {
            ...stringEnumField(['folder', 'file'] as const),
            description: 'Node kind.',
            metadata: { source: 'fs-kind' }
          }
        }
      })
    });

    type FsRow = RelationRefRow<typeof fsSchema.nodes>;
    expectTypeOf<FsRow>().toEqualTypeOf<{
      readonly id: string;
      readonly name: string;
      readonly kind: 'folder' | 'file';
    }>();
    expectTypeOf<RootRelationRefRow<typeof fsSchema.nodes>>().toEqualTypeOf<FsRow>();

    const folder = { id: '/docs', name: 'docs', kind: 'folder' } as const satisfies FsRow;
    // @ts-expect-error string enum fields only accept declared values.
    const invalidKind = { id: '/link', name: 'link', kind: 'shortcut' } as const satisfies FsRow;
    expect(invalidKind.kind).toBe('shortcut');

    const manifest = toSchemaManifest(fsSchema, { schemaId: 'tarstate.fs@draft' });
    expect(rootToSchemaManifest(fsSchema, { schemaId: 'tarstate.fs@draft' })).toEqual(manifest);
    expect(rootStringEnumField(['folder', 'file'] as const).values).toEqual(['folder', 'file']);
    expect(manifest.relations.nodes?.fields.kind).toEqual({
      type: 'string',
      values: ['folder', 'file'],
      description: 'Node kind.',
      metadata: { source: 'fs-kind' }
    });
    expect(manifest.relations.nodes).toEqual(expect.objectContaining({
      description: 'Filesystem nodes.',
      metadata: { source: 'fs' }
    }));

    const hydrated = hydrateSchemaManifest(manifest);
    expect(toSchemaManifest(hydrated, { schemaId: 'tarstate.fs@draft' })).toEqual(manifest);
    expect(hydrated.nodes?.fields.kind?.values).toEqual(['folder', 'file']);
    expect(hydrated.nodes?.fields.kind?.description).toBe('Node kind.');
    expect(hydrated.nodes?.fields.kind?.metadata).toEqual({ source: 'fs-kind' });
    expect(validateRelationRow(fsSchema.nodes, folder)).toEqual([]);
    expect(validateRelationRow(fsSchema.nodes, {
      id: '/link',
      name: 'link',
      kind: 'shortcut'
    }).map((diagnosticValue) => diagnosticValue.field)).toContain('kind');

    const kindKeySchema = defineSchema({
      nodesByKind: relation({
        key: 'kind',
        fields: {
          kind: stringEnumField(['folder', 'file'] as const),
          label: stringField()
        }
      })
    });
    expect(relationApi.relationKeyInputKey(kindKeySchema.nodesByKind, 'folder')).toBeDefined();
    expect(relationApi.relationKeyInputKey(kindKeySchema.nodesByKind, 'shortcut')).toBeUndefined();
  });

  it('infers optional schema builder fields as optional row properties', () => {
    const nodes = relation({
      key: 'id',
      fields: {
        id: stringField(),
        label: stringField(),
        parentId: nullable(stringField()),
        src: optional(stringField()),
        maybeParentId: optional(nullable(stringField())),
        detail: optional(opaqueField<unknown>('node.detail'))
      }
    });

    type NodeRow = RelationRefRow<typeof nodes>;
    expectTypeOf<RootRelationRefRow<typeof nodes>>().toEqualTypeOf<NodeRow>();
    expectTypeOf<NodeRow>().toEqualTypeOf<{
      readonly id: string;
      readonly label: string;
      readonly parentId: string | null;
      readonly src?: string;
      readonly maybeParentId?: string | null;
      readonly detail?: unknown;
    }>();

    const omittedOptional = { id: 'node-1', label: 'Node 1', parentId: null } satisfies NodeRow;
    const presentOptionalNullable = {
      id: 'node-2',
      label: 'Node 2',
      parentId: 'node-1',
      maybeParentId: null,
      detail: { source: 'fuzz' },
      src: 'src/index.ts'
    } satisfies NodeRow;
    // @ts-expect-error required fields cannot be omitted.
    const missingRequired = { id: 'node-3', parentId: null } satisfies NodeRow;
    // @ts-expect-error nullable fields remain required.
    const missingNullable = { id: 'node-4', label: 'Node 4' } satisfies NodeRow;
    // @ts-expect-error optional properties do not accept undefined when present.
    const presentUndefined = { id: 'node-5', label: 'Node 5', parentId: null, src: undefined } satisfies NodeRow;

    expect(omittedOptional.id).toBe('node-1');
    expect(presentOptionalNullable.maybeParentId).toBeNull();
    expect(missingRequired.id).toBe('node-3');
    expect(missingNullable.id).toBe('node-4');
    expect(presentUndefined.id).toBe('node-5');
  });

  it('validates schema manifests before canonicalization and hydration', () => {
    expect(stringifyCanonicalSchemaManifest({
      kind: 'tarstate.schema',
      formatVersion: 1,
      schemaId: 'empty@1',
      relations: {},
      codecs: {},
      metadata: {}
    })).toBe('{"formatVersion":1,"kind":"tarstate.schema","relations":{},"schemaId":"empty@1"}');

    const invalidManifest = {
      kind: 'tarstate.schema',
      formatVersion: 1,
      schemaId: 'bad@1',
      unexpected: true,
      relations: {
        things: {
          key: ['id'],
          fields: {
            id: { type: 'json' },
            ownerId: { type: 'ref', target: { relation: 'missing', field: 'id' } }
          }
        }
      }
    };
    const diagnostics = validateSchemaManifest(invalidManifest);
    expect(diagnostics.map((diagnosticValue) => diagnosticValue.code)).toEqual(expect.arrayContaining([
      'schema_manifest.unknown_property',
      'schema_manifest.invalid_key',
      'schema_manifest.invalid_ref'
    ]));
    expect(() => canonicalSchemaManifest(invalidManifest)).toThrow(SchemaManifestValidationError);

    const cyclicMetadata: Record<string, unknown> = {};
    cyclicMetadata.self = cyclicMetadata;
    expect(validateSchemaManifest({
      kind: 'tarstate.schema',
      formatVersion: 1,
      schemaId: 'cyclic@1',
      relations: {},
      metadata: cyclicMetadata
    }).map((diagnosticValue) => diagnosticValue.code)).toContain('schema_manifest.non_json_value');

    let proxyGetInvoked = false;
    const proxyManifest = new Proxy({
      kind: 'tarstate.schema',
      formatVersion: 1,
      schemaId: 'proxy@1',
      relations: {}
    }, {
      get(target, property, receiver) {
        proxyGetInvoked = true;
        return Reflect.get(target, property, receiver);
      }
    });
    expect(validateSchemaManifest(proxyManifest)).toEqual([]);
    expect(proxyGetInvoked).toBe(false);

    const customManifest = {
      kind: 'tarstate.schema',
      formatVersion: 1,
      schemaId: 'custom@1',
      codecs: { 'food.spice': {} },
      relations: {
        recipes: {
          key: 'id',
          fields: {
            id: { type: 'id', domain: 'food.recipe' },
            spice: { type: 'custom', codec: 'food.spice' }
          }
        }
      }
    } satisfies SchemaManifestV1;
    const hydrateResult = hydrateSchemaManifest(customManifest, { diagnosticMode: 'collect', codecs: {} });
    expect(hydrateResult.schema).toBeUndefined();
    expect(hydrateResult.diagnostics.map((diagnosticValue) => diagnosticValue.code)).toContain('schema_manifest.invalid_codec');

    const enumManifest = canonicalSchemaManifest({
      kind: 'tarstate.schema',
      formatVersion: 1,
      schemaId: 'enum@1',
      relations: {
        nodes: {
          key: 'id',
          fields: {
            id: { type: 'string' },
            kind: { type: 'string', values: ['folder', 'file'] }
          }
        }
      }
    });
    expect(enumManifest.relations.nodes?.fields.kind).toEqual({
      type: 'string',
      values: ['folder', 'file']
    });

    const malformedEnumManifest = {
      kind: 'tarstate.schema',
      formatVersion: 1,
      schemaId: 'bad.enum@1',
      relations: {
        nodes: {
          key: 'id',
          fields: {
            id: { type: 'string' },
            kind: { type: 'string', values: ['folder', 7, 'folder'] }
          }
        }
      }
    };
    expect(validateSchemaManifest(malformedEnumManifest).map((diagnosticValue) => diagnosticValue.code)).toContain('schema_manifest.invalid_field');
    expect(() => canonicalSchemaManifest(malformedEnumManifest)).toThrow(SchemaManifestValidationError);
  });

  it('rejects ambiguous builder refs during manifest export', () => {
    const ambiguousSchema = defineSchema({
      objectLocations: relation<{ readonly id: string; readonly parentObjectId?: string }>({
        key: 'id',
        fields: {
          id: idField('tarstate.runtime.objectLocation'),
          parentObjectId: optional(refField('tarstate.runtime.object'))
        }
      })
    });

    try {
      toSchemaManifest(ambiguousSchema, { schemaId: 'bad.refs@1' });
      throw new Error('expected schema manifest export to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(SchemaManifestValidationError);
      expect((error as SchemaManifestValidationError).diagnostics.map((diagnosticValue) => diagnosticValue.code)).toContain('schema_manifest.invalid_ref');
    }
  });

  it('exposes relation deltas from the delta subpath', () => {
    const delta = {
      relation: schema.entries,
      added: [{ id: 'e3', accountId: 'cash', amount: 20, memo: 'sale' }],
      removed: []
    } satisfies RelationDelta<typeof schema.entries>;

    expect(relationDeltas(delta)).toEqual([delta]);
    expect(relationDeltaNames(relationDeltas(delta, delta))).toEqual(['entries']);
  });

  it('keeps TarstateDiagnostic as the canonical diagnostic type', () => {
    const known = diagnostic({
      code: 'not_implemented',
      severity: 'warning',
      message: 'stubbed'
    });
    const dbWithEnv = createDb({}, { env: { tenant: 'acme' } });

    expectTypeOf<TarstateCoreDiagnosticCode>().toMatchTypeOf<TarstateDiagnosticCode>();
    expectTypeOf<'foreign_key'>().toMatchTypeOf<TarstateCoreDiagnosticCode>();
    expectTypeOf<'write_patch_invalid'>().toMatchTypeOf<TarstateCoreDiagnosticCode>();
    expectTypeOf<'transaction_failed'>().toMatchTypeOf<TarstateCoreDiagnosticCode>();
    expectTypeOf<'app/custom-rule'>().toMatchTypeOf<TarstateDiagnosticCode>();
    expectTypeOf<TarstateDiagnosticSeverity>().toEqualTypeOf<'info' | 'warning' | 'error'>();
    expectTypeOf<TarstateDiagnosticMode>().toEqualTypeOf<'collect' | 'throw' | 'warn'>();
    expectTypeOf<TarstateDiagnosticOptions>().toMatchTypeOf<{ readonly diagnosticMode?: TarstateDiagnosticMode }>();
    expectTypeOf<EvaluateOptions>().toMatchTypeOf<TarstateDiagnosticOptions>();
    expectTypeOf<DbOptions>().toMatchTypeOf<TarstateDiagnosticOptions>();
    expectTypeOf<typeof known>().toEqualTypeOf<TarstateDiagnostic>();
    expect(dbWithEnv.env).toEqual({ tenant: 'acme' });

    // @ts-expect-error createDb env must be passed through DbOptions.env.
    createDb({}, { tenant: 'acme' });
  });

  it('exposes runtime system state as queryable relation rows', () => {
    const objectLocation = {
      id: 'runtime:object:1@actor',
      runtime: 'runtime',
      objectId: '1@actor',
      path: 'entries.[0]',
      pathSegments: ['entries', 0],
      relation: 'entries',
      key: 'entry-1'
    } satisfies RuntimeObjectLocationRow;
    const history = {
      id: 'runtime:history:hash-1',
      runtime: 'runtime',
      documentId: 'document-1',
      hash: 'hash-1',
      actor: 'actor-1',
      message: 'created entry',
      time: 1_783_036_800,
      deps: [],
      heads: ['hash-1'],
      detail: { seq: 1 }
    } satisfies RuntimeHistoryRow;
    const state = {
      sources: [{
        id: 'runtime:source:storage',
        runtime: 'runtime',
        source: 'storage',
        state: 'loading'
      }],
      diagnostics: [diagnostic({
        code: 'not_implemented',
        severity: 'warning',
        message: 'source is still loading',
        surface: 'runtime'
      })],
      interests: [{
        id: 'view:entries',
        runtime: 'runtime',
        queryKey: 'query:entries',
        state: 'active',
        relationNames: ['entries'],
        subscriberCount: 1
      }],
      history: [history],
      objectLocations: [objectLocation]
    } satisfies RuntimeSystemState;
    const source = runtimeSystemSource(state);

    expect(runtimeSystemRelations.sources.name).toBe('tarstate.runtime.sources');
    expect(runtimeSystemRelations.diagnostics.ephemeral).toBe(true);
    expect(runtimeSystemRelations.history.name).toBe('tarstate.runtime.history');
    expect(adapterApi.runtimeSystemRelations.objectLocations.name).toBe('tarstate.runtime.objectLocations');
    expect(runtimeSystemRelations.objectLocations.key).toBe('id');
    expect(adapterApi.runtimeSystemRelations.history.key).toBe('id');
    expectTypeOf<typeof history>().toMatchTypeOf<RuntimeHistoryRow>();
    expectTypeOf<typeof objectLocation>().toMatchTypeOf<RuntimeObjectLocationRow>();
    expect(source.relationNames).toEqual([
      'tarstate.runtime.sources',
      'tarstate.runtime.diagnostics',
      'tarstate.runtime.peers',
      'tarstate.runtime.sync',
      'tarstate.runtime.conflicts',
      'tarstate.runtime.history',
      'tarstate.runtime.objectLocations',
      'tarstate.runtime.storage',
      'tarstate.runtime.interests'
    ]);
    expect(source.rows(runtimeSystemRelations.sources)).toEqual(state.sources);
    expect(source.rows(runtimeSystemRelations.interests)).toEqual(state.interests);
    expect(source.rows(runtimeSystemRelations.history)).toEqual(state.history);
    expect(source.rows(runtimeSystemRelations.objectLocations)).toEqual(state.objectLocations);
    expect(source.rows(runtimeSystemRelations.diagnostics)).toEqual([
      expect.objectContaining({
        runtime: 'runtime',
        code: 'not_implemented',
        severity: 'warning',
        message: 'source is still loading'
      })
    ]);
    expect(source.diagnostics?.()).toEqual([
      expect.objectContaining({
        code: 'not_implemented',
        severity: 'warning',
        message: 'source is still loading'
      })
    ]);
  });

  it('makes q and qMany row-first with explicit result envelopes', () => {
    const entry = as(schema.entries, 'entry');
    const positiveEntries = pipe(
      from(entry),
      where(gt(entry.amount, value(0))),
      project({ id: entry.id, amount: entry.amount })
    );
    const summary = pipe(
      from(entry),
      project({ entryCount: count() })
    );
    const batch = { positiveEntries, summary };

    const readRows = () => q(openingDb, positiveEntries);
    const readRelationRows = () => q(openingDb, schema.entries);
    const readResult = () => qResult(openingDb, positiveEntries);
    const readBatchRows = () => qMany(openingDb, batch);
    const readBatchResult = () => qManyResult(openingDb, batch);

    expectTypeOf<ReturnType<typeof readRows>>().toEqualTypeOf<readonly {
      readonly id: string;
      readonly amount: number;
    }[]>();
    expectTypeOf<ReturnType<typeof readRelationRows>>().toEqualTypeOf<readonly Entry[]>();
    expectTypeOf<ReturnType<typeof readResult>>().toEqualTypeOf<QueryResult<{
      readonly id: string;
      readonly amount: number;
    }>>();
    expectTypeOf<ReturnType<typeof readBatchRows>>().toEqualTypeOf<QueryBatchRows<typeof batch>>();
    expectTypeOf<ReturnType<typeof readBatchResult>>().toEqualTypeOf<QueryBatchResult<typeof batch>>();
  });

  it('keeps DB query option defaults unknown while constraining known-row sort keys', () => {
    type DefaultTargetRows = Parameters<NonNullable<QueryBatchTargetOptions['mapRows']>>[0];
    type DefaultTargetRow = DefaultTargetRows[number];
    type DefaultTargetObjectQueryRow =
      Extract<QueryBatchTargetObject['q'], Query<unknown>> extends Query<infer Row> ? Row : never;
    type PositiveEntry = {
      readonly id: string;
      readonly amount: number;
    };

    const entry = as(schema.entries, 'entry');
    const positiveEntries = pipe(
      from(entry),
      where(gt(entry.amount, value(0))),
      project({ id: entry.id, amount: entry.amount })
    );

    const validTargetOptions = {
      sort: 'amount',
      rsort: ['id', 'amount']
    } satisfies QueryBatchTargetOptions<PositiveEntry>;
    const invalidTargetOptions = {
      // @ts-expect-error Sort keys must be fields from the typed row.
      sort: 'missing'
    } satisfies QueryBatchTargetOptions<PositiveEntry>;
    const invalidDbOptions = {
      rsort: [
        'id',
        // @ts-expect-error Sort key arrays must also use fields from the typed row.
        'missing'
      ]
    } satisfies DbQueryOptions<PositiveEntry>;

    const readIds = () => q(openingDb, positiveEntries, {
      sort: 'amount',
      mapRows: (rows) => rows.map((row) => row.id)
    });
    const mappedTarget = {
      q: positiveEntries,
      sort: 'amount',
      mapRows: (rows: readonly PositiveEntry[]) => rows.map((row) => row.id)
    } satisfies QueryBatchTargetObject<PositiveEntry, string>;
    const mappedBatch = { ids: mappedTarget };
    const readBatchIds = () => qMany(openingDb, mappedBatch);
    const invalidRead = () =>
      // @ts-expect-error q sort keys must be fields from the inferred query row.
      q(openingDb, positiveEntries, { sort: 'missing' });

    expectTypeOf<DefaultTargetRows>().toEqualTypeOf<readonly unknown[]>();
    expectTypeOf<DefaultTargetRow>().toEqualTypeOf<unknown>();
    expectTypeOf<IsAny<DefaultTargetRow>>().toEqualTypeOf<false>();
    expectTypeOf<DefaultTargetObjectQueryRow>().toEqualTypeOf<unknown>();
    expectTypeOf<IsAny<DefaultTargetObjectQueryRow>>().toEqualTypeOf<false>();
    expectTypeOf<DbQuerySortKey<PositiveEntry>>()
      .toEqualTypeOf<'id' | 'amount' | ((row: PositiveEntry) => unknown)>();
    expectTypeOf<ReturnType<typeof readIds>>().toEqualTypeOf<readonly string[]>();
    expectTypeOf<ReturnType<typeof mappedTarget.mapRows>>().toEqualTypeOf<string[]>();
    expectTypeOf<QueryBatchTargetRow<typeof mappedTarget>>().toEqualTypeOf<PositiveEntry>();
    expectTypeOf<QueryBatchRows<typeof mappedBatch>['ids']>().toEqualTypeOf<string[]>();
    expectTypeOf<ReturnType<typeof readBatchIds>['ids']>().toEqualTypeOf<string[]>();

    void validTargetOptions;
    void invalidTargetOptions;
    void invalidDbOptions;
    void invalidRead;
  });

  it('removes duplicated row-only read helpers and the constrained transaction fork from public exports', () => {
    expect('qRows' in dbApi).toBe(false);
    expect('qManyRows' in dbApi).toBe(false);
    expect('attachConstraints' in constraintsApi).toBe(false);
    expect('detachConstraints' in constraintsApi).toBe(false);
    expect('attachedConstraintsFor' in constraintsApi).toBe(false);
    expect('hasAttachedConstraints' in constraintsApi).toBe(false);
    expect('tryTransactConstrained' in constraintsApi).toBe(false);
    expect('transactConstrained' in constraintsApi).toBe(false);

    // @ts-expect-error qRows is intentionally not exported.
    expect(dbApi.qRows).toBeUndefined();
    // @ts-expect-error qManyRows is intentionally not exported.
    expect(dbApi.qManyRows).toBeUndefined();
    // @ts-expect-error constraints install through mat, not a separate attachment API.
    expect(constraintsApi.attachConstraints).toBeUndefined();
    // @ts-expect-error constraints remove through demat, not a separate attachment API.
    expect(constraintsApi.detachConstraints).toBeUndefined();
    // @ts-expect-error attached constraint inspection is intentionally not public.
    expect(constraintsApi.attachedConstraintsFor).toBeUndefined();
    // @ts-expect-error attached constraint inspection is intentionally not public.
    expect(constraintsApi.hasAttachedConstraints).toBeUndefined();
    // @ts-expect-error constrained transaction forks are intentionally not exported.
    expect(constraintsApi.tryTransactConstrained).toBeUndefined();
    // @ts-expect-error constrained transaction forks are intentionally not exported.
    expect(constraintsApi.transactConstrained).toBeUndefined();
  });

  it('keeps relation key lookup typed from relation metadata', () => {
    type KeyedEntry = {
      readonly id: string;
      readonly amount: number;
    };
    type TenantEntry = {
      readonly tenantId: string;
      readonly id: string;
      readonly amount: number;
    };
    type FlagEntry = {
      readonly enabled: boolean;
      readonly label: string;
    };
    type NumberKeyEntry = {
      readonly id: number;
      readonly label: string;
    };
    const keyedSchema = defineSchema({
      byId: relation<KeyedEntry, 'id'>({
        key: 'id',
        fields: {
          id: stringField(),
          amount: numberField()
        }
      }),
      byTenantAndId: relation<TenantEntry, readonly ['tenantId', 'id']>({
        key: ['tenantId', 'id'] as const,
        fields: {
          tenantId: stringField(),
          id: stringField(),
          amount: numberField()
        }
      }),
      byEnabled: relation<FlagEntry, 'enabled'>({
        key: 'enabled',
        fields: {
          enabled: booleanField(),
          label: stringField()
        }
      }),
      byNumber: relation<NumberKeyEntry, 'id'>({
        key: 'id',
        fields: {
          id: numberField(),
          label: stringField()
        }
      })
    });

    const readById = () => row(openingDb, keyedSchema.byId, 'entry-a');
    const readByTenantAndId = () => row(openingDb, keyedSchema.byTenantAndId, ['acme', 'entry-a'] as const);
    const readByEnabled = () => row(openingDb, keyedSchema.byEnabled, true);
    const readByNumber = () => row(openingDb, keyedSchema.byNumber, 1);
    const hasById = () => exists(openingDb, keyedSchema.byId, 'entry-a');
    const hasByEnabled = () => exists(openingDb, keyedSchema.byEnabled, false);
    const hasByNumber = () => exists(openingDb, keyedSchema.byNumber, 2);
    const updateFlag = () => updateByKey(keyedSchema.byEnabled, true, { label: 'Enabled' });
    const deleteFlag = () => deleteByKey(keyedSchema.byEnabled, false);
    const incrementAmount = () => incrementByKey(keyedSchema.byId, 'entry-a', 'amount', 2);
    const rootIncrementAmount = () => rootIncrementByKey(keyedSchema.byId, 'entry-a', 'amount', 2);
    const writerIncrementAmount = () => write(keyedSchema.byTenantAndId).incrementByKey(['acme', 'entry-a'] as const, 'amount', 2);
    const flagDb = createDb({
      byEnabled: [
        { enabled: true, label: 'Enabled' },
        { enabled: false, label: 'Disabled' }
      ],
      byNumber: [
        { id: 1, label: 'One' },
        { id: 2, label: 'Two' }
      ]
    });

    expectTypeOf<ReturnType<typeof readById>>().toEqualTypeOf<KeyedEntry | undefined>();
    expectTypeOf<ReturnType<typeof readByTenantAndId>>().toEqualTypeOf<TenantEntry | undefined>();
    expectTypeOf<ReturnType<typeof readByEnabled>>().toEqualTypeOf<FlagEntry | undefined>();
    expectTypeOf<ReturnType<typeof readByNumber>>().toEqualTypeOf<NumberKeyEntry | undefined>();
    expectTypeOf<ReturnType<typeof hasById>>().toEqualTypeOf<boolean>();
    expectTypeOf<ReturnType<typeof hasByEnabled>>().toEqualTypeOf<boolean>();
    expectTypeOf<ReturnType<typeof hasByNumber>>().toEqualTypeOf<boolean>();
    expectTypeOf<ReturnType<typeof updateFlag>>().toEqualTypeOf<UpdateByKeyPatch<typeof keyedSchema.byEnabled>>();
    expectTypeOf<ReturnType<typeof deleteFlag>>().toEqualTypeOf<DeleteByKeyPatch<typeof keyedSchema.byEnabled>>();
    expectTypeOf<ReturnType<typeof incrementAmount>>().toEqualTypeOf<IncrementByKeyPatch<typeof keyedSchema.byId>>();
    expectTypeOf<ReturnType<typeof rootIncrementAmount>>().toEqualTypeOf<RootIncrementByKeyPatch<typeof keyedSchema.byId>>();
    expectTypeOf<ReturnType<typeof rootIncrementAmount>>().toEqualTypeOf<ReturnType<typeof incrementAmount>>();
    expectTypeOf<ReturnType<typeof writerIncrementAmount>>().toEqualTypeOf<IncrementByKeyPatch<typeof keyedSchema.byTenantAndId>>();
    expectTypeOf<RootRelationNumericField<typeof keyedSchema.byId>>().toEqualTypeOf<RelationNumericField<typeof keyedSchema.byId>>();
    expectTypeOf<RelationKeyInput>().toEqualTypeOf<string | number | boolean | readonly (string | number | boolean)[]>();
    expect(row(flagDb, keyedSchema.byEnabled, true)).toEqual({ enabled: true, label: 'Enabled' });
    expect(exists(flagDb, keyedSchema.byEnabled, false)).toBe(true);
    expect(row(flagDb, keyedSchema.byNumber, 1)).toEqual({ id: 1, label: 'One' });
    expect(exists(flagDb, keyedSchema.byNumber, 2)).toBe(true);

    const invalidReadById = () =>
      // @ts-expect-error row keys must match the relation key field type.
      row(openingDb, keyedSchema.byId, 1);
    const invalidReadByEnabled = () =>
      // @ts-expect-error boolean row keys must use boolean key values.
      row(openingDb, keyedSchema.byEnabled, 'true');
    const invalidReadByNumber = () =>
      // @ts-expect-error numeric row keys must use numeric key values.
      row(openingDb, keyedSchema.byNumber, '1');
    const invalidHasById = () =>
      // @ts-expect-error exists keys must match the relation key field type.
      exists(openingDb, keyedSchema.byId, 1);
    const invalidCompositeRead = () =>
      // @ts-expect-error composite row keys use the relation key tuple shape.
      row(openingDb, keyedSchema.byTenantAndId, 'entry-a');
    const invalidCompositeExists = () =>
      // @ts-expect-error composite key component types follow row fields.
      exists(openingDb, keyedSchema.byTenantAndId, ['acme', 1] as const);
    const invalidIncrementKey = () =>
      // @ts-expect-error incrementByKey keys must match relation key metadata.
      incrementByKey(keyedSchema.byId, 1, 'amount', 2);
    const invalidRootIncrementField = () =>
      // @ts-expect-error root incrementByKey fields must be numeric relation fields.
      rootIncrementByKey(keyedSchema.byTenantAndId, ['acme', 'entry-a'] as const, 'id', 2);
    const invalidIncrementField = () =>
      // @ts-expect-error incrementByKey fields must be numeric relation fields.
      incrementByKey(keyedSchema.byTenantAndId, ['acme', 'entry-a'] as const, 'id', 2);
    const invalidIncrementAmount = () =>
      // @ts-expect-error incrementByKey amount must be numeric.
      write(keyedSchema.byId).incrementByKey('entry-a', 'amount', '2');
    void invalidReadById;
    void invalidReadByEnabled;
    void invalidReadByNumber;
    void invalidHasById;
    void invalidCompositeRead;
    void invalidCompositeExists;
    void updateFlag;
    void deleteFlag;
    void incrementAmount;
    void rootIncrementAmount;
    void writerIncrementAmount;
    void invalidIncrementKey;
    void invalidRootIncrementField;
    void invalidIncrementField;
    void invalidIncrementAmount;
  });

  it('supports custom and opaque field specs without making them stringly', () => {
    type RichText = {
      readonly text: string;
      readonly objectId: string;
    };
    const richTextSpec = {
      codec: 'automergeText',
      description: 'an Automerge text value',
      validate: (value: unknown): value is RichText =>
        typeof value === 'object'
        && value !== null
        && 'text' in value
        && typeof value.text === 'string',
      toScalar: (value: unknown) => typeof value === 'object' && value !== null && 'text' in value
        ? String(value.text)
        : null
    } satisfies CustomFieldSpec<RichText>;
    const customSchema = defineSchema({
      notes: relation<{ readonly id: string; readonly body: RichText; readonly raw: unknown }>({
        key: 'id',
        fields: {
          id: stringField(),
          body: customField(richTextSpec),
          raw: opaqueField('hostObject')
        }
      })
    });
    expect(customSchema.notes.fields.body?.custom?.codec).toBe('automergeText');
    expect(customSchema.notes.fields.body?.custom).not.toHaveProperty('kind');

    expect(validateRelationRow(customSchema.notes, {
      id: 'note-1',
      body: { text: 'hello', objectId: '1@actor' },
      raw: { host: true }
    })).toEqual([]);
    expect(validateRelationRow(customSchema.notes, {
      id: 'note-1',
      body: 'plain string',
      raw: { host: true }
    } as never)).toEqual([
      expect.objectContaining({
        code: 'field_invalid',
        field: 'body'
      })
    ]);

    const db = createDb({
      notes: [
        { id: 'note-1', body: { text: 'hello', objectId: '1@actor' }, raw: { host: true } },
        { id: 'note-2', body: { text: 'bye', objectId: '2@actor' }, raw: { host: true } }
      ]
    });
    const rows = q(
      db,
      pipe(
        from(customSchema.notes),
        where(eq(field<string>('notes', 'body'), value('hello'))),
        project({ id: field<string>('notes', 'id'), body: field<string>('notes', 'body') })
      )
    );

    expect(rows).toEqual([{ id: 'note-1', body: 'hello' }]);

    const normalizedKeySchema = defineSchema({
      tags: relation<{ readonly id: string; readonly label: string }>({
        key: 'id',
        fields: {
          id: customField<string>({
            codec: 'caseInsensitiveKey',
            validate: (value): value is string => typeof value === 'string',
            toScalar: (value) => typeof value === 'string' ? value.toLowerCase() : null
          }),
          label: stringField()
        }
      })
    });
    const normalizedKeyDb = createDb({
      tags: [{ id: 'Hello', label: 'Greeting' }]
    });
    expect(validateRelationRow(normalizedKeySchema.tags, {
      id: 'Hello',
      label: 'Greeting'
    })).toEqual([]);
    expect(row(normalizedKeyDb, normalizedKeySchema.tags, 'hello')).toEqual({ id: 'Hello', label: 'Greeting' });
    expect(row(normalizedKeyDb, normalizedKeySchema.tags, 'HELLO')).toEqual({ id: 'Hello', label: 'Greeting' });

    const unsafeKeySchema = defineSchema({
      notes: relation<{ readonly id: RichText }>({
        key: 'id',
        fields: {
          id: opaqueField<RichText>('automergeText')
        }
      })
    });
    const safeKeySchema = defineSchema({
      notes: relation<{ readonly id: RichText }>({
        key: 'id',
        fields: {
          id: customField<RichText>({
            codec: 'automergeText',
            stableKey: (value) => typeof value === 'object' && value !== null && 'objectId' in value
              ? String(value.objectId)
              : ''
          })
        }
      })
    });

    expect(validateRelationRow(unsafeKeySchema.notes, {
      id: { text: 'hello', objectId: '1@actor' }
    })).toEqual([
      expect.objectContaining({
        code: 'field_invalid',
        field: 'id'
      })
    ]);
    expect(validateRelationRow(safeKeySchema.notes, {
      id: { text: 'hello', objectId: '1@actor' }
    })).toEqual([]);
    const safeKeyDb = createDb({
      notes: [
        { id: { text: 'hello', objectId: '1@actor' } },
        { id: { text: 'bye', objectId: '2@actor' } }
      ]
    });
    expect(row(safeKeyDb, safeKeySchema.notes, '1@actor')).toEqual({ id: { text: 'hello', objectId: '1@actor' } });
    expect(exists(safeKeyDb, safeKeySchema.notes, '2@actor')).toBe(true);
    expect(row(safeKeyDb, safeKeySchema.notes, { text: 'hello', objectId: '1@actor' } as never)).toBeUndefined();
    expect(tryTransact(
      safeKeyDb,
      updateByKey(safeKeySchema.notes, { text: 'hello', objectId: '1@actor' } as never, {})
    ).diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'write_patch_invalid',
        relation: 'notes',
        message: expect.stringContaining('key values')
      })
    ]));
    const invalidSafeKeyRead = () =>
      // @ts-expect-error object custom key fields are looked up by their scalar stable key.
      row(safeKeyDb, safeKeySchema.notes, { text: 'hello', objectId: '1@actor' });
    void invalidSafeKeyRead;

    const scalarObjectKeySchema = defineSchema({
      notes: relation<{ readonly id: RichText; readonly visits: number }>({
        key: 'id',
        fields: {
          id: customField<RichText>({
            codec: 'richTextObjectId',
            validate: (value): value is RichText => typeof value === 'object' && value !== null && 'objectId' in value,
            toScalar: (value) => typeof value === 'object' && value !== null && 'objectId' in value ? String(value.objectId) : null
          }),
          visits: numberField()
        }
      })
    });
    const scalarObjectKeyDb = createDb({
      notes: [
        { id: { text: 'hello', objectId: '1@actor' }, visits: 1 },
        { id: { text: 'bye', objectId: '2@actor' }, visits: 2 }
      ]
    });
    expect(row(scalarObjectKeyDb, scalarObjectKeySchema.notes, '1@actor')).toEqual({ id: { text: 'hello', objectId: '1@actor' }, visits: 1 });
    expect(exists(scalarObjectKeyDb, scalarObjectKeySchema.notes, '2@actor')).toBe(true);
    const scalarObjectUpdate = tryTransact(
      scalarObjectKeyDb,
      updateByKey(scalarObjectKeySchema.notes, '1@actor', { visits: 3 })
    );
    expect(scalarObjectUpdate.diagnostics).toEqual([]);
    expect(row(scalarObjectUpdate.db, scalarObjectKeySchema.notes, '1@actor')?.visits).toBe(3);
    const scalarObjectIncrement = tryTransact(
      scalarObjectKeyDb,
      incrementByKey(scalarObjectKeySchema.notes, '1@actor', 'visits', 2)
    );
    expect(scalarObjectIncrement.diagnostics).toEqual([]);
    expect(row(scalarObjectIncrement.db, scalarObjectKeySchema.notes, '1@actor')?.visits).toBe(3);
    const scalarObjectDelete = tryTransact(
      scalarObjectKeyDb,
      deleteByKey(scalarObjectKeySchema.notes, '2@actor')
    );
    expect(scalarObjectDelete.diagnostics).toEqual([]);
    expect(exists(scalarObjectDelete.db, scalarObjectKeySchema.notes, '2@actor')).toBe(false);
    const invalidScalarObjectRead = () =>
      // @ts-expect-error object custom key fields with toScalar are looked up by their scalar key.
      row(scalarObjectKeyDb, scalarObjectKeySchema.notes, { text: 'hello', objectId: '1@actor' });
    void invalidScalarObjectRead;

    const invalidScalarKeySchema = defineSchema({
      notes: relation<{ readonly id: RichText }>({
        key: 'id',
        fields: {
          id: customField<RichText>({
            codec: 'invalidScalarKey',
            validate: (value): value is RichText => typeof value === 'object' && value !== null && 'objectId' in value,
            toScalar: () => null
          })
        }
      })
    });
    const invalidScalarKeyRow = { id: { text: 'hello', objectId: '1@actor' } };
    expect(validateRelationRow(invalidScalarKeySchema.notes, invalidScalarKeyRow)).toEqual([
      expect.objectContaining({
        code: 'field_invalid',
        field: 'id',
        message: expect.stringContaining('string, finite number, or boolean')
      })
    ]);
    expect(rowKey(invalidScalarKeySchema.notes, invalidScalarKeyRow)).toBeUndefined();

    const throwingScalarKeySchema = defineSchema({
      tags: relation<{ readonly id: string }>({
        key: 'id',
        fields: {
          id: customField<string>({
            codec: 'throwingScalarKey',
            validate: (value): value is string => typeof value === 'string',
            toScalar: (value) => (value as string).toLowerCase()
          })
        }
      })
    });
    const invalidThrowingKeyRow = { id: 42 };
    expect(validateRelationRow(throwingScalarKeySchema.tags, invalidThrowingKeyRow)).toEqual([
      expect.objectContaining({
        code: 'field_invalid',
        field: 'id',
        message: expect.stringContaining('must be')
      })
    ]);
    expect(rowKey(throwingScalarKeySchema.tags, invalidThrowingKeyRow)).toBeUndefined();
  });

  it('installs and removes constraints through materialization inputs', () => {
    const required = req(schema.entries, 'id', 'accountId', 'amount');
    const namedRequired = req(schema.entries, ['id', 'accountId'], { name: 'entries.required' });
    const namedUnique = unique(schema.entries, ['id'], { name: 'entries.id' });
    const namedForeignKey = fk(schema.entries, 'accountId', schema.accounts, 'id', { name: 'entries.account', cascade: 'delete' });
    const namedCheck = check(from(as(schema.entries, 'entry')), gt(field('entry', 'amount'), value(-1_000_000)), { name: 'entries.amount_floor' });
    const constraints = constrain(
      required,
      namedUnique,
      namedForeignKey,
      namedCheck
    );
    const constrained = mat(openingDb, constraints, required);
    const dematerialized = demat(constrained, constraints, required);

    const tryCommit = () => tryTransact(
      constrained,
      insert(schema.entries, { id: 'bad', accountId: 'missing', amount: 10, memo: 'bad account' })
    );
    const commit = () => transact(
      constrained,
      insert(schema.entries, { id: 'e3', accountId: 'cash', amount: -20, memo: 'bank fee' })
    );

    expectTypeOf<typeof constraints>().toEqualTypeOf<ConstraintSet>();
    expectTypeOf<(typeof constraints)[number]>().toEqualTypeOf<ConstraintData>();
    expectTypeOf<typeof namedRequired>().toMatchTypeOf<ConstraintData & ConstraintOptions>();
    expectTypeOf<typeof constraints>().toMatchTypeOf<MaterializationInput>();
    expectTypeOf<(typeof constraints)[number]>().toMatchTypeOf<MaterializationInput>();
    expectTypeOf<typeof constrained>().toMatchTypeOf<MaterializedDb>();
    expectTypeOf<typeof dematerialized>().toEqualTypeOf<typeof constrained>();
    expectTypeOf<ReturnType<typeof tryCommit>>().toEqualTypeOf<DbTransactionResult<typeof constrained>>();
    expectTypeOf<ReturnType<typeof commit>>().toEqualTypeOf<typeof constrained>();

    const invalidMaterializationInput = () =>
      // @ts-expect-error mat inputs are query/constraint/metadata values, not loose options objects.
      mat(openingDb, { id: 'entries' });
    void invalidMaterializationInput;
    expect(namedRequired.name).toBe('entries.required');
    expect(namedUnique.name).toBe('entries.id');
    expect(namedForeignKey).toEqual(expect.objectContaining({ name: 'entries.account', cascade: 'delete' }));
    expect(namedCheck.name).toBe('entries.amount_floor');
  });

  it('exports store snapshot types from root and the store subpath', () => {
    expectTypeOf<RootStoreSnapshot>().toEqualTypeOf<StoreSnapshot>();
    expectTypeOf<RootStoreCommitEffects>().toEqualTypeOf<StoreCommitEffects>();
    expectTypeOf<RootStoreCommitSnapshot>().toEqualTypeOf<StoreCommitSnapshot>();
  });

  it('exports materialized index helper types from root and materialization subpath', () => {
    const entry = as(schema.entries, 'entry');
    const indexedEntries = pipe(
      from(entry),
      project({
        id: entry.id,
        accountId: entry.accountId,
        amount: entry.amount
      }),
      hash(field<string>('row', 'accountId'))
    );
    const db = mat(openingDb, indexedEntries);
    const readIndex = () => materializedIndex(db, indexedEntries);
    const readRootIndex = () => rootMaterializedIndex(db, indexedEntries);
    type IndexedEntry = QueryRow<typeof indexedEntries>;

    expectTypeOf<ReturnType<typeof readIndex>>().toEqualTypeOf<MaterializedIndex<IndexedEntry> | undefined>();
    expectTypeOf<ReturnType<typeof readRootIndex>>().toEqualTypeOf<RootMaterializedIndex<IndexedEntry> | undefined>();
    expectTypeOf<RootMaterializedIndex<IndexedEntry>>().toEqualTypeOf<MaterializedIndex<IndexedEntry>>();
    expectTypeOf<MaterializationTargetValue<IndexedEntry>>().toEqualTypeOf<MaterializationTarget<IndexedEntry>>();
    expectTypeOf<MaterializedTarget<IndexedEntry>>().toEqualTypeOf<MaterializationTargetValue<IndexedEntry>>();

    const raw = readIndex();
    expect(raw?.op).toBe('hash');
    if (raw?.op !== 'hash') throw new Error('expected hash index');
    expectTypeOf<typeof raw>().toMatchTypeOf<MaterializedHashIndex<IndexedEntry>>();
    expect(raw.lookup('cash').map((row) => row.id)).toEqual(['e1']);
    expect(readRootIndex()?.op).toBe('hash');
  });

  it('adds Relic-shaped helper signatures without evaluator behavior', () => {
    const account = as(schema.accounts, 'account');
    const entry = as(schema.entries, 'entry');
    const summaryRows = pipe(
      from(entry),
      aggregate({
        groupBy: { accountId: entry.accountId },
        aggregates: {
          entryCount: count(),
          positiveCount: count(gt(entry.amount, value(0))),
          hasIncome: anyAggregate(gt(entry.amount, value(0))),
          hasNoMissingMemo: notAny(isMissing(entry.memo)),
          total: sum(entry.amount)
        }
      }),
      project({
        accountId: field<string>('row', 'accountId'),
        entryCount: field<number>('row', 'entryCount'),
        positiveCount: field<number>('row', 'positiveCount'),
        hasIncome: field<boolean>('row', 'hasIncome'),
        hasNoMissingMemo: field<boolean>('row', 'hasNoMissingMemo'),
        total: field<number>('row', 'total')
      })
    );
    const summary = as(summaryRows, 'summary');
    const byPredicate = pipe(from(entry), join(from(account), eq(entry.accountId, account.id)));
    const byClause = pipe(
      from(entry),
      join(from(account), clauses<Entry, Account>({ accountId: 'id' }))
    );
    const leftByClause = pipe(
      from(account),
      leftJoin(summaryRows, clauses<Account, QueryRow<typeof summaryRows>>({ id: 'accountId' })),
      project({
        id: account.id,
        name: account.$.name,
        entryCount: maybe(summary.entryCount),
        total: maybe(summary.total)
      })
    );
    const correlatedRows = sel(from(account), correlate<Entry, Account>({ accountId: 'id' }));
    const correlatedRow = sel1(from(account), correlate<Entry, Account>({ accountId: 'id' }));
    const wholeRow = self<Entry>();
    const hasPositiveAmount = anyAggregate(gt(entry.amount, value(0)));
    const hasNoPositiveAmount = notAny(gt(entry.amount, value(0)));
    const positiveCount = count(gt(entry.amount, value(0)));
    const predicates = [
      isNull(account.id),
      notNull(account.$.name),
      isMissing(field('entry', 'optional')),
      notMissing(entry.id)
    ];

    expectTypeOf<QueryRow<typeof byPredicate>>().toMatchTypeOf<Entry & Account>();
    expectTypeOf<QueryRow<typeof byClause>>().toMatchTypeOf<Entry & Account>();
    expectTypeOf<QueryRow<typeof leftByClause>>().toEqualTypeOf<{
      readonly id: string;
      readonly name: string;
      readonly entryCount: number | undefined;
      readonly total: number | undefined;
    }>();
    expectTypeOf<typeof hasPositiveAmount>().toMatchTypeOf<ExprData<boolean>>();
    expectTypeOf<typeof hasNoPositiveAmount>().toMatchTypeOf<ExprData<boolean>>();
    expectTypeOf<typeof positiveCount>().toMatchTypeOf<ExprData<number>>();
    expectTypeOf<typeof correlatedRows>().toEqualTypeOf<ExprData<readonly Account[]>>();
    expectTypeOf<typeof correlatedRow>().toEqualTypeOf<ExprData<Account | undefined>>();
    expectTypeOf<typeof wholeRow>().toEqualTypeOf<ExprData<Entry>>();
    expectTypeOf<(typeof predicates)[number]>().toEqualTypeOf<PredicateData>();

    const invalidJoinLeft = () =>
      // @ts-expect-error clause helpers reject keys outside the left row.
      clauses<Entry, Account>({ missingAccount: 'id' });
    const invalidJoinRight = () =>
      // @ts-expect-error clause helpers reject values outside the right row.
      clauses<Entry, Account>({ accountId: 'missingId' });
    const invalidCorrelationOuter = () =>
      // @ts-expect-error correlation helpers reject keys outside the outer row.
      correlate<Entry, Account>({ missingAccount: 'id' });
    const invalidCorrelationInner = () =>
      // @ts-expect-error correlation helpers reject values outside the inner row.
      correlate<Entry, Account>({ accountId: 'missingId' });
    void invalidJoinLeft;
    void invalidJoinRight;
    void invalidCorrelationOuter;
    void invalidCorrelationInner;
  });

  it('adds a schema-keyed seed helper for terse transaction rows', () => {
    const rows = {
      accounts: [{ id: 'cash', name: 'Cash', kind: 'asset' }],
      entries: [{ id: 'e1', accountId: 'cash', amount: 120, memo: 'invoice paid' }]
    } satisfies SchemaSeedInput<typeof schema>;
    const patches = () => seed(schema, rows);
    const commit = () => transact(openingDb, patches());

    expectTypeOf<ReturnType<typeof patches>>().toEqualTypeOf<SchemaSeedPatches<typeof schema>>();
    expectTypeOf<ReturnType<typeof commit>>().toEqualTypeOf<typeof openingDb>();

    // @ts-expect-error schema-keyed seed rows must match their relation row type.
    const invalidRows: SchemaSeedInput<typeof schema> = { entries: [{ id: 'e1' }] };
    void invalidRows;

    // @ts-expect-error deleteExact requires a complete relation row, not a partial match shape.
    const invalidDeleteExact = deleteExact(schema.entries, { id: 'e1', accountId: 'cash' });
    void invalidDeleteExact;
  });

  it('keeps watch and change tracking results free of constant kind tags', async () => {
    const target = from(schema.entries);
    const handle = watch(openingDb, target, () => undefined, { label: 'entries' });
    const registration = watchTarget(openingDb, target);
    const refresh = await handle.refresh();
    const closed = handle.unwatch();
    const closedAgain = unwatch(handle);
    const subscription = subscribeWatch(handle, () => undefined);
    const unsubscribe = subscription.unsubscribe();
    const diff = await diffQuery(openingDb, openingDb, target);

    expect('kind' in handle).toBe(false);
    expect('kind' in registration).toBe(false);
    expect('kind' in refresh).toBe(false);
    expect('kind' in closed).toBe(false);
    expect('kind' in closedAgain).toBe(false);
    expect('kind' in subscription).toBe(false);
    expect('kind' in unsubscribe).toBe(false);
    expect('kind' in diff).toBe(false);

    expectTypeOf<typeof handle>().toEqualTypeOf<WatchHandle<typeof openingDb, Entry>>();
    expectTypeOf<typeof registration>().toEqualTypeOf<WatchTargetRegistration<typeof openingDb, Entry>>();
    expectTypeOf<typeof refresh>().toEqualTypeOf<WatchRefreshResult<Entry>>();
    expectTypeOf<typeof closed>().toEqualTypeOf<UnwatchResult>();
    expectTypeOf<typeof subscription>().toEqualTypeOf<WatchSubscription>();
    expectTypeOf<typeof unsubscribe>().toEqualTypeOf<WatchUnsubscribeResult>();
    expectTypeOf<typeof diff>().toEqualTypeOf<QueryDiff<Entry>>();
    expectTypeOf<HasKind<WatchEvent<Entry>>>().toEqualTypeOf<false>();
    expectTypeOf<HasKind<WatchRefreshResult<Entry>>>().toEqualTypeOf<false>();
    expectTypeOf<HasKind<WatchUnsubscribeResult>>().toEqualTypeOf<false>();
    expectTypeOf<HasKind<WatchSubscription>>().toEqualTypeOf<false>();
    expectTypeOf<HasKind<WatchHandle<typeof openingDb, Entry>>>().toEqualTypeOf<false>();
    expectTypeOf<HasKind<WatchTargetRegistration<typeof openingDb, Entry>>>().toEqualTypeOf<false>();
    expectTypeOf<HasKind<UnwatchResult>>().toEqualTypeOf<false>();
    expectTypeOf<HasKind<TrackedChange<Entry>>>().toEqualTypeOf<false>();
    expectTypeOf<HasKind<WatchTargetChange<Entry>>>().toEqualTypeOf<false>();
    expectTypeOf<HasKind<QueryDiff<Entry>>>().toEqualTypeOf<false>();
    expectTypeOf<HasKind<TrackTransactResult<typeof openingDb>>>().toEqualTypeOf<false>();
    expectTypeOf<HasKind<TrackRuntimeCommitSupportedResult<number>>>().toEqualTypeOf<false>();
    expectTypeOf<HasKind<TrackRuntimeCommitUnsupportedResult<number>>>().toEqualTypeOf<false>();
    expectTypeOf<HasKind<TrackRuntimeCommitResult<number>>>().toEqualTypeOf<false>();

    // @ts-expect-error WatchHandle.kind is intentionally not public.
    expect(handle.kind).toBeUndefined();
    // @ts-expect-error WatchSubscription.kind is intentionally not public.
    expect(subscription.kind).toBeUndefined();
    // @ts-expect-error QueryDiff.kind is intentionally not public.
    expect(diff.kind).toBeUndefined();
  });

  it('trims StoreView and StoreViewSnapshot to the sync external store shape', () => {
    const view = createStore(openingDb).view(from(schema.entries));
    const snapshot = view.getSnapshot();
    const commitResult = () => createStore(openingDb).commit(
      insert(schema.entries, { id: 'e3', accountId: 'cash', amount: -20, memo: 'bank fee' })
    );

    expectTypeOf<typeof snapshot>().toEqualTypeOf<StoreViewSnapshot<Entry>>();
    expectTypeOf<StoreViewSnapshot<Entry>>().toEqualTypeOf<{
      readonly rows: readonly Entry[];
      readonly diagnostics: readonly TarstateDiagnostic[];
      readonly revision: number;
      readonly queryKey: string;
      readonly version?: unknown;
    }>();
    expectTypeOf<Awaited<ReturnType<typeof commitResult>>>().toEqualTypeOf<StoreCommitResult>();
    expectTypeOf<HasKind<StoreCommitResult>>().toEqualTypeOf<false>();

    // @ts-expect-error StoreView.read is intentionally not public.
    expect(view.read).toBeUndefined();
    // @ts-expect-error StoreView.rows is intentionally not public.
    expect(view.rows).toBeUndefined();
    // @ts-expect-error StoreView.kind is intentionally not public.
    expect(view.kind).toBeUndefined();
    // @ts-expect-error StoreViewSnapshot.db is intentionally not public.
    expect(snapshot.db).toBeUndefined();
    // @ts-expect-error StoreViewSnapshot.source is intentionally not public.
    expect(snapshot.source).toBeUndefined();
    // @ts-expect-error StoreViewSnapshot.snapshot is intentionally not public.
    expect(snapshot.snapshot).toBeUndefined();
  });
});
