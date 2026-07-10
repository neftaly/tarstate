import { issue, type Issue } from './wire.js';

export type HydrationState = 'loading' | 'ready' | 'failed';

export type AtomicExternalStore<State> = {
  readonly getState: () => State;
  readonly subscribe: (listener: () => void) => () => void;
  readonly update: <Result>(fn: (current: State) => { readonly state: State; readonly changed: boolean; readonly result: Result }) => Result;
  readonly hydration?: {
    readonly getState: () => HydrationState;
    readonly subscribe: (listener: () => void) => () => void;
  };
};

export type ExternalStoreBasis = { readonly incarnation: string; readonly revision: number };

export type ExternalStoreSnapshot<State> = {
  readonly sourceId: string;
  readonly basis: ExternalStoreBasis;
  readonly state: 'loading' | 'ready' | 'failed' | 'closed';
  readonly freshness: 'current' | 'none';
  readonly storage?: State;
  readonly issues: readonly Issue[];
};

export type ExternalStoreCommitResult<Result> =
  | { readonly outcome: 'committed'; readonly beforeBasis: ExternalStoreBasis; readonly afterBasis: ExternalStoreBasis; readonly changed: boolean; readonly result: Result; readonly issues: readonly Issue[] }
  | { readonly outcome: 'rejected'; readonly beforeBasis: ExternalStoreBasis; readonly issues: readonly Issue[] };

type RuntimeEntry = ExternalStoreRuntime<unknown>;
const runtimesByStore = new WeakMap<object, Map<string, RuntimeEntry>>();
const liveRuntimeBySourceId = new Map<string, { readonly store: object; readonly runtime: RuntimeEntry }>();
let nextIncarnation = 1;

export class ExternalStoreRuntime<State> {
  readonly sourceId: string;
  readonly incarnation: string;
  readonly store: AtomicExternalStore<State>;
  readonly #storeIdentity: object;
  readonly #listeners = new Set<() => void>();
  readonly #unsubscribeStore: () => void;
  readonly #unsubscribeHydration: (() => void) | undefined;
  #revision = 0;
  #leases = 0;
  #coordinating = false;
  #closed = false;
  #hydration: HydrationState;

  constructor(sourceId: string, store: AtomicExternalStore<State>, storeIdentity: object) {
    this.sourceId = sourceId;
    this.store = store;
    this.#storeIdentity = storeIdentity;
    this.incarnation = sourceId + ':external:' + nextIncarnation++;
    this.#hydration = store.hydration?.getState() ?? 'ready';
    this.#unsubscribeStore = store.subscribe(() => this.#onStoreSignal());
    this.#unsubscribeHydration = store.hydration?.subscribe(() => this.#onHydrationSignal());
  }

