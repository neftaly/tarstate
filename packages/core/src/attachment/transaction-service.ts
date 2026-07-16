import { sha256Json, type ContentHash } from '../canonical-json.js';
import type { ReadyAttachmentPreparation } from './preparation.js';
import { createIssue, TarstateParseError, type Issue } from '../issues.js';
import { detachAndFreezeJsonValue } from '../internal-owned-json.js';
import type { OperationLedgerProtocol } from '../lifecycle-governance.js';
import { authorExactKeyedRelationDelta } from '../relation-delta-authoring.js';
import type { CapabilityRegistry } from '../registry.js';
import type { StagedBasisAtomicSource, StorageBinding } from '../source-protocol.js';
import {
  executeReplayablePreparedTransaction,
  prepareWritableExecutionContext,
  simulateReplayablePreparedTransaction,
  type PreparedWritableExecutionContext,
  type PreparedTransactionQueryService
} from '../transaction-executor.js';
import { sealTransaction, type CommitReceipt } from '../transaction.js';
import type { JsonValue } from '../value.js';
import type { WritableLogicalState } from '../logical-edit.js';
import type {
  DatabaseTransactionOptions,
  DatabaseTransactionService,
  DatabaseTransactionTransform
} from '../database/transaction.js';
import { ImmutableDatabaseTransactionSnapshot } from './transaction-snapshot.js';

type WritableAttachmentPreparation = Pick<
  ReadyAttachmentPreparation<unknown, unknown, WritableLogicalState>,
  'writable' | 'declaration' | 'schema' | 'relations' | 'constraints'
>;

type PreparedWritableAttachment = WritableAttachmentPreparation & {
  readonly writable: true;
  readonly declaration: NonNullable<WritableAttachmentPreparation['declaration']>;
  readonly schema: NonNullable<WritableAttachmentPreparation['schema']>;
};

export type AttachmentTransactionServiceInput<Storage, Command> = {
  readonly attachmentId: string;
  readonly attachmentIncarnation: string;
  readonly authorityScope: string;
  readonly preparation: WritableAttachmentPreparation;
  readonly source: StagedBasisAtomicSource<Storage, Command>;
  readonly bindings: readonly StorageBinding<Storage, Command>[];
  readonly registry: CapabilityRegistry;
  readonly durability: 'memory' | 'local' | 'persisted';
  readonly operationLedger?: OperationLedgerProtocol<CommitReceipt>;
};

/** Combines portable attachment evidence with one live source and authority view. */
export const createAttachmentTransactionService = async <Storage, Command>(
  input: AttachmentTransactionServiceInput<Storage, Command>
): Promise<DatabaseTransactionService> => {
  assertWritablePreparation(input.preparation);
  const preparation = input.preparation;
  const context = await createExecutionContext(input, preparation);
  const snapshotOwner = Object.freeze({});
  const prepareInput = async (
    intent: JsonValue,
    transform: DatabaseTransactionTransform,
    options: DatabaseTransactionOptions
  ) => {
    if (typeof transform !== 'function') throw new TypeError('Attachment transaction transform must be a function');
    const ownedIntent = detachAndFreezeJsonValue(intent);
    if (!ownedIntent.success) throw new TarstateParseError(ownedIntent.issues);
    return {
      operationId: globalThis.crypto.randomUUID(),
      intentHash: await attachmentIntentHash(context, ownedIntent.value),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      author: async ({ state, issues }: { readonly state: WritableLogicalState; readonly issues: readonly Issue[] }) =>
        authorStateTransition(context, preparation, input.registry, snapshotOwner, state, issues, transform)
    };
  };
  const service: DatabaseTransactionService = {
    transact: async (
      intent: JsonValue,
      transform: DatabaseTransactionTransform,
      options: DatabaseTransactionOptions = {}
    ) => {
      return executeReplayablePreparedTransaction(context, await prepareInput(intent, transform, options));
    },
    simulate: async (intent, transform, options = {}) =>
      simulateReplayablePreparedTransaction(context, await prepareInput(intent, transform, options))
  };
  return Object.freeze(service);
};

