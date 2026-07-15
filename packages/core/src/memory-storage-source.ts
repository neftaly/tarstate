import { canonicalizeJson, type ContentHash } from './artifacts.js';
import { createIssue, type Issue } from './issues.js';
import type { MemoryRow, MemoryState } from './memory-source.js';
import type { SourceBasis } from './maintenance.js';
import type { SourceSnapshot } from './database.js';
import type {
  AtomicSource,
  Footprint,
  FootprintRelation,
  IntentMergeResult,
  LogicalEdit,
  PlanResult,
  ProjectionResult,
  SourceCommitInput,
  SourceCommitResult,
  SourceOutcomeLookup,
  StorageBinding
} from './source-protocol.js';
import type { WritableLogicalRow } from './transaction-executor.js';
import type { JsonValue } from './value.js';

export type LogicalMemoryBasis = { readonly incarnation: string; readonly revision: number };

export type LogicalMemoryCommand = {
  readonly description: string;
  readonly apply: (state: MemoryState) => MemoryState;
};

export type LogicalMemoryRelation = {
  readonly relationId: string;
  readonly keyFields: readonly string[];
};

type LedgerEntry = {
  readonly intentHash: ContentHash;
  readonly result: SourceCommitResult;
};

/** Small generic AtomicSource proving adapter over immutable logical rows. */
export class LogicalMemoryAtomicSource implements AtomicSource<MemoryState, LogicalMemoryCommand> {
  readonly sourceId: string;
  readonly operationEpoch: string;
  readonly #incarnation: string;
  readonly #listeners = new Set<(change?: { readonly beforeBasis?: SourceBasis; readonly afterBasis: SourceBasis }) => void>();
  readonly #ledger = new Map<string, LedgerEntry>();
  #state: MemoryState;
  #revision = 0;
  #closed = false;

  constructor(options: {
    readonly sourceId: string;
    readonly incarnation: string;
    readonly operationEpoch: string;
    readonly state: MemoryState;
  }) {
    if (options.sourceId.length === 0 || options.incarnation.length === 0 || options.operationEpoch.length === 0) throw new TypeError('Logical memory source identifiers must not be empty');
    this.sourceId = options.sourceId;
    this.#incarnation = options.incarnation;
    this.operationEpoch = options.operationEpoch;
    this.#state = ownState(options.state);
  }

