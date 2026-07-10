import { canonicalizeJson } from './artifacts.js';
import type {
  MaintainedResult,
  MaintenanceInput,
  MaintenanceSession,
  MaintenanceStrategy,
  PreparedPlan,
  RelationDelta
} from './maintenance.js';
import { evaluateQuery, type FunctionRegistry, type QueryLogicalValue, type QueryNode, type QueryRecord, type RelationInput } from './query.js';
import { logicalUnknown, type JsonValue } from './value.js';

/** A row change paired with the source-owned occurrence identity it affects. */
export type QueryRowOccurrence = {
  readonly occurrenceId: string;
  readonly row: QueryRecord;
};

/**
 * Runtime inputs needed to evaluate a prepared query. A session owns its most
 * recent snapshot; callers still supply a fresh snapshot on every update.
 */
export type QueryMaintenanceSnapshot = {
  readonly relations: readonly RelationInput[];
  readonly parameters?: Readonly<Record<string, JsonValue>>;
  readonly functions?: FunctionRegistry;
  readonly basis?: JsonValue;
  readonly membershipRevision?: number;
};

/** Adapter hints are deliberately narrow and carry no semantic authority. */
export type QueryMaintenanceChange = {
  readonly relationDeltas: readonly RelationDelta<QueryRowOccurrence>[];
};

export type DifferentialFallbackReason =
  | 'initial'
  | 'missing_change_hint'
  | 'empty_change_hint'
  | 'invalidated_hint'
  | 'ambiguous_relation'
  | 'duplicate_relation_hint'
  | 'incomplete_relation'
  | 'missing_relation_basis'
  | 'stale_before_basis'
  | 'stale_after_basis'
  | 'occurrence_identity_unavailable'
  | 'malformed_delta'
  | 'delta_snapshot_mismatch'
  | 'unhinted_relation_change'
  | 'session_input_changed';

export type DifferentialMaintenanceState = {
  readonly strategy: 'differential';
  readonly mode: 'full-recompute' | 'validated-delta-recompute';
  readonly revision: number;
  readonly acceptedHints: number;
  readonly fallbackCount: number;
  readonly appliedRelationIds: readonly string[];
  readonly fallbackReason?: DifferentialFallbackReason;
};

export type DifferentialMaintainedQueryResult = MaintainedResult<QueryRecord, DifferentialMaintenanceState>;

export interface DifferentialQueryMaintenanceSession extends MaintenanceSession<
  QueryRecord,
  QueryMaintenanceSnapshot,
  QueryMaintenanceChange
> {
  current(): DifferentialMaintainedQueryResult;
  update(input: MaintenanceInput<QueryMaintenanceSnapshot, QueryMaintenanceChange>): DifferentialMaintainedQueryResult;
}

type HintDecision =
  | { readonly accepted: true; readonly relationIds: readonly string[] }
  | { readonly accepted: false; readonly reason: Exclude<DifferentialFallbackReason, 'initial'> };

/**
 * Correctness-first differential maintenance.
 *
 * A trustworthy hint is replayed against the prior occurrence snapshot and
 * checked against the fresh snapshot before it is accepted. Query operators
 * currently use bounded root recomputation after that validation. Missing,
 * stale, ambiguous, incomplete, or rejected hints take the same full-oracle
 * path without changing public rows, keys, completeness, or issues.
 */
export class DifferentialQueryMaintenanceStrategy implements MaintenanceStrategy<
  QueryNode,
  QueryRecord,
  QueryMaintenanceSnapshot,
  QueryMaintenanceChange
> {
  open(
    plan: PreparedPlan<QueryNode>,
    input: MaintenanceInput<QueryMaintenanceSnapshot, QueryMaintenanceChange>
  ): DifferentialQueryMaintenanceSession {
    let closed = false;
    let snapshot = input.snapshot;
    let state: DifferentialMaintenanceState = {
      strategy: 'differential',
      mode: 'full-recompute',
      revision: 0,
      acceptedHints: 0,
      fallbackCount: 0,
      appliedRelationIds: [],
      fallbackReason: 'initial'
    };
    let current = withState(evaluateSnapshot(plan, snapshot), state);

    return {
      current: () => current,
      update: (next) => {
        if (closed) throw new Error('Maintenance session is closed');

        const decision = validateHint(snapshot, next.snapshot, next.change);
        state = decision.accepted
          ? {
              strategy: 'differential',
              mode: 'validated-delta-recompute',
              revision: state.revision + 1,
              acceptedHints: state.acceptedHints + 1,
              fallbackCount: state.fallbackCount,
              appliedRelationIds: decision.relationIds
            }
          : {
              strategy: 'differential',
              mode: 'full-recompute',
              revision: state.revision + 1,
              acceptedHints: state.acceptedHints,
              fallbackCount: state.fallbackCount + 1,
              appliedRelationIds: [],
              fallbackReason: decision.reason
            };
        snapshot = next.snapshot;
        current = withState(evaluateSnapshot(plan, snapshot), state);
        return current;
      },
      close: () => {
        closed = true;
      }
    };
  }
}

