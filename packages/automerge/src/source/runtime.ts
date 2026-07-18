import * as Automerge from '@automerge/automerge';
import { canonicalizeJson, isContentHash, type ContentHash } from '@tarstate/core/artifacts';
import type { GeneratedLogicalKey } from '@tarstate/core/source';
import type { JsonValue } from '@tarstate/core';
import {
  reportAutomergeDiagnostic,
  runAutomergeCleanups,
  type AutomergeSourceDiagnosticReporter
} from './diagnostics.js';
export type { AutomergeSourceDiagnostic, AutomergeSourceDiagnosticReporter } from './diagnostics.js';

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
  readonly generatesKeys?: true;
  readonly apply: (
    draft: Parameters<Automerge.ChangeFn<T>>[0],
    context: AutomergeSourceCommandContext
  ) => void;
};

export type AutomergeSourceCommandContext = {
  readonly recordGeneratedKey: (
    relationId: string,
    token: string,
    key: JsonValue
  ) => void;
};

type AutomergeSourceCommitEvidence = {
  readonly kind: 'source-commit';
  readonly operationEpoch: string;
  readonly operationId: string;
  readonly intentHash: ContentHash;
  readonly durability: 'local';
  readonly generatedKeys: readonly GeneratedLogicalKey[];
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
  readonly intentHash: ContentHash;
  readonly result: AutomergeSourceCommitResult;
};

type AutomergeSourceCommitInput<T extends object> = {
  readonly operationEpoch: string;
  readonly operationId: string;
  readonly intentHash: ContentHash;
  readonly expectedBasis: AutomergeBasis;
  readonly commands: readonly AutomergeSourceCommand<T>[];
  readonly message?: string;
};

type AutomergeReconciledCommitInput<T extends object> = {
  readonly operationEpoch: string;
  readonly operationId: string;
  readonly intentHash: ContentHash;
  readonly expectedBasis: AutomergeBasis;
  readonly candidate: Automerge.Doc<T>;
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
  if (isSorted(left) && isSorted(right)) return left.every((head, index) => head === right[index]);
  const sortedLeft = [...left].sort();
  const sortedRight = [...right].sort();
  return sortedLeft.every((head, index) => head === sortedRight[index]);
};

const isSorted = (values: readonly string[]): boolean => {
  for (let index = 1; index < values.length; index += 1) {
    if ((values[index - 1] as string) > (values[index] as string)) return false;
  }
  return true;
};

export const exactAutomergeBasisEqual = (left: AutomergeBasis, right: AutomergeBasis): boolean =>
  left.kind === 'automerge-heads' && right.kind === 'automerge-heads' && exactAutomergeHeadsEqual(left.heads, right.heads);

/** Minimal Automerge Repo handle surface consumed by the source runtime. */
export type AutomergeRepoHandle<T extends object, Heads = unknown> = {
  readonly url: string;
  isReady(): boolean;
  isReadOnly(): boolean;
  doc(): Automerge.Doc<T> | undefined;
  heads(): Heads;
  changeAt(heads: Heads, change: Automerge.ChangeFn<T>, options?: Automerge.ChangeOptions<T>): Heads | undefined;
  update(change: (doc: Automerge.Doc<T>) => Automerge.Doc<T>): void;
  on(event: 'heads-changed', listener: (payload: { readonly doc: Automerge.Doc<T> }) => void): unknown;
  off(event: 'heads-changed', listener: (payload: { readonly doc: Automerge.Doc<T> }) => void): unknown;
};

type DocumentOwner<T extends object> = {
  current(): Automerge.Doc<T>;
  changeAt(
    expectedBasis: AutomergeBasis,
    commands: readonly AutomergeSourceCommand<T>[],
    message: string,
  ): { readonly storage: Automerge.Doc<T>; readonly generatedKeys: readonly GeneratedLogicalKey[] };
  installCandidate(expectedBasis: AutomergeBasis, candidate: Automerge.Doc<T>): Automerge.Doc<T>;
  subscribe(listener: (doc: Automerge.Doc<T>) => void): () => void;
  close(): void;
  merge?(remote: Automerge.Doc<T>): Automerge.Doc<T>;
  replace?(doc: Automerge.Doc<T>): Automerge.Doc<T>;
};

