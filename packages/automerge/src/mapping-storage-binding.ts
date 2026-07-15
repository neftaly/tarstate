import * as Automerge from '@automerge/automerge';
import {
  canonicalizeJson,
  createIssue,
  parseRelationCandidate,
  parseScalarValueForField,
  projectStorage,
  type CapabilityRegistry,
  type CompiledStorageMapping,
  type Issue,
  type JsonValue,
  type LogicalEdit,
  type PlanResult,
  type ProjectionResult,
  type RelationStorageMapping,
  type SourceSnapshot,
  type StorageBinding
} from '@tarstate/core';
import {
  automergePathFootprint,
  type AutomergePathFootprint
} from './core-adapter.js';
import { conflictsAt, type AutomergePath } from './projection.js';
import { isAutomergeReservedRootProperty } from './reserved.js';
import {
  planPropertyEdit,
  valueAtAutomergePath,
  type AutomergeProjectedRow
} from './storage-binding.js';
import type { AutomergeSourceCommand } from './source.js';

export type AutomergeMappedStorageRow = AutomergeProjectedRow<Readonly<Record<string, JsonValue>>>;

export type AutomergeMappedStorageBindingOptions = {
  readonly id?: string;
  readonly mapping: CompiledStorageMapping;
  readonly registry?: CapabilityRegistry;
  readonly relationIds?: readonly string[];
  readonly locatorNamespace?: string;
};

type MappedRelation = CompiledStorageMapping['relations'] extends ReadonlyMap<string, infer Relation> ? Relation : never;

/**
 * Writable Automerge object-map binding derived from the same compiled
 * `json-tree-v1` mapping used by `projectStorage`.
 */
