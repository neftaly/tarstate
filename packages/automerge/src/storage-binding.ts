import * as Automerge from '@automerge/automerge';
import type { JsonValue } from '@tarstate/core';
import { conflictsAt, normalizeAutomergeValue, type AutomergeProjectionIssue } from './projection.js';
import { valueAtAutomergePath, type AutomergeMovePath } from './move.js';
import { isAutomergeReservedRootProperty } from './reserved.js';
import { automergeBasis, type AutomergeBasis, type AutomergeSnapshot, type AutomergeSourceCommand } from './source.js';
import { canonicalAutomergeJson } from './wire.js';

export type AutomergeRowLocator = {
  readonly namespace: string;
  readonly token: JsonValue;
  readonly rowIncarnation: string;
};

export type AutomergeProjectedRow<Row extends Readonly<Record<string, JsonValue>>> = {
  readonly relationId: string;
  readonly key: readonly [JsonValue, ...JsonValue[]];
  readonly fields: Row;
  readonly locator: AutomergeRowLocator;
  readonly storagePath: AutomergeMovePath;
  readonly conflictChangeHash?: string;
};

export type AutomergeRelationProjection<Row extends Readonly<Record<string, JsonValue>>> = {
  readonly basis: AutomergeBasis;
  readonly completeness: 'exact' | 'unknown';
  readonly rows: readonly AutomergeProjectedRow<Row>[];
  readonly issues: readonly AutomergeProjectionIssue[];
};

export type AutomergeMapBindingOptions<Row extends Readonly<Record<string, JsonValue>>> = {
  readonly relationId: string;
  readonly collectionPath: AutomergeMovePath;
  readonly missingCollection: 'empty' | 'invalid';
  readonly keySource: 'map-key' | { readonly field: string };
  readonly locatorNamespace?: string;
  readonly parse?: (candidate: unknown, context: { readonly mapKey: string; readonly path: AutomergeMovePath }) =>
    | { readonly success: true; readonly row: Row }
    | { readonly success: false; readonly issue: AutomergeProjectionIssue };
};

export type AutomergePropertyEdit =
  | { readonly kind: 'replace'; readonly path: AutomergeMovePath; readonly value: unknown }
  | { readonly kind: 'delete'; readonly path: AutomergeMovePath }
  | { readonly kind: 'counter-increment'; readonly path: AutomergeMovePath; readonly by: number }
  | { readonly kind: 'text-splice'; readonly path: AutomergeMovePath; readonly index: number; readonly deleteCount: number; readonly value: string }
  | {
      readonly kind: 'conflict-resolve';
      readonly path: AutomergeMovePath;
      readonly observedChangeHashes: readonly string[];
      readonly selectedChangeHash: string;
    };

export type AutomergeEditPlan<T extends object> = {
  readonly basis: AutomergeBasis;
  readonly commands: readonly AutomergeSourceCommand<T>[];
  readonly footprints: readonly { readonly kind: 'exact-path'; readonly path: AutomergeMovePath }[];
  readonly issues: readonly AutomergeProjectionIssue[];
};

/** A pure map-collection binding. It never subscribes or commits. */
export class AutomergeMapStorageBinding<T extends object, Row extends Readonly<Record<string, JsonValue>>> {
  readonly relationId: string;
  readonly #options: AutomergeMapBindingOptions<Row>;

  constructor(options: AutomergeMapBindingOptions<Row>) {
    this.relationId = options.relationId;
    this.#options = options;
  }

