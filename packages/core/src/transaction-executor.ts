import { canonicalizeJson, isContentHash, sha256Json, type ArtifactRef, type ContentHash } from './artifacts.js';
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
import type { SourceBasis } from './maintenance.js';
import { comparePortableStrings } from './portable-order.js';
import type { QueryNode } from './query.js';
import { safeParseTransactionArtifact } from './semantic-artifact-parsers.js';
import type { AtomicSource, LogicalEdit, StorageBinding } from './source-protocol.js';
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
  type WriteExpression,
  type WriteRelation,
  type WriteStatement,
  type WriteTarget
} from './transaction.js';
import { logicalAnd, logicalNot, logicalOr, logicalUnknown, type JsonValue, type LogicalTruth } from './value.js';

export type WritableLogicalRow = {
  readonly relationId: string;
  readonly key: JsonValue;
  readonly fields: Readonly<Record<string, JsonValue>>;
  readonly locator: JsonValue;
};

export type WritableLogicalState = {
  readonly rows: readonly WritableLogicalRow[];
};

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
  readonly source: AtomicSource<Storage, Command>;
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
    bindings: Object.freeze([...input.bindings]),
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
  ], prior?.returning),
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
  const evaluated = evaluatePreparedExecution(context, prepared);
  if (evaluated.blockingIssues.length > 0) {
    return completePreparedExecution(context, prepared, reservation.entry, rejectedReceipt(context, prepared, evaluated));
  }
  if (prepared.attempt.signal?.aborted === true) {
    const receipt = rejectedReceipt(context, prepared, {
      ...evaluated,
      issues: [...evaluated.issues, transactionIssue('transaction.cancelled', prepared.attempt, { timing: 'before_handoff' })],
      blockingIssues: [transactionIssue('transaction.cancelled', prepared.attempt, { timing: 'before_handoff' })]
    });
    return completePreparedExecution(context, prepared, reservation.entry, receipt);
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
    const receipt: CommitReceipt = {
      ...receiptEvidence(context, prepared, evaluated.statementResults, [
        ...evaluated.issues,
        transactionIssue('transaction.outcome_unavailable', prepared.attempt, { error: errorName(error) }, 'query_outcome')
      ]),
      outcome: 'unknown',
      beforeBasis: evaluated.beforeBasis,
      durability: 'unknown'
    };
    return completePreparedExecution(context, prepared, reservation.entry, receipt);
  }
  const issues = [...evaluated.issues, ...outcome.issues];
  if (outcome.outcome === 'rejected') {
    const receipt: CommitReceipt = {
      ...receiptEvidence(context, prepared, evaluated.statementResults, issues),
      outcome: 'rejected',
      ...(outcome.beforeBasis === undefined ? {} : { beforeBasis: outcome.beforeBasis })
    };
    return completePreparedExecution(context, prepared, reservation.entry, receipt);
  }
  if (outcome.outcome === 'unknown' || outcome.beforeBasis === undefined || outcome.afterBasis === undefined) {
    const receipt: CommitReceipt = {
      ...receiptEvidence(context, prepared, evaluated.statementResults, issues),
      outcome: 'unknown',
      ...(outcome.beforeBasis === undefined ? {} : { beforeBasis: outcome.beforeBasis }),
      durability: 'unknown'
    };
    return completePreparedExecution(context, prepared, reservation.entry, receipt);
  }
  const returning = evaluated.returning?.map((result): ReturningResult => ({ ...result, basis: outcome.afterBasis as SourceBasis }));
  const receipt: CommitReceipt = {
    ...receiptEvidence(context, prepared, evaluated.statementResults, issues, returning),
    outcome: 'committed',
    beforeBasis: outcome.beforeBasis,
    afterBasis: outcome.afterBasis,
    durability: context.durability
  };
  return completePreparedExecution(context, prepared, reservation.entry, receipt);
};

