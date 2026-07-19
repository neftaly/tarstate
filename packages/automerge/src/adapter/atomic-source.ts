import * as Automerge from '@automerge/automerge';
import { comparePortableStrings } from '../shared/portable-order.js';
import {
  canonicalizeJson,
  createIssue,
  type ContentHash,
  type Issue
} from '@tarstate/core';
import {
  type AtomicSource,
  type IntentMergeResult,
  type PlanResult,
  type SourceCommitInput,
  type SourceCommitResult,
  type SourceOutcomeLookup,
  type SourceSnapshot
} from '@tarstate/core/source';
import {
  applySourceCommands,
  automergeBasis,
  exactAutomergeBasisEqual,
  type AutomergeSnapshot,
  type AutomergeSourceRuntimeApi,
  type AutomergeBasis,
  type AutomergeSourceCommand,
  type AutomergeSourceCommitResult
} from '../source/runtime.js';
import {
  reportAutomergeDiagnostic,
  runAutomergeCleanups,
  type AutomergeSourceDiagnosticReporter
} from '../source/diagnostics.js';
import { adoptAutomergeBasis } from '../shared/basis-adoption.js';
import {
  findAutomergeFootprintOverlap,
  relateAutomergeFootprints
} from './footprint.js';

export {
  automergePathFootprint,
  relateAutomergeFootprints,
  type AutomergePathFootprint,
  type AutomergePathFootprintEntry
} from './footprint.js';

export type AutomergeAtomicSourceOptions<T extends object> = {
  readonly runtime: AutomergeSourceRuntimeApi<T>;
  readonly operationEpoch: string;
  readonly ownsRuntime?: boolean;
  readonly onDiagnostic?: AutomergeSourceDiagnosticReporter;
};

/** Core AtomicSource facade over the proven exact-head Automerge runtime. */
export class AutomergeAtomicSource<T extends object> implements AtomicSource<Automerge.Doc<T>, AutomergeSourceCommand<T>> {
  readonly sourceId: string;
  readonly operationEpoch: string;
  readonly #runtime: AutomergeSourceRuntimeApi<T>;
  readonly #ownsRuntime: boolean;
  readonly #onDiagnostic: AutomergeSourceDiagnosticReporter | undefined;
  readonly #listeners = new Set<(change?: { readonly beforeBasis?: import('@tarstate/core/source').SourceBasis; readonly afterBasis: import('@tarstate/core/source').SourceBasis }) => void>();
  readonly #unsubscribeRuntime: () => void;
  #closed = false;
  #snapshot: SourceSnapshot<Automerge.Doc<T>> & { readonly basis: AutomergeBasis };

