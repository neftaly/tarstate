import * as Automerge from '@automerge/automerge';
import type { JsonValue } from '@tarstate/core';
import {
  automergeCopyRelocateLossCodes,
  automergeMoveMetadataProperty,
  readMoveRecord,
  type AutomergeMovePath,
  type AutomergeMoveRecordV1
} from './move.js';
import { automergeBasis, type AutomergeBasis } from './source.js';
import { isAutomergeReservedRootProperty } from './reserved.js';

export type AutomergeFactValue = JsonValue;

export type AutomergeObjectFact = {
  readonly kind: 'automerge.object';
  readonly objectId: string;
  readonly path: AutomergeMovePath;
  readonly objectKind: 'map' | 'list';
};

export type AutomergePropertyFact = {
  readonly kind: 'automerge.property';
  readonly ownerObjectId: string;
  readonly path: AutomergeMovePath;
  readonly property: string | number;
  readonly value: AutomergeFactValue;
  readonly childObjectId?: string;
};

export type AutomergeConflictFact = {
  readonly kind: 'automerge.conflict';
  readonly ownerObjectId: string;
  readonly path: AutomergeMovePath;
  readonly property: string | number;
  readonly alternatives: readonly {
    readonly changeHash: string;
    readonly value: AutomergeFactValue;
    readonly childObjectId?: string;
  }[];
};

export type AutomergeMoveFact = {
  readonly kind: 'automerge.move';
  readonly recordId: string;
  readonly record: AutomergeMoveRecordV1;
};

export type AutomergeLegacyMoveFact = {
  readonly kind: 'automerge.legacy-move';
  readonly legacyKey: string;
  readonly shape: 'object-id' | 'path-relocation';
  readonly value: JsonValue;
  readonly basisKnown: false;
};

export type AutomergeProjectionIssue = {
  readonly code: string;
  readonly path?: AutomergeMovePath;
  readonly details?: Readonly<Record<string, unknown>>;
};

export type AutomergeFactProjection = {
  readonly basis: AutomergeBasis;
  readonly completeness: 'exact' | 'unknown';
  readonly objects: readonly AutomergeObjectFact[];
  readonly properties: readonly AutomergePropertyFact[];
  readonly conflicts: readonly AutomergeConflictFact[];
  readonly moves: readonly AutomergeMoveFact[];
  readonly legacyMoves: readonly AutomergeLegacyMoveFact[];
  readonly issues: readonly AutomergeProjectionIssue[];
};

export type AutomergeProjectionBudget = {
  readonly maxObjects: number;
  readonly maxProperties: number;
  readonly maxMoveRecords: number;
};

export const defaultAutomergeProjectionBudget: AutomergeProjectionBudget = {
  maxObjects: 100_000,
  maxProperties: 1_000_000,
  maxMoveRecords: 100_000
};

/** Projects Automerge-specific storage details into deterministic diagnostic facts. */
export const projectAutomergeFacts = <T extends object>(
  doc: Automerge.Doc<T>,
  budget: AutomergeProjectionBudget = defaultAutomergeProjectionBudget
): AutomergeFactProjection => {
  const objects: AutomergeObjectFact[] = [];
  const properties: AutomergePropertyFact[] = [];
  const conflicts: AutomergeConflictFact[] = [];
  const moves: AutomergeMoveFact[] = [];
  const legacyMoves: AutomergeLegacyMoveFact[] = [];
  const issues: AutomergeProjectionIssue[] = [];
  const visited = new Set<string>();
  let incomplete = false;

  const visit = (value: unknown, path: AutomergeMovePath): void => {
    if (!isTraversable(value)) return;
    const objectId = Automerge.getObjectId(value);
    if (typeof objectId !== 'string' || visited.has(objectId)) return;
    if (objects.length >= budget.maxObjects) {
      incomplete = true;
      issues.push({ code: 'automerge.projection_budget_exceeded', path, details: { budget: 'maxObjects', limit: budget.maxObjects } });
      return;
    }
    visited.add(objectId);
    objects.push({ kind: 'automerge.object', objectId, path: [...path], objectKind: Array.isArray(value) ? 'list' : 'map' });
    for (const [rawProperty, child] of Object.entries(value)) {
      const property = Array.isArray(value) ? Number(rawProperty) : rawProperty;
      if (path.length === 0 && (property === automergeMoveMetadataProperty || (typeof property === 'string' && isAutomergeReservedRootProperty(property)))) continue;
      if (properties.length >= budget.maxProperties) {
        incomplete = true;
        issues.push({ code: 'automerge.projection_budget_exceeded', path: [...path, property], details: { budget: 'maxProperties', limit: budget.maxProperties } });
        return;
      }
      const childObjectId = objectIdOf(child);
      properties.push({
        kind: 'automerge.property',
        ownerObjectId: objectId,
        path: [...path, property],
        property,
        value: normalizeAutomergeValue(child),
        ...(childObjectId === undefined ? {} : { childObjectId })
      });
      const alternatives = conflictsAt(value, property);
      if (alternatives.length > 1) {
        conflicts.push({
          kind: 'automerge.conflict',
          ownerObjectId: objectId,
          path: [...path, property],
          property,
          alternatives: alternatives.map(([changeHash, candidate]) => {
            const candidateObjectId = objectIdOf(candidate);
            return {
              changeHash,
              value: normalizeAutomergeValue(candidate),
              ...(candidateObjectId === undefined ? {} : { childObjectId: candidateObjectId })
            };
          })
        });
      }
      visit(child, [...path, property]);
    }
  };

  visit(doc, []);
  projectMoveMetadata(doc, budget, moves, legacyMoves, issues);
  const lineageIssues = inspectMoveLineage(moves);
  issues.push(...lineageIssues);
  return {
    basis: automergeBasis(doc),
    completeness: incomplete ? 'unknown' : 'exact',
    objects,
    properties,
    conflicts,
    moves,
    legacyMoves,
    issues
  };
};

