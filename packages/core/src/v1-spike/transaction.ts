import { capabilityRef } from './capabilities.js';
import { evaluateExpression, evaluateQuery, type RelationInput, type ScopedRow } from './evaluator.js';
import { sha256Canonical } from './hash.js';
import { canonicalJson, issue, sameJson, type BaseTarget, type Expr, type Guard, type Issue, type JsonValue, type QueryNode, type RelationUse, type Statement } from './wire.js';

export type SourceBasis = { readonly incarnation: string; readonly revision: number };
export type MemoryRow = Readonly<Record<string, JsonValue>>;
export type MemoryStorage = Readonly<Record<string, readonly MemoryRow[]>>;

export type Footprint = {
  readonly relations: '*' | readonly string[];
  readonly certainty?: 'known' | 'unknown';
};

export type FootprintRelation = 'disjoint' | 'equal' | 'contains' | 'contained_by' | 'overlaps' | 'unknown';

export type MemoryCommand = {
  readonly kind: 'set-relation';
  readonly relationId: string;
  readonly rows: readonly MemoryRow[];
};

export type MemoryBinding = {
  readonly id: string;
  readonly relationIds: readonly string[];
  readonly declaredReadFootprint: Footprint;
  readonly declaredWriteFootprint: Footprint;
  readonly planFootprint?: (relations: readonly string[]) => Footprint;
  readonly mapCommand?: (command: MemoryCommand) => MemoryCommand;
};

export type MemoryRelation = {
  readonly use: RelationUse;
  readonly keyFields: readonly string[];
};

export type SpikeConstraint = {
  readonly constraintId: string;
  readonly violationQuery: QueryNode;
  readonly code: string;
};

export type StatementResult = {
  readonly statementIndex: number;
  readonly matched: number;
  readonly logicallyChanged: number;
  readonly inserted: number;
  readonly deleted: number;
  readonly editOutcomes: readonly {
    readonly edit: 'move' | 'rekey' | 'counter' | 'text' | 'custom';
    readonly mechanism: ReturnType<typeof capabilityRef>;
    readonly preservationLosses: readonly string[];
  }[];
  readonly issues: readonly Issue[];
};

export type CommitReceipt = {
  readonly kind: 'commit';
  readonly receiptVersion: 1;
  readonly operationEpoch: string;
  readonly operationId: string;
  readonly transactionHash: `sha256:${string}`;
  readonly intentHash: `sha256:${string}`;
  readonly attachmentId: string;
  readonly attachmentFingerprint: `sha256:${string}`;
  readonly sourceId: string;
  readonly outcome: 'committed' | 'rejected';
  readonly beforeBasis: SourceBasis;
  readonly afterBasis?: SourceBasis;
  readonly statementResults: readonly StatementResult[];
  readonly issues: readonly Issue[];
  readonly durability?: 'memory';
};

export type SimulationReceipt = Omit<CommitReceipt, 'kind' | 'outcome' | 'afterBasis' | 'durability'> & {
  readonly kind: 'simulation';
  readonly outcome: 'would-commit' | 'rejected';
  readonly stagedStorage?: MemoryStorage;
};

export type TransactionAttempt = {
  readonly operationEpoch: string;
  readonly operationId: string;
  readonly transactionHash: `sha256:${string}`;
  readonly attachmentId: string;
  readonly attachmentFingerprint: `sha256:${string}`;
  readonly authorityViewFingerprint: `sha256:${string}`;
  readonly expectedBasis?: SourceBasis;
  readonly parameters?: Readonly<Record<string, JsonValue>>;
  readonly statements: readonly Statement[];
  readonly guards?: readonly Guard[];
};

type AttemptEvaluation = {
  readonly storage: MemoryStorage;
  readonly changed: boolean;
  readonly statementResults: readonly StatementResult[];
  readonly issues: readonly Issue[];
};

const emptyStatementResult = (statementIndex: number): StatementResult => ({
  statementIndex,
  matched: 0,
  logicallyChanged: 0,
  inserted: 0,
  deleted: 0,
  editOutcomes: [],
  issues: []
});

export class InMemorySpikeSource {
  readonly sourceId: string;
  readonly incarnation: string;
  readonly #relations: ReadonlyMap<string, MemoryRelation>;
  readonly #bindings: readonly MemoryBinding[];
  readonly #constraints: readonly SpikeConstraint[];
  readonly #outcomes = new Map<string, { readonly intentHash: string; readonly receipt: CommitReceipt }>();
  readonly #listeners = new Set<() => void>();
  #storage: MemoryStorage;
  #revision = 0;
  #queue: Promise<void> = Promise.resolve();

