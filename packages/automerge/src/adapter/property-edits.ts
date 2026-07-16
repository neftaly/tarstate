import * as Automerge from '@automerge/automerge';
import type { JsonValue } from '@tarstate/core';
import { conflictsAt, type AutomergePath, type AutomergeProjectionIssue } from '../document/projection.js';
import type { AutomergeSourceCommand } from '../source/runtime.js';

export type AutomergePropertyEdit =
  | { readonly kind: 'replace'; readonly path: AutomergePath; readonly value: JsonValue }
  | { readonly kind: 'delete'; readonly path: AutomergePath };

export const planPropertyEdit = <T extends object>(
  doc: Automerge.Doc<T>,
  edit: AutomergePropertyEdit
): { readonly command: AutomergeSourceCommand<T> } | { readonly issue: AutomergeProjectionIssue } => {
  if (edit.path.length === 0) {
    return { issue: { code: 'automerge.root_edit_unsupported', path: edit.path } };
  }

  const parentPath = edit.path.slice(0, -1);
  const parent = valueAtAutomergePath(doc, parentPath);
  if (parent === null || typeof parent !== 'object') {
    return { issue: { code: 'automerge.edit_parent_missing', path: parentPath } };
  }

  const conflict = firstConflictAlongPath(doc, edit.path);
  if (conflict !== undefined) {
    return {
      issue: {
        code: 'transaction.conflict_requires_resolution',
        path: conflict.path,
        details: { changeHashes: conflict.changeHashes }
      }
    };
  }

  if (edit.kind === 'delete') {
    return {
      command: {
        description: 'delete property',
        apply: (draft) => {
          deleteAtPath(draft, edit.path);
        }
      }
    };
  }

  const value = copyAutomergeValue(edit.value);
  return {
    command: {
      description: 'replace property',
      apply: (draft) => {
        setAtPath(draft, edit.path, value);
      }
    }
  };
};

export const valueAtAutomergePath = (root: unknown, path: AutomergePath): unknown => {
  let current = root;
  for (const part of path) {
    if (current === null || typeof current !== 'object') return undefined;
    current = (current as Record<string | number, unknown>)[part];
  }
  return current;
};

const firstConflictAlongPath = (
  doc: object,
  path: AutomergePath
): { readonly path: AutomergePath; readonly changeHashes: readonly string[] } | undefined => {
  for (let index = 0; index < path.length; index += 1) {
    const owner = valueAtAutomergePath(doc, path.slice(0, index));
    if (owner === null || typeof owner !== 'object') return undefined;
    if (Array.isArray(owner)) continue;
    const alternatives = conflictsAt(owner, path[index] as string | number);
    if (alternatives.length > 1) {
      return {
        path: path.slice(0, index + 1),
        changeHashes: alternatives.map(([changeHash]) => changeHash)
      };
    }
  }
  return undefined;
};

const setAtPath = (root: unknown, path: AutomergePath, value: unknown): void => {
  const parent = valueAtAutomergePath(root, path.slice(0, -1));
  if (parent === null || typeof parent !== 'object') throw new Error('Edit parent is missing');
  const property = path[path.length - 1] as string | number;
  (parent as Record<string | number, unknown>)[property] = value;
};

const deleteAtPath = (root: unknown, path: AutomergePath): void => {
  const parent = valueAtAutomergePath(root, path.slice(0, -1));
  if (parent === null || typeof parent !== 'object') throw new Error('Edit parent is missing');
  const property = path[path.length - 1] as string | number;
  if (Array.isArray(parent) && typeof property === 'number') Automerge.deleteAt(parent, property);
  else delete (parent as Record<string | number, unknown>)[property];
};

const copyAutomergeValue = (value: unknown): unknown => {
  if (Automerge.isCounter(value)) return new Automerge.Counter(Number(value));
  if (value instanceof Date) return new Date(value.getTime());
  if (value instanceof Uint8Array) return new Uint8Array(value);
  if (Array.isArray(value)) return value.map(copyAutomergeValue);
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, copyAutomergeValue(child)])
    );
  }
  return value;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
