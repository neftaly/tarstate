import * as Automerge from '@automerge/automerge';
import type { JsonValue } from '@tarstate/core/foundation';
import { automergeBasis, type AutomergeBasis } from './source.js';
import { isAutomergeReservedRootProperty } from './reserved.js';
import { comparePortableStrings } from './portable-order.js';

export type AutomergeFactValue = JsonValue;
export type AutomergePath = readonly (string | number)[];

export type AutomergeObjectFact = {
  readonly kind: 'automerge.object';
  readonly objectId: string;
  readonly path: AutomergePath;
  readonly objectKind: 'map' | 'list';
};

export type AutomergePropertyFact = {
  readonly kind: 'automerge.property';
  readonly ownerObjectId: string;
  readonly path: AutomergePath;
  readonly property: string | number;
  readonly value: AutomergeFactValue;
  readonly childObjectId?: string;
};

export type AutomergeConflictFact = {
  readonly kind: 'automerge.conflict';
  readonly ownerObjectId: string;
  readonly path: AutomergePath;
  readonly property: string | number;
  readonly alternatives: readonly {
    readonly changeHash: string;
    readonly value: AutomergeFactValue;
    readonly childObjectId?: string;
  }[];
};

export type AutomergeProjectionIssue = {
  readonly code: string;
  readonly path?: AutomergePath;
  readonly details?: Readonly<Record<string, unknown>>;
};

export type AutomergeFactProjection = {
  readonly basis: AutomergeBasis;
  readonly completeness: 'exact' | 'unknown';
  readonly objects: readonly AutomergeObjectFact[];
  readonly properties: readonly AutomergePropertyFact[];
  readonly conflicts: readonly AutomergeConflictFact[];
  readonly issues: readonly AutomergeProjectionIssue[];
};

export type AutomergeProjectionBudget = {
  readonly maxObjects: number;
  readonly maxProperties: number;
};

export const defaultAutomergeProjectionBudget: AutomergeProjectionBudget = Object.freeze({
  maxObjects: 100_000,
  maxProperties: 1_000_000
});

/** Projects Automerge-specific storage details into deterministic diagnostic facts. */
export const projectAutomergeFacts = <T extends object>(
  doc: Automerge.Doc<T>,
  budget: AutomergeProjectionBudget = defaultAutomergeProjectionBudget
): AutomergeFactProjection => {
  const objects: AutomergeObjectFact[] = [];
  const properties: AutomergePropertyFact[] = [];
  const conflicts: AutomergeConflictFact[] = [];
  const issues: AutomergeProjectionIssue[] = [];
  const visited = new Set<string>();
  let incomplete = false;

  const visit = (value: unknown, path: AutomergePath): void => {
    if (!isTraversable(value)) return;
    const objectId = Automerge.getObjectId(value);
    if (typeof objectId !== 'string' || visited.has(objectId)) return;
    if (objects.length >= budget.maxObjects) {
      incomplete = true;
      issues.push(Object.freeze({ code: 'automerge.projection_budget_exceeded', path, details: Object.freeze({ budget: 'maxObjects', limit: budget.maxObjects }) }));
      return;
    }
    visited.add(objectId);
    objects.push(Object.freeze({ kind: 'automerge.object', objectId, path, objectKind: Array.isArray(value) ? 'list' : 'map' }));
    for (const [rawProperty, child] of Object.entries(value)) {
      const property = Array.isArray(value) ? Number(rawProperty) : rawProperty;
      if (path.length === 0 && typeof property === 'string' && isAutomergeReservedRootProperty(property)) continue;
      const childPath = Object.freeze([...path, property]);
      if (properties.length >= budget.maxProperties) {
        incomplete = true;
        issues.push(Object.freeze({ code: 'automerge.projection_budget_exceeded', path: childPath, details: Object.freeze({ budget: 'maxProperties', limit: budget.maxProperties }) }));
        return;
      }
      const childObjectId = objectIdOf(child);
      properties.push(Object.freeze({
        kind: 'automerge.property',
        ownerObjectId: objectId,
        path: childPath,
        property,
        value: normalizeAutomergeValue(child),
        ...(childObjectId === undefined ? {} : { childObjectId })
      }));
      const alternatives = Array.isArray(value) ? [] : conflictsAt(value, property);
      if (alternatives.length > 1) {
        conflicts.push(Object.freeze({
          kind: 'automerge.conflict',
          ownerObjectId: objectId,
          path: childPath,
          property,
          alternatives: Object.freeze(alternatives.map(([changeHash, candidate]) => {
            const candidateObjectId = objectIdOf(candidate);
            return Object.freeze({
              changeHash,
              value: normalizeAutomergeValue(candidate),
              ...(candidateObjectId === undefined ? {} : { childObjectId: candidateObjectId })
            });
          }))
        }));
      }
      visit(child, childPath);
    }
  };

  visit(doc, Object.freeze([]));
  return Object.freeze({
    basis: automergeBasis(doc),
    completeness: incomplete ? 'unknown' : 'exact',
    objects: Object.freeze(objects),
    properties: Object.freeze(properties),
    conflicts: Object.freeze(conflicts),
    issues: Object.freeze(issues)
  });
};

export const normalizeAutomergeValue = (value: unknown): AutomergeFactValue => {
  if (Automerge.isCounter(value)) return Object.freeze({ '@type': 'automerge-counter', value: Number(value) });
  if (value instanceof Date) return Object.freeze({ '@type': 'date', value: value.toISOString() });
  if (value instanceof Uint8Array) return Object.freeze({ '@type': 'bytes', value: Object.freeze([...value]) });
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : Object.freeze({ '@type': 'unsupported-number' });
  if (Array.isArray(value)) return Object.freeze(value.map(normalizeAutomergeValue));
  if (isRecord(value)) {
    return Object.freeze(Object.fromEntries(Object.entries(value).map(([key, child]) => [key, normalizeAutomergeValue(child)])));
  }
  return Object.freeze({ '@type': 'unsupported', jsType: typeof value });
};

export const conflictsAt = (owner: object, property: string | number): readonly (readonly [string, unknown])[] => {
  const conflicts = Automerge.getConflicts(owner as Record<string, unknown>, String(property));
  return Object.entries(conflicts ?? {}).sort(([left], [right]) => comparePortableStrings(left, right));
};

const objectIdOf = (value: unknown): string | undefined => {
  if (!isTraversable(value)) return undefined;
  const objectId = Automerge.getObjectId(value);
  return typeof objectId === 'string' ? objectId : undefined;
};

const isTraversable = (value: unknown): value is object =>
  value !== null && typeof value === 'object' && !Automerge.isCounter(value) && !(value instanceof Date) && !(value instanceof Uint8Array);

const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
