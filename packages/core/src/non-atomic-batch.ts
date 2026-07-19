import { createIssue, type Issue } from './issues.js';
import type { SourceBasis } from './source-state.js';
import type { CommitReceipt } from './transaction.js';
import type {
  DatabaseNonAtomicBatch,
  DatabaseNonAtomicBatchStep,
  NonAtomicBatch,
  NonAtomicBatchExecutor,
  NonAtomicBatchReceipt,
  NonAtomicBatchStepReceipt
} from './non-atomic-batch-model.js';

type BatchStepOperations<Step> = {
  readonly stepId: (step: Step) => string;
  readonly attachmentId: (step: Step) => string;
  readonly capturedBasis: (step: Step) => SourceBasis | undefined;
  readonly operationId: (step: Step) => string | undefined;
  readonly sourceId: (step: Step) => string;
  readonly commit: (step: Step) => Promise<CommitReceipt>;
};

/**
 * Sequential, deliberately non-atomic shell orchestration for portable
 * transaction attempts. Known nested receipts are retained verbatim.
 */
export const executeNonAtomicBatch = (
  batch: NonAtomicBatch,
  executor: NonAtomicBatchExecutor
): Promise<NonAtomicBatchReceipt> => {
  const sourceIdFor = executor.sourceIdFor;
  const commit = executor.commit;
  return executeBatchSteps(
    { ...batch, steps: batch.steps.map(ownPortableStep) },
    {
      ...portableStepOperations,
      sourceId: (step) => sourceIdFor(step.attempt),
      commit: (step) => commit(step.attempt)
    }
  );
};

/**
 * Runs ordinary database transaction callbacks sequentially without claiming
 * cross-source atomicity, rollback, retry, or durable workflow identity.
 */
export const executeDatabaseNonAtomicBatch = (
  batch: DatabaseNonAtomicBatch
): Promise<NonAtomicBatchReceipt> => executeBatchSteps(
  {
    ...batch,
    steps: batch.steps.map(ownDatabaseStep)
  },
  databaseStepOperations
);

const executeBatchSteps = async <Step>(
  batch: {
    readonly batchId: string;
    readonly failurePolicy: 'stop' | 'continue';
    readonly steps: readonly Step[];
    readonly signal?: AbortSignal;
  },
  operations: BatchStepOperations<Step>
): Promise<NonAtomicBatchReceipt> => {
  const scheduledSteps = batch.steps;
  if (hasDuplicateStepId(scheduledSteps, operations.stepId)) {
    const issue = createIssue({
      code: 'transaction.batch_step_id_duplicate',
      phase: 'commit',
      severity: 'error',
      retry: 'after_input',
      details: { batchId: batch.batchId }
    });
    return finalizeBatch(batch.batchId, scheduledSteps.map((step) => ({
      ...unresolvedStep(step, operations),
      outcome: 'unattempted'
    })), [issue]);
  }

  const steps: NonAtomicBatchStepReceipt[] = [];
  const issues: Issue[] = [];
  let stopped = false;
  for (const step of scheduledSteps) {
    const unresolved = unresolvedStep(step, operations);
    if (!stopped && batch.signal?.aborted === true) {
      stopped = true;
      issues.push(createIssue({
        code: 'transaction.cancelled',
        phase: 'commit',
        severity: 'error',
        retry: 'never',
        details: {
          batchId: batch.batchId,
          stepId: unresolved.stepId,
          timing: 'before_batch_step'
        }
      }));
    }
    if (stopped) {
      steps.push({ ...unresolved, outcome: 'unattempted' });
      continue;
    }

    let sourceId: string;
    try {
      sourceId = operations.sourceId(step);
    } catch (error) {
      const issue = unknownStepIssue(unresolved.stepId, 'source_resolution_failed', error);
      steps.push({ ...unresolved, outcome: 'unknown' });
      issues.push(issue);
      if (batch.failurePolicy === 'stop') stopped = true;
      continue;
    }

    const identified = { ...unresolved, sourceId };
    try {
      const receipt = await operations.commit(step);
      const recorded = recordNestedReceipt(identified, receipt);
      steps.push(recorded.step);
      issues.push(...receipt.issues, ...recorded.issues);
      if (batch.failurePolicy === 'stop' && recorded.step.outcome !== 'applied') {
        stopped = true;
      }
    } catch (error) {
      const issue = unknownStepIssue(
        unresolved.stepId,
        'commit_threw_before_receipt',
        error,
        operations.operationId(step)
      );
      steps.push({ ...identified, outcome: 'unknown' });
      issues.push(issue);
      if (batch.failurePolicy === 'stop') stopped = true;
    }
  }
  return finalizeBatch(batch.batchId, steps, issues);
};

