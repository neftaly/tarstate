import type { ArtifactRef } from './artifacts.js';
import { canonicalizeJson, isContentHash, sha256Json, type ContentHash } from './canonical-json.js';
import { stageSourceEdits } from './commit-coordinator.js';
import { builtInCapabilityRefs } from './builtins.js';
import { checkFinalConstraints, type SourceConstraint } from './constraints.js';
import { createIssue, type CapabilityRef, type Issue } from './issues.js';
import {
  SourceOperationLedger,
  type OperationLedgerEntry,
  type OperationLedgerProtocol,
  type OperationReservation
} from './lifecycle-governance.js';
import type {
  GeneratedLogicalKey,
  WritableLogicalRow,
  WritableLogicalState
} from './logical-edit.js';
import {
  evaluateTransactionExpression,
  evaluateTransactionFields,
  requireTransactionExpression
} from './internal-transaction-expression.js';
import { capturedTargetsRemain } from './internal-captured-target-validation.js';
import { samePortableJson } from './internal-json-equality.js';
import { isValidUtf16TextSplice } from './internal-text-splice.js';
import type { SourceBasis } from './source-state.js';
import { comparePortableStrings } from './portable-order.js';
import type { QueryNode } from './query/model.js';
import { safeParseTransactionArtifact } from './semantic-transaction-artifact.js';
import type { AtomicSource, LogicalEdit, StagedBasisAtomicSource, StorageBinding } from './source-protocol.js';
import {
  type CommitReceipt,
  type FieldEdit,
  type ReturningResult,
  type SemanticEditOutcome,
  type SimulationReceipt,
  type StatementResult,
  type Transaction,
  type TransactionAttempt,
  type TransactionGuard,
  type WriteRelation,
  type WriteStatement,
  type WriteTarget
} from './transaction.js';
import type { JsonValue } from './value.js';

export type { WritableLogicalRow, WritableLogicalState } from './logical-edit.js';

export type PreparedTransactionQueryResult = {
  readonly rows: readonly unknown[];
  readonly resultKeys: readonly string[];
  readonly completeness: 'exact' | 'lower-bound' | 'unknown';
  readonly issues: readonly Issue[];
};

export type PreparedTransactionQueryService = {
  readonly evaluate: (
    root: QueryNode,
    state: WritableLogicalState,
    parameters: Readonly<Record<string, JsonValue>>,
    basis: SourceBasis
  ) => PreparedTransactionQueryResult;
};

const preparedWritableContextBrand: unique symbol = Symbol('tarstate.prepared-writable-execution-context');
const preparedWritableContexts = new WeakSet<object>();

/**
 * Authority-approved, source-local execution facts. Constructing this context
 * is the host's authorization and preparation boundary.
 */
export type PreparedWritableExecutionContext<Storage, Command> = {
  readonly [preparedWritableContextBrand]: true;
  readonly attachmentId: string;
  readonly attachmentIncarnation: string;
  readonly attachmentFingerprint: ContentHash;
  readonly authorityViewFingerprint: ContentHash;
  readonly writable: true;
  readonly schemaView: ArtifactRef;
  readonly source: StagedBasisAtomicSource<Storage, Command>;
  readonly operationEpoch: string;
  readonly operationLedger: OperationLedgerProtocol<CommitReceipt>;
  readonly bindings: readonly StorageBinding<Storage, Command>[];
  readonly relationKeys: ReadonlyMap<string, readonly string[]>;
  readonly query: PreparedTransactionQueryService;
  readonly constraints?: readonly SourceConstraint<WritableLogicalState>[];
  /** Authority decision for every exact capability required by an artifact. */
  readonly satisfiesCapability: (capability: CapabilityRef) => boolean;
  readonly resolveTransaction?: (ref: ArtifactRef, signal?: AbortSignal) => Promise<Transaction | undefined>;
  readonly durability: 'memory' | 'local' | 'persisted';
};

export type PreparedWritableExecutionContextInput<Storage, Command> = Omit<
  PreparedWritableExecutionContext<Storage, Command>,
  typeof preparedWritableContextBrand | 'operationLedger'
> & { readonly operationLedger?: OperationLedgerProtocol<CommitReceipt> };

/** Adopts authority-prepared callbacks and source facts once for repeated attempts. */
export const prepareWritableExecutionContext = <Storage, Command>(
  input: PreparedWritableExecutionContextInput<Storage, Command>
): PreparedWritableExecutionContext<Storage, Command> => {
  if (!isRecord(input)
    || typeof input.attachmentId !== 'string'
    || input.attachmentId.length === 0
    || typeof input.attachmentIncarnation !== 'string'
    || input.attachmentIncarnation.length === 0
    || !isContentHash(input.attachmentFingerprint)
    || !isContentHash(input.authorityViewFingerprint)
    || input.writable !== true
    || !isArtifactReference(input.schemaView)
    || typeof input.operationEpoch !== 'string'
    || input.operationEpoch.length === 0
    || !isRecord(input.source)
    || typeof input.source.sourceId !== 'string'
    || !Array.isArray(input.bindings)
    || !(input.relationKeys instanceof Map)
    || !isRecord(input.query)
    || typeof input.query.evaluate !== 'function'
    || typeof input.satisfiesCapability !== 'function'
    || (input.operationLedger !== undefined && !isOperationLedger(input.operationLedger))
    || !['memory', 'local', 'persisted'].includes(input.durability)) {
    throw new TypeError('Prepared writable execution context has invalid boundary fields');
  }
  if (new Set(input.bindings.map(({ id }) => id)).size !== input.bindings.length) throw new TypeError('Prepared writable execution binding IDs must be unique');
  if (typeof input.source.basisForStagedStorage !== 'function') {
    throw new TypeError('Prepared writable execution source must derive staged basis');
  }
  const operationLedger = input.operationLedger ?? new SourceOperationLedger<CommitReceipt>(input.operationEpoch);
  if (input.durability !== 'memory' && operationLedger.retention !== 'durable') {
    throw new TypeError('Local or persisted writable execution requires a durable operation ledger');
  }
  const relationKeys = new Map<string, readonly string[]>();
  for (const [relationId, fields] of input.relationKeys) {
    if (typeof relationId !== 'string' || relationId.length === 0 || !Array.isArray(fields) || fields.length === 0 || fields.some((field) => typeof field !== 'string' || field.length === 0)) {
      throw new TypeError('Prepared writable execution relation keys are invalid');
    }
    relationKeys.set(relationId, Object.freeze([...fields]));
  }
  if (input.constraints !== undefined && !Array.isArray(input.constraints)) throw new TypeError('Prepared writable execution constraints must be an array');
  const prepared = Object.freeze({
    ...input,
    operationLedger,
    bindings: Object.freeze([...input.bindings].sort((left, right) => comparePortableStrings(left.id, right.id))),
    relationKeys,
    ...(input.constraints === undefined ? {} : { constraints: Object.freeze([...input.constraints]) }),
    [preparedWritableContextBrand]: true as const
  });
  preparedWritableContexts.add(prepared);
  return prepared;
};

const reservePreparedExecution = async <Storage, Command>(
  context: PreparedWritableExecutionContext<Storage, Command>,
  prepared: PreparedExecution
): Promise<{ readonly entry: OperationLedgerEntry<CommitReceipt> } | { readonly receipt: CommitReceipt }> => {
  let reservation: OperationReservation<CommitReceipt>;
  try {
    reservation = await context.operationLedger.reserve(
      prepared.attempt.operationEpoch,
      prepared.attempt.operationId,
      prepared.intentHash
    );
  } catch (error) {
    return { receipt: unknownOperationReceipt(context, prepared, 'operation.ledger_unavailable', error) };
  }
  if (reservation.status === 'reserved') return { entry: reservation.entry };
  if (reservation.status === 'known') return { receipt: reservation.receipt };
  if (reservation.status === 'pending') {
    return { receipt: unknownOperationReceipt(context, prepared, 'operation.outcome_pending') };
  }
  const code = reservation.status === 'ambiguous'
    ? 'transaction.operation_id_ambiguous'
    : 'transaction.operation_epoch_expired';
  return {
    receipt: {
      ...receiptEvidence(context, prepared, [], [transactionIssue(code, prepared.attempt, undefined, 'never')]),
      outcome: 'rejected'
    }
  };
};

const completePreparedExecution = async <Storage, Command>(
  context: PreparedWritableExecutionContext<Storage, Command>,
  prepared: PreparedExecution,
  entry: OperationLedgerEntry<CommitReceipt>,
  receipt: CommitReceipt
): Promise<CommitReceipt> => {
  try {
    await context.operationLedger.complete(entry, receipt);
    return receipt;
  } catch (error) {
    return unknownOperationReceipt(context, prepared, 'operation.ledger_complete_failed', error, receipt);
  }
};

const unknownOperationReceipt = <Storage, Command>(
  context: PreparedWritableExecutionContext<Storage, Command>,
  prepared: PreparedExecution,
  code: 'operation.ledger_unavailable' | 'operation.ledger_complete_failed' | 'operation.outcome_pending',
  error?: unknown,
  prior?: CommitReceipt
): CommitReceipt => ({
  ...receiptEvidence(context, prepared, prior?.statementResults ?? [], [
    ...(prior?.issues ?? []),
    transactionIssue(code, prepared.attempt, error === undefined ? undefined : { error: errorName(error) }, 'query_outcome')
  ], prior?.returning, prior?.generatedKeys),
  outcome: 'unknown',
  ...(prior?.beforeBasis === undefined ? {} : { beforeBasis: prior.beforeBasis }),
  durability: 'unknown'
});

type PreparedExecution = {
  readonly attempt: TransactionAttempt;
  readonly transaction: Transaction;
  readonly intentHash: ContentHash;
};

type EvaluatedStatement = {
  readonly editGroups: readonly (readonly LogicalEdit[])[];
  readonly result: StatementResult;
};

