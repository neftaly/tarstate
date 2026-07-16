import * as Automerge from '@automerge/automerge';
import {
  prepareDatabaseAttachment,
  type AttachmentConstraintQuery,
  type ReadyAttachmentPreparation
} from '@tarstate/core/attachment/prepare';
import {
  builtInCapabilityRefs,
  CapabilityRegistry,
  registerBuiltInCapabilities
} from '@tarstate/core/capabilities';
import {
  createAttachmentTransactionService,
  type AttachmentTransactionService
} from '@tarstate/core/attachment/transact';
import type { WritableLogicalState } from '@tarstate/core/transactions';
import {
  createIssue,
  safeParseJsonValue,
  type JsonValue,
  type ParseResult
} from '@tarstate/core/foundation';
import { adoptConflictFreeAutomergeJsonValue } from './automerge-json.js';
import { AutomergeAtomicSource } from './core-adapter.js';
import { AutomergeMappedStorageBinding } from './mapping-storage-binding.js';
import {
  automergeRepoSourceRuntime,
  type AutomergeRepoHandle,
  type AutomergeSourceCommand
} from './source.js';

export type OpenAutomergeAttachmentInput<T extends object, Heads> = {
  readonly handle: AutomergeRepoHandle<T, Heads>;
  readonly declaration: unknown;
  readonly embeddedArtifacts: unknown;
  readonly authorityScope: string;
  readonly attachmentId?: string;
  readonly registry?: CapabilityRegistry;
  readonly evaluateConstraintQuery?: AttachmentConstraintQuery<WritableLogicalState>;
};

export type OpenAutomergeAttachment = AttachmentTransactionService & {
  readonly close: () => void;
};

/** Opens the standard writable Automerge attachment path without exposing heads, bindings, or execution contexts. */
export const openAutomergeAttachment = async <T extends object, Heads>(
  input: OpenAutomergeAttachmentInput<T, Heads>
): Promise<ParseResult<OpenAutomergeAttachment>> => {
  const declaration = adoptBoundaryJson(input.declaration);
  if (!declaration.success) return declaration;
  const embedded = adoptBoundaryJson(input.embeddedArtifacts);
  if (!embedded.success) return embedded;
  if (!Array.isArray(embedded.value)) return failure('embedded_artifacts_array_required');
  const artifacts: readonly JsonValue[] = embedded.value;
  const registry = input.registry ?? await standardAutomergeRegistry();
  const sourceId = input.handle.url;
  const preparation = await prepareDatabaseAttachment<WritableLogicalState>({
    sourceId,
    bootstrap: { status: 'ready', declaration: declaration.value },
    resolveArtifact: (reference) => artifacts.find((candidate) =>
      isRecord(candidate)
      && candidate.id === reference.id
      && candidate.contentHash === reference.contentHash
    ),
    registry,
    ...(input.evaluateConstraintQuery === undefined ? {} : { evaluateConstraintQuery: input.evaluateConstraintQuery })
  });
  if (preparation.state !== 'ready') return { success: false, issues: preparation.issues };
  if (!preparation.writable || preparation.mapping === undefined) {
    return {
      success: false,
      issues: preparation.issues.length > 0
        ? preparation.issues
        : [createIssue({ code: 'transaction.attachment_unavailable', details: { reason: 'writable_mapping_required' } })]
    };
  }
  const runtime = automergeRepoSourceRuntime({ handle: input.handle });
  const source = new AutomergeAtomicSource({
    runtime,
    operationEpoch: globalThis.crypto.randomUUID(),
    ownsRuntime: true
  });
  try {
    const binding = new AutomergeMappedStorageBinding<T>({ mapping: preparation.mapping, registry });
    const transactions = await createAttachmentTransactionService<Automerge.Doc<T>, AutomergeSourceCommand<T>>({
      attachmentId: input.attachmentId ?? sourceId,
      attachmentIncarnation: globalThis.crypto.randomUUID(),
      authorityScope: input.authorityScope,
      preparation: preparation as ReadyAttachmentPreparation<unknown, unknown, WritableLogicalState>,
      source,
      bindings: [binding],
      registry,
      // The standard runtime ledger is process-local even when the document is persisted.
      durability: 'memory'
    });
    return {
      success: true,
      value: Object.freeze({ ...transactions, close: () => { source.close(); } }),
      issues: preparation.issues
    };
  } catch (error) {
    source.close();
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

const failure = (reason: string): ParseResult<never> => ({
  success: false,
  issues: [createIssue({ code: 'artifact.invalid_envelope', retry: 'after_input', details: { reason } })]
});

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
