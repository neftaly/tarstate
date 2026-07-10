import * as Automerge from '@automerge/automerge';
import { capabilityRef, canonicalJson, sha256Canonical, type CapabilityRef, type JsonValue } from '@tarstate/core/v1-spike';

export type AutomergeMovePath = readonly (string | number)[];
export const automergeMoveMetadataProperty = '__tarstateMovesV1' as const;

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
};

export const exactAutomergeHeadsEqual = (left: Automerge.Heads, right: Automerge.Heads): boolean => {
  if (left.length !== right.length) return false;
  const sortedLeft = [...left].sort();
  const sortedRight = [...right].sort();
  return sortedLeft.every((head, index) => head === sortedRight[index]);
};

export const copyRelocateAutomerge = async <T extends object>(
  doc: Automerge.Doc<T>,
  input: {
    readonly operationEpoch: string;
    readonly operationId: string;
    readonly statementIndex: number;
    readonly fromPath: AutomergeMovePath;
    readonly toPath: AutomergeMovePath;
  }
): Promise<AutomergeCopyRelocateResult<T>> => {
  const beforeHeads = [...Automerge.getHeads(doc)].sort();
  const source = valueAt(doc, input.fromPath);
  if (source === undefined || source === null || typeof source !== 'object') throw new Error('copyRelocate requires an object subtree');
  const oldRootObjectId = Automerge.getObjectId(source);
  if (oldRootObjectId === null) throw new Error('copyRelocate source has no Automerge object ID');
  const oldObjects = objectIdsByRelativePath(source);
  let losses = preservationLosses(source);
  const recordId = await sha256Canonical({ operationEpoch: input.operationEpoch, operationId: input.operationId, statementIndex: input.statementIndex });
  let completedRecord: AutomergeMoveRecordV1 | undefined;

  const changed = Automerge.change(doc, { message: 'tarstate copy relocation', time: 0 }, (draft) => {
    const root = draft as unknown as Record<string, unknown>;
    const metadata = root[automergeMoveMetadataProperty];
    if (metadata !== undefined && (!isRecord(metadata) || Array.isArray(metadata))) throw new Error('Automerge move metadata collision');
    if (metadata === undefined) root[automergeMoveMetadataProperty] = {};
    const records = root[automergeMoveMetadataProperty] as Record<string, unknown>;
    if (records[recordId] !== undefined) throw new Error('Automerge move operation record already exists');

    setAt(draft, input.toPath, copyAutomergeValue(source));
    const copied = valueAt(draft, input.toPath);
    if (copied === undefined || copied === null || typeof copied !== 'object') throw new Error('copyRelocate destination was not created');
    const newRootObjectId = Automerge.getObjectId(copied);
    if (newRootObjectId === null) throw new Error('copyRelocate destination has no Automerge object ID');
    const newObjects = objectIdsByRelativePath(copied);
    let descendantMappingIncomplete = false;
    const descendants = [...oldObjects.entries()]
      .filter(([path]) => path !== '')
      .flatMap(([path, fromObjectId]) => {
        const toObjectId = newObjects.get(path);
        if (toObjectId === undefined) { descendantMappingIncomplete = true; return []; }
        return [{ fromObjectId, toObjectId, relativePath: parsePathKey(path) }];
      })
      .sort((left, right) => canonicalJson(left.relativePath) < canonicalJson(right.relativePath) ? -1 : 1);
    if (descendantMappingIncomplete) losses = automergeCopyRelocateLossCodes.filter((code) => code === 'automerge.descendant_mapping_incomplete' || losses.includes(code));
    completedRecord = {
      formatVersion: 1,
      operationEpoch: input.operationEpoch,
      operationId: input.operationId,
      statementIndex: input.statementIndex,
      beforeHeads,
      fromPath: input.fromPath,
      toPath: input.toPath,
      oldRootObjectId,
      newRootObjectId,
      descendants,
      mechanism: capabilityRef('entity/copy-relocate'),
      preservationLosses: losses
    };
    records[recordId] = completedRecord as unknown as JsonValue;
    deleteAt(draft, input.fromPath);
  });

  if (completedRecord === undefined) throw new Error('copyRelocate did not complete');
  return { doc: changed, recordId, record: completedRecord };
};

const preservationLosses = (root: object): readonly AutomergeCopyRelocateLossCode[] => {
  const losses = new Set<AutomergeCopyRelocateLossCode>([
    'automerge.conflicts_not_copied',
    'automerge.concurrent_old_subtree_edits_not_forwarded',
    'automerge.root_object_identity_changed'
  ]);
  const visit = (value: unknown, isRoot = false): void => {
    if (Automerge.isCounter(value)) losses.add('automerge.counter_identity_changed');
    if (typeof value === 'string') losses.add('automerge.text_identity_changed');
    if (value === null || typeof value !== 'object') return;
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
  if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, copyAutomergeValue(child)]));
  return value;
};

const objectIdsByRelativePath = (root: object): Map<string, string> => {
  const result = new Map<string, string>();
  const visit = (value: unknown, path: AutomergeMovePath): void => {
    if (value === null || typeof value !== 'object' || Automerge.isCounter(value) || value instanceof Date || value instanceof Uint8Array) return;
    const objectId = Automerge.getObjectId(value);
    if (typeof objectId === 'string') result.set(pathKey(path), objectId);
    if (Array.isArray(value)) value.forEach((child, index) => visit(child, [...path, index]));
    else Object.entries(value).forEach(([key, child]) => visit(child, [...path, key]));
  };
  visit(root, []);
  return result;
};

const pathKey = (path: AutomergeMovePath): string => canonicalJson(path);
const parsePathKey = (key: string): AutomergeMovePath => JSON.parse(key) as (string | number)[];

const valueAt = (root: unknown, path: AutomergeMovePath): unknown => {
  let current = root;
  for (const part of path) {
    if (current === null || typeof current !== 'object') return undefined;
    current = (current as Record<string | number, unknown>)[part];
  }
  return current;
};

const setAt = (root: unknown, path: AutomergeMovePath, value: unknown): void => {
  if (path.length === 0) throw new Error('copyRelocate cannot replace the document root');
  const parent = valueAt(root, path.slice(0, -1));
  if (parent === null || typeof parent !== 'object') throw new Error('copyRelocate destination parent is missing');
  (parent as Record<string | number, unknown>)[path[path.length - 1] as string | number] = value;
};

const deleteAt = (root: unknown, path: AutomergeMovePath): void => {
  if (path.length === 0) throw new Error('copyRelocate cannot delete the document root');
  const parent = valueAt(root, path.slice(0, -1));
  if (parent === null || typeof parent !== 'object') throw new Error('copyRelocate source parent is missing');
  const property = path[path.length - 1] as string | number;
  if (Array.isArray(parent) && typeof property === 'number') Automerge.deleteAt(parent, property);
  else delete (parent as Record<string | number, unknown>)[property];
};

const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
