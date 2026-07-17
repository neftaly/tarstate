import type { ArtifactRef, ContentHash } from './artifacts.js';
import { sealTypedArtifact, type TypedArtifact, type TypedArtifactInput } from './internal-seal.js';
import { createIssue, type CapabilityRef, type Issue } from './issues.js';
import type { SourceBasis } from './source-state.js';
import type { QueryNode } from './query/model.js';
import type { JsonValue } from './value.js';
import type { GeneratedLogicalKey } from './logical-edit.js';

/** Portable expression subset used by source-local writes. */
export type WriteExpression =
  | { readonly kind: 'literal'; readonly value: JsonValue }
  | { readonly kind: 'parameter'; readonly name: string }
  | { readonly kind: 'field'; readonly alias: string; readonly name: string }
  | { readonly kind: 'compare'; readonly op: 'eq' | 'ne' | 'lt' | 'lte' | 'gt' | 'gte'; readonly left: WriteExpression; readonly right: WriteExpression }
  | { readonly kind: 'boolean'; readonly op: 'and' | 'or'; readonly args: readonly WriteExpression[] }
  | { readonly kind: 'boolean'; readonly op: 'not'; readonly arg: WriteExpression };

export type WriteRelation = {
  readonly relationId: string;
  readonly schemaView: ArtifactRef;
};

export type WriteTarget = {
  readonly relation: WriteRelation;
  readonly alias: string;
  readonly where?: WriteExpression;
};

export type InsertConflictPolicy = 'reject' | 'keep-existing' | 'replace';

export type MovePosition =
  | { readonly kind: 'beginning' }
  | { readonly kind: 'end' }
  | { readonly kind: 'before'; readonly anchor: WriteExpression }
  | { readonly kind: 'after'; readonly anchor: WriteExpression };

export type FieldEdit =
  | { readonly kind: 'edit.replace'; readonly value: WriteExpression }
  | { readonly kind: 'edit.counter-increment'; readonly amount: WriteExpression }
  | { readonly kind: 'edit.text-splice'; readonly index: WriteExpression; readonly deleteCount: WriteExpression; readonly insert: WriteExpression }
  | { readonly kind: 'edit.list-splice'; readonly index: WriteExpression; readonly deleteCount: WriteExpression; readonly values: readonly WriteExpression[]; readonly requires: CapabilityRef }
  | { readonly kind: 'edit.conflict-resolve'; readonly observed: readonly JsonValue[]; readonly value: WriteExpression }
  | { readonly kind: 'extension'; readonly capability: CapabilityRef; readonly payload: JsonValue };

export type KeyedDeltaChange =
  | { readonly kind: 'delta.delete'; readonly key: Readonly<Record<string, WriteExpression>> }
  | { readonly kind: 'delta.insert'; readonly fields: Readonly<Record<string, WriteExpression>> }
  | {
      readonly kind: 'delta.update';
      readonly key: Readonly<Record<string, WriteExpression>>;
      readonly edits: Readonly<Record<string, FieldEdit>>;
    };

export type WriteStatement =
  | { readonly kind: 'statement.insert'; readonly relation: WriteRelation; readonly rows: readonly Readonly<Record<string, WriteExpression>>[] }
  | { readonly kind: 'statement.insert-generated-key'; readonly relation: WriteRelation; readonly token: string; readonly fields: Readonly<Record<string, WriteExpression>> }
  | { readonly kind: 'statement.insert-from-query'; readonly relation: WriteRelation; readonly root: QueryNode }
  | { readonly kind: 'statement.upsert'; readonly relation: WriteRelation; readonly rows: readonly Readonly<Record<string, WriteExpression>>[]; readonly onConflict: InsertConflictPolicy }
  | { readonly kind: 'statement.replace-all'; readonly relation: WriteRelation; readonly rows: readonly Readonly<Record<string, WriteExpression>>[] }
  | { readonly kind: 'statement.keyed-delta'; readonly relation: WriteRelation; readonly alias: string; readonly changes: readonly KeyedDeltaChange[] }
  | { readonly kind: 'statement.update'; readonly target: WriteTarget; readonly edits: Readonly<Record<string, FieldEdit>> }
  | { readonly kind: 'statement.delete'; readonly target: WriteTarget }
  | { readonly kind: 'statement.rekey'; readonly target: WriteTarget; readonly key: Readonly<Record<string, WriteExpression>>; readonly references: 'source-local-declared' | 'reject-if-referenced'; readonly requires: CapabilityRef }
  | { readonly kind: 'statement.move'; readonly target: WriteTarget; readonly parent: WriteExpression; readonly position: MovePosition; readonly missingAnchor: 'reject' | 'beginning' | 'end'; readonly requires: CapabilityRef }
  | { readonly kind: 'extension'; readonly capability: CapabilityRef; readonly payload: JsonValue };

