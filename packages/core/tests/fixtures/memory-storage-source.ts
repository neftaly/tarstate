import { canonicalizeJson, type ContentHash } from '../../src/artifacts.js';
import { createIssue, type Issue } from '../../src/issues.js';
import { detachAndFreezeJsonValue } from '../../src/internal-owned-json.js';
import { positiveSafeInteger } from '../../src/internal-numeric-boundary.js';
import { stringTupleKey } from '../../src/internal-string-key.js';
import { samePortableJson } from '../../src/internal-json-equality.js';
import { notifyObservers, type ObserverDiagnosticReporter } from '../../src/observer-diagnostics.js';
import type { MemoryRow, MemoryState } from '../../src/memory-source.js';
import type { WritableLogicalRow } from '../../src/logical-edit.js';
import { sealStorageProjection } from '../../src/storage-projection.js';
import type { SourceBasis, SourceSnapshot } from '../../src/source-state.js';
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
} from '../../src/source-protocol.js';
import type { JsonValue } from '../../src/value.js';

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

type MemoryRowOperation =
  | { readonly kind: 'insert'; readonly fingerprint: string; readonly row: MemoryRow }
  | { readonly kind: 'delete'; readonly fingerprint: string }
  | { readonly kind: 'update'; readonly fingerprint: string; readonly update: (row: MemoryRow) => MemoryRow };

/** Small generic AtomicSource proving adapter over immutable logical rows. */
export class LogicalMemoryAtomicSource implements AtomicSource<MemoryState, LogicalMemoryCommand> {
  readonly sourceId: string;
  readonly operationEpoch: string;
  readonly #incarnation: string;
  readonly #listeners = new Set<(change?: { readonly beforeBasis?: SourceBasis; readonly afterBasis: SourceBasis }) => void>();
  readonly #ledger = new Map<string, LedgerEntry>();
  readonly #maxOperationReceipts: number;
  readonly #onDiagnostic: ObserverDiagnosticReporter | undefined;
  #state: MemoryState;
  #revision = 0;
  #closed = false;

