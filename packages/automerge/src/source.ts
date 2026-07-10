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
  readonly origin: 'commit' | 'merge' | 'replace';
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
  | { readonly status: 'ambiguous' };

type LedgerEntry = {
  readonly intentHash: `sha256:${string}`;
  readonly result: AutomergeSourceCommitResult;
};

/** Captures the document's current exact-head basis. */
export const automergeBasis = (doc: Automerge.Doc<unknown>): AutomergeBasis => ({
  kind: 'automerge-heads',
  heads: [...Automerge.getHeads(doc)].sort()
});

export const exactAutomergeHeadsEqual = (left: readonly string[], right: readonly string[]): boolean => {
  if (left.length !== right.length) return false;
  const sortedLeft = [...left].sort();
  const sortedRight = [...right].sort();
  return sortedLeft.every((head, index) => head === sortedRight[index]);
};

export const exactAutomergeBasisEqual = (left: AutomergeBasis, right: AutomergeBasis): boolean =>
  left.kind === 'automerge-heads' && right.kind === 'automerge-heads' && exactAutomergeHeadsEqual(left.heads, right.heads);

/**
 * One explicit runtime owns one live Automerge document. It serializes local
 * commits, compares exact head sets, and never claims durable receipt storage.
 */
export class AutomergeSourceRuntime<T extends object> {
  readonly sourceId: string;
  #doc: Automerge.Doc<T>;
  #closed = false;
  #applying = false;
  #queue: Promise<void> = Promise.resolve();
  readonly #listeners = new Set<(change: AutomergeSourceChange) => void>();
  readonly #ledger = new Map<string, LedgerEntry>();

  constructor(options: { readonly sourceId: string; readonly doc: Automerge.Doc<T> }) {
    if (options.sourceId.length === 0) throw new Error('Automerge sourceId must not be empty');
    this.sourceId = options.sourceId;
    this.#doc = options.doc;
  }

  snapshot(): AutomergeSnapshot<T> {
    this.#assertOpen();
    return { sourceId: this.sourceId, basis: automergeBasis(this.#doc), storage: this.#doc };
  }

  view(basis: AutomergeBasis): AutomergeSnapshot<T> {
    this.#assertOpen();
    const storage = Automerge.view(this.#doc, [...basis.heads]);
    return { sourceId: this.sourceId, basis: { kind: 'automerge-heads', heads: [...basis.heads].sort() }, storage };
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
    const entry = this.#ledger.get(ledgerKey(input.operationEpoch, input.operationId));
    if (entry === undefined) return { status: 'not_seen' };
    if (entry.intentHash !== input.intentHash) return { status: 'ambiguous' };
    return { status: 'known', result: entry.result };
  }

  merge(remote: Automerge.Doc<T>): AutomergeSnapshot<T> {
    this.#assertOpen();
    if (this.#applying) throw new Error('Cannot merge while an Automerge command is applying');
    const beforeBasis = automergeBasis(this.#doc);
    const merged = Automerge.merge(this.#doc, remote);
    const afterBasis = automergeBasis(merged);
    this.#doc = merged;
    if (!exactAutomergeBasisEqual(beforeBasis, afterBasis)) this.#notify({ beforeBasis, afterBasis, origin: 'merge' });
    return this.snapshot();
  }

  replace(doc: Automerge.Doc<T>): AutomergeSnapshot<T> {
    this.#assertOpen();
    if (this.#applying) throw new Error('Cannot replace while an Automerge command is applying');
    const beforeBasis = automergeBasis(this.#doc);
    const afterBasis = automergeBasis(doc);
    this.#doc = doc;
    if (!exactAutomergeBasisEqual(beforeBasis, afterBasis)) this.#notify({ beforeBasis, afterBasis, origin: 'replace' });
    return this.snapshot();
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
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

    const beforeBasis = automergeBasis(this.#doc);
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

    let staged: Automerge.Doc<T>;
    this.#applying = true;
    try {
      staged = input.commands.length === 0
        ? this.#doc
        : Automerge.change(this.#doc, { message: input.message ?? 'tarstate source commit', time: 0 }, (draft) => {
            for (const command of input.commands) command.apply(draft);
          });
    } catch (error) {
      const rejected = this.#rejected(input, beforeBasis, [{
        code: 'automerge.command_failed',
        phase: 'commit',
        sourceId: this.sourceId,
        operationId: input.operationId,
        details: { message: error instanceof Error ? error.message : String(error) }
      }]);
      this.#ledger.set(key, { intentHash: input.intentHash, result: rejected });
      return rejected;
    } finally {
      this.#applying = false;
    }

    const afterBasis = automergeBasis(staged);
    const changed = !exactAutomergeBasisEqual(beforeBasis, afterBasis);
    this.#doc = staged;
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
    if (changed) this.#notify({ beforeBasis, afterBasis, origin: 'commit' });
    return committed;
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

const ledgerKey = (operationEpoch: string, operationId: string): string => operationEpoch + '\u0000' + operationId;