const documentOwner = Symbol('AutomergeSourceRuntime.documentOwner');
type AutomergeSourceRuntimeOptions<T extends object> =
  | ({ readonly sourceId: string; readonly doc: Automerge.Doc<T> } & AutomergeRuntimeLedgerOptions)
  | ({ readonly sourceId: string; readonly [documentOwner]: DocumentOwner<T> } & AutomergeRuntimeLedgerOptions);

type AutomergeRuntimeLedgerOptions = {
  readonly onDiagnostic?: AutomergeSourceDiagnosticReporter;
  readonly maxOperationEpochs?: number;
  readonly maxOperationReceiptsPerEpoch?: number;
  readonly maxRetiredOperationEpochs?: number;
};

class StaleOwnerBasis<T extends object> extends Error {
  readonly storage: Automerge.Doc<T>;

  constructor(storage: Automerge.Doc<T>) {
    super('Automerge document owner basis changed');
    this.storage = storage;
  }
}

/**
 * One explicit runtime owns one live Automerge document. It serializes local
 * commits, compares exact head sets, and never claims durable receipt storage.
 */
export class AutomergeSourceRuntime<T extends object> {
  readonly sourceId: string;
  readonly #owner: DocumentOwner<T>;
  readonly #onDiagnostic: AutomergeSourceDiagnosticReporter | undefined;
  readonly #unsubscribeOwner: () => void;
  #snapshot: AutomergeSnapshot<T>;
  #closed = false;
  #applying = false;
  #queue: Promise<void> = Promise.resolve();
  readonly #listeners = new Set<(change: AutomergeSourceChange) => void>();
  readonly #ledger = new Map<string, Map<string, LedgerEntry>>();
  readonly #retiredEpochs = new Set<string>();
  readonly #maxOperationEpochs: number;
  readonly #maxOperationReceiptsPerEpoch: number;
  readonly #maxRetiredOperationEpochs: number;