  constructor(options: {
    readonly sourceId: string;
    readonly incarnation: string;
    readonly operationEpoch: string;
    readonly state: MemoryState;
    /** Fail closed before mutation when exact replay evidence reaches this bound. */
    readonly maxOperationReceipts?: number;
    /** Receives listener failures after an already committed transition. */
    readonly onDiagnostic?: ObserverDiagnosticReporter;
  }) {
    if (options.sourceId.length === 0 || options.incarnation.length === 0 || options.operationEpoch.length === 0) throw new TypeError('Logical memory source identifiers must not be empty');
    this.sourceId = options.sourceId;
    this.#incarnation = options.incarnation;
    this.operationEpoch = options.operationEpoch;
    this.#state = ownState(options.state);
    this.#maxOperationReceipts = positiveSafeInteger(options.maxOperationReceipts ?? 65_536, 'maxOperationReceipts');
    this.#onDiagnostic = options.onDiagnostic;
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
    const ledgerKey = stringTupleKey(input.operationEpoch, input.operationId);
    const prior = this.#ledger.get(ledgerKey);
    if (prior !== undefined) {
      return prior.intentHash === input.intentHash
        ? prior.result
        : { outcome: 'rejected', issues: [createIssue({ code: 'transaction.operation_id_ambiguous', operationId: input.operationId, sourceId: this.sourceId })] };
    }
    if (this.#ledger.size >= this.#maxOperationReceipts) {
      return {
        outcome: 'rejected',
        issues: [createIssue({
          code: 'operation.ledger_capacity_exhausted',
          sourceId: this.sourceId,
          operationId: input.operationId,
          details: { capacity: this.#maxOperationReceipts, action: 'replace_source' }
        })]
      };
    }
    const retain = (result: SourceCommitResult): SourceCommitResult => {
      const owned = Object.freeze({ ...result, issues: Object.freeze([...result.issues]) });
      this.#ledger.set(ledgerKey, { intentHash: input.intentHash, result: owned });
      return owned;
    };
    const beforeBasis = this.#basis();
    if (!samePortableJson(input.expectedBasis, beforeBasis)) {
      return retain({ outcome: 'rejected', beforeBasis, issues: [createIssue({ code: 'transaction.expected_basis_stale', operationId: input.operationId, sourceId: this.sourceId, details: { expected: input.expectedBasis, actual: beforeBasis } })] });
    }
    const staged = this.stage(this.snapshot(), input.commands);
    if (staged.issues.some(({ severity }) => severity === 'error')) return retain({ outcome: 'rejected', beforeBasis, issues: staged.issues });
    const changed = this.#state !== staged.storage;
    if (changed) {
      this.#state = staged.storage;
      this.#revision += 1;
    }
    const result = retain({ outcome: 'committed', beforeBasis, afterBasis: this.#basis(), issues: staged.issues });
    if (changed) {
      const afterBasis = this.#basis();
      notifyObservers(this.#listeners, (listener) => listener({ beforeBasis, afterBasis }), {
        component: 'memory-source',
        operation: 'publish'
      }, this.#onDiagnostic);
    }
    return result;
  };

  relateFootprints = relateLogicalMemoryFootprints;

  mergeIntents = (plans: readonly PlanResult<LogicalMemoryCommand>[]): IntentMergeResult<LogicalMemoryCommand> => {
    const intents = plans.flatMap(({ intents }) => intents);
    const overlap = firstLogicalMemoryFootprintOverlap(intents.map(({ footprint }) => footprint));
    if (overlap === 'unknown') return { outcome: 'unknown', issues: [createIssue({ code: 'binding.footprint_relation_unknown', sourceId: this.sourceId })] };
    if (overlap !== undefined) return { outcome: 'conflict', issues: [createIssue({ code: 'binding.write_footprint_overlap', sourceId: this.sourceId })] };
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
    return snapshot.storage === stagedStorage
      ? basis
      : Object.freeze({ incarnation: basis.incarnation, revision: basis.revision + 1 });
  };

  queryOutcome = async (input: { readonly operationEpoch: string; readonly operationId: string; readonly intentHash: ContentHash }): Promise<SourceOutcomeLookup<SourceCommitResult>> => {
    if (input.operationEpoch !== this.operationEpoch) return { status: 'expired' };
    const entry = this.#ledger.get(stringTupleKey(input.operationEpoch, input.operationId));
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
  readonly relationIds: readonly string[];
  readonly declaredReadFootprint: Footprint;
  readonly declaredWriteFootprint: Footprint;
  readonly #relations: ReadonlyMap<string, LogicalMemoryRelation>;
  readonly #projections = new WeakMap<object, Map<string, ProjectionResult<WritableLogicalRow>>>();

  constructor(options: { readonly id?: string; readonly relations: readonly LogicalMemoryRelation[] }) {
    this.id = options.id ?? 'logical-memory';
    const relations = options.relations.map((relation) => Object.freeze({ relationId: relation.relationId, keyFields: Object.freeze([...relation.keyFields]) }));
    if (new Set(relations.map(({ relationId }) => relationId)).size !== relations.length) throw new TypeError('Logical memory relation IDs must be unique');
    this.#relations = new Map(relations.map((relation) => [relation.relationId, relation]));
    this.relationIds = Object.freeze(relations.map(({ relationId }) => relationId));
    this.declaredReadFootprint = Object.freeze(relations.map(({ relationId }) => relationFootprint(relationId)));
    this.declaredWriteFootprint = this.declaredReadFootprint;
  }

  project = (snapshot: SourceSnapshot<MemoryState>, requestedRelations?: ReadonlySet<string>): ProjectionResult<WritableLogicalRow> => {
    if (snapshot.state !== 'ready' || snapshot.storage === undefined) return { rows: [], completeness: 'unknown', issues: [createIssue({ code: 'source.not_ready', sourceId: snapshot.sourceId })] };
    const selectedRelations = requestedRelations === undefined
      ? this.relationIds
      : this.relationIds.filter((relationId) => requestedRelations.has(relationId));
    const cacheKey = stringTupleKey(snapshot.sourceId, ...selectedRelations);
    const cached = this.#projections.get(snapshot.storage)?.get(cacheKey);
    if (cached !== undefined) return cached;
    const rows: WritableLogicalRow[] = [];
    const issues: Issue[] = [];
    for (const relation of this.#relations.values()) {
      if (requestedRelations !== undefined && !requestedRelations.has(relation.relationId)) continue;
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
        rows.push(Object.freeze({
          relationId: relation.relationId,
          key,
          fields,
          locator: Object.freeze({ namespace: this.id, token: fingerprint })
        }));
      }
    }
    const projection = sealStorageProjection(Object.freeze({
      rows: Object.freeze(rows),
      completeness: issues.length === 0 ? 'exact' as const : 'unknown' as const,
      issues: Object.freeze(issues)
    }));
    const bySource = this.#projections.get(snapshot.storage) ?? new Map<string, ProjectionResult<WritableLogicalRow>>();
    if (!bySource.has(cacheKey) && bySource.size >= 64) bySource.delete(bySource.keys().next().value as string);
    bySource.set(cacheKey, projection);
    this.#projections.set(snapshot.storage, bySource);
    return projection;
  };

  plan = (snapshot: SourceSnapshot<MemoryState>, edits: readonly LogicalEdit[]): PlanResult<LogicalMemoryCommand> => {
    const handledEdits = edits.flatMap((edit, editIndex) => this.#relations.has(edit.relationId)
      ? [{ editIndex, mode: 'exclusive' as const }]
      : []);
    const relevant = handledEdits.map(({ editIndex }) => edits[editIndex] as LogicalEdit);
    const operations = new Map<string, { readonly paths: string[]; readonly edits: MemoryRowOperation[] }>();
    const issues: Issue[] = [];
    if (snapshot.state !== 'ready' || snapshot.storage === undefined) return { handledEdits, readFootprint: this.declaredReadFootprint, writeFootprint: [], intents: [], issues: [createIssue({ code: 'source.not_ready', sourceId: snapshot.sourceId })] };
    const projection = this.project(snapshot);
    if (projection.completeness !== 'exact') return { handledEdits, readFootprint: this.declaredReadFootprint, writeFootprint: [], intents: [], issues: projection.issues };
    const rowsByLocator = new Map<string, WritableLogicalRow>();
    const keysByRelation = new Map<string, Set<string>>();
    for (const row of projection.rows) {
      rowsByLocator.set(stringTupleKey(row.relationId, canonicalizeJson(row.locator)), row);
      const keys = keysByRelation.get(row.relationId) ?? new Set<string>();
      keys.add(canonicalizeJson(row.key));
      keysByRelation.set(row.relationId, keys);
    }
    for (const edit of relevant) {
      const fingerprint = canonicalizeJson(edit.key);
      const operationGroup = operations.get(edit.relationId) ?? { paths: [], edits: [] };
      operationGroup.paths.push(rowPath(edit.relationId, edit.key));
      operations.set(edit.relationId, operationGroup);
      if (edit.kind === 'insert') {
        if (keysByRelation.get(edit.relationId)?.has(fingerprint) === true) {
          issues.push(createIssue({ code: 'transaction.upsert_conflict', sourceId: snapshot.sourceId, relationId: edit.relationId, key: edit.key }));
          continue;
        }
        operationGroup.edits.push({ kind: 'insert', fingerprint, row: ownRow(edit.fields) });
        continue;
      }
      const row = rowsByLocator.get(stringTupleKey(edit.relationId, canonicalizeJson(edit.locator)));
      if (row === undefined || !samePortableJson(row.key, edit.key)) {
        issues.push(createIssue({ code: 'mapping.locator_stale', sourceId: snapshot.sourceId, relationId: edit.relationId, key: edit.key }));
        continue;
      }
      if (edit.kind === 'delete') {
        operationGroup.edits.push({ kind: 'delete', fingerprint });
        continue;
      }
      if (edit.kind === 'rekey' || edit.kind === 'move-relocate' || edit.kind === 'conflict-resolve') {
        issues.push(createIssue({ code: 'transaction.capability_unavailable', sourceId: snapshot.sourceId, relationId: edit.relationId, details: { edit: edit.kind } }));
        continue;
      }
      operationGroup.edits.push({ kind: 'update', fingerprint, update: (current) => {
        if (edit.kind === 'replace-fields') return ownRow({ ...current, ...edit.fields });
        if (edit.kind === 'replace-row') return ownRow(edit.fields);
        if (edit.kind === 'counter-increment') {
          const currentValue = current[edit.field];
          if (typeof currentValue !== 'number') throw new Error('Counter target is not numeric');
          return ownRow({ ...current, [edit.field]: currentValue + edit.by });
        }
        if (edit.kind === 'text-splice') {
          const value = current[edit.field];
          if (typeof value !== 'string') throw new Error('Text target is not a string');
          return ownRow({ ...current, [edit.field]: value.slice(0, edit.index) + edit.value + value.slice(edit.index + edit.deleteCount) });
        }
        if (edit.kind === 'list-splice') {
          if (!Array.isArray(current[edit.field])) throw new Error('List target is not an array');
          const value = current[edit.field] as readonly JsonValue[];
          return ownRow({ ...current, [edit.field]: [...value.slice(0, edit.index), ...edit.values, ...value.slice(edit.index + edit.deleteCount)] });
        }
        return current;
      } });
    }
    const intents = [...operations].flatMap(([relationId, group]) => group.edits.length === 0
      ? []
      : [{
          footprint: Object.freeze(group.paths),
          command: commandForOperations(relationId, (this.#relations.get(relationId) as LogicalMemoryRelation).keyFields, group.edits)
        }]);
    const writeFootprint = Object.freeze(intents.flatMap(({ footprint }) => parseFootprint(footprint) ?? []));
    return issues.some(({ severity }) => severity === 'error')
      ? { handledEdits, readFootprint: this.declaredReadFootprint, writeFootprint, intents: [], issues }
      : { handledEdits, readFootprint: this.declaredReadFootprint, writeFootprint, intents, issues };
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

type MemoryPathTrie = {
  readonly children: Map<string, MemoryPathTrie>;
  terminalOwner?: number;
  firstOwner?: number;
  secondOwner?: number;
};

const firstLogicalMemoryFootprintOverlap = (
  footprints: readonly Footprint[]
): readonly [number, number] | 'unknown' | undefined => {
  const root: MemoryPathTrie = { children: new Map() };
  for (let owner = 0; owner < footprints.length; owner += 1) {
    const paths = parseFootprint(footprints[owner] as Footprint);
    if (paths === undefined) return 'unknown';
    for (const path of paths) {
      const visited = [root];
      let node = root;
      for (const segment of path.split('/')) {
        if (node.terminalOwner !== undefined && node.terminalOwner !== owner) return [node.terminalOwner, owner];
        const child = node.children.get(segment) ?? { children: new Map<string, MemoryPathTrie>() };
        if (!node.children.has(segment)) node.children.set(segment, child);
        node = child;
        visited.push(node);
      }
      const descendantOwner = node.firstOwner !== undefined && node.firstOwner !== owner
        ? node.firstOwner
        : node.secondOwner !== undefined && node.secondOwner !== owner
          ? node.secondOwner
          : undefined;
      if (descendantOwner !== undefined) return [descendantOwner, owner];
      node.terminalOwner = owner;
      for (const visitedNode of visited) {
        if (visitedNode.firstOwner === undefined) visitedNode.firstOwner = owner;
        else if (visitedNode.firstOwner !== owner && visitedNode.secondOwner === undefined) visitedNode.secondOwner = owner;
      }
    }
  }
  return undefined;
};

const commandForOperations = (
  relationId: string,
  keyFields: readonly string[],
  operations: readonly MemoryRowOperation[]
): LogicalMemoryCommand => ({
  description: 'update logical memory relation ' + relationId,
  apply: (state) => {
    const current = state[relationId] ?? [];
    const next: (MemoryRow | undefined)[] = [...current];
    const positions = new Map<string, number>();
    let modified = false;
    current.forEach((row, index) => {
      const key = logicalKey(row, keyFields);
      if (key !== undefined) positions.set(canonicalizeJson(key), index);
    });
    for (const operation of operations) {
      const index = positions.get(operation.fingerprint);
      if (operation.kind === 'insert') {
        if (index !== undefined) throw new Error('Logical memory insert target changed after planning');
        positions.set(operation.fingerprint, next.length);
        next.push(operation.row);
        modified = true;
        continue;
      }
      if (index === undefined || next[index] === undefined) throw new Error('Logical memory target changed after planning');
      if (operation.kind === 'delete') {
        next[index] = undefined;
        positions.delete(operation.fingerprint);
        modified = true;
      } else {
        const replacement = operation.update(next[index] as MemoryRow);
        if (!samePortableJson(next[index], replacement)) {
          next[index] = replacement;
          modified = true;
        }
      }
    }
    if (!modified) return state;
    const rows = next.includes(undefined)
      ? next.filter((row): row is MemoryRow => row !== undefined)
      : next as MemoryRow[];
    return Object.freeze({ ...state, [relationId]: Object.freeze(rows) });
  }
});
const relationFootprint = (relationId: string): string => encodeURIComponent(relationId);
const rowPath = (relationId: string, key: JsonValue): string => relationFootprint(relationId) + '/' + encodeURIComponent(canonicalizeJson(key));
const parseFootprint = (footprint: Footprint): readonly string[] | undefined => Array.isArray(footprint) && footprint.every((value) => typeof value === 'string') ? footprint : undefined;
const logicalKey = (row: MemoryRow, fields: readonly string[]): JsonValue | undefined => fields.length > 0 && fields.every((field) => Object.hasOwn(row, field))
  ? Object.freeze(fields.map((field) => row[field] as JsonValue))
  : undefined;
const ownRow = (row: Readonly<Record<string, JsonValue>>): MemoryRow => {
  const owned = detachAndFreezeJsonValue(row);
  if (!owned.success || owned.value === null || Array.isArray(owned.value) || typeof owned.value !== 'object') throw new TypeError('Logical memory row must be portable data');
  return owned.value as MemoryRow;
};
const ownState = (state: MemoryState): MemoryState => Object.freeze(Object.fromEntries(Object.entries(state).map(([relationId, rows]) => [relationId, Object.freeze(rows.map(ownRow))])));
