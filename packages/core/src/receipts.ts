import { safeParseJsonValue, type JsonValue, type PortableValue } from './value.js';
import { createIssue, type CapabilityRef, type Issue, type ParseResult } from './issues.js';
import { isContentHash, safeParseJsonText, type ArtifactParseBudget, type ArtifactRef, type ContentHash } from './artifacts.js';
import type { SourceBasis } from './maintenance.js';
import type { CommitReceipt, NonAtomicBatchReceipt } from './transaction.js';

export type SourceLifecycleCommand = {
  readonly lifecycleCoordinatorId: string;
  readonly operationEpoch: string;
  readonly operationId: string;
  readonly request:
    | { readonly action: 'create'; readonly sourceCapability: CapabilityRef; readonly input: PortableValue }
    | { readonly action: 'delete'; readonly sourceId: string; readonly expectedBasis?: SourceBasis };
};

export type SourceLifecycleReceipt = {
  readonly kind: 'source-lifecycle';
  readonly receiptVersion: 1;
  readonly lifecycleCoordinatorId: string;
  readonly operationEpoch: string;
  readonly operationId: string;
  readonly commandHash: ContentHash;
  readonly action: 'create' | 'delete';
  readonly sourceId?: string;
  readonly outcome: 'committed' | 'rejected' | 'unknown';
  readonly durability?: 'memory' | 'local' | 'persisted' | 'unknown';
  readonly issues: readonly Issue[];
};

export type GovernanceReceipt = {
  readonly kind: 'governance';
  readonly receiptVersion: 1;
  readonly operationEpoch: string;
  readonly operationId: string;
  readonly commandHash: ContentHash;
  readonly sourceId: string;
  readonly action: 'initialize_declaration' | 'repair_declaration' | 'activate_constraints';
  readonly outcome: 'committed' | 'rejected' | 'unknown';
  readonly beforeBasis?: SourceBasis;
  readonly afterBasis?: SourceBasis;
  readonly selectedArtifactHashes: readonly ContentHash[];
  readonly issues: readonly Issue[];
  readonly durability?: 'memory' | 'local' | 'persisted' | 'unknown';
};

export type PresenceReceipt = {
  readonly kind: 'presence';
  readonly receiptVersion: 1;
  readonly operationId: string;
  readonly attachmentId: string;
  readonly outcome: 'accepted' | 'rejected';
  readonly issues: readonly Issue[];
};

export type SetPresenceCommand = {
  readonly operationId: string;
  readonly attachmentId: string;
  readonly sessionId: string;
  readonly action: 'set' | 'clear';
  readonly value?: JsonValue;
};

export type SequenceNestedReceipt = CommitReceipt | NonAtomicBatchReceipt | SourceLifecycleReceipt | GovernanceReceipt;
export type SequenceReceipt = {
  readonly kind: 'sequence';
  readonly receiptVersion: 1;
  readonly sequenceId: string;
  readonly outcome: 'complete' | 'partial' | 'failed' | 'unknown';
  readonly steps: readonly { readonly stepId: string; readonly outcome: 'applied' | 'failed' | 'unattempted' | 'unknown'; readonly receipt?: SequenceNestedReceipt }[];
  readonly orphanedSourceIds: readonly string[];
  readonly issues: readonly Issue[];
};

export type UnknownReceipt = {
  readonly kind: 'unknown_receipt';
  readonly receiptVersion: 1;
  readonly original: JsonValue;
  readonly issues: readonly Issue[];
};

export type KnownReceipt = CommitReceipt | NonAtomicBatchReceipt | SourceLifecycleReceipt | GovernanceReceipt | SequenceReceipt | PresenceReceipt;
export type ForwardableReceipt = KnownReceipt | UnknownReceipt;

export const safeParseReceipt = (input: unknown): ParseResult<ForwardableReceipt> => {
  const parsed = safeParseJsonValue(input);
  if (!parsed.success) return parsed;
  if (!isRecord(parsed.value)) return receiptFailure('receipt.invalid', { reason: 'not_record' });
  const kind = parsed.value.kind;
  const version = parsed.value.receiptVersion;
  if (typeof kind === 'string' && knownReceiptKinds.has(kind) && version === 1) {
    if (!isKnownReceiptShape(parsed.value, 0)) return receiptFailure('receipt.invalid', { reason: 'known_shape', kind });
    return { success: true, value: parsed.value as unknown as KnownReceipt, issues: [] };
  }
  const issue = createIssue({ code: 'receipt.unknown_kind_version', phase: 'parse', severity: 'warning', retry: 'never', details: { kind: typeof kind === 'string' ? kind : null, version: typeof version === 'number' ? version : null } });
  return { success: true, value: { kind: 'unknown_receipt', receiptVersion: 1, original: parsed.value, issues: [issue] }, issues: [issue] };
};