  constructor(options: AutomergeSourceRuntimeOptions<T>) {
    if (options.sourceId.length === 0) throw new Error('Automerge sourceId must not be empty');
    this.sourceId = options.sourceId;
    this.#onDiagnostic = options.onDiagnostic;
    this.#maxOperationEpochs = positiveSafeInteger(options.maxOperationEpochs ?? 64, 'Automerge maxOperationEpochs');
    this.#maxOperationReceiptsPerEpoch = positiveSafeInteger(options.maxOperationReceiptsPerEpoch ?? 65_536, 'Automerge maxOperationReceiptsPerEpoch');
    this.#maxRetiredOperationEpochs = positiveSafeInteger(options.maxRetiredOperationEpochs ?? 4_096, 'Automerge maxRetiredOperationEpochs');
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

  commit(input: AutomergeSourceCommitInput<T>): Promise<AutomergeSourceCommitResult> {
    const owned = adoptCommitInput<T>(input);
    return this.#enqueueCommit(owned);
  }

  commitReconciled(input: AutomergeReconciledCommitInput<T>): Promise<AutomergeSourceCommitResult> {
    const owned = adoptReconciledCommitInput(input);
    return this.#enqueueCommit(owned);
  }

  #enqueueCommit(
    owned: AutomergeSourceCommitInput<T> | AutomergeReconciledCommitInput<T>
  ): Promise<AutomergeSourceCommitResult> {
    if (this.#closed) return Promise.resolve(this.#rejected(owned, undefined, [{ code: 'source.closed', phase: 'commit', sourceId: this.sourceId, operationId: owned.operationId }]));
    if (this.#applying) {
      return Promise.resolve(this.#rejected(owned, undefined, [{
        code: 'automerge.reentrant_commit',
        phase: 'commit',
        sourceId: this.sourceId,
        operationId: owned.operationId
      }]));
    }
    const result = this.#queue.then(() => this.#commit(owned));
    this.#queue = result.then(() => undefined, () => undefined);
    return result;
  }

  queryOutcome(input: {
    readonly operationEpoch: string;
    readonly operationId: string;
    readonly intentHash: ContentHash;
  }): AutomergeSourceOutcomeLookup {
    const identity = adoptOperationIdentity(input, 'Automerge outcome query');
    if (this.#retiredEpochs.has(identity.operationEpoch)) return Object.freeze({ status: 'expired' });
    const entry = this.#ledger.get(identity.operationEpoch)?.get(identity.operationId);
    if (entry === undefined) return Object.freeze({ status: 'not_seen' });
    if (entry.intentHash !== identity.intentHash) return Object.freeze({ status: 'ambiguous' });
    return Object.freeze({ status: 'known', result: entry.result });
  }

  /** Retires one application-owned operation epoch after its in-flight work. */
  retireOperationEpoch(operationEpoch: string): Promise<void> {
    let ownedOperationEpoch: string;
    try {
      ownedOperationEpoch = adoptIdentifier(operationEpoch, 'Automerge operationEpoch');
    } catch (error) {
      return Promise.reject(error);
    }
    const result = this.#queue.then(() => {
      if (!this.#retiredEpochs.has(ownedOperationEpoch) && this.#retiredEpochs.size >= this.#maxRetiredOperationEpochs) {
        throw new RangeError('Automerge retired operation-epoch capacity exhausted; replace the runtime');
      }
      this.#retiredEpochs.add(ownedOperationEpoch);
      this.#ledger.delete(ownedOperationEpoch);
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
    this.#listeners.clear();
    runAutomergeCleanups([
      { operation: 'close.unsubscribe-owner', cleanup: this.#unsubscribeOwner },
      { operation: 'close.owner', cleanup: () => this.#owner.close() }
    ], 'source-runtime', this.#onDiagnostic);
  }

  async #commit(
    input: AutomergeSourceCommitInput<T> | AutomergeReconciledCommitInput<T>
  ): Promise<AutomergeSourceCommitResult> {
    if (this.#closed) return this.#rejected(input, undefined, [{ code: 'source.closed', phase: 'commit', sourceId: this.sourceId, operationId: input.operationId }]);
    if (this.#retiredEpochs.has(input.operationEpoch)) return this.#rejected(input, undefined, [{ code: 'transaction.operation_epoch_expired', phase: 'commit', sourceId: this.sourceId, operationId: input.operationId }]);
    const known = this.#ledger.get(input.operationEpoch)?.get(input.operationId);
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
    const expectedBasis = input.expectedBasis;
    if (!exactAutomergeBasisEqual(beforeBasis, expectedBasis)) {
      const rejected = this.#rejected(input, beforeBasis, [{
        code: 'transaction.expected_basis_stale',
        phase: 'commit',
        sourceId: this.sourceId,
        operationId: input.operationId,
        details: { expectedBasis, actualBasis: beforeBasis }
      }]);
      return rejected;
    }
    const epochLedger = this.#ledger.get(input.operationEpoch);
    if ((epochLedger === undefined && this.#ledger.size >= this.#maxOperationEpochs)
      || (epochLedger?.size ?? 0) >= this.#maxOperationReceiptsPerEpoch) {
      return this.#rejected(input, undefined, [{
        code: 'operation.ledger_capacity_exhausted',
        phase: 'commit',
        sourceId: this.sourceId,
        operationId: input.operationId,
        details: { action: 'retire_operation_epoch' }
      }]);
    }

    let applied: { readonly storage: Automerge.Doc<T>; readonly generatedKeys: readonly GeneratedLogicalKey[] } | undefined;
    let failure: unknown;
    this.#applying = true;
    try {
      if ('candidate' in input) {
        applied = {
          storage: this.#owner.installCandidate(beforeBasis, input.candidate),
          generatedKeys: emptyGeneratedKeys
        };
      } else {
        applied = input.commands.length === 0
          ? { storage: current, generatedKeys: emptyGeneratedKeys }
          : this.#owner.changeAt(
              beforeBasis,
              input.commands,
              input.message ?? 'tarstate source commit'
            );
      }
    } catch (error) {
      failure = error;
    } finally {
      this.#applying = false;
    }

    if (failure !== undefined || applied === undefined) {
      const actual = failure instanceof StaleOwnerBasis ? failure.storage : this.#owner.current();
      const actualBasis = automergeBasis(actual);
      const stale = failure instanceof StaleOwnerBasis;
      const rejected = this.#rejected(input, stale ? actualBasis : beforeBasis, [{
        code: stale ? 'transaction.expected_basis_stale' : 'automerge.command_failed',
        phase: 'commit',
        sourceId: this.sourceId,
        operationId: input.operationId,
        details: stale
          ? { expectedBasis, actualBasis }
          : { message: failure instanceof Error ? failure.message : String(failure) }
      }]);
      if (!stale) this.#retainOutcome(input, rejected);
      this.#install(actual, 'handle');
      return rejected;
    }

    const afterBasis = automergeBasis(applied.storage);
    const changed = !exactAutomergeBasisEqual(beforeBasis, afterBasis);
    const committed = ownCommitResult({
      kind: 'source-commit',
      outcome: 'committed',
      operationEpoch: input.operationEpoch,
      operationId: input.operationId,
      intentHash: input.intentHash,
      beforeBasis,
      afterBasis,
      changed,
      durability: 'local',
      generatedKeys: applied.generatedKeys,
      issues: []
    });
    this.#retainOutcome(input, committed);
    this.#install(applied.storage, 'commit');
    return committed;
  }

  #install(doc: Automerge.Doc<T>, origin: AutomergeSourceChange['origin']): void {
    const beforeBasis = this.#snapshot.basis;
    const afterBasis = automergeBasis(doc);
    if (exactAutomergeBasisEqual(beforeBasis, afterBasis)) return;
    this.#snapshot = automergeSnapshot(this.sourceId, afterBasis, doc);
    this.#notify({ beforeBasis, afterBasis, origin });
  }

  #retainOutcome(
    identity: OperationIdentity,
    result: AutomergeSourceCommitResult
  ): void {
    let epoch = this.#ledger.get(identity.operationEpoch);
    if (epoch === undefined) {
      epoch = new Map();
      this.#ledger.set(identity.operationEpoch, epoch);
    }
    epoch.set(identity.operationId, { intentHash: identity.intentHash, result });
  }

  #rejected(
    input: { readonly operationEpoch: string; readonly operationId: string; readonly intentHash: ContentHash },
    beforeBasis: AutomergeBasis | undefined,
    issues: readonly AutomergeSourceIssue[]
  ): AutomergeSourceCommitResult {
    return ownCommitResult({
      kind: 'source-commit',
      outcome: 'rejected',
      operationEpoch: input.operationEpoch,
      operationId: input.operationId,
      intentHash: input.intentHash,
      ...(beforeBasis === undefined ? {} : { beforeBasis, afterBasis: beforeBasis }),
      changed: false,
      durability: 'local',
      generatedKeys: emptyGeneratedKeys,
      issues
    });
  }

  #notify(change: AutomergeSourceChange): void {
    for (const listener of Array.from(this.#listeners)) {
      try {
        listener(change);
      } catch (error) {
        reportAutomergeDiagnostic(this.#onDiagnostic, {
          kind: 'listener_error', component: 'source-runtime', operation: 'publish', error
        });
      }
    }
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error('Automerge source runtime is closed');
  }
}

