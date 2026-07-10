import { artifactSemanticValue, safeParseArtifactValue, sha256Json, type ArtifactRef, type ContentHash } from './artifacts.js';
import { checkFinalConstraints, type SourceConstraint } from './constraints.js';
import { createIssue, type CapabilityRef, type Issue, type IssuePhase, type IssueRetry } from './issues.js';
import type { SourceBasis } from './maintenance.js';
import {
  emptyStatementResult,
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
import { logicalAnd, logicalNot, logicalOr, logicalUnknown, type LogicalTruth, type JsonValue } from './value.js';

export type MemoryBasis = { readonly incarnation: string; readonly revision: number };
export type MemoryRow = Readonly<Record<string, JsonValue>>;
export type MemoryState = Readonly<Record<string, readonly MemoryRow[]>>;

export type MemoryRelation = {
  readonly relationId: string;
  readonly schemaView: ArtifactRef;
  readonly keyFields: readonly string[];
};

export type MemoryAttachment = {
  readonly attachmentId: string;
  readonly fingerprint: ContentHash;
  readonly authorityViewFingerprint: ContentHash;
  readonly schemaView: ArtifactRef;
  readonly writable: boolean;
};

export type MemoryQueryResult = {
  readonly rows: readonly unknown[];
  readonly resultKeys: readonly string[];
  readonly completeness: 'exact' | 'lower-bound' | 'unknown';
  readonly issues: readonly Issue[];
};

export type OutcomeLookup =
  | { readonly status: 'known'; readonly receipt: CommitReceipt }
  | { readonly status: 'not_seen' }
  | { readonly status: 'ambiguous' }
  | { readonly status: 'expired' }
  | { readonly status: 'unavailable' };

type PreparedAttempt = {
  readonly attempt: TransactionAttempt;
  readonly transaction: Transaction;
  readonly attachment: MemoryAttachment;
  readonly intentHash: ContentHash;
};

type LedgerEntry = {
  readonly intentHash: ContentHash;
  receipt?: CommitReceipt;
};

type EvaluatedAttempt = {
  readonly state: MemoryState;
  readonly changed: boolean;
  readonly touchedRelations: ReadonlySet<string>;
  readonly statementResults: readonly StatementResult[];
  readonly blockingIssues: readonly Issue[];
  readonly issues: readonly Issue[];
};

type ExpressionResult =
  | { readonly success: true; readonly value: JsonValue | typeof logicalUnknown }
  | { readonly success: false; readonly issue: Issue };

const builtinMechanisms = {
  counter: capability('field/counter-increment', '9df5e2507b3d10ca1d40c3e7b0b42c9c6de272a02ebaee8b69a838206f881963'),
  text: capability('field/text-splice', '9a9cc22f2768d5de353a390682e17430952614e8e30eb8fc12992170d4c5d0fc'),
  conflict: capability('field/conflict-resolve', 'd2f90f3c1fcda78718037d6c4c1d27b7155e276c92c14fd2c2d4fb08aa9729d3')
} as const;

export class InMemoryAtomicSource {
  readonly sourceId: string;
  readonly incarnation: string;
  readonly #relations: ReadonlyMap<string, MemoryRelation>;
  readonly #attachments: ReadonlyMap<string, MemoryAttachment>;
  readonly #constraints: readonly SourceConstraint<MemoryState>[];
  readonly #resolveArtifact: ((ref: ArtifactRef) => Promise<Transaction | undefined> | Transaction | undefined) | undefined;
  readonly #evaluateQuery: ((root: JsonValue, state: MemoryState, parameters: Readonly<Record<string, JsonValue>>) => MemoryQueryResult) | undefined;
  readonly #satisfiesCapability: (capability: CapabilityRef) => boolean;
  readonly #listeners = new Set<() => void>();
  readonly #ledger = new Map<string, LedgerEntry>();
  readonly #retiredEpochs = new Set<string>();
  #activeEpoch: string;
  #state: MemoryState;
  #revision = 0;
  #queue: Promise<void> = Promise.resolve();

  constructor(options: {
    readonly sourceId: string;
    readonly incarnation: string;
    readonly operationEpoch: string;
    readonly state: MemoryState;
    readonly relations: readonly MemoryRelation[];
    readonly attachments: readonly MemoryAttachment[];
    readonly constraints?: readonly SourceConstraint<MemoryState>[];
    readonly resolveArtifact?: (ref: ArtifactRef) => Promise<Transaction | undefined> | Transaction | undefined;
    readonly evaluateQuery?: (root: JsonValue, state: MemoryState, parameters: Readonly<Record<string, JsonValue>>) => MemoryQueryResult;
    readonly satisfiesCapability?: (capability: CapabilityRef) => boolean;
  }) {
    this.sourceId = options.sourceId;
    this.incarnation = options.incarnation;
    this.#activeEpoch = options.operationEpoch;
    this.#state = cloneState(options.state);
    this.#relations = new Map(options.relations.map((relation) => [relation.relationId, relation]));
    this.#attachments = new Map(options.attachments.map((attachment) => [attachment.attachmentId, attachment]));
    this.#constraints = options.constraints ?? [];
    this.#resolveArtifact = options.resolveArtifact;
    this.#evaluateQuery = options.evaluateQuery;
    this.#satisfiesCapability = options.satisfiesCapability ?? (() => true);
  }

  snapshot(): { readonly basis: MemoryBasis; readonly state: MemoryState } {
    return { basis: this.#basis(), state: cloneState(this.#state) };
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** Simulation is advisory and intentionally does not join the commit queue or reserve an operation ID. */
  async simulate(attempt: TransactionAttempt): Promise<SimulationReceipt> {
    const prepared = await this.#prepare(attempt);
    if ('receipt' in prepared) return { ...prepared.receipt, kind: 'simulation', outcome: 'rejected' };
    const before = this.snapshot();
    const evaluated = this.#evaluate(prepared, before.state, before.basis);
    return {
      kind: 'simulation',
      receiptVersion: 1,
      operationEpoch: attempt.operationEpoch,
      operationId: attempt.operationId,
      transactionHash: prepared.transaction.contentHash,
      intentHash: prepared.intentHash,
      attachmentId: attempt.attachmentId,
      attachmentFingerprint: prepared.attachment.fingerprint,
      sourceId: this.sourceId,
      beforeBasis: before.basis,
      afterBasis: evaluated.changed ? { incarnation: this.incarnation, revision: before.basis.revision + 1 } : before.basis,
      outcome: evaluated.blockingIssues.length === 0 ? 'would-commit' : 'rejected',
      statementResults: evaluated.statementResults,
      issues: evaluated.issues,
      ...(evaluated.blockingIssues.length === 0 ? { stagedState: evaluated.state } : {})
    };
  }

  commit(attempt: TransactionAttempt): Promise<CommitReceipt> {
    const run = this.#queue.then(async () => {
      const prepared = await this.#prepare(attempt);
      if ('receipt' in prepared) return prepared.receipt;
      // This is the explicit source-handoff boundary. Cancellation and all
      // shell checks above it leave no operation-ledger evidence.
      if (attempt.signal?.aborted === true) return this.#reject(prepared, [], [txIssue('transaction.cancelled', 'commit', { timing: 'before_handoff' }, attempt, 'never')]);
      return this.#handoff(prepared);
    });
    this.#queue = run.then(() => undefined, () => undefined);
    return run;
  }

  queryOutcome(input: { readonly operationEpoch: string; readonly operationId: string; readonly intentHash: ContentHash }): OutcomeLookup {
    if (this.#retiredEpochs.has(input.operationEpoch)) return { status: 'expired' };
    if (input.operationEpoch !== this.#activeEpoch) return { status: 'unavailable' };
    const entry = this.#ledger.get(operationKey(input.operationEpoch, input.operationId));
    if (entry === undefined) return { status: 'not_seen' };
    if (entry.intentHash !== input.intentHash) return { status: 'ambiguous' };
    return entry.receipt === undefined ? { status: 'unavailable' } : { status: 'known', receipt: entry.receipt };
  }

  /** Retires the complete previous epoch atomically; its IDs can never bind to the new epoch. */
  rotateOperationEpoch(nextEpoch: string): void {
    if (nextEpoch.length === 0 || nextEpoch === this.#activeEpoch || this.#retiredEpochs.has(nextEpoch)) throw new Error('Operation epoch must be new and non-empty');
    this.#retiredEpochs.add(this.#activeEpoch);
    for (const key of this.#ledger.keys()) if (key.startsWith(this.#activeEpoch + '\u0000')) this.#ledger.delete(key);
    this.#activeEpoch = nextEpoch;
  }

  /** Decoded receipt eviction cannot erase the authoritative ledger outcome. */
  evictReceiptCache(): void {}

  async #prepare(attempt: TransactionAttempt): Promise<PreparedAttempt | { readonly receipt: CommitReceipt }> {
    const attachment = this.#attachments.get(attempt.attachmentId);
    const transactionHash = attempt.transaction.contentHash;
    const fallbackAttachment = attachment ?? {
      attachmentId: attempt.attachmentId,
      fingerprint: unknownHash,
      authorityViewFingerprint: unknownHash,
      schemaView: { id: 'urn:tarstate:unavailable', contentHash: unknownHash },
      writable: false
    };
    const intentHash = await intentHashFor(attempt, transactionHash, fallbackAttachment);
    const reject = (issues: readonly Issue[]) => ({ receipt: this.#rejectRaw(attempt, transactionHash, intentHash, fallbackAttachment.fingerprint, [], issues) });
    if (attempt.operationEpoch !== this.#activeEpoch) return reject([txIssue('transaction.operation_epoch_expired', 'commit', { operationEpoch: attempt.operationEpoch }, attempt, 'never')]);
    if (attachment === undefined) return reject([txIssue('transaction.attachment_unavailable', 'resolve', { attachmentId: attempt.attachmentId }, attempt, 'after_refresh')]);
    if (!attachment.writable) return reject([txIssue('transaction.authority_denied', 'commit', { attachmentId: attempt.attachmentId }, attempt, 'after_authority')]);
    let transaction: Transaction | undefined;
    if (isTransaction(attempt.transaction)) {
      const parsed = await safeParseArtifactValue(attempt.transaction);
      if (!parsed.success) return reject(parsed.issues);
      transaction = attempt.transaction;
    } else {
      transaction = await this.#resolveArtifact?.(attempt.transaction);
      if (transaction === undefined) return reject([txIssue('transaction.artifact_unavailable', 'resolve', { transactionHash }, attempt, 'after_refresh')]);
      if (transaction.contentHash !== attempt.transaction.contentHash || transaction.id !== attempt.transaction.id) return reject([txIssue('artifact.dependency_mismatch', 'resolve', { expected: attempt.transaction, actual: { id: transaction.id, contentHash: transaction.contentHash } }, attempt, 'after_input')]);
    }
    const computedHash = await sha256Json(artifactSemanticValue(transaction));
    if (computedHash !== transaction.contentHash) return reject([txIssue('artifact.hash_mismatch', 'parse', { expected: transaction.contentHash, actual: computedHash }, attempt, 'after_input')]);
    if (!validTransactionBody(transaction.body)) return reject([txIssue('artifact.invalid_envelope', 'parse', { member: 'transaction.body' }, attempt, 'after_input')]);
    if (transaction.body.schemaView.id !== attachment.schemaView.id || transaction.body.schemaView.contentHash !== attachment.schemaView.contentHash) return reject([txIssue('transaction.schema_view_unavailable', 'resolve', { schemaView: transaction.body.schemaView }, attempt, 'after_refresh')]);
    const unavailable = transaction.body.requiredCapabilities.filter((capabilityRef) => !this.#satisfiesCapability(capabilityRef));
    if (unavailable.length > 0) return reject([txIssue('transaction.capability_unavailable', 'resolve', { capabilities: unavailable }, attempt, 'after_capability')]);
    const returningNames = transaction.body.returning?.map(({ name }) => name) ?? [];
    if (new Set(returningNames).size !== returningNames.length) return reject([txIssue('transaction.returning_name_duplicate', 'parse', { names: returningNames }, attempt, 'after_input')]);
    return { attempt, transaction, attachment, intentHash };
  }

  #handoff(prepared: PreparedAttempt): CommitReceipt {
    const { attempt } = prepared;
    const key = operationKey(attempt.operationEpoch, attempt.operationId);
    const existing = this.#ledger.get(key);
    if (existing !== undefined) {
      if (existing.intentHash !== prepared.intentHash) return this.#reject(prepared, [], [txIssue('transaction.operation_id_ambiguous', 'commit', undefined, attempt, 'never')]);
      if (existing.receipt === undefined) return this.#reject(prepared, [], [txIssue('transaction.outcome_unavailable', 'commit', undefined, attempt, 'query_outcome')]);
      return existing.receipt;
    }
    // Reserve the identity before any evaluation that can lead to mutation or
    // a handed-off rejection. The reservation is correctness state.
    const ledgerEntry: LedgerEntry = { intentHash: prepared.intentHash };
    this.#ledger.set(key, ledgerEntry);
    const before = this.snapshot();
    let receipt: CommitReceipt;
    try {
      const evaluated = this.#evaluate(prepared, before.state, before.basis);
      if (evaluated.blockingIssues.length > 0) {
        receipt = this.#reject(prepared, evaluated.statementResults, evaluated.issues, before.basis);
      } else {
        const afterBasis = evaluated.changed ? { incarnation: this.incarnation, revision: this.#revision + 1 } : this.#basis();
        const returning = this.#returning(prepared, afterBasis, evaluated.state);
        if (evaluated.changed) {
          this.#state = evaluated.state;
          this.#revision += 1;
        }
        receipt = {
          kind: 'commit', receiptVersion: 1,
          operationEpoch: attempt.operationEpoch, operationId: attempt.operationId,
          transactionHash: prepared.transaction.contentHash, intentHash: prepared.intentHash,
          attachmentId: attempt.attachmentId, attachmentFingerprint: prepared.attachment.fingerprint,
          sourceId: this.sourceId, outcome: 'committed', beforeBasis: before.basis, afterBasis,
          statementResults: evaluated.statementResults,
          ...(returning === undefined ? {} : { returning }),
          issues: evaluated.issues,
          durability: 'memory'
        };
        ledgerEntry.receipt = receipt;
        if (evaluated.changed) for (const listener of this.#listeners) {
          try { listener(); } catch { /* Observation callbacks cannot change a known commit outcome. */ }
        }
        return receipt;
      }
    } catch (error) {
      receipt = this.#reject(prepared, [], [txIssue('transaction.unexpected_failure', 'commit', { error: error instanceof Error ? error.name : typeof error }, attempt, 'after_refresh')], before.basis);
    }
    ledgerEntry.receipt = receipt;
    return receipt;
  }

  #evaluate(prepared: PreparedAttempt, sourceState: MemoryState, basis: MemoryBasis): EvaluatedAttempt {
    const { attempt, transaction } = prepared;
    if (attempt.expectedBasis !== undefined && !sameJson(attempt.expectedBasis, basis)) {
      const issue = txIssue('transaction.expected_basis_stale', 'commit', { expected: attempt.expectedBasis, actual: basis }, attempt, 'after_refresh');
      return { state: sourceState, changed: false, touchedRelations: new Set(), statementResults: [], blockingIssues: [issue], issues: [issue] };
    }
    const staged = cloneState(sourceState) as Record<string, readonly MemoryRow[]>;
    const touched = new Set<string>();
    const statementResults: StatementResult[] = [];
    const blockingIssues: Issue[] = [];
    const statementAuditIssues: Issue[] = [];
    for (const [statementIndex, statement] of transaction.body.statements.entries()) {
      const result = this.#applyStatement(statement, statementIndex, staged, transaction.body.parameters);
      statementResults.push(result);
      const statementBlockingIssues = result.issues.filter(({ severity }) => severity === 'error');
      blockingIssues.push(...statementBlockingIssues);
      statementAuditIssues.push(...result.issues.filter(({ severity }) => severity !== 'error'));
      const relationId = statementRelation(statement)?.relationId;
      if (relationId !== undefined) touched.add(relationId);
      if (statementBlockingIssues.length > 0) break;
    }
    if (blockingIssues.length === 0) blockingIssues.push(...this.#evaluateGuards(transaction.body.guards, staged, transaction.body.parameters, statementResults, attempt));
    const logicallyChanged = !sameJson(sourceState, staged);
    const proposedBasis: MemoryBasis = logicallyChanged ? { incarnation: this.incarnation, revision: basis.revision + 1 } : basis;
    let auditIssues: readonly Issue[] = [];
    if (blockingIssues.length === 0) {
      const constraints = checkFinalConstraints({ constraints: this.#constraints, before: sourceState, after: staged, beforeBasis: basis, afterBasis: proposedBasis, touchedRelations: touched });
      blockingIssues.push(...constraints.blockingIssues);
      auditIssues = constraints.auditIssues;
    }
    return {
      state: blockingIssues.length === 0 ? staged : sourceState,
      changed: blockingIssues.length === 0 && logicallyChanged,
      touchedRelations: touched,
      statementResults,
      blockingIssues,
      issues: [...blockingIssues, ...statementAuditIssues, ...auditIssues]
    };
  }

  #applyStatement(statement: WriteStatement, statementIndex: number, state: Record<string, readonly MemoryRow[]>, parameters: Readonly<Record<string, JsonValue>>): StatementResult {
    const empty = emptyStatementResult(statementIndex);
    if (statement.kind === 'extension') return { ...empty, issues: [txIssue('transaction.capability_unavailable', 'plan', { capability: statement.capability })] };
    const relation = statementRelation(statement);
    if (relation === undefined) return { ...empty, issues: [txIssue('transaction.statement_invalid', 'parse')] };
    const relationIssue = this.#relationIssue(relation);
    if (relationIssue !== undefined) return { ...empty, issues: [relationIssue] };
    const relationId = relation.relationId;
    const rows = state[relationId] ?? [];
    if (statement.kind === 'statement.insert') {
      const inserted: MemoryRow[] = [];
      for (const fields of statement.rows) {
        const evaluated = evaluateFields(fields, {}, parameters);
        if (!evaluated.success) return { ...empty, issues: [evaluated.issue] };
        inserted.push(evaluated.value);
      }
      state[relationId] = [...rows, ...inserted];
      return { ...empty, inserted: inserted.length, logicallyChanged: inserted.length };
    }
    if (statement.kind === 'statement.insert-from-query') {
      if (this.#evaluateQuery === undefined) return { ...empty, issues: [txIssue('transaction.capability_unavailable', 'plan', { capability: 'query-evaluator' })] };
      let evaluated: MemoryQueryResult;
      try {
        evaluated = this.#evaluateQuery(statement.root, state, parameters);
      } catch (error) {
        return { ...empty, issues: [txIssue('transaction.insert_query_failed', 'query', { error: error instanceof Error ? error.name : typeof error })] };
      }
      if (evaluated.completeness !== 'exact') {
        return { ...empty, issues: [...evaluated.issues, txIssue('transaction.insert_query_incomplete', 'query', { completeness: evaluated.completeness })] };
      }
      const inserted: MemoryRow[] = [];
      for (const candidate of evaluated.rows) {
        if (!isMemoryRow(candidate)) return { ...empty, issues: [txIssue('transaction.insert_query_row_invalid', 'parse', { rowType: Array.isArray(candidate) ? 'array' : typeof candidate })] };
        inserted.push({ ...candidate });
      }
      state[relationId] = [...rows, ...inserted];
      return { ...empty, inserted: inserted.length, logicallyChanged: inserted.length, issues: evaluated.issues };
    }
    if (statement.kind === 'statement.replace-all') {
      const replacement: MemoryRow[] = [];
      for (const fields of statement.rows) {
        const evaluated = evaluateFields(fields, {}, parameters);
        if (!evaluated.success) return { ...empty, issues: [evaluated.issue] };
        replacement.push(evaluated.value);
      }
      if (sameJson(rows as unknown as JsonValue, replacement as unknown as JsonValue)) return { ...empty, matched: rows.length };
      state[relationId] = replacement;
      return { ...empty, matched: rows.length, inserted: replacement.length, deleted: rows.length, logicallyChanged: rows.length + replacement.length };
    }
    if (statement.kind === 'statement.upsert') {
      const relationDeclaration = this.#relations.get(relationId) as MemoryRelation;
      if (relationDeclaration.keyFields.length === 0) return { ...empty, issues: [txIssue('transaction.upsert_key_unavailable', 'plan', { relationId })] };
      const candidates: MemoryRow[] = [];
      for (const fields of statement.rows) {
        const evaluated = evaluateFields(fields, {}, parameters);
        if (!evaluated.success) return { ...empty, issues: [evaluated.issue] };
        if (relationDeclaration.keyFields.some((field) => !Object.hasOwn(evaluated.value, field))) {
          return { ...empty, issues: [txIssue('transaction.upsert_key_missing', 'plan', { relationId, keyFields: relationDeclaration.keyFields })] };
        }
        candidates.push(evaluated.value);
      }
      const candidateKeys = candidates.map((row) => rowKey(row, relationDeclaration.keyFields));
      if (new Set(candidateKeys).size !== candidateKeys.length) return { ...empty, issues: [txIssue('transaction.upsert_input_ambiguous', 'plan', { relationId })] };
      const existingByKey = new Map<string, number[]>();
      for (const [index, row] of rows.entries()) {
        const key = rowKey(row, relationDeclaration.keyFields);
        const indexes = existingByKey.get(key) ?? [];
        indexes.push(index);
        existingByKey.set(key, indexes);
      }
      const conflicts = candidateKeys.filter((key) => (existingByKey.get(key)?.length ?? 0) > 0);
      if (conflicts.some((key) => (existingByKey.get(key)?.length ?? 0) > 1)) return { ...empty, issues: [txIssue('transaction.upsert_target_ambiguous', 'plan', { relationId })] };
      if (statement.onConflict === 'reject' && conflicts.length > 0) return { ...empty, matched: conflicts.length, issues: [txIssue('transaction.upsert_conflict', 'plan', { relationId, conflicts: conflicts.length })] };
      const next = [...rows];
      let inserted = 0;
      let changed = 0;
      for (const [candidateIndex, candidate] of candidates.entries()) {
        const existing = existingByKey.get(candidateKeys[candidateIndex] as string);
        if (existing === undefined) {
          next.push(candidate);
          inserted += 1;
        } else if (statement.onConflict === 'replace') {
          const targetIndex = existing[0] as number;
          if (!sameJson(next[targetIndex] as MemoryRow, candidate)) changed += 1;
          next[targetIndex] = candidate;
        }
      }
      state[relationId] = next;
      return { ...empty, matched: conflicts.length, inserted, logicallyChanged: inserted + changed };
    }
    const selected = selectTargets(statement.target, rows, parameters);
    if (!selected.success) return { ...empty, issues: [selected.issue] };
    const matches = selected.value;
    if (statement.kind === 'statement.delete') {
      const indexes = new Set(matches.map(({ index }) => index));
      state[relationId] = rows.filter((_row, index) => !indexes.has(index));
      return { ...empty, matched: matches.length, logicallyChanged: matches.length, deleted: matches.length };
    }
    if (statement.kind === 'statement.move') return { ...empty, matched: matches.length, issues: [txIssue('transaction.capability_unavailable', 'plan', { capability: statement.requires })] };
    const next = [...rows];
    let changed = 0;
    const outcomes: SemanticEditOutcome[] = [];
    for (const { index, row } of matches) {
      const scope = { [statement.target.alias]: row };
      let replacement: MemoryRow;
      if (statement.kind === 'statement.rekey') {
        const key = evaluateFields(statement.key, scope, parameters);
        if (!key.success) return { ...empty, matched: matches.length, issues: [key.issue] };
        replacement = { ...row, ...key.value };
        outcomes.push({ edit: 'rekey', mechanism: statement.requires, preservationLosses: [] });
      } else {
        const edited = applyFieldEdits(row, statement.edits, scope, parameters);
        if (!edited.success) return { ...empty, matched: matches.length, issues: [edited.issue] };
        replacement = edited.value.row;
        outcomes.push(...edited.value.outcomes);
      }
      if (!sameJson(row, replacement)) changed += 1;
      next[index] = replacement;
    }
    state[relationId] = next;
    return { ...empty, matched: matches.length, logicallyChanged: changed, editOutcomes: uniqueOutcomes(outcomes) };
  }

  #evaluateGuards(guards: readonly TransactionGuard[], state: MemoryState, parameters: Readonly<Record<string, JsonValue>>, results: readonly StatementResult[], attempt: TransactionAttempt): Issue[] {
    const issues: Issue[] = [];
    for (const guard of guards) {
      if (guard.kind === 'extension') { issues.push(txIssue('transaction.capability_unavailable', 'plan', { capability: guard.capability }, attempt)); continue; }
      if (guard.kind === 'guard.affected-count') {
        const result = results[guard.statementIndex];
        const actual = result?.[guard.count];
        const pass = actual !== undefined && (guard.op === 'eq' ? actual === guard.value : guard.op === 'gte' ? actual >= guard.value : actual <= guard.value);
        if (!pass) issues.push(txIssue('transaction.guard_failed', 'constraint', { statementIndex: guard.statementIndex, count: guard.count, expected: guard.value, actual: actual ?? null }, attempt, 'after_refresh'));
        continue;
      }
      if (this.#evaluateQuery === undefined) { issues.push(txIssue('transaction.capability_unavailable', 'plan', { capability: 'query-evaluator' }, attempt, 'after_capability')); continue; }
      const evaluated = this.#evaluateQuery(guard.root, state, parameters);
      const pass = evaluated.completeness === 'exact' && (guard.expect === 'exists' ? evaluated.rows.length > 0 : evaluated.rows.length === 0);
      if (!pass) issues.push(...evaluated.issues, txIssue('transaction.guard_failed', 'constraint', { expect: guard.expect, completeness: evaluated.completeness }, attempt, 'after_refresh'));
    }
    return issues;
  }

  #returning(prepared: PreparedAttempt, basis: MemoryBasis, state: MemoryState): readonly ReturningResult[] | undefined {
    const returning = prepared.transaction.body.returning;
    if (returning === undefined) return undefined;
    if (this.#evaluateQuery === undefined) return returning.map(({ name }) => ({ name, rows: [], resultKeys: [], sourceId: this.sourceId, basis, issues: [txIssue('transaction.capability_unavailable', 'query', { capability: 'query-evaluator' }, prepared.attempt, 'after_capability')] }));
    return returning.map(({ name, root }) => {
      try {
        const result = this.#evaluateQuery?.(root, state, prepared.transaction.body.parameters) as MemoryQueryResult;
        return { name, rows: result.rows, resultKeys: result.resultKeys, sourceId: this.sourceId, basis, issues: result.issues };
      } catch (error) {
        return { name, rows: [], resultKeys: [], sourceId: this.sourceId, basis, issues: [txIssue('transaction.returning_failed', 'query', { error: error instanceof Error ? error.name : typeof error }, prepared.attempt, 'after_refresh')] };
      }
    });
  }

  #relationIssue(use: WriteRelation): Issue | undefined {
    const relation = this.#relations.get(use.relationId);
    return relation === undefined || relation.schemaView.id !== use.schemaView.id || relation.schemaView.contentHash !== use.schemaView.contentHash
      ? txIssue('transaction.cross_source_access', 'plan', { relationId: use.relationId }, undefined, 'never', { relationId: use.relationId, sourceId: this.sourceId })
      : undefined;
  }

  #reject(prepared: PreparedAttempt, statementResults: readonly StatementResult[], issues: readonly Issue[], beforeBasis?: SourceBasis): CommitReceipt {
    return this.#rejectRaw(prepared.attempt, prepared.transaction.contentHash, prepared.intentHash, prepared.attachment.fingerprint, statementResults, issues, beforeBasis);
  }

  #rejectRaw(attempt: TransactionAttempt, transactionHash: ContentHash, intentHash: ContentHash, attachmentFingerprint: ContentHash, statementResults: readonly StatementResult[], issues: readonly Issue[], beforeBasis?: SourceBasis): CommitReceipt {
    return {
      kind: 'commit', receiptVersion: 1,
      operationEpoch: attempt.operationEpoch, operationId: attempt.operationId,
      transactionHash, intentHash, attachmentId: attempt.attachmentId, attachmentFingerprint,
      sourceId: this.sourceId, outcome: 'rejected',
      ...(beforeBasis === undefined ? {} : { beforeBasis }),
      statementResults, issues
    };
  }

  #basis(): MemoryBasis { return { incarnation: this.incarnation, revision: this.#revision }; }
}

const applyFieldEdits = (
  row: MemoryRow,
  edits: Readonly<Record<string, FieldEdit>>,
  scope: Readonly<Record<string, MemoryRow>>,
  parameters: Readonly<Record<string, JsonValue>>
): { readonly success: true; readonly value: { readonly row: MemoryRow; readonly outcomes: readonly SemanticEditOutcome[] } } | { readonly success: false; readonly issue: Issue } => {
  const next: Record<string, JsonValue> = { ...row };
  const outcomes: SemanticEditOutcome[] = [];
  for (const [field, edit] of Object.entries(edits)) {
    if (edit.kind === 'extension') return { success: false, issue: txIssue('transaction.capability_unavailable', 'plan', { capability: edit.capability }) };
    if (edit.kind === 'edit.replace') {
      const value = requireExpression(edit.value, scope, parameters);
      if (!value.success) return value;
      next[field] = value.value;
      continue;
    }
    if (edit.kind === 'edit.counter-increment') {
      const amount = requireExpression(edit.amount, scope, parameters);
      if (!amount.success) return amount;
      if (typeof next[field] !== 'number' || typeof amount.value !== 'number') return expressionIssue('transaction.edit_type_mismatch', { field, edit: edit.kind });
      next[field] += amount.value;
      outcomes.push({ edit: 'counter', mechanism: builtinMechanisms.counter, preservationLosses: [] });
      continue;
    }
    if (edit.kind === 'edit.text-splice') {
      const index = requireExpression(edit.index, scope, parameters);
      if (!index.success) return index;
      const deleteCount = requireExpression(edit.deleteCount, scope, parameters);
      if (!deleteCount.success) return deleteCount;
      const insert = requireExpression(edit.insert, scope, parameters);
      if (!insert.success) return insert;
      if (typeof next[field] !== 'string' || !isIndex(index.value) || !isIndex(deleteCount.value) || typeof insert.value !== 'string') return expressionIssue('transaction.edit_type_mismatch', { field, edit: edit.kind });
      next[field] = next[field].slice(0, index.value) + insert.value + next[field].slice(index.value + deleteCount.value);
      outcomes.push({ edit: 'text', mechanism: builtinMechanisms.text, preservationLosses: [] });
      continue;
    }
    if (edit.kind === 'edit.list-splice') {
      const index = requireExpression(edit.index, scope, parameters);
      if (!index.success) return index;
      const deleteCount = requireExpression(edit.deleteCount, scope, parameters);
      if (!deleteCount.success) return deleteCount;
      const values: JsonValue[] = [];
      for (const expression of edit.values) {
        const value = requireExpression(expression, scope, parameters);
        if (!value.success) return value;
        values.push(value.value);
      }
      if (!Array.isArray(next[field]) || !isIndex(index.value) || !isIndex(deleteCount.value)) return expressionIssue('transaction.edit_type_mismatch', { field, edit: edit.kind });
      const existing = next[field] as readonly JsonValue[];
      next[field] = [...existing.slice(0, index.value), ...values, ...existing.slice(index.value + deleteCount.value)];
      outcomes.push({ edit: 'list', mechanism: edit.requires, preservationLosses: [] });
      continue;
    }
    const value = requireExpression(edit.value, scope, parameters);
    if (!value.success) return value;
    const current = next[field];
    if (current === undefined || !edit.observed.some((candidate) => sameJson(candidate, current))) return expressionIssue('transaction.conflict_changed', { field });
    next[field] = value.value;
    outcomes.push({ edit: 'custom', mechanism: builtinMechanisms.conflict, preservationLosses: [] });
  }
  return { success: true, value: { row: next, outcomes } };
};

const selectTargets = (target: WriteTarget, rows: readonly MemoryRow[], parameters: Readonly<Record<string, JsonValue>>):
  { readonly success: true; readonly value: readonly { readonly index: number; readonly row: MemoryRow }[] } | { readonly success: false; readonly issue: Issue } => {
  const selected: { index: number; row: MemoryRow }[] = [];
  for (const [index, row] of rows.entries()) {
    if (target.where === undefined) { selected.push({ index, row }); continue; }
    const evaluated = evaluateExpression(target.where, { [target.alias]: row }, parameters);
    if (!evaluated.success) return evaluated;
    if (evaluated.value === true) selected.push({ index, row });
  }
  return { success: true, value: selected };
};

const evaluateFields = (fields: Readonly<Record<string, WriteExpression>>, scope: Readonly<Record<string, MemoryRow>>, parameters: Readonly<Record<string, JsonValue>>):
  { readonly success: true; readonly value: MemoryRow } | { readonly success: false; readonly issue: Issue } => {
  const row: Record<string, JsonValue> = {};
  for (const [field, expression] of Object.entries(fields)) {
    const value = requireExpression(expression, scope, parameters);
    if (!value.success) return value;
    row[field] = value.value;
  }
  return { success: true, value: row };
};

const requireExpression = (expression: WriteExpression, scope: Readonly<Record<string, MemoryRow>>, parameters: Readonly<Record<string, JsonValue>>):
  { readonly success: true; readonly value: JsonValue } | { readonly success: false; readonly issue: Issue } => {
  const result = evaluateExpression(expression, scope, parameters);
  if (!result.success) return result;
  return result.value === logicalUnknown ? expressionIssue('transaction.expression_indeterminate', { expression: expression.kind }) : { success: true, value: result.value };
};

const evaluateExpression = (expression: WriteExpression, scope: Readonly<Record<string, MemoryRow>>, parameters: Readonly<Record<string, JsonValue>>): ExpressionResult => {
  if (expression.kind === 'literal') return { success: true, value: expression.value };
  if (expression.kind === 'parameter') return Object.hasOwn(parameters, expression.name)
    ? { success: true, value: parameters[expression.name] as JsonValue }
    : expressionIssue('transaction.parameter_missing', { parameter: expression.name });
  if (expression.kind === 'field') {
    const row = scope[expression.alias];
    return row !== undefined && Object.hasOwn(row, expression.name) ? { success: true, value: row[expression.name] as JsonValue } : { success: true, value: logicalUnknown };
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
    const arg = evaluateExpression(expression.arg, scope, parameters);
    return arg.success ? { success: true, value: logicalNot(asTruth(arg.value)) } : arg;
  }
  const args: LogicalTruth[] = [];
  for (const expressionArg of expression.args) {
    const arg = evaluateExpression(expressionArg, scope, parameters);
    if (!arg.success) return arg;
    args.push(asTruth(arg.value));
  }
  return { success: true, value: expression.op === 'and' ? logicalAnd(args) : logicalOr(args) };
};

const asTruth = (value: JsonValue | typeof logicalUnknown): LogicalTruth => value === true ? true : value === false ? false : logicalUnknown;

const compareValues = (left: JsonValue, right: JsonValue): number | undefined => {
  if (typeof left === 'number' && typeof right === 'number') return left - right;
  if (typeof left === 'string' && typeof right === 'string') return left.localeCompare(right);
  if (typeof left === 'boolean' && typeof right === 'boolean') return Number(left) - Number(right);
  if ((Array.isArray(left) && Array.isArray(right)) || (isRecord(left) && isRecord(right))) return canonical(left).localeCompare(canonical(right));
  return undefined;
};

const expressionIssue = (code: string, details: JsonValue): { readonly success: false; readonly issue: Issue } => ({ success: false, issue: txIssue(code, 'plan', details, undefined, 'after_input') });

const intentHashFor = (attempt: TransactionAttempt, transactionHash: ContentHash, attachment: MemoryAttachment): Promise<ContentHash> => sha256Json({
  operationEpoch: attempt.operationEpoch,
  transactionHash,
  attachmentId: attempt.attachmentId,
  attachmentFingerprint: attachment.fingerprint,
  ...(attempt.expectedBasis === undefined ? {} : { expectedBasis: attempt.expectedBasis }),
  authorityViewFingerprint: attachment.authorityViewFingerprint
});

const validTransactionBody = (body: Transaction['body']): boolean => isRecord(body) && isRecord(body.parameters) && Array.isArray(body.statements) && Array.isArray(body.guards) && Array.isArray(body.requiredCapabilities) && isRecord(body.schemaView);

const isTransaction = (value: Transaction | ArtifactRef): value is Transaction => 'kind' in value && value.kind === 'transaction' && 'body' in value;

const operationKey = (operationEpoch: string, operationId: string): string => operationEpoch + '\u0000' + operationId;
const statementRelation = (statement: WriteStatement): WriteRelation | undefined => {
  if (statement.kind === 'extension') return undefined;
  if (statement.kind === 'statement.insert' || statement.kind === 'statement.insert-from-query' || statement.kind === 'statement.upsert' || statement.kind === 'statement.replace-all') return statement.relation;
  return statement.target.relation;
};
const cloneState = (state: MemoryState): MemoryState => Object.fromEntries(Object.entries(state).map(([relationId, rows]) => [relationId, rows.map((row) => ({ ...row }))]));
const canonical = (value: JsonValue): string => JSON.stringify(value, (_key, candidate: unknown) => isRecord(candidate) ? Object.fromEntries(Object.entries(candidate).sort(([left], [right]) => left.localeCompare(right))) : candidate);
const sameJson = (left: JsonValue | MemoryState, right: JsonValue | MemoryState): boolean => canonical(left as JsonValue) === canonical(right as JsonValue);
const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> => typeof value === 'object' && value !== null && !Array.isArray(value);
const isJsonValue = (value: unknown): value is JsonValue => value === null || typeof value === 'boolean' || typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value)) || (Array.isArray(value) && value.every(isJsonValue)) || (isRecord(value) && Object.values(value).every(isJsonValue));
const isMemoryRow = (value: unknown): value is MemoryRow => isRecord(value) && Object.values(value).every(isJsonValue);
const rowKey = (row: MemoryRow, fields: readonly string[]): string => canonical(fields.map((field) => Object.hasOwn(row, field) ? row[field] as JsonValue : { missing: field }));
const isIndex = (value: JsonValue): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const uniqueOutcomes = (outcomes: readonly SemanticEditOutcome[]): readonly SemanticEditOutcome[] => [...new Map(outcomes.map((outcome) => [canonical(outcome as unknown as JsonValue), outcome])).values()];
function capability(suffix: string, hash: string): CapabilityRef { return { id: 'urn:tarstate:capability:' + suffix, version: '1', contractHash: `sha256:${hash}` }; }
const unknownHash = `sha256:${'0'.repeat(64)}` as const;

const txIssue = (
  code: string,
  phase: IssuePhase,
  details?: JsonValue,
  attempt?: Pick<TransactionAttempt, 'operationId'>,
  retry?: IssueRetry,
  context: { readonly sourceId?: string; readonly relationId?: string } = {}
): Issue => createIssue({ code, phase, severity: 'error', ...(details === undefined ? {} : { details }), ...(attempt === undefined ? {} : { operationId: attempt.operationId }), ...(retry === undefined ? {} : { retry }), ...context });