type EvaluatedExecution<Storage, Command> = {
  readonly beforeBasis: SourceBasis;
  readonly stagedSnapshot: ReturnType<AtomicSource<Storage, Command>['snapshot']>;
  readonly logicalState: WritableLogicalState;
  readonly commands: readonly Command[];
  readonly statementResults: readonly StatementResult[];
  readonly returning?: readonly Omit<ReturningResult, 'basis'>[];
  readonly issues: readonly Issue[];
  readonly blockingIssues: readonly Issue[];
};

type CapturedExecutionSnapshot<Storage, Command> =
  | { readonly snapshot: ReturnType<AtomicSource<Storage, Command>['snapshot']> }
  | { readonly issue: Issue };

/** The source callback is an effect boundary; evaluation only receives captured state. */
const captureExecutionSnapshot = <Storage, Command>(
  context: PreparedWritableExecutionContext<Storage, Command>,
  basis?: SourceBasis
): CapturedExecutionSnapshot<Storage, Command> => {
  try {
    if (basis === undefined) return { snapshot: context.source.snapshot() };
    if (context.source.snapshotAt !== undefined) return { snapshot: context.source.snapshotAt(basis) };
    const snapshot = context.source.snapshot();
    if (samePortableJson(snapshot.basis, basis)) return { snapshot };
    return {
      issue: createIssue({
        code: 'transaction.expected_basis_stale',
        phase: 'plan',
        severity: 'error',
        retry: 'after_refresh',
        sourceId: context.source.sourceId,
        details: { reason: 'observed_basis_unavailable', observedBasis: basis, actualBasis: snapshot.basis }
      })
    };
  } catch (error) {
    return {
      issue: createIssue({
        code: 'source.snapshot_failed',
        phase: 'plan',
        severity: 'error',
        retry: 'after_refresh',
        sourceId: context.source.sourceId,
        details: { error: errorName(error) }
      })
    };
  }
};

export const executePreparedTransaction = async <Storage, Command>(
  context: PreparedWritableExecutionContext<Storage, Command>,
  attempt: TransactionAttempt
): Promise<CommitReceipt> => {
  assertPreparedWritableContext(context);
  const preparedAttempt = adoptAttempt(attempt);
  const prepared = await prepareExecution(context, preparedAttempt);
  if ('receipt' in prepared) return prepared.receipt;
  const reservation = await reservePreparedExecution(context, prepared);
  if ('receipt' in reservation) return reservation.receipt;
  const completed = await reconcileAndCommitPreparedExecution(context, prepared);
  return completePreparedExecution(context, completed.prepared, reservation.entry, completed.receipt);
};

const maxReconciliationAttempts = 16;

type ReplayablePreparationResult = PreparedExecution | {
  readonly prepared?: PreparedExecution;
  readonly receipt: CommitReceipt;
};

type ReplayablePreparation<Storage, Command> = (
  snapshot: ReturnType<AtomicSource<Storage, Command>['snapshot']>
) => Promise<ReplayablePreparationResult>;

type ReconciledPreparedCommit = {
  readonly prepared: PreparedExecution;
  readonly receipt: CommitReceipt;
};

/** Re-evaluates all guards and constraints after a transient concurrent change. */
const reconcileAndCommitPreparedExecution = async <Storage, Command>(
  context: PreparedWritableExecutionContext<Storage, Command>,
  initialPrepared: PreparedExecution,
  initialSnapshot?: ReturnType<AtomicSource<Storage, Command>['snapshot']>,
  reprepare?: ReplayablePreparation<Storage, Command>
): Promise<ReconciledPreparedCommit> => {
  let prepared = initialPrepared;
  let nextSnapshot = initialSnapshot;
  for (let reconciliationAttempt = 0; reconciliationAttempt < maxReconciliationAttempts; reconciliationAttempt += 1) {
    const captured = nextSnapshot === undefined ? captureExecutionSnapshot(context) : { snapshot: nextSnapshot };
    nextSnapshot = undefined;
    if ('issue' in captured) return { prepared, receipt: rejectedBeforeSnapshotReceipt(context, prepared, captured.issue) };
    const evaluated = evaluatePreparedExecution(context, prepared, captured.snapshot);
    if (evaluated.blockingIssues.length > 0) return { prepared, receipt: rejectedReceipt(context, prepared, evaluated) };
    if (prepared.attempt.signal?.aborted === true) {
      return {
        prepared,
        receipt: rejectedReceipt(context, prepared, {
          ...evaluated,
          issues: [...evaluated.issues, transactionIssue('transaction.cancelled', prepared.attempt, { timing: 'before_handoff' })],
          blockingIssues: [transactionIssue('transaction.cancelled', prepared.attempt, { timing: 'before_handoff' })]
        })
      };
    }
    let outcome: Awaited<ReturnType<AtomicSource<Storage, Command>['commit']>>;
    try {
      outcome = await context.source.commit({
        operationEpoch: prepared.attempt.operationEpoch,
        operationId: prepared.attempt.operationId,
        intentHash: prepared.intentHash,
        expectedBasis: evaluated.beforeBasis,
        commands: evaluated.commands
      });
    } catch (error) {
      return { prepared, receipt: {
        ...receiptEvidence(context, prepared, evaluated.statementResults, [
          ...evaluated.issues,
          transactionIssue('transaction.outcome_unavailable', prepared.attempt, { error: errorName(error) }, 'query_outcome')
        ]),
        outcome: 'unknown',
        beforeBasis: evaluated.beforeBasis,
        durability: 'unknown'
      } };
    }
    if (isTransientStaleBasis(outcome) && prepared.attempt.expectedBasis === undefined) {
      if (capturedBasisMergeable(prepared.transaction)
        && context.source.reconcile !== undefined
        && context.source.commitReconciled !== undefined) {
        return reconcileCapturedBasisExecution(context, prepared, evaluated);
      }
      // Numeric text coordinates belong to the captured projection. A mixed or
      // conditional transaction is exact, so replaying its author against a
      // newer snapshot would silently reinterpret those coordinates.
      if (containsCapturedBasisEdit(prepared.transaction)) {
        return { prepared, receipt: rejectedReceipt(context, prepared, {
          ...evaluated,
          issues: [...evaluated.issues, ...outcome.issues],
          blockingIssues: outcome.issues
        }) };
      }
      if (reprepare !== undefined) {
        const refreshed = captureExecutionSnapshot(context);
        if ('issue' in refreshed) return { prepared, receipt: rejectedBeforeSnapshotReceipt(context, prepared, refreshed.issue) };
        let replacement: Awaited<ReturnType<ReplayablePreparation<Storage, Command>>>;
        try {
          replacement = await reprepare(refreshed.snapshot);
        } catch (error) {
          return {
            prepared,
            receipt: {
              ...receiptEvidence(context, prepared, [], [transactionIssue(
                'transaction.unexpected_failure',
                prepared.attempt,
                { timing: 'reconciliation', error: errorName(error) },
                'after_input'
              )]),
              outcome: 'rejected',
              beforeBasis: refreshed.snapshot.basis
            }
          };
        }
        if ('receipt' in replacement) {
          return {
            prepared: replacement.prepared ?? prepared,
            receipt: replacement.receipt
          };
        }
        prepared = replacement;
        nextSnapshot = refreshed.snapshot;
      }
      continue;
    }
    const issues = [...evaluated.issues, ...outcome.issues];
    if (outcome.outcome === 'rejected') {
      return { prepared, receipt: {
        ...receiptEvidence(context, prepared, evaluated.statementResults, issues),
        outcome: 'rejected',
        ...(outcome.beforeBasis === undefined ? {} : { beforeBasis: outcome.beforeBasis })
      } };
    }
    if (outcome.outcome === 'unknown' || outcome.beforeBasis === undefined || outcome.afterBasis === undefined) {
      return { prepared, receipt: {
        ...receiptEvidence(context, prepared, evaluated.statementResults, issues),
        outcome: 'unknown',
        ...(outcome.beforeBasis === undefined ? {} : { beforeBasis: outcome.beforeBasis }),
        durability: 'unknown'
      } };
    }
    const returning = evaluated.returning?.map((result): ReturningResult => ({ ...result, basis: outcome.afterBasis as SourceBasis }));
    return { prepared, receipt: {
      ...receiptEvidence(
        context,
        prepared,
        evaluated.statementResults,
        issues,
        returning,
        outcome.generatedKeys
      ),
      outcome: 'committed',
      beforeBasis: outcome.beforeBasis,
      afterBasis: outcome.afterBasis,
      durability: context.durability
    } };
  }
  const latest = captureExecutionSnapshot(context);
  const beforeBasis = 'snapshot' in latest ? latest.snapshot.basis : undefined;
  return { prepared, receipt: {
    ...receiptEvidence(context, prepared, [], [transactionIssue(
      'transaction.expected_basis_stale',
      prepared.attempt,
      { reason: 'reconciliation_exhausted' }
    )]),
    outcome: 'rejected',
    ...(beforeBasis === undefined ? {} : { beforeBasis })
  } };
};

const isTransientStaleBasis = (outcome: { readonly outcome: string; readonly issues: readonly Issue[] }): boolean =>
  outcome.outcome === 'rejected'
  && outcome.issues.length > 0
  && outcome.issues.every(({ code }) => code === 'transaction.expected_basis_stale');

/** Conservative private policy: mixed or conditional work remains exact/replayable. */
const capturedBasisMergeable = (transaction: Transaction): boolean =>
  transaction.body.guards.length === 0
  && transaction.body.statements.length > 0
  && transaction.body.statements.every((statement) => statement.kind === 'statement.keyed-delta'
    && statement.changes.length > 0
    && statement.changes.every((change) => change.kind === 'delta.update'
      && Object.values(change.key).every(({ kind }) => kind === 'literal')
      && Object.values(change.edits).length > 0
      && Object.values(change.edits).every(({ kind }) => kind === 'edit.text-splice')));

