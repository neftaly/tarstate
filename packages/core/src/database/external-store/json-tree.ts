import { createIssue, type Issue, type ParseResult } from '../../issues.js';
import type { Footprint, FootprintRelation } from '../../logical-edit.js';
import type { StoragePath } from '../../mapping.js';
import type { JsonValue } from '../../value.js';
import { setEnumerableDataProperty } from './record-property.js';

export type JsonTreePathFootprintEntry = {
  readonly scope: 'exact' | 'subtree';
  readonly path: StoragePath;
};

export type JsonTreePathFootprint = {
  readonly kind: 'json-tree-paths';
  readonly entries: readonly JsonTreePathFootprintEntry[];
};

export type JsonTreeCommand =
  | { readonly kind: 'replace'; readonly path: StoragePath; readonly value: JsonValue }
  | { readonly kind: 'delete'; readonly path: StoragePath }
  | { readonly kind: 'insert'; readonly path: StoragePath; readonly value: JsonValue }
  | { readonly kind: 'append'; readonly path: StoragePath; readonly value: JsonValue }
  | { readonly kind: 'batch'; readonly commands: readonly JsonTreeCommand[] };

export const jsonTreePathFootprint = (
  entries: readonly JsonTreePathFootprintEntry[]
): JsonTreePathFootprint => Object.freeze({
  kind: 'json-tree-paths',
  entries: Object.freeze(entries.map(({ scope, path }) => Object.freeze({
    scope,
    path: Object.freeze([...path])
  })))
});

export const relateJsonTreeFootprints = (
  left: Footprint,
  right: Footprint
): FootprintRelation => {
  const parsedLeft = parseFootprint(left);
  const parsedRight = parseFootprint(right);
  if (parsedLeft === undefined || parsedRight === undefined) return 'unknown';
  if (parsedLeft.entries.length === 0 || parsedRight.entries.length === 0) return 'disjoint';

  let leftContains = true;
  let rightContains = true;
  let overlaps = false;
  for (const leftEntry of parsedLeft.entries) {
    let containedByRight = false;
    for (const rightEntry of parsedRight.entries) {
      const relation = relateEntries(leftEntry, rightEntry);
      if (relation !== 'disjoint') overlaps = true;
      if (relation === 'equal' || relation === 'contained_by') containedByRight = true;
    }
    rightContains &&= containedByRight;
  }
  for (const rightEntry of parsedRight.entries) {
    let containedByLeft = false;
    for (const leftEntry of parsedLeft.entries) {
      const relation = relateEntries(leftEntry, rightEntry);
      if (relation === 'equal' || relation === 'contains') containedByLeft = true;
    }
    leftContains &&= containedByLeft;
  }
  if (!overlaps) return 'disjoint';
  if (leftContains && rightContains) return 'equal';
  if (leftContains) return 'contains';
  if (rightContains) return 'contained_by';
  return 'overlaps';
};

export const applyJsonTreeCommands = <State extends object>(
  state: State,
  commands: readonly JsonTreeCommand[]
): { readonly state: State; readonly changed: boolean; readonly issues: readonly Issue[] } => {
  let current: unknown = state;
  for (const command of commands) {
    const next = applyCommand(current, command);
    if (!next.success) return { state, changed: false, issues: next.issues };
    current = next.value;
  }
  if (Object.is(current, state)) return { state, changed: false, issues: [] };
  if (current === null || typeof current !== 'object' || Array.isArray(current)) {
    return {
      state,
      changed: false,
      issues: [jsonTreeIssue('mapping.path_invalid', [], { reason: 'object_root_required' })]
    };
  }
  return { state: current as State, changed: true, issues: [] };
};