const ownCommitResult = (result: AutomergeSourceCommitResult): AutomergeSourceCommitResult =>
  cloneAndFreezeEvidence(result) as AutomergeSourceCommitResult;

type DataDescriptors = Readonly<Record<string, PropertyDescriptor>>;
const automergeHeadPattern = /^[0-9a-f]{64}$/;

const inspectCommitRecord = (input: unknown, label: string): DataDescriptors => {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) throw new TypeError(label + ' must be a record');
  return Object.getOwnPropertyDescriptors(input);
};

const commitDataValue = (descriptors: DataDescriptors, key: string, label: string): unknown => {
  const descriptor = descriptors[key];
  if (descriptor === undefined) return undefined;
  if (!descriptor.enumerable || !('value' in descriptor)) throw new TypeError(label + ' ' + key + ' has a hostile property descriptor');
  return descriptor.value;
};

const requiredCommitDataValue = (descriptors: DataDescriptors, key: string, label: string): unknown => {
  if (descriptors[key] === undefined) throw new TypeError(label + ' must have an enumerable data property ' + key);
  return commitDataValue(descriptors, key, label);
};

const inspectCommitArray = (input: unknown, label: string): readonly unknown[] => {
  if (!Array.isArray(input)) throw new TypeError(label + ' must be an array');
  const descriptors = Object.getOwnPropertyDescriptors(input) as DataDescriptors;
  const length = descriptors.length?.value;
  if (typeof length !== 'number' || !Number.isSafeInteger(length) || length < 0) throw new TypeError(label + ' has a hostile length');
  const output: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) throw new TypeError(label + ' has a hostile property descriptor');
    output.push(descriptor.value);
  }
  return output;
};

