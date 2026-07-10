import * as Automerge from '@automerge/automerge';
import type { CapabilityRef, JsonValue } from '@tarstate/core';
import { canonicalAutomergeJson, sha256AutomergeJson } from './wire.js';

export type AutomergeMovePath = readonly (string | number)[];

export const automergeMoveMetadataProperty = '__tarstateMovesV1' as const;

export const automergeCopyRelocateCapability: CapabilityRef = Object.freeze({
  id: 'urn:tarstate:capability:entity/copy-relocate',
  version: '1',
  contractHash: 'sha256:0403e04d4800fc6e143d8e91c98605e72445a0af94d58c7bbcfc7cf450d1d44b'
});

export const automergeMoveCapability: CapabilityRef = Object.freeze({
  id: 'urn:tarstate:capability:entity/move',
  version: '1',
  contractHash: 'sha256:4406275cc0916b33bf7cde7ef69f07be2788f0fe1e903b792f44ff3e238dcdc6'
});

export const automergeIdentityPreservingMoveCapability: CapabilityRef = Object.freeze({
  id: 'urn:tarstate:capability:entity/identity-preserving-move',
  version: '1',
  contractHash: 'sha256:0a6ab736c23054f2b6dac6c5baa671769a078ac57c3540b73e63878c26442cb5'
});

export type AutomergeMoveSupport =
  | {
      readonly available: true;
      readonly mechanism: 'copyRelocate';
      readonly capabilities: readonly [CapabilityRef, CapabilityRef];
      readonly preservationLosses: readonly AutomergeCopyRelocateLossCode[];
    }
  | { readonly available: false; readonly issueCode: 'automerge.move_metadata_collision' | 'automerge.move_metadata_conflict' };

export const automergeCopyRelocateLossCodes = [
  'automerge.conflicts_not_copied',
  'automerge.concurrent_old_subtree_edits_not_forwarded',
  'automerge.counter_identity_changed',
  'automerge.descendant_mapping_incomplete',
  'automerge.descendant_object_identity_changed',
  'automerge.list_element_identity_changed',
  'automerge.root_object_identity_changed',
  'automerge.text_identity_changed'
] as const;

export type AutomergeCopyRelocateLossCode = typeof automergeCopyRelocateLossCodes[number];

export type AutomergeMoveRecordV1 = {
  readonly formatVersion: 1;
  readonly operationEpoch: string;
  readonly operationId: string;
  readonly statementIndex: number;
  readonly beforeHeads: readonly string[];
  readonly fromPath: AutomergeMovePath;
  readonly toPath: AutomergeMovePath;
  readonly oldRootObjectId: string;
  readonly newRootObjectId: string;
  readonly descendants: readonly {
    readonly fromObjectId: string;
    readonly toObjectId: string;
    readonly relativePath: AutomergeMovePath;
  }[];
  readonly mechanism: CapabilityRef;
  readonly preservationLosses: readonly AutomergeCopyRelocateLossCode[];
};

export type AutomergeCopyRelocateResult<T extends object> = {
  readonly doc: Automerge.Doc<T>;
  readonly recordId: `sha256:${string}`;
  readonly record: AutomergeMoveRecordV1;
  readonly changed: boolean;
};

export type AutomergeCopyRelocateInput = {
  readonly operationEpoch: string;
  readonly operationId: string;
  readonly statementIndex: number;
  readonly fromPath: AutomergeMovePath;
  readonly toPath: AutomergeMovePath;
};

export class AutomergeMoveError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'AutomergeMoveError';
  }
}

/** The current adapter deliberately never advertises identityPreservingMove. */
export const inspectAutomergeMoveSupport = (doc: object): AutomergeMoveSupport => {
  const root = doc as Record<string, unknown>;
  const alternatives = (() => {
    try { return Automerge.getConflicts(root, automergeMoveMetadataProperty); }
    catch { return undefined; }
  })();
  if (Object.keys(alternatives ?? {}).length > 1) return { available: false, issueCode: 'automerge.move_metadata_conflict' };
  const metadata = root[automergeMoveMetadataProperty];
  if (metadata !== undefined && !isPlainRecord(metadata)) return { available: false, issueCode: 'automerge.move_metadata_collision' };
  return {
    available: true,
    mechanism: 'copyRelocate',
    capabilities: [automergeCopyRelocateCapability, automergeMoveCapability],
    preservationLosses: automergeCopyRelocateLossCodes
  };
};