const containsCapturedBasisEdit = (transaction: Transaction): boolean =>
  transaction.body.statements.some((statement) => statement.kind === 'statement.keyed-delta'
    && statement.changes.some((change) => change.kind === 'delta.update'
      && Object.values(change.edits).some(({ kind }) => kind === 'edit.text-splice')));

const reconcileCapturedBasisExecution = async <Storage, Command>(
  context: PreparedWritableExecutionContext<Storage, Command>,
  prepared: PreparedExecution,
  evaluated: EvaluatedExecution<Storage, Command>
): Promise<ReconciledPreparedCommit> => {
  const reconcile = context.source.reconcile;
  const commitReconciled = context.source.commitReconciled;
  if (reconcile === undefined || commitReconciled === undefined) {
    throw new TypeError('Captured-basis reconciliation requires source support');
  }
  let priorCandidate: Storage | undefined;
  for (let attemptIndex = 0; attemptIndex < maxReconciliationAttempts; attemptIndex += 1) {
    const captured = captureExecutionSnapshot(context);
    if ('issue' in captured) return { prepared, receipt: rejectedBeforeSnapshotReceipt(context, prepared, captured.issue) };
    const integration = captured.snapshot;
    let candidate: ReturnType<typeof reconcile>;
    try {
      candidate = reconcile(integration, evaluated.beforeBasis, evaluated.commands, priorCandidate);
    } catch (error) {
      return { prepared, receipt: reconciledRejectedReceipt(context, prepared, evaluated, integration.basis, [
        transactionIssue('binding.stage_failed', prepared.attempt, { timing: 'reconciliation', error: errorName(error) })
      ]) };
    }
    if (candidate.issues.some(isError) || integration.storage === undefined) {
      return { prepared, receipt: reconciledRejectedReceipt(context, prepared, evaluated, integration.basis, candidate.issues) };
    }
    priorCandidate = candidate.storage;
    const candidateBasis = deriveStagedBasis(context, integration, { ...integration, storage: candidate.storage });
    if ('issue' in candidateBasis) {
      return { prepared, receipt: reconciledRejectedReceipt(context, prepared, evaluated, integration.basis, [candidateBasis.issue]) };
    }
    const candidateSnapshot = { ...integration, storage: candidate.storage, basis: candidateBasis.basis };
    const validation = validateReconciledCandidate(
      context,
      prepared,
      integration,
      candidateSnapshot
    );
    if (validation.blockingIssues.length > 0) {
      return { prepared, receipt: reconciledRejectedReceipt(
        context,
        prepared,
        evaluated,
        integration.basis,
        validation.issues
      ) };
    }
    let outcome: Awaited<ReturnType<AtomicSource<Storage, Command>['commit']>>;
    try {
      outcome = await commitReconciled({
        operationEpoch: prepared.attempt.operationEpoch,
        operationId: prepared.attempt.operationId,
        intentHash: prepared.intentHash,
        expectedBasis: integration.basis,
        candidate: candidate.storage
      });
    } catch (error) {
      return { prepared, receipt: {
        ...receiptEvidence(context, prepared, evaluated.statementResults, [
          ...validation.issues,
          transactionIssue('transaction.outcome_unavailable', prepared.attempt, { error: errorName(error) }, 'query_outcome')
        ]),
        evaluationBasis: evaluated.beforeBasis,
        integrationBasis: integration.basis,
        outcome: 'unknown',
        beforeBasis: integration.basis,
        durability: 'unknown'
      } };
    }
    if (isTransientStaleBasis(outcome)) continue;
    const issues = [...validation.issues, ...outcome.issues];
    if (outcome.outcome === 'rejected') {
      return { prepared, receipt: reconciledRejectedReceipt(context, prepared, evaluated, integration.basis, issues) };
    }
    if (outcome.outcome === 'unknown' || outcome.beforeBasis === undefined || outcome.afterBasis === undefined) {
      return { prepared, receipt: {
        ...receiptEvidence(context, prepared, evaluated.statementResults, issues),
        evaluationBasis: evaluated.beforeBasis,
        integrationBasis: integration.basis,
        outcome: 'unknown',
        ...(outcome.beforeBasis === undefined ? {} : { beforeBasis: outcome.beforeBasis }),
        durability: 'unknown'
      } };
    }
    if (!samePortableJson(outcome.afterBasis, candidateBasis.basis)) {
      return { prepared, receipt: {
        ...receiptEvidence(context, prepared, evaluated.statementResults, [
          ...issues,
          transactionIssue('transaction.outcome_unavailable', prepared.attempt, {
            reason: 'published_candidate_basis_mismatch',
            validated: candidateBasis.basis,
            published: outcome.afterBasis
          }, 'query_outcome')
        ]),
        evaluationBasis: evaluated.beforeBasis,
        integrationBasis: integration.basis,
        outcome: 'unknown',
        beforeBasis: outcome.beforeBasis,
        durability: 'unknown'
      } };
    }
    const returning = validation.returning?.map((result): ReturningResult => ({
      ...result,
      basis: outcome.afterBasis as SourceBasis
    }));
    return { prepared, receipt: {
      ...receiptEvidence(context, prepared, evaluated.statementResults, issues, returning, outcome.generatedKeys),
      evaluationBasis: evaluated.beforeBasis,
      integrationBasis: outcome.beforeBasis,
      outcome: 'committed',
      beforeBasis: outcome.beforeBasis,
      afterBasis: outcome.afterBasis,
      durability: context.durability
    } };
  }
  const latest = captureExecutionSnapshot(context);
  const integrationBasis = 'snapshot' in latest ? latest.snapshot.basis : evaluated.beforeBasis;
  return { prepared, receipt: reconciledRejectedReceipt(context, prepared, evaluated, integrationBasis, [
    transactionIssue('transaction.expected_basis_stale', prepared.attempt, { reason: 'reconciliation_exhausted' })
  ]) };
};

type ReconciledCandidateValidation = {
  readonly issues: readonly Issue[];
  readonly blockingIssues: readonly Issue[];
  readonly returning?: readonly Omit<ReturningResult, 'basis'>[];
};

const validateReconciledCandidate = <Storage, Command>(
  context: PreparedWritableExecutionContext<Storage, Command>,
  prepared: PreparedExecution,
  integration: ReturnType<AtomicSource<Storage, Command>['snapshot']>,
  candidate: ReturnType<AtomicSource<Storage, Command>['snapshot']>
): ReconciledCandidateValidation => {
  const beforeProjection = projectLogicalState(context.bindings, integration);
  const afterProjection = projectLogicalState(context.bindings, candidate);
  const issues: Issue[] = [...beforeProjection.issues, ...afterProjection.issues];
  if (!capturedTargetsRemain(prepared.transaction.body.statements, beforeProjection.rowsByRelation, context.relationKeys)) {
    issues.push(transactionIssue('transaction.expected_basis_stale', prepared.attempt, {
      reason: 'captured_text_target_unavailable'
    }, 'after_refresh'));
  }
  let blockingIssues = issues.filter(isError);
  const before = logicalProjectionState(beforeProjection);
  const after = logicalProjectionState(afterProjection);
  if (blockingIssues.length === 0 && context.constraints !== undefined && context.constraints.length > 0) {
    const checked = checkFinalConstraints({
      constraints: context.constraints,
      before,
      after,
      beforeBasis: integration.basis,
      afterBasis: candidate.basis,
      touchedRelations: new Set(prepared.transaction.body.statements.flatMap((statement) => {
        const relation = statementRelation(statement);
        return relation === undefined ? [] : [relation.relationId];
      }))
    });
    issues.push(...checked.blockingIssues, ...checked.auditIssues);
    blockingIssues = [...checked.blockingIssues];
  }
  const returning = blockingIssues.length === 0
    ? evaluateReturning(context, prepared, after, candidate.basis)
    : undefined;
  if (returning !== undefined) issues.push(...returning.flatMap(({ issues: resultIssues }) => resultIssues));
  return { issues, blockingIssues, ...(returning === undefined ? {} : { returning }) };
};

const reconciledRejectedReceipt = <Storage, Command>(
  context: PreparedWritableExecutionContext<Storage, Command>,
  prepared: PreparedExecution,
  evaluated: EvaluatedExecution<Storage, Command>,
  integrationBasis: SourceBasis,
  issues: readonly Issue[]
): CommitReceipt => ({
  ...receiptEvidence(context, prepared, evaluated.statementResults, [...evaluated.issues, ...issues]),
  evaluationBasis: evaluated.beforeBasis,
  integrationBasis,
  outcome: 'rejected',
  beforeBasis: integrationBasis
});

export type ReplayablePreparedTransactionInput = {
  readonly operationId: string;
  readonly intentHash: ContentHash;
  readonly signal?: AbortSignal;
  readonly observedBasis?: SourceBasis;
  readonly author: (input: {
    readonly basis: SourceBasis;
    readonly state: WritableLogicalState;
    readonly issues: readonly Issue[];
  }) => Promise<{
    readonly transaction: Transaction;
    readonly issues: readonly Issue[];
  }>;
};

/** Internal bridge used by attachment services; the author is replayed only after transient concurrency. */
export const executeReplayablePreparedTransaction = async <Storage, Command>(
  context: PreparedWritableExecutionContext<Storage, Command>,
  input: ReplayablePreparedTransactionInput
): Promise<CommitReceipt> => {
  assertPreparedWritableContext(context);
  try {
    const prior = await context.operationLedger.lookup(
      context.operationEpoch,
      input.operationId,
      input.intentHash
    );
    if (prior.status === 'known') return prior.receipt;
  } catch { /* Reservation below reports ledger availability with receipt evidence. */ }
  const prepareFromSnapshot: ReplayablePreparation<Storage, Command> = (snapshot) =>
    prepareReplayableExecution(context, input, snapshot);
  const captured = captureExecutionSnapshot(context, input.observedBasis);
  if ('issue' in captured) throw new Error('Cannot author a transaction without a source snapshot');
  const initial = await prepareFromSnapshot(captured.snapshot);
  if ('receipt' in initial) return initial.receipt;
  const reservation = await reservePreparedExecution(context, initial);
  if ('receipt' in reservation) return reservation.receipt;
  const completed = await reconcileAndCommitPreparedExecution(
    context,
    initial,
    captured.snapshot,
    prepareFromSnapshot
  );
  return completePreparedExecution(context, completed.prepared, reservation.entry, completed.receipt);
};