export const createDifferentialQueryMaintenanceStrategy = (): DifferentialQueryMaintenanceStrategy =>
  new DifferentialQueryMaintenanceStrategy();

const evaluateSnapshot = (
  plan: PreparedPlan<QueryNode>,
  snapshot: QueryMaintenanceSnapshot
): Omit<DifferentialMaintainedQueryResult, 'state'> =>
  evaluateQuery({
    root: plan.query,
    relations: snapshot.relations,
    ...(snapshot.parameters === undefined ? {} : { parameters: snapshot.parameters }),
    ...(snapshot.functions === undefined ? {} : { functions: snapshot.functions }),
    ...(snapshot.basis === undefined ? {} : { basis: snapshot.basis }),
    ...(snapshot.membershipRevision === undefined ? {} : { membershipRevision: snapshot.membershipRevision })
  });

const withState = (
  result: Omit<DifferentialMaintainedQueryResult, 'state'>,
  state: DifferentialMaintenanceState
): DifferentialMaintainedQueryResult => ({ ...result, state });

const validateHint = (
  previous: QueryMaintenanceSnapshot,
  next: QueryMaintenanceSnapshot,
  change: QueryMaintenanceChange | undefined
): HintDecision => {
  if (change === undefined) return rejected('missing_change_hint');
  if (change.relationDeltas.length === 0) return rejected('empty_change_hint');
  if (!sameSessionInputs(previous, next)) return rejected('session_input_changed');

  const previousById = groupRelationsById(previous.relations);
  const nextById = groupRelationsById(next.relations);
  const hintedIds = new Set<string>();

  for (const delta of change.relationDeltas) {
    if (hintedIds.has(delta.relationId)) return rejected('duplicate_relation_hint');
    hintedIds.add(delta.relationId);
    if (delta.invalidated) return rejected('invalidated_hint');

    const beforeCandidates = previousById.get(delta.relationId) ?? [];
    const afterCandidates = nextById.get(delta.relationId) ?? [];
    if (beforeCandidates.length !== 1 || afterCandidates.length !== 1) return rejected('ambiguous_relation');
    const before = beforeCandidates[0] as RelationInput;
    const after = afterCandidates[0] as RelationInput;
    if (relationIdentity(before) !== relationIdentity(after)) return rejected('ambiguous_relation');
    if (before.completeness !== 'exact' || after.completeness !== 'exact') return rejected('incomplete_relation');
    if (before.basis === undefined || after.basis === undefined) return rejected('missing_relation_basis');
    if (!jsonEqual(before.basis, delta.beforeBasis)) return rejected('stale_before_basis');
    if (!jsonEqual(after.basis, delta.afterBasis)) return rejected('stale_after_basis');
    if (!stableRelationMetadata(before, after)) return rejected('session_input_changed');

    const expected = occurrenceMap(after);
    if (occurrenceMap(before) === undefined || expected === undefined) return rejected('occurrence_identity_unavailable');
    const replay = replayDelta(before, delta);
    if (replay === undefined) return rejected('malformed_delta');
    if (!occurrenceMapsEqual(replay, expected)) return rejected('delta_snapshot_mismatch');
  }

  const previousRelations = new Map(previous.relations.map((relation) => [relationIdentity(relation), relation]));
  const nextRelations = new Map(next.relations.map((relation) => [relationIdentity(relation), relation]));
  if (previousRelations.size !== previous.relations.length || nextRelations.size !== next.relations.length) return rejected('ambiguous_relation');
  const identities = new Set([...previousRelations.keys(), ...nextRelations.keys()]);
  for (const identity of identities) {
    const before = previousRelations.get(identity);
    const after = nextRelations.get(identity);
    if (before === undefined || after === undefined) return rejected('unhinted_relation_change');
    if (!relationSnapshotEqual(before, after) && !hintedIds.has(before.relation.relationId)) return rejected('unhinted_relation_change');
  }

  return { accepted: true, relationIds: [...hintedIds].sort() };
};

const rejected = (reason: Exclude<DifferentialFallbackReason, 'initial'>): HintDecision => ({ accepted: false, reason });

const sameSessionInputs = (left: QueryMaintenanceSnapshot, right: QueryMaintenanceSnapshot): boolean =>
  jsonOptionalEqual(left.parameters, right.parameters) && sameFunctions(left.functions, right.functions);

const sameFunctions = (left: FunctionRegistry | undefined, right: FunctionRegistry | undefined): boolean => {
  if (left === right) return true;
  const leftEntries = [...(left ?? new Map()).entries()];
  const rightMap = right ?? new Map();
  return leftEntries.length === rightMap.size && leftEntries.every(([key, implementation]) => rightMap.get(key) === implementation);
};

