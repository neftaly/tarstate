import * as Automerge from '@automerge/automerge';

/** Exact, order-insensitive Automerge head set used for optimistic concurrency. */
export type AutomergeBasis = {
  readonly kind: 'automerge-heads';
  readonly heads: readonly string[];
};

export type AutomergeSnapshot<T extends object> = {
  readonly sourceId: string;
  readonly basis: AutomergeBasis;
  readonly storage: Automerge.Doc<T>;
};

export type AutomergeSourceChange = {
  readonly beforeBasis: AutomergeBasis;
  readonly afterBasis: AutomergeBasis;
  readonly origin: 'commit' | 'handle' | 'merge' | 'replace';
};

export type AutomergeSourceCommand<T extends object> = {
  readonly description?: string;
  readonly apply: Automerge.ChangeFn<T>;
};

type AutomergeSourceCommitEvidence = {
  readonly kind: 'source-commit';
  readonly operationEpoch: string;
  readonly operationId: string;
  readonly intentHash: `sha256:${string}`;
  readonly durability: 'local';
  readonly issues: readonly AutomergeSourceIssue[];
};

/** Exact-head commit evidence; rejected attempts either expose both equal bases or neither. */
export type AutomergeSourceCommitResult = AutomergeSourceCommitEvidence & (
  | { readonly outcome: 'committed'; readonly beforeBasis: AutomergeBasis; readonly afterBasis: AutomergeBasis; readonly changed: boolean }
  | { readonly outcome: 'rejected'; readonly beforeBasis: AutomergeBasis; readonly afterBasis: AutomergeBasis; readonly changed: false }
  | { readonly outcome: 'rejected'; readonly changed: false }
);

export type AutomergeSourceIssue = {
  readonly code: string;
  readonly phase: 'commit' | 'load';
  readonly sourceId: string;
  readonly operationId?: string;
  readonly details?: Readonly<Record<string, unknown>>;
};

export type AutomergeSourceOutcomeLookup =
  | { readonly status: 'known'; readonly result: AutomergeSourceCommitResult }
  | { readonly status: 'not_seen' }
  | { readonly status: 'ambiguous' | 'expired' };

type LedgerEntry = {
  readonly intentHash: `sha256:${string}`;
  readonly result: AutomergeSourceCommitResult;
};

/** Captures the document's current exact-head basis. */
export const automergeBasis = (doc: Automerge.Doc<unknown>): AutomergeBasis => Object.freeze({
  kind: 'automerge-heads',
  heads: Object.freeze([...Automerge.getHeads(doc)].sort())
});

const automergeSnapshot = <T extends object>(sourceId: string, basis: AutomergeBasis, storage: Automerge.Doc<T>): AutomergeSnapshot<T> =>
  Object.freeze({ sourceId, basis, storage });

export const exactAutomergeHeadsEqual = (left: readonly string[], right: readonly string[]): boolean => {
  if (left.length !== right.length) return false;
  const sortedLeft = [...left].sort();
  const sortedRight = [...right].sort();
  return sortedLeft.every((head, index) => head === sortedRight[index]);
};

export const exactAutomergeBasisEqual = (left: AutomergeBasis, right: AutomergeBasis): boolean =>
  left.kind === 'automerge-heads' && right.kind === 'automerge-heads' && exactAutomergeHeadsEqual(left.heads, right.heads);

/** Minimal Automerge Repo handle surface consumed by the source runtime. */
export type AutomergeRepoHandle<T extends object, Heads = unknown> = {
  readonly url: string;
  isReady(): boolean;
  isReadOnly(): boolean;
  doc(): Automerge.Doc<T>;
  heads(): Heads;
  changeAt(heads: Heads, change: Automerge.ChangeFn<T>, options?: Automerge.ChangeOptions<T>): Heads | undefined;
  on(event: 'heads-changed', listener: (payload: { readonly doc: Automerge.Doc<T> }) => void): unknown;
  off(event: 'heads-changed', listener: (payload: { readonly doc: Automerge.Doc<T> }) => void): unknown;
};

type DocumentOwner<T extends object> = {
  current(): Automerge.Doc<T>;
  changeAt(
    basis: AutomergeBasis,
    commands: readonly AutomergeSourceCommand<T>[],
    message: string,
  ): Automerge.Doc<T>;
  subscribe(listener: (doc: Automerge.Doc<T>) => void): () => void;
  close(): void;
  merge?(remote: Automerge.Doc<T>): Automerge.Doc<T>;
  replace?(doc: Automerge.Doc<T>): Automerge.Doc<T>;
};

