import { type JsonValue, type PortableValue } from './value.js';
import { createIssue, type CapabilityRef, type Issue, type ParseResult } from './issues.js';
import { safeParseJsonText, type ArtifactParseBudget } from './artifacts.js';
import { isContentHash, type ContentHash } from './canonical-json.js';
import { detachAndFreezeJsonValue, freezeOwnedJsonValue } from './internal-owned-json.js';
import type { SourceBasis } from './source-state.js';
import type { NonAtomicBatchReceipt } from './non-atomic-batch-model.js';
import type { CommitReceipt } from './transaction.js';

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
  const parsed = detachAndFreezeJsonValue(input);
  if (!parsed.success) return parsed;
  return parseOwnedReceipt(parsed.value);
};

const parseOwnedReceipt = (value: JsonValue): ParseResult<ForwardableReceipt> => {
  if (!isRecord(value)) return receiptFailure('receipt.invalid', { reason: 'not_record' });
  const kind = value.kind;
  const version = value.receiptVersion;
  if (typeof kind === 'string' && knownReceiptKinds.has(kind) && version === 1) {
    if (!isKnownReceiptShape(value, 0)) return receiptFailure('receipt.invalid', { reason: 'known_shape', kind });
    return { success: true, value: value as unknown as KnownReceipt, issues: [] };
  }
  const issue = createIssue({ code: 'receipt.unknown_kind_version', phase: 'parse', severity: 'warning', retry: 'never', details: { kind: typeof kind === 'string' ? kind : null, version: typeof version === 'number' ? version : null } });
  const wrapper: UnknownReceipt = Object.freeze({
    kind: 'unknown_receipt',
    receiptVersion: 1,
    original: value,
    issues: Object.freeze([issue])
  });
  return { success: true, value: wrapper, issues: wrapper.issues };
};