const groupRelationsById = (relations: readonly RelationInput[]): Map<string, RelationInput[]> => {
  const grouped = new Map<string, RelationInput[]>();
  for (const relation of relations) {
    const candidates = grouped.get(relation.relation.relationId) ?? [];
    candidates.push(relation);
    grouped.set(relation.relation.relationId, candidates);
  }
  return grouped;
};

const relationIdentity = (input: RelationInput): string =>
  `${input.relation.schemaView.id}\u0000${input.relation.schemaView.contentHash}\u0000${input.relation.relationId}`;

const stableRelationMetadata = (left: RelationInput, right: RelationInput): boolean =>
  left.sourceId === right.sourceId && left.attachmentId === right.attachmentId;

const occurrenceMap = (input: RelationInput): Map<string, QueryRecord> | undefined => {
  if (input.occurrenceIds === undefined || input.occurrenceIds.length !== input.rows.length) return undefined;
  const occurrences = new Map<string, QueryRecord>();
  for (let index = 0; index < input.rows.length; index += 1) {
    const occurrenceId = input.occurrenceIds[index] as string;
    if (occurrences.has(occurrenceId)) return undefined;
    occurrences.set(occurrenceId, input.rows[index] as QueryRecord);
  }
  return occurrences;
};

const replayDelta = (
  input: RelationInput,
  delta: RelationDelta<QueryRowOccurrence>
): Map<string, QueryRecord> | undefined => {
  const rows = occurrenceMap(input);
  if (rows === undefined) return undefined;

  for (const removed of delta.removed) {
    if (!removeExact(rows, removed)) return undefined;
  }
  for (const updated of delta.updated) {
    if (!removeExact(rows, updated.before)) return undefined;
    if (rows.has(updated.after.occurrenceId)) return undefined;
    rows.set(updated.after.occurrenceId, updated.after.row);
  }
  for (const added of delta.added) {
    if (rows.has(added.occurrenceId)) return undefined;
    rows.set(added.occurrenceId, added.row);
  }
  return rows;
};

const removeExact = (rows: Map<string, QueryRecord>, occurrence: QueryRowOccurrence): boolean => {
  const existing = rows.get(occurrence.occurrenceId);
  if (existing === undefined || !queryRecordEqual(existing, occurrence.row)) return false;
  rows.delete(occurrence.occurrenceId);
  return true;
};

const occurrenceMapsEqual = (left: ReadonlyMap<string, QueryRecord>, right: ReadonlyMap<string, QueryRecord>): boolean =>
  left.size === right.size && [...left].every(([occurrenceId, row]) => {
    const candidate = right.get(occurrenceId);
    return candidate !== undefined && queryRecordEqual(row, candidate);
  });

const relationSnapshotEqual = (left: RelationInput, right: RelationInput): boolean => {
  if (left.completeness !== right.completeness || !jsonOptionalEqual(left.basis, right.basis) || !stableRelationMetadata(left, right)) return false;
  const leftRows = occurrenceMap(left);
  const rightRows = occurrenceMap(right);
  if (leftRows !== undefined && rightRows !== undefined) return occurrenceMapsEqual(leftRows, rightRows);
  return queryRowsEqual(left.rows, right.rows)
    && jsonOptionalEqual(left.occurrenceIds as readonly string[] | undefined, right.occurrenceIds as readonly string[] | undefined);
};

const jsonOptionalEqual = (left: unknown, right: unknown): boolean => {
  if (left === undefined || right === undefined) return left === right;
  return jsonEqual(left as JsonValue, right as JsonValue);
};

const jsonEqual = (left: JsonValue, right: JsonValue): boolean => canonicalizeJson(left) === canonicalizeJson(right);

const queryRowsEqual = (left: readonly QueryRecord[], right: readonly QueryRecord[]): boolean =>
  left.length === right.length && left.every((row, index) => queryRecordEqual(row, right[index] as QueryRecord));

const queryRecordEqual = (left: QueryRecord, right: QueryRecord): boolean =>
  canonicalizeQueryValue(left) === canonicalizeQueryValue(right);

/** Query rows can contain the internal logical-unknown carrier, which is not JSON. */
const canonicalizeQueryValue = (value: QueryLogicalValue): string => {
  if (value === logicalUnknown) return 'u';
  if (value === null) return 'n';
  if (typeof value === 'boolean') return value ? 'b1' : 'b0';
  if (typeof value === 'number') return `d${Object.is(value, -0) ? 0 : value}`;
  if (typeof value === 'string') return `s${JSON.stringify(value)}`;
  if (Array.isArray(value)) return `a[${value.map(canonicalizeQueryValue).join(',')}]`;
  const record = value as Readonly<Record<string, QueryLogicalValue>>;
  return `o{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalizeQueryValue(record[key] as QueryLogicalValue)}`).join(',')}}`;
};