const documentOwner = Symbol('AutomergeSourceRuntime.documentOwner');
type AutomergeSourceRuntimeOptions<T extends object> =
  | { readonly sourceId: string; readonly doc: Automerge.Doc<T> }
  | { readonly sourceId: string; readonly [documentOwner]: DocumentOwner<T> };

class StaleOwnerBasis<T extends object> extends Error {
  constructor(readonly storage: Automerge.Doc<T>) {
    super('Automerge document owner basis changed');
  }
}

/**
 * One explicit runtime owns one live Automerge document. It serializes local
 * commits, compares exact head sets, and never claims durable receipt storage.
 */
export class AutomergeSourceRuntime<T extends object> {
  readonly sourceId: string;
  readonly #owner: DocumentOwner<T>;
  readonly #unsubscribeOwner: () => void;
  #snapshot: AutomergeSnapshot<T>;
  #closed = false;
  #applying = false;
  #queue: Promise<void> = Promise.resolve();
  readonly #listeners = new Set<(change: AutomergeSourceChange) => void>();
  readonly #ledger = new Map<string, LedgerEntry>();
  readonly #retiredEpochs = new Set<string>();

  constructor(options: AutomergeSourceRuntimeOptions<T>) {
    if (options.sourceId.length === 0) throw new Error('Automerge sourceId must not be empty');
    this.sourceId = options.sourceId;
    this.#owner = 'doc' in options ? memoryDocumentOwner(options.doc) : options[documentOwner];
    const storage = this.#owner.current();
    this.#snapshot = automergeSnapshot(this.sourceId, automergeBasis(storage), storage);
    this.#unsubscribeOwner = this.#owner.subscribe((doc) => {
      if (!this.#applying) this.#install(doc, 'handle');
    });
  }

  /** Stable until exact heads change; retained storage stays basis-correct for reads and views.
   * Write via commit and save current snapshot storage: historical handles may serialize advanced shared state. */
  snapshot(): AutomergeSnapshot<T> {
    this.#assertOpen();
    return this.#snapshot;
  }

  view(basis: AutomergeBasis): AutomergeSnapshot<T> {
    this.#assertOpen();
    const storage = Automerge.view(this.#owner.current(), [...basis.heads]);
    return automergeSnapshot(this.sourceId, automergeBasis(storage), storage);
  }

  subscribe(listener: (change: AutomergeSourceChange) => void): () => void {
    this.#assertOpen();
    this.#listeners.add(listener);
    return () => { this.#listeners.delete(listener); };
  }

  commit(input: {
    readonly operationEpoch: string;
    readonly operationId: string;
    readonly intentHash: `sha256:${string}`;
    readonly expectedBasis: AutomergeBasis;
    readonly commands: readonly AutomergeSourceCommand<T>[];
    readonly message?: string;
  }): Promise<AutomergeSourceCommitResult> {
    if (this.#closed) return Promise.resolve(this.#rejected(input, undefined, [{ code: 'source.closed', phase: 'commit', sourceId: this.sourceId, operationId: input.operationId }]));
    if (this.#applying) {
      return Promise.resolve(this.#rejected(input, undefined, [{
        code: 'automerge.reentrant_commit',
        phase: 'commit',
        sourceId: this.sourceId,
        operationId: input.operationId
      }]));
    }
    const result = this.#queue.then(() => this.#commit(input));
    this.#queue = result.then(() => undefined, () => undefined);
    return result;
  }

  queryOutcome(input: {
    readonly operationEpoch: string;
    readonly operationId: string;
    readonly intentHash: `sha256:${string}`;
  }): AutomergeSourceOutcomeLookup {
    if (this.#retiredEpochs.has(input.operationEpoch)) return { status: 'expired' };
    const entry = this.#ledger.get(ledgerKey(input.operationEpoch, input.operationId));
    if (entry === undefined) return { status: 'not_seen' };
    if (entry.intentHash !== input.intentHash) return { status: 'ambiguous' };
    return { status: 'known', result: entry.result };
  }

  /** Retires one application-owned operation epoch after its in-flight work. */
  retireOperationEpoch(operationEpoch: string): Promise<void> {
    if (operationEpoch.length === 0) return Promise.reject(new TypeError('operationEpoch must not be empty'));
    const result = this.#queue.then(() => {
      this.#retiredEpochs.add(operationEpoch);
      for (const key of this.#ledger.keys()) if (key.startsWith(operationEpoch + '\u0000')) this.#ledger.delete(key);
    });
    this.#queue = result.then(() => undefined, () => undefined);
    return result;
  }

  merge(remote: Automerge.Doc<T>): AutomergeSnapshot<T> {
    this.#assertOpen();
    if (this.#applying) throw new Error('Cannot merge while an Automerge command is applying');
    if (this.#owner.merge === undefined) throw new Error('This Automerge document owner does not support merge');
    this.#install(this.#owner.merge(remote), 'merge');
    return this.snapshot();
  }

  /** Adopts a changed document; an exact-head-equivalent replacement is a no-op. */
  replace(doc: Automerge.Doc<T>): AutomergeSnapshot<T> {
    this.#assertOpen();
    if (this.#applying) throw new Error('Cannot replace while an Automerge command is applying');
    if (this.#owner.replace === undefined) throw new Error('This Automerge document owner does not support replace');
    this.#install(this.#owner.replace(doc), 'replace');
    return this.snapshot();
  }

  close(): void {
    if (this.#closed) return;
    if (this.#applying) throw new Error('Cannot close while an Automerge command is applying');
    this.#closed = true;
    this.#unsubscribeOwner();
    this.#owner.close();
    this.#listeners.clear();
  }

  async #commit(input: {
    readonly operationEpoch: string;
    readonly operationId: string;
    readonly intentHash: `sha256:${string}`;
    readonly expectedBasis: AutomergeBasis;
    readonly commands: readonly AutomergeSourceCommand<T>[];
    readonly message?: string;
  }): Promise<AutomergeSourceCommitResult> {
    if (this.#closed) return this.#rejected(input, undefined, [{ code: 'source.closed', phase: 'commit', sourceId: this.sourceId, operationId: input.operationId }]);
    if (this.#retiredEpochs.has(input.operationEpoch)) return this.#rejected(input, undefined, [{ code: 'transaction.operation_epoch_expired', phase: 'commit', sourceId: this.sourceId, operationId: input.operationId }]);
    const key = ledgerKey(input.operationEpoch, input.operationId);
    const known = this.#ledger.get(key);
    if (known !== undefined) {
      if (known.intentHash === input.intentHash) return known.result;
      return this.#rejected(input, undefined, [{
        code: 'transaction.operation_id_ambiguous',
        phase: 'commit',
        sourceId: this.sourceId,
        operationId: input.operationId
      }]);
    }

    const current = this.#owner.current();
    this.#install(current, 'handle');
    const beforeBasis = automergeBasis(current);
    if (!exactAutomergeBasisEqual(beforeBasis, input.expectedBasis)) {
      const rejected = this.#rejected(input, beforeBasis, [{
        code: 'transaction.expected_basis_stale',
        phase: 'commit',
        sourceId: this.sourceId,
        operationId: input.operationId,
        details: { expectedBasis: input.expectedBasis, actualBasis: beforeBasis }
      }]);
      this.#ledger.set(key, { intentHash: input.intentHash, result: rejected });
      return rejected;
    }

    let staged: Automerge.Doc<T> | undefined;
    let failure: unknown;
    this.#applying = true;
    try {
      staged = input.commands.length === 0
        ? current
        : this.#owner.changeAt(beforeBasis, input.commands, input.message ?? 'tarstate source commit');
    } catch (error) {
      failure = error;
    } finally {
      this.#applying = false;
    }

    if (failure !== undefined || staged === undefined) {
      const actual = failure instanceof StaleOwnerBasis ? failure.storage : this.#owner.current();
      const actualBasis = automergeBasis(actual);
      const stale = failure instanceof StaleOwnerBasis;
      const rejected = this.#rejected(input, stale ? actualBasis : beforeBasis, [{
        code: stale ? 'transaction.expected_basis_stale' : 'automerge.command_failed',
        phase: 'commit',
        sourceId: this.sourceId,
        operationId: input.operationId,
        details: stale
          ? { expectedBasis: input.expectedBasis, actualBasis }
          : { message: failure instanceof Error ? failure.message : String(failure) }
      }]);
      this.#ledger.set(key, { intentHash: input.intentHash, result: rejected });
      this.#install(actual, 'handle');
      return rejected;
    }

    const afterBasis = automergeBasis(staged);
    const changed = !exactAutomergeBasisEqual(beforeBasis, afterBasis);
    const committed: AutomergeSourceCommitResult = {
      kind: 'source-commit',
      outcome: 'committed',
      operationEpoch: input.operationEpoch,
      operationId: input.operationId,
      intentHash: input.intentHash,
      beforeBasis,
      afterBasis,
      changed,
      durability: 'local',
      issues: []
    };
    this.#ledger.set(key, { intentHash: input.intentHash, result: committed });
    this.#install(staged, 'commit');
    return committed;
  }

  #install(doc: Automerge.Doc<T>, origin: AutomergeSourceChange['origin']): void {
    const beforeBasis = this.#snapshot.basis;
    const afterBasis = automergeBasis(doc);
    if (exactAutomergeBasisEqual(beforeBasis, afterBasis)) return;
    this.#snapshot = automergeSnapshot(this.sourceId, afterBasis, doc);
    this.#notify({ beforeBasis, afterBasis, origin });
  }

  #rejected(
    input: { readonly operationEpoch: string; readonly operationId: string; readonly intentHash: `sha256:${string}` },
    beforeBasis: AutomergeBasis | undefined,
    issues: readonly AutomergeSourceIssue[]
  ): AutomergeSourceCommitResult {
    return {
      kind: 'source-commit',
      outcome: 'rejected',
      operationEpoch: input.operationEpoch,
      operationId: input.operationId,
      intentHash: input.intentHash,
      ...(beforeBasis === undefined ? {} : { beforeBasis, afterBasis: beforeBasis }),
      changed: false,
      durability: 'local',
      issues
    };
  }

  #notify(change: AutomergeSourceChange): void {
    for (const listener of Array.from(this.#listeners)) {
      try { listener(change); } catch { /* committed source state cannot depend on observers */ }
    }
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error('Automerge source runtime is closed');
  }
}

