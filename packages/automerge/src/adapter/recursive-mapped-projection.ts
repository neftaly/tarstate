import * as Automerge from '@automerge/automerge';
import type { Patch as AutomergePatch } from '@automerge/automerge';
import type {
  RecursiveArrayCollectionMapping
} from '@tarstate/core/schema';
import type { MappedStorageOccurrence } from '@tarstate/core/schema/adapter';
import type { AutomergePath } from '../document/projection.js';
import { valueAtAutomergePath } from './path-access.js';
import type { AutomergeMappedStorageRow } from './mapped-storage-model.js';

type RecursiveProjectionEntry = {
  readonly objectId: string;
  readonly parentObjectId: string | undefined;
  readonly index: number;
  readonly depth: number;
  readonly path: AutomergePath;
};

export type RecursiveMappedProjectionState = {
  readonly rows: readonly AutomergeMappedStorageRow[];
  readonly entries: readonly RecursiveProjectionEntry[];
  readonly byPath: ReadonlyMap<string, number>;
};

export type RecursiveMappedProjectionUpdate =
  | { readonly kind: 'fallback' }
  | { readonly kind: 'unchanged'; readonly state: RecursiveMappedProjectionState }
  | {
      readonly kind: 'changed';
      readonly rows: readonly AutomergeMappedStorageRow[];
      readonly state: RecursiveMappedProjectionState;
    };

type ProjectOccurrence = (
  occurrence: MappedStorageOccurrence,
  previous?: AutomergeMappedStorageRow
) => AutomergeMappedStorageRow | undefined;

type ProjectPatches = (
  previous: AutomergeMappedStorageRow,
  occurrencePath: AutomergePath,
  patches: readonly AutomergePatch[]
) => AutomergeMappedStorageRow | undefined;

export const createRecursiveMappedProjectionState = (
  collection: RecursiveArrayCollectionMapping,
  rows: readonly AutomergeMappedStorageRow[]
): RecursiveMappedProjectionState | undefined => {
  const entries: RecursiveProjectionEntry[] = [];
  const byPath = new Map<string, number>();
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index] as AutomergeMappedStorageRow;
    const position = row.storagePath.at(-1);
    const depth = recursiveDepth(collection, row.storagePath);
    const objectId = typeof row.locator.token === 'string'
      ? row.locator.token
      : undefined;
    if (typeof position !== 'number'
      || depth === undefined
      || objectId === undefined) {
      return undefined;
    }
    const parentPath = depth === 0
      ? undefined
      : row.storagePath.slice(
          0,
          -(collection.descendants.length + 1)
        ) as AutomergePath;
    let parentObjectId: string | undefined;
    if (parentPath !== undefined) {
      const parentPosition = byPath.get(pathKey(parentPath));
      const parentToken = parentPosition === undefined
        ? undefined
        : rows[parentPosition]?.locator.token;
      if (typeof parentToken !== 'string') return undefined;
      parentObjectId = parentToken;
    }
    const identity = { objectId, parentObjectId, index: position, depth };
    const entry = { ...identity, path: row.storagePath };
    entries.push(entry);
    byPath.set(pathKey(row.storagePath), index);
  }
  return {
    rows,
    entries,
    byPath
  };
};

export const updateRecursiveMappedProjection = <T extends object>(input: {
  readonly storage: Automerge.Doc<T>;
  readonly collection: RecursiveArrayCollectionMapping;
  readonly valuePaths: readonly AutomergePath[];
  readonly patches: readonly AutomergePatch[];
  readonly previous: RecursiveMappedProjectionState;
  readonly inspect: () => {
    readonly occurrences: readonly MappedStorageOccurrence[];
    readonly completeness: 'exact' | 'unknown';
    readonly issues: readonly unknown[];
  };
  readonly project: ProjectOccurrence;
  readonly projectPatches?: ProjectPatches;
  readonly rowKey: (row: AutomergeMappedStorageRow) => string;
}): RecursiveMappedProjectionUpdate => {
  return input.patches.some((patch) =>
    patchChangesCollection(patch, input.collection, input.previous.byPath))
    ? updateStructure(input)
    : updateValues(input);
};