export const simulateReplayablePreparedTransaction = async <Storage, Command>(
  context: PreparedWritableExecutionContext<Storage, Command>,
  input: ReplayablePreparedTransactionInput
): Promise<SimulationReceipt> => {
  assertPreparedWritableContext(context);
  const captured = captureExecutionSnapshot(context, input.observedBasis);
  if ('issue' in captured) throw new Error('Cannot simulate a transaction without a source snapshot');
  const prepared = await prepareReplayableExecution(context, input, captured.snapshot);
  if ('receipt' in prepared) return commitRejectionAsSimulation(prepared.receipt);
  const evaluated = evaluatePreparedExecution(context, prepared, captured.snapshot);
  return simulationReceipt(context, prepared, evaluated);
};

const prepareReplayableExecution = async <Storage, Command>(
  context: PreparedWritableExecutionContext<Storage, Command>,
  input: ReplayablePreparedTransactionInput,
  snapshot: ReturnType<AtomicSource<Storage, Command>['snapshot']>
): Promise<ReplayablePreparationResult> => {
  const projection = projectLogicalState(context.bindings, snapshot);
  const authored = await input.author({
    basis: snapshot.basis,
    state: logicalProjectionState(projection),
    issues: projection.issues
  });
  const attempt = adoptAttempt({
    operationEpoch: context.operationEpoch,
    operationId: input.operationId,
    attachmentId: context.attachmentId,
    transaction: authored.transaction,
    ...(input.signal === undefined ? {} : { signal: input.signal })
  });
  if (containsCapturedBasisEdit(authored.transaction) && input.observedBasis === undefined) {
    const issue = transactionIssue('transaction.expected_basis_stale', attempt, {
      reason: 'observed_basis_required_for_position_sensitive_intent'
    }, 'after_input');
    return {
      prepared: { attempt, transaction: authored.transaction, intentHash: input.intentHash },
      receipt: {
        ...rawReceiptEvidence(context, attempt, authored.transaction.contentHash, input.intentHash, [], [issue]),
        outcome: 'rejected',
        beforeBasis: snapshot.basis
      }
    };
  }
  if (authored.issues.length > 0) {
    const prepared = {
      attempt,
      transaction: authored.transaction,
      intentHash: input.intentHash
    };
    return {
      prepared,
      receipt: {
        ...rawReceiptEvidence(
          context,
          attempt,
          authored.transaction.contentHash,
          input.intentHash,
          [],
          authored.issues
        ),
        outcome: 'rejected',
        beforeBasis: snapshot.basis
      }
    };
  }
  const prepared = await prepareExecution(context, attempt);
  return 'receipt' in prepared ? prepared : { ...prepared, intentHash: input.intentHash };
};

export const simulatePreparedTransaction = async <Storage, Command>(
  context: PreparedWritableExecutionContext<Storage, Command>,
  attempt: TransactionAttempt
): Promise<SimulationReceipt> => {
  assertPreparedWritableContext(context);
  const preparedAttempt = adoptAttempt(attempt);
  const prepared = await prepareExecution(context, preparedAttempt);
  if ('receipt' in prepared) return commitRejectionAsSimulation(prepared.receipt);
  const captured = captureExecutionSnapshot(context);
  if ('issue' in captured) {
    return commitRejectionAsSimulation(rejectedBeforeSnapshotReceipt(context, prepared, captured.issue));
  }
  const evaluated = evaluatePreparedExecution(context, prepared, captured.snapshot);
  return simulationReceipt(context, prepared, evaluated);
};

const simulationReceipt = <Storage, Command>(
  context: PreparedWritableExecutionContext<Storage, Command>,
  prepared: PreparedExecution,
  evaluated: EvaluatedExecution<Storage, Command>
): SimulationReceipt => ({
    kind: 'simulation',
    receiptVersion: 1,
    operationEpoch: prepared.attempt.operationEpoch,
    operationId: prepared.attempt.operationId,
    transactionHash: prepared.transaction.contentHash,
    intentHash: prepared.intentHash,
    attachmentId: context.attachmentId,
    attachmentFingerprint: context.attachmentFingerprint,
    sourceId: context.source.sourceId,
    outcome: evaluated.blockingIssues.length === 0 ? 'would-commit' : 'rejected',
    beforeBasis: evaluated.beforeBasis,
    statementResults: evaluated.statementResults,
    issues: evaluated.issues,
    ...(evaluated.blockingIssues.length === 0 ? { stagedState: evaluated.logicalState } : {})
  });

const prepareExecution = async <Storage, Command>(
  context: PreparedWritableExecutionContext<Storage, Command>,
  attempt: TransactionAttempt
): Promise<PreparedExecution | { readonly receipt: CommitReceipt }> => {
  const transactionHash = attempt.transaction.contentHash;
  const intentHash = await transactionIntentHash(context, attempt, transactionHash);
  const reject = (issues: readonly Issue[]): { readonly receipt: CommitReceipt } => ({
    receipt: {
      ...rawReceiptEvidence(context, attempt, transactionHash, intentHash, [], issues),
      outcome: 'rejected'
    }
  });
  if (attempt.attachmentId !== context.attachmentId || context.writable !== true) {
    return reject([transactionIssue('transaction.attachment_unavailable', attempt, { attachmentId: attempt.attachmentId })]);
  }
  if (attempt.operationEpoch !== context.operationEpoch) {
    return reject([transactionIssue('transaction.operation_epoch_expired', attempt, { operationEpoch: attempt.operationEpoch }, 'never')]);
  }
  if (signalAborted(attempt.signal)) {
    return reject([transactionIssue('transaction.cancelled', attempt, { timing: 'preparation' }, 'never')]);
  }
  let candidate: Transaction | undefined;
  if (isTransaction(attempt.transaction)) candidate = attempt.transaction;
  else {
    try {
      candidate = await context.resolveTransaction?.(attempt.transaction, attempt.signal);
    } catch (error) {
      if (signalAborted(attempt.signal)) {
        return reject([transactionIssue('transaction.cancelled', attempt, { timing: 'preparation' }, 'never')]);
      }
      return reject([transactionIssue('transaction.artifact_unavailable', attempt, { error: errorName(error) })]);
    }
    if (signalAborted(attempt.signal)) {
      return reject([transactionIssue('transaction.cancelled', attempt, { timing: 'preparation' }, 'never')]);
    }
    if (candidate === undefined) return reject([transactionIssue('transaction.artifact_unavailable', attempt, { transactionHash })]);
    if (candidate.id !== attempt.transaction.id || candidate.contentHash !== attempt.transaction.contentHash) {
      return reject([transactionIssue('artifact.dependency_mismatch', attempt, {
        expected: attempt.transaction,
        actual: { id: candidate.id, contentHash: candidate.contentHash }
      })]);
    }
  }
  const parsed = await safeParseTransactionArtifact(candidate);
  if (!parsed.success) return reject(parsed.issues);
  if (signalAborted(attempt.signal)) {
    return reject([transactionIssue('transaction.cancelled', attempt, { timing: 'preparation' }, 'never')]);
  }
  const transaction = parsed.value;
  if (!sameRef(transaction.body.schemaView, context.schemaView)) {
    return reject([transactionIssue('transaction.schema_view_unavailable', attempt, { schemaView: transaction.body.schemaView })]);
  }
  const missing: CapabilityRef[] = [];
  try {
    for (const capability of transaction.body.requiredCapabilities) {
      if (!context.satisfiesCapability(capability)) missing.push(capability);
    }
  } catch (error) {
    return reject([transactionIssue('transaction.capability_unavailable', attempt, {
      reason: 'authority_check_failed',
      error: errorName(error)
    })]);
  }
  if (missing.length > 0) {
    return reject([createIssue({
      code: 'transaction.capability_unavailable',
      operationId: attempt.operationId,
      sourceId: context.source.sourceId,
      requiredCapabilities: missing,
      details: { capabilities: missing }
    })]);
  }
  return { attempt, transaction, intentHash };
};