/**
 * Runtime operations shared by memory-owned and Repo-owned Automerge sources.
 * Document replacement and merging remain capabilities of the memory runtime,
 * rather than being implied for every document owner.
 */
export type AutomergeSourceRuntimeApi<T extends object> = Omit<
  AutomergeSourceRuntime<T>,
  'merge' | 'replace'
>;

const ledgerKey = (operationEpoch: string, operationId: string): string => operationEpoch + '\u0000' + operationId;

const memoryDocumentOwner = <T extends object>(initial: Automerge.Doc<T>): DocumentOwner<T> => {
  let doc = initial;
  return {
    current: () => doc,
    changeAt: (basis, commands, message) => {
      if (!exactAutomergeBasisEqual(basis, automergeBasis(doc))) throw new StaleOwnerBasis(doc);
      doc = Automerge.change(doc, { message, time: 0 }, (draft) => {
        for (const command of commands) command.apply(draft);
      });
      return doc;
    },
    subscribe: () => () => undefined,
    close: () => undefined,
    merge: (remote) => {
      if (!Automerge.hasHeads(doc, Automerge.getHeads(remote))) doc = Automerge.merge(doc, remote);
      return doc;
    },
    replace: (replacement) => {
      if (!exactAutomergeBasisEqual(automergeBasis(doc), automergeBasis(replacement))) doc = replacement;
      return doc;
    }
  };
};

