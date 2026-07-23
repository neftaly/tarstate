import * as Automerge from '@automerge/automerge';
import { canonicalizeJson, type JsonValue } from '@tarstate/core';
import type {
  MappingLocator,
  RelationStorageMapping
} from '@tarstate/core/schema';
import { conflictsAt, type AutomergePath } from '../document/projection.js';
import type { AutomergePathFootprintEntry } from './footprint.js';
import { valueAtAutomergePath } from './path-access.js';

export const mappedReadEntries = (
  mapping: RelationStorageMapping,
  valuePaths: readonly AutomergePath[]
): readonly AutomergePathFootprintEntry[] => {
  const collectionPath = mapping.collection.path as AutomergePath;
  if (mapping.collection.kind === 'object-map'
    || mapping.collection.kind === 'array'
    || mapping.collection.kind === 'recursive-array') {
    return Object.freeze([{ scope: 'subtree', path: collectionPath }]);
  }
  const entries: AutomergePathFootprintEntry[] = [{ scope: 'exact', path: collectionPath }];
  for (const relativePath of valuePaths) {
    const absolutePath = [...collectionPath, ...relativePath] as AutomergePath;
    for (let length = collectionPath.length + 1; length < absolutePath.length; length += 1) {
      entries.push({ scope: 'exact', path: absolutePath.slice(0, length) as AutomergePath });
    }
    entries.push({ scope: 'subtree', path: absolutePath });
  }
  return Object.freeze(entries);
};

export const mappedWriteEntries = (
  mapping: RelationStorageMapping
): readonly AutomergePathFootprintEntry[] => {
  if (mapping.collection.kind === 'object-map'
    || mapping.collection.kind === 'array'
    || mapping.collection.kind === 'recursive-array') {
    return [{ scope: 'subtree', path: mapping.collection.path as AutomergePath }];
  }
  return Object.values(mapping.fields).flatMap((field) => field.kind !== 'absent'
    && field.kind !== 'source-metadata'
    && Object.keys(field.write).length > 0
    ? [{ scope: 'exact' as const, path: [...mapping.collection.path, ...field.path] as AutomergePath }]
    : []);
};

export const locateProjectedCandidate = (
  doc: object,
  mapping: RelationStorageMapping,
  locator: MappingLocator
): {
  readonly candidate: unknown;
  readonly path: AutomergePath;
  readonly collectionConflict?: { readonly code: string; readonly changeHashes: readonly string[] };
} | { readonly issue: string } => {
  const collectionPath = mapping.collection.path as AutomergePath;
  if (mapping.collection.kind === 'singleton') {
    if (locator.kind !== 'singleton') return { issue: 'mapping.locator_invalid' };
    const candidate = valueAtAutomergePath(doc, collectionPath);
    if (!isRecord(candidate)) return { issue: 'mapping.locator_invalid' };
    const alternatives = conflictsAtPath(doc, collectionPath);
    return {
      candidate,
      path: collectionPath,
      ...(alternatives.length < 2
        ? {}
        : { collectionConflict: { code: 'automerge.conflict_observed', changeHashes: alternatives.map(([changeHash]) => changeHash) } })
    };
  }
  if (mapping.collection.kind === 'array') {
    if (locator.kind !== 'array-position') return { issue: 'mapping.locator_invalid' };
    const collection = valueAtAutomergePath(doc, collectionPath);
    if (!Array.isArray(collection) || locator.index >= collection.length) {
      return { issue: 'mapping.locator_invalid' };
    }
    return {
      candidate: collection[locator.index],
      path: [...collectionPath, locator.index] as AutomergePath
    };
  }
  if (mapping.collection.kind === 'recursive-array') {
    if (locator.kind !== 'recursive-array-position') {
      return { issue: 'mapping.locator_invalid' };
    }
    const path = [...locator.collectionPath, locator.index] as AutomergePath;
    const candidate = valueAtAutomergePath(doc, path);
    if (candidate === undefined) return { issue: 'mapping.locator_invalid' };
    return { candidate, path };
  }
  if (mapping.collection.kind !== 'object-map' || locator.kind !== 'object-map-key') {
    return { issue: 'mapping.locator_invalid' };
  }
  const collection = valueAtAutomergePath(doc, collectionPath);
  if (!isRecord(collection)) return { issue: 'mapping.locator_invalid' };
  const path = [...collectionPath, locator.key] as AutomergePath;
  const alternatives = conflictsAt(collection, locator.key);
  return {
    candidate: collection[locator.key],
    path,
    ...(alternatives.length < 2
      ? {}
      : { collectionConflict: { code: 'automerge.map_key_conflict', changeHashes: alternatives.map(([changeHash]) => changeHash) } })
  };
};