  constructor(options: {
    readonly sourceId: string;
    readonly incarnation: string;
    readonly storage: MemoryStorage;
    readonly relations: readonly MemoryRelation[];
    readonly bindings: readonly MemoryBinding[];
    readonly constraints?: readonly SpikeConstraint[];
  }) {
    this.sourceId = options.sourceId;
    this.incarnation = options.incarnation;
    this.#storage = cloneStorage(options.storage);
    this.#relations = new Map(options.relations.map((relation) => [relation.use.relationId, relation]));
    this.#bindings = options.bindings;
    this.#constraints = options.constraints ?? [];
  }

  snapshot(): { readonly basis: SourceBasis; readonly storage: MemoryStorage } {
    return { basis: { incarnation: this.incarnation, revision: this.#revision }, storage: cloneStorage(this.#storage) };
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  relateFootprints(left: Footprint, right: Footprint): FootprintRelation {
    if (left.certainty === 'unknown' || right.certainty === 'unknown') return 'unknown';
    if (left.relations === '*' && right.relations === '*') return 'equal';
    if (left.relations === '*') return 'contains';
    if (right.relations === '*') return 'contained_by';
    const leftSet = new Set(left.relations);
    const rightSet = new Set(right.relations);
    const common = [...leftSet].filter((value) => rightSet.has(value));
    if (common.length === 0) return 'disjoint';
    if (leftSet.size === rightSet.size && common.length === leftSet.size) return 'equal';
    if (common.length === rightSet.size) return 'contains';
    if (common.length === leftSet.size) return 'contained_by';
    return 'overlaps';
  }

  async simulate(attempt: TransactionAttempt): Promise<SimulationReceipt> {
    const before = this.snapshot();
    const intentHash = await intentHashFor(attempt);
    const evaluation = this.#evaluate(attempt, before.storage, before.basis);
    return {
      kind: 'simulation', receiptVersion: 1,
      operationEpoch: attempt.operationEpoch, operationId: attempt.operationId,
      transactionHash: attempt.transactionHash, intentHash,
      attachmentId: attempt.attachmentId, attachmentFingerprint: attempt.attachmentFingerprint,
      sourceId: this.sourceId, beforeBasis: before.basis,
      outcome: evaluation.issues.length === 0 ? 'would-commit' : 'rejected',
      statementResults: evaluation.statementResults, issues: evaluation.issues,
      ...(evaluation.issues.length === 0 ? { stagedStorage: evaluation.storage } : {})
    };
  }

  commit(attempt: TransactionAttempt): Promise<CommitReceipt> {
    const run = this.#queue.then(() => this.#commit(attempt));
    this.#queue = run.then(() => undefined, () => undefined);
    return run;
  }

  async #commit(attempt: TransactionAttempt): Promise<CommitReceipt> {
    const intentHash = await intentHashFor(attempt);
    const operationKey = attempt.operationEpoch + '\u0000' + attempt.operationId;
    const previous = this.#outcomes.get(operationKey);
    if (previous !== undefined) {
      if (previous.intentHash === intentHash) return previous.receipt;
      return this.#rejected(attempt, intentHash, this.snapshot().basis, [], [issue('transaction.operation_id_ambiguous', 'commit', undefined, { sourceId: this.sourceId, operationId: attempt.operationId, retry: 'never' })]);
    }
    const before = this.snapshot();
    const evaluation = this.#evaluate(attempt, before.storage, before.basis);
    if (evaluation.issues.length > 0) return this.#rejected(attempt, intentHash, before.basis, evaluation.statementResults, evaluation.issues);
    if (evaluation.changed) {
      this.#storage = evaluation.storage;
      this.#revision += 1;
      for (const listener of this.#listeners) listener();
    }
    const receipt: CommitReceipt = {
      kind: 'commit', receiptVersion: 1,
      operationEpoch: attempt.operationEpoch, operationId: attempt.operationId,
      transactionHash: attempt.transactionHash, intentHash,
      attachmentId: attempt.attachmentId, attachmentFingerprint: attempt.attachmentFingerprint,
      sourceId: this.sourceId, outcome: 'committed', beforeBasis: before.basis,
      afterBasis: { incarnation: this.incarnation, revision: this.#revision },
      statementResults: evaluation.statementResults, issues: [], durability: 'memory'
    };
    this.#outcomes.set(operationKey, { intentHash, receipt });
    return receipt;
  }

  #rejected(attempt: TransactionAttempt, intentHash: `sha256:${string}`, beforeBasis: SourceBasis, statementResults: readonly StatementResult[], issues: readonly Issue[]): CommitReceipt {
    return {
      kind: 'commit', receiptVersion: 1,
      operationEpoch: attempt.operationEpoch, operationId: attempt.operationId,
      transactionHash: attempt.transactionHash, intentHash,
      attachmentId: attempt.attachmentId, attachmentFingerprint: attempt.attachmentFingerprint,
      sourceId: this.sourceId, outcome: 'rejected', beforeBasis, statementResults, issues
    };
  }

  #evaluate(attempt: TransactionAttempt, storage: MemoryStorage, basis: SourceBasis): AttemptEvaluation {
    if (attempt.expectedBasis !== undefined && canonicalJson(attempt.expectedBasis) !== canonicalJson(basis)) {
      return { storage, changed: false, statementResults: [], issues: [issue('transaction.expected_basis_stale', 'commit', { expected: attempt.expectedBasis, actual: basis }, { sourceId: this.sourceId, operationId: attempt.operationId, retry: 'after_refresh' })] };
    }
    const mutable = cloneStorage(storage) as Record<string, readonly MemoryRow[]>;
    const results: StatementResult[] = [];
    const issues: Issue[] = [];
    const touched = new Set<string>();
    for (const [statementIndex, statement] of attempt.statements.entries()) {
      const result = this.#applyStatement(statement, statementIndex, mutable, attempt.parameters ?? {});
      results.push(result);
      issues.push(...result.issues);
      if (statement.kind !== 'extension') touched.add(statement.kind === 'statement.insert' ? statement.relation.relationId : statement.target.relation.relationId);
      if (result.issues.length > 0) break;
    }
    if (issues.length === 0) issues.push(...this.#evaluateGuards(attempt.guards ?? [], mutable, results));
    if (issues.length === 0) issues.push(...this.#evaluateConstraints(mutable));
    if (issues.length > 0) return { storage, changed: false, statementResults: results, issues };

    const commands = [...touched].map((relationId): MemoryCommand => ({ kind: 'set-relation', relationId, rows: mutable[relationId] ?? [] }));
    const planned: MemoryCommand[] = [];
    for (const binding of this.#bindings) {
      const bindingRelations = [...touched].filter((relationId) => binding.relationIds.includes(relationId));
      if (bindingRelations.length === 0) continue;
      const planFootprint = binding.planFootprint?.(bindingRelations) ?? { relations: bindingRelations };
      const boundRelation = this.relateFootprints(planFootprint, binding.declaredWriteFootprint);
      if (boundRelation !== 'equal' && boundRelation !== 'contained_by') {
        issues.push(issue('binding.footprint_out_of_bounds', 'plan', { bindingId: binding.id, relation: boundRelation }, { sourceId: this.sourceId }));
        continue;
      }
      for (const command of commands.filter((candidate) => bindingRelations.includes(candidate.relationId))) planned.push(binding.mapCommand?.(command) ?? command);
    }
    if (issues.length > 0) return { storage, changed: false, statementResults: results, issues };
    const merged = new Map<string, MemoryCommand>();
    for (const command of planned) {
      const previous = merged.get(command.relationId);
      if (previous !== undefined && canonicalJson(previous.rows) !== canonicalJson(command.rows)) {
        issues.push(issue('transaction.intent_merge_conflict', 'plan', { relationId: command.relationId }, { sourceId: this.sourceId, relationId: command.relationId }));
      } else merged.set(command.relationId, command);
    }
    if ([...touched].some((relationId) => !merged.has(relationId))) issues.push(issue('transaction.binding_missing', 'plan', { relations: [...touched].filter((relationId) => !merged.has(relationId)) }, { sourceId: this.sourceId }));
    if (issues.length > 0) return { storage, changed: false, statementResults: results, issues };
    const staged: Record<string, readonly MemoryRow[]> = { ...storage };
    for (const command of merged.values()) staged[command.relationId] = command.rows;
    return { storage: staged, changed: canonicalJson(storage) !== canonicalJson(staged), statementResults: results, issues: [] };
  }

  #applyStatement(statement: Statement, statementIndex: number, storage: Record<string, readonly MemoryRow[]>, parameters: Readonly<Record<string, JsonValue>>): StatementResult {
    const base = emptyStatementResult(statementIndex);
    if (statement.kind === 'extension') return { ...base, issues: [issue('transaction.capability_unavailable', 'plan', { capability: statement.capability.id })] };
    if (statement.kind === 'statement.insert') {
      const relationIssue = this.#relationIssue(statement.relation);
      if (relationIssue !== undefined) return { ...base, issues: [relationIssue] };
      const inserted = statement.rows.map((row) => evaluateFields(row, {}, parameters));
      storage[statement.relation.relationId] = [...(storage[statement.relation.relationId] ?? []), ...inserted];
      return { ...base, logicallyChanged: inserted.length, inserted: inserted.length };
    }
    const relationIssue = this.#relationIssue(statement.target.relation);
    if (relationIssue !== undefined) return { ...base, issues: [relationIssue] };
    const relationId = statement.target.relation.relationId;
    const rows = storage[relationId] ?? [];
    const matches = rows.map((row, index) => ({ row, index })).filter(({ row }) => targetMatches(statement.target, row, parameters));
    if (statement.kind === 'statement.delete') {
      const indexes = new Set(matches.map(({ index }) => index));
      storage[relationId] = rows.filter((_row, index) => !indexes.has(index));
      return { ...base, matched: matches.length, logicallyChanged: matches.length, deleted: matches.length };
    }
    if (statement.kind === 'statement.move') return { ...base, matched: matches.length, issues: [issue('transaction.capability_unavailable', 'plan', { capability: statement.requires.id })] };
    const next = [...rows];
    let logicallyChanged = 0;
    const outcomes: StatementResult['editOutcomes'][number][] = [];
    for (const { row, index } of matches) {
      let updated: MemoryRow = row;
      if (statement.kind === 'statement.rekey') {
        updated = { ...row, ...evaluateFields(statement.key, { [statement.target.alias]: row }, parameters) };
        outcomes.push({ edit: 'rekey', mechanism: capabilityRef('entity/rekey'), preservationLosses: [] });
      } else {
        const editable: Record<string, JsonValue> = { ...row };
        for (const [fieldName, edit] of Object.entries(statement.edits)) {
          if (edit.kind === 'extension') return { ...base, matched: matches.length, issues: [issue('transaction.capability_unavailable', 'plan', { capability: edit.capability.id })] };
          const scope = { [statement.target.alias]: row };
          if (edit.kind === 'edit.replace') editable[fieldName] = requireValue(edit.value, scope, parameters);
          if (edit.kind === 'edit.counter-increment') {
            const amount = requireValue(edit.amount, scope, parameters);
            if (typeof editable[fieldName] !== 'number' || typeof amount !== 'number') return { ...base, matched: matches.length, issues: [issue('transaction.edit_type_mismatch', 'plan', { field: fieldName })] };
            editable[fieldName] += amount;
            outcomes.push({ edit: 'counter', mechanism: capabilityRef('field/counter-increment'), preservationLosses: [] });
          }
          if (edit.kind === 'edit.text-splice') {
            const indexValue = requireValue(edit.index, scope, parameters);
            const deleteValue = requireValue(edit.deleteCount, scope, parameters);
            const insertValue = requireValue(edit.insert, scope, parameters);
            if (typeof editable[fieldName] !== 'string' || typeof indexValue !== 'number' || typeof deleteValue !== 'number' || typeof insertValue !== 'string') return { ...base, matched: matches.length, issues: [issue('transaction.edit_type_mismatch', 'plan', { field: fieldName })] };
            editable[fieldName] = editable[fieldName].slice(0, indexValue) + insertValue + editable[fieldName].slice(indexValue + deleteValue);
            outcomes.push({ edit: 'text', mechanism: capabilityRef('field/text-splice'), preservationLosses: [] });
          }
          if (edit.kind === 'edit.conflict-resolve') {
            const current = editable[fieldName];
            if (!edit.observed.some((value) => sameJson(value, current as JsonValue))) return { ...base, matched: matches.length, issues: [issue('transaction.conflict_changed', 'plan', { field: fieldName })] };
            editable[fieldName] = requireValue(edit.value, scope, parameters);
            outcomes.push({ edit: 'custom', mechanism: capabilityRef('field/conflict-resolve'), preservationLosses: [] });
          }
        }
        updated = editable;
      }
      if (canonicalJson(row) !== canonicalJson(updated)) logicallyChanged += 1;
      next[index] = updated;
    }
    storage[relationId] = next;
    return { ...base, matched: matches.length, logicallyChanged, editOutcomes: outcomes };
  }

  #relationIssue(relation: RelationUse): Issue | undefined {
    const declared = this.#relations.get(relation.relationId);
    return declared === undefined || canonicalJson(declared.use.schemaView) !== canonicalJson(relation.schemaView)
      ? issue('transaction.cross_source_access', 'plan', { relationId: relation.relationId }, { sourceId: this.sourceId, relationId: relation.relationId })
      : undefined;
  }

  #evaluateGuards(guards: readonly Guard[], storage: MemoryStorage, results: readonly StatementResult[]): Issue[] {
    const issues: Issue[] = [];
    for (const guard of guards) {
      if (guard.kind === 'extension') { issues.push(issue('transaction.capability_unavailable', 'plan', { capability: guard.capability.id })); continue; }
      if (guard.kind === 'guard.affected-count') {
        const result = results[guard.statementIndex];
        const actual = result?.[guard.count];
        const passes = actual !== undefined && (guard.op === 'eq' ? actual === guard.value : guard.op === 'gte' ? actual >= guard.value : actual <= guard.value);
        if (!passes) issues.push(issue('transaction.guard_failed', 'constraint', { statementIndex: guard.statementIndex, count: guard.count, actual: actual ?? null }));
        continue;
      }
      const foreign = queryRelations(guard.root).find((relation) => this.#relationIssue(relation) !== undefined);
      if (foreign !== undefined) { issues.push(issue('transaction.cross_source_guard', 'constraint', { relationId: foreign.relationId }, { sourceId: this.sourceId, relationId: foreign.relationId })); continue; }
      const result = evaluateQuery({ root: guard.root, relations: this.#relationInputs(storage) });
      if (result.completeness !== 'exact' || (guard.expect === 'exists' ? result.rows.length === 0 : result.rows.length > 0)) issues.push(issue('transaction.guard_failed', 'constraint', { expect: guard.expect }));
    }
    return issues;
  }

  #evaluateConstraints(storage: MemoryStorage): Issue[] {
    const issues: Issue[] = [];
    for (const constraint of this.#constraints) {
      const result = evaluateQuery({ root: constraint.violationQuery, relations: this.#relationInputs(storage) });
      if (result.completeness !== 'exact') issues.push(issue('constraint.indeterminate', 'constraint', { constraintId: constraint.constraintId }));
      else if (result.rows.length > 0) issues.push(issue(constraint.code, 'constraint', { constraintId: constraint.constraintId, violations: result.rows.length }));
    }
    return issues;
  }

  #relationInputs(storage: MemoryStorage): RelationInput[] {
    return [...this.#relations.values()].map((relation) => ({ relation: relation.use, rows: storage[relation.use.relationId] ?? [], completeness: 'exact', sourceIds: [this.sourceId] }));
  }
}

const cloneStorage = (storage: MemoryStorage): MemoryStorage => Object.fromEntries(Object.entries(storage).map(([relationId, rows]) => [relationId, rows.map((row) => ({ ...row }))]));

const intentHashFor = (attempt: TransactionAttempt): Promise<`sha256:${string}`> => sha256Canonical({
  operationEpoch: attempt.operationEpoch,
  transactionHash: attempt.transactionHash,
  attachmentId: attempt.attachmentId,
  attachmentFingerprint: attempt.attachmentFingerprint,
  ...(attempt.expectedBasis === undefined ? {} : { expectedBasis: attempt.expectedBasis }),
  authorityViewFingerprint: attempt.authorityViewFingerprint
});

const evaluateFields = (fields: Readonly<Record<string, Expr>>, scope: ScopedRow, parameters: Readonly<Record<string, JsonValue>>): MemoryRow => Object.fromEntries(Object.entries(fields).map(([name, expression]) => [name, requireValue(expression, scope, parameters)]));

const requireValue = (expression: Expr, scope: ScopedRow, parameters: Readonly<Record<string, JsonValue>>): JsonValue => {
  const value = evaluateExpression(expression, scope, parameters);
  if (typeof value === 'symbol') throw new Error('Spike expression produced missing where a value is required');
  return value;
};

const targetMatches = (target: BaseTarget, row: MemoryRow, parameters: Readonly<Record<string, JsonValue>>): boolean => target.where === undefined || evaluateExpression(target.where, { [target.alias]: row }, parameters) === true;

const queryRelations = (node: QueryNode): readonly RelationUse[] => {
  if (node.kind === 'extension') return [];
  if (node.kind === 'from') return [node.relation];
  if (node.kind === 'join') return [...queryRelations(node.left), ...queryRelations(node.right)];
  return queryRelations(node.input);
};