const evaluatePreparedExecution = <Storage, Command>(
  context: PreparedWritableExecutionContext<Storage, Command>,
  prepared: PreparedExecution,
  beforeSnapshot: ReturnType<AtomicSource<Storage, Command>['snapshot']>
): EvaluatedExecution<Storage, Command> => {
  const beforeBasis = beforeSnapshot.basis;
  const earlyIssues: Issue[] = [];
  if (beforeSnapshot.state !== 'ready' || beforeSnapshot.storage === undefined) {
    earlyIssues.push(createIssue({ code: 'source.not_ready', sourceId: context.source.sourceId, details: { state: beforeSnapshot.state } }));
  }
  if (beforeSnapshot.operationEpoch !== context.operationEpoch) {
    earlyIssues.push(transactionIssue('transaction.operation_epoch_expired', prepared.attempt, { snapshotEpoch: beforeSnapshot.operationEpoch }, 'never'));
  }
  if (prepared.attempt.expectedBasis !== undefined && !samePortableJson(prepared.attempt.expectedBasis, beforeBasis)) {
    earlyIssues.push(transactionIssue('transaction.expected_basis_stale', prepared.attempt, {
      expected: prepared.attempt.expectedBasis,
      actual: beforeBasis
    }, 'after_refresh'));
  }
  const initialProjection = earlyIssues.length === 0
    ? projectLogicalState(context.bindings, beforeSnapshot)
    : emptyLogicalProjection(earlyIssues);
  if (initialProjection.issues.some(isError)) {
    return rejectedEvaluation(beforeSnapshot, beforeBasis, logicalProjectionState(initialProjection), initialProjection.issues);
  }
  let stagedSnapshot = beforeSnapshot;
  let stagedBasis = beforeBasis;
  let logicalProjection = initialProjection;
  const beforeState = logicalProjectionState(initialProjection);
  const commands: Command[] = [];
  const statementResults: StatementResult[] = [];
  const issues: Issue[] = [...initialProjection.issues];
  const touchedRelations = new Set<string>();
  for (const [statementIndex, statement] of prepared.transaction.body.statements.entries()) {
    const statementStart = logicalProjection;
    const evaluated = evaluateStatement(context, statement, statementIndex, statementStart, prepared.transaction.body.parameters, stagedBasis);
    statementResults.push(evaluated.result);
    issues.push(...evaluated.result.issues);
    if (evaluated.result.issues.some(isError)) break;
    let statementRejected = false;
    const affectedRelations = new Set<string>();
    for (const editGroup of evaluated.editGroups) {
      if (editGroup.length === 0) continue;
      const staged = stageSourceEdits({
        source: context.source,
        bindings: context.bindings,
        snapshot: stagedSnapshot,
        edits: editGroup
      });
      if (staged.outcome === 'rejected') {
        issues.push(...staged.issues);
        statementRejected = true;
        break;
      }
      const derivedBasis = deriveStagedBasis(context, beforeSnapshot, staged.snapshot);
      if ('issue' in derivedBasis) {
        issues.push(derivedBasis.issue);
        statementRejected = true;
        break;
      }
      stagedBasis = derivedBasis.basis;
      stagedSnapshot = { ...staged.snapshot, basis: stagedBasis };
      for (const edit of editGroup) affectedRelations.add(edit.relationId);
      commands.push(...staged.commands);
      issues.push(...staged.issues);
    }
    if (statementRejected) break;
    const projected = projectLogicalState(context.bindings, stagedSnapshot, logicalProjection, affectedRelations);
    issues.push(...projected.issues);
    if (projected.issues.some(isError)) break;
    logicalProjection = projected;
    statementResults[statementIndex] = reconcileStatementResult(
      statement,
      statementStart,
      logicalProjection,
      prepared.transaction.body.parameters,
      evaluated.result
    );
    const relation = statementRelation(statement);
    if (relation !== undefined) touchedRelations.add(relation.relationId);
  }
  const logicalState = logicalProjectionState(logicalProjection);
  let blockingIssues = issues.filter(isError);
  if (blockingIssues.length === 0) {
    const guardIssues = evaluateGuards(context, prepared.transaction.body.guards, logicalState, prepared.transaction.body.parameters, statementResults, prepared.attempt, stagedBasis);
    issues.push(...guardIssues);
    blockingIssues = guardIssues.filter(isError);
  }
  if (blockingIssues.length === 0 && context.constraints !== undefined && context.constraints.length > 0) {
    const checked = checkFinalConstraints({
      constraints: context.constraints,
      before: beforeState,
      after: logicalState,
      beforeBasis,
      afterBasis: stagedBasis,
      touchedRelations
    });
    issues.push(...checked.blockingIssues, ...checked.auditIssues);
    blockingIssues = [...checked.blockingIssues];
  }
  const returning = blockingIssues.length === 0
    ? evaluateReturning(context, prepared, logicalState, stagedBasis)
    : undefined;
  if (returning !== undefined) issues.push(...returning.flatMap(({ issues: resultIssues }) => resultIssues));
  return {
    beforeBasis,
    stagedSnapshot,
    logicalState,
    commands,
    statementResults,
    ...(returning === undefined ? {} : { returning }),
    issues,
    blockingIssues
  };
};

const reconcileStatementResult = (
  statement: WriteStatement,
  before: LogicalProjection,
  after: LogicalProjection,
  parameters: Readonly<Record<string, JsonValue>>,
  result: StatementResult
): StatementResult => {
  if (statement.kind !== 'statement.update') return result;
  const relationId = statement.target.relation.relationId;
  const selected = selectTargets(
    statement.target,
    before.rowsByRelation.get(relationId) ?? [],
    parameters
  );
  if (!selected.success) return result;
  let logicallyChanged = 0;
  const projectedByLocator = new Map<string, WritableLogicalRow>();
  for (const candidate of after.rowsByRelation.get(relationId) ?? []) {
    const locator = canonicalizeJson(candidate.locator);
    if (!projectedByLocator.has(locator)) projectedByLocator.set(locator, candidate);
  }
  for (const row of selected.value) {
    const projected = projectedByLocator.get(canonicalizeJson(row.locator));
    if (projected === undefined || !samePortableJson(projected.fields, row.fields)) logicallyChanged += 1;
  }
  return logicallyChanged === result.logicallyChanged ? result : { ...result, logicallyChanged };
};

const deriveStagedBasis = <Storage, Command>(
  context: PreparedWritableExecutionContext<Storage, Command>,
  before: ReturnType<AtomicSource<Storage, Command>['snapshot']>,
  staged: ReturnType<AtomicSource<Storage, Command>['snapshot']>
): { readonly basis: SourceBasis } | { readonly issue: Issue } => {
  if (staged.storage === undefined) {
    return { issue: transactionIssue('transaction.staged_basis_unavailable', undefined, { reason: 'staged_storage_unavailable' }, 'after_refresh') };
  }
  try {
    return { basis: context.source.basisForStagedStorage(before, staged.storage) };
  } catch (error) {
    return { issue: transactionIssue('transaction.staged_basis_unavailable', undefined, { reason: 'basis_derivation_failed', error: errorName(error) }, 'after_refresh') };
  }
};

const evaluateStatement = <Storage, Command>(
  context: PreparedWritableExecutionContext<Storage, Command>,
  statement: WriteStatement,
  statementIndex: number,
  state: LogicalProjection,
  parameters: Readonly<Record<string, JsonValue>>,
  basis: SourceBasis
): EvaluatedStatement => {
  const empty = emptyStatementResult(statementIndex);
  if (statement.kind === 'extension') {
    return failedStatement(empty, transactionIssue('transaction.capability_unavailable', undefined, { capability: statement.capability }));
  }
  const relation = statementRelation(statement);
  if (relation === undefined || !sameRef(relation.schemaView, context.schemaView)) {
    return failedStatement(empty, transactionIssue('transaction.cross_source_access', undefined, { relationId: relation?.relationId ?? null }));
  }
  const keyFields = context.relationKeys.get(relation.relationId);
  if (keyFields === undefined) return failedStatement(empty, transactionIssue('transaction.cross_source_access', undefined, { relationId: relation.relationId }));
  const rows = state.rowsByRelation.get(relation.relationId) ?? [];
  if (statement.kind === 'statement.insert-generated-key') {
    const evaluated = evaluateTransactionFields(statement.fields, {}, parameters);
    if (!evaluated.success) return failedStatement(empty, evaluated.issue);
    const suppliedKey = keyFields.find((field) => Object.hasOwn(evaluated.value, field));
    if (suppliedKey !== undefined) {
      return failedStatement(empty, transactionIssue('transaction.delta_invalid', undefined, {
        relationId: relation.relationId,
        field: suppliedKey,
        reason: 'source_generated_key_supplied'
      }));
    }
    return {
      editGroups: [[{
        kind: 'insert-generated-key',
        relationId: relation.relationId,
        token: statement.token,
        fields: evaluated.value
      }]],
      result: { ...empty, inserted: 1, logicallyChanged: 1 }
    };
  }
  if (statement.kind === 'statement.insert' || statement.kind === 'statement.replace-all' || statement.kind === 'statement.upsert') {
    const candidates: Readonly<Record<string, JsonValue>>[] = [];
    for (const fields of statement.rows) {
      const evaluated = evaluateTransactionFields(fields, {}, parameters);
      if (!evaluated.success) return failedStatement(empty, evaluated.issue);
      candidates.push(evaluated.value);
    }
    if (statement.kind === 'statement.insert') {
      const inserts = insertEdits(relation.relationId, keyFields, candidates);
      if ('issue' in inserts) return failedStatement(empty, inserts.issue);
      return { editGroups: [inserts.edits], result: { ...empty, inserted: inserts.edits.length, logicallyChanged: inserts.edits.length } };
    }
    if (statement.kind === 'statement.replace-all') {
      const inserts = insertEdits(relation.relationId, keyFields, candidates);
      if ('issue' in inserts) return failedStatement(empty, inserts.issue);
      if (replacementMatchesRows(rows, candidates)) return { editGroups: [], result: { ...empty, matched: rows.length } };
      const deletes = rows.map((row): LogicalEdit => ({ kind: 'delete', relationId: row.relationId, key: row.key, locator: row.locator }));
      return {
        editGroups: [deletes, inserts.edits],
        result: { ...empty, matched: rows.length, inserted: inserts.edits.length, deleted: rows.length, logicallyChanged: deletes.length + inserts.edits.length }
      };
    }
    return evaluateUpsert(statement, empty, relation.relationId, keyFields, rows, candidates);
  }
  if (statement.kind === 'statement.insert-from-query') {
    const queried = safeEvaluateQuery(context.query, statement.root, logicalProjectionState(state), parameters, basis, 'transaction.insert_query_failed');
    if (queried.completeness !== 'exact') {
      return failedStatement(empty, ...queried.issues, transactionIssue('transaction.insert_query_incomplete', undefined, { completeness: queried.completeness }));
    }
    const candidates: Readonly<Record<string, JsonValue>>[] = [];
    for (const row of queried.rows) {
      if (!isJsonRecord(row)) return failedStatement(empty, transactionIssue('transaction.insert_query_row_invalid', undefined, { rowType: typeof row }));
      candidates.push(row);
    }
    const inserts = insertEdits(relation.relationId, keyFields, candidates);
    if ('issue' in inserts) return failedStatement(empty, inserts.issue);
    return { editGroups: [inserts.edits], result: { ...empty, inserted: inserts.edits.length, logicallyChanged: inserts.edits.length, issues: queried.issues } };
  }
  if (statement.kind === 'statement.keyed-delta') {
    return evaluateKeyedDelta(statement, empty, relation.relationId, keyFields, rows, parameters);
  }
  const selected = selectTargets(statement.target, rows, parameters);
  if (!selected.success) return failedStatement(empty, selected.issue);
  if (statement.kind === 'statement.delete') {
    return {
      editGroups: [selected.value.map((row): LogicalEdit => ({ kind: 'delete', relationId: row.relationId, key: row.key, locator: row.locator }))],
      result: { ...empty, matched: selected.value.length, logicallyChanged: selected.value.length, deleted: selected.value.length }
    };
  }
  if (statement.kind === 'statement.move' || statement.kind === 'statement.rekey') {
    return failedStatement(empty, transactionIssue('transaction.capability_unavailable', undefined, { capability: statement.requires }));
  }
  const edits: LogicalEdit[] = [];
  const outcomes: SemanticEditOutcome[] = [];
  let changed = 0;
  for (const row of selected.value) {
    const evaluated = evaluateRowEdits(row, statement.edits, statement.target.alias, parameters);
    if (!evaluated.success) return failedStatement({ ...empty, matched: selected.value.length }, evaluated.issue);
    edits.push(...evaluated.edits);
    outcomes.push(...evaluated.outcomes);
    if (evaluated.changed) changed += 1;
  }
  return {
    editGroups: [edits],
    result: { ...empty, matched: selected.value.length, logicallyChanged: changed, editOutcomes: uniqueOutcomes(outcomes) }
  };
};