const updateValues = <T extends object>(input: {
  readonly storage: Automerge.Doc<T>;
  readonly collection: RecursiveArrayCollectionMapping;
  readonly valuePaths: readonly AutomergePath[];
  readonly patches: readonly AutomergePatch[];
  readonly previous: RecursiveMappedProjectionState;
  readonly project: ProjectOccurrence;
  readonly projectPatches?: ProjectPatches;
  readonly rowKey: (row: AutomergeMappedStorageRow) => string;
}): RecursiveMappedProjectionUpdate => {
  const dirty = changedPositions(input.patches, input.previous, input.valuePaths);
  if (dirty.size === 0) return { kind: 'unchanged', state: input.previous };
  let rows: AutomergeMappedStorageRow[] | undefined;
  let keyChanged = false;
  for (const [position, occurrencePatches] of dirty) {
    const entry = input.previous.entries[position] as RecursiveProjectionEntry;
    const previousRow = input.previous.rows[position] as AutomergeMappedStorageRow;
    const patched = input.projectPatches?.(
      previousRow,
      entry.path,
      occurrencePatches
    );
    const occurrence = patched === undefined
      ? occurrenceAtPath(input.storage, input.collection, entry.path)
      : undefined;
    if (patched === undefined && occurrence === undefined) return { kind: 'fallback' };
    const row = patched ?? input.project(
      occurrence as MappedStorageOccurrence,
      previousRow
    );
    if (row === undefined) return { kind: 'fallback' };
    if (row === previousRow) continue;
    rows ??= [...input.previous.rows];
    rows[position] = row;
    keyChanged ||= row.key !== previousRow.key
      && input.rowKey(row) !== input.rowKey(previousRow);
  }
  if (rows !== undefined
    && keyChanged
    && hasDuplicateRowKey(rows, input.rowKey)) {
    return { kind: 'fallback' };
  }
  return rows === undefined
    ? { kind: 'unchanged', state: input.previous }
    : {
        kind: 'changed',
        rows,
        state: { ...input.previous, rows }
      };
};

const hasDuplicateRowKey = (
  rows: readonly AutomergeMappedStorageRow[],
  rowKey: (row: AutomergeMappedStorageRow) => string
): boolean => {
  const keys = new Set<string>();
  for (const row of rows) {
    const key = rowKey(row);
    if (keys.has(key)) return true;
    keys.add(key);
  }
  return false;
};