  constructor(options: AutomergeAtomicSourceOptions<T>) {
    if (options.operationEpoch.length === 0) throw new TypeError('operationEpoch must not be empty');
    this.#runtime = options.runtime;
    this.sourceId = options.runtime.sourceId;
    this.operationEpoch = options.operationEpoch;
    this.#ownsRuntime = options.ownsRuntime === true;
    this.#onDiagnostic = options.onDiagnostic;
    const initial = options.runtime.snapshot();
    this.#snapshot = readySourceSnapshot(
      this.sourceId,
      this.operationEpoch,
      initial
    );
    this.#unsubscribeRuntime = options.runtime.subscribe(() => {
      if (this.#closed) return;
      const latest = this.#runtime.snapshot();
      const beforeBasis = this.#snapshot.basis;
      if (beforeBasis === latest.basis || exactAutomergeBasisEqual(beforeBasis, latest.basis)) return;
      this.#snapshot = readySourceSnapshot(
        this.sourceId,
        this.operationEpoch,
        latest
      );
      this.#publish({ beforeBasis, afterBasis: latest.basis });
    });
  }

  snapshot = (): SourceSnapshot<Automerge.Doc<T>> => this.#snapshot;

  snapshotAt = (input: import('@tarstate/core/source').SourceBasis): SourceSnapshot<Automerge.Doc<T>> => {
    if (this.#closed) throw new TypeError('Cannot view a closed Automerge source');
    const basis = parseAutomergeBasis(input);
    if (basis === undefined) throw new TypeError('Automerge historical view requires an Automerge basis');
    const view = this.#runtime.view(basis);
    return Object.freeze({
      sourceId: this.sourceId,
      operationEpoch: this.operationEpoch,
      basis: view.basis,
      state: 'ready',
      freshness: 'current',
      storage: view.storage,
      issues: noIssues
    });
  };

  subscribe = (listener: (change?: { readonly beforeBasis?: import('@tarstate/core/source').SourceBasis; readonly afterBasis: import('@tarstate/core/source').SourceBasis }) => void): (() => void) => {
    if (this.#closed) return () => undefined;
    this.#listeners.add(listener);
    return () => { this.#listeners.delete(listener); };
  };

  commit = async (input: SourceCommitInput<AutomergeSourceCommand<T>>): Promise<SourceCommitResult> => {
    if (this.#closed) {
      return frozenCoreCommitResult({ outcome: 'rejected', issues: this.#snapshot.issues });
    }
    if (input.operationEpoch !== this.operationEpoch) {
      return frozenCoreCommitResult({
        outcome: 'rejected',
        issues: [createIssue({
          code: 'transaction.operation_epoch_expired',
          sourceId: this.sourceId,
          operationId: input.operationId,
          retry: 'never',
          details: { expected: this.operationEpoch, received: input.operationEpoch }
        })]
      });
    }
    const basis = parseAutomergeBasis(input.expectedBasis);
    if (basis === undefined) {
      return frozenCoreCommitResult({
        outcome: 'rejected',
        issues: [createIssue({
          code: 'transaction.expected_basis_stale',
          phase: 'commit',
          severity: 'error',
          retry: 'after_refresh',
          sourceId: this.sourceId,
          operationId: input.operationId,
          details: { reason: 'automerge_basis_required' }
        })]
      });
    }
    const result = await this.#runtime.commit({
      operationEpoch: input.operationEpoch,
      operationId: input.operationId,
      intentHash: input.intentHash,
      expectedBasis: basis,
      commands: input.commands
    });
    return coreCommitResult(result);
  };

  commitReconciled = async (
    input: import('@tarstate/core/source').ReconciledSourceCommitInput<Automerge.Doc<T>>
  ): Promise<SourceCommitResult> => {
    if (this.#closed) {
      return frozenCoreCommitResult({
        outcome: 'rejected',
        issues: this.#snapshot.issues
      });
    }
    const basis = parseAutomergeBasis(input.expectedBasis);
    if (basis === undefined) {
      return frozenCoreCommitResult({
        outcome: 'rejected',
        issues: [createIssue({
          code: 'transaction.expected_basis_stale',
          phase: 'commit',
          severity: 'error',
          retry: 'after_refresh',
          sourceId: this.sourceId,
          operationId: input.operationId,
          details: { reason: 'automerge_basis_required' }
        })]
      });
    }
    return coreCommitResult(await this.#runtime.commitReconciled({
      operationEpoch: input.operationEpoch,
      operationId: input.operationId,
      intentHash: input.intentHash,
      expectedBasis: basis,
      candidate: input.candidate
    }));
  };

  relateFootprints = relateAutomergeFootprints;

  mergeIntents = (plans: readonly PlanResult<AutomergeSourceCommand<T>>[]): IntentMergeResult<AutomergeSourceCommand<T>> => {
    const intents = plans.flatMap(({ intents }) => intents)
      .map((intent) => ({ intent, sortKey: canonicalizeJson(intent.footprint) }))
      .sort((left, right) => comparePortableStrings(left.sortKey, right.sortKey))
      .map(({ intent }) => intent);
    const overlap = findAutomergeFootprintOverlap(intents.map(({ footprint }) => footprint));
    if (overlap.status === 'unknown') {
      return {
        outcome: 'unknown',
        issues: [adapterIssue('binding.footprint_relation_unknown', 'plan', this.sourceId, undefined, undefined, { footprint: intents[overlap.footprintIndex]?.footprint })]
      };
    }
    if (overlap.status === 'overlap') {
      const left = intents[overlap.leftIndex]!;
      const right = intents[overlap.rightIndex]!;
      const relation = this.relateFootprints(left.footprint, right.footprint);
      return {
        outcome: 'conflict',
        issues: [adapterIssue('binding.write_footprint_overlap', 'plan', this.sourceId, undefined, undefined, { relation, left: left.footprint, right: right.footprint })]
      };
    }
    return { outcome: 'merged', commands: intents.map(({ command }) => command) };
  };

  stage = (snapshot: SourceSnapshot<Automerge.Doc<T>>, commands: readonly AutomergeSourceCommand<T>[]): { readonly storage: Automerge.Doc<T>; readonly issues: readonly Issue[] } => {
    if (snapshot.state !== 'ready' || snapshot.storage === undefined) throw new TypeError('Cannot stage a non-ready Automerge snapshot');
    try {
      const storage = commands.length === 0
        ? snapshot.storage
        : Automerge.change(
            // The clone is speculative and never merged. Reusing the serialized
            // owner's actor makes source-generated IDs match a later exact-basis publish.
            Automerge.clone(snapshot.storage, Automerge.getActorId(snapshot.storage)),
            { message: 'tarstate staged source commit', time: 0 },
            (draft) => { applySourceCommands(commands, draft); }
          );
      return { storage, issues: [] };
    } catch (error) {
      return {
        storage: snapshot.storage,
        issues: [adapterIssue('automerge.command_failed', 'plan', this.sourceId, undefined, undefined, { message: error instanceof Error ? error.message : String(error) })]
      };
    }
  };

  createPrivateBranch = (snapshot: SourceSnapshot<Automerge.Doc<T>>): Automerge.Doc<T> => {
    if (snapshot.state !== 'ready' || snapshot.storage === undefined) {
      throw new TypeError('Cannot branch a non-ready Automerge snapshot');
    }
    return Automerge.clone(snapshot.storage);
  };

  reconcile = (
    snapshot: SourceSnapshot<Automerge.Doc<T>>,
    commandBasis: import('@tarstate/core/source').SourceBasis,
    commands: readonly AutomergeSourceCommand<T>[],
    priorCandidate?: Automerge.Doc<T>
  ): { readonly storage: Automerge.Doc<T>; readonly issues: readonly Issue[] } => {
    if (snapshot.state !== 'ready' || snapshot.storage === undefined) {
      throw new TypeError('Cannot reconcile a non-ready Automerge snapshot');
    }
    const basis = parseAutomergeBasis(commandBasis);
    if (basis === undefined || !Automerge.hasHeads(snapshot.storage, [...basis.heads])) {
      return {
        storage: snapshot.storage,
        issues: [adapterIssue('transaction.expected_basis_stale', 'plan', this.sourceId, undefined, undefined, {
          reason: 'captured_basis_not_in_current_history'
        })]
      };
    }
    if (priorCandidate !== undefined
      && !Automerge.hasHeads(priorCandidate, [...basis.heads])) {
      return {
        storage: snapshot.storage,
        issues: [adapterIssue('transaction.expected_basis_stale', 'plan', this.sourceId, undefined, undefined, {
          reason: 'retained_candidate_missing_captured_basis'
        })]
      };
    }
    if (commands.length === 0 && priorCandidate === undefined) {
      return { storage: snapshot.storage, issues: [] };
    }
    try {
      const storage = priorCandidate === undefined
        ? Automerge.merge(
            Automerge.clone(snapshot.storage),
            Automerge.change(
              Automerge.clone(Automerge.view(snapshot.storage, [...basis.heads])),
              { message: 'tarstate source commit', time: 0 },
              (draft) => { applySourceCommands(commands, draft); }
            )
          )
        : Automerge.merge(Automerge.clone(snapshot.storage), priorCandidate);
      return { storage, issues: [] };
    } catch (error) {
      return {
        storage: snapshot.storage,
        issues: [adapterIssue('automerge.command_failed', 'plan', this.sourceId, undefined, undefined, {
          message: error instanceof Error ? error.message : String(error)
        })]
      };
    }
  };

  basisForStagedStorage = (_snapshot: SourceSnapshot<Automerge.Doc<T>>, stagedStorage: Automerge.Doc<T>): AutomergeBasis =>
    automergeBasis(stagedStorage);

  queryOutcome = async (input: { readonly operationEpoch: string; readonly operationId: string; readonly intentHash: ContentHash }): Promise<SourceOutcomeLookup<SourceCommitResult>> => {
    const lookup = this.#runtime.queryOutcome(input);
    if (lookup.status === 'known') return Object.freeze({ status: 'known', result: coreCommitResult(lookup.result) });
    return lookup;
  };

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    const basis = this.#snapshot.basis;
    this.#snapshot = Object.freeze({
      sourceId: this.sourceId,
      operationEpoch: this.operationEpoch,
      basis,
      state: 'closed',
      freshness: 'none',
      issues: Object.freeze([sourceClosedIssue(this.sourceId)])
    });
    this.#publish({ afterBasis: basis });
    this.#listeners.clear();
    runAutomergeCleanups([
      { operation: 'close.unsubscribe-runtime', cleanup: this.#unsubscribeRuntime },
      ...(this.#ownsRuntime ? [{ operation: 'close.runtime', cleanup: () => this.#runtime.close() }] : [])
    ], 'atomic-source', this.#onDiagnostic);
  }

  #publish(change: { readonly beforeBasis?: AutomergeBasis; readonly afterBasis: AutomergeBasis }): void {
    for (const listener of Array.from(this.#listeners)) {
      try {
        listener(change);
      } catch (error) {
        reportAutomergeDiagnostic(this.#onDiagnostic, {
          kind: 'listener_error', component: 'atomic-source', operation: 'publish', error
        });
      }
    }
  }
}

