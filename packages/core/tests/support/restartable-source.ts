import { createIssue } from '../../src/issues.js';
import type { SourceSnapshot } from '../../src/database.js';
import type { ContentHash } from '../../src/artifacts.js';
import type {
  AtomicSource,
  Footprint,
  FootprintRelation,
  IntentMergeResult,
  PlanResult,
  SourceCommitInput,
  SourceCommitResult,
  SourceOutcomeLookup
} from '../../src/source-protocol.js';

export type RestartableBasis = { readonly incarnation: string; readonly revision: number };

export type RestartableLedgerEntry = {
  readonly operationEpoch: string;
  readonly operationId: string;
  readonly intentHash: ContentHash;
  readonly result?: SourceCommitResult;
};

export type RestartableSourceState<Storage> = {
  readonly sourceId: string;
  readonly incarnation: string;
  readonly operationEpoch: string;
  readonly revision: number;
  readonly storage: Storage;
  readonly ledger: readonly RestartableLedgerEntry[];
};

export type RestartableReservation<Storage> =
  | { readonly status: 'reserved'; readonly state: RestartableSourceState<Storage> }
  | { readonly status: 'known'; readonly state: RestartableSourceState<Storage>; readonly result: SourceCommitResult }
  | { readonly status: 'pending' | 'ambiguous' | 'expired'; readonly state: RestartableSourceState<Storage> };

export const reserveRestartableOperation = <Storage>(
  state: RestartableSourceState<Storage>,
  identity: { readonly operationEpoch: string; readonly operationId: string; readonly intentHash: ContentHash }
): RestartableReservation<Storage> => {
  if (identity.operationEpoch !== state.operationEpoch) return { status: 'expired', state };
  const existing = state.ledger.find((entry) => entry.operationEpoch === identity.operationEpoch && entry.operationId === identity.operationId);
  if (existing !== undefined) {
    if (existing.intentHash !== identity.intentHash) return { status: 'ambiguous', state };
    return existing.result === undefined ? { status: 'pending', state } : { status: 'known', state, result: existing.result };
  }
  return {
    status: 'reserved',
    state: {
      ...state,
      ledger: [...state.ledger, { ...identity }]
    }
  };
};

export const completeRestartableOperation = <Storage>(
  state: RestartableSourceState<Storage>,
  identity: { readonly operationEpoch: string; readonly operationId: string; readonly intentHash: ContentHash },
  completion: { readonly storage: Storage; readonly revision: number; readonly result: SourceCommitResult }
): RestartableSourceState<Storage> => {
  let matched = false;
  const ledger = state.ledger.map((entry) => {
    if (entry.operationEpoch !== identity.operationEpoch || entry.operationId !== identity.operationId) return entry;
    if (entry.intentHash !== identity.intentHash) throw new Error('Cannot complete an ambiguous operation identity');
    matched = true;
    return { ...entry, result: completion.result };
  });
  if (!matched) throw new Error('Operation must be durably reserved before completion');
  return { ...state, storage: completion.storage, revision: completion.revision, ledger };
};

export const lookupRestartableOperation = <Storage>(
  state: RestartableSourceState<Storage>,
  identity: { readonly operationEpoch: string; readonly operationId: string; readonly intentHash: ContentHash }
): SourceOutcomeLookup<SourceCommitResult> => {
  if (identity.operationEpoch !== state.operationEpoch) return { status: 'expired' };
  const existing = state.ledger.find((entry) => entry.operationEpoch === identity.operationEpoch && entry.operationId === identity.operationId);
  if (existing === undefined) return { status: 'not_seen' };
  if (existing.intentHash !== identity.intentHash) return { status: 'ambiguous' };
  return existing.result === undefined ? { status: 'unavailable', issues: [outcomeIssue(identity.operationId)] } : { status: 'known', result: existing.result };
};

/** Persistence adapters must make each update atomic and durable before returning. */
export interface RestartableStateStore<Storage> {
  read(): RestartableSourceState<Storage>;
  update<Result>(transition: (state: RestartableSourceState<Storage>) => {
    readonly state: RestartableSourceState<Storage>;
    readonly result: Result;
  }): Result;
}

/** Serialized reference shell used to prove process-object recreation semantics. */
export class SerializedRestartableStateStore<Storage> implements RestartableStateStore<Storage> {
  #state: RestartableSourceState<Storage>;

  constructor(initial: RestartableSourceState<Storage>) {
    this.#state = structuredClone(initial);
  }

  read(): RestartableSourceState<Storage> {
    return structuredClone(this.#state);
  }

  update<Result>(transition: (state: RestartableSourceState<Storage>) => { readonly state: RestartableSourceState<Storage>; readonly result: Result }): Result {
    const transitioned = transition(this.read());
    // Serialization occurs before the caller receives the transition result.
    this.#state = structuredClone(transitioned.state);
    return transitioned.result;
  }
}

export type RestartableApply<Storage, Command> = (
  storage: Storage,
  commands: readonly Command[]
) => { readonly storage: Storage; readonly changed: boolean };

export class RestartableReferenceSource<Storage, Command> implements AtomicSource<Storage, Command> {
  readonly sourceId: string;
  readonly #store: RestartableStateStore<Storage>;
  readonly #apply: RestartableApply<Storage, Command>;
  readonly #relateFootprints: (left: Footprint, right: Footprint) => FootprintRelation;
  readonly #listeners = new Set<() => void>();
  #loseNextCommitResult: boolean;