const updateStructure = <T extends object>(input: {
  readonly storage: Automerge.Doc<T>;
  readonly collection: RecursiveArrayCollectionMapping;
  readonly valuePaths: readonly AutomergePath[];
  readonly patches: readonly AutomergePatch[];
  readonly previous: RecursiveMappedProjectionState;
  readonly inspect: () => {
    readonly occurrences: readonly MappedStorageOccurrence[];
    readonly completeness: 'exact' | 'unknown';
    readonly issues: readonly unknown[];
  };
  readonly project: ProjectOccurrence;
  readonly rowKey: (row: AutomergeMappedStorageRow) => string;
}): RecursiveMappedProjectionUpdate => {
  const inspected = input.inspect();
  if (inspected.completeness !== 'exact' || inspected.issues.length > 0) {
    return { kind: 'fallback' };
  }
  const rows: AutomergeMappedStorageRow[] = [];
  const entries: RecursiveProjectionEntry[] = [];
  const byPath = new Map<string, number>();
  const previousByObjectId = indexEntriesByObjectId(input.previous.entries);
  const keys = new Set<string>();
  let changed = inspected.occurrences.length !== input.previous.entries.length;
  for (const occurrence of inspected.occurrences) {
    const identity = occurrenceIdentity(occurrence);
    if (identity === undefined) return { kind: 'fallback' };
    const previousIndex = previousByObjectId.get(identity.objectId);
    const previous = previousIndex === undefined
      ? undefined
      : input.previous.entries[previousIndex];
    const retainedRow = previousIndex === undefined
      ? undefined
      : input.previous.rows[previousIndex] as AutomergeMappedStorageRow;
    const metadataChanged = previous === undefined
      || previous.parentObjectId !== identity.parentObjectId
      || previous.index !== identity.index
      || previous.depth !== identity.depth;
    const valuesChanged = occurrenceAffectedByPatches(
      occurrence.absolutePath,
      input.patches,
      input.valuePaths
    );
    let row: AutomergeMappedStorageRow | undefined;
    if (previous === undefined) {
      row = input.project(occurrence, retainedRow);
    } else if (metadataChanged || valuesChanged) {
      row = input.project(
        occurrence,
        retainedRow as AutomergeMappedStorageRow
      );
    } else if (!samePath(previous.path, occurrence.absolutePath)) {
      row = Object.freeze({
        ...(retainedRow as AutomergeMappedStorageRow),
        storagePath: Object.freeze([...occurrence.absolutePath]) as AutomergePath
      });
    } else {
      row = retainedRow as AutomergeMappedStorageRow;
    }
    if (row === undefined) return { kind: 'fallback' };
    const key = input.rowKey(row);
    if (keys.has(key)) return { kind: 'fallback' };
    keys.add(key);
    const path = row.storagePath;
    const entry = { ...identity, path };
    if (row !== retainedRow) changed = true;
    rows.push(row);
    entries.push(entry);
    byPath.set(pathKey(path), entries.length - 1);
  }
  return changed
    ? {
        kind: 'changed',
        rows,
        state: {
          rows,
          entries,
          byPath
        }
      }
    : { kind: 'unchanged', state: input.previous };
};

const indexEntriesByObjectId = (
  entries: readonly RecursiveProjectionEntry[]
): ReadonlyMap<string, number> => {
  const positions = new Map<string, number>();
  for (let index = 0; index < entries.length; index += 1) {
    positions.set((entries[index] as RecursiveProjectionEntry).objectId, index);
  }
  return positions;
};

const patchChangesCollection = (
  patch: AutomergePatch,
  collection: RecursiveArrayCollectionMapping,
  occurrencePaths: ReadonlyMap<string, number>
): boolean => isSameOrDirectChild(patch.path, collection.path)
  || isRecursiveCollectionPath(
    patch.path,
    collection.descendants,
    occurrencePaths
  )
  || isRecursiveCollectionPath(
    patch.path.slice(0, -1),
    collection.descendants,
    occurrencePaths
  );

const isRecursiveCollectionPath = (
  path: readonly (string | number)[],
  descendants: readonly (string | number)[],
  occurrencePaths: ReadonlyMap<string, number>
): boolean => {
  if (!pathEndsWith(path, descendants)) return false;
  const occurrencePath = path.slice(0, -descendants.length);
  return occurrencePaths.has(pathKey(occurrencePath));
};

const isSameOrDirectChild = (
  path: readonly (string | number)[],
  collectionPath: readonly (string | number)[]
): boolean => samePath(path, collectionPath)
  || (path.length === collectionPath.length + 1
    && pathStartsWith(path, collectionPath));

const pathEndsWith = (
  path: readonly (string | number)[],
  suffix: readonly (string | number)[]
): boolean => suffix.length > 0
  && suffix.length <= path.length
  && suffix.every((part, index) =>
    Object.is(part, path[path.length - suffix.length + index]));

const changedPositions = (
  patches: readonly AutomergePatch[],
  previous: RecursiveMappedProjectionState,
  valuePaths: readonly AutomergePath[]
): ReadonlyMap<number, readonly AutomergePatch[]> => {
  const dirty = new Map<number, AutomergePatch[]>();
  for (const patch of patches) {
    let position: number | undefined;
    let ownerPath: AutomergePath | undefined;
    for (let length = patch.path.length; length > 0; length -= 1) {
      const path = patch.path.slice(0, length) as AutomergePath;
      position = previous.byPath.get(pathKey(path));
      if (position !== undefined) {
        ownerPath = path;
        break;
      }
    }
    if (position === undefined || ownerPath === undefined) continue;
    const relative = patch.path.slice(ownerPath.length);
    if (relative.length === 0
      || valuePaths.some((path) => pathsIntersect(relative, path))) {
      const patchesForPosition = dirty.get(position);
      if (patchesForPosition === undefined) dirty.set(position, [patch]);
      else patchesForPosition.push(patch);
    }
  }
  return dirty;
};