export const safeParseReceiptText = (text: string, budget?: ArtifactParseBudget): ParseResult<ForwardableReceipt> => {
  const parsed = safeParseJsonText(text, budget);
  return parsed.success ? safeParseReceipt(parsed.value) : parsed;
};

export const executeSequence = async (input: {
  readonly sequenceId: string;
  readonly failurePolicy?: 'stop' | 'continue';
  readonly steps: readonly { readonly stepId: string; readonly run: () => Promise<SequenceNestedReceipt> }[];
}): Promise<SequenceReceipt> => {
  if (new Set(input.steps.map(({ stepId }) => stepId)).size !== input.steps.length) {
    const issue = createIssue({ code: 'receipt.sequence_step_duplicate', phase: 'commit', severity: 'error', retry: 'after_input', details: { sequenceId: input.sequenceId } });
    return { kind: 'sequence', receiptVersion: 1, sequenceId: input.sequenceId, outcome: 'failed', steps: input.steps.map(({ stepId }) => ({ stepId, outcome: 'unattempted' })), orphanedSourceIds: [], issues: [issue] };
  }
  const steps: { stepId: string; outcome: 'applied' | 'failed' | 'unattempted' | 'unknown'; receipt?: SequenceNestedReceipt }[] = [];
  const issues: Issue[] = [];
  let stopped = false;
  for (const step of input.steps) {
    if (stopped) { steps.push({ stepId: step.stepId, outcome: 'unattempted' }); continue; }
    try {
      const receipt = await step.run();
      const nestedOutcome = receipt.outcome;
      const outcome = nestedOutcome === 'committed' || nestedOutcome === 'complete' ? 'applied' : nestedOutcome === 'unknown' ? 'unknown' : 'failed';
      steps.push({ stepId: step.stepId, outcome, receipt });
      issues.push(...receipt.issues);
      if ((input.failurePolicy ?? 'stop') === 'stop' && outcome !== 'applied') stopped = true;
    } catch (error) {
      const issue = createIssue({ code: 'receipt.sequence_step_unknown', phase: 'commit', severity: 'error', retry: 'query_outcome', details: { stepId: step.stepId, error: error instanceof Error ? error.name : typeof error } });
      steps.push({ stepId: step.stepId, outcome: 'unknown' });
      issues.push(issue);
      if ((input.failurePolicy ?? 'stop') === 'stop') stopped = true;
    }
  }
  const outcomes = steps.map(({ outcome }) => outcome);
  const outcome = outcomes.includes('unknown') ? 'unknown' : outcomes.every((value) => value === 'applied') ? 'complete' : outcomes.includes('applied') ? 'partial' : 'failed';
  const orphanedSourceIds = outcome === 'complete' ? [] : steps.flatMap((step) => step.outcome === 'applied' && step.receipt?.kind === 'source-lifecycle' && step.receipt.action === 'create' && step.receipt.sourceId !== undefined ? [step.receipt.sourceId] : []);
  return { kind: 'sequence', receiptVersion: 1, sequenceId: input.sequenceId, outcome, steps, orphanedSourceIds, issues };
};

export const executePresence = async (command: SetPresenceCommand, accept: (command: SetPresenceCommand) => Promise<readonly Issue[]> | readonly Issue[]): Promise<PresenceReceipt> => {
  const shapeInvalid = command.action === 'set' ? command.value === undefined : command.value !== undefined;
  if (shapeInvalid) return { kind: 'presence', receiptVersion: 1, operationId: command.operationId, attachmentId: command.attachmentId, outcome: 'rejected', issues: [createIssue({ code: 'presence.command_invalid', phase: 'presence', severity: 'error', retry: 'after_input' })] };
  try {
    const issues = await accept(command);
    return { kind: 'presence', receiptVersion: 1, operationId: command.operationId, attachmentId: command.attachmentId, outcome: issues.some(({ severity }) => severity === 'error') ? 'rejected' : 'accepted', issues };
  } catch (error) {
    return { kind: 'presence', receiptVersion: 1, operationId: command.operationId, attachmentId: command.attachmentId, outcome: 'rejected', issues: [createIssue({ code: 'presence.accept_failed', phase: 'presence', severity: 'error', retry: 'after_refresh', details: { error: error instanceof Error ? error.name : typeof error } })] };
  }
};

export type DocumentDeclaration = {
  readonly formatVersion: 1;
  readonly storageSchema: ArtifactRef;
  readonly projection: { readonly kind: 'storage-mapping'; readonly storageMapping: ArtifactRef } | { readonly kind: 'storage-binding'; readonly storageBinding: CapabilityRef };
  readonly constraints?: { readonly set: ArtifactRef; readonly mode: 'audit' | 'required' };
};

