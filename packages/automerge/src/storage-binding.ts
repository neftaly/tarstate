import * as Automerge from '@automerge/automerge';
import { canonicalizeJson, safeParseJsonValue, type JsonValue } from '@tarstate/core/foundation';
import { conflictsAt, normalizeAutomergeValue, type AutomergePath, type AutomergeProjectionIssue } from './projection.js';
import { isAutomergeReservedRootProperty } from './reserved.js';
import { comparePortableStrings } from './portable-order.js';
import { automergeBasis, type AutomergeBasis, type AutomergeSnapshot, type AutomergeSourceCommand } from './source.js';
import { adoptAutomergeMapOptions, type OwnedAutomergeMapOptions } from './internal-options-ownership.js';

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
  readonly storagePath: AutomergePath;
  readonly conflictChangeHash?: string;
};

export type AutomergeRelationProjection<Row extends Readonly<Record<string, JsonValue>>> = {
  readonly basis: AutomergeBasis;
  readonly completeness: 'exact' | 'unknown';
  readonly rows: readonly AutomergeProjectedRow<Row>[];
  readonly issues: readonly AutomergeProjectionIssue[];
};

export type PriorAutomergeRelationProjection<T extends object, Row extends Readonly<Record<string, JsonValue>>> = {
  readonly snapshot: Pick<AutomergeSnapshot<T>, 'sourceId' | 'basis'>;
  readonly projection: AutomergeRelationProjection<Row>;
};

export type AutomergeMapProjectionPlannerOptions<Row extends Readonly<Record<string, JsonValue>>> = {
  readonly relationId: string;
  readonly collectionPath: AutomergePath;
  readonly missingCollection: 'empty' | 'invalid';
  readonly keySource: 'map-key' | { readonly field: string };
  readonly locatorNamespace?: string;
  readonly parse?: (candidate: unknown, context: { readonly mapKey: string; readonly path: AutomergePath }) =>
    | { readonly success: true; readonly row: Row }
    | { readonly success: false; readonly issue: AutomergeProjectionIssue };
};

export type AutomergePropertyEdit =
  | { readonly kind: 'replace'; readonly path: AutomergePath; readonly value: unknown }
  | { readonly kind: 'delete'; readonly path: AutomergePath }
  | { readonly kind: 'counter-increment'; readonly path: AutomergePath; readonly by: number }
  | { readonly kind: 'text-splice'; readonly path: AutomergePath; readonly index: number; readonly deleteCount: number; readonly value: string }
  | {
      readonly kind: 'conflict-resolve';
      readonly path: AutomergePath;
      readonly observedChangeHashes: readonly string[];
      readonly selectedChangeHash: string;
    };

export type AutomergeEditPlan<T extends object> = {
  readonly basis: AutomergeBasis;
  readonly commands: readonly AutomergeSourceCommand<T>[];
  readonly footprints: readonly { readonly kind: 'exact-path'; readonly path: AutomergePath }[];
  readonly issues: readonly AutomergeProjectionIssue[];
};

/** A pure map-collection binding. It never subscribes or commits. */
export class AutomergeMapProjectionPlanner<T extends object, Row extends Readonly<Record<string, JsonValue>>> {
  readonly relationId: string;
  readonly #options: OwnedAutomergeMapOptions<Row>;

  constructor(options: AutomergeMapProjectionPlannerOptions<Row>) {
    this.#options = adoptAutomergeMapOptions<Row>(options);
    this.relationId = this.#options.relationId;
  }