const evaluateKeyedDelta = (
  statement: Extract<WriteStatement, { readonly kind: 'statement.keyed-delta' }>,
  empty: StatementResult,
  relationId: string,
  keyFields: readonly string[],
  rows: readonly WritableLogicalRow[],
  parameters: Readonly<Record<string, JsonValue>>
): EvaluatedStatement => {
  const existing = new Map<string, WritableLogicalRow[]>();
  for (const row of rows) {
    const fingerprint = canonicalizeJson(row.key);
    const bucket = existing.get(fingerprint);
    if (bucket === undefined) existing.set(fingerprint, [row]);
    else bucket.push(row);
  }
  const changedKeys = new Set<string>();
  const edits: LogicalEdit[] = [];
  const outcomes: SemanticEditOutcome[] = [];
  let matched = 0;
  let inserted = 0;
  let deleted = 0;
  let changed = 0;
  for (const change of statement.changes) {
    const fields = change.kind === 'delta.insert'
      ? evaluateTransactionFields(change.fields, {}, parameters)
      : evaluateTransactionFields(change.key, {}, parameters);
    if (!fields.success) return failedStatement(empty, fields.issue);
    const key = logicalKey(fields.value, keyFields);
    if (key === undefined) return failedStatement(empty, transactionIssue('transaction.delta_key_missing', undefined, { relationId, keyFields }));
    const fingerprint = canonicalizeJson(key);
    if (changedKeys.has(fingerprint)) return failedStatement(empty, transactionIssue('transaction.delta_input_ambiguous', undefined, { relationId, key }));
    changedKeys.add(fingerprint);
    const matches = existing.get(fingerprint) ?? [];
    if (change.kind === 'delta.insert') {
      if (matches.length > 0) return failedStatement(empty, transactionIssue('transaction.upsert_conflict', undefined, { relationId, key }));
      edits.push({ kind: 'insert', relationId, key, fields: fields.value });
      inserted += 1;
      changed += 1;
      continue;
    }
    if (matches.length !== 1) {
      return failedStatement(empty, transactionIssue(
        matches.length === 0 ? 'transaction.delta_target_missing' : 'transaction.delta_target_ambiguous',
        undefined,
        { relationId, key }
      ));
    }
    const row = matches[0] as WritableLogicalRow;
    matched += 1;
    if (change.kind === 'delta.delete') {
      edits.push({ kind: 'delete', relationId, key: row.key, locator: row.locator });
      deleted += 1;
      changed += 1;
      continue;
    }
    const evaluated = evaluateRowEdits(row, change.edits, statement.alias, parameters);
    if (!evaluated.success) return failedStatement({ ...empty, matched }, evaluated.issue);
    outcomes.push(...evaluated.outcomes);
    if (!evaluated.changed) continue;
    edits.push(...evaluated.edits);
    changed += 1;
  }
  return {
    editGroups: [edits],
    result: {
      ...empty,
      matched,
      inserted,
      deleted,
      logicallyChanged: changed,
      editOutcomes: uniqueOutcomes(outcomes)
    }
  };
};

const evaluateUpsert = (
  statement: Extract<WriteStatement, { readonly kind: 'statement.upsert' }>,
  empty: StatementResult,
  relationId: string,
  keyFields: readonly string[],
  rows: readonly WritableLogicalRow[],
  candidates: readonly Readonly<Record<string, JsonValue>>[]
): EvaluatedStatement => {
  const keyed: { readonly fields: Readonly<Record<string, JsonValue>>; readonly key: JsonValue; readonly fingerprint: string }[] = [];
  const candidateKeys = new Set<string>();
  for (const fields of candidates) {
    const key = logicalKey(fields, keyFields);
    if (key === undefined) return failedStatement(empty, transactionIssue('transaction.upsert_key_missing', undefined, { relationId, keyFields }));
    const fingerprint = canonicalizeJson(key);
    if (candidateKeys.has(fingerprint)) return failedStatement(empty, transactionIssue('transaction.upsert_input_ambiguous', undefined, { relationId }));
    candidateKeys.add(fingerprint);
    keyed.push({ fields, key, fingerprint });
  }
  const existing = new Map<string, WritableLogicalRow[]>();
  for (const row of rows) {
    const fingerprint = canonicalizeJson(row.key);
    const group = existing.get(fingerprint) ?? [];
    group.push(row);
    existing.set(fingerprint, group);
  }
  let conflicts = 0;
  for (const { fingerprint } of keyed) {
    const matches = existing.get(fingerprint)?.length ?? 0;
    if (matches > 1) return failedStatement(empty, transactionIssue('transaction.upsert_target_ambiguous', undefined, { relationId }));
    if (matches === 1) conflicts += 1;
  }
  if (statement.onConflict === 'reject' && conflicts > 0) {
    return failedStatement({ ...empty, matched: conflicts }, transactionIssue('transaction.upsert_conflict', undefined, { relationId, conflicts }));
  }
  const edits: LogicalEdit[] = [];
  let inserted = 0;
  let changed = 0;
  for (const { fields, key, fingerprint } of keyed) {
    const match = existing.get(fingerprint)?.[0];
    if (match === undefined) {
      edits.push({ kind: 'insert', relationId, key, fields });
      inserted += 1;
    } else if (statement.onConflict === 'replace' && !samePortableJson(match.fields, fields)) {
      edits.push({ kind: 'replace-row', relationId, key: match.key, locator: match.locator, fields });
      changed += 1;
    }
  }
  return { editGroups: [edits], result: { ...empty, matched: conflicts, inserted, logicallyChanged: inserted + changed } };
};

const evaluateRowEdits = (
  row: WritableLogicalRow,
  edits: Readonly<Record<string, FieldEdit>>,
  alias: string,
  parameters: Readonly<Record<string, JsonValue>>
): { readonly success: true; readonly edits: readonly LogicalEdit[]; readonly outcomes: readonly SemanticEditOutcome[]; readonly changed: boolean } | { readonly success: false; readonly issue: Issue } => {
  const logicalEdits: LogicalEdit[] = [];
  const replacements: Record<string, JsonValue> = {};
  const outcomes: SemanticEditOutcome[] = [];
  let changed = false;
  for (const [field, edit] of Object.entries(edits)) {
    if (edit.kind === 'extension' || edit.kind === 'edit.conflict-resolve') {
      return { success: false, issue: transactionIssue('transaction.capability_unavailable', undefined, { capability: edit.kind === 'extension' ? edit.capability : 'conflict-resolution-observation-adapter' }) };
    }
    const scope = { [alias]: row.fields };
    if (edit.kind === 'edit.replace') {
      const value = requireTransactionExpression(edit.value, scope, parameters);
      if (!value.success) return value;
      replacements[field] = value.value;
      if (!samePortableJson(row.fields[field], value.value)) changed = true;
      continue;
    }
    if (edit.kind === 'edit.counter-increment') {
      const amount = requireTransactionExpression(edit.amount, scope, parameters);
      if (!amount.success) return amount;
      if (typeof amount.value !== 'number' || typeof row.fields[field] !== 'number') return expressionFailure('transaction.edit_type_mismatch', { field, edit: edit.kind });
      logicalEdits.push({ kind: 'counter-increment', relationId: row.relationId, key: row.key, locator: row.locator, field, by: amount.value });
      changed ||= amount.value !== 0;
      outcomes.push({ edit: 'counter', mechanism: builtInCapabilityRefs.counterIncrement, preservationLosses: [] });
      continue;
    }
    const index = requireTransactionExpression(edit.index, scope, parameters);
    if (!index.success) return index;
    const deleteCount = requireTransactionExpression(edit.deleteCount, scope, parameters);
    if (!deleteCount.success) return deleteCount;
    if (!isIndex(index.value) || !isIndex(deleteCount.value)) return expressionFailure('transaction.edit_type_mismatch', { field, edit: edit.kind });
    if (edit.kind === 'edit.text-splice') {
      const insert = requireTransactionExpression(edit.insert, scope, parameters);
      if (!insert.success) return insert;
      if (typeof insert.value !== 'string'
        || typeof row.fields[field] !== 'string'
        || !isValidUtf16TextSplice(row.fields[field], {
          index: index.value,
          deleteCount: deleteCount.value,
          insert: insert.value
        })) {
        return expressionFailure('transaction.edit_type_mismatch', { field, edit: edit.kind, reason: 'invalid_utf16_range_or_insert' });
      }
      logicalEdits.push({ kind: 'text-splice', relationId: row.relationId, key: row.key, locator: row.locator, field, index: index.value, deleteCount: deleteCount.value, value: insert.value });
      changed ||= deleteCount.value !== 0 || insert.value.length !== 0;
      outcomes.push({ edit: 'text', mechanism: builtInCapabilityRefs.textSplice, preservationLosses: [] });
      continue;
    }
    const values: JsonValue[] = [];
    for (const expression of edit.values) {
      const value = requireTransactionExpression(expression, scope, parameters);
      if (!value.success) return value;
      values.push(value.value);
    }
    if (!Array.isArray(row.fields[field])) return expressionFailure('transaction.edit_type_mismatch', { field, edit: edit.kind });
    logicalEdits.push({ kind: 'list-splice', relationId: row.relationId, key: row.key, locator: row.locator, field, index: index.value, deleteCount: deleteCount.value, values });
    changed ||= deleteCount.value !== 0 || values.length !== 0;
    outcomes.push({ edit: 'list', mechanism: edit.requires, preservationLosses: [] });
  }
  if (Object.keys(replacements).length > 0) logicalEdits.unshift({ kind: 'replace-fields', relationId: row.relationId, key: row.key, locator: row.locator, fields: replacements });
  return { success: true, edits: logicalEdits, outcomes, changed };
};