const ownBasisEvidence = (input: AutomergeBasis): AutomergeBasis => {
  const descriptors = inspectCommitRecord(input, 'Automerge expectedBasis');
  const kind = requiredCommitDataValue(descriptors, 'kind', 'Automerge expectedBasis');
  if (kind !== 'automerge-heads') throw new TypeError('Automerge expectedBasis kind must be automerge-heads');
  const heads = inspectCommitArray(requiredCommitDataValue(descriptors, 'heads', 'Automerge expectedBasis'), 'Automerge expectedBasis heads');
  if (heads.some((head) => typeof head !== 'string' || !automergeHeadPattern.test(head))) {
    throw new TypeError('Automerge expectedBasis heads must be canonical Automerge hashes');
  }
  if (new Set(heads).size !== heads.length) throw new TypeError('Automerge expectedBasis heads must be unique');
  return Object.freeze({
    kind,
    heads: Object.freeze((heads as string[]).sort())
  });
};

type OperationIdentity = {
  readonly operationEpoch: string;
  readonly operationId: string;
  readonly intentHash: ContentHash;
};

const adoptIdentifier = (input: unknown, label: string): string => {
  if (typeof input !== 'string' || input.length === 0) throw new TypeError(label + ' must be a non-empty string');
  try {
    canonicalizeJson(input);
  } catch {
    throw new TypeError(label + ' must contain only Unicode scalar values');
  }
  return input;
};

const adoptOperationIdentity = (input: unknown, label: string): OperationIdentity => {
  const descriptors = inspectCommitRecord(input, label);
  return adoptOperationIdentityDescriptors(descriptors, label);
};

const adoptOperationIdentityDescriptors = (descriptors: DataDescriptors, label: string): OperationIdentity => {
  const operationEpoch = adoptIdentifier(requiredCommitDataValue(descriptors, 'operationEpoch', label), label + ' operationEpoch');
  const operationId = adoptIdentifier(requiredCommitDataValue(descriptors, 'operationId', label), label + ' operationId');
  const intentHash = requiredCommitDataValue(descriptors, 'intentHash', label);
  if (!isContentHash(intentHash)) throw new TypeError(label + ' intentHash must be a canonical SHA-256 content hash');
  return Object.freeze({ operationEpoch, operationId, intentHash });
};

const adoptCommitInput = <T extends object>(input: AutomergeSourceCommitInput<T>): AutomergeSourceCommitInput<T> => {
  const descriptors = inspectCommitRecord(input, 'Automerge commit input');
  const identity = adoptOperationIdentityDescriptors(descriptors, 'Automerge commit input');
  const commands = inspectCommitArray(requiredCommitDataValue(descriptors, 'commands', 'Automerge commit input'), 'Automerge commit commands')
    .map((command, index): AutomergeSourceCommand<T> => {
      const commandDescriptors = inspectCommitRecord(command, 'Automerge commit command ' + String(index));
      const description = commitDataValue(commandDescriptors, 'description', 'Automerge commit command ' + String(index));
      const generatesKeys = commitDataValue(commandDescriptors, 'generatesKeys', 'Automerge commit command ' + String(index));
      const apply = requiredCommitDataValue(commandDescriptors, 'apply', 'Automerge commit command ' + String(index));
      if (description !== undefined && typeof description !== 'string') throw new TypeError('Automerge commit command description must be a string');
      if (generatesKeys !== undefined && generatesKeys !== true) throw new TypeError('Automerge commit command generatesKeys must be true');
      if (typeof apply !== 'function') throw new TypeError('Automerge commit command apply must be a function');
      return Object.freeze({
        ...(description === undefined ? {} : { description: description as string }),
        ...(generatesKeys === undefined ? {} : { generatesKeys: true as const }),
        apply: apply as AutomergeSourceCommand<T>['apply']
      });
    });
  const message = commitDataValue(descriptors, 'message', 'Automerge commit input');
  if (message !== undefined && typeof message !== 'string') throw new TypeError('Automerge commit input message must be a string');
  return Object.freeze({
    ...identity,
    expectedBasis: ownBasisEvidence(requiredCommitDataValue(descriptors, 'expectedBasis', 'Automerge commit input') as AutomergeBasis),
    commands: Object.freeze(commands),
    ...(message === undefined ? {} : { message: message as string })
  });
};

