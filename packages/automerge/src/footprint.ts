import { canonicalizeJson, type JsonValue } from '@tarstate/core/foundation';
import type { Footprint, FootprintRelation } from '@tarstate/core/source';
import { comparePortableStrings } from './portable-order.js';
import type { AutomergePath } from './projection.js';

export type AutomergePathFootprintEntry = {
  readonly scope: 'exact' | 'subtree';
  readonly path: AutomergePath;
};

export type AutomergePathFootprint = {
  readonly kind: 'automerge-paths';
  readonly entries: readonly AutomergePathFootprintEntry[];
};

/** Pure, canonical construction of an Automerge path footprint. */
export const automergePathFootprint = (
  entries: readonly AutomergePathFootprintEntry[]
): AutomergePathFootprint => Object.freeze({
  kind: 'automerge-paths',
  entries: Object.freeze(normalizeFootprintEntries(entries))
});

/** Pure containment and overlap algebra over adopted footprint values. */
export const relateAutomergeFootprints = (
  left: Footprint,
  right: Footprint
): FootprintRelation => {
  const normalizedLeft = parseFootprint(left);
  const normalizedRight = parseFootprint(right);
  if (normalizedLeft === undefined || normalizedRight === undefined) return 'unknown';

  const leftInRight = containedByFootprint(normalizedLeft, normalizedRight);
  const rightInLeft = containedByFootprint(normalizedRight, normalizedLeft);
  if (leftInRight && rightInLeft) return 'equal';
  if (leftInRight) return 'contained_by';
  if (rightInLeft) return 'contains';

  const intersects = normalizedLeft.some((entry) =>
    normalizedRight.some((other) => entriesIntersect(entry, other))
  );
  return intersects ? 'overlaps' : 'disjoint';
};

const containedByFootprint = (
  candidates: readonly AutomergePathFootprintEntry[],
  bounds: readonly AutomergePathFootprintEntry[]
): boolean => candidates.every((candidate) => bounds.some((bound) => entryContainedBy(candidate, bound)));

const parseFootprint = (
  value: Footprint
): readonly AutomergePathFootprintEntry[] | undefined => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const candidate = value as { readonly kind?: unknown; readonly entries?: unknown };
  if (candidate.kind !== 'automerge-paths' || !Array.isArray(candidate.entries)) return undefined;

  const entries: AutomergePathFootprintEntry[] = [];
  for (const raw of candidate.entries) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
    const entry = raw as { readonly scope?: unknown; readonly path?: unknown };
    if ((entry.scope !== 'exact' && entry.scope !== 'subtree')
      || !Array.isArray(entry.path)
      || entry.path.some((part) => typeof part !== 'string' && typeof part !== 'number')) {
      return undefined;
    }
    entries.push({ scope: entry.scope, path: entry.path as AutomergePath });
  }
  return normalizeFootprintEntries(entries);
};

const normalizeFootprintEntries = (
  entries: readonly AutomergePathFootprintEntry[]
): AutomergePathFootprintEntry[] => {
  const byIdentity = new Map<string, AutomergePathFootprintEntry>();
  for (const entry of entries) {
    const normalized = Object.freeze({
      scope: entry.scope,
      path: Object.freeze([...entry.path])
    }) satisfies AutomergePathFootprintEntry;
    byIdentity.set(canonicalizeJson(normalized as unknown as JsonValue), normalized);
  }
  return [...byIdentity.values()].sort((left, right) => comparePortableStrings(
    canonicalizeJson(left as unknown as JsonValue),
    canonicalizeJson(right as unknown as JsonValue)
  ));
};

const entryContainedBy = (
  candidate: AutomergePathFootprintEntry,
  bound: AutomergePathFootprintEntry
): boolean => {
  if (bound.scope === 'exact') {
    return candidate.scope === 'exact' && samePath(candidate.path, bound.path);
  }
  return pathStartsWith(candidate.path, bound.path);
};

const entriesIntersect = (
  left: AutomergePathFootprintEntry,
  right: AutomergePathFootprintEntry
): boolean => {
  if (left.scope === 'exact' && right.scope === 'exact') {
    return samePath(left.path, right.path);
  }
  if (left.scope === 'subtree' && right.scope === 'subtree') {
    return pathStartsWith(left.path, right.path) || pathStartsWith(right.path, left.path);
  }
  const exact = left.scope === 'exact' ? left : right;
  const subtree = left.scope === 'subtree' ? left : right;
  return pathStartsWith(exact.path, subtree.path);
};

const pathStartsWith = (path: AutomergePath, prefix: AutomergePath): boolean =>
  prefix.length <= path.length
  && prefix.every((part, index) => Object.is(part, path[index]));

const samePath = (left: AutomergePath, right: AutomergePath): boolean =>
  left.length === right.length && pathStartsWith(left, right);
