import * as Automerge from '@automerge/automerge';
import {
  bindAttachmentProjection,
  createLogicalConstraintQuery,
  prepareDatabaseAttachment,
  type ReadyAttachmentPreparation
} from '@tarstate/core/attachment/adapter';
import { createAttachmentTransactionRuntime } from '@tarstate/core/attachment/retained-text-adapter';
import { createAttachmentTextIntentService } from '@tarstate/core/attachment/text-intent-adapter';
import {
  createMappedAttachmentProjector,
  createMappedDatabaseProjection,
  embeddedArtifactKey,
  indexEmbeddedArtifacts
} from '@tarstate/core/attachment/mapped-adapter';
import {
  builtInCapabilityRefs,
  CapabilityRegistry,
  registerBuiltInCapabilities
} from '@tarstate/core/capabilities';
import type { WritableLogicalState } from '@tarstate/core/transactions';
import {
  createIssue,
  safeParseJsonValue,
  TarstateParseError,
  type JsonValue,
  type ParseResult
} from '@tarstate/core';
import { adoptConflictFreeAutomergeJsonValue } from '../document/json-value.js';
import { AutomergeAtomicSource } from '../adapter/atomic-source.js';
import { AutomergeMappedStorageBinding } from '../adapter/mapped-storage.js';
import {
  createLiveAutomergeDatabase,
} from './live.js';
import type { AutomergeDatabase } from './model.js';
import {
  automergeRepoSourceRuntime,
  type AutomergeRepoHandle,
  type AutomergeSourceCommand
} from '../source/runtime.js';

export type OpenAutomergeDatabaseOptions<T extends object, Heads> = {
  readonly handle: AutomergeRepoHandle<T, Heads>;
  readonly declaration: unknown;
  readonly embeddedArtifacts: unknown;
  readonly authorityScope: string;
  readonly attachmentId?: string;
  readonly registry?: CapabilityRegistry;
};

/** Opens a writable Automerge-backed database without exposing heads, bindings, or execution contexts. */
export const openAutomergeDatabase = async <T extends object, Heads>(
  input: OpenAutomergeDatabaseOptions<T, Heads>
): Promise<ParseResult<AutomergeDatabase>> => {
  if (typeof input.authorityScope !== 'string' || input.authorityScope.length === 0) {
    throw new TypeError('authorityScope must be a non-empty string');
  }
  if (input.attachmentId !== undefined
    && (typeof input.attachmentId !== 'string' || input.attachmentId.length === 0)) {
    throw new TypeError('attachmentId must be a non-empty string');
  }
  const declaration = adoptBoundaryJson(input.declaration);
  if (!declaration.success) return declaration;
  const embedded = adoptBoundaryJson(input.embeddedArtifacts);
  if (!embedded.success) return embedded;
  const artifacts = indexEmbeddedArtifacts(embedded.value);
  if (!artifacts.success) return artifacts;
  const registry = input.registry ?? await standardAutomergeRegistry();
  const sourceId = input.handle.url;
  const attachmentId = input.attachmentId ?? sourceId;
  const preparation = await prepareDatabaseAttachment<WritableLogicalState>({
    sourceId,
    bootstrap: { status: 'ready', declaration: declaration.value },
    resolveArtifact: (reference) => artifacts.value.get(embeddedArtifactKey(reference.id, reference.contentHash)),
    registry,
    createConstraintQuery: ({ schemaView, relationIds, registry: constraintRegistry }) =>
      createLogicalConstraintQuery({
        schemaView,
        relationIds,
        registry: constraintRegistry,
        sourceId,
        attachmentId
      })
  });
  if (preparation.state !== 'ready') return { success: false, issues: preparation.issues };
  if (!preparation.writable || preparation.mapping === undefined || preparation.declaration === undefined) {
    return {
      success: false,
      issues: preparation.issues.length > 0
        ? preparation.issues
        : [createIssue({ code: 'transaction.attachment_unavailable', details: { reason: 'writable_mapping_required' } })]
    };
  }
  const sourceRuntime = automergeRepoSourceRuntime({ handle: input.handle });
  const source = new AutomergeAtomicSource({
    runtime: sourceRuntime,
    operationEpoch: globalThis.crypto.randomUUID(),
    ownsRuntime: true
  });
  try {
    const binding = new AutomergeMappedStorageBinding<T>({ mapping: preparation.mapping, registry });
    const attachmentIncarnation = globalThis.crypto.randomUUID();
    const projector = createMappedAttachmentProjector({
      binding,
      constraints: preparation.constraints
    });
    const projection = createMappedDatabaseProjection({
      projector,
      schemaView: preparation.declaration.storageSchema,
      relationIds: [...preparation.relations.keys()],
      sourceId,
      attachmentId,
      occurrenceId: (row) => row.locator.rowIncarnation
    });
    const boundPreparation = bindAttachmentProjection(
      preparation as ReadyAttachmentPreparation<unknown, unknown, WritableLogicalState>,
      projection
    );
    const transactionRuntime = await createAttachmentTransactionRuntime<Automerge.Doc<T>, AutomergeSourceCommand<T>>({
      attachmentId,
      attachmentIncarnation,
      authorityScope: input.authorityScope,
      preparation: boundPreparation,
      source,
      bindings: [binding],
      registry,
      // The standard runtime ledger is process-local even when the document is persisted.
      durability: 'memory'
    });
    const transactions = transactionRuntime.transactions;
    const textIntents = createAttachmentTextIntentService({
      transactions,
      source,
      ...(transactionRuntime.retainedText === undefined
        ? {}
        : { publication: transactionRuntime.retainedText })
    });
    return {
      success: true,
      value: createLiveAutomergeDatabase({
        attachmentId,
        incarnation: attachmentIncarnation,
        authorityScope: input.authorityScope,
        schemaView: preparation.declaration.storageSchema,
        transactions: Object.freeze({ ...transactions, ...textIntents }),
        preparation: boundPreparation,
        source,
        projector
      }),
      issues: preparation.issues
    };
  } catch (error) {
    source.close();
    if (error instanceof TarstateParseError) return { success: false, issues: error.issues };
    throw error;
  }
};

const standardAutomergeRegistry = async (): Promise<CapabilityRegistry> => {
  const registry = new CapabilityRegistry('tarstate:automerge-standard');
  await registerBuiltInCapabilities(registry);
  registry.registerImplementation({
    ref: builtInCapabilityRefs.fieldReplace,
    integrity: 'tarstate:automerge:field-replace-v1',
    implementation: Object.freeze({ kind: 'automerge-field-replace' })
  });
  registry.registerImplementation({
    ref: builtInCapabilityRefs.textSplice,
    integrity: 'tarstate:automerge:text-splice-v2',
    implementation: Object.freeze({
      kind: 'automerge-text-splice',
      indexUnit: 'utf16-code-unit',
      rangeBoundary: 'unicode-code-point',
      insertedText: 'well-formed-utf16'
    })
  });
  return registry;
};

const adoptBoundaryJson = (input: unknown): ParseResult<JsonValue> => {
  try {
    if (input !== null && typeof input === 'object' && typeof Automerge.getObjectId(input) === 'string') {
      return adoptConflictFreeAutomergeJsonValue(input);
    }
  } catch { /* Plain host JSON is handled by the ordinary parser below. */ }
  return safeParseJsonValue(input);
};
