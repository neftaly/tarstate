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
  DatabaseRelationCapabilities,
  DatabaseTransactionOptions,
  DatabaseTransactionService,
  DatabaseTransactionTransform
} from '../database/transaction.js';
import { authorAttachmentStateTransition } from './transaction-state-authoring.js';

type WritableAttachmentPreparation = Pick<
  ReadyAttachmentPreparation<unknown, unknown, WritableLogicalState>,
  'writable' | 'declaration' | 'schema' | 'mapping' | 'relations' | 'constraints'
>;

type PreparedWritableAttachment = WritableAttachmentPreparation & {
  readonly writable: true;
  readonly declaration: NonNullable<WritableAttachmentPreparation['declaration']>;
  readonly schema: NonNullable<WritableAttachmentPreparation['schema']>;
  readonly mapping: NonNullable<WritableAttachmentPreparation['mapping']>;
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
  const capabilities = effectiveCapabilities(preparation, input.bindings, input.source);
  const context = await createExecutionContext(input, preparation, capabilities);
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
      intentHash: await attachmentIntentHash(context, ownedIntent.value, options.observedBasis),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(options.observedBasis === undefined ? {} : { observedBasis: options.observedBasis }),
      author: ({
        state,
        issues
      }: {
        readonly state: WritableLogicalState;
        readonly issues: readonly Issue[];
      }) => authorAttachmentStateTransition({
        schemaView: context.schemaView,
        preparation: { schema: preparation.schema, relations: capabilities },
        registry: input.registry,
        snapshotOwner,
        before: state,
        projectionIssues: issues,
        transform
      })
    };
  };
  const service: DatabaseTransactionService = {
    capabilities: (relation) => {
      if (relation.schemaView.id !== context.schemaView.id
        || relation.schemaView.contentHash !== context.schemaView.contentHash) {
        throw new TypeError('Capability relation belongs to a different schema view');
      }
      const relationCapabilities = capabilities.get(relation.relationId);
      if (relationCapabilities === undefined) {
        throw new TypeError(`Capability relation ${JSON.stringify(relation.relationId)} is unavailable`);
      }
      return relationCapabilities;
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
  preparation: PreparedWritableAttachment,
  capabilities: ReadonlyMap<string, DatabaseRelationCapabilities>
): Promise<PreparedWritableExecutionContext<Storage, Command>> => {
  if (input.authorityScope.length === 0) throw new TypeError('Attachment transaction authorityScope must not be empty');
  const snapshot = input.source.snapshot();
  const registryFingerprint = await input.registry.fingerprint();
  const relations = [...capabilities.values()];
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
  if (!preparation.writable
    || preparation.declaration === undefined
    || preparation.schema === undefined
    || preparation.mapping === undefined) {
    throw new TypeError('Attachment transaction service requires a writable prepared database attachment');
  }
};

const effectiveCapabilities = <Storage, Command>(
  preparation: PreparedWritableAttachment,
  bindings: readonly StorageBinding<Storage, Command>[],
  source: StagedBasisAtomicSource<Storage, Command>
): ReadonlyMap<string, DatabaseRelationCapabilities> => {
  const capabilities = new Map<string, DatabaseRelationCapabilities>();
  const issues: Issue[] = [];
  for (const [relationId, relation] of preparation.relations) {
    const implementations = bindings.flatMap((binding) => {
      const capability = binding.writeCapabilities.get(relationId);
      return capability === undefined ? [] : [capability];
    });
    if (implementations.length > 1) {
      throw new TypeError(`Multiple storage bindings advertise writes for relation ${JSON.stringify(relationId)}`);
    }
    const implementation = implementations[0];
    const mapped = preparation.mapping.relations.get(relationId);
    for (const [field, fieldMapping] of Object.entries(mapped?.mapping.fields ?? {})) {
      if (fieldMapping.kind === 'absent' || fieldMapping.kind === 'source-metadata') continue;
      const support = implementation?.fields[field];
      if (fieldMapping.write.replace !== undefined && support?.replace !== true) {
        issues.push(bindingCompatibilityIssue(source.sourceId, relationId, field, 'replace'));
      }
      if (fieldMapping.write.textSplice !== undefined
        && (support?.textSplice === undefined
          || source.reconcile === undefined
          || source.commitReconciled === undefined
          || source.snapshotAt === undefined)) {
        issues.push(bindingCompatibilityIssue(source.sourceId, relationId, field, 'text-splice'));
      }
    }
    const fields: Record<string, import('../database/transaction.js').DatabaseFieldWriteCapabilities> = {};
    for (const [field, support] of Object.entries(implementation?.fields ?? {})) {
      const fieldMapping = mapped?.mapping.fields[field];
      if (fieldMapping === undefined
        || fieldMapping.kind === 'absent'
        || fieldMapping.kind === 'source-metadata') continue;
      const replace = support.replace === true && fieldMapping.write.replace !== undefined;
      const textSplice = fieldMapping.write.textSplice === undefined
        ? undefined
        : support.textSplice;
      if (!replace && textSplice === undefined) continue;
      fields[field] = Object.freeze({
        ...(replace
          ? { replace: Object.freeze({ concurrency: 'replay-transform' as const }) }
          : {}),
        ...(textSplice === undefined
          ? {}
          : { textSplice: Object.freeze({
              indexUnit: textSplice.indexUnit,
              concurrency: 'merge-captured-intent' as const
            }) })
      });
    }
    capabilities.set(relationId, Object.freeze({
      relationId,
      keyFields: relation.keyFields,
      sourceGeneratedFields: relation.sourceGeneratedFields,
      ...(implementation?.insert === true
        ? { insert: Object.freeze({ concurrency: 'replay-transform' as const }) }
        : {}),
      ...(implementation?.delete === true
        ? { delete: Object.freeze({ concurrency: 'replay-transform' as const }) }
        : {}),
      ...(implementation?.generatedKeyInsert === true
        ? { generatedKeyInsert: Object.freeze({ concurrency: 'replay-transform' as const }) }
        : {}),
      fields: Object.freeze(fields)
    }));
  }
  if (issues.length > 0) throw new TarstateParseError(issues);
  return capabilities;
};

const bindingCompatibilityIssue = (
  sourceId: string,
  relationId: string,
  field: string,
  operation: 'replace' | 'text-splice'
): Issue => createIssue({
  code: 'mapping.binding_incompatible',
  phase: 'resolve',
  severity: 'error',
  retry: 'after_input',
  sourceId,
  relationId,
  path: ['fields', field, 'write', operation],
  details: { field, operation }
});

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
  intent: JsonValue,
  observedBasis: import('../source-state.js').SourceBasis | undefined
): Promise<ContentHash> => sha256Json({
  operationEpoch: context.operationEpoch,
  attachmentId: context.attachmentId,
  attachmentFingerprint: context.attachmentFingerprint,
  authorityViewFingerprint: context.authorityViewFingerprint,
  intent,
  ...(observedBasis === undefined ? {} : { observedBasis })
});
