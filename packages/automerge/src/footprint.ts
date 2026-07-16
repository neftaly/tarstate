import { canonicalizeJson, type JsonValue } from '@tarstate/core';
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

const ownedAutomergeFootprints = new WeakSet<object>();

/** Pure, canonical construction of an Automerge path footprint. */
export const automergePathFootprint = (
  entries: readonly AutomergePathFootprintEntry[]
): AutomergePathFootprint => {
  const footprint = Object.freeze({
    kind: 'automerge-paths' as const,
    entries: Object.freeze(normalizeFootprintEntries(entries))
  });
  ownedAutomergeFootprints.add(footprint);
  return footprint;
};

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

export type AutomergeFootprintOverlap =
  | { readonly status: 'disjoint' }
  | { readonly status: 'unknown'; readonly footprintIndex: number }
  | { readonly status: 'overlap'; readonly leftIndex: number; readonly rightIndex: number };

/** Finds the first cross-footprint path overlap in path-depth time rather than comparing every pair. */
export const findAutomergeFootprintOverlap = (footprints: readonly Footprint[]): AutomergeFootprintOverlap => {
  const root = pathTrieNode();
  for (let footprintIndex = 0; footprintIndex < footprints.length; footprintIndex += 1) {
    const entries = parseFootprint(footprints[footprintIndex] as Footprint);
    if (entries === undefined) return { status: 'unknown', footprintIndex };
    for (const entry of entries) {
      const overlap = insertTrieEntry(root, entry, footprintIndex);
      if (overlap !== undefined) return { status: 'overlap', leftIndex: overlap, rightIndex: footprintIndex };
    }
  }
  return { status: 'disjoint' };
};

type PathTrieNode = {
  readonly children: Map<string, PathTrieNode>;
  exactOwner?: number;
  subtreeOwner?: number;
  firstOwner?: number;
  secondOwner?: number;
};

const pathTrieNode = (): PathTrieNode => ({ children: new Map() });

const insertTrieEntry = (
  root: PathTrieNode,
  entry: AutomergePathFootprintEntry,
  owner: number
): number | undefined => {
  const visited = [root];
  let node = root;
  for (const part of entry.path) {
    if (node.subtreeOwner !== undefined && node.subtreeOwner !== owner) return node.subtreeOwner;
    const key = typeof part === 'string' ? 's' + part : 'n' + String(Object.is(part, -0) ? 0 : part);
    const child = node.children.get(key) ?? pathTrieNode();
    if (!node.children.has(key)) node.children.set(key, child);
    node = child;
    visited.push(node);
  }
  if (entry.scope === 'exact') {
    if (node.subtreeOwner !== undefined && node.subtreeOwner !== owner) return node.subtreeOwner;
    if (node.exactOwner !== undefined && node.exactOwner !== owner) return node.exactOwner;
    node.exactOwner = owner;
  } else {
    const descendantOwner = node.firstOwner !== undefined && node.firstOwner !== owner
      ? node.firstOwner
      : node.secondOwner !== undefined && node.secondOwner !== owner
        ? node.secondOwner
        : undefined;
    if (descendantOwner !== undefined) return descendantOwner;
    node.subtreeOwner = owner;
  }
  for (const visitedNode of visited) {
    if (visitedNode.firstOwner === undefined) visitedNode.firstOwner = owner;
    else if (visitedNode.firstOwner !== owner && visitedNode.secondOwner === undefined) visitedNode.secondOwner = owner;
  }
  return undefined;
};

const containedByFootprint = (
  candidates: readonly AutomergePathFootprintEntry[],
  bounds: readonly AutomergePathFootprintEntry[]
): boolean => candidates.every((candidate) => bounds.some((bound) => entryContainedBy(candidate, bound)));

const parseFootprint = (
  value: Footprint
): readonly AutomergePathFootprintEntry[] | undefined => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  if (ownedAutomergeFootprints.has(value)) return (value as AutomergePathFootprint).entries;
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
  return [...byIdentity.entries()]
    .sort(([left], [right]) => comparePortableStrings(left, right))
    .map(([, entry]) => entry);
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