const createExecutionContext = async <Storage, Command>(
  input: AttachmentTransactionServiceInput<Storage, Command>,
  preparation: PreparedWritableAttachment
): Promise<PreparedWritableExecutionContext<Storage, Command>> => {
  if (input.authorityScope.length === 0) throw new TypeError('Attachment transaction authorityScope must not be empty');
  const snapshot = input.source.snapshot();
  const registryFingerprint = await input.registry.fingerprint();
  const relations = [...preparation.relations.values()].map(({ relationId, keyFields, replaceableFields }) => ({
    relationId,
    keyFields,
    replaceableFields
  }));
  const attachmentFingerprint = await sha256Json({
    attachmentId: input.attachmentId,
    attachmentIncarnation: input.attachmentIncarnation,
    sourceId: input.source.sourceId,
    schemaView: preparation.declaration.storageSchema,
    relations
  } as unknown as JsonValue);
  const authorityViewFingerprint = await sha256Json({
    authorityScope: input.authorityScope,
    registryFingerprint
  });
  return prepareWritableExecutionContext({
    attachmentId: input.attachmentId,
    attachmentIncarnation: input.attachmentIncarnation,
    attachmentFingerprint,
    authorityViewFingerprint,
    writable: true,
    schemaView: preparation.declaration.storageSchema,
    source: input.source,
    operationEpoch: snapshot.operationEpoch,
    bindings: input.bindings,
    relationKeys: new Map([...preparation.relations].map(([relationId, relation]) => [relationId, relation.keyFields])),
    query: unavailableQueryService,
    constraints: preparation.constraints,
    satisfiesCapability: (capability) => input.registry.satisfies(capability),
    durability: input.durability,
    ...(input.operationLedger === undefined ? {} : { operationLedger: input.operationLedger })
  });
};

const assertWritablePreparation: (
  preparation: WritableAttachmentPreparation
) => asserts preparation is PreparedWritableAttachment = (preparation) => {
  if (!preparation.writable || preparation.declaration === undefined || preparation.schema === undefined) {
    throw new TypeError('Attachment transaction service requires a writable prepared database attachment');
  }
};

const authorStateTransition = async <Storage, Command>(
  context: PreparedWritableExecutionContext<Storage, Command>,
  preparation: PreparedWritableAttachment,
  registry: CapabilityRegistry,
  snapshotOwner: object,
  before: WritableLogicalState,
  projectionIssues: readonly Issue[],
  transform: DatabaseTransactionTransform
) => {
  const statements = [];
  if (!projectionIssues.some(({ severity }) => severity === 'error')) {
    const beforeByRelation = groupTransactionFields(before.rows);
    const snapshot = new ImmutableDatabaseTransactionSnapshot({
      owner: snapshotOwner,
      schemaView: context.schemaView,
      schema: preparation.schema,
      availableRelations: preparation.relations,
      registry,
      rowsByRelation: beforeByRelation,
      changedRelationIds: emptyChangedRelationIds
    });
    const transformed = await transform(snapshot);
    if (!(transformed instanceof ImmutableDatabaseTransactionSnapshot)
      || !transformed.belongsTo(snapshotOwner)) {
      throw new TypeError('Attachment transaction transform must return a snapshot created by this service');
    }
    const afterByRelation = transformed.relationRows();
    for (const relationId of transformed.changedRelations()) {
      const relation = preparation.relations.get(relationId);
      if (relation === undefined) throw new TypeError(`Transaction relation ${JSON.stringify(relationId)} is unavailable`);
      const authored = authorExactKeyedRelationDelta({
        relation: { relationId, schemaView: context.schemaView },
        keyFields: relation.keyFields,
        replaceableFields: relation.replaceableFields,
        before: { completeness: 'exact', rows: beforeByRelation.get(relationId) ?? emptyTransactionFields },
        after: { completeness: 'exact', rows: afterByRelation.get(relationId) ?? emptyTransactionFields }
      });
      if (!authored.success) throw new TarstateParseError(authored.issues);
      statements.push(...authored.value);
    }
  }
  return sealTransaction({ body: {
    schemaView: context.schemaView,
    parameters: {},
    statements,
    guards: [],
    requiredCapabilities: []
  } });
};

const emptyTransactionFields: readonly Readonly<Record<string, JsonValue>>[] = Object.freeze([]);
const emptyChangedRelationIds: ReadonlySet<string> = new Set<string>();

/** Groups one adopted logical state once before per-relation delta authoring. */
const groupTransactionFields = (
  rows: readonly { readonly relationId: string; readonly fields: Readonly<Record<string, JsonValue>> }[]
): ReadonlyMap<string, readonly Readonly<Record<string, JsonValue>>[]> => {
  const grouped = new Map<string, Readonly<Record<string, JsonValue>>[]>();
  for (const { relationId, fields } of rows) {
    const relationRows = grouped.get(relationId);
    if (relationRows === undefined) grouped.set(relationId, [fields]);
    else relationRows.push(fields);
  }
  for (const relationRows of grouped.values()) Object.freeze(relationRows);
  return grouped;
};

const unavailableQueryService: PreparedTransactionQueryService = {
  evaluate: () => ({
    rows: [],
    resultKeys: [],
    completeness: 'unknown',
    issues: [createIssue({ code: 'transaction.capability_unavailable', details: { capability: 'query-evaluator' } })]
  })
};

const attachmentIntentHash = <Storage, Command>(
  context: PreparedWritableExecutionContext<Storage, Command>,
  intent: JsonValue
): Promise<ContentHash> => sha256Json({
  operationEpoch: context.operationEpoch,
  attachmentId: context.attachmentId,
  attachmentFingerprint: context.attachmentFingerprint,
  authorityViewFingerprint: context.authorityViewFingerprint,
  intent
});
