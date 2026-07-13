import { canonicalizeJson, isContentHash, sha256Json, type ArtifactRef, type ContentHash } from './artifacts.js';
import { detachAndFreezeJsonValue } from './internal-owned-json.js';
import { stringTupleKey } from './internal-string-key.js';
import { createIssue, type CapabilityRef, type Issue, type ParseResult } from './issues.js';
import type { SourceBasis } from './maintenance.js';
import type { DocumentDeclaration, GovernanceReceipt, SourceLifecycleCommand, SourceLifecycleReceipt } from './receipts.js';
import { type JsonValue, type PortableValue } from './value.js';

export type CoordinatorOutcomeLookup<Receipt> =
  | { readonly status: 'known'; readonly receipt: Receipt }
  | { readonly status: 'not_seen' }
  | { readonly status: 'ambiguous' | 'expired' }
  | { readonly status: 'unavailable'; readonly issues: readonly Issue[] };

export type OperationLedgerEntry<Receipt> = {
  readonly commandHash: ContentHash;
  receipt?: Receipt;
  evidence?: JsonValue;
};

export type OperationReservation<Receipt> =
  | { readonly status: 'reserved'; readonly entry: OperationLedgerEntry<Receipt> }
  | { readonly status: 'known'; readonly receipt: Receipt }
  | { readonly status: 'pending' }
  | { readonly status: 'ambiguous' }
  | { readonly status: 'expired' };

export interface OperationLedgerProtocol<Receipt> {
  readonly activeEpoch: string;
  readonly retention: 'memory' | 'durable';
  reserve(operationEpoch: string, operationId: string, commandHash: ContentHash): Promise<OperationReservation<Receipt>> | OperationReservation<Receipt>;
  recordEvidence(entry: OperationLedgerEntry<Receipt>, evidence: JsonValue): Promise<void> | void;
  complete(entry: OperationLedgerEntry<Receipt>, receipt: Receipt): Promise<void> | void;
  lookup(operationEpoch: string, operationId: string, commandHash: ContentHash): Promise<CoordinatorOutcomeLookup<Receipt>> | CoordinatorOutcomeLookup<Receipt>;
  rotateEpoch(nextEpoch: string): Promise<void> | void;
}

/**
 * Process-local reference ledger. Adapters claiming durable operation receipts
 * must persist the same reservation/outcome evidence in their own atomic
 * boundary; this class intentionally makes no restart durability claim.
 */
export class SourceOperationLedger<Receipt> implements OperationLedgerProtocol<Receipt> {
  readonly retention = 'memory' as const;
  readonly #entries = new Map<string, OperationLedgerEntry<Receipt>>();
  readonly #retiredEpochs = new Set<string>();
  #activeEpoch: string;

  constructor(activeEpoch: string) {
    if (activeEpoch.length === 0) throw new Error('Operation epoch must be non-empty');
    this.#activeEpoch = activeEpoch;
  }