const adoptReconciledCommitInput = <T extends object>(
  input: AutomergeReconciledCommitInput<T>
): AutomergeReconciledCommitInput<T> => {
  const descriptors = inspectCommitRecord(input, 'Automerge reconciled commit input');
  const identity = adoptOperationIdentityDescriptors(descriptors, 'Automerge reconciled commit input');
  const candidate = requiredCommitDataValue(
    descriptors,
    'candidate',
    'Automerge reconciled commit input'
  );
  try {
    Automerge.getHeads(candidate as Automerge.Doc<T>);
  } catch {
    throw new TypeError('Automerge reconciled commit candidate must be an Automerge document');
  }
  return Object.freeze({
    ...identity,
    expectedBasis: ownBasisEvidence(requiredCommitDataValue(
      descriptors,
      'expectedBasis',
      'Automerge reconciled commit input'
    ) as AutomergeBasis),
    candidate: candidate as Automerge.Doc<T>
  });
};

const cloneAndFreezeEvidence = (value: unknown, seen = new WeakMap<object, object>()): unknown => {
  if (value === null || typeof value !== 'object') return value;
  const existing = seen.get(value);
  if (existing !== undefined) return existing;
  const descriptors = Object.getOwnPropertyDescriptors(value) as DataDescriptors;
  if (Array.isArray(value)) {
    const length = descriptors.length?.value;
    if (typeof length !== 'number' || !Number.isSafeInteger(length) || length < 0) throw new TypeError('Automerge commit evidence has a hostile array length');
    const output: unknown[] = [];
    seen.set(value, output);
    for (let index = 0; index < length; index += 1) {
      const descriptor = descriptors[String(index)];
      if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) throw new TypeError('Automerge commit evidence has a hostile array descriptor');
      output.push(cloneAndFreezeEvidence(descriptor.value, seen));
    }
    return Object.freeze(output);
  }
  if (Object.getPrototypeOf(value) !== Object.prototype) throw new TypeError('Automerge commit evidence must contain only plain records');
  const output: Record<string, unknown> = {};
  seen.set(value, output);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== 'string') throw new TypeError('Automerge commit evidence contains a symbol key');
    const descriptor = descriptors[key];
    if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) throw new TypeError('Automerge commit evidence has a hostile object descriptor');
    Object.defineProperty(output, key, {
      value: cloneAndFreezeEvidence(descriptor.value, seen),
      enumerable: true,
      configurable: true,
      writable: true
    });
  }
  return Object.freeze(output);
};

/**
 * Runtime operations shared by memory-owned and Repo-owned Automerge sources.
 * Document replacement and merging remain capabilities of the memory runtime,
 * rather than being implied for every document owner.
 */
export type AutomergeSourceRuntimeApi<T extends object> = Omit<
  AutomergeSourceRuntime<T>,
  'merge' | 'replace'
>;

