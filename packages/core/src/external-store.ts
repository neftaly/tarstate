import type { HostRuntimeRegistry, RuntimeLease } from './host.js';
import { createIssue, type Issue } from './issues.js';
import {
  notifyObservers,
  runObserverCleanups,
  type ObserverDiagnosticReporter
} from './observer-diagnostics.js';

export type HydrationState = 'loading' | 'ready' | 'failed';

/**
 * The smallest store contract on which Tarstate can provide exact local
 * expected-basis commits. Both the update and its notification must be
 * synchronous.
 */
export type AtomicExternalStore<State> = {
  readonly getState: () => State;
  readonly subscribe: (listener: () => void) => () => void;
  readonly update: <Result>(fn: (current: State) => {
    readonly state: State;
    readonly changed: boolean;
    readonly result: Result;
  }) => Result;
  readonly hydration?: {
    readonly getState: () => HydrationState;
    readonly subscribe: (listener: () => void) => () => void;
  };
};

export type ExternalStoreBasis = {
  readonly incarnation: string;
  readonly revision: number;
};

export type ExternalStoreSnapshot<State> = {
  readonly sourceId: string;
  readonly basis: ExternalStoreBasis;
  readonly state: 'loading' | 'ready' | 'failed' | 'closed';
  readonly freshness: 'current' | 'none';
  readonly storage?: State;
  readonly issues: readonly Issue[];
};

export type ExternalStoreCommitResult<Result> =
  | {
    readonly outcome: 'committed';
    readonly beforeBasis: ExternalStoreBasis;
    readonly afterBasis: ExternalStoreBasis;
    readonly changed: boolean;
    readonly result: Result;
    readonly issues: readonly Issue[];
  }
  | {
    readonly outcome: 'rejected';
    readonly beforeBasis: ExternalStoreBasis;
    readonly issues: readonly Issue[];
  };

// Incarnations only need process-local uniqueness. Runtime ownership and
// source-identity conflict detection live in HostRuntimeRegistry, not here.
let nextIncarnation = 1;

export class ExternalStoreRuntime<State> {
  readonly sourceId: string;
  readonly incarnation: string;
  readonly store: AtomicExternalStore<State>;
  readonly #listeners = new Set<() => void>();
  readonly #unsubscribeStore: () => void;
  readonly #unsubscribeHydration: (() => void) | undefined;
  readonly #onDiagnostic: ObserverDiagnosticReporter | undefined;
  #revision = 0;
  #leaseCount = 0;
  #coordinating = false;
  #closed = false;
  #hydration: HydrationState;