export const safeParseReceiptText = (text: string, budget?: ArtifactParseBudget): ParseResult<ForwardableReceipt> => {
  const parsed = safeParseJsonText(text, budget);
  return parsed.success ? parseOwnedReceipt(freezeOwnedJsonValue(parsed.value)) : parsed;
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

export type { DocumentDeclaration } from './attachment/model.js';

const knownReceiptKinds = new Set(['commit', 'non-atomic-batch', 'source-lifecycle', 'governance', 'sequence', 'presence']);
const receiptFailure = (code: string, details: JsonValue): ParseResult<never> => ({ success: false, issues: [createIssue({ code, phase: 'parse', severity: 'error', retry: 'after_input', details })] });
const isRecord = (value: JsonValue): value is Readonly<Record<string, JsonValue>> => value !== null && typeof value === 'object' && !Array.isArray(value);

const isKnownReceiptShape = (value: Readonly<Record<string, JsonValue>>, depth: number): boolean => {
  if (depth > 8 || value.receiptVersion !== 1 || !isIssueArray(value.issues)) return false;
  if (value.kind === 'commit') {
    const outcomeShape = value.outcome === 'committed'
      ? value.beforeBasis !== undefined && value.afterBasis !== undefined && includes(value.durability, ['memory', 'local', 'persisted'])
      : value.outcome === 'rejected'
        ? value.afterBasis === undefined && value.durability === undefined
        : value.outcome === 'unknown' && value.afterBasis === undefined && value.durability === 'unknown';
    return strings(value, ['operationEpoch', 'operationId', 'attachmentId', 'sourceId'])
      && hashes(value, ['transactionHash', 'intentHash', 'attachmentFingerprint'])
      && outcomeShape
      && Array.isArray(value.statementResults)
      && value.statementResults.every(isStatementResult)
      && (value.generatedKeys === undefined
        || (value.outcome !== 'rejected'
          && Array.isArray(value.generatedKeys)
          && value.generatedKeys.every(isGeneratedLogicalKey)))
      && (value.returning === undefined
        || (Array.isArray(value.returning) && value.returning.every(isReturningResult)));
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

const isStatementResult = (value: JsonValue): boolean => isRecord(value) && typeof value.statementIndex === 'number' && Number.isSafeInteger(value.statementIndex) && value.statementIndex >= 0 && ['matched', 'logicallyChanged', 'inserted', 'deleted'].every((field) => typeof value[field] === 'number' && Number.isSafeInteger(value[field]) && value[field] >= 0) && Array.isArray(value.editOutcomes) && value.editOutcomes.every(isSemanticEditOutcome) && isIssueArray(value.issues);
const isSemanticEditOutcome = (value: JsonValue): boolean => isRecord(value) && includes(value.edit, ['move', 'rekey', 'counter', 'text', 'list', 'custom']) && isCapabilityRef(value.mechanism) && Array.isArray(value.preservationLosses) && value.preservationLosses.every((loss) => typeof loss === 'string');
const isReturningResult = (value: JsonValue): boolean => isRecord(value) && strings(value, ['name', 'sourceId']) && Array.isArray(value.rows) && Array.isArray(value.resultKeys) && value.resultKeys.length === value.rows.length && value.resultKeys.every((key) => typeof key === 'string') && Object.hasOwn(value, 'basis') && isIssueArray(value.issues);
const isGeneratedLogicalKey = (value: JsonValue): boolean => isRecord(value)
  && strings(value, ['relationId', 'token'])
  && Object.hasOwn(value, 'key');
const isBatchStep = (value: JsonValue, depth: number): boolean => isRecord(value) && strings(value, ['stepId', 'attachmentId']) && (value.sourceId === undefined || (typeof value.sourceId === 'string' && value.sourceId.length > 0)) && includes(value.outcome, ['applied', 'failed', 'unattempted', 'unknown']) && (value.receipt === undefined || (isRecord(value.receipt) && isKnownReceiptShape(value.receipt, depth + 1)));
const isSequenceStep = (value: JsonValue, depth: number): boolean => isRecord(value) && typeof value.stepId === 'string' && includes(value.outcome, ['applied', 'failed', 'unattempted', 'unknown']) && (value.receipt === undefined || (isRecord(value.receipt) && isKnownReceiptShape(value.receipt, depth + 1)));
const isIssueArray = (value: JsonValue | undefined): boolean => Array.isArray(value) && value.every(isIssue);
const isIssue = (value: JsonValue): boolean => isRecord(value)
  && strings(value, ['id', 'code'])
  && includes(value.severity, ['info', 'warning', 'error'])
  && includes(value.phase, ['resolve', 'load', 'parse', 'query', 'plan', 'constraint', 'commit', 'governance', 'lifecycle', 'presence', 'sync'])
  && (value.retry === undefined || includes(value.retry, ['never', 'after_input', 'after_refresh', 'after_capability', 'after_authority', 'query_outcome', 'manual_repair']))
  && ['sourceId', 'relationId', 'operationId'].every((field) => value[field] === undefined || typeof value[field] === 'string')
  && (value.path === undefined || Array.isArray(value.path))
  && (value.requiredCapabilities === undefined || (Array.isArray(value.requiredCapabilities) && value.requiredCapabilities.every(isCapabilityRef)));
const isCapabilityRef = (value: JsonValue | undefined): boolean => value !== undefined && isRecord(value) && strings(value, ['id', 'version']) && isContentHash(value.contractHash);
const strings = (value: Readonly<Record<string, JsonValue>>, fields: readonly string[]): boolean => fields.every((field) => typeof value[field] === 'string' && value[field].length > 0);
const hashes = (value: Readonly<Record<string, JsonValue>>, fields: readonly string[]): boolean => fields.every((field) => isContentHash(value[field]));
const includes = <Value extends string>(value: JsonValue | undefined, allowed: readonly Value[]): value is Value => typeof value === 'string' && allowed.includes(value as Value);
const optionalDurability = (value: JsonValue | undefined): boolean => value === undefined || includes(value, ['memory', 'local', 'persisted', 'unknown']);