type LogicalBindingProjection = {
  readonly rows: readonly WritableLogicalRow[];
  readonly issues: readonly Issue[];
};

type LogicalProjection = {
  readonly byBinding: ReadonlyMap<string, LogicalBindingProjection>;
  readonly rowsByRelation: ReadonlyMap<string, readonly WritableLogicalRow[]>;
  readonly issues: readonly Issue[];
};

const logicalProjectionStates = new WeakMap<LogicalProjection, WritableLogicalState>();

const emptyLogicalProjection = (issues: readonly Issue[]): LogicalProjection => ({
  byBinding: new Map(),
  rowsByRelation: new Map(),
  issues
});

const projectLogicalState = <Storage, Command>(
  bindings: readonly StorageBinding<Storage, Command>[],
  snapshot: ReturnType<AtomicSource<Storage, Command>['snapshot']>,
  previous?: LogicalProjection,
  affectedRelations?: ReadonlySet<string>
): LogicalProjection => {
  if (previous !== undefined && affectedRelations?.size === 0) return previous;
  const byBinding = new Map(previous?.byBinding ?? []);
  for (const binding of bindings) {
    const selectedRelations = affectedRelations === undefined
      ? undefined
      : binding.relationIds === undefined
        ? undefined
        : new Set(binding.relationIds.filter((relationId) => affectedRelations.has(relationId)));
    if (affectedRelations !== undefined && selectedRelations !== undefined && selectedRelations.size === 0) continue;
    const prior = byBinding.get(binding.id);
    const mustProjectFully = selectedRelations === undefined || prior === undefined || prior.issues.length > 0;
    let projection: ReturnType<typeof binding.project>;
    try {
      projection = binding.project(snapshot, mustProjectFully ? undefined : selectedRelations);
    } catch (error) {
      byBinding.set(binding.id, {
        rows: prior?.rows ?? [],
        issues: [createIssue({ code: 'observer.projection_unavailable', sourceId: snapshot.sourceId, details: { bindingId: binding.id, error: errorName(error) } })]
      });
      continue;
    }
    byBinding.set(binding.id, mergeLogicalBindingProjection({
      bindingId: binding.id,
      sourceId: snapshot.sourceId,
      projection,
      prior,
      selectedRelations: mustProjectFully ? undefined : selectedRelations
    }));
  }
  const issues: Issue[] = [];
  const rowsByRelation = affectedRelations === undefined || previous === undefined
    ? new Map<string, readonly WritableLogicalRow[]>()
    : new Map(previous.rowsByRelation);
  if (affectedRelations !== undefined && previous !== undefined) {
    for (const relationId of affectedRelations) rowsByRelation.set(relationId, []);
  }
  for (const binding of bindings) {
    const projection = byBinding.get(binding.id);
    if (projection === undefined) continue;
    issues.push(...projection.issues);
    for (const row of projection.rows) {
      if (affectedRelations !== undefined && previous !== undefined && !affectedRelations.has(row.relationId)) continue;
      const relationRows = rowsByRelation.get(row.relationId);
      if (relationRows === undefined) rowsByRelation.set(row.relationId, [row]);
      else (relationRows as WritableLogicalRow[]).push(row);
    }
  }
  return {
    byBinding,
    rowsByRelation: new Map([...rowsByRelation].map(([relationId, rows]) => [relationId, Object.freeze(rows)])),
    issues: Object.freeze(issues)
  };
};

const logicalProjectionState = (projection: LogicalProjection): WritableLogicalState => {
  const cached = logicalProjectionStates.get(projection);
  if (cached !== undefined) return cached;
  const rows: WritableLogicalRow[] = [];
  for (const relationRows of projection.rowsByRelation.values()) rows.push(...relationRows);
  const state = Object.freeze({ rows: Object.freeze(rows) });
  logicalProjectionStates.set(projection, state);
  return state;
};

/** Pure adoption and partial-refresh merge after the binding callback returns. */
const mergeLogicalBindingProjection = (input: {
  readonly bindingId: string;
  readonly sourceId: string;
  readonly projection: ReturnType<StorageBinding<unknown, unknown>['project']>;
  readonly prior: LogicalBindingProjection | undefined;
  readonly selectedRelations: ReadonlySet<string> | undefined;
}): LogicalBindingProjection => {
  const issues: Issue[] = [...input.projection.issues];
  const projectedRows: WritableLogicalRow[] = [];
  if (input.projection.completeness !== 'exact') {
    issues.push(createIssue({ code: 'observer.projection_unavailable', sourceId: input.sourceId, details: { bindingId: input.bindingId, completeness: input.projection.completeness } }));
  } else {
    for (const candidate of input.projection.rows) {
      if (!isProjectedRow(candidate)) {
        issues.push(createIssue({ code: 'observer.projection_unavailable', sourceId: input.sourceId, details: { bindingId: input.bindingId, reason: 'writable_row_shape' } }));
      } else {
        projectedRows.push(candidate);
      }
    }
  }
  const rows = input.selectedRelations === undefined
    ? projectedRows
    : [
        ...(input.prior?.rows ?? []).filter((row) => !input.selectedRelations?.has(row.relationId)),
        ...projectedRows
      ];
  return { rows: Object.freeze(rows), issues: Object.freeze(issues) };
};

const evaluateGuards = <Storage, Command>(
  context: PreparedWritableExecutionContext<Storage, Command>,
  guards: readonly TransactionGuard[],
  state: WritableLogicalState,
  parameters: Readonly<Record<string, JsonValue>>,
  results: readonly StatementResult[],
  attempt: TransactionAttempt,
  basis: SourceBasis
): readonly Issue[] => {
  const issues: Issue[] = [];
  for (const guard of guards) {
    if (guard.kind === 'extension') {
      issues.push(transactionIssue('transaction.capability_unavailable', attempt, { capability: guard.capability }));
      continue;
    }
    if (guard.kind === 'guard.affected-count') {
      const actual = results[guard.statementIndex]?.[guard.count];
      const passes = actual !== undefined && (guard.op === 'eq' ? actual === guard.value : guard.op === 'gte' ? actual >= guard.value : actual <= guard.value);
      if (!passes) issues.push(transactionIssue('transaction.guard_failed', attempt, { statementIndex: guard.statementIndex, count: guard.count, expected: guard.value, actual: actual ?? null }));
      continue;
    }
    const evaluated = safeEvaluateQuery(context.query, guard.root, state, parameters, basis, 'transaction.guard_failed');
    const passes = evaluated.completeness === 'exact' && (guard.expect === 'exists' ? evaluated.rows.length > 0 : evaluated.rows.length === 0);
    if (!passes) issues.push(...evaluated.issues, transactionIssue('transaction.guard_failed', attempt, { expect: guard.expect, completeness: evaluated.completeness }));
  }
  return issues;
};

const evaluateReturning = <Storage, Command>(
  context: PreparedWritableExecutionContext<Storage, Command>,
  prepared: PreparedExecution,
  state: WritableLogicalState,
  basis: SourceBasis
): readonly Omit<ReturningResult, 'basis'>[] | undefined => prepared.transaction.body.returning?.map(({ name, root }) => {
  const result = safeEvaluateQuery(context.query, root, state, prepared.transaction.body.parameters, basis, 'transaction.returning_failed');
  return { name, rows: result.rows, resultKeys: result.resultKeys, sourceId: context.source.sourceId, issues: result.issues };
});

const safeEvaluateQuery = (
  service: PreparedTransactionQueryService,
  root: QueryNode,
  state: WritableLogicalState,
  parameters: Readonly<Record<string, JsonValue>>,
  basis: SourceBasis,
  failureCode: string
): PreparedTransactionQueryResult => {
  try {
    return service.evaluate(root, state, parameters, basis);
  } catch (error) {
    return { rows: [], resultKeys: [], completeness: 'unknown', issues: [transactionIssue(failureCode, undefined, { error: errorName(error) })] };
  }
};

const selectTargets = (
  target: WriteTarget,
  rows: readonly WritableLogicalRow[],
  parameters: Readonly<Record<string, JsonValue>>
): { readonly success: true; readonly value: readonly WritableLogicalRow[] } | { readonly success: false; readonly issue: Issue } => {
  const selected: WritableLogicalRow[] = [];
  for (const row of rows) {
    if (target.where === undefined) {
      selected.push(row);
      continue;
    }
    const evaluated = evaluateTransactionExpression(target.where, { [target.alias]: row.fields }, parameters);
    if (!evaluated.success) return evaluated;
    if (evaluated.value === true) selected.push(row);
  }
  return { success: true, value: selected };
};