const recordNestedReceipt = (
  step: {
    readonly stepId: string;
    readonly attachmentId: string;
    readonly sourceId: string;
    readonly capturedBasis?: SourceBasis;
  },
  receipt: CommitReceipt
): { readonly step: NonAtomicBatchStepReceipt; readonly issues: readonly Issue[] } => {
  if (receipt.attachmentId !== step.attachmentId || receipt.sourceId !== step.sourceId) {
    return {
      step: { ...step, outcome: 'unknown', receipt },
      issues: [createIssue({
        code: 'transaction.batch_step_outcome_unknown',
        phase: 'commit',
        severity: 'error',
        retry: 'query_outcome',
        operationId: receipt.operationId,
        details: {
          stepId: step.stepId,
          reason: 'receipt_identity_mismatch',
          expected: { attachmentId: step.attachmentId, sourceId: step.sourceId },
          actual: { attachmentId: receipt.attachmentId, sourceId: receipt.sourceId }
        }
      })]
    };
  }
  return {
    step: {
      ...step,
      outcome: receipt.outcome === 'committed'
        ? 'applied'
        : receipt.outcome === 'rejected'
          ? 'failed'
          : 'unknown',
      receipt
    },
    issues: []
  };
};

const finalizeBatch = (
  batchId: string,
  steps: readonly NonAtomicBatchStepReceipt[],
  issues: readonly Issue[]
): NonAtomicBatchReceipt => ({
  kind: 'non-atomic-batch',
  receiptVersion: 1,
  batchId,
  outcome: aggregateBatchOutcome(steps),
  steps,
  issues
});

const aggregateBatchOutcome = (
  steps: readonly NonAtomicBatchStepReceipt[]
): NonAtomicBatchReceipt['outcome'] => {
  let applied = false;
  let failed = false;
  for (const step of steps) {
    if (step.outcome === 'unknown') return 'unknown';
    if (step.outcome === 'applied') applied = true;
    else failed = true;
  }
  if (!failed) return 'complete';
  return applied ? 'partial' : 'failed';
};

const unresolvedStep = <Step>(
  step: Step,
  operations: BatchStepOperations<Step>
): Omit<NonAtomicBatchStepReceipt, 'outcome'> => {
  const capturedBasis = operations.capturedBasis(step);
  return {
    stepId: operations.stepId(step),
    attachmentId: operations.attachmentId(step),
    ...(capturedBasis === undefined ? {} : { capturedBasis })
  };
};

const hasDuplicateStepId = <Step>(
  steps: readonly Step[],
  stepId: (step: Step) => string
): boolean => {
  const seen = new Set<string>();
  for (const step of steps) {
    const id = stepId(step);
    if (seen.has(id)) return true;
    seen.add(id);
  }
  return false;
};

const unknownStepIssue = (
  stepId: string,
  reason: string,
  error: unknown,
  operationId?: string
): Issue => createIssue({
  code: 'transaction.batch_step_outcome_unknown',
  phase: 'commit',
  severity: 'error',
  retry: 'query_outcome',
  ...(operationId === undefined ? {} : { operationId }),
  details: {
    stepId,
    reason,
    error: error instanceof Error ? error.name : typeof error
  }
});

const ownDatabaseStep = (
  step: DatabaseNonAtomicBatchStep
): DatabaseNonAtomicBatchStep => ({
  stepId: step.stepId,
  attachmentId: step.attachmentId,
  sourceId: step.sourceId,
  transact: step.transact
});

const ownPortableStep = (
  step: NonAtomicBatch['steps'][number]
): NonAtomicBatch['steps'][number] => ({
  stepId: step.stepId,
  attempt: {
    operationEpoch: step.attempt.operationEpoch,
    operationId: step.attempt.operationId,
    attachmentId: step.attempt.attachmentId,
    transaction: step.attempt.transaction,
    ...(step.attempt.expectedBasis === undefined
      ? {}
      : { expectedBasis: step.attempt.expectedBasis }),
    ...(step.attempt.signal === undefined ? {} : { signal: step.attempt.signal })
  }
});

const portableStepOperations = {
  stepId: (step: NonAtomicBatch['steps'][number]) => step.stepId,
  attachmentId: (step: NonAtomicBatch['steps'][number]) => step.attempt.attachmentId,
  capturedBasis: (step: NonAtomicBatch['steps'][number]) => step.attempt.expectedBasis,
  operationId: (step: NonAtomicBatch['steps'][number]) => step.attempt.operationId
};

const databaseStepOperations: BatchStepOperations<DatabaseNonAtomicBatchStep> = {
  stepId: (step) => step.stepId,
  attachmentId: (step) => step.attachmentId,
  capturedBasis: () => undefined,
  operationId: () => undefined,
  sourceId: (step) => step.sourceId,
  commit: (step) => step.transact()
};