export const normalizeAutomergeValue = (value: unknown): AutomergeFactValue => {
  if (Automerge.isCounter(value)) return { '@type': 'automerge-counter', value: Number(value) };
  if (value instanceof Date) return { '@type': 'date', value: value.toISOString() };
  if (value instanceof Uint8Array) return { '@type': 'bytes', value: [...value] };
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : { '@type': 'unsupported-number' };
  if (Array.isArray(value)) return value.map(normalizeAutomergeValue);
  if (isRecord(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, normalizeAutomergeValue(child)]));
  }
  return { '@type': 'unsupported', jsType: typeof value };
};

export const conflictsAt = (owner: object, property: string | number): readonly (readonly [string, unknown])[] => {
  try {
    const conflicts = Automerge.getConflicts(owner as Record<string, unknown>, String(property));
    return Object.entries(conflicts ?? {}).sort(([left], [right]) => left.localeCompare(right));
  } catch {
    return [];
  }
};

const projectMoveMetadata = (
  doc: object,
  budget: AutomergeProjectionBudget,
  moves: AutomergeMoveFact[],
  legacyMoves: AutomergeLegacyMoveFact[],
  issues: AutomergeProjectionIssue[]
): void => {
  const root = doc as Record<string, unknown>;
  const metadata = root[automergeMoveMetadataProperty];
  if (metadata !== undefined && !isRecord(metadata)) {
    issues.push({ code: 'automerge.move_metadata_collision', path: [automergeMoveMetadataProperty] });
  } else if (isRecord(metadata)) {
    const entries = Object.entries(metadata).sort(([left], [right]) => left.localeCompare(right));
    if (entries.length > budget.maxMoveRecords) {
      issues.push({ code: 'automerge.move_metadata_limit_exceeded', path: [automergeMoveMetadataProperty], details: { limit: budget.maxMoveRecords, actual: entries.length } });
    }
    for (const [recordId, candidate] of entries.slice(0, budget.maxMoveRecords)) {
      const record = readMoveRecord(doc, recordId);
      if (record === undefined) {
        issues.push({ code: 'automerge.move_record_unknown', path: [automergeMoveMetadataProperty, recordId] });
        continue;
      }
      if (record.preservationLosses.some((loss) => !automergeCopyRelocateLossCodes.includes(loss))) {
        issues.push({ code: 'automerge.move_record_unknown_loss', path: [automergeMoveMetadataProperty, recordId] });
      }
      moves.push({ kind: 'automerge.move', recordId, record });
      void candidate;
    }
  }

  const legacy = root.__automergeMoves;
  if (!isRecord(legacy)) return;
  for (const [legacyKey, value] of Object.entries(legacy).sort(([left], [right]) => left.localeCompare(right))) {
    if (typeof value === 'string') {
      legacyMoves.push({ kind: 'automerge.legacy-move', legacyKey, shape: 'object-id', value, basisKnown: false });
    } else if (isRecord(value) && isLegacyPath(value.from) && isLegacyPath(value.to)) {
      legacyMoves.push({ kind: 'automerge.legacy-move', legacyKey, shape: 'path-relocation', value: normalizeAutomergeValue(value), basisKnown: false });
    }
  }
};

const inspectMoveLineage = (moves: readonly AutomergeMoveFact[]): readonly AutomergeProjectionIssue[] => {
  const issues: AutomergeProjectionIssue[] = [];
  const targets = new Map<string, Set<string>>();
  for (const move of moves) {
    const next = targets.get(move.record.oldRootObjectId) ?? new Set<string>();
    next.add(move.record.newRootObjectId);
    targets.set(move.record.oldRootObjectId, next);
  }
  for (const [oldRootObjectId, next] of targets) {
    if (next.size > 1) issues.push({ code: 'automerge.move_fork_history', details: { oldRootObjectId, newRootObjectIds: [...next].sort() } });
    for (const middle of next) {
      for (const end of targets.get(middle) ?? []) issues.push({ code: 'automerge.move_chain_history', details: { objectIds: [oldRootObjectId, middle, end] } });
    }
  }
  const visit = (start: string, current: string, path: readonly string[]): void => {
    for (const next of targets.get(current) ?? []) {
      if (next === start) {
        issues.push({ code: 'automerge.move_cycle_history', details: { objectIds: [...path, current, next] } });
        return;
      }
      if (!path.includes(next)) visit(start, next, [...path, current]);
    }
  };
  for (const start of targets.keys()) visit(start, start, []);
  return deduplicateIssues(issues);
};

const deduplicateIssues = (issues: readonly AutomergeProjectionIssue[]): readonly AutomergeProjectionIssue[] => {
  const byKey = new Map<string, AutomergeProjectionIssue>();
  for (const issue of issues) byKey.set(issue.code + JSON.stringify(issue.details ?? {}), issue);
  return [...byKey.values()];
};

const objectIdOf = (value: unknown): string | undefined => {
  if (!isTraversable(value)) return undefined;
  const objectId = Automerge.getObjectId(value);
  return typeof objectId === 'string' ? objectId : undefined;
};

const isTraversable = (value: unknown): value is object =>
  value !== null && typeof value === 'object' && !Automerge.isCounter(value) && !(value instanceof Date) && !(value instanceof Uint8Array);

const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const isLegacyPath = (value: unknown): value is (string | number)[] => Array.isArray(value) && value.every((part) => typeof part === 'string' || Number.isInteger(part));
