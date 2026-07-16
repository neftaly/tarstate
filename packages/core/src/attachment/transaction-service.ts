import { sha256Json, type ContentHash } from '../artifacts.js';
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

export type AttachmentTransactionRow = {
  readonly relationId: string;
  readonly fields: Readonly<Record<string, JsonValue>>;
};

export type AttachmentTransactionSnapshot = {
  readonly rows: readonly AttachmentTransactionRow[];
};

export type AttachmentTransactionOptions = {
  readonly signal?: AbortSignal;
};

export type AttachmentTransactionService = {
  readonly transact: (
    intent: JsonValue,
    transform: (snapshot: AttachmentTransactionSnapshot) => unknown,
    options?: AttachmentTransactionOptions
  ) => Promise<CommitReceipt>;
  readonly simulate: (
    intent: JsonValue,
    transform: (snapshot: AttachmentTransactionSnapshot) => unknown,
    options?: AttachmentTransactionOptions
  ) => Promise<import('../transaction.js').SimulationReceipt>;
};

export type AttachmentTransactionServiceInput<Storage, Command> = {
  readonly attachmentId: string;
  readonly attachmentIncarnation: string;
  readonly authorityScope: string;
  readonly preparation: ReadyAttachmentPreparation<unknown, unknown, WritableLogicalState>;
  readonly source: StagedBasisAtomicSource<Storage, Command>;
  readonly bindings: readonly StorageBinding<Storage, Command>[];
  readonly registry: CapabilityRegistry;
  readonly durability: 'memory' | 'local' | 'persisted';
  readonly operationLedger?: OperationLedgerProtocol<CommitReceipt>;
};

/** Combines portable attachment evidence with one live source and authority view. */
export const createAttachmentTransactionService = async <Storage, Command>(
  input: AttachmentTransactionServiceInput<Storage, Command>
): Promise<AttachmentTransactionService> => {
  const context = await createExecutionContext(input);
  const prepareInput = async (
    intent: JsonValue,
    transform: (snapshot: AttachmentTransactionSnapshot) => unknown,
    options: AttachmentTransactionOptions
  ) => {
    if (typeof transform !== 'function') throw new TypeError('Attachment transaction transform must be a function');
    const ownedIntent = detachAndFreezeJsonValue(intent);
    if (!ownedIntent.success) throw new TarstateParseError(ownedIntent.issues);
    return {
      operationId: globalThis.crypto.randomUUID(),
      intentHash: await attachmentIntentHash(context, ownedIntent.value),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      author: async ({ state, issues }: { readonly state: WritableLogicalState; readonly issues: readonly Issue[] }) =>
        authorStateTransition(context, input.preparation, state, issues, transform)
    };
  };
  const service: AttachmentTransactionService = {
    transact: async (
      intent: JsonValue,
      transform: (snapshot: AttachmentTransactionSnapshot) => unknown,
      options: AttachmentTransactionOptions = {}
    ) => {
      return executeReplayablePreparedTransaction(context, await prepareInput(intent, transform, options));
    },
    simulate: async (intent, transform, options = {}) =>
      simulateReplayablePreparedTransaction(context, await prepareInput(intent, transform, options))
  };
  return Object.freeze(service);
};

const createExecutionContext = async <Storage, Command>(
  input: AttachmentTransactionServiceInput<Storage, Command>
): Promise<PreparedWritableExecutionContext<Storage, Command>> => {
  if (!input.preparation.writable || input.preparation.declaration === undefined || input.preparation.schema === undefined) {
    throw new TypeError('Attachment transaction service requires a writable prepared database attachment');
  }
  if (input.authorityScope.length === 0) throw new TypeError('Attachment transaction authorityScope must not be empty');
  const snapshot = input.source.snapshot();
  const registryFingerprint = await input.registry.fingerprint();
  const relations = [...input.preparation.relations.values()].map(({ relationId, keyFields, replaceableFields }) => ({
    relationId,
    keyFields,
    replaceableFields
  }));
  const attachmentFingerprint = await sha256Json({
    attachmentId: input.attachmentId,
    attachmentIncarnation: input.attachmentIncarnation,
    sourceId: input.source.sourceId,
    schemaView: input.preparation.declaration.storageSchema,
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
    schemaView: input.preparation.declaration.storageSchema,
    source: input.source,
    operationEpoch: snapshot.operationEpoch,
    bindings: input.bindings,
    relationKeys: new Map([...input.preparation.relations].map(([relationId, relation]) => [relationId, relation.keyFields])),
    query: unavailableQueryService,
    constraints: input.preparation.constraints,
    satisfiesCapability: (capability) => input.registry.satisfies(capability),
    durability: input.durability,
    ...(input.operationLedger === undefined ? {} : { operationLedger: input.operationLedger })
  });
};

const authorStateTransition = async <Storage, Command>(
  context: PreparedWritableExecutionContext<Storage, Command>,
  preparation: ReadyAttachmentPreparation<unknown, unknown, WritableLogicalState>,
  before: WritableLogicalState,
  projectionIssues: readonly Issue[],
  transform: (snapshot: AttachmentTransactionSnapshot) => unknown
) => {
  const statements = [];
  if (!projectionIssues.some(({ severity }) => severity === 'error')) {
    const beforeRows = before.rows.map(({ relationId, fields }) => Object.freeze({ relationId, fields }));
    const transformed = await transform(Object.freeze({ rows: Object.freeze(beforeRows) }));
    const afterRows = adoptTransactionRows(transformed, preparation);
    for (const [relationId, relation] of preparation.relations) {
      const authored = authorExactKeyedRelationDelta({
        relation: { relationId, schemaView: context.schemaView },
        keyFields: relation.keyFields,
        replaceableFields: relation.replaceableFields,
        before: { completeness: 'exact', rows: beforeRows.filter((row) => row.relationId === relationId).map(({ fields }) => fields) },
        after: { completeness: 'exact', rows: afterRows.filter((row) => row.relationId === relationId).map(({ fields }) => fields) }
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

const adoptTransactionRows = (
  input: unknown,
  preparation: ReadyAttachmentPreparation<unknown, unknown, WritableLogicalState>
): readonly AttachmentTransactionRow[] => {
  const owned = detachAndFreezeJsonValue(input);
  if (!owned.success) throw new TarstateParseError(owned.issues);
  if (!Array.isArray(owned.value)) throw new TarstateParseError([rowIssue('array_required')]);
  const rows: AttachmentTransactionRow[] = [];
  for (const [rowIndex, candidate] of owned.value.entries()) {
    if (!isRecord(candidate)
      || typeof candidate.relationId !== 'string'
      || !preparation.relations.has(candidate.relationId)
      || !isRecord(candidate.fields)) {
      throw new TarstateParseError([rowIssue('row_shape', rowIndex)]);
    }
    rows.push(candidate as unknown as AttachmentTransactionRow);
  }
  return Object.freeze(rows);
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

const rowIssue = (reason: string, rowIndex?: number): Issue => createIssue({
  code: 'transaction.insert_query_row_invalid',
  retry: 'after_input',
  ...(rowIndex === undefined ? {} : { path: [rowIndex] }),
  details: { reason }
});

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