const knownReceiptKinds = new Set(['commit', 'non-atomic-batch', 'source-lifecycle', 'governance', 'sequence', 'presence']);
const receiptFailure = (code: string, details: JsonValue): ParseResult<never> => ({ success: false, issues: [createIssue({ code, phase: 'parse', severity: 'error', retry: 'after_input', details })] });
const isRecord = (value: JsonValue): value is Readonly<Record<string, JsonValue>> => value !== null && typeof value === 'object' && !Array.isArray(value);

const isKnownReceiptShape = (value: Readonly<Record<string, JsonValue>>, depth: number): boolean => {
  if (depth > 8 || value.receiptVersion !== 1 || !isIssueArray(value.issues)) return false;
  if (value.kind === 'commit') {
    return strings(value, ['operationEpoch', 'operationId', 'attachmentId', 'sourceId']) && hashes(value, ['transactionHash', 'intentHash', 'attachmentFingerprint']) && includes(value.outcome, ['committed', 'rejected', 'unknown']) && Array.isArray(value.statementResults) && value.statementResults.every(isStatementResult) && optionalArray(value.returning) && optionalDurability(value.durability);
  }
  if (value.kind === 'non-atomic-batch') {
    return typeof value.batchId === 'string' && includes(value.outcome, ['complete', 'partial', 'failed', 'unknown']) && Array.isArray(value.steps) && value.steps.every((step) => isBatchStep(step, depth));
  }
  if (value.kind === 'source-lifecycle') {
    return strings(value, ['lifecycleCoordinatorId', 'operationEpoch', 'operationId']) && isContentHash(value.commandHash) && includes(value.action, ['create', 'delete']) && includes(value.outcome, ['committed', 'rejected', 'unknown']) && (value.sourceId === undefined || typeof value.sourceId === 'string') && optionalDurability(value.durability);
  }
  if (value.kind === 'governance') {
    return strings(value, ['operationEpoch', 'operationId', 'sourceId']) && isContentHash(value.commandHash) && includes(value.action, ['initialize_declaration', 'repair_declaration', 'activate_constraints']) && includes(value.outcome, ['committed', 'rejected', 'unknown']) && Array.isArray(value.selectedArtifactHashes) && value.selectedArtifactHashes.every(isContentHash) && optionalDurability(value.durability);
  }
  if (value.kind === 'sequence') {
    return typeof value.sequenceId === 'string' && includes(value.outcome, ['complete', 'partial', 'failed', 'unknown']) && Array.isArray(value.orphanedSourceIds) && value.orphanedSourceIds.every((item) => typeof item === 'string') && Array.isArray(value.steps) && value.steps.every((step) => isSequenceStep(step, depth));
  }
  return value.kind === 'presence' && strings(value, ['operationId', 'attachmentId']) && includes(value.outcome, ['accepted', 'rejected']);
};

const isStatementResult = (value: JsonValue): boolean => isRecord(value) && Number.isSafeInteger(value.statementIndex) && ['matched', 'logicallyChanged', 'inserted', 'deleted'].every((field) => typeof value[field] === 'number' && Number.isSafeInteger(value[field]) && value[field] >= 0) && Array.isArray(value.editOutcomes) && isIssueArray(value.issues);
const isBatchStep = (value: JsonValue, depth: number): boolean => isRecord(value) && strings(value, ['stepId', 'attachmentId', 'sourceId']) && includes(value.outcome, ['applied', 'failed', 'unattempted', 'unknown']) && (value.receipt === undefined || (isRecord(value.receipt) && isKnownReceiptShape(value.receipt, depth + 1)));
const isSequenceStep = (value: JsonValue, depth: number): boolean => isRecord(value) && typeof value.stepId === 'string' && includes(value.outcome, ['applied', 'failed', 'unattempted', 'unknown']) && (value.receipt === undefined || (isRecord(value.receipt) && isKnownReceiptShape(value.receipt, depth + 1)));
const isIssueArray = (value: JsonValue | undefined): boolean => Array.isArray(value) && value.every((item) => isRecord(item) && strings(item, ['id', 'code', 'severity', 'phase']));
const strings = (value: Readonly<Record<string, JsonValue>>, fields: readonly string[]): boolean => fields.every((field) => typeof value[field] === 'string' && value[field].length > 0);
const hashes = (value: Readonly<Record<string, JsonValue>>, fields: readonly string[]): boolean => fields.every((field) => isContentHash(value[field]));
const includes = <Value extends string>(value: JsonValue | undefined, allowed: readonly Value[]): value is Value => typeof value === 'string' && allowed.includes(value as Value);
const optionalArray = (value: JsonValue | undefined): boolean => value === undefined || Array.isArray(value);
const optionalDurability = (value: JsonValue | undefined): boolean => value === undefined || includes(value, ['memory', 'local', 'persisted', 'unknown']);