const occurrenceAffectedByPatches = (
  occurrencePath: readonly (string | number)[],
  patches: readonly AutomergePatch[],
  valuePaths: readonly AutomergePath[]
): boolean => patches.some((patch) => {
  if (!pathStartsWith(patch.path, occurrencePath)) return false;
  const relative = patch.path.slice(occurrencePath.length);
  return relative.length === 0
    || valuePaths.some((path) => pathsIntersect(relative, path));
});

const occurrenceAtPath = <T extends object>(
  storage: Automerge.Doc<T>,
  collection: RecursiveArrayCollectionMapping,
  path: AutomergePath
): MappedStorageOccurrence | undefined => {
  const index = path.at(-1);
  if (typeof index !== 'number') return undefined;
  const depth = recursiveDepth(collection, path);
  if (depth === undefined) return undefined;
  const candidate = valueAtAutomergePath(storage, path);
  if (candidate === undefined) return undefined;
  const parentPath = depth === 0
    ? undefined
    : path.slice(0, -(collection.descendants.length + 1)) as AutomergePath;
  const parentCandidate = parentPath === undefined
    ? undefined
    : valueAtAutomergePath(storage, parentPath);
  return {
    candidate,
    ...(parentCandidate === undefined ? {} : { parentCandidate }),
    absolutePath: path,
    locator: {
      kind: 'recursive-array-position',
      collectionPath: path.slice(0, -1),
      index,
      depth,
      durable: false
    }
  };
};

const occurrenceIdentity = (
  occurrence: MappedStorageOccurrence
): Omit<RecursiveProjectionEntry, 'path'> | undefined => {
  const objectId = automergeObjectId(occurrence.candidate);
  if (objectId === undefined
    || occurrence.locator.kind !== 'recursive-array-position') {
    return undefined;
  }
  const parentObjectId = occurrence.parentCandidate === undefined
    ? undefined
    : automergeObjectId(occurrence.parentCandidate);
  if (occurrence.parentCandidate !== undefined && parentObjectId === undefined) {
    return undefined;
  }
  return {
    objectId,
    parentObjectId,
    index: occurrence.locator.index,
    depth: occurrence.locator.depth
  };
};

const recursiveDepth = (
  collection: RecursiveArrayCollectionMapping,
  occurrencePath: readonly (string | number)[]
): number | undefined => {
  const tailLength = occurrencePath.length - collection.path.length;
  const stride = collection.descendants.length + 1;
  if (tailLength < 1 || (tailLength - 1) % stride !== 0) return undefined;
  return (tailLength - 1) / stride;
};

const automergeObjectId = (value: unknown): string | undefined => {
  if (value === null || typeof value !== 'object') return undefined;
  try {
    return Automerge.getObjectId(value) ?? undefined;
  } catch {
    return undefined;
  }
};

const pathsIntersect = (
  left: readonly (string | number)[],
  right: readonly (string | number)[]
): boolean => pathStartsWith(left, right) || pathStartsWith(right, left);

const samePath = (
  left: readonly (string | number)[],
  right: readonly (string | number)[]
): boolean => left.length === right.length && pathStartsWith(left, right);

const pathStartsWith = (
  path: readonly (string | number)[],
  prefix: readonly (string | number)[]
): boolean => prefix.length <= path.length
  && prefix.every((part, index) => Object.is(part, path[index]));

const pathKey = (path: readonly (string | number)[]): string => {
  let key = '';
  for (const part of path) {
    key += typeof part === 'number'
      ? `n${part};`
      : `s${part.length}:${part}`;
  }
  return key;
};