  get leaseCount(): number { return this.#leases; }

  snapshot(): ExternalStoreSnapshot<State> {
    const basis = { incarnation: this.incarnation, revision: this.#revision };
    if (this.#closed) return { sourceId: this.sourceId, basis, state: 'closed', freshness: 'none', issues: [] };
    if (this.#hydration !== 'ready') return {
      sourceId: this.sourceId, basis, state: this.#hydration, freshness: 'none', issues: this.#hydration === 'failed' ? [issue('source.hydration_failed', 'lifecycle', undefined, { sourceId: this.sourceId, retry: 'after_refresh' })] : []
    };
    return { sourceId: this.sourceId, basis, state: 'ready', freshness: 'current', storage: this.store.getState(), issues: [] };
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  commit<Result>(expectedBasis: ExternalStoreBasis, update: (current: State) => { readonly state: State; readonly changed: boolean; readonly result: Result }): ExternalStoreCommitResult<Result> {
    const beforeBasis = this.snapshot().basis;
    if (this.#closed) return { outcome: 'rejected', beforeBasis, issues: [issue('source.closed', 'commit', undefined, { sourceId: this.sourceId, retry: 'never' })] };
    if (this.#hydration !== 'ready') return { outcome: 'rejected', beforeBasis, issues: [issue('source.not_ready', 'commit', { hydration: this.#hydration }, { sourceId: this.sourceId, retry: 'after_refresh' })] };
    if (!sameBasis(expectedBasis, beforeBasis)) return { outcome: 'rejected', beforeBasis, issues: [issue('transaction.expected_basis_stale', 'commit', { expected: expectedBasis, actual: beforeBasis }, { sourceId: this.sourceId, retry: 'after_refresh' })] };

    let changed = false;
    const previousRevision = this.#revision;
    this.#coordinating = true;
    try {
      const result = this.store.update((current) => {
        if (!sameBasis(expectedBasis, { incarnation: this.incarnation, revision: this.#revision })) throw new StaleExternalStoreBasisError();
        const next = update(current);
        if (next.changed && Object.is(next.state, current)) throw new Error('AtomicExternalStore changed update must return a distinct state');
        changed = next.changed;
        if (changed) this.#revision += 1;
        return next;
      });
      this.#coordinating = false;
      if (changed) this.#notify();
      return { outcome: 'committed', beforeBasis, afterBasis: { incarnation: this.incarnation, revision: this.#revision }, changed, result, issues: [] };
    } catch (error) {
      this.#coordinating = false;
      this.#revision = previousRevision;
      if (error instanceof StaleExternalStoreBasisError) return { outcome: 'rejected', beforeBasis, issues: [issue('transaction.expected_basis_stale', 'commit', undefined, { sourceId: this.sourceId, retry: 'after_refresh' })] };
      throw error;
    }
  }

  acquireLease(): void { if (this.#closed) throw new Error('External store runtime is closed'); this.#leases += 1; }

  releaseLease(): void {
    if (this.#leases === 0) return;
    this.#leases -= 1;
    if (this.#leases > 0) return;
    this.#closed = true;
    this.#unsubscribeStore();
    this.#unsubscribeHydration?.();
    this.#listeners.clear();
    const bySource = runtimesByStore.get(this.#storeIdentity);
    bySource?.delete(this.sourceId);
    if (bySource?.size === 0) runtimesByStore.delete(this.#storeIdentity);
    if (liveRuntimeBySourceId.get(this.sourceId)?.runtime === this as unknown as RuntimeEntry) liveRuntimeBySourceId.delete(this.sourceId);
  }

  #onStoreSignal(): void {
    if (this.#closed) return;
    if (this.#coordinating) return;
    if (this.#hydration === 'loading') return;
    this.#revision += 1;
    this.#notify();
  }

  #onHydrationSignal(): void {
    if (this.#closed) return;
    const next = this.store.hydration?.getState() ?? 'ready';
    if (next === this.#hydration) return;
    this.#hydration = next;
    this.#revision += 1;
    this.#notify();
  }

  #notify(): void { for (const listener of this.#listeners) listener(); }
}

class StaleExternalStoreBasisError extends Error {}

export type ExternalStoreLease<State> = {
  readonly runtime: ExternalStoreRuntime<State>;
  readonly release: () => void;
};

export const acquireExternalStoreRuntime = <State>(options: {
  readonly sourceId: string;
  readonly store: AtomicExternalStore<State>;
  readonly storeIdentity: object;
}): ExternalStoreLease<State> => {
  const live = liveRuntimeBySourceId.get(options.sourceId);
  if (live !== undefined && live.store !== options.storeIdentity) throw new Error('A different live store is already registered for source ID ' + options.sourceId);
  let bySource = runtimesByStore.get(options.storeIdentity);
  if (bySource === undefined) { bySource = new Map(); runtimesByStore.set(options.storeIdentity, bySource); }
  let runtime = bySource.get(options.sourceId) as ExternalStoreRuntime<State> | undefined;
  if (runtime === undefined) {
    runtime = new ExternalStoreRuntime(options.sourceId, options.store, options.storeIdentity);
    bySource.set(options.sourceId, runtime as unknown as RuntimeEntry);
    liveRuntimeBySourceId.set(options.sourceId, { store: options.storeIdentity, runtime: runtime as unknown as RuntimeEntry });
  }
  runtime.acquireLease();
  let released = false;
  return { runtime, release: () => { if (released) return; released = true; runtime.releaseLease(); } };
};

const sameBasis = (left: ExternalStoreBasis, right: ExternalStoreBasis): boolean => left.incarnation === right.incarnation && left.revision === right.revision;