  project(
    snapshot: AutomergeSnapshot<T>,
    previous?: PriorAutomergeRelationProjection<T, Row>
  ): AutomergeRelationProjection<Row> {
    const collection = valueAtAutomergePath(snapshot.storage, this.#options.collectionPath);
    if (collection === undefined && this.#options.missingCollection === 'empty') {
      return frozenProjection({ basis: snapshot.basis, completeness: 'exact', rows: [], issues: [] });
    }
    if (!isRecord(collection)) {
      return frozenProjection({
        basis: snapshot.basis,
        completeness: 'unknown',
        rows: [],
        issues: [{ code: 'automerge.collection_invalid', path: this.#options.collectionPath }]
      });
    }

    const affectedKeys = previous === undefined
      ? undefined
      : affectedCollectionKeys(previous.snapshot, snapshot, this.#options.collectionPath);
    if (affectedKeys !== undefined && previous !== undefined) {
      if (affectedKeys.size === 0) {
        return frozenProjection({ ...previous.projection, basis: snapshot.basis });
      }
      const collectionSize = Object.keys(collection).length;
      if (affectedKeys.size <= Math.max(32, Math.floor(collectionSize / 4))) {
        return this.#projectChangedKeys(snapshot, collection, previous.projection, affectedKeys);
      }
    }

    const rows: AutomergeProjectedRow<Row>[] = [];
    const issues: AutomergeProjectionIssue[] = [];
    let incomplete = false;
    const mapKeys = Object.keys(collection).sort(comparePortableStrings);
    for (const mapKey of mapKeys) {
      if (this.#options.collectionPath.length === 0 && isAutomergeReservedRootProperty(mapKey)) continue;
      const projected = this.#projectEntry(collection, mapKey, collection[mapKey]);
      rows.push(...projected.rows);
      issues.push(...projected.issues);
      incomplete ||= projected.incomplete;
    }
    issues.push(...duplicateKeyIssues(rows));
    return frozenProjection({ basis: snapshot.basis, completeness: incomplete ? 'unknown' : 'exact', rows, issues });
  }

  #projectChangedKeys(
    snapshot: AutomergeSnapshot<T>,
    collection: Record<string, unknown>,
    previous: AutomergeRelationProjection<Row>,
    affectedKeys: ReadonlySet<string>
  ): AutomergeRelationProjection<Row> {
    const rows = previous.rows.filter((row) => !affectedKeys.has(String(row.storagePath[this.#options.collectionPath.length])));
    const issues = previous.issues.filter((issue) => issue.code !== 'automerge.logical_key_ambiguous'
      && !pathTouchesMapKey(issue.path, this.#options.collectionPath, affectedKeys));
    for (const mapKey of affectedKeys) {
      if (this.#options.collectionPath.length === 0 && isAutomergeReservedRootProperty(mapKey)) continue;
      if (!Object.hasOwn(collection, mapKey)) continue;
      const projected = this.#projectEntry(collection, mapKey, collection[mapKey]);
      rows.push(...projected.rows);
      issues.push(...projected.issues);
    }
    rows.sort((left, right) => {
      const keyOrder = comparePortableStrings(
        String(left.storagePath[this.#options.collectionPath.length]),
        String(right.storagePath[this.#options.collectionPath.length])
      );
      return keyOrder !== 0 ? keyOrder : comparePortableStrings(left.conflictChangeHash ?? '', right.conflictChangeHash ?? '');
    });
    issues.push(...duplicateKeyIssues(rows));
    return frozenProjection({
      basis: snapshot.basis,
      completeness: issues.some(projectionIssueMakesIncomplete) ? 'unknown' : 'exact',
      rows,
      issues
    });
  }

  #projectEntry(
    collection: Record<string, unknown>,
    mapKey: string,
    visible: unknown
  ): { readonly rows: readonly AutomergeProjectedRow<Row>[]; readonly issues: readonly AutomergeProjectionIssue[]; readonly incomplete: boolean } {
    const rows: AutomergeProjectedRow<Row>[] = [];
    const issues: AutomergeProjectionIssue[] = [];
    let incomplete = false;
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
      const locator = locatorFor(collection, mapKey, candidate, changeHash, this.#options.locatorNamespace ?? 'automerge-object');
      if (locator === undefined) {
        incomplete = true;
        issues.push({ code: 'automerge.row_identity_unavailable', path });
        continue;
      }
      rows.push(Object.freeze({
        relationId: this.relationId,
        key: Object.freeze([key]) as readonly [JsonValue],
        fields: parsed.row,
        locator: Object.freeze(locator),
        storagePath: Object.freeze(path),
        ...(changeHash === '' ? {} : { conflictChangeHash: changeHash })
      }));
    }
    if (conflictAlternatives.length > 1) {
      issues.push({
        code: 'automerge.map_key_conflict',
        path: [...this.#options.collectionPath, mapKey],
        details: { changeHashes: conflictAlternatives.map(([changeHash]) => changeHash) }
      });
    }
    return { rows, issues, incomplete };
  }

  plan(snapshot: AutomergeSnapshot<T>, edits: readonly AutomergePropertyEdit[]): AutomergeEditPlan<T> {
    const commands: AutomergeSourceCommand<T>[] = [];
    const issues: AutomergeProjectionIssue[] = [];
    const footprints: { readonly kind: 'exact-path'; readonly path: AutomergePath }[] = [];
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

  #parse(candidate: unknown, mapKey: string, path: AutomergePath):
    | { readonly success: true; readonly row: Row }
    | { readonly success: false; readonly issue: AutomergeProjectionIssue } {
    if (this.#options.parse !== undefined) {
      try {
        const parsed = this.#options.parse(candidate, { mapKey, path });
        if (!parsed.success) return parsed;
        return ownParsedRow(parsed.row, path);
      } catch (error) {
        return { success: false, issue: { code: 'automerge.row_parser_failed', path, details: { message: error instanceof Error ? error.message : String(error) } } };
      }
    }
    if (!isRecord(candidate)) return { success: false, issue: { code: 'automerge.row_invalid', path } };
    return ownParsedRow(normalizeAutomergeValue(candidate), path);
  }

  #logicalKey(mapKey: string, row: Row): JsonValue | undefined {
    if (this.#options.keySource === 'map-key') return mapKey;
    const value = row[this.#options.keySource.field];
    return value === undefined ? undefined : value;
  }
}

const ownParsedRow = <Row extends Readonly<Record<string, JsonValue>>>(
  candidate: unknown,
  path: AutomergePath
): { readonly success: true; readonly row: Row } | { readonly success: false; readonly issue: AutomergeProjectionIssue } => {
  const owned = safeParseJsonValue(candidate);
  if (!owned.success || owned.value === null || Array.isArray(owned.value) || typeof owned.value !== 'object') {
    return {
      success: false,
      issue: {
        code: 'automerge.row_invalid',
        path,
        ...(owned.success ? {} : { details: { issueCodes: owned.issues.map(({ code }) => code) } })
      }
    };
  }
  return { success: true, row: freezeOwnedJson(owned.value) as Row };
};

const affectedCollectionKeys = <T extends object>(
  previous: Pick<AutomergeSnapshot<T>, 'sourceId' | 'basis'>,
  next: AutomergeSnapshot<T>,
  collectionPath: AutomergePath
): ReadonlySet<string> | undefined => {
  if (previous.sourceId !== next.sourceId || !Automerge.hasHeads(next.storage, [...previous.basis.heads])) return undefined;
  const affected = new Set<string>();
  for (const patch of Automerge.diff(next.storage, [...previous.basis.heads], [...next.basis.heads])) {
    const path = patch.path;
    let sharesPrefix = true;
    const sharedLength = Math.min(path.length, collectionPath.length);
    for (let index = 0; index < sharedLength; index += 1) {
      if (path[index] !== collectionPath[index]) {
        sharesPrefix = false;
        break;
      }
    }
    if (!sharesPrefix) continue;
    if (path.length <= collectionPath.length) return undefined;
    const mapKey = path[collectionPath.length];
    if (typeof mapKey !== 'string') return undefined;
    affected.add(mapKey);
  }
  return affected;
};

const pathTouchesMapKey = (
  path: AutomergePath | undefined,
  collectionPath: AutomergePath,
  affectedKeys: ReadonlySet<string>
): boolean => path !== undefined
  && path.length > collectionPath.length
  && collectionPath.every((part, index) => path[index] === part)
  && affectedKeys.has(String(path[collectionPath.length]));

const projectionIssueMakesIncomplete = ({ code }: AutomergeProjectionIssue): boolean =>
  code === 'automerge.collection_invalid'
  || code === 'automerge.row_invalid'
  || code === 'automerge.row_parser_failed'
  || code === 'automerge.row_key_invalid'
  || code === 'automerge.row_identity_unavailable';

const frozenProjection = <Row extends Readonly<Record<string, JsonValue>>>(
  projection: AutomergeRelationProjection<Row>
): AutomergeRelationProjection<Row> => Object.freeze({
  ...projection,
  rows: Object.freeze(projection.rows),
  issues: Object.freeze(projection.issues)
});

const freezeOwnedJson = (value: JsonValue): JsonValue => {
  if (value === null || typeof value !== 'object') return value;
  for (const child of Array.isArray(value) ? value : Object.values(value)) freezeOwnedJson(child);
  return Object.freeze(value);
};

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
  const alternatives = Array.isArray(parent) ? [] : conflictsAt(parent, property);

  if (edit.kind === 'conflict-resolve') {
    const observed = [...edit.observedChangeHashes].sort();
    const actual = alternatives.map(([changeHash]) => changeHash).sort();
    if (actual.length < 2 || canonicalizeJson(actual) !== canonicalizeJson(observed)) {
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
  if (edit.kind !== 'text-splice') return assertNever(edit);
  const current = valueAtAutomergePath(doc, edit.path);
  if (typeof current !== 'string' || !validSplice(edit.index, edit.deleteCount, current.length)) return { issue: { code: 'automerge.text_edit_invalid', path: edit.path } };
  return {
    command: {
      description: 'splice text',
      apply: (draft) => { Automerge.splice(draft, [...edit.path], edit.index, edit.deleteCount, edit.value); }
    }
  };
};

const firstConflictAlongPath = (
  doc: object,
  path: AutomergePath
): { readonly path: AutomergePath; readonly alternatives: readonly (readonly [string, unknown])[] } | undefined => {
  for (let index = 0; index < path.length; index += 1) {
    const owner = valueAtAutomergePath(doc, path.slice(0, index));
    if (owner === null || typeof owner !== 'object') return undefined;
    if (Array.isArray(owner)) continue;
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
): AutomergeRowLocator | undefined => {
  const objectId = candidate !== null && typeof candidate === 'object' ? Automerge.getObjectId(candidate) : null;
  if (typeof objectId === 'string') return { namespace, token: objectId, rowIncarnation: objectId };
  const collectionObjectId = Automerge.getObjectId(collection);
  if (changeHash !== '' && typeof collectionObjectId === 'string') {
    return {
      namespace: namespace + ':conflict',
      token: Object.freeze({ collectionObjectId, mapKey, changeHash }),
      rowIncarnation: changeHash
    };
  }
  return undefined;
};

const duplicateKeyIssues = <Row extends Readonly<Record<string, JsonValue>>>(
  rows: readonly AutomergeProjectedRow<Row>[]
): readonly AutomergeProjectionIssue[] => {
  const byKey = new Map<string, AutomergeProjectedRow<Row>[]>();
  for (const row of rows) {
    const key = canonicalizeJson(row.key as JsonValue);
    const group = byKey.get(key) ?? [];
    group.push(row);
    byKey.set(key, group);
  }
  return [...byKey.entries()].flatMap(([key, candidates]) => candidates.length < 2 ? [] : [{
    code: 'automerge.logical_key_ambiguous',
    details: { key: JSON.parse(key), candidates: candidates.map((candidate) => candidate.locator.token) }
  }]);
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
  if (isRecord(value)) return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, copyAutomergeValue(child)]));
  return value;
};

export const valueAtAutomergePath = (root: unknown, path: AutomergePath): unknown => {
  let current = root;
  for (const part of path) {
    if (current === null || typeof current !== 'object') return undefined;
    current = (current as Record<string | number, unknown>)[part];
  }
  return current;
};

const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

const validSplice = (index: number, deleteCount: number, length: number): boolean =>
  Number.isSafeInteger(index) && Number.isSafeInteger(deleteCount) && index >= 0 && deleteCount >= 0 && index <= length && index + deleteCount <= length;

const assertNever = (value: never): never => { throw new TypeError('Unsupported Automerge property edit: ' + String(value)); };