/**
 * Hosts can reserve the shared metadata map before handing a document to
 * concurrent writers. This avoids concurrent first-use assignments creating a
 * root-property conflict. Existing documents remain lazily compatible.
 */
export const initializeAutomergeMoveMetadata = <T extends object>(doc: Automerge.Doc<T>): Automerge.Doc<T> => {
  const support = inspectAutomergeMoveSupport(doc);
  if (!support.available) throw new AutomergeMoveError(support.issueCode, 'Automerge copy relocation is unavailable for this document');
  if ((doc as Record<string, unknown>)[automergeMoveMetadataProperty] !== undefined) return doc;
  return Automerge.change(doc, { message: 'initialize tarstate move metadata', time: 0 }, (draft) => {
    (draft as Record<string, unknown>)[automergeMoveMetadataProperty] = {};
  });
};

/**
 * Automerge currently has no public identity-preserving subtree relocation.
 * This fallback copies current values and atomically records every known loss.
 */
export const copyRelocateAutomerge = async <T extends object>(
  doc: Automerge.Doc<T>,
  input: AutomergeCopyRelocateInput
): Promise<AutomergeCopyRelocateResult<T>> => {
  validateMovePaths(input.fromPath, input.toPath);
  const support = inspectAutomergeMoveSupport(doc);
  if (!support.available) throw new AutomergeMoveError(support.issueCode, 'Automerge copy relocation is unavailable for this document');
  const recordId = await sha256AutomergeJson({
    operationEpoch: input.operationEpoch,
    operationId: input.operationId,
    statementIndex: input.statementIndex
  });
  const existing = readMoveRecord(doc, recordId);
  if (existing !== undefined) {
    if (!sameIntent(existing, input)) {
      throw new AutomergeMoveError('automerge.move_operation_ambiguous', 'The move operation identity is already bound to different paths');
    }
    return { doc, recordId, record: existing, changed: false };
  }

  const beforeHeads = [...Automerge.getHeads(doc)].sort();
  const source = valueAt(doc, input.fromPath);
  if (!isObjectValue(source)) throw new AutomergeMoveError('automerge.move_source_missing', 'copyRelocate requires an object subtree');
  if (hasAtPath(doc, input.toPath)) throw new AutomergeMoveError('automerge.move_destination_occupied', 'copyRelocate destination is already occupied');
  const oldRootObjectId = Automerge.getObjectId(source);
  if (oldRootObjectId === null) throw new AutomergeMoveError('automerge.move_source_unlocatable', 'copyRelocate source has no Automerge object ID');
  const oldObjects = objectIdsByRelativePath(source);
  let losses = preservationLosses(source);
  let completedRecord: AutomergeMoveRecordV1 | undefined;

  const changed = Automerge.change(doc, { message: 'tarstate copy relocation', time: 0 }, (draft) => {
    const root = draft as unknown as Record<string, unknown>;
    const metadata = root[automergeMoveMetadataProperty];
    if (metadata !== undefined && !isPlainRecord(metadata)) {
      throw new AutomergeMoveError('automerge.move_metadata_collision', 'Reserved Automerge move metadata has an incompatible value');
    }
    if (metadata === undefined) root[automergeMoveMetadataProperty] = {};
    const records = root[automergeMoveMetadataProperty] as Record<string, unknown>;
    if (records[recordId] !== undefined) {
      throw new AutomergeMoveError('automerge.move_operation_ambiguous', 'Move operation record appeared while applying the change');
    }

    setAt(draft, input.toPath, copyAutomergeValue(source));
    const copied = valueAt(draft, input.toPath);
    if (!isObjectValue(copied)) throw new AutomergeMoveError('automerge.move_destination_failed', 'copyRelocate destination was not created');
    const newRootObjectId = Automerge.getObjectId(copied);
    if (newRootObjectId === null) throw new AutomergeMoveError('automerge.move_destination_unlocatable', 'copyRelocate destination has no Automerge object ID');
    const newObjects = objectIdsByRelativePath(copied);
    let descendantMappingIncomplete = false;
    const descendants = [...oldObjects.entries()]
      // The frozen v1 wire vector includes the root pair here as measured by
      // the original spike; oldRootObjectId/newRootObjectId also name it.
      .filter(([path]) => path !== '')
      .flatMap(([path, fromObjectId]) => {
        const toObjectId = newObjects.get(path);
        if (toObjectId === undefined) {
          descendantMappingIncomplete = true;
          return [];
        }
        return [{ fromObjectId, toObjectId, relativePath: parsePathKey(path) }];
      })
      .sort((left, right) => canonicalAutomergeJson(left.relativePath as JsonValue).localeCompare(canonicalAutomergeJson(right.relativePath as JsonValue)));
    if (descendantMappingIncomplete) {
      const present = new Set(losses);
      present.add('automerge.descendant_mapping_incomplete');
      losses = automergeCopyRelocateLossCodes.filter((code) => present.has(code));
    }
    completedRecord = {
      formatVersion: 1,
      operationEpoch: input.operationEpoch,
      operationId: input.operationId,
      statementIndex: input.statementIndex,
      beforeHeads,
      fromPath: [...input.fromPath],
      toPath: [...input.toPath],
      oldRootObjectId,
      newRootObjectId,
      descendants,
      mechanism: automergeCopyRelocateCapability,
      preservationLosses: losses
    };
    records[recordId] = completedRecord as unknown;
    deleteAt(draft, input.fromPath);
  });

  if (completedRecord === undefined) throw new AutomergeMoveError('automerge.move_destination_failed', 'copyRelocate did not complete');
  return { doc: changed, recordId, record: completedRecord, changed: true };
};