const frozenCoreCommitResult = (result: SourceCommitResult): SourceCommitResult => Object.freeze({
  ...result,
  ...('beforeBasis' in result && result.beforeBasis !== undefined ? {
    beforeBasis: result.beforeBasis,
    ...(result.afterBasis === undefined ? {} : { afterBasis: result.afterBasis })
  } : {}),
  ...(result.generatedKeys === undefined
    ? {}
    : { generatedKeys: result.generatedKeys }),
  issues: Object.freeze([...result.issues])
});

const coreCommitResult = (result: AutomergeSourceCommitResult): SourceCommitResult => frozenCoreCommitResult({
  outcome: result.outcome,
  ...('beforeBasis' in result ? { beforeBasis: result.beforeBasis, afterBasis: result.afterBasis } : {}),
  ...(result.generatedKeys.length === 0 ? {} : { generatedKeys: result.generatedKeys }),
  issues: result.issues.map((issue) => adapterIssue(
    issue.code,
    issue.phase,
    issue.sourceId,
    undefined,
    issue.operationId,
    issue.details
  ))
});

const adapterIssue = (
  code: string,
  phase: 'load' | 'query' | 'plan' | 'commit',
  sourceId: string,
  relationId?: string,
  operationId?: string,
  details?: unknown,
  path?: readonly unknown[]
): Issue => createIssue({
  code,
  phase,
  severity: phase === 'query' && (code.includes('conflict') || code.includes('ambiguous')) ? 'warning' : 'error',
  retry: adapterRetry(code, phase),
  sourceId,
  ...(relationId === undefined ? {} : { relationId }),
  ...(operationId === undefined ? {} : { operationId }),
  ...(details === undefined ? {} : { details }),
  ...(path === undefined ? {} : { path })
});