export type TransactionGuard =
  | { readonly kind: 'guard.affected-count'; readonly statementIndex: number; readonly count: 'matched' | 'logicallyChanged' | 'inserted' | 'deleted'; readonly op: 'eq' | 'gte' | 'lte'; readonly value: number }
  | { readonly kind: 'guard.query'; readonly root: QueryNode; readonly expect: 'exists' | 'empty' }
  | { readonly kind: 'extension'; readonly capability: CapabilityRef; readonly payload: JsonValue };

export type TransactionBody = {
  readonly schemaView: ArtifactRef;
  readonly parameters: Readonly<Record<string, JsonValue>>;
  readonly statements: readonly WriteStatement[];
  readonly guards: readonly TransactionGuard[];
  readonly returning?: readonly { readonly name: string; readonly root: QueryNode }[];
  readonly requiredCapabilities: readonly CapabilityRef[];
};

export type Transaction = TypedArtifact<'transaction', TransactionBody>;

/** Host-only attempt fields select a source attachment; bound values remain in Transaction.body. */
export type TransactionAttempt = {
  readonly operationEpoch: string;
  readonly operationId: string;
  readonly attachmentId: string;
  readonly transaction: Transaction | ArtifactRef;
  readonly expectedBasis?: SourceBasis;
  readonly signal?: AbortSignal;
};

export type SemanticEditOutcome = {
  readonly edit: 'move' | 'rekey' | 'counter' | 'text' | 'list' | 'custom';
  readonly mechanism: CapabilityRef;
  readonly preservationLosses: readonly string[];
};

export type StatementResult = {
  readonly statementIndex: number;
  readonly matched: number;
  readonly logicallyChanged: number;
  readonly inserted: number;
  readonly deleted: number;
  readonly editOutcomes: readonly SemanticEditOutcome[];
  readonly issues: readonly Issue[];
};

export type ReturningResult = {
  readonly name: string;
  readonly rows: readonly unknown[];
  readonly resultKeys: readonly string[];
  readonly sourceId: string;
  readonly basis: SourceBasis;
  readonly issues: readonly Issue[];
};

type CommitReceiptEvidence = {
  readonly kind: 'commit';
  readonly receiptVersion: 1;
  readonly operationEpoch: string;
  readonly operationId: string;
  readonly transactionHash: ContentHash;
  readonly intentHash: ContentHash;
  readonly attachmentId: string;
  readonly attachmentFingerprint: ContentHash;
  readonly sourceId: string;
  readonly statementResults: readonly StatementResult[];
  readonly generatedKeys?: readonly GeneratedLogicalKey[];
  readonly returning?: readonly ReturningResult[];
  readonly issues: readonly Issue[];
};

/**
 * Authoritative transaction outcome. Committed receipts prove both bases and
 * known durability; rejected and unknown outcomes make no after-basis claim.
 */
export type CommitReceipt = CommitReceiptEvidence & (
  | { readonly outcome: 'committed'; readonly beforeBasis: SourceBasis; readonly afterBasis: SourceBasis; readonly durability: 'memory' | 'local' | 'persisted' }
  | { readonly outcome: 'rejected'; readonly beforeBasis?: SourceBasis }
  | { readonly outcome: 'unknown'; readonly beforeBasis?: SourceBasis; readonly durability: 'unknown' }
);

/** Pure preflight evidence; it never claims durability or mutates a source. */
export type SimulationReceipt = Omit<CommitReceiptEvidence, 'kind'> & {
  readonly kind: 'simulation';
  readonly outcome: 'would-commit' | 'rejected';
  readonly beforeBasis?: SourceBasis;
  readonly afterBasis?: SourceBasis;
  readonly stagedState?: unknown;
};

export type NonAtomicBatch = {
  readonly batchId: string;
  readonly failurePolicy: 'stop' | 'continue';
  readonly steps: readonly {
    readonly stepId: string;
    readonly attempt: TransactionAttempt;
  }[];
};

export type NonAtomicBatchStepReceipt = {
  readonly stepId: string;
  readonly attachmentId: string;
  /** Absent only when shell-owned membership resolution itself failed. */
  readonly sourceId?: string;
  readonly capturedBasis?: SourceBasis;
  readonly outcome: 'applied' | 'failed' | 'unattempted' | 'unknown';
  readonly receipt?: CommitReceipt;
};