export class AutomergeMappedStorageBinding<T extends object>
implements StorageBinding<Automerge.Doc<T>, AutomergeSourceCommand<T>, AutomergeMappedStorageRow> {
  readonly id: string;
  readonly declaredReadFootprint: AutomergePathFootprint;
  readonly declaredWriteFootprint: AutomergePathFootprint;
  readonly #mapping: CompiledStorageMapping;
  readonly #registry: CapabilityRegistry | undefined;
  readonly #relations: ReadonlyMap<string, MappedRelation>;
  readonly #locatorNamespace: string;

  constructor(options: AutomergeMappedStorageBindingOptions) {
    const owned = adoptOptions(options);
    this.id = owned.id ?? 'automerge-mapping';
    this.#mapping = owned.mapping;
    this.#registry = owned.registry;
    this.#locatorNamespace = owned.locatorNamespace ?? this.id;
    const selectedIds = owned.relationIds ?? [...owned.mapping.relations.keys()];
    const relations = new Map<string, MappedRelation>();
    for (const relationId of selectedIds) {
      const relation = owned.mapping.relations.get(relationId);
      if (relation === undefined) throw new TypeError('Mapped Automerge relation is missing: ' + relationId);
      if (relation.mapping.collection.kind !== 'object-map') throw new TypeError('Mapped Automerge relation must use an object-map collection: ' + relationId);
      relations.set(relationId, relation as MappedRelation);
    }
    this.#relations = relations;
    const entries = [...relations.values()].map(({ mapping }) => ({ scope: 'subtree' as const, path: mapping.collection.path as AutomergePath }));
    this.declaredReadFootprint = automergePathFootprint(entries);
    this.declaredWriteFootprint = this.declaredReadFootprint;
  }

  project = (snapshot: SourceSnapshot<Automerge.Doc<T>>): ProjectionResult<AutomergeMappedStorageRow> => {
    if (snapshot.state !== 'ready' || snapshot.storage === undefined) {
      return { rows: [], completeness: 'unknown', issues: [sourceIssue(snapshot.sourceId, snapshot.state)] };
    }
    const projection = projectStorage(this.#mapping, snapshot.storage, this.#registry, snapshot.sourceId);
    const rows: AutomergeMappedStorageRow[] = [];
    const issues: Issue[] = [];
    let incomplete = false;
    for (const [relationId, compiled] of this.#relations) {
      const relation = projection.relations.get(relationId);
      if (relation === undefined) {
        incomplete = true;
        issues.push(bindingIssue('mapping.relation_missing', snapshot.sourceId, relationId));
        continue;
      }
      issues.push(...relation.issues.map((issue) => rebaseProjectionIssue(issue, compiled.mapping.collection.path)));
      if (relation.completeness !== 'exact') incomplete = true;
      const collection = valueAtAutomergePath(snapshot.storage, compiled.mapping.collection.path as AutomergePath);
      for (const projected of relation.rows) {
        if (projected.locator.kind !== 'object-map-key' || !isRecord(collection)) {
          incomplete = true;
          issues.push(bindingIssue('mapping.locator_invalid', snapshot.sourceId, relationId));
          continue;
        }
        const path = [...compiled.mapping.collection.path, projected.locator.key] as AutomergePath;
        const candidates = conflictsAt(collection, projected.locator.key);
        if (candidates.length > 1) {
          incomplete = true;
          issues.push(createIssue({
            code: 'automerge.map_key_conflict', phase: 'query', severity: 'warning', retry: 'manual_repair',
            sourceId: snapshot.sourceId, relationId, path,
            details: { changeHashes: candidates.map(([changeHash]) => changeHash) }
          }));
          continue;
        }
        const mappedConflicts = conflictsAlongMappedPaths(snapshot.storage, path, compiled.mapping);
        if (mappedConflicts.length > 0) {
          incomplete = true;
          issues.push(...mappedConflicts.map((conflict) => createIssue({
            code: 'automerge.conflict_observed', phase: 'query', severity: 'warning', retry: 'manual_repair',
            sourceId: snapshot.sourceId, relationId, path: conflict.path,
            details: { changeHashes: conflict.changeHashes }
          })));
          continue;
        }
        const candidate = collection[projected.locator.key];
        const objectId = candidate === null || typeof candidate !== 'object' ? null : Automerge.getObjectId(candidate);
        if (typeof objectId !== 'string') {
          incomplete = true;
          issues.push(bindingIssue('automerge.row_identity_unavailable', snapshot.sourceId, relationId, path));
          continue;
        }
        rows.push(Object.freeze({
          relationId,
          key: projected.key,
          fields: projected.row as Readonly<Record<string, JsonValue>>,
          locator: Object.freeze({ namespace: this.#locatorNamespace, token: objectId, rowIncarnation: objectId }),
          storagePath: Object.freeze(path)
        }));
      }
    }
    return Object.freeze({
      rows: Object.freeze(rows),
      completeness: incomplete ? 'unknown' : 'exact',
      issues: Object.freeze(issues)
    });
  };

  plan = (snapshot: SourceSnapshot<Automerge.Doc<T>>, edits: readonly LogicalEdit[]): PlanResult<AutomergeSourceCommand<T>> => {
    const relevant = edits.filter(({ relationId }) => this.#relations.has(relationId));
    const empty = automergePathFootprint([]);
    if (relevant.length === 0) return { readFootprint: empty, writeFootprint: empty, intents: [], issues: [] };
    if (snapshot.state !== 'ready' || snapshot.storage === undefined) {
      return { readFootprint: this.declaredReadFootprint, writeFootprint: empty, intents: [], issues: [sourceIssue(snapshot.sourceId, snapshot.state)] };
    }
    const projection = this.project(snapshot);
    const issues = [...projection.issues];
    if (projection.completeness !== 'exact') {
      return { readFootprint: this.declaredReadFootprint, writeFootprint: empty, intents: [], issues };
    }
    const intents: { readonly footprint: AutomergePathFootprint; readonly command: AutomergeSourceCommand<T> }[] = [];
    for (const edit of relevant) {
      const compiled = this.#relations.get(edit.relationId) as MappedRelation;
      if (edit.kind === 'insert') {
        const planned = this.#planInsert(snapshot, compiled, edit.relationId, edit.key, edit.fields);
        if ('issues' in planned) issues.push(...planned.issues);
        else intents.push(planned.intent);
        continue;
      }
      const candidates = projection.rows.filter((row) => row.relationId === edit.relationId && samePortable(row.locator, edit.locator));
      if (candidates.length !== 1) {
        issues.push(bindingIssue(candidates.length === 0 ? 'mapping.locator_stale' : 'mapping.locator_invalid', snapshot.sourceId, edit.relationId));
        continue;
      }
      const row = candidates[0] as AutomergeMappedStorageRow;
      if (!samePortable(row.key, edit.key)) {
        issues.push(bindingIssue('mapping.locator_stale', snapshot.sourceId, edit.relationId, row.storagePath, { reason: 'logical_key_changed' }));
        continue;
      }
      if (edit.kind === 'delete') {
        const planned = planPropertyEdit(snapshot.storage, { kind: 'delete', path: row.storagePath });
        if ('issue' in planned) issues.push(projectionIssue(planned.issue.code, snapshot.sourceId, edit.relationId, planned.issue.path, planned.issue.details));
        else intents.push(intentAt(row.storagePath, planned.command));
        continue;
      }
      if (edit.kind !== 'replace-fields' && edit.kind !== 'replace-row') {
        issues.push(bindingIssue('transaction.capability_unavailable', snapshot.sourceId, edit.relationId, row.storagePath, { edit: edit.kind }));
        continue;
      }
      let fieldInputs: readonly (readonly [string, JsonValue | undefined])[];
      if (edit.kind === 'replace-row') {
        const parsed = parseRelationCandidate(this.#mapping.schema, compiled.relation, edit.fields, this.#registry, {
          sourceId: snapshot.sourceId,
          relationId: edit.relationId
        });
        if (!parsed.success) {
          issues.push(...parsed.issues.map((issue) => withEvidence(issue, snapshot.sourceId, edit.relationId, row.storagePath, edit.key)));
          continue;
        }
        if (!samePortable(parsed.value.key, row.key)) {
          issues.push(bindingIssue('mapping.rekey_required', snapshot.sourceId, edit.relationId, row.storagePath));
          continue;
        }
        fieldInputs = Object.keys(compiled.mapping.fields).map((field) => [field, parsed.value.row[field]] as const);
      } else {
        fieldInputs = Object.entries(edit.fields);
      }
      for (const [field, input] of fieldInputs) {
        if (field in compiled.mapping.keys) {
          if (!samePortable(row.fields[field], input)) issues.push(bindingIssue('mapping.rekey_required', snapshot.sourceId, edit.relationId, row.storagePath, { field }));
          continue;
        }
        const fieldMapping = compiled.mapping.fields[field];
        const declaration = compiled.relation.declaration.fields[field];
        if (fieldMapping === undefined || declaration === undefined || fieldMapping.write.kind !== 'replace') {
          issues.push(bindingIssue('mapping.field_read_only', snapshot.sourceId, edit.relationId, row.storagePath, { field }));
          continue;
        }
        if (this.#registry !== undefined && !this.#registry.satisfies(fieldMapping.write.capability)) {
          issues.push(createIssue({ code: 'mapping.capability_unavailable', sourceId: snapshot.sourceId, relationId: edit.relationId, requiredCapabilities: [fieldMapping.write.capability], retry: 'after_capability', details: { field } }));
          continue;
        }
        const path = [...row.storagePath, ...fieldMapping.path] as AutomergePath;
        if (input === undefined) {
          if (valueAtAutomergePath(snapshot.storage, path) === undefined) continue;
          const planned = planPropertyEdit(snapshot.storage, { kind: 'delete', path });
          if ('issue' in planned) issues.push(projectionIssue(planned.issue.code, snapshot.sourceId, edit.relationId, planned.issue.path, planned.issue.details));
          else intents.push(intentAt(path, planned.command));
          continue;
        }
        const parsed = parseScalarValueForField(this.#mapping.schema, declaration, input, this.#registry, [field]);
        if (!parsed.success) {
          issues.push(...parsed.issues.map((issue) => withEvidence(issue, snapshot.sourceId, edit.relationId, row.storagePath)));
          continue;
        }
        if (samePortable(row.fields[field], parsed.value)) continue;
        const planned = planPropertyEdit(snapshot.storage, { kind: 'replace', path, value: parsed.value });
        if ('issue' in planned) issues.push(projectionIssue(planned.issue.code, snapshot.sourceId, edit.relationId, planned.issue.path, planned.issue.details));
        else intents.push(intentAt(path, planned.command));
      }
    }
    const writeFootprint = automergePathFootprint(intents.flatMap(({ footprint }) => footprint.entries));
    return issues.some(({ severity }) => severity === 'error')
      ? { readFootprint: this.declaredReadFootprint, writeFootprint, intents: [], issues }
      : { readFootprint: this.declaredReadFootprint, writeFootprint, intents, issues };
  };

  #planInsert(
    snapshot: SourceSnapshot<Automerge.Doc<T>>,
    compiled: MappedRelation,
    relationId: string,
    key: JsonValue,
    fields: Readonly<Record<string, JsonValue>>
  ): { readonly intent: { readonly footprint: AutomergePathFootprint; readonly command: AutomergeSourceCommand<T> } } | { readonly issues: readonly Issue[] } {
    const keyValues = Array.isArray(key) ? key : [];
    const keyFields = compiled.relation.declaration.key;
    if (keyValues.length !== keyFields.length) return { issues: [bindingIssue('schema.key_arity', snapshot.sourceId, relationId)] };
    const logical: Record<string, JsonValue> = { ...fields };
    keyFields.forEach((field, index) => { logical[field] = keyValues[index] as JsonValue; });
    const mapKeys = Object.entries(compiled.mapping.keys).filter(([, mapping]) => mapping.kind === 'map-key');
    if (mapKeys.length !== 1) return { issues: [bindingIssue('mapping.key_invalid', snapshot.sourceId, relationId, compiled.mapping.collection.path, { reason: 'single_map_key_required' })] };
    const [mapKeyField] = mapKeys[0] as [string, Extract<RelationStorageMapping['keys'][string], { readonly kind: 'map-key' }>];
    const rawMapKey = logical[mapKeyField];
    const candidatePath = typeof rawMapKey === 'string'
      ? [...compiled.mapping.collection.path, rawMapKey] as AutomergePath
      : compiled.mapping.collection.path as AutomergePath;
    const parsed = parseRelationCandidate(this.#mapping.schema, compiled.relation, logical, this.#registry, { sourceId: snapshot.sourceId, relationId });
    if (!parsed.success) {
      return { issues: parsed.issues.map((issue) => withEvidence(issue, snapshot.sourceId, relationId, candidatePath, key)) };
    }
    const mapKey = parsed.value.row[mapKeyField];
    if (typeof mapKey !== 'string' || (compiled.mapping.collection.path.length === 0 && isAutomergeReservedRootProperty(mapKey))) {
      return { issues: [bindingIssue('mapping.key_invalid', snapshot.sourceId, relationId, compiled.mapping.collection.path, { reason: 'string_map_key_required' })] };
    }
    const collection = valueAtAutomergePath(snapshot.storage, compiled.mapping.collection.path as AutomergePath);
    const createCollection = collection === undefined && compiled.mapping.collection.absent === 'creatable';
    if (!isRecord(collection) && !createCollection) {
      return { issues: [bindingIssue('mapping.collection_invalid', snapshot.sourceId, relationId, compiled.mapping.collection.path)] };
    }
    if (isRecord(collection) && (Object.hasOwn(collection, mapKey) || conflictsAt(collection, mapKey).length > 0)) {
      return { issues: [bindingIssue('transaction.upsert_conflict', snapshot.sourceId, relationId, [...compiled.mapping.collection.path, mapKey])] };
    }
    const physical: Record<string, JsonValue> = {};
    for (const [field, mapping] of Object.entries(compiled.mapping.keys)) {
      if (mapping.kind === 'map-key') {
        if (mapping.mirrorPath !== undefined && !setPortablePath(physical, mapping.mirrorPath, parsed.value.row[field] as JsonValue)) {
          return { issues: [bindingIssue('mapping.path_invalid', snapshot.sourceId, relationId, mapping.mirrorPath)] };
        }
      } else if (!setPortablePath(physical, mapping.path, parsed.value.row[field] as JsonValue)) {
        return { issues: [bindingIssue('mapping.path_invalid', snapshot.sourceId, relationId, mapping.path)] };
      }
    }
    for (const [field, mapping] of Object.entries(compiled.mapping.fields)) {
      if (!Object.hasOwn(parsed.value.row, field)) continue;
      if (!setPortablePath(physical, mapping.path, parsed.value.row[field] as JsonValue)) {
        return { issues: [bindingIssue('mapping.path_invalid', snapshot.sourceId, relationId, mapping.path)] };
      }
    }
    const path = [...compiled.mapping.collection.path, mapKey] as AutomergePath;
    if (createCollection) {
      const collectionPath = compiled.mapping.collection.path as AutomergePath;
      if (collectionPath.length === 0) {
        return { issues: [bindingIssue('mapping.collection_invalid', snapshot.sourceId, relationId, collectionPath, { reason: 'root_collection_cannot_be_created' })] };
      }
      const parentPath = collectionPath.slice(0, -1) as AutomergePath;
      const member = collectionPath.at(-1);
      const parent = valueAtAutomergePath(snapshot.storage, parentPath);
      if (!isRecord(parent) || typeof member !== 'string' || conflictsAt(parent, member).length > 0 || Object.hasOwn(parent, member)) {
        return { issues: [bindingIssue('mapping.collection_invalid', snapshot.sourceId, relationId, collectionPath, { reason: 'uncreatable_or_ambiguous_parent' })] };
      }
      return {
        intent: {
          footprint: automergePathFootprint([{ scope: 'subtree', path: collectionPath }]),
          command: {
            description: 'create mapped object collection and insert row',
            apply: (draft) => {
              const target = valueAtAutomergePath(draft, parentPath);
              if (!isRecord(target) || Object.hasOwn(target, member)) throw new Error('Mapped collection target changed after planning');
              target[member] = { [mapKey]: copyPortable(physical) };
            }
          }
        }
      };
    }
    return {
      intent: intentAt(path, {
        description: 'insert mapped object row',
        apply: (draft) => {
          const target = valueAtAutomergePath(draft, compiled.mapping.collection.path as AutomergePath);
          if (!isRecord(target) || Object.hasOwn(target, mapKey)) throw new Error('Mapped insert target changed after planning');
          target[mapKey] = copyPortable(physical);
        }
      })
    };
  }
}

const adoptOptions = (input: AutomergeMappedStorageBindingOptions): AutomergeMappedStorageBindingOptions => {
  if (!isRecord(input)) throw new TypeError('Mapped Automerge binding options must be a record');
  const mapping = ownValue(input, 'mapping');
  if (mapping === undefined || !isRecord(mapping)) throw new TypeError('Mapped Automerge binding requires a compiled mapping');
  const id = ownValue(input, 'id');
  const registry = ownValue(input, 'registry');
  const locatorNamespace = ownValue(input, 'locatorNamespace');
  const rawRelationIds = ownValue(input, 'relationIds');
  if (id !== undefined && typeof id !== 'string') throw new TypeError('Mapped Automerge binding id must be a string');
  if (locatorNamespace !== undefined && typeof locatorNamespace !== 'string') throw new TypeError('Mapped Automerge locator namespace must be a string');
  let relationIds: readonly string[] | undefined;
  if (rawRelationIds !== undefined) {
    if (!Array.isArray(rawRelationIds) || rawRelationIds.some((value) => typeof value !== 'string')) throw new TypeError('Mapped Automerge relationIds must be strings');
    relationIds = Object.freeze([...new Set(rawRelationIds as string[])]);
  }
  return Object.freeze({
    mapping: mapping as CompiledStorageMapping,
    ...(id === undefined ? {} : { id }),
    ...(registry === undefined ? {} : { registry: registry as CapabilityRegistry }),
    ...(locatorNamespace === undefined ? {} : { locatorNamespace }),
    ...(relationIds === undefined ? {} : { relationIds })
  });
};

const ownValue = (input: object, key: string): unknown => {
  const descriptor = Object.getOwnPropertyDescriptor(input, key);
  if (descriptor === undefined) return undefined;
  if (!descriptor.enumerable || !('value' in descriptor)) throw new TypeError('Mapped Automerge binding option ' + key + ' must be an enumerable data property');
  return descriptor.value;
};

const intentAt = <T extends object>(path: AutomergePath, command: AutomergeSourceCommand<T>) => ({
  footprint: automergePathFootprint([{ scope: 'exact' as const, path }]),
  command
});

const conflictsAlongMappedPaths = (
  doc: object,
  rowPath: AutomergePath,
  mapping: RelationStorageMapping
): readonly { readonly path: AutomergePath; readonly changeHashes: readonly string[] }[] => {
  const relativePaths = [
    ...Object.values(mapping.keys).flatMap((key) => key.kind === 'field'
      ? [key.path]
      : key.mirrorPath === undefined ? [] : [key.mirrorPath]),
    ...Object.values(mapping.fields).map(({ path }) => path)
  ];
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

const setPortablePath = (root: Record<string, JsonValue>, path: readonly (string | number)[], value: JsonValue): boolean => {
  if (path.length === 0 || path.some((part) => typeof part !== 'string')) return false;
  let current = root;
  for (const [index, part] of path.entries()) {
    const key = part as string;
    if (index === path.length - 1) {
      current[key] = copyPortable(value);
      return true;
    }
    const child = current[key];
    if (child === undefined) {
      const created: Record<string, JsonValue> = {};
      current[key] = created;
      current = created;
    } else if (isRecord(child)) current = child as Record<string, JsonValue>;
    else return false;
  }
  return false;
};

const copyPortable = (value: JsonValue): JsonValue => {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(copyPortable);
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, copyPortable(child)]));
};

const samePortable = (left: unknown, right: unknown): boolean => {
  try { return canonicalizeJson(left as JsonValue) === canonicalizeJson(right as JsonValue); } catch { return false; }
};

const withEvidence = (issue: Issue, sourceId: string, relationId: string, candidatePath: AutomergePath, key?: JsonValue): Issue => createIssue({
  ...issue,
  sourceId,
  relationId,
  ...(key === undefined ? {} : { key }),
  path: [...candidatePath, ...(issue.path ?? [])]
});

const rebaseProjectionIssue = (issue: Issue, collectionPath: readonly (string | number)[]): Issue => {
  if (!issue.code.startsWith('schema.')) return issue;
  const details = isRecord(issue.details) ? issue.details : undefined;
  const locator = details !== undefined && isRecord(details.locator) ? details.locator : undefined;
  if (locator?.kind !== 'object-map-key' || typeof locator.key !== 'string') return issue;
  const relative = typeof issue.path?.[0] === 'number' ? issue.path.slice(1) : issue.path ?? [];
  return createIssue({ ...issue, path: [...collectionPath, locator.key, ...relative] });
};

const projectionIssue = (code: string, sourceId: string, relationId: string, path?: readonly unknown[], details?: unknown): Issue =>
  bindingIssue(code, sourceId, relationId, path, details);

const bindingIssue = (code: string, sourceId: string, relationId?: string, path?: readonly unknown[], details?: unknown): Issue => createIssue({
  code,
  phase: 'plan',
  severity: 'error',
  retry: code.includes('stale') ? 'after_refresh' : code.includes('capability') ? 'after_capability' : 'after_input',
  sourceId,
  ...(relationId === undefined ? {} : { relationId }),
  ...(path === undefined ? {} : { path }),
  ...(details === undefined ? {} : { details })
});

const sourceIssue = (sourceId: string, state: SourceSnapshot<unknown>['state']): Issue => createIssue({
  code: state === 'closed' ? 'source.closed' : 'source.not_ready',
  phase: state === 'closed' ? 'lifecycle' : 'load', severity: 'error', retry: state === 'closed' ? 'never' : 'after_refresh', sourceId, details: { state }
});

const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