const sourceClosedIssue = (sourceId: string): Issue => createIssue({
  code: 'source.closed',
  phase: 'lifecycle',
  severity: 'error',
  retry: 'never',
  sourceId,
  details: { state: 'closed' }
});

const parseAutomergeBasis = (value: unknown): AutomergeBasis | undefined => {
  const adopted = adoptAutomergeBasis(value);
  return adopted.success ? adopted.value : undefined;
};

const noIssues: readonly Issue[] = Object.freeze([]);

const readySourceSnapshot = <T extends object>(
  sourceId: string,
  operationEpoch: string,
  snapshot: AutomergeSnapshot<T>
): SourceSnapshot<Automerge.Doc<T>> & { readonly basis: AutomergeBasis } => Object.freeze({
  sourceId,
  operationEpoch,
  basis: snapshot.basis,
  state: 'ready',
  freshness: 'current',
  storage: snapshot.storage,
  issues: noIssues
});

const adapterRetry = (code: string, phase: 'load' | 'query' | 'plan' | 'commit'): NonNullable<Issue['retry']> => {
  if (code === 'transaction.operation_id_ambiguous') return 'never';
  if (code === 'transaction.expected_basis_stale' || code === 'transaction.conflict_observation_stale' || code.startsWith('mapping.locator_')) return 'after_refresh';
  if (code.includes('conflict') || code.includes('ambiguous')) return 'manual_repair';
  return phase === 'load' ? 'after_refresh' : 'after_input';
};