  constructor(sourceId: string, store: AtomicExternalStore<State>, options: { readonly onDiagnostic?: ObserverDiagnosticReporter } = {}) {
    this.sourceId = sourceId;
    this.store = store;
    this.#onDiagnostic = options.onDiagnostic;
    this.incarnation = sourceId + ':external:' + nextIncarnation++;
    this.#hydration = store.hydration?.getState() ?? 'ready';
    const unsubscribeStore = store.subscribe(() => this.#onStoreSignal());
    let unsubscribeHydration: (() => void) | undefined;
    try {
      unsubscribeHydration = store.hydration?.subscribe(() => this.#onHydrationSignal());
    } catch (error) {
      runObserverCleanups([unsubscribeStore], {
        component: 'external-store', operation: 'rollback-construction'
      }, this.#onDiagnostic);
      throw error;
    }
    this.#unsubscribeStore = unsubscribeStore;
    this.#unsubscribeHydration = unsubscribeHydration;

    // Hydration may finish between the first read and subscription setup. No
    // public snapshot exists yet, so adopt the authoritative current state as
    // the initial state of this incarnation without inventing a revision.
    this.#hydration = store.hydration?.getState() ?? 'ready';
  }

  get leaseCount(): number {
    return this.#leaseCount;
  }

  snapshot(): ExternalStoreSnapshot<State> {
    const basis = this.#basis();
    if (this.#closed) {
      return { sourceId: this.sourceId, basis, state: 'closed', freshness: 'none', issues: [] };
    }
    if (this.#hydration !== 'ready') {
      return {
        sourceId: this.sourceId,
        basis,
        state: this.#hydration,
        freshness: 'none',
        issues: this.#hydration === 'failed'
          ? [externalStoreIssue('source.hydration_failed', 'lifecycle', this.sourceId, 'after_refresh')]
          : []
      };
    }
    return {
      sourceId: this.sourceId,
      basis,
      state: 'ready',
      freshness: 'current',
      storage: this.store.getState(),
      issues: []
    };
  }

  subscribe(listener: () => void): () => void {
    if (this.#closed) return () => undefined;
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  commit<Result>(
    expectedBasis: ExternalStoreBasis,
    update: (current: State) => {
      readonly state: State;
      readonly changed: boolean;
      readonly result: Result;
    }
  ): ExternalStoreCommitResult<Result> {
    const beforeBasis = this.#basis();
    if (this.#closed) {
      return {
        outcome: 'rejected',
        beforeBasis,
        issues: [externalStoreIssue('source.closed', 'commit', this.sourceId, 'never')]
      };
    }
    if (this.#hydration !== 'ready') {
      return {
        outcome: 'rejected',
        beforeBasis,
        issues: [externalStoreIssue('source.not_ready', 'commit', this.sourceId, 'after_refresh', { hydration: this.#hydration })]
      };
    }
    if (!sameExternalStoreBasis(expectedBasis, beforeBasis)) {
      return this.#staleBasis(beforeBasis, expectedBasis);
    }

    let changed = false;
    let updateInvoked = false;
    const previousRevision = this.#revision;
    this.#coordinating = true;
    try {
      const result = this.store.update((current) => {
        if (updateInvoked) throw new Error('AtomicExternalStore must invoke its updater exactly once');
        updateInvoked = true;
        // The authoritative comparison and revision advancement happen inside
        // the store's atomic update boundary, not on its notification path.
        if (!sameExternalStoreBasis(expectedBasis, this.#basis())) {
          throw new StaleExternalStoreBasisError();
        }
        const next = update(current);
        if (next.changed && Object.is(next.state, current)) {
          throw new Error('AtomicExternalStore changed update must return a distinct state');
        }
        changed = next.changed;
        if (changed) this.#revision += 1;
        return next;
      });
      if (!updateInvoked) throw new Error('AtomicExternalStore must invoke its updater synchronously');
      this.#coordinating = false;
      if (changed) this.#notify();
      return {
        outcome: 'committed',
        beforeBasis,
        afterBasis: this.#basis(),
        changed,
        result,
        issues: []
      };
    } catch (error) {
      this.#coordinating = false;
      this.#revision = previousRevision;
      if (error instanceof StaleExternalStoreBasisError) return this.#staleBasis(beforeBasis, expectedBasis);
      throw error;
    }
  }

  /** @internal Lease accounting is paired with HostRuntimeRegistry leases. */
  acquireLease(): void {
    if (this.#closed) throw new Error('External store runtime is closed');
    this.#leaseCount += 1;
  }

  /** @internal */
  releaseLease(): void {
    if (this.#leaseCount > 0) this.#leaseCount -= 1;
  }

  /** @internal Called by the owning host registry after its final lease. */
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    runObserverCleanups([
      this.#unsubscribeStore,
      ...(this.#unsubscribeHydration === undefined ? [] : [this.#unsubscribeHydration])
    ], { component: 'external-store', operation: 'close' }, this.#onDiagnostic);
    this.#listeners.clear();
  }

  #basis(): ExternalStoreBasis {
    return { incarnation: this.incarnation, revision: this.#revision };
  }

  #staleBasis(beforeBasis: ExternalStoreBasis, expectedBasis: ExternalStoreBasis): ExternalStoreCommitResult<never> {
    return {
      outcome: 'rejected',
      beforeBasis,
      issues: [externalStoreIssue(
        'transaction.expected_basis_stale',
        'commit',
        this.sourceId,
        'after_refresh',
        { expected: expectedBasis, actual: this.#basis() }
      )]
    };
  }

  #onStoreSignal(): void {
    if (this.#closed || this.#coordinating) return;
    const hydrationChanged = this.#refreshHydration();
    if (hydrationChanged) {
      this.#revision += 1;
      this.#notify();
      return;
    }
    if (this.#hydration === 'loading') return;
    this.#revision += 1;
    this.#notify();
  }

  #onHydrationSignal(): void {
    if (this.#closed || !this.#refreshHydration()) return;
    this.#revision += 1;
    this.#notify();
  }

  #refreshHydration(): boolean {
    const next = this.store.hydration?.getState() ?? 'ready';
    if (next === this.#hydration) return false;
    this.#hydration = next;
    return true;
  }

  #notify(): void {
    notifyObservers(this.#listeners, (listener) => listener(), {
      component: 'external-store', operation: 'publish'
    }, this.#onDiagnostic);
  }
}

export type ExternalStoreLease<State> = {
  readonly runtime: ExternalStoreRuntime<State>;
  readonly release: () => void;
};

export const acquireExternalStoreRuntime = <State>(options: {
  readonly registry: HostRuntimeRegistry;
  readonly sourceId: string;
  readonly store: AtomicExternalStore<State>;
  readonly storeIdentity: object;
  readonly onDiagnostic?: ObserverDiagnosticReporter;
}): ExternalStoreLease<State> => {
  const hostLease: RuntimeLease<ExternalStoreRuntime<State>> = options.registry.acquire({
    sourceId: options.sourceId,
    identity: options.storeIdentity,
    create: () => {
      const diagnosticOptions = options.onDiagnostic === undefined ? {} : { onDiagnostic: options.onDiagnostic };
      const runtime = new ExternalStoreRuntime(options.sourceId, options.store, diagnosticOptions);
      return { runtime, close: () => runtime.close() };
    }
  });
  hostLease.runtime.acquireLease();
  let released = false;
  return {
    runtime: hostLease.runtime,
    release: () => {
      if (released) return;
      released = true;
      hostLease.runtime.releaseLease();
      hostLease.release();
    }
  };
};

export const sameExternalStoreBasis = (left: ExternalStoreBasis, right: ExternalStoreBasis): boolean =>
  left.incarnation === right.incarnation && left.revision === right.revision;

class StaleExternalStoreBasisError extends Error {}

const externalStoreIssue = (
  code: string,
  phase: 'commit' | 'lifecycle',
  sourceId: string,
  retry: 'never' | 'after_refresh',
  details?: unknown
): Issue => createIssue({ code, phase, severity: 'error', sourceId, retry, ...(details === undefined ? {} : { details }) });