const insertEdits = (
  relationId: string,
  keyFields: readonly string[],
  candidates: readonly Readonly<Record<string, JsonValue>>[]
): { readonly edits: readonly LogicalEdit[] } | { readonly issue: Issue } => {
  const edits: LogicalEdit[] = [];
  for (const fields of candidates) {
    const key = logicalKey(fields, keyFields);
    if (key === undefined) return { issue: transactionIssue('transaction.upsert_key_missing', undefined, { relationId, keyFields }) };
    edits.push({ kind: 'insert', relationId, key, fields });
  }
  return { edits };
};

const logicalKey = (fields: Readonly<Record<string, JsonValue>>, keyFields: readonly string[]): JsonValue | undefined => {
  if (keyFields.length === 0) return undefined;
  const key: JsonValue[] = [];
  for (const field of keyFields) {
    if (!Object.hasOwn(fields, field)) return undefined;
    key.push(fields[field] as JsonValue);
  }
  return key;
};

const replacementMatchesRows = (
  rows: readonly WritableLogicalRow[],
  candidates: readonly Readonly<Record<string, JsonValue>>[]
): boolean => {
  if (rows.length !== candidates.length) return false;
  const counts = new Map<string, number>();
  for (const { fields } of rows) {
    const fingerprint = canonicalizeJson(fields as JsonValue);
    counts.set(fingerprint, (counts.get(fingerprint) ?? 0) + 1);
  }
  for (const fields of candidates) {
    const fingerprint = canonicalizeJson(fields as JsonValue);
    const count = counts.get(fingerprint);
    if (count === undefined) return false;
    if (count === 1) counts.delete(fingerprint);
    else counts.set(fingerprint, count - 1);
  }
  return counts.size === 0;
};

const rejectedEvaluation = <Storage, Command>(
  snapshot: ReturnType<AtomicSource<Storage, Command>['snapshot']>,
  basis: SourceBasis,
  state: WritableLogicalState,
  issues: readonly Issue[]
): EvaluatedExecution<Storage, Command> => ({
  beforeBasis: basis,
  stagedSnapshot: snapshot,
  logicalState: state,
  commands: [],
  statementResults: [],
  issues,
  blockingIssues: issues.filter(isError)
});

const rejectedReceipt = <Storage, Command>(
  context: PreparedWritableExecutionContext<Storage, Command>,
  prepared: PreparedExecution,
  evaluated: EvaluatedExecution<Storage, Command>
): CommitReceipt => ({
  ...receiptEvidence(context, prepared, evaluated.statementResults, evaluated.issues),
  outcome: 'rejected',
  beforeBasis: evaluated.beforeBasis
});

const rejectedBeforeSnapshotReceipt = <Storage, Command>(
  context: PreparedWritableExecutionContext<Storage, Command>,
  prepared: PreparedExecution,
  issue: Issue
): CommitReceipt => ({
  ...receiptEvidence(context, prepared, [], [issue]),
  outcome: 'rejected'
});

const receiptEvidence = <Storage, Command>(
  context: PreparedWritableExecutionContext<Storage, Command>,
  prepared: PreparedExecution,
  statementResults: readonly StatementResult[],
  issues: readonly Issue[],
  returning?: readonly ReturningResult[],
  generatedKeys?: readonly GeneratedLogicalKey[]
) => rawReceiptEvidence(
  context,
  prepared.attempt,
  prepared.transaction.contentHash,
  prepared.intentHash,
  statementResults,
  issues,
  returning,
  generatedKeys
);

const rawReceiptEvidence = <Storage, Command>(
  context: PreparedWritableExecutionContext<Storage, Command>,
  attempt: TransactionAttempt,
  transactionHash: ContentHash,
  intentHash: ContentHash,
  statementResults: readonly StatementResult[],
  issues: readonly Issue[],
  returning?: readonly ReturningResult[],
  generatedKeys?: readonly GeneratedLogicalKey[]
) => ({
  kind: 'commit' as const,
  receiptVersion: 1 as const,
  operationEpoch: attempt.operationEpoch,
  operationId: attempt.operationId,
  transactionHash,
  intentHash,
  attachmentId: context.attachmentId,
  attachmentFingerprint: context.attachmentFingerprint,
  sourceId: context.source.sourceId,
  statementResults,
  ...(generatedKeys === undefined ? {} : { generatedKeys }),
  ...(returning === undefined ? {} : { returning }),
  issues
});

const transactionIntentHash = <Storage, Command>(
  context: PreparedWritableExecutionContext<Storage, Command>,
  attempt: TransactionAttempt,
  transactionHash: ContentHash
): Promise<ContentHash> => sha256Json({
  operationEpoch: attempt.operationEpoch,
  transactionHash,
  attachmentId: context.attachmentId,
  attachmentFingerprint: context.attachmentFingerprint,
  ...(attempt.expectedBasis === undefined ? {} : { expectedBasis: attempt.expectedBasis }),
  authorityViewFingerprint: context.authorityViewFingerprint
});

const commitRejectionAsSimulation = (receipt: CommitReceipt): SimulationReceipt => ({
  kind: 'simulation',
  receiptVersion: 1,
  operationEpoch: receipt.operationEpoch,
  operationId: receipt.operationId,
  transactionHash: receipt.transactionHash,
  intentHash: receipt.intentHash,
  attachmentId: receipt.attachmentId,
  attachmentFingerprint: receipt.attachmentFingerprint,
  sourceId: receipt.sourceId,
  outcome: 'rejected',
  ...(receipt.beforeBasis === undefined ? {} : { beforeBasis: receipt.beforeBasis }),
  statementResults: receipt.statementResults,
  issues: receipt.issues
});

const adoptAttempt = (input: TransactionAttempt): TransactionAttempt => {
  if (!isRecord(input) || typeof input.operationEpoch !== 'string' || typeof input.operationId !== 'string' || typeof input.attachmentId !== 'string' || !isRecord(input.transaction)) {
    throw new TypeError('Transaction attempt must contain owned string identifiers and a transaction value');
  }
  return Object.freeze({
    operationEpoch: input.operationEpoch,
    operationId: input.operationId,
    attachmentId: input.attachmentId,
    transaction: input.transaction,
    ...(input.expectedBasis === undefined ? {} : { expectedBasis: input.expectedBasis }),
    ...(input.signal === undefined ? {} : { signal: input.signal })
  });
};

const isProjectedRow = (value: unknown): value is WritableLogicalRow => {
  if (!isRecord(value) || typeof value.relationId !== 'string' || !isJsonRecord(value.fields)) return false;
  try {
    canonicalizeJson(value.key as JsonValue);
    canonicalizeJson(value.locator as JsonValue);
    canonicalizeJson(value.fields as JsonValue);
    return true;
  } catch {
    return false;
  }
};

const assertPreparedWritableContext = (context: object): void => {
  if (!preparedWritableContexts.has(context)) throw new TypeError('Writable execution context was not produced by prepareWritableExecutionContext');
};

const isOperationLedger = (value: unknown): value is OperationLedgerProtocol<CommitReceipt> => isRecord(value)
  && typeof value.activeEpoch === 'string'
  && (value.retention === 'memory' || value.retention === 'durable')
  && typeof value.reserve === 'function'
  && typeof value.complete === 'function'
  && typeof value.recordEvidence === 'function'
  && typeof value.lookup === 'function'
  && typeof value.rotateEpoch === 'function';

const isArtifactReference = (value: unknown): value is ArtifactRef => isRecord(value)
  && typeof value.id === 'string'
  && value.id.length > 0
  && isContentHash(value.contentHash)
  && (value.locations === undefined || (Array.isArray(value.locations) && value.locations.every((location) => typeof location === 'string')));

const isTransaction = (value: Transaction | ArtifactRef): value is Transaction => 'kind' in value && value.kind === 'transaction' && 'body' in value;
const sameRef = (left: ArtifactRef, right: ArtifactRef): boolean => left.id === right.id && left.contentHash === right.contentHash;
const isError = (issue: Issue): boolean => issue.severity === 'error';
const emptyStatementResult = (statementIndex: number): StatementResult => ({
  statementIndex,
  matched: 0,
  logicallyChanged: 0,
  inserted: 0,
  deleted: 0,
  editOutcomes: [],
  issues: []
});

const failedStatement = (
  empty: StatementResult,
  ...issues: readonly Issue[]
): EvaluatedStatement => ({ editGroups: [], result: { ...empty, issues } });

const statementRelation = (statement: WriteStatement): WriteRelation | undefined => {
  switch (statement.kind) {
    case 'extension': return undefined;
    case 'statement.insert':
    case 'statement.insert-generated-key':
    case 'statement.insert-from-query':
    case 'statement.upsert':
    case 'statement.replace-all':
    case 'statement.keyed-delta':
      return statement.relation;
    default:
      return statement.target.relation;
  }
};

const expressionFailure = (
  code: string,
  details: JsonValue
): { readonly success: false; readonly issue: Issue } => ({
  success: false,
  issue: transactionIssue(code, undefined, details)
});

const transactionIssue = (
  code: string,
  attempt?: Pick<TransactionAttempt, 'operationId'>,
  details?: JsonValue,
  retry?: Issue['retry']
): Issue => createIssue({
  code,
  ...(attempt === undefined ? {} : { operationId: attempt.operationId }),
  ...(details === undefined ? {} : { details }),
  ...(retry === undefined ? {} : { retry })
});
const errorName = (error: unknown): string => error instanceof Error ? error.name : typeof error;
const signalAborted = (signal?: AbortSignal): boolean => signal?.aborted === true;
const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const isJsonRecord = (value: unknown): value is Readonly<Record<string, JsonValue>> =>
  isRecord(value) && Object.values(value).every((child) => {
    try {
      canonicalizeJson(child as JsonValue);
      return true;
    } catch {
      return false;
    }
  });
const isIndex = (value: JsonValue): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const uniqueOutcomes = (
  outcomes: readonly SemanticEditOutcome[]
): readonly SemanticEditOutcome[] => [...new Map(outcomes.map((outcome) => [
  canonicalizeJson(outcome as unknown as JsonValue),
  outcome
])).values()];