export const simulatePreparedTransaction = async <Storage, Command>(
  context: PreparedWritableExecutionContext<Storage, Command>,
  attempt: TransactionAttempt
): Promise<SimulationReceipt> => {
  assertPreparedWritableContext(context);
  const preparedAttempt = adoptAttempt(attempt);
  const prepared = await prepareExecution(context, preparedAttempt);
  if ('receipt' in prepared) return commitRejectionAsSimulation(prepared.receipt);
  const evaluated = evaluatePreparedExecution(context, prepared);
  return {
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
  };
};

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
  if (attempt.signal?.aborted === true) {
    return reject([transactionIssue('transaction.cancelled', attempt, { timing: 'preparation' }, 'never')]);
  }
  let candidate: Transaction | undefined;
  if (isTransaction(attempt.transaction)) candidate = attempt.transaction;
  else {
    try {
      candidate = await context.resolveTransaction?.(attempt.transaction, attempt.signal);
    } catch (error) {
      return reject([transactionIssue('transaction.artifact_unavailable', attempt, { error: errorName(error) })]);
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
  const transaction = parsed.value;
  if (!sameRef(transaction.body.schemaView, context.schemaView)) {
    return reject([transactionIssue('transaction.schema_view_unavailable', attempt, { schemaView: transaction.body.schemaView })]);
  }
  const missing = transaction.body.requiredCapabilities.filter((capability) => !context.satisfiesCapability(capability));
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
  prepared: PreparedExecution
): EvaluatedExecution<Storage, Command> => {
  const beforeSnapshot = context.source.snapshot();
  const beforeBasis = beforeSnapshot.basis;
  const earlyIssues: Issue[] = [];
  if (beforeSnapshot.state !== 'ready' || beforeSnapshot.storage === undefined) {
    earlyIssues.push(createIssue({ code: 'source.not_ready', sourceId: context.source.sourceId, details: { state: beforeSnapshot.state } }));
  }
  if (beforeSnapshot.operationEpoch !== context.operationEpoch) {
    earlyIssues.push(transactionIssue('transaction.operation_epoch_expired', prepared.attempt, { snapshotEpoch: beforeSnapshot.operationEpoch }, 'never'));
  }
  if (prepared.attempt.expectedBasis !== undefined && !samePortable(prepared.attempt.expectedBasis, beforeBasis)) {
    earlyIssues.push(transactionIssue('transaction.expected_basis_stale', prepared.attempt, {
      expected: prepared.attempt.expectedBasis,
      actual: beforeBasis
    }, 'after_refresh'));
  }
  const initialProjection = earlyIssues.length === 0
    ? projectLogicalState(context.bindings, beforeSnapshot)
    : { state: emptyLogicalState, issues: earlyIssues };
  if (initialProjection.issues.some(isError)) {
    return rejectedEvaluation(beforeSnapshot, beforeBasis, initialProjection.state, initialProjection.issues);
  }
  let stagedSnapshot = beforeSnapshot;
  let stagedBasis = beforeBasis;
  let logicalState = initialProjection.state;
  const beforeState = logicalState;
  const commands: Command[] = [];
  const statementResults: StatementResult[] = [];
  const issues: Issue[] = [...initialProjection.issues];
  const touchedRelations = new Set<string>();
  for (const [statementIndex, statement] of prepared.transaction.body.statements.entries()) {
    const statementStart = logicalState;
    const evaluated = evaluateStatement(context, statement, statementIndex, statementStart, prepared.transaction.body.parameters, stagedBasis);
    statementResults.push(evaluated.result);
    issues.push(...evaluated.result.issues);
    if (evaluated.result.issues.some(isError)) break;
    let statementRejected = false;
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
      commands.push(...staged.commands);
      issues.push(...staged.issues);
    }
    if (statementRejected) break;
    const projected = projectLogicalState(context.bindings, stagedSnapshot);
    issues.push(...projected.issues);
    if (projected.issues.some(isError)) break;
    logicalState = projected.state;
    statementResults[statementIndex] = reconcileStatementResult(
      statement,
      statementStart,
      logicalState,
      prepared.transaction.body.parameters,
      evaluated.result
    );
    const relation = statementRelation(statement);
    if (relation !== undefined) touchedRelations.add(relation.relationId);
  }
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
  before: WritableLogicalState,
  after: WritableLogicalState,
  parameters: Readonly<Record<string, JsonValue>>,
  result: StatementResult
): StatementResult => {
  if (statement.kind !== 'statement.update') return result;
  const relationId = statement.target.relation.relationId;
  const selected = selectTargets(
    statement.target,
    before.rows.filter((row) => row.relationId === relationId),
    parameters
  );
  if (!selected.success) return result;
  let logicallyChanged = 0;
  for (const row of selected.value) {
    const projected = after.rows.find((candidate) =>
      candidate.relationId === relationId && samePortable(candidate.locator, row.locator)
    );
    if (projected === undefined || !samePortable(projected.fields, row.fields)) logicallyChanged += 1;
  }
  return logicallyChanged === result.logicallyChanged ? result : { ...result, logicallyChanged };
};