export type NonAtomicBatchReceipt = {
  readonly kind: 'non-atomic-batch';
  readonly receiptVersion: 1;
  readonly batchId: string;
  readonly outcome: 'complete' | 'partial' | 'failed' | 'unknown';
  readonly steps: readonly NonAtomicBatchStepReceipt[];
  readonly issues: readonly Issue[];
};

export type NonAtomicBatchExecutor = {
  /** Resolves shell-owned attachment membership before a step is attempted. */
  readonly sourceIdFor: (attempt: TransactionAttempt) => string;
  readonly commit: (attempt: TransactionAttempt) => Promise<CommitReceipt>;
};

/**
 * Sequential, deliberately non-atomic shell orchestration. Known nested
 * receipts are retained verbatim; this function performs no rollback or retry.
 */
export const executeNonAtomicBatch = async (
  batch: NonAtomicBatch,
  executor: NonAtomicBatchExecutor
): Promise<NonAtomicBatchReceipt> => {
  if (new Set(batch.steps.map(({ stepId }) => stepId)).size !== batch.steps.length) {
    const issue = createIssue({ code: 'transaction.batch_step_id_duplicate', phase: 'commit', severity: 'error', retry: 'after_input', details: { batchId: batch.batchId } });
    return {
      kind: 'non-atomic-batch',
      receiptVersion: 1,
      batchId: batch.batchId,
      outcome: 'failed',
      steps: batch.steps.map((step) => ({ stepId: step.stepId, attachmentId: step.attempt.attachmentId, ...(step.attempt.expectedBasis === undefined ? {} : { capturedBasis: step.attempt.expectedBasis }), outcome: 'unattempted' })),
      issues: [issue]
    };
  }
  const steps: NonAtomicBatchStepReceipt[] = [];
  const issues: Issue[] = [];
  let stopped = false;
  for (const step of batch.steps) {
    const unresolved = { stepId: step.stepId, attachmentId: step.attempt.attachmentId, ...(step.attempt.expectedBasis === undefined ? {} : { capturedBasis: step.attempt.expectedBasis }) };
    if (stopped) { steps.push({ ...unresolved, outcome: 'unattempted' }); continue; }
    let sourceId: string;
    try {
      sourceId = executor.sourceIdFor(step.attempt);
    } catch (error) {
      const issue = createIssue({ code: 'transaction.batch_step_outcome_unknown', phase: 'commit', severity: 'error', retry: 'query_outcome', details: { stepId: step.stepId, reason: 'source_resolution_failed', error: error instanceof Error ? error.name : typeof error } });
      steps.push({ ...unresolved, outcome: 'unknown' });
      issues.push(issue);
      if (batch.failurePolicy === 'stop') stopped = true;
      continue;
    }
    const common = {
      stepId: step.stepId,
      attachmentId: step.attempt.attachmentId,
      sourceId,
      ...(step.attempt.expectedBasis === undefined ? {} : { capturedBasis: step.attempt.expectedBasis })
    };
    try {
      const receipt = await executor.commit(step.attempt);
      const outcome = receipt.outcome === 'committed' ? 'applied' : receipt.outcome === 'rejected' ? 'failed' : 'unknown';
      steps.push({ ...common, outcome, receipt });
      issues.push(...receipt.issues);
      if (batch.failurePolicy === 'stop' && outcome !== 'applied') stopped = true;
    } catch (error) {
      const issue = createIssue({
        code: 'transaction.batch_step_outcome_unknown',
        phase: 'commit',
        severity: 'error',
        retry: 'query_outcome',
        operationId: step.attempt.operationId,
        details: { stepId: step.stepId, error: error instanceof Error ? error.name : typeof error }
      });
      steps.push({ ...common, outcome: 'unknown' });
      issues.push(issue);
      if (batch.failurePolicy === 'stop') stopped = true;
    }
  }
  const outcomes = steps.map(({ outcome }) => outcome);
  const outcome = outcomes.includes('unknown')
    ? 'unknown'
    : outcomes.every((stepOutcome) => stepOutcome === 'applied')
      ? 'complete'
      : outcomes.includes('applied')
        ? 'partial'
        : 'failed';
  return { kind: 'non-atomic-batch', receiptVersion: 1, batchId: batch.batchId, outcome, steps, issues };
};

export const sealTransaction = (input: TypedArtifactInput<TransactionBody>): Promise<Transaction> => sealTypedArtifact('transaction', input);