const applyCommand = (root: unknown, command: JsonTreeCommand): ParseResult<unknown> => {
  if (command.kind === 'batch') {
    const split = command.commands.findIndex((child) => child.kind === 'append'
      || (child.kind === 'delete' && typeof child.path.at(-1) === 'number')
      || child.kind === 'batch');
    const ordinaryCount = split < 0 ? command.commands.length : split;
    const ordinary = command.commands.slice(0, ordinaryCount) as readonly OrdinaryJsonTreeCommand[];
    const grouped = applyDisjointCommands(root, ordinary);
    let current = grouped?.success === true ? grouped.value : root;
    if (grouped !== undefined && !grouped.success) return grouped;
    const start = grouped === undefined ? 0 : ordinaryCount;
    for (let index = start; index < command.commands.length; index += 1) {
      const child = command.commands[index] as JsonTreeCommand;
      const applied = applyCommand(current, child);
      if (!applied.success) return applied;
      current = applied.value;
    }
    return { success: true, value: current, issues: [] };
  }
  if (command.kind === 'append') {
    const collection = readPath(root, command.path);
    if (!collection.present || !Array.isArray(collection.value)) {
      return failure('mapping.collection_invalid', command.path, { operation: 'append' });
    }
    return replacePath(root, command.path, Object.freeze([...collection.value, command.value]));
  }
  if (command.path.length === 0) {
    if (command.kind === 'delete' || command.kind === 'insert') {
      return failure('mapping.path_invalid', command.path, { operation: command.kind });
    }
    return { success: true, value: command.value, issues: [] };
  }
  const parentPath = command.path.slice(0, -1);
  const member = command.path.at(-1) as string | number;
  const parent = readPath(root, parentPath);
  if (!parent.present) return failure('mapping.path_invalid', command.path, { operation: command.kind });

  if (Array.isArray(parent.value) && typeof member === 'number') {
    if (!Number.isSafeInteger(member) || member < 0) return failure('mapping.path_invalid', command.path);
    const copied = copyDataArray(parent.value);
    if (copied === undefined) return failure('mapping.path_invalid', command.path, { reason: 'descriptor' });
    if (command.kind === 'delete') {
      if (member >= copied.length) return failure('mapping.locator_stale', command.path);
      copied.splice(member, 1);
    } else if (command.kind === 'insert') {
      if (member !== copied.length) return failure('transaction.upsert_conflict', command.path);
      copied.push(command.value);
    } else {
      if (member >= copied.length) return failure('mapping.locator_stale', command.path);
      copied[member] = command.value;
    }
    return replacePath(root, parentPath, Object.freeze(copied));
  }
  if (!isRecord(parent.value) || typeof member !== 'string') {
    return failure('mapping.path_invalid', command.path);
  }
  const copied = copyDataRecord(parent.value);
  if (copied === undefined) return failure('mapping.path_invalid', command.path, { reason: 'descriptor' });
  const present = Object.hasOwn(copied, member);
  if (command.kind === 'delete') {
    if (!present) return failure('mapping.locator_stale', command.path);
    delete copied[member];
  } else if (command.kind === 'insert') {
    if (present) return failure('transaction.upsert_conflict', command.path);
    setEnumerableDataProperty(copied, member, command.value);
  } else {
    if (!present) return failure('mapping.locator_stale', command.path);
    setEnumerableDataProperty(copied, member, command.value);
  }
  return replacePath(root, parentPath, Object.freeze(copied));
};

type OrdinaryJsonTreeCommand = Exclude<JsonTreeCommand, {
  readonly kind: 'append' | 'batch';
}>;

type CommandTree = {
  command?: OrdinaryJsonTreeCommand;
  readonly children: Map<string | number, CommandTree>;
};

const applyDisjointCommands = (
  root: unknown,
  commands: readonly OrdinaryJsonTreeCommand[]
): ParseResult<unknown> | undefined => {
  if (commands.length === 0) return { success: true, value: root, issues: [] };
  const tree: CommandTree = { children: new Map() };
  for (const command of commands) {
    if (command.path.length === 0) return undefined;
    if (command.kind === 'delete' && typeof command.path.at(-1) === 'number') return undefined;
    let node = tree;
    for (const member of command.path) {
      if (node.command !== undefined) return undefined;
      let child = node.children.get(member);
      if (child === undefined) {
        child = { children: new Map() };
        node.children.set(member, child);
      }
      node = child;
    }
    if (node.command !== undefined || node.children.size > 0) return undefined;
    node.command = command;
  }
  return applyCommandTree(root, tree, []);
};

const applyCommandTree = (
  value: unknown,
  tree: CommandTree,
  path: StoragePath
): ParseResult<unknown> => {
  if (Array.isArray(value)) {
    const copied = copyDataArray(value);
    if (copied === undefined) return failure('mapping.path_invalid', path, { reason: 'descriptor' });
    for (const [member, child] of tree.children) {
      if (typeof member !== 'number' || !Number.isSafeInteger(member) || member < 0) {
        return failure('mapping.path_invalid', [...path, member]);
      }
      const command = child.command;
      if (command !== undefined) {
        if (command.kind === 'insert') {
          if (member !== copied.length) return failure('transaction.upsert_conflict', command.path);
          copied.push(command.value);
        } else if (command.kind === 'delete') {
          return failure('mapping.path_invalid', command.path, { reason: 'grouped_array_delete' });
        } else {
          if (member >= copied.length) return failure('mapping.locator_stale', command.path);
          copied[member] = command.value;
        }
        continue;
      }
      if (member >= copied.length) return failure('mapping.path_invalid', [...path, member]);
      const applied = applyCommandTree(copied[member], child, [...path, member]);
      if (!applied.success) return applied;
      copied[member] = applied.value;
    }
    return { success: true, value: Object.freeze(copied), issues: [] };
  }
  if (!isRecord(value)) return failure('mapping.path_invalid', path);
  const copied = copyDataRecord(value);
  if (copied === undefined) return failure('mapping.path_invalid', path, { reason: 'descriptor' });
  for (const [member, child] of tree.children) {
    if (typeof member !== 'string') return failure('mapping.path_invalid', [...path, member]);
    const command = child.command;
    if (command !== undefined) {
      const present = Object.hasOwn(copied, member);
      if (command.kind === 'insert') {
        if (present) return failure('transaction.upsert_conflict', command.path);
        setEnumerableDataProperty(copied, member, command.value);
      } else if (command.kind === 'delete') {
        if (!present) return failure('mapping.locator_stale', command.path);
        delete copied[member];
      } else {
        if (!present) return failure('mapping.locator_stale', command.path);
        setEnumerableDataProperty(copied, member, command.value);
      }
      continue;
    }
    if (!Object.hasOwn(copied, member)) return failure('mapping.path_invalid', [...path, member]);
    const applied = applyCommandTree(copied[member], child, [...path, member]);
    if (!applied.success) return applied;
    setEnumerableDataProperty(copied, member, applied.value);
  }
  return { success: true, value: Object.freeze(copied), issues: [] };
};