  project(snapshot: AutomergeSnapshot<T>): AutomergeRelationProjection<Row> {
    const collection = valueAtAutomergePath(snapshot.storage, this.#options.collectionPath);
    if (collection === undefined && this.#options.missingCollection === 'empty') {
      return { basis: snapshot.basis, completeness: 'exact', rows: [], issues: [] };
    }
    if (!isRecord(collection)) {
      return {
        basis: snapshot.basis,
        completeness: 'unknown',
        rows: [],
        issues: [{ code: 'automerge.collection_invalid', path: this.#options.collectionPath }]
      };
    }

    const rows: AutomergeProjectedRow<Row>[] = [];
    const issues: AutomergeProjectionIssue[] = [];
    let incomplete = false;
    for (const [mapKey, visible] of Object.entries(collection).sort(([left], [right]) => left.localeCompare(right))) {
      if (this.#options.collectionPath.length === 0 && isAutomergeReservedRootProperty(mapKey)) continue;
      const conflictAlternatives = conflictsAt(collection, mapKey);
      const candidates = conflictAlternatives.length > 1 ? conflictAlternatives : [['', visible] as const];
      for (const [changeHash, candidate] of candidates) {
        const path = [...this.#options.collectionPath, mapKey];
        const parsed = this.#parse(candidate, mapKey, path);
        if (!parsed.success) {
          incomplete = true;
          issues.push(parsed.issue);
          continue;
        }
        const key = this.#logicalKey(mapKey, parsed.row);
        if (key === undefined) {
          incomplete = true;
          issues.push({ code: 'automerge.row_key_invalid', path });
          continue;
        }
        rows.push({
          relationId: this.relationId,
          key: [key],
          fields: parsed.row,
          locator: locatorFor(collection, mapKey, candidate, changeHash, this.#options.locatorNamespace ?? 'automerge-object'),
          storagePath: path,
          ...(changeHash === '' ? {} : { conflictChangeHash: changeHash })
        });
      }
      if (conflictAlternatives.length > 1) {
        issues.push({
          code: 'automerge.map_key_conflict',
          path: [...this.#options.collectionPath, mapKey],
          details: { changeHashes: conflictAlternatives.map(([changeHash]) => changeHash) }
        });
      }
    }
    issues.push(...duplicateKeyIssues(rows));
    return { basis: snapshot.basis, completeness: incomplete ? 'unknown' : 'exact', rows, issues };
  }

  plan(snapshot: AutomergeSnapshot<T>, edits: readonly AutomergePropertyEdit[]): AutomergeEditPlan<T> {
    const commands: AutomergeSourceCommand<T>[] = [];
    const issues: AutomergeProjectionIssue[] = [];
    const footprints: { readonly kind: 'exact-path'; readonly path: AutomergeMovePath }[] = [];
    for (const edit of edits) {
      footprints.push({ kind: 'exact-path', path: [...edit.path] });
      const rootProperty = edit.path[0];
      if (typeof rootProperty === 'string' && isAutomergeReservedRootProperty(rootProperty)) {
        issues.push({ code: 'automerge.reserved_metadata_write', path: edit.path });
        continue;
      }
      const planned = planPropertyEdit(snapshot.storage, edit);
      if ('issue' in planned) issues.push(planned.issue);
      else commands.push(planned.command);
    }
    return { basis: snapshot.basis, commands: issues.length === 0 ? commands : [], footprints, issues };
  }

  #parse(candidate: unknown, mapKey: string, path: AutomergeMovePath):
    | { readonly success: true; readonly row: Row }
    | { readonly success: false; readonly issue: AutomergeProjectionIssue } {
    if (this.#options.parse !== undefined) {
      try {
        return this.#options.parse(candidate, { mapKey, path });
      } catch (error) {
        return { success: false, issue: { code: 'automerge.row_parser_failed', path, details: { message: error instanceof Error ? error.message : String(error) } } };
      }
    }
    if (!isRecord(candidate)) return { success: false, issue: { code: 'automerge.row_invalid', path } };
    return { success: true, row: normalizeAutomergeValue(candidate) as Row };
  }

  #logicalKey(mapKey: string, row: Row): JsonValue | undefined {
    if (this.#options.keySource === 'map-key') return mapKey;
    const value = row[this.#options.keySource.field];
    return value === undefined ? undefined : value;
  }
}

export const snapshotAutomergeDocument = <T extends object>(sourceId: string, storage: Automerge.Doc<T>): AutomergeSnapshot<T> => ({
  sourceId,
  basis: automergeBasis(storage),
  storage
});

export const planPropertyEdit = <T extends object>(
  doc: Automerge.Doc<T>,
  edit: AutomergePropertyEdit
): { readonly command: AutomergeSourceCommand<T> } | { readonly issue: AutomergeProjectionIssue } => {
  if (edit.path.length === 0) return { issue: { code: 'automerge.root_edit_unsupported', path: edit.path } };
  const parentPath = edit.path.slice(0, -1);
  const property = edit.path[edit.path.length - 1] as string | number;
  const parent = valueAtAutomergePath(doc, parentPath);
  if (parent === null || typeof parent !== 'object') return { issue: { code: 'automerge.edit_parent_missing', path: parentPath } };
  const alternatives = conflictsAt(parent, property);

  if (edit.kind === 'conflict-resolve') {
    const observed = [...edit.observedChangeHashes].sort();
    const actual = alternatives.map(([changeHash]) => changeHash).sort();
    if (actual.length < 2 || canonicalAutomergeJson(actual) !== canonicalAutomergeJson(observed)) {
      return { issue: { code: 'transaction.conflict_observation_stale', path: edit.path, details: { observed, actual } } };
    }
    const selected = alternatives.find(([changeHash]) => changeHash === edit.selectedChangeHash);
    if (selected === undefined) return { issue: { code: 'transaction.conflict_selection_invalid', path: edit.path } };
    const selectedValue = copyAutomergeValue(selected[1]);
    return { command: { description: 'resolve conflict', apply: (draft) => { setAtPath(draft, edit.path, selectedValue); } } };
  }

  const conflictingAncestor = firstConflictAlongPath(doc, edit.path);
  if (conflictingAncestor !== undefined) {
    return {
      issue: {
        code: 'transaction.conflict_requires_resolution',
        path: conflictingAncestor.path,
        details: { changeHashes: conflictingAncestor.alternatives.map(([changeHash]) => changeHash) }
      }
    };
  }

  if (edit.kind === 'replace') {
    const value = copyAutomergeValue(edit.value);
    return { command: { description: 'replace property', apply: (draft) => { setAtPath(draft, edit.path, value); } } };
  }
  if (edit.kind === 'delete') {
    return { command: { description: 'delete property', apply: (draft) => { deleteAtPath(draft, edit.path); } } };
  }
  if (edit.kind === 'counter-increment') {
    const current = valueAtAutomergePath(doc, edit.path);
    if (!Automerge.isCounter(current) || !Number.isFinite(edit.by)) return { issue: { code: 'automerge.counter_edit_invalid', path: edit.path } };
    return {
      command: {
        description: 'increment counter',
        apply: (draft) => {
          const counter = valueAtAutomergePath(draft, edit.path);
          if (!Automerge.isCounter(counter)) throw new Error('Counter changed after planning');
          counter.increment(edit.by);
        }
      }
    };
  }
  const current = valueAtAutomergePath(doc, edit.path);
  if (typeof current !== 'string' || edit.index < 0 || edit.deleteCount < 0) return { issue: { code: 'automerge.text_edit_invalid', path: edit.path } };
  return {
    command: {
      description: 'splice text',
      apply: (draft) => { Automerge.splice(draft, [...edit.path], edit.index, edit.deleteCount, edit.value); }
    }
  };
};

const firstConflictAlongPath = (
  doc: object,
  path: AutomergeMovePath
): { readonly path: AutomergeMovePath; readonly alternatives: readonly (readonly [string, unknown])[] } | undefined => {
  for (let index = 0; index < path.length; index += 1) {
    const owner = valueAtAutomergePath(doc, path.slice(0, index));
    if (owner === null || typeof owner !== 'object') return undefined;
    const alternatives = conflictsAt(owner, path[index] as string | number);
    if (alternatives.length > 1) return { path: path.slice(0, index + 1), alternatives };
  }
  return undefined;
};

const locatorFor = (
  collection: object,
  mapKey: string,
  candidate: unknown,
  changeHash: string,
  namespace: string
): AutomergeRowLocator => {
  const objectId = candidate !== null && typeof candidate === 'object' ? Automerge.getObjectId(candidate) : null;
  if (typeof objectId === 'string') return { namespace, token: objectId, rowIncarnation: objectId };
  const collectionObjectId = Automerge.getObjectId(collection) ?? '_root';
  const incarnation = changeHash === '' ? 'visible:' + mapKey : 'change:' + changeHash;
  return {
    namespace: namespace + ':map-slot',
    token: { collectionObjectId, mapKey, candidate: incarnation },
    rowIncarnation: incarnation
  };
};

const duplicateKeyIssues = <Row extends Readonly<Record<string, JsonValue>>>(
  rows: readonly AutomergeProjectedRow<Row>[]
): readonly AutomergeProjectionIssue[] => {
  const byKey = new Map<string, AutomergeProjectedRow<Row>[]>();
  for (const row of rows) {
    const key = canonicalAutomergeJson(row.key as JsonValue);
    const group = byKey.get(key) ?? [];
    group.push(row);
    byKey.set(key, group);
  }
  return [...byKey.entries()].flatMap(([key, candidates]) => candidates.length < 2 ? [] : [{
    code: 'automerge.logical_key_ambiguous',
    details: { key: JSON.parse(key), candidates: candidates.map((candidate) => candidate.locator.token) }
  }]);
};

const setAtPath = (root: unknown, path: AutomergeMovePath, value: unknown): void => {
  const parent = valueAtAutomergePath(root, path.slice(0, -1));
  if (parent === null || typeof parent !== 'object') throw new Error('Edit parent is missing');
  const property = path[path.length - 1] as string | number;
  (parent as Record<string | number, unknown>)[property] = value;
};

const deleteAtPath = (root: unknown, path: AutomergeMovePath): void => {
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
  if (isRecord(value)) return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, copyAutomergeValue(child)]));
  return value;
};

const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
