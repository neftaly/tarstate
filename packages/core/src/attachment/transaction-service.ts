import { sha256Json, type ContentHash } from '../canonical-json.js';
import type { ReadyAttachmentPreparation } from './preparation.js';
import { createIssue, TarstateParseError, type Issue } from '../issues.js';
import { detachAndFreezeJsonValue } from '../internal-owned-json.js';
import type { OperationLedgerProtocol } from '../lifecycle-governance.js';
import type { CapabilityRegistry } from '../registry.js';
import type { StagedBasisAtomicSource, StorageBinding } from '../source-protocol.js';
import {
  executeReplayablePreparedTransaction,
  prepareWritableExecutionContext,
  simulateReplayablePreparedTransaction,
  type PreparedWritableExecutionContext,
  type PreparedTransactionQueryService
} from '../transaction-executor.js';
import type { CommitReceipt } from '../transaction.js';
import type { JsonValue } from '../value.js';
import type { WritableLogicalState } from '../logical-edit.js';
import type {
  DatabaseRelationWriteCapabilities,
  DatabaseTransactionOptions,
  DatabaseTransactionService,
  DatabaseTransactionTransform
} from '../database/transaction.js';
import { authorAttachmentStateTransition } from './transaction-state-authoring.js';

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
  const writeCapabilities = preparedWriteCapabilities(preparation);
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
      author: ({
        state,
        issues
      }: {
        readonly state: WritableLogicalState;
        readonly issues: readonly Issue[];
      }) => authorAttachmentStateTransition({
        schemaView: context.schemaView,
        preparation,
        registry: input.registry,
        snapshotOwner,
        before: state,
        projectionIssues: issues,
        transform
      })
    };
  };
  const service: DatabaseTransactionService = {
    writeCapabilities: (relation) => {
      if (relation.schemaView.id !== context.schemaView.id
        || relation.schemaView.contentHash !== context.schemaView.contentHash) {
        throw new TypeError('Write-capability relation belongs to a different schema view');
      }
      const capabilities = writeCapabilities.get(relation.relationId);
      if (capabilities === undefined) {
        throw new TypeError(`Write-capability relation ${JSON.stringify(relation.relationId)} is unavailable`);
      }
      return capabilities;
    },
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
  const relations = [...preparation.relations.values()].map(({
    relationId,
    keyFields,
    replaceableFields,
    sourceGeneratedFields,
    supportsGeneratedKeyInsert
  }) => ({
    relationId,
    keyFields,
    replaceableFields,
    sourceGeneratedFields,
    supportsGeneratedKeyInsert
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

const preparedWriteCapabilities = (
  preparation: PreparedWritableAttachment
): ReadonlyMap<string, DatabaseRelationWriteCapabilities> => {
  const capabilities = new Map<string, DatabaseRelationWriteCapabilities>();
  for (const [relationId, relation] of preparation.relations) {
    capabilities.set(relationId, Object.freeze({
      relationId,
      keyFields: relation.keyFields,
      replaceableFields: relation.replaceableFields,
      sourceGeneratedFields: relation.sourceGeneratedFields,
      supportsGeneratedKeyInsert: relation.supportsGeneratedKeyInsert
    }));
  }
  return capabilities;
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
