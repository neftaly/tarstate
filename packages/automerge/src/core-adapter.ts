import * as Automerge from '@automerge/automerge';
import { comparePortableStrings } from './portable-order.js';
import { samePortableJson } from './internal-portable-json.js';
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
  type SourceFreshness,
  type SourceLifecycleState,
  type SourceOutcomeLookup,
  type SourceSnapshot
} from '@tarstate/core/source';
import {
  automergeBasis,
  type AutomergeSourceRuntimeApi,
  type AutomergeBasis,
  type AutomergeSourceCommand,
  type AutomergeSourceCommitResult
} from './source.js';
import {
  reportAutomergeDiagnostic,
  runAutomergeCleanups,
  type AutomergeSourceDiagnosticReporter
} from './internal-diagnostics.js';
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
  readonly freshness?: SourceFreshness;
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
  #freshness: SourceFreshness;
  #lifecycle: SourceLifecycleState = 'ready';
  #lifecycleIssues: readonly Issue[] = Object.freeze([]);
  #lastReady: { readonly basis: AutomergeBasis; readonly storage: Automerge.Doc<T> };

  constructor(options: AutomergeAtomicSourceOptions<T>) {
    if (options.operationEpoch.length === 0) throw new TypeError('operationEpoch must not be empty');
    this.#runtime = options.runtime;
    this.sourceId = options.runtime.sourceId;
    this.operationEpoch = options.operationEpoch;
    this.#freshness = options.freshness ?? 'current';
    this.#ownsRuntime = options.ownsRuntime === true;
    this.#onDiagnostic = options.onDiagnostic;
    const initial = options.runtime.snapshot();
    this.#lastReady = { basis: initial.basis, storage: initial.storage };
    this.#unsubscribeRuntime = options.runtime.subscribe((change) => {
      const latest = this.#runtime.snapshot();
      this.#lastReady = { basis: latest.basis, storage: latest.storage };
      this.#publish({ beforeBasis: change.beforeBasis, afterBasis: change.afterBasis });
    });
  }

  snapshot = (): SourceSnapshot<Automerge.Doc<T>> => {
    if (this.#lifecycle !== 'ready') {
      return Object.freeze({
        sourceId: this.sourceId,
        operationEpoch: this.operationEpoch,
        basis: this.#lastReady.basis,
        state: this.#lifecycle,
        freshness: this.#lifecycle === 'closed' ? 'none' : this.#freshness,
        issues: this.#lifecycleIssues
      });
    }
    const current = this.#runtime.snapshot();
    return Object.freeze({
      sourceId: this.sourceId,
      operationEpoch: this.operationEpoch,
      basis: current.basis,
      state: 'ready',
      freshness: this.#freshness,
      storage: current.storage,
      issues: this.#lifecycleIssues
    });
  };

  subscribe = (listener: (change?: { readonly beforeBasis?: import('@tarstate/core/source').SourceBasis; readonly afterBasis: import('@tarstate/core/source').SourceBasis }) => void): (() => void) => {
    if (this.#lifecycle === 'closed') return () => undefined;
    this.#listeners.add(listener);
    return () => { this.#listeners.delete(listener); };
  };

  commit = async (input: SourceCommitInput<AutomergeSourceCommand<T>>): Promise<SourceCommitResult> => {
    if (this.#lifecycle !== 'ready') {
      return frozenCoreCommitResult({ outcome: 'rejected', issues: [sourceStateIssue(this.sourceId, this.#lifecycle)] });
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
        : Automerge.change(Automerge.clone(snapshot.storage), { message: 'tarstate staged source commit', time: 0 }, (draft) => {
            for (const command of commands) command.apply(draft);
          });
      return { storage, issues: [] };
    } catch (error) {
      return {
        storage: snapshot.storage,
        issues: [adapterIssue('automerge.command_failed', 'plan', this.sourceId, undefined, undefined, { message: error instanceof Error ? error.message : String(error) })]
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

  setFreshness(freshness: SourceFreshness): void {
    if (this.#lifecycle === 'closed' || freshness === this.#freshness) return;
    this.#freshness = freshness;
    this.#publish({ afterBasis: this.#lastReady.basis });
  }

  setLifecycle(state: Exclude<SourceLifecycleState, 'ready' | 'closed'>, issues: readonly Issue[] = []): void {
    if (this.#lifecycle === 'closed') throw new Error('Automerge atomic source is closed');
    if (state === this.#lifecycle && sameIssues(issues, this.#lifecycleIssues)) return;
    this.#lifecycle = state;
    this.#lifecycleIssues = Object.freeze([...issues]);
    this.#publish({ afterBasis: this.#lastReady.basis });
  }

  markReady(freshness: SourceFreshness = 'current'): void {
    if (this.#lifecycle === 'closed') throw new Error('Automerge atomic source is closed');
    this.#lifecycle = 'ready';
    this.#freshness = freshness;
    this.#lifecycleIssues = Object.freeze([]);
    this.#publish({ afterBasis: this.#lastReady.basis });
  }

  close(): void {
    if (this.#lifecycle === 'closed') return;
    this.#lifecycle = 'closed';
    this.#freshness = 'none';
    this.#lifecycleIssues = Object.freeze([createIssue({ code: 'source.closed', sourceId: this.sourceId, retry: 'never' })]);
    this.#publish({ afterBasis: this.#lastReady.basis });
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
  issues: Object.freeze([...result.issues])
});

const coreCommitResult = (result: AutomergeSourceCommitResult): SourceCommitResult => frozenCoreCommitResult({
  outcome: result.outcome,
  ...('beforeBasis' in result ? { beforeBasis: result.beforeBasis, afterBasis: result.afterBasis } : {}),
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

const sourceStateIssue = (sourceId: string, state: SourceLifecycleState): Issue => createIssue({
  code: state === 'closed' ? 'source.closed' : 'source.not_ready',
  phase: state === 'closed' ? 'lifecycle' : 'load',
  severity: 'error',
  retry: state === 'closed' ? 'never' : 'after_refresh',
  sourceId,
  details: { state }
});

const parseAutomergeBasis = (value: unknown): AutomergeBasis | undefined => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const candidate = value as { readonly kind?: unknown; readonly heads?: unknown };
  if (candidate.kind !== 'automerge-heads' || !Array.isArray(candidate.heads) || candidate.heads.some((head) => typeof head !== 'string')) return undefined;
  return { kind: 'automerge-heads', heads: [...new Set(candidate.heads as string[])].sort() };
};

const sameIssues = (left: readonly Issue[], right: readonly Issue[]): boolean => samePortableJson(left, right);

const adapterRetry = (code: string, phase: 'load' | 'query' | 'plan' | 'commit'): NonNullable<Issue['retry']> => {
  if (code === 'transaction.operation_id_ambiguous') return 'never';
  if (code === 'transaction.expected_basis_stale' || code === 'transaction.conflict_observation_stale' || code.startsWith('mapping.locator_')) return 'after_refresh';
  if (code.includes('conflict') || code.includes('ambiguous')) return 'manual_repair';
  return phase === 'load' ? 'after_refresh' : 'after_input';
};