  snapshot = () => this.#closed
    ? Object.freeze({ sourceId: this.sourceId, operationEpoch: this.operationEpoch, basis: this.#basis(), state: 'closed' as const, freshness: 'none' as const, issues: Object.freeze([createIssue({ code: 'source.closed', sourceId: this.sourceId })]) })
    : Object.freeze({ sourceId: this.sourceId, operationEpoch: this.operationEpoch, basis: this.#basis(), state: 'ready' as const, freshness: 'current' as const, storage: this.#state, issues: Object.freeze([]) });

  subscribe = (listener: (change?: { readonly beforeBasis?: SourceBasis; readonly afterBasis: SourceBasis }) => void): (() => void) => {
    if (this.#closed) return () => undefined;
    this.#listeners.add(listener);
    return () => { this.#listeners.delete(listener); };
  };

  commit = async (input: SourceCommitInput<LogicalMemoryCommand>): Promise<SourceCommitResult> => {
    if (this.#closed) return { outcome: 'rejected', issues: [createIssue({ code: 'source.closed', sourceId: this.sourceId })] };
    if (input.operationEpoch !== this.operationEpoch) return { outcome: 'rejected', issues: [createIssue({ code: 'transaction.operation_epoch_expired', operationId: input.operationId, sourceId: this.sourceId })] };
    const ledgerKey = input.operationEpoch + '\u0000' + input.operationId;
    const prior = this.#ledger.get(ledgerKey);
    if (prior !== undefined) {
      return prior.intentHash === input.intentHash
        ? prior.result
        : { outcome: 'rejected', issues: [createIssue({ code: 'transaction.operation_id_ambiguous', operationId: input.operationId, sourceId: this.sourceId })] };
    }
    const beforeBasis = this.#basis();
    if (!samePortable(input.expectedBasis, beforeBasis)) {
      return { outcome: 'rejected', beforeBasis, issues: [createIssue({ code: 'transaction.expected_basis_stale', operationId: input.operationId, sourceId: this.sourceId, details: { expected: input.expectedBasis, actual: beforeBasis } })] };
    }
    const staged = this.stage(this.snapshot(), input.commands);
    if (staged.issues.some(({ severity }) => severity === 'error')) return { outcome: 'rejected', beforeBasis, issues: staged.issues };
    const changed = !samePortable(this.#state, staged.storage);
    if (changed) {
      this.#state = staged.storage;
      this.#revision += 1;
    }
    const result: SourceCommitResult = { outcome: 'committed', beforeBasis, afterBasis: this.#basis(), issues: staged.issues };
    this.#ledger.set(ledgerKey, { intentHash: input.intentHash, result });
    if (changed) for (const listener of this.#listeners) listener({ beforeBasis, afterBasis: this.#basis() });
    return result;
  };

  relateFootprints = relateLogicalMemoryFootprints;

  mergeIntents = (plans: readonly PlanResult<LogicalMemoryCommand>[]): IntentMergeResult<LogicalMemoryCommand> => {
    const intents = plans.flatMap(({ intents }) => intents);
    for (let leftIndex = 0; leftIndex < intents.length; leftIndex += 1) {
      for (let rightIndex = leftIndex + 1; rightIndex < intents.length; rightIndex += 1) {
        if (this.relateFootprints(intents[leftIndex]!.footprint, intents[rightIndex]!.footprint) !== 'disjoint') {
          return { outcome: 'conflict', issues: [createIssue({ code: 'binding.write_footprint_overlap', sourceId: this.sourceId })] };
        }
      }
    }
    return { outcome: 'merged', commands: intents.map(({ command }) => command) };
  };

  stage = (snapshot: SourceSnapshot<MemoryState>, commands: readonly LogicalMemoryCommand[]): { readonly storage: MemoryState; readonly issues: readonly Issue[] } => {
    if (snapshot.state !== 'ready' || snapshot.storage === undefined) throw new TypeError('Cannot stage a non-ready logical memory snapshot');
    try {
      return { storage: commands.reduce((state, command) => command.apply(state), snapshot.storage), issues: [] };
    } catch (error) {
      return { storage: snapshot.storage, issues: [createIssue({ code: 'binding.stage_failed', sourceId: this.sourceId, details: { error: error instanceof Error ? error.name : typeof error } })] };
    }
  };

  basisForStagedStorage = (snapshot: SourceSnapshot<MemoryState>, stagedStorage: MemoryState): SourceBasis => {
    const basis = snapshot.basis as LogicalMemoryBasis;
    return samePortable(snapshot.storage, stagedStorage)
      ? basis
      : Object.freeze({ incarnation: basis.incarnation, revision: basis.revision + 1 });
  };

  queryOutcome = async (input: { readonly operationEpoch: string; readonly operationId: string; readonly intentHash: ContentHash }): Promise<SourceOutcomeLookup<SourceCommitResult>> => {
    const entry = this.#ledger.get(input.operationEpoch + '\u0000' + input.operationId);
    if (entry === undefined) return { status: 'not_seen' };
    return entry.intentHash === input.intentHash ? { status: 'known', result: entry.result } : { status: 'ambiguous' };
  };

  close(): void {
    this.#closed = true;
    this.#listeners.clear();
  }

  #basis(): LogicalMemoryBasis {
    return Object.freeze({ incarnation: this.#incarnation, revision: this.#revision });
  }
}

/** StorageBinding paired with LogicalMemoryAtomicSource. */
export class LogicalMemoryStorageBinding implements StorageBinding<MemoryState, LogicalMemoryCommand, WritableLogicalRow> {
  readonly id: string;
  readonly declaredReadFootprint: Footprint;
  readonly declaredWriteFootprint: Footprint;
  readonly #relations: ReadonlyMap<string, LogicalMemoryRelation>;

  constructor(options: { readonly id?: string; readonly relations: readonly LogicalMemoryRelation[] }) {
    this.id = options.id ?? 'logical-memory';
    const relations = options.relations.map((relation) => Object.freeze({ relationId: relation.relationId, keyFields: Object.freeze([...relation.keyFields]) }));
    if (new Set(relations.map(({ relationId }) => relationId)).size !== relations.length) throw new TypeError('Logical memory relation IDs must be unique');
    this.#relations = new Map(relations.map((relation) => [relation.relationId, relation]));
    this.declaredReadFootprint = Object.freeze(relations.map(({ relationId }) => relationFootprint(relationId)));
    this.declaredWriteFootprint = this.declaredReadFootprint;
  }

  project = (snapshot: SourceSnapshot<MemoryState>): ProjectionResult<WritableLogicalRow> => {
    if (snapshot.state !== 'ready' || snapshot.storage === undefined) return { rows: [], completeness: 'unknown', issues: [createIssue({ code: 'source.not_ready', sourceId: snapshot.sourceId })] };
    const rows: WritableLogicalRow[] = [];
    const issues: Issue[] = [];
    for (const relation of this.#relations.values()) {
      const candidates = snapshot.storage[relation.relationId] ?? [];
      const seen = new Set<string>();
      for (const fields of candidates) {
        const key = logicalKey(fields, relation.keyFields);
        if (key === undefined) {
          issues.push(createIssue({ code: 'schema.field_missing', sourceId: snapshot.sourceId, relationId: relation.relationId, details: { keyFields: relation.keyFields } }));
          continue;
        }
        const fingerprint = canonicalizeJson(key);
        if (seen.has(fingerprint)) {
          issues.push(createIssue({ code: 'schema.duplicate_key', sourceId: snapshot.sourceId, relationId: relation.relationId, key }));
          continue;
        }
        seen.add(fingerprint);
        rows.push(Object.freeze({ relationId: relation.relationId, key, fields, locator: { namespace: this.id, token: fingerprint } }));
      }
    }
    return { rows, completeness: issues.length === 0 ? 'exact' : 'unknown', issues };
  };

  plan = (snapshot: SourceSnapshot<MemoryState>, edits: readonly LogicalEdit[]): PlanResult<LogicalMemoryCommand> => {
    const handledEdits = edits.flatMap((edit, editIndex) => this.#relations.has(edit.relationId)
      ? [{ editIndex, mode: 'exclusive' as const }]
      : []);
    const relevant = handledEdits.map(({ editIndex }) => edits[editIndex] as LogicalEdit);
    const intents: { readonly footprint: Footprint; readonly command: LogicalMemoryCommand }[] = [];
    const issues: Issue[] = [];
    if (snapshot.state !== 'ready' || snapshot.storage === undefined) return { handledEdits, readFootprint: this.declaredReadFootprint, writeFootprint: [], intents: [], issues: [createIssue({ code: 'source.not_ready', sourceId: snapshot.sourceId })] };
    const projection = this.project(snapshot);
    if (projection.completeness !== 'exact') return { handledEdits, readFootprint: this.declaredReadFootprint, writeFootprint: [], intents: [], issues: projection.issues };
    for (const edit of relevant) {
      const relation = this.#relations.get(edit.relationId) as LogicalMemoryRelation;
      const footprint = rowFootprint(edit.relationId, edit.key);
      if (edit.kind === 'insert') {
        if (projection.rows.some((row) => row.relationId === edit.relationId && samePortable(row.key, edit.key))) {
          issues.push(createIssue({ code: 'transaction.upsert_conflict', sourceId: snapshot.sourceId, relationId: edit.relationId, key: edit.key }));
          continue;
        }
        intents.push({ footprint, command: commandFor(edit.relationId, (rows) => [...rows, ownRow(edit.fields)]) });
        continue;
      }
      const row = projection.rows.find((candidate) => candidate.relationId === edit.relationId && samePortable(candidate.locator, edit.locator));
      if (row === undefined || !samePortable(row.key, edit.key)) {
        issues.push(createIssue({ code: 'mapping.locator_stale', sourceId: snapshot.sourceId, relationId: edit.relationId, key: edit.key }));
        continue;
      }
      const indexFor = (rows: readonly MemoryRow[]) => rows.findIndex((candidate) => samePortable(logicalKey(candidate, relation.keyFields), edit.key));
      if (edit.kind === 'delete') {
        intents.push({ footprint, command: commandFor(edit.relationId, (rows) => rows.filter((_candidate, index) => index !== indexFor(rows))) });
        continue;
      }
      if (edit.kind === 'rekey' || edit.kind === 'move-relocate' || edit.kind === 'conflict-resolve') {
        issues.push(createIssue({ code: 'transaction.capability_unavailable', sourceId: snapshot.sourceId, relationId: edit.relationId, details: { edit: edit.kind } }));
        continue;
      }
      intents.push({ footprint, command: commandFor(edit.relationId, (rows) => {
        const index = indexFor(rows);
        if (index < 0) throw new Error('Logical memory target changed after planning');
        const next = [...rows];
        const current = next[index] as MemoryRow;
        if (edit.kind === 'replace-fields') next[index] = ownRow({ ...current, ...edit.fields });
        if (edit.kind === 'replace-row') next[index] = ownRow(edit.fields);
        if (edit.kind === 'counter-increment') {
          const currentValue = current[edit.field];
          if (typeof currentValue !== 'number') throw new Error('Counter target is not numeric');
          next[index] = ownRow({ ...current, [edit.field]: currentValue + edit.by });
        }
        if (edit.kind === 'text-splice') {
          const value = current[edit.field];
          if (typeof value !== 'string') throw new Error('Text target is not a string');
          next[index] = ownRow({ ...current, [edit.field]: value.slice(0, edit.index) + edit.value + value.slice(edit.index + edit.deleteCount) });
        }
        if (edit.kind === 'list-splice') {
          if (!Array.isArray(current[edit.field])) throw new Error('List target is not an array');
          const value = current[edit.field] as readonly JsonValue[];
          next[index] = ownRow({ ...current, [edit.field]: [...value.slice(0, edit.index), ...edit.values, ...value.slice(edit.index + edit.deleteCount)] });
        }
        return next;
      }) });
    }
    const combined = combineMemoryIntents(intents);
    const writeFootprint = combined.flatMap(({ footprint }) => parseFootprint(footprint) ?? []);
    return issues.some(({ severity }) => severity === 'error')
      ? { handledEdits, readFootprint: this.declaredReadFootprint, writeFootprint, intents: [], issues }
      : { handledEdits, readFootprint: this.declaredReadFootprint, writeFootprint, intents: combined, issues };
  };
}

export const relateLogicalMemoryFootprints = (left: Footprint, right: Footprint): FootprintRelation => {
  const leftPaths = parseFootprint(left);
  const rightPaths = parseFootprint(right);
  if (leftPaths === undefined || rightPaths === undefined) return 'unknown';
  const leftInRight = leftPaths.every((path) => rightPaths.some((bound) => path === bound || path.startsWith(bound + '/')));
  const rightInLeft = rightPaths.every((path) => leftPaths.some((bound) => path === bound || path.startsWith(bound + '/')));
  if (leftInRight && rightInLeft) return 'equal';
  if (leftInRight) return 'contained_by';
  if (rightInLeft) return 'contains';
  return leftPaths.some((path) => rightPaths.some((other) => path.startsWith(other + '/') || other.startsWith(path + '/'))) ? 'overlaps' : 'disjoint';
};

const commandFor = (relationId: string, update: (rows: readonly MemoryRow[]) => readonly MemoryRow[]): LogicalMemoryCommand => ({
  description: 'update logical memory relation ' + relationId,
  apply: (state) => ownState({ ...state, [relationId]: update(state[relationId] ?? []) })
});
const combineMemoryIntents = (
  intents: readonly { readonly footprint: Footprint; readonly command: LogicalMemoryCommand }[]
): readonly { readonly footprint: Footprint; readonly command: LogicalMemoryCommand }[] => {
  const groups = new Map<string, { footprint: Footprint; commands: LogicalMemoryCommand[] }>();
  for (const intent of intents) {
    const key = canonicalizeJson(intent.footprint);
    const group = groups.get(key) ?? { footprint: intent.footprint, commands: [] };
    group.commands.push(intent.command);
    groups.set(key, group);
  }
  return [...groups.values()].map(({ footprint, commands }) => ({
    footprint,
    command: {
      description: commands.map(({ description }) => description).join('; '),
      apply: (state) => commands.reduce((current, command) => command.apply(current), state)
    }
  }));
};
const relationFootprint = (relationId: string): string => encodeURIComponent(relationId);
const rowFootprint = (relationId: string, key: JsonValue): readonly string[] => [relationFootprint(relationId) + '/' + encodeURIComponent(canonicalizeJson(key))];
const parseFootprint = (footprint: Footprint): readonly string[] | undefined => Array.isArray(footprint) && footprint.every((value) => typeof value === 'string') ? footprint : undefined;
const logicalKey = (row: MemoryRow, fields: readonly string[]): JsonValue | undefined => fields.length > 0 && fields.every((field) => Object.hasOwn(row, field)) ? fields.map((field) => row[field] as JsonValue) : undefined;
const ownRow = (row: Readonly<Record<string, JsonValue>>): MemoryRow => Object.freeze(structuredClone(row));
const ownState = (state: MemoryState): MemoryState => Object.freeze(Object.fromEntries(Object.entries(state).map(([relationId, rows]) => [relationId, Object.freeze(rows.map(ownRow))])));
const samePortable = (left: unknown, right: unknown): boolean => {
  try { return canonicalizeJson(left as JsonValue) === canonicalizeJson(right as JsonValue); } catch { return false; }
};