const memoryDocumentOwner = <T extends object>(initial: Automerge.Doc<T>): DocumentOwner<T> => {
  let doc = initial;
  return {
    current: () => doc,
    changeAt: (expectedBasis, commands, message) => {
      if (!exactAutomergeBasisEqual(expectedBasis, automergeBasis(doc))) throw new StaleOwnerBasis(doc);
      let generatedKeys = emptyGeneratedKeys;
      doc = Automerge.change(doc, { message, time: 0 }, (draft) => {
        generatedKeys = applySourceCommands(commands, draft);
      });
      return { storage: doc, generatedKeys };
    },
    installCandidate: (expectedBasis, candidate) => {
      if (!exactAutomergeBasisEqual(expectedBasis, automergeBasis(doc))) throw new StaleOwnerBasis(doc);
      if (!Automerge.hasHeads(candidate, [...expectedBasis.heads])) {
        throw new Error('Reconciled Automerge candidate does not include the integration basis');
      }
      doc = candidate;
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
  readonly onDiagnostic?: AutomergeSourceDiagnosticReporter;
  readonly maxOperationEpochs?: number;
  readonly maxOperationReceiptsPerEpoch?: number;
  readonly maxRetiredOperationEpochs?: number;
}): AutomergeSourceRuntimeApi<T> => {
  const { handle } = options;
  const sourceId = options.sourceId ?? handle.url;
  if (sourceId.length === 0) throw new Error('Automerge sourceId must not be empty');
  if (!handle.isReady()) throw new Error('Automerge Repo handle must be ready');
  if (handle.isReadOnly()) throw new Error('Automerge Repo handle must be writable');
  const listeners = new Set<(doc: Automerge.Doc<T>) => void>();
  const currentDocument = (): Automerge.Doc<T> => {
    const document = handle.doc();
    if (document === undefined) throw new Error('Automerge Repo handle document is unavailable');
    return document;
  };
  const handleChanged = ({ doc }: { readonly doc: Automerge.Doc<T> }): void => {
    for (const listener of Array.from(listeners)) {
      try {
        listener(doc);
      } catch (error) {
        reportAutomergeDiagnostic(options.onDiagnostic, {
          kind: 'listener_error',
          component: 'source-runtime',
          operation: 'repo-owner.publish',
          error
        });
      }
    }
  };
  handle.on('heads-changed', handleChanged);
  const owner: DocumentOwner<T> = {
    current: currentDocument,
    changeAt: (expectedBasis, commands, message) => {
      const current = currentDocument();
      if (!exactAutomergeBasisEqual(expectedBasis, automergeBasis(current))) throw new StaleOwnerBasis(current);
      let generatedKeys = emptyGeneratedKeys;
      const changedHeads = handle.changeAt(handle.heads(), (draft) => {
        generatedKeys = applySourceCommands(commands, draft);
      }, { message, time: 0 });
      const changed = currentDocument();
      if (changedHeads === undefined) throw new StaleOwnerBasis(changed);
      return { storage: changed, generatedKeys };
    },
    installCandidate: (expectedBasis, candidate) => {
      handle.update((current) => {
        if (!exactAutomergeBasisEqual(expectedBasis, automergeBasis(current))) {
          throw new StaleOwnerBasis(current);
        }
        if (!Automerge.hasHeads(candidate, [...expectedBasis.heads])) {
          throw new Error('Reconciled Automerge candidate does not include the integration basis');
        }
        return candidate;
      });
      return currentDocument();
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    close: () => { handle.off('heads-changed', handleChanged); }
  };
  try {
    return new AutomergeSourceRuntime({
      sourceId,
      ...(options.onDiagnostic === undefined ? {} : { onDiagnostic: options.onDiagnostic }),
      ...(options.maxOperationEpochs === undefined ? {} : { maxOperationEpochs: options.maxOperationEpochs }),
      ...(options.maxOperationReceiptsPerEpoch === undefined ? {} : { maxOperationReceiptsPerEpoch: options.maxOperationReceiptsPerEpoch }),
      ...(options.maxRetiredOperationEpochs === undefined ? {} : { maxRetiredOperationEpochs: options.maxRetiredOperationEpochs }),
      [documentOwner]: owner
    });
  } catch (error) {
    try { handle.off('heads-changed', handleChanged); } catch { /* preserve the construction failure */ }
    throw error;
  }
};

export const applySourceCommands = <T extends object>(
  commands: readonly AutomergeSourceCommand<T>[],
  draft: Parameters<Automerge.ChangeFn<T>>[0]
): readonly GeneratedLogicalKey[] => {
  if (!commands.some(({ generatesKeys }) => generatesKeys === true)) {
    for (const command of commands) command.apply(draft, noGeneratedKeyContext);
    return emptyGeneratedKeys;
  }
  const generatedKeys: GeneratedLogicalKey[] = [];
  const tokens = new Set<string>();
  const context: AutomergeSourceCommandContext = {
    recordGeneratedKey: (relationId, token, key) => {
      if (typeof relationId !== 'string'
        || typeof token !== 'string'
        || relationId.length === 0
        || token.length === 0) {
        throw new TypeError('Generated logical key relation and token must not be empty');
      }
      if (tokens.has(token)) throw new TypeError('Generated logical key token must be unique per operation');
      canonicalizeJson(relationId);
      canonicalizeJson(token);
      canonicalizeJson(key);
      tokens.add(token);
      generatedKeys.push(Object.freeze({
        relationId,
        token,
        key: cloneAndFreezeEvidence(key) as JsonValue
      }));
    }
  };
  for (const command of commands) command.apply(draft, context);
  return Object.freeze(generatedKeys);
};

const emptyGeneratedKeys: readonly GeneratedLogicalKey[] = Object.freeze([]);
const noGeneratedKeyContext: AutomergeSourceCommandContext = Object.freeze({
  recordGeneratedKey: () => {
    throw new TypeError('Automerge command must declare generatesKeys before recording generated keys');
  }
});

const positiveSafeInteger = (value: number, label: string): number => {
  if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(label + ' must be a positive safe integer');
  return value;
};