export const affectedMappedRelations = <T extends object>(
  sourceId: string,
  storage: Automerge.Doc<T>,
  previous: { readonly sourceId: string; readonly heads: readonly string[] },
  relationReadEntries: ReadonlyMap<string, readonly AutomergePathFootprintEntry[]>
): ReadonlySet<string> | undefined => {
  if (sourceId !== previous.sourceId || !Automerge.hasHeads(storage, [...previous.heads])) return undefined;
  const patches = Automerge.diff(storage, [...previous.heads], Automerge.getHeads(storage));
  const affected = new Set<string>();
  for (const [relationId, entries] of relationReadEntries) {
    if (patches.some(({ path }) => entries.some((entry) => patchAffectsEntry(path, entry)))) {
      affected.add(relationId);
    }
  }
  return affected;
};

export const conflictsAlongMappedPaths = (
  doc: object,
  rowPath: AutomergePath,
  relativePaths: readonly AutomergePath[]
): readonly { readonly path: AutomergePath; readonly changeHashes: readonly string[] }[] => {
  const conflicts = new Map<string, { readonly path: AutomergePath; readonly changeHashes: readonly string[] }>();
  for (const relative of relativePaths) {
    const absolute = [...rowPath, ...relative] as AutomergePath;
    for (let index = rowPath.length; index < absolute.length; index += 1) {
      const owner = valueAtAutomergePath(doc, absolute.slice(0, index) as AutomergePath);
      if (owner === null || typeof owner !== 'object') break;
      if (Array.isArray(owner)) continue;
      const alternatives = conflictsAt(owner, absolute[index] as string | number);
      if (alternatives.length < 2) continue;
      const path = absolute.slice(0, index + 1) as AutomergePath;
      conflicts.set(canonicalizeJson(path as JsonValue), {
        path: Object.freeze([...path]),
        changeHashes: Object.freeze(alternatives.map(([changeHash]) => changeHash))
      });
      break;
    }
  }
  return Object.freeze([...conflicts.values()]);
};

const conflictsAtPath = (
  doc: object,
  path: AutomergePath
): readonly (readonly [string, unknown])[] => {
  if (path.length === 0) return [];
  const owner = valueAtAutomergePath(doc, path.slice(0, -1) as AutomergePath);
  return owner !== null && typeof owner === 'object' && !Array.isArray(owner)
    ? conflictsAt(owner, path[path.length - 1] as string | number)
    : [];
};

const patchAffectsEntry = (
  patchPath: readonly (string | number)[],
  entry: AutomergePathFootprintEntry
): boolean => entry.scope === 'subtree'
  ? pathsIntersect(patchPath, entry.path)
  : samePath(patchPath, entry.path) || pathStartsWith(entry.path, patchPath);

const pathsIntersect = (
  left: readonly (string | number)[],
  right: readonly (string | number)[]
): boolean => {
  const shared = Math.min(left.length, right.length);
  for (let index = 0; index < shared; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
};

const samePath = (
  left: readonly (string | number)[],
  right: readonly (string | number)[]
): boolean => left.length === right.length && pathStartsWith(left, right);

const pathStartsWith = (
  path: readonly (string | number)[],
  prefix: readonly (string | number)[]
): boolean => prefix.length <= path.length
  && prefix.every((part, index) => Object.is(part, path[index]));

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