/**
 * Opens the shared source runtime over a ready, writable Automerge Repo handle.
 * During a synchronous commit, the handle must be written only through this runtime.
 */
export const automergeRepoSourceRuntime = <T extends object, Heads>(options: {
  readonly handle: AutomergeRepoHandle<T, Heads>;
  readonly sourceId?: string;
}): AutomergeSourceRuntimeApi<T> => {
  const { handle } = options;
  const sourceId = options.sourceId ?? handle.url;
  if (sourceId.length === 0) throw new Error('Automerge sourceId must not be empty');
  if (!handle.isReady()) throw new Error('Automerge Repo handle must be ready');
  if (handle.isReadOnly()) throw new Error('Automerge Repo handle must be writable');
  const listeners = new Set<(doc: Automerge.Doc<T>) => void>();
  const handleChanged = ({ doc }: { readonly doc: Automerge.Doc<T> }): void => {
    for (const listener of Array.from(listeners)) listener(doc);
  };
  handle.on('heads-changed', handleChanged);
  const owner: DocumentOwner<T> = {
    current: () => handle.doc(),
    changeAt: (basis, commands, message) => {
      const current = handle.doc();
      if (!exactAutomergeBasisEqual(basis, automergeBasis(current))) throw new StaleOwnerBasis(current);
      const heads = handle.heads();
      handle.changeAt(heads, (draft) => {
        for (const command of commands) command.apply(draft);
      }, { message, time: 0 });
      return handle.doc();
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    close: () => { handle.off('heads-changed', handleChanged); }
  };
  return new AutomergeSourceRuntime({
    sourceId,
    [documentOwner]: owner
  });
};