const deriveStagedBasis = <Storage, Command>(
  context: PreparedWritableExecutionContext<Storage, Command>,
  before: ReturnType<AtomicSource<Storage, Command>['snapshot']>,
  staged: ReturnType<AtomicSource<Storage, Command>['snapshot']>
): { readonly basis: SourceBasis } | { readonly issue: Issue } => {
  if (staged.storage === undefined || context.source.basisForStagedStorage === undefined) {
    return { issue: transactionIssue('transaction.staged_basis_unavailable', undefined, { reason: 'basis_derivation_unavailable' }, 'after_refresh') };
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
  state: WritableLogicalState,
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
  const rows = state.rows.filter(({ relationId }) => relationId === relation.relationId);
  if (statement.kind === 'statement.insert' || statement.kind === 'statement.replace-all' || statement.kind === 'statement.upsert') {
    const candidates: Readonly<Record<string, JsonValue>>[] = [];
    for (const fields of statement.rows) {
      const evaluated = evaluateFields(fields, {}, parameters);
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
    const queried = safeEvaluateQuery(context.query, statement.root, state, parameters, basis, 'transaction.insert_query_failed');
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

const evaluateUpsert = (
  statement: Extract<WriteStatement, { readonly kind: 'statement.upsert' }>,
  empty: StatementResult,
  relationId: string,
  keyFields: readonly string[],
  rows: readonly WritableLogicalRow[],
  candidates: readonly Readonly<Record<string, JsonValue>>[]
): EvaluatedStatement => {
  const keyed = candidates.map((fields) => ({ fields, key: logicalKey(fields, keyFields) }));
  if (keyed.some(({ key }) => key === undefined)) return failedStatement(empty, transactionIssue('transaction.upsert_key_missing', undefined, { relationId, keyFields }));
  const fingerprints = keyed.map(({ key }) => canonicalizeJson(key as JsonValue));
  if (new Set(fingerprints).size !== fingerprints.length) return failedStatement(empty, transactionIssue('transaction.upsert_input_ambiguous', undefined, { relationId }));
  const existing = new Map<string, WritableLogicalRow[]>();
  for (const row of rows) {
    const group = existing.get(canonicalizeJson(row.key)) ?? [];
    group.push(row);
    existing.set(canonicalizeJson(row.key), group);
  }
  const conflicts = fingerprints.filter((fingerprint) => (existing.get(fingerprint)?.length ?? 0) > 0);
  if (conflicts.some((fingerprint) => (existing.get(fingerprint)?.length ?? 0) > 1)) {
    return failedStatement(empty, transactionIssue('transaction.upsert_target_ambiguous', undefined, { relationId }));
  }
  if (statement.onConflict === 'reject' && conflicts.length > 0) {
    return failedStatement({ ...empty, matched: conflicts.length }, transactionIssue('transaction.upsert_conflict', undefined, { relationId, conflicts: conflicts.length }));
  }
  const edits: LogicalEdit[] = [];
  let inserted = 0;
  let changed = 0;
  keyed.forEach(({ fields, key }, index) => {
    const match = existing.get(fingerprints[index] as string)?.[0];
    if (match === undefined) {
      edits.push({ kind: 'insert', relationId, key: key as JsonValue, fields });
      inserted += 1;
    } else if (statement.onConflict === 'replace' && !samePortable(match.fields, fields)) {
      edits.push({ kind: 'replace-row', relationId, key: match.key, locator: match.locator, fields });
      changed += 1;
    }
  });
  return { editGroups: [edits], result: { ...empty, matched: conflicts.length, inserted, logicallyChanged: inserted + changed } };
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
      const value = requireExpression(edit.value, scope, parameters);
      if (!value.success) return value;
      replacements[field] = value.value;
      if (!samePortable(row.fields[field], value.value)) changed = true;
      continue;
    }
    if (edit.kind === 'edit.counter-increment') {
      const amount = requireExpression(edit.amount, scope, parameters);
      if (!amount.success) return amount;
      if (typeof amount.value !== 'number' || typeof row.fields[field] !== 'number') return expressionFailure('transaction.edit_type_mismatch', { field, edit: edit.kind });
      logicalEdits.push({ kind: 'counter-increment', relationId: row.relationId, key: row.key, locator: row.locator, field, by: amount.value });
      changed ||= amount.value !== 0;
      outcomes.push({ edit: 'counter', mechanism: builtInCapabilityRefs.counterIncrement, preservationLosses: [] });
      continue;
    }
    const index = requireExpression(edit.index, scope, parameters);
    if (!index.success) return index;
    const deleteCount = requireExpression(edit.deleteCount, scope, parameters);
    if (!deleteCount.success) return deleteCount;
    if (!isIndex(index.value) || !isIndex(deleteCount.value)) return expressionFailure('transaction.edit_type_mismatch', { field, edit: edit.kind });
    if (edit.kind === 'edit.text-splice') {
      const insert = requireExpression(edit.insert, scope, parameters);
      if (!insert.success) return insert;
      if (typeof insert.value !== 'string' || typeof row.fields[field] !== 'string') return expressionFailure('transaction.edit_type_mismatch', { field, edit: edit.kind });
      logicalEdits.push({ kind: 'text-splice', relationId: row.relationId, key: row.key, locator: row.locator, field, index: index.value, deleteCount: deleteCount.value, value: insert.value });
      changed ||= deleteCount.value !== 0 || insert.value.length !== 0;
      outcomes.push({ edit: 'text', mechanism: builtInCapabilityRefs.textSplice, preservationLosses: [] });
      continue;
    }
    const values: JsonValue[] = [];
    for (const expression of edit.values) {
      const value = requireExpression(expression, scope, parameters);
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

const projectLogicalState = <Storage, Command>(
  bindings: readonly StorageBinding<Storage, Command>[],
  snapshot: ReturnType<AtomicSource<Storage, Command>['snapshot']>
): { readonly state: WritableLogicalState; readonly issues: readonly Issue[] } => {
  const rows: WritableLogicalRow[] = [];
  const issues: Issue[] = [];
  for (const binding of [...bindings].sort((left, right) => comparePortableStrings(left.id, right.id))) {
    let projection: ReturnType<typeof binding.project>;
    try {
      projection = binding.project(snapshot);
    } catch (error) {
      issues.push(createIssue({ code: 'observer.projection_unavailable', sourceId: snapshot.sourceId, details: { bindingId: binding.id, error: errorName(error) } }));
      continue;
    }
    issues.push(...projection.issues);
    if (projection.completeness !== 'exact') {
      issues.push(createIssue({ code: 'observer.projection_unavailable', sourceId: snapshot.sourceId, details: { bindingId: binding.id, completeness: projection.completeness } }));
      continue;
    }
    for (const candidate of projection.rows) {
      if (!isProjectedRow(candidate)) {
        issues.push(createIssue({ code: 'observer.projection_unavailable', sourceId: snapshot.sourceId, details: { bindingId: binding.id, reason: 'writable_row_shape' } }));
        continue;
      }
      rows.push(candidate);
    }
  }
  return { state: Object.freeze({ rows: Object.freeze(rows) }), issues: Object.freeze(issues) };
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
    const evaluated = evaluateExpression(target.where, { [target.alias]: row.fields }, parameters);
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
  if (keyFields.length === 0 || keyFields.some((field) => !Object.hasOwn(fields, field))) return undefined;
  return keyFields.map((field) => fields[field] as JsonValue);
};

const replacementMatchesRows = (
  rows: readonly WritableLogicalRow[],
  candidates: readonly Readonly<Record<string, JsonValue>>[]
): boolean => {
  if (rows.length !== candidates.length) return false;
  const current = rows.map(({ fields }) => canonicalizeJson(fields as JsonValue)).sort(comparePortableStrings);
  const replacement = candidates.map((fields) => canonicalizeJson(fields as JsonValue)).sort(comparePortableStrings);
  return current.every((value, index) => value === replacement[index]);
};

const evaluateFields = (
  fields: Readonly<Record<string, WriteExpression>>,
  scope: Readonly<Record<string, Readonly<Record<string, JsonValue>>>>,
  parameters: Readonly<Record<string, JsonValue>>
): { readonly success: true; readonly value: Readonly<Record<string, JsonValue>> } | { readonly success: false; readonly issue: Issue } => {
  const row: Record<string, JsonValue> = {};
  for (const [field, expression] of Object.entries(fields)) {
    const value = requireExpression(expression, scope, parameters);
    if (!value.success) return value;
    row[field] = value.value;
  }
  return { success: true, value: row };
};

type ExpressionResult =
  | { readonly success: true; readonly value: JsonValue | typeof logicalUnknown }
  | { readonly success: false; readonly issue: Issue };

const requireExpression = (
  expression: WriteExpression,
  scope: Readonly<Record<string, Readonly<Record<string, JsonValue>>>>,
  parameters: Readonly<Record<string, JsonValue>>
): { readonly success: true; readonly value: JsonValue } | { readonly success: false; readonly issue: Issue } => {
  const result = evaluateExpression(expression, scope, parameters);
  if (!result.success) return result;
  return result.value === logicalUnknown
    ? expressionFailure('transaction.expression_indeterminate', { expression: expression.kind })
    : { success: true, value: result.value };
};

const evaluateExpression = (
  expression: WriteExpression,
  scope: Readonly<Record<string, Readonly<Record<string, JsonValue>>>>,
  parameters: Readonly<Record<string, JsonValue>>
): ExpressionResult => {
  if (expression.kind === 'literal') return { success: true, value: expression.value };
  if (expression.kind === 'parameter') {
    return Object.hasOwn(parameters, expression.name)
      ? { success: true, value: parameters[expression.name] as JsonValue }
      : expressionFailure('transaction.parameter_missing', { parameter: expression.name });
  }
  if (expression.kind === 'field') {
    const row = scope[expression.alias];
    return row !== undefined && Object.hasOwn(row, expression.name)
      ? { success: true, value: row[expression.name] as JsonValue }
      : { success: true, value: logicalUnknown };
  }
  if (expression.kind === 'compare') {
    const left = evaluateExpression(expression.left, scope, parameters);
    if (!left.success) return left;
    const right = evaluateExpression(expression.right, scope, parameters);
    if (!right.success) return right;
    if (left.value === logicalUnknown || right.value === logicalUnknown || left.value === null || right.value === null) return { success: true, value: logicalUnknown };
    const comparison = compareValues(left.value, right.value);
    if (comparison === undefined) return { success: true, value: logicalUnknown };
    return { success: true, value: expression.op === 'eq' ? comparison === 0 : expression.op === 'ne' ? comparison !== 0 : expression.op === 'lt' ? comparison < 0 : expression.op === 'lte' ? comparison <= 0 : expression.op === 'gt' ? comparison > 0 : comparison >= 0 };
  }
  if (expression.op === 'not') {
    const value = evaluateExpression(expression.arg, scope, parameters);
    return value.success ? { success: true, value: logicalNot(asTruth(value.value)) } : value;
  }
  const values: LogicalTruth[] = [];
  for (const arg of expression.args) {
    const value = evaluateExpression(arg, scope, parameters);
    if (!value.success) return value;
    values.push(asTruth(value.value));
  }
  return { success: true, value: expression.op === 'and' ? logicalAnd(values) : logicalOr(values) };
};

const compareValues = (left: JsonValue, right: JsonValue): number | undefined => {
  if (typeof left === 'number' && typeof right === 'number') return left - right;
  if (typeof left === 'string' && typeof right === 'string') return comparePortableStrings(left, right);
  if (typeof left === 'boolean' && typeof right === 'boolean') return Number(left) - Number(right);
  if ((Array.isArray(left) && Array.isArray(right)) || (isJsonRecord(left) && isJsonRecord(right))) return comparePortableStrings(canonicalizeJson(left), canonicalizeJson(right));
  return undefined;
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

const receiptEvidence = <Storage, Command>(
  context: PreparedWritableExecutionContext<Storage, Command>,
  prepared: PreparedExecution,
  statementResults: readonly StatementResult[],
  issues: readonly Issue[],
  returning?: readonly ReturningResult[]
) => rawReceiptEvidence(context, prepared.attempt, prepared.transaction.contentHash, prepared.intentHash, statementResults, issues, returning);

const rawReceiptEvidence = <Storage, Command>(
  context: PreparedWritableExecutionContext<Storage, Command>,
  attempt: TransactionAttempt,
  transactionHash: ContentHash,
  intentHash: ContentHash,
  statementResults: readonly StatementResult[],
  issues: readonly Issue[],
  returning?: readonly ReturningResult[]
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
const samePortable = (left: unknown, right: unknown): boolean => {
  try { return canonicalizeJson(left as JsonValue) === canonicalizeJson(right as JsonValue); } catch { return false; }
};
const isError = (issue: Issue): boolean => issue.severity === 'error';
const emptyLogicalState: WritableLogicalState = Object.freeze({ rows: Object.freeze([]) });
const emptyStatementResult = (statementIndex: number): StatementResult => ({ statementIndex, matched: 0, logicallyChanged: 0, inserted: 0, deleted: 0, editOutcomes: [], issues: [] });
const failedStatement = (empty: StatementResult, ...issues: readonly Issue[]): EvaluatedStatement => ({ editGroups: [], result: { ...empty, issues } });
const statementRelation = (statement: WriteStatement): WriteRelation | undefined => statement.kind === 'extension' ? undefined : statement.kind === 'statement.insert' || statement.kind === 'statement.insert-from-query' || statement.kind === 'statement.upsert' || statement.kind === 'statement.replace-all' ? statement.relation : statement.target.relation;
const expressionFailure = (code: string, details: JsonValue): { readonly success: false; readonly issue: Issue } => ({ success: false, issue: transactionIssue(code, undefined, details) });
const transactionIssue = (code: string, attempt?: Pick<TransactionAttempt, 'operationId'>, details?: JsonValue, retry?: Issue['retry']): Issue => createIssue({ code, ...(attempt === undefined ? {} : { operationId: attempt.operationId }), ...(details === undefined ? {} : { details }), ...(retry === undefined ? {} : { retry }) });
const errorName = (error: unknown): string => error instanceof Error ? error.name : typeof error;
const isRecord = (value: unknown): value is Readonly<Record<string, any>> => value !== null && typeof value === 'object' && !Array.isArray(value);
const isJsonRecord = (value: unknown): value is Readonly<Record<string, JsonValue>> => isRecord(value) && Object.values(value).every((child) => {
  try { canonicalizeJson(child as JsonValue); return true; } catch { return false; }
});
const isIndex = (value: JsonValue): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const asTruth = (value: JsonValue | typeof logicalUnknown): LogicalTruth => value === true ? true : value === false ? false : logicalUnknown;
const uniqueOutcomes = (outcomes: readonly SemanticEditOutcome[]): readonly SemanticEditOutcome[] => [...new Map(outcomes.map((outcome) => [canonicalizeJson(outcome as unknown as JsonValue), outcome])).values()];