export const readMoveRecord = (doc: object, recordId: string): AutomergeMoveRecordV1 | undefined => {
  const metadata = (doc as Record<string, unknown>)[automergeMoveMetadataProperty];
  if (!isPlainRecord(metadata)) return undefined;
  const candidate = metadata[recordId];
  return isMoveRecordV1(candidate) ? candidate : undefined;
};

const sameIntent = (record: AutomergeMoveRecordV1, input: AutomergeCopyRelocateInput): boolean =>
  record.operationEpoch === input.operationEpoch &&
  record.operationId === input.operationId &&
  record.statementIndex === input.statementIndex &&
  canonicalAutomergeJson(record.fromPath as JsonValue) === canonicalAutomergeJson(input.fromPath as JsonValue) &&
  canonicalAutomergeJson(record.toPath as JsonValue) === canonicalAutomergeJson(input.toPath as JsonValue);

const validateMovePaths = (fromPath: AutomergeMovePath, toPath: AutomergeMovePath): void => {
  if (fromPath.length === 0 || toPath.length === 0) throw new AutomergeMoveError('automerge.move_root_unsupported', 'copyRelocate cannot replace the document root');
  if (samePath(fromPath, toPath)) throw new AutomergeMoveError('automerge.move_same_path', 'Move source and destination are identical');
  if (isPathPrefix(fromPath, toPath)) throw new AutomergeMoveError('automerge.move_destination_inside_source', 'Move destination cannot be inside the source subtree');
  if ([...fromPath, ...toPath].some((part) => typeof part === 'number' && (!Number.isInteger(part) || part < 0))) {
    throw new AutomergeMoveError('automerge.move_path_invalid', 'Numeric move path components must be non-negative integers');
  }
};

const samePath = (left: AutomergeMovePath, right: AutomergeMovePath): boolean =>
  left.length === right.length && left.every((part, index) => part === right[index]);

const isPathPrefix = (prefix: AutomergeMovePath, path: AutomergeMovePath): boolean =>
  prefix.length < path.length && prefix.every((part, index) => part === path[index]);

const preservationLosses = (root: object): readonly AutomergeCopyRelocateLossCode[] => {
  const losses = new Set<AutomergeCopyRelocateLossCode>([
    'automerge.conflicts_not_copied',
    'automerge.concurrent_old_subtree_edits_not_forwarded',
    'automerge.root_object_identity_changed'
  ]);
  const visit = (value: unknown, isRoot = false): void => {
    if (Automerge.isCounter(value)) losses.add('automerge.counter_identity_changed');
    if (typeof value === 'string') losses.add('automerge.text_identity_changed');
    if (!isObjectValue(value)) return;
    if (!isRoot) losses.add('automerge.descendant_object_identity_changed');
    if (Array.isArray(value)) losses.add('automerge.list_element_identity_changed');
    for (const child of Object.values(value)) visit(child);
  };
  visit(root, true);
  return automergeCopyRelocateLossCodes.filter((code) => losses.has(code));
};