const replacePath = (root: unknown, path: StoragePath, value: unknown): ParseResult<unknown> => {
  if (path.length === 0) return { success: true, value, issues: [] };
  const parentPath = path.slice(0, -1);
  const member = path.at(-1) as string | number;
  const parent = readPath(root, parentPath);
  if (!parent.present) return failure('mapping.path_invalid', path);
  if (Array.isArray(parent.value) && typeof member === 'number') {
    if (!Number.isSafeInteger(member) || member < 0 || member >= parent.value.length) {
      return failure('mapping.path_invalid', path);
    }
    const copied = copyDataArray(parent.value);
    if (copied === undefined) return failure('mapping.path_invalid', path, { reason: 'descriptor' });
    copied[member] = value;
    return replacePath(root, parentPath, Object.freeze(copied));
  }
  if (!isRecord(parent.value) || typeof member !== 'string' || !Object.hasOwn(parent.value, member)) {
    return failure('mapping.path_invalid', path);
  }
  const copied = copyDataRecord(parent.value);
  if (copied === undefined) return failure('mapping.path_invalid', path, { reason: 'descriptor' });
  setEnumerableDataProperty(copied, member, value);
  return replacePath(root, parentPath, Object.freeze(copied));
};

type PathRead =
  | { readonly present: true; readonly value: unknown }
  | { readonly present: false };

const readPath = (root: unknown, path: StoragePath): PathRead => {
  let current = root;
  try {
    for (const member of path) {
      if ((typeof member === 'number' && !Array.isArray(current))
        || (typeof member === 'string' && !isRecord(current))
        || !Object.hasOwn(current as object, member)) return { present: false };
      const descriptor = Object.getOwnPropertyDescriptor(current as object, member);
      if (descriptor === undefined || !('value' in descriptor)) return { present: false };
      current = descriptor.value;
    }
    return { present: true, value: current };
  } catch {
    return { present: false };
  }
};

const copyDataArray = (value: readonly unknown[]): unknown[] | undefined => {
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const output: unknown[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = descriptors[index];
    if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) return undefined;
    output.push(descriptor.value);
  }
  return output;
};

const copyDataRecord = (
  value: Readonly<Record<string, unknown>>
): Record<string, unknown> | undefined => {
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const output: Record<string, unknown> = {};
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') return undefined;
    const descriptor = descriptors[key];
    if (descriptor === undefined || !descriptor.enumerable) continue;
    if (!('value' in descriptor)) return undefined;
    setEnumerableDataProperty(output, key, descriptor.value);
  }
  return output;
};

const parseFootprint = (value: Footprint): JsonTreePathFootprint | undefined => {
  if (!isRecord(value) || value.kind !== 'json-tree-paths' || !Array.isArray(value.entries)) return undefined;
  const entries: JsonTreePathFootprintEntry[] = [];
  for (const entry of value.entries) {
    if (!isRecord(entry)
      || (entry.scope !== 'exact' && entry.scope !== 'subtree')
      || !Array.isArray(entry.path)
      || entry.path.some((member) => (typeof member === 'string' && member.length === 0)
        || (typeof member === 'number' && (!Number.isSafeInteger(member) || member < 0))
        || (typeof member !== 'string' && typeof member !== 'number'))) return undefined;
    entries.push({ scope: entry.scope, path: entry.path as StoragePath });
  }
  return { kind: 'json-tree-paths', entries };
};

const relateEntries = (
  left: JsonTreePathFootprintEntry,
  right: JsonTreePathFootprintEntry
): FootprintRelation => {
  const common = Math.min(left.path.length, right.path.length);
  for (let index = 0; index < common; index += 1) {
    if (left.path[index] !== right.path[index]) return 'disjoint';
  }
  if (left.path.length === right.path.length) {
    if (left.scope === right.scope) return 'equal';
    return left.scope === 'subtree' ? 'contains' : 'contained_by';
  }
  if (left.path.length < right.path.length) return left.scope === 'subtree' ? 'contains' : 'disjoint';
  return right.scope === 'subtree' ? 'contained_by' : 'disjoint';
};

const failure = (
  code: string,
  path: readonly unknown[],
  details?: unknown
): ParseResult<never> => ({ success: false, issues: [jsonTreeIssue(code, path, details)] });

const jsonTreeIssue = (code: string, path: readonly unknown[], details?: unknown): Issue => createIssue({
  code,
  phase: 'plan',
  severity: 'error',
  retry: code.includes('stale') ? 'after_refresh' : 'after_input',
  path,
  ...(details === undefined ? {} : { details })
});

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