  constructor(options: {
    readonly store: RestartableStateStore<Storage>;
    readonly apply: RestartableApply<Storage, Command>;
    readonly relateFootprints: (left: Footprint, right: Footprint) => FootprintRelation;
    readonly loseNextCommitResult?: boolean;
  }) {
    this.#store = options.store;
    this.#apply = options.apply;
    this.#relateFootprints = options.relateFootprints;
    this.#loseNextCommitResult = options.loseNextCommitResult ?? false;
    this.sourceId = options.store.read().sourceId;
  }

  snapshot(): SourceSnapshot<Storage> {
    const state = this.#store.read();
    return {
      sourceId: state.sourceId,
      operationEpoch: state.operationEpoch,
      basis: basisOf(state),
      state: 'ready',
      freshness: 'current',
      storage: state.storage,
      issues: []
    };
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => { this.#listeners.delete(listener); };
  }

  relateFootprints(left: Footprint, right: Footprint): FootprintRelation {
    return this.#relateFootprints(left, right);
  }

  mergeIntents(plans: readonly PlanResult<Command>[]): IntentMergeResult<Command> {
    return { outcome: 'merged', commands: plans.flatMap((plan) => plan.intents.map(({ command }) => command)) };
  }

  stage(snapshot: SourceSnapshot<Storage>, commands: readonly Command[]): { readonly storage: Storage; readonly issues: readonly [] } {
    if (snapshot.storage === undefined) return { storage: this.#store.read().storage, issues: [] };
    return { storage: this.#apply(snapshot.storage, commands).storage, issues: [] };
  }

  async commit(input: SourceCommitInput<Command>): Promise<SourceCommitResult> {
    const identity = { operationEpoch: input.operationEpoch, operationId: input.operationId, intentHash: input.intentHash };
    const reservation = this.#store.update((state) => {
      const reserved = reserveRestartableOperation(state, identity);
      return { state: reserved.state, result: reserved };
    });
    if (reservation.status === 'known') return reservation.result;
    if (reservation.status === 'ambiguous') return { outcome: 'rejected', issues: [ambiguousIssue(input.operationId)] };
    if (reservation.status === 'expired') return { outcome: 'rejected', issues: [expiredIssue(input.operationId)] };
    if (reservation.status === 'pending') return { outcome: 'unknown', issues: [outcomeIssue(input.operationId)] };

    const completed = this.#store.update((state) => {
      const beforeBasis = basisOf(state);
      if (!sameBasis(input.expectedBasis, beforeBasis)) {
        const result: SourceCommitResult = {
          outcome: 'rejected',
          beforeBasis,
          issues: [staleBasisIssue(input.operationId, input.expectedBasis, beforeBasis)]
        };
        return { state: completeRestartableOperation(state, identity, { storage: state.storage, revision: state.revision, result }), result: { result, changed: false } };
      }
      const applied = this.#apply(state.storage, input.commands);
      const revision = applied.changed ? state.revision + 1 : state.revision;
      const result: SourceCommitResult = {
        outcome: 'committed',
        beforeBasis,
        afterBasis: { incarnation: state.incarnation, revision },
        issues: []
      };
      return { state: completeRestartableOperation(state, identity, { storage: applied.storage, revision, result }), result: { result, changed: applied.changed } };
    });
    if (completed.changed) for (const listener of this.#listeners) listener();
    if (this.#loseNextCommitResult) {
      this.#loseNextCommitResult = false;
      return {
        outcome: 'unknown',
        ...(completed.result.beforeBasis === undefined ? {} : { beforeBasis: completed.result.beforeBasis }),
        issues: [outcomeIssue(input.operationId)]
      };
    }
    return completed.result;
  }

  async queryOutcome(input: { readonly operationEpoch: string; readonly operationId: string; readonly intentHash: ContentHash }): Promise<SourceOutcomeLookup<SourceCommitResult>> {
    return lookupRestartableOperation(this.#store.read(), input);
  }
}

const basisOf = <Storage>(state: RestartableSourceState<Storage>): RestartableBasis => ({ incarnation: state.incarnation, revision: state.revision });
const sameBasis = (left: unknown, right: RestartableBasis): boolean => {
  if (left === null || typeof left !== 'object' || Array.isArray(left)) return false;
  const candidate = left as Readonly<Record<string, unknown>>;
  return candidate.incarnation === right.incarnation && candidate.revision === right.revision;
};
const outcomeIssue = (operationId: string) => createIssue({ code: 'transaction.outcome_unavailable', retry: 'query_outcome', operationId });
const ambiguousIssue = (operationId: string) => createIssue({ code: 'transaction.operation_id_ambiguous', retry: 'never', operationId });
const expiredIssue = (operationId: string) => createIssue({ code: 'transaction.operation_epoch_expired', retry: 'never', operationId });
const staleBasisIssue = (operationId: string, expected: unknown, actual: RestartableBasis) => createIssue({ code: 'transaction.expected_basis_stale', retry: 'after_refresh', operationId, details: { expected, actual } });