const copyAutomergeValue = (value: unknown): unknown => {
  if (Automerge.isCounter(value)) return new Automerge.Counter(Number(value));
  if (value instanceof Date) return new Date(value.getTime());
  if (value instanceof Uint8Array) return new Uint8Array(value);
  if (Array.isArray(value)) return value.map(copyAutomergeValue);
  if (isObjectValue(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, copyAutomergeValue(child)]));
  }
  return value;
};

const objectIdsByRelativePath = (root: object): Map<string, string> => {
  const result = new Map<string, string>();
  const visit = (value: unknown, path: AutomergeMovePath): void => {
    if (!isObjectValue(value) || Automerge.isCounter(value) || value instanceof Date || value instanceof Uint8Array) return;
    const objectId = Automerge.getObjectId(value);
    if (typeof objectId === 'string') result.set(pathKey(path), objectId);
    if (Array.isArray(value)) value.forEach((child, index) => visit(child, [...path, index]));
    else Object.entries(value).forEach(([key, child]) => visit(child, [...path, key]));
  };
  visit(root, []);
  return result;
};

const pathKey = (path: AutomergeMovePath): string => canonicalAutomergeJson(path as JsonValue);
const parsePathKey = (key: string): AutomergeMovePath => JSON.parse(key) as (string | number)[];

export const valueAtAutomergePath = (root: unknown, path: AutomergeMovePath): unknown => {
  let current = root;
  for (const part of path) {
    if (!isObjectValue(current)) return undefined;
    current = (current as Record<string | number, unknown>)[part];
  }
  return current;
};

const valueAt = valueAtAutomergePath;

const hasAtPath = (root: unknown, path: AutomergeMovePath): boolean => {
  const parent = valueAt(root, path.slice(0, -1));
  if (!isObjectValue(parent)) return false;
  const property = path[path.length - 1] as string | number;
  if (Array.isArray(parent) && typeof property === 'number') return property >= 0 && property < parent.length;
  return Object.hasOwn(parent, property);
};

const setAt = (root: unknown, path: AutomergeMovePath, value: unknown): void => {
  const parent = valueAt(root, path.slice(0, -1));
  if (!isObjectValue(parent)) throw new AutomergeMoveError('automerge.move_destination_missing', 'copyRelocate destination parent is missing');
  const property = path[path.length - 1] as string | number;
  (parent as Record<string | number, unknown>)[property] = value;
};

const deleteAt = (root: unknown, path: AutomergeMovePath): void => {
  const parent = valueAt(root, path.slice(0, -1));
  if (!isObjectValue(parent)) throw new AutomergeMoveError('automerge.move_source_missing', 'copyRelocate source parent is missing');
  const property = path[path.length - 1] as string | number;
  if (Array.isArray(parent) && typeof property === 'number') Automerge.deleteAt(parent, property);
  else delete (parent as Record<string | number, unknown>)[property];
};

const isObjectValue = (value: unknown): value is object => value !== null && typeof value === 'object';
const isPlainRecord = (value: unknown): value is Record<string, unknown> => isObjectValue(value) && !Array.isArray(value);

const isMoveRecordV1 = (value: unknown): value is AutomergeMoveRecordV1 => {
  if (!isPlainRecord(value) || value.formatVersion !== 1) return false;
  if (typeof value.operationEpoch !== 'string' || typeof value.operationId !== 'string' || !Number.isInteger(value.statementIndex)) return false;
  if (!isMovePath(value.fromPath) || !isMovePath(value.toPath) || !isStringArray(value.beforeHeads)) return false;
  if (typeof value.oldRootObjectId !== 'string' || typeof value.newRootObjectId !== 'string') return false;
  if (!Array.isArray(value.descendants) || !Array.isArray(value.preservationLosses)) return false;
  return isPlainRecord(value.mechanism) && value.mechanism.id === automergeCopyRelocateCapability.id && value.mechanism.version === '1';
};

const isMovePath = (value: unknown): value is (string | number)[] => Array.isArray(value) && value.every((part) => typeof part === 'string' || Number.isInteger(part));
const isStringArray = (value: unknown): value is string[] => Array.isArray(value) && value.every((entry) => typeof entry === 'string');