  get activeEpoch(): string { return this.#activeEpoch; }

  reserve(operationEpoch: string, operationId: string, commandHash: ContentHash): OperationReservation<Receipt> {
    if (operationEpoch !== this.#activeEpoch) return Object.freeze({ status: 'expired' });
    const key = operationKey(operationEpoch, operationId);
    const existing = this.#entries.get(key);
    if (existing !== undefined) {
      if (existing.commandHash !== commandHash) return Object.freeze({ status: 'ambiguous' });
      return existing.receipt === undefined
        ? Object.freeze({ status: 'pending' })
        : Object.freeze({ status: 'known', receipt: existing.receipt });
    }
    const entry = { commandHash };
    this.#entries.set(key, entry);
    return Object.freeze({ status: 'reserved', entry });
  }

  complete(entry: OperationLedgerEntry<Receipt>, receipt: Receipt): void {
    if (entry.receipt !== undefined) throw new Error('Operation outcome is already complete');
    entry.receipt = receipt;
  }

  recordEvidence(entry: OperationLedgerEntry<Receipt>, evidence: JsonValue): void {
    if (entry.receipt !== undefined) throw new Error('Cannot add evidence after operation completion');
    entry.evidence = evidence;
  }

  lookup(operationEpoch: string, operationId: string, commandHash: ContentHash): CoordinatorOutcomeLookup<Receipt> {
    if (this.#retiredEpochs.has(operationEpoch)) return Object.freeze({ status: 'expired' });
    if (operationEpoch !== this.#activeEpoch) return Object.freeze({ status: 'expired' });
    const entry = this.#entries.get(operationKey(operationEpoch, operationId));
    if (entry === undefined) return Object.freeze({ status: 'not_seen' });
    if (entry.commandHash !== commandHash) return Object.freeze({ status: 'ambiguous' });
    return entry.receipt === undefined
      ? Object.freeze({ status: 'unavailable', issues: Object.freeze([coordinatorIssue('operation.outcome_pending', 'commit', 'query_outcome')]) })
      : Object.freeze({ status: 'known', receipt: entry.receipt });
  }

  rotateEpoch(nextEpoch: string): void {
    if (nextEpoch.length === 0 || nextEpoch === this.#activeEpoch || this.#retiredEpochs.has(nextEpoch)) throw new Error('Operation epoch must be new and non-empty');
    const activeEpochPrefix = stringTupleKey(this.#activeEpoch);
    if ([...this.#entries.entries()].some(([key, entry]) => key.startsWith(activeEpochPrefix) && entry.receipt === undefined)) throw new Error('Cannot retire an epoch with a pending operation');
    this.#retiredEpochs.add(this.#activeEpoch);
    for (const key of this.#entries.keys()) if (key.startsWith(activeEpochPrefix)) this.#entries.delete(key);
    this.#activeEpoch = nextEpoch;
  }
}

export type AuthorityDecision =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly issues?: readonly Issue[] };

export type LifecycleMutationResult = {
  readonly outcome: 'committed' | 'rejected' | 'unknown';
  readonly issues: readonly Issue[];
  readonly durability?: 'memory' | 'local' | 'persisted' | 'unknown';
};

export type LifecycleMutationContext = {
  /** Must be called immediately before the first operation that could mutate external state. */
  readonly markMutationPossible: () => void;
};

export type SourceLifecycleAdapter = {
  readonly preflight?: (request: SourceLifecycleCommand['request']) => Promise<readonly Issue[]> | readonly Issue[];
  readonly snapshotBasis?: (sourceId: string) => Promise<SourceBasis> | SourceBasis;
  /** Allocation is deterministic/coordinator-local and must not mutate the source backend. */
  readonly allocateSourceId: (input: PortableValue, capability: CapabilityRef) => Promise<string> | string;
  readonly create: (input: {
    readonly sourceId: string;
    readonly capability: CapabilityRef;
    readonly value: PortableValue;
    readonly context: LifecycleMutationContext;
  }) => Promise<LifecycleMutationResult> | LifecycleMutationResult;
  /** When expectedBasis is present, compare it again inside the delete mutation boundary. */
  readonly delete: (input: {
    readonly sourceId: string;
    readonly expectedBasis?: SourceBasis;
    readonly context: LifecycleMutationContext;
  }) => Promise<LifecycleMutationResult> | LifecycleMutationResult;
};

export type SourceLifecycleCoordinatorOptions = {
  readonly lifecycleCoordinatorId: string;
  readonly operationEpoch: string;
  readonly authorityViewFingerprint: ContentHash;
  readonly authorize: (request: SourceLifecycleCommand['request']) => Promise<AuthorityDecision> | AuthorityDecision;
  readonly adapter: SourceLifecycleAdapter;
  readonly ledger?: OperationLedgerProtocol<SourceLifecycleReceipt>;
};

export class SourceLifecycleCoordinator {
  readonly lifecycleCoordinatorId: string;
  readonly authorityViewFingerprint: ContentHash;
  readonly ledger: OperationLedgerProtocol<SourceLifecycleReceipt>;
  readonly #authorize: SourceLifecycleCoordinatorOptions['authorize'];
  readonly #adapter: SourceLifecycleAdapter;
  #queue: Promise<void> = Promise.resolve();

  constructor(options: SourceLifecycleCoordinatorOptions) {
    this.lifecycleCoordinatorId = options.lifecycleCoordinatorId;
    this.authorityViewFingerprint = options.authorityViewFingerprint;
    this.ledger = options.ledger ?? new SourceOperationLedger(options.operationEpoch);
    if (this.ledger.activeEpoch !== options.operationEpoch) throw new Error('Lifecycle ledger epoch does not match coordinator epoch');
    this.#authorize = options.authorize;
    this.#adapter = options.adapter;
  }

  execute(command: SourceLifecycleCommand, options: { readonly signal?: AbortSignal } = {}): Promise<SourceLifecycleReceipt> {
    const ownedCommand = adoptCoordinatorCommand<SourceLifecycleCommand>(command, 'Source lifecycle command');
    const signal = options.signal;
    const run = this.#queue.then(() => this.#execute(ownedCommand, signal === undefined ? {} : { signal }));
    this.#queue = run.then(() => undefined, () => undefined);
    return run;
  }

  async queryOutcome(input: { readonly operationEpoch: string; readonly operationId: string; readonly commandHash: ContentHash }): Promise<CoordinatorOutcomeLookup<SourceLifecycleReceipt>> {
    try { return await this.ledger.lookup(input.operationEpoch, input.operationId, input.commandHash); }
    catch (error) { return { status: 'unavailable', issues: [coordinatorIssue('operation.ledger_unavailable', 'commit', 'query_outcome', errorDetails(error))] }; }
  }

  async rotateOperationEpoch(nextEpoch: string): Promise<void> { await this.ledger.rotateEpoch(nextEpoch); }

  async #execute(command: SourceLifecycleCommand, options: { readonly signal?: AbortSignal }): Promise<SourceLifecycleReceipt> {
    const validated = validateLifecycleCommand(command, this.lifecycleCoordinatorId);
    const commandHash = validated.success
      ? await lifecycleCommandHash(command, this.authorityViewFingerprint)
      : await invalidCommandHash('source-lifecycle', commandIdentity(command, 'operationEpoch'), commandIdentity(command, 'operationId'));
    const reject = (issues: readonly Issue[], sourceId?: string): SourceLifecycleReceipt => lifecycleReceipt(command, commandHash, 'rejected', issues, sourceId);
    if (!validated.success) return reject(validated.issues);
    if (command.operationEpoch !== this.ledger.activeEpoch) return reject([coordinatorIssue('lifecycle.operation_epoch_expired', 'lifecycle', 'never')], command.request.action === 'delete' ? command.request.sourceId : undefined);
    let decision: AuthorityDecision;
    try { decision = await this.#authorize(command.request); }
    catch (error) { return reject([coordinatorIssue('lifecycle.authority_failed', 'governance', 'after_authority', errorDetails(error))], command.request.action === 'delete' ? command.request.sourceId : undefined); }
    if (!decision.allowed) return reject(decision.issues ?? [coordinatorIssue('lifecycle.authority_denied', 'governance', 'after_authority')], command.request.action === 'delete' ? command.request.sourceId : undefined);
    if (options.signal?.aborted === true) return reject([coordinatorIssue('lifecycle.cancelled', 'lifecycle', 'never', { timing: 'before_handoff' })], command.request.action === 'delete' ? command.request.sourceId : undefined);
    try {
      const preflightIssues = await this.#adapter.preflight?.(command.request) ?? [];
      if (preflightIssues.some(({ severity }) => severity === 'error')) return reject(preflightIssues, command.request.action === 'delete' ? command.request.sourceId : undefined);
    } catch (error) {
      return reject([coordinatorIssue('lifecycle.preflight_failed', 'lifecycle', 'after_refresh', errorDetails(error))], command.request.action === 'delete' ? command.request.sourceId : undefined);
    }

    // Source-side handoff begins here. Every path below completes or preserves
    // this reservation; none may re-run mutation-capable work for the same ID.
    let reservation: OperationReservation<SourceLifecycleReceipt>;
    try { reservation = await this.ledger.reserve(command.operationEpoch, command.operationId, commandHash); }
    catch (error) {
      return lifecycleReceipt(command, commandHash, 'unknown', [coordinatorIssue('operation.ledger_unavailable', 'commit', 'query_outcome', errorDetails(error))], command.request.action === 'delete' ? command.request.sourceId : undefined, 'unknown');
    }
    if (reservation.status === 'known') return reservation.receipt;
    if (reservation.status === 'ambiguous') return reject([coordinatorIssue('lifecycle.operation_id_ambiguous', 'commit', 'never')], command.request.action === 'delete' ? command.request.sourceId : undefined);
    if (reservation.status === 'pending') return lifecycleReceipt(command, commandHash, 'unknown', [coordinatorIssue('lifecycle.outcome_unavailable', 'commit', 'query_outcome')], command.request.action === 'delete' ? command.request.sourceId : undefined, 'unknown');
    if (reservation.status === 'expired') return reject([coordinatorIssue('lifecycle.operation_epoch_expired', 'lifecycle', 'never')], command.request.action === 'delete' ? command.request.sourceId : undefined);

    let sourceId: string | undefined = command.request.action === 'delete' ? command.request.sourceId : undefined;
    let mutationPossible = false;
    const context = { markMutationPossible: () => { mutationPossible = true; } };
    let receipt: SourceLifecycleReceipt;
    try {
      let result: LifecycleMutationResult;
      if (command.request.action === 'create') {
        sourceId = await this.#adapter.allocateSourceId(command.request.input, command.request.sourceCapability);
        if (sourceId.length === 0) throw new CoordinatorExpectedError(coordinatorIssue('lifecycle.source_id_invalid', 'lifecycle', 'after_input'));
        // A durable ledger persists this allocation before the adapter can
        // cross its mutation boundary, allowing pending lookup to retain it.
        await this.ledger.recordEvidence(reservation.entry, { sourceId });
        result = await this.#adapter.create({ sourceId, capability: command.request.sourceCapability, value: command.request.input, context });
      } else {
        if (command.request.expectedBasis !== undefined) {
          const actualBasis = await this.#adapter.snapshotBasis?.(command.request.sourceId);
          if (actualBasis === undefined) throw new CoordinatorExpectedError(coordinatorIssue('lifecycle.expected_basis_unavailable', 'lifecycle', 'after_refresh'));
          if (!sameBasis(actualBasis, command.request.expectedBasis)) throw new CoordinatorExpectedError(coordinatorIssue('lifecycle.expected_basis_stale', 'lifecycle', 'after_refresh', { expected: command.request.expectedBasis, actual: actualBasis }));
        }
        result = await this.#adapter.delete({ sourceId: command.request.sourceId, ...(command.request.expectedBasis === undefined ? {} : { expectedBasis: command.request.expectedBasis }), context });
      }
      const issues = result.outcome === 'unknown' && this.ledger.retention !== 'durable'
        ? [...result.issues, coordinatorIssue('operation.durable_lookup_unavailable', 'commit', 'query_outcome')]
        : result.issues;
      const durability = result.outcome === 'rejected' ? undefined : result.outcome === 'unknown' ? result.durability ?? 'unknown' : result.durability;
      receipt = lifecycleReceipt(command, commandHash, result.outcome, issues, sourceId, durability);
    } catch (error) {
      const issue = error instanceof CoordinatorExpectedError
        ? error.issue
        : coordinatorIssue(mutationPossible ? 'lifecycle.outcome_unknown' : 'lifecycle.adapter_failed', 'lifecycle', mutationPossible ? 'query_outcome' : 'after_refresh', errorDetails(error));
      const durabilityIssue = mutationPossible && this.ledger.retention !== 'durable' ? [coordinatorIssue('operation.durable_lookup_unavailable', 'commit', 'query_outcome')] : [];
      receipt = lifecycleReceipt(command, commandHash, mutationPossible ? 'unknown' : 'rejected', [issue, ...durabilityIssue], sourceId, mutationPossible ? 'unknown' : undefined);
    }
    try { await this.ledger.complete(reservation.entry, receipt); }
    catch (error) {
      return lifecycleReceipt(command, commandHash, 'unknown', [...receipt.issues, coordinatorIssue('operation.ledger_complete_failed', 'commit', 'query_outcome', errorDetails(error))], sourceId, 'unknown');
    }
    return receipt;
  }
}

export type GovernanceStorageSection = {
  readonly kind: 'storage';
  readonly storageSchema: ArtifactRef;
  readonly projection: DocumentDeclaration['projection'];
};

export type GovernanceConstraintSection = {
  readonly kind: 'constraints';
  readonly set: ArtifactRef;
  readonly mode: 'audit' | 'required';
};

export type GovernanceSection = GovernanceStorageSection | GovernanceConstraintSection;

export type GovernanceCommand = {
  readonly operationEpoch: string;
  readonly operationId: string;
  readonly sourceId: string;
  readonly expectedBasis: SourceBasis;
  readonly request:
    | { readonly action: 'initialize_declaration'; readonly declaration: DocumentDeclaration }
    | { readonly action: 'repair_declaration'; readonly section: GovernanceSection['kind']; readonly alternatives: readonly GovernanceSection[]; readonly selected: GovernanceSection }
    | { readonly action: 'activate_constraints'; readonly activation: GovernanceConstraintSection };
};

export type GovernanceMutationResult = {
  readonly outcome: 'committed' | 'rejected' | 'unknown';
  readonly beforeBasis?: SourceBasis;
  readonly afterBasis?: SourceBasis;
  readonly issues: readonly Issue[];
  readonly durability?: 'memory' | 'local' | 'persisted' | 'unknown';
};

export type GovernanceSourceAdapter = {
  readonly snapshotBasis: () => Promise<SourceBasis> | SourceBasis;
  readonly preflight?: (command: GovernanceCommand) => Promise<readonly Issue[]> | readonly Issue[];
  /** The adapter must atomically compare expectedBasis before applying. */
  readonly apply: (input: {
    readonly command: GovernanceCommand;
    readonly context: { readonly markMutationPossible: () => void };
  }) => Promise<GovernanceMutationResult> | GovernanceMutationResult;
};

type GovernanceSource = {
  readonly ledger: OperationLedgerProtocol<GovernanceReceipt>;
  readonly adapter: GovernanceSourceAdapter;
};

export type GovernanceCoordinatorOptions = {
  readonly authorityViewFingerprint: ContentHash;
  readonly authorize: (command: GovernanceCommand) => Promise<AuthorityDecision> | AuthorityDecision;
};

export class GovernanceCoordinator {
  readonly authorityViewFingerprint: ContentHash;
  readonly #authorize: GovernanceCoordinatorOptions['authorize'];
  readonly #sources = new Map<string, GovernanceSource>();
  readonly #queues = new Map<string, Promise<void>>();

  constructor(options: GovernanceCoordinatorOptions) {
    this.authorityViewFingerprint = options.authorityViewFingerprint;
    this.#authorize = options.authorize;
  }

  registerSource(sourceId: string, operationEpoch: string, adapter: GovernanceSourceAdapter, ledger: OperationLedgerProtocol<GovernanceReceipt> = new SourceOperationLedger(operationEpoch)): () => void {
    if (this.#sources.has(sourceId)) throw new Error('Governance source is already registered: ' + sourceId);
    if (ledger.activeEpoch !== operationEpoch) throw new Error('Governance ledger epoch does not match source epoch');
    const source = { ledger, adapter };
    this.#sources.set(sourceId, source);
    return () => { if (this.#sources.get(sourceId) === source) this.#sources.delete(sourceId); };
  }

  execute(command: GovernanceCommand, options: { readonly signal?: AbortSignal } = {}): Promise<GovernanceReceipt> {
    const ownedCommand = adoptCoordinatorCommand<GovernanceCommand>(command, 'Governance command');
    const signal = options.signal;
    const sourceId = commandIdentity(ownedCommand, 'sourceId');
    const prior = this.#queues.get(sourceId) ?? Promise.resolve();
    const run = prior.then(() => this.#execute(ownedCommand, signal === undefined ? {} : { signal }));
    const tail = run.then(() => undefined, () => undefined);
    this.#queues.set(sourceId, tail);
    void tail.then(() => {
      if (this.#queues.get(sourceId) === tail) this.#queues.delete(sourceId);
    });
    return run;
  }

  async queryOutcome(input: { readonly sourceId: string; readonly operationEpoch: string; readonly operationId: string; readonly commandHash: ContentHash }): Promise<CoordinatorOutcomeLookup<GovernanceReceipt>> {
    const source = this.#sources.get(input.sourceId);
    if (source === undefined) return { status: 'unavailable', issues: [coordinatorIssue('governance.source_unavailable', 'resolve', 'after_refresh')] };
    try { return await source.ledger.lookup(input.operationEpoch, input.operationId, input.commandHash); }
    catch (error) { return { status: 'unavailable', issues: [coordinatorIssue('operation.ledger_unavailable', 'commit', 'query_outcome', errorDetails(error))] }; }
  }

  async rotateOperationEpoch(sourceId: string, nextEpoch: string): Promise<void> {
    const source = this.#sources.get(sourceId);
    if (source === undefined) throw new Error('Governance source is not registered: ' + sourceId);
    await source.ledger.rotateEpoch(nextEpoch);
  }

  async #execute(command: GovernanceCommand, options: { readonly signal?: AbortSignal }): Promise<GovernanceReceipt> {
    const validated = validateGovernanceCommand(command);
    const commandHash = validated.success
      ? await governanceCommandHash(command, this.authorityViewFingerprint)
      : await invalidCommandHash('governance', commandIdentity(command, 'operationEpoch'), commandIdentity(command, 'operationId'));
    const selectedArtifactHashes = validated.success ? selectedHashes(command) : [];
    const reject = (issues: readonly Issue[], beforeBasis?: SourceBasis): GovernanceReceipt => governanceReceipt(command, commandHash, selectedArtifactHashes, 'rejected', issues, beforeBasis);
    if (!validated.success) return reject(validated.issues);
    const source = this.#sources.get(command.sourceId);
    if (source === undefined) return reject([coordinatorIssue('governance.source_unavailable', 'resolve', 'after_refresh')]);
    if (command.operationEpoch !== source.ledger.activeEpoch) return reject([coordinatorIssue('governance.operation_epoch_expired', 'governance', 'never')]);
    let decision: AuthorityDecision;
    try { decision = await this.#authorize(command); }
    catch (error) { return reject([coordinatorIssue('governance.authority_failed', 'governance', 'after_authority', errorDetails(error))]); }
    if (!decision.allowed) return reject(decision.issues ?? [coordinatorIssue('governance.authority_denied', 'governance', 'after_authority')]);
    if (options.signal?.aborted === true) return reject([coordinatorIssue('governance.cancelled', 'governance', 'never', { timing: 'before_handoff' })]);
    try {
      const preflightIssues = await source.adapter.preflight?.(command) ?? [];
      if (preflightIssues.some(({ severity }) => severity === 'error')) return reject(preflightIssues);
    } catch (error) {
      return reject([coordinatorIssue('governance.preflight_failed', 'governance', 'after_refresh', errorDetails(error))]);
    }

    let reservation: OperationReservation<GovernanceReceipt>;
    try { reservation = await source.ledger.reserve(command.operationEpoch, command.operationId, commandHash); }
    catch (error) {
      return governanceReceipt(command, commandHash, selectedArtifactHashes, 'unknown', [coordinatorIssue('operation.ledger_unavailable', 'commit', 'query_outcome', errorDetails(error))], undefined, undefined, 'unknown');
    }
    if (reservation.status === 'known') return reservation.receipt;
    if (reservation.status === 'ambiguous') return reject([coordinatorIssue('governance.operation_id_ambiguous', 'governance', 'never')]);
    if (reservation.status === 'pending') return governanceReceipt(command, commandHash, selectedArtifactHashes, 'unknown', [coordinatorIssue('governance.outcome_unavailable', 'governance', 'query_outcome')], undefined, undefined, 'unknown');
    if (reservation.status === 'expired') return reject([coordinatorIssue('governance.operation_epoch_expired', 'governance', 'never')]);

    let beforeBasis: SourceBasis | undefined;
    let mutationPossible = false;
    let receipt: GovernanceReceipt;
    try {
      beforeBasis = await source.adapter.snapshotBasis();
      if (!sameBasis(beforeBasis, command.expectedBasis)) {
        receipt = reject([coordinatorIssue('governance.expected_basis_stale', 'governance', 'after_refresh', { expected: command.expectedBasis, actual: beforeBasis })], beforeBasis);
      } else {
        const result = await source.adapter.apply({ command, context: { markMutationPossible: () => { mutationPossible = true; } } });
        const reportedBefore = result.beforeBasis ?? beforeBasis;
        const invalidEvidence = result.outcome === 'committed' && (result.afterBasis === undefined || !sameBasis(reportedBefore, command.expectedBasis));
        if (invalidEvidence) {
          const issue = coordinatorIssue('governance.adapter_evidence_invalid', 'governance', mutationPossible ? 'query_outcome' : 'after_refresh');
          receipt = governanceReceipt(command, commandHash, selectedArtifactHashes, mutationPossible ? 'unknown' : 'rejected', [issue], reportedBefore, undefined, mutationPossible ? 'unknown' : undefined);
        } else {
          const issues = result.outcome === 'unknown' && source.ledger.retention !== 'durable'
            ? [...result.issues, coordinatorIssue('operation.durable_lookup_unavailable', 'commit', 'query_outcome')]
            : result.issues;
          const durability = result.outcome === 'rejected' ? undefined : result.outcome === 'unknown' ? result.durability ?? 'unknown' : result.durability;
          receipt = governanceReceipt(command, commandHash, selectedArtifactHashes, result.outcome, issues, reportedBefore, result.afterBasis, durability);
        }
      }
    } catch (error) {
      const issue = coordinatorIssue(mutationPossible ? 'governance.outcome_unknown' : 'governance.adapter_failed', 'governance', mutationPossible ? 'query_outcome' : 'after_refresh', errorDetails(error));
      const durabilityIssue = mutationPossible && source.ledger.retention !== 'durable' ? [coordinatorIssue('operation.durable_lookup_unavailable', 'commit', 'query_outcome')] : [];
      receipt = governanceReceipt(command, commandHash, selectedArtifactHashes, mutationPossible ? 'unknown' : 'rejected', [issue, ...durabilityIssue], beforeBasis, undefined, mutationPossible ? 'unknown' : undefined);
    }
    try { await source.ledger.complete(reservation.entry, receipt); }
    catch (error) {
      return governanceReceipt(command, commandHash, selectedArtifactHashes, 'unknown', [...receipt.issues, coordinatorIssue('operation.ledger_complete_failed', 'commit', 'query_outcome', errorDetails(error))], receipt.beforeBasis, undefined, 'unknown');
    }
    return receipt;
  }
}

export const lifecycleCommandHash = (command: SourceLifecycleCommand, authorityViewFingerprint: ContentHash): Promise<ContentHash> => sha256Json({
  lifecycleCoordinatorId: command.lifecycleCoordinatorId,
  operationEpoch: command.operationEpoch,
  request: command.request,
  authorityViewFingerprint
} as unknown as JsonValue);

export const governanceCommandHash = (command: GovernanceCommand, authorityViewFingerprint: ContentHash): Promise<ContentHash> => sha256Json({
  operationEpoch: command.operationEpoch,
  sourceId: command.sourceId,
  action: command.request.action,
  request: normalizeGovernanceRequest(command.request),
  expectedBasis: command.expectedBasis,
  authorityViewFingerprint
} as unknown as JsonValue);

const validateLifecycleCommand = (command: SourceLifecycleCommand, coordinatorId: string): ParseResult<SourceLifecycleCommand> => {
  if (command.lifecycleCoordinatorId !== coordinatorId || !nonEmptyString(command.operationEpoch) || !nonEmptyString(command.operationId)) return coordinatorFailure('lifecycle.command_invalid', 'lifecycle', { reason: 'identity' });
  if (!isCanonicalJson(command)) return coordinatorFailure('lifecycle.command_invalid', 'lifecycle', { reason: 'canonical_json' });
  if (!isPortableRecord(command.request)) return coordinatorFailure('lifecycle.command_invalid', 'lifecycle', { reason: 'request' });
  if (command.request.action === 'create') {
    if (!validCapability(command.request.sourceCapability) || !Object.hasOwn(command.request, 'input')) return coordinatorFailure('lifecycle.command_invalid', 'lifecycle', { reason: 'capability' });
  } else if (command.request.action === 'delete') {
    if (!nonEmptyString(command.request.sourceId)) return coordinatorFailure('lifecycle.command_invalid', 'lifecycle', { reason: 'source_id' });
  } else {
    return coordinatorFailure('lifecycle.command_invalid', 'lifecycle', { reason: 'action' });
  }
  return { success: true, value: command, issues: [] };
};

const validateGovernanceCommand = (command: GovernanceCommand): ParseResult<GovernanceCommand> => {
  if (!nonEmptyString(command.operationEpoch) || !nonEmptyString(command.operationId) || !nonEmptyString(command.sourceId)) return coordinatorFailure('governance.command_invalid', 'governance', { reason: 'identity' });
  if (!isCanonicalJson(command)) return coordinatorFailure('governance.command_invalid', 'governance', { reason: 'canonical_json' });
  if (!Object.hasOwn(command, 'expectedBasis')) return coordinatorFailure('governance.command_invalid', 'governance', { reason: 'expected_basis' });
  if (!isPortableRecord(command.request)) return coordinatorFailure('governance.command_invalid', 'governance', { reason: 'request' });
  if (command.request.action === 'initialize_declaration') {
    if (!validDeclaration(command.request.declaration)) return coordinatorFailure('governance.command_invalid', 'governance', { reason: 'declaration' });
  } else if (command.request.action === 'activate_constraints') {
    if (!validConstraintSection(command.request.activation)) return coordinatorFailure('governance.command_invalid', 'governance', { reason: 'activation' });
  } else if (command.request.action === 'repair_declaration') {
    const request = command.request;
    if ((request.section !== 'storage' && request.section !== 'constraints') || !Array.isArray(request.alternatives) || request.alternatives.length < 2 || !validSection(request.selected) || request.selected.kind !== request.section || request.alternatives.some((alternative) => !validSection(alternative) || alternative.kind !== request.section)) return coordinatorFailure('governance.command_invalid', 'governance', { reason: 'repair_shape' });
    const alternatives = request.alternatives.map((alternative) => canonicalizeJson(alternative as unknown as JsonValue));
    if (new Set(alternatives).size !== alternatives.length) return coordinatorFailure('governance.command_invalid', 'governance', { reason: 'repair_shape' });
    const selected = canonicalizeJson(request.selected as unknown as JsonValue);
    if (!request.alternatives.some((alternative) => canonicalizeJson(alternative as unknown as JsonValue) === selected)) return coordinatorFailure('governance.repair_selection_invalid', 'governance', { reason: 'selected_not_observed' });
  } else {
    return coordinatorFailure('governance.command_invalid', 'governance', { reason: 'action' });
  }
  return { success: true, value: command, issues: [] };
};

const validDeclaration = (value: unknown): value is DocumentDeclaration => {
  if (!isPortableRecord(value) || value.formatVersion !== 1 || !validArtifactRef(value.storageSchema) || !validProjection(value.projection)) return false;
  return value.constraints === undefined || (isPortableRecord(value.constraints) && validArtifactRef(value.constraints.set) && (value.constraints.mode === 'audit' || value.constraints.mode === 'required'));
};

const validProjection = (value: unknown): value is DocumentDeclaration['projection'] => isPortableRecord(value) && (
  value.kind === 'storage-mapping'
    ? validArtifactRef(value.storageMapping)
    : value.kind === 'storage-binding' && validCapability(value.storageBinding)
);

const validSection = (value: unknown): value is GovernanceSection => {
  if (!isPortableRecord(value)) return false;
  if (value.kind === 'constraints') return validConstraintSection(value);
  return value.kind === 'storage' && validArtifactRef(value.storageSchema) && validProjection(value.projection);
};

const validConstraintSection = (value: unknown): value is GovernanceConstraintSection => isPortableRecord(value) && value.kind === 'constraints' && validArtifactRef(value.set) && (value.mode === 'audit' || value.mode === 'required');
const validArtifactRef = (value: unknown): value is ArtifactRef => isPortableRecord(value) && nonEmptyString(value.id) && isContentHash(value.contentHash);
const validCapability = (value: unknown): value is CapabilityRef => isPortableRecord(value) && nonEmptyString(value.id) && nonEmptyString(value.version) && isContentHash(value.contractHash);
const isPortableRecord = (value: unknown): value is Readonly<Record<string, JsonValue>> => value !== null && typeof value === 'object' && !Array.isArray(value);
const nonEmptyString = (value: unknown): value is string => typeof value === 'string' && value.length > 0;
const isCanonicalJson = (value: JsonValue): boolean => {
  try {
    canonicalizeJson(value);
    return true;
  } catch {
    return false;
  }
};

const normalizeGovernanceRequest = (request: GovernanceCommand['request']): JsonValue => {
  if (request.action === 'initialize_declaration') return { action: request.action, declaration: normalizeDeclaration(request.declaration) } as unknown as JsonValue;
  if (request.action === 'activate_constraints') return { action: request.action, activation: normalizeSection(request.activation) } as unknown as JsonValue;
  return {
    action: request.action,
    section: request.section,
    alternatives: request.alternatives.map(normalizeSection),
    selected: normalizeSection(request.selected)
  } as unknown as JsonValue;
};

const normalizeDeclaration = (declaration: DocumentDeclaration): DocumentDeclaration => ({
  formatVersion: 1,
  storageSchema: normalizeRef(declaration.storageSchema),
  projection: declaration.projection.kind === 'storage-mapping'
    ? { kind: 'storage-mapping', storageMapping: normalizeRef(declaration.projection.storageMapping) }
    : { kind: 'storage-binding', storageBinding: normalizeCapability(declaration.projection.storageBinding) },
  ...(declaration.constraints === undefined ? {} : { constraints: { set: normalizeRef(declaration.constraints.set), mode: declaration.constraints.mode } })
});

const normalizeSection = (section: GovernanceSection): GovernanceSection => section.kind === 'storage'
  ? {
      kind: 'storage',
      storageSchema: normalizeRef(section.storageSchema),
      projection: section.projection.kind === 'storage-mapping'
        ? { kind: 'storage-mapping', storageMapping: normalizeRef(section.projection.storageMapping) }
        : { kind: 'storage-binding', storageBinding: normalizeCapability(section.projection.storageBinding) }
    }
  : { kind: 'constraints', set: normalizeRef(section.set), mode: section.mode };

const normalizeRef = (ref: ArtifactRef): ArtifactRef => ({ id: ref.id, contentHash: ref.contentHash });
const normalizeCapability = (ref: CapabilityRef): CapabilityRef => ({ id: ref.id, version: ref.version, contractHash: ref.contractHash });

const selectedHashes = (command: GovernanceCommand): readonly ContentHash[] => {
  const refs: ContentHash[] = [];
  const addProjection = (projection: DocumentDeclaration['projection']) => { if (projection.kind === 'storage-mapping') refs.push(projection.storageMapping.contentHash); };
  if (command.request.action === 'initialize_declaration') {
    refs.push(command.request.declaration.storageSchema.contentHash);
    addProjection(command.request.declaration.projection);
    if (command.request.declaration.constraints !== undefined) refs.push(command.request.declaration.constraints.set.contentHash);
  } else if (command.request.action === 'activate_constraints') refs.push(command.request.activation.set.contentHash);
  else if (command.request.selected.kind === 'storage') { refs.push(command.request.selected.storageSchema.contentHash); addProjection(command.request.selected.projection); }
  else refs.push(command.request.selected.set.contentHash);
  return [...new Set(refs)].sort(compare);
};

const lifecycleReceipt = (command: SourceLifecycleCommand, commandHash: ContentHash, outcome: SourceLifecycleReceipt['outcome'], issues: readonly Issue[], sourceId?: string, durability?: SourceLifecycleReceipt['durability']): SourceLifecycleReceipt => ownCoordinatorReceipt({
  kind: 'source-lifecycle', receiptVersion: 1,
  lifecycleCoordinatorId: commandIdentity(command, 'lifecycleCoordinatorId'),
  operationEpoch: commandIdentity(command, 'operationEpoch'),
  operationId: commandIdentity(command, 'operationId'),
  commandHash,
  action: lifecycleAction(command),
  ...(sourceId === undefined ? {} : { sourceId }),
  outcome,
  ...(durability === undefined ? {} : { durability }),
  issues
}, 'Source lifecycle receipt');

const governanceReceipt = (command: GovernanceCommand, commandHash: ContentHash, selectedArtifactHashes: readonly ContentHash[], outcome: GovernanceReceipt['outcome'], issues: readonly Issue[], beforeBasis?: SourceBasis, afterBasis?: SourceBasis, durability?: GovernanceReceipt['durability']): GovernanceReceipt => ownCoordinatorReceipt({
  kind: 'governance', receiptVersion: 1,
  operationEpoch: commandIdentity(command, 'operationEpoch'),
  operationId: commandIdentity(command, 'operationId'),
  commandHash,
  sourceId: commandIdentity(command, 'sourceId'),
  action: governanceAction(command),
  outcome,
  ...(beforeBasis === undefined ? {} : { beforeBasis }),
  ...(afterBasis === undefined ? {} : { afterBasis }),
  selectedArtifactHashes,
  issues,
  ...(durability === undefined ? {} : { durability })
}, 'Governance receipt');

const coordinatorFailure = <Value>(code: string, phase: 'lifecycle' | 'governance', details: JsonValue): ParseResult<Value> => ({ success: false, issues: [coordinatorIssue(code, phase, 'after_input', details)] });
const coordinatorIssue = (code: string, phase: 'commit' | 'governance' | 'lifecycle' | 'resolve', retry: 'never' | 'after_input' | 'after_refresh' | 'after_authority' | 'query_outcome', details?: JsonValue): Issue => createIssue({ code, phase, severity: 'error', retry, ...(details === undefined ? {} : { details }) });
const errorDetails = (error: unknown): JsonValue => ({ error: error instanceof Error ? error.name : typeof error });
const invalidCommandHash = (kind: string, operationEpoch: string, operationId: string): Promise<ContentHash> => sha256Json({ kind, invalid: true, operationEpoch, operationId });
const operationKey = (epoch: string, id: string): string => stringTupleKey(epoch, id);
const sameBasis = (left: SourceBasis, right: SourceBasis): boolean => canonicalizeJson(left) === canonicalizeJson(right);
const compare = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0;
const commandIdentity = (command: unknown, member: string): string => {
  if (!isPortableRecord(command)) return '<invalid>';
  const value = command[member];
  return nonEmptyString(value) && isCanonicalJson(value) ? value : '<invalid>';
};
const commandRequest = (command: unknown): Readonly<Record<string, JsonValue>> | undefined => isPortableRecord(command) && isPortableRecord(command.request) ? command.request : undefined;
const lifecycleAction = (command: unknown): SourceLifecycleReceipt['action'] => commandRequest(command)?.action === 'delete' ? 'delete' : 'create';
const governanceAction = (command: unknown): GovernanceReceipt['action'] => {
  const action = commandRequest(command)?.action;
  if (action === 'repair_declaration' || action === 'activate_constraints') return action;
  return 'initialize_declaration';
};

const adoptCoordinatorCommand = <Command>(input: unknown, label: string): Command => {
  const owned = detachAndFreezeJsonValue(input);
  if (!owned.success || owned.value === null || typeof owned.value !== 'object' || Array.isArray(owned.value)) {
    throw new TypeError(label + ' must be descriptor-safe portable data');
  }
  return owned.value as unknown as Command;
};

const ownCoordinatorReceipt = <Receipt>(input: unknown, label: string): Receipt => {
  const owned = detachAndFreezeJsonValue(input);
  if (!owned.success || owned.value === null || typeof owned.value !== 'object' || Array.isArray(owned.value)) {
    throw new TypeError(label + ' must be descriptor-safe portable evidence');
  }
  return owned.value as unknown as Receipt;
};

class CoordinatorExpectedError extends Error {
  readonly issue: Issue;
  constructor(issue: Issue) { super(issue.code); this.issue = issue; }
}
