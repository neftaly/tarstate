import * as Automerge from '@automerge/automerge';
import {
  canonicalizeJson,
  createIssue,
  type Issue,
  type JsonValue
} from '@tarstate/core';
import type { CapabilityRegistry } from '@tarstate/core/capabilities';
import {
  parseRelationCandidate,
  parseScalarValueForField,
  projectStorage,
  type CompiledStorageMapping,
  type SourceMetadataResolver
} from '@tarstate/core/schema';
import {
  type LogicalEdit,
  type PlanResult,
  type ProjectionResult,
  type SourceSnapshot,
  type StorageBinding
} from '@tarstate/core/source';
import {
  automergePathFootprint,
  type AutomergePathFootprint,
  type AutomergePathFootprintEntry
} from './footprint.js';
import { conflictsAt, type AutomergePath } from '../document/projection.js';
import { isAutomergeReservedRootProperty } from '../document/reserved-properties.js';
import { samePortableJson } from '../shared/portable-json.js';
import {
  planPropertyEdit
} from './property-edits.js';
import { valueAtAutomergePath } from './path-access.js';
import { createAutomergeStorageScalarCodec } from './scalar-codec.js';
import {
  affectedMappedRelations,
  conflictsAlongMappedPaths,
  locateProjectedCandidate,
  mappedReadEntries,
  mappedWriteEntries
} from './mapped-projection.js';
import type { AutomergeSourceCommand } from '../source/runtime.js';

export type AutomergeMappedStorageRow = {
  readonly relationId: string;
  readonly key: readonly [JsonValue, ...JsonValue[]];
  readonly fields: Readonly<Record<string, JsonValue>>;
  readonly locator: {
    readonly namespace: string;
    readonly token: JsonValue;
    readonly rowIncarnation: string;
  };
  readonly storagePath: AutomergePath;
};

export type AutomergeMappedStorageBindingOptions = {
  readonly id?: string;
  readonly mapping: CompiledStorageMapping;
  readonly registry?: CapabilityRegistry;
  readonly relationIds?: readonly string[];
  readonly locatorNamespace?: string;
};

type MappedRelation = CompiledStorageMapping['relations'] extends ReadonlyMap<string, infer Relation> ? Relation : never;

/**
 * Writable Automerge mapped-storage binding derived from the same compiled
 * `json-tree-v1` mapping used by `projectStorage`.
 */
export class AutomergeMappedStorageBinding<T extends object>
implements StorageBinding<Automerge.Doc<T>, AutomergeSourceCommand<T>, AutomergeMappedStorageRow> {
  readonly id: string;
  readonly relationIds: readonly string[];
  readonly declaredReadFootprint: AutomergePathFootprint;
  readonly declaredWriteFootprint: AutomergePathFootprint;
  readonly #mapping: CompiledStorageMapping;
  readonly #registry: CapabilityRegistry | undefined;
  readonly #relations: ReadonlyMap<string, MappedRelation>;
  readonly #relationSelection: ReadonlySet<string>;
  readonly #locatorNamespace: string;
  readonly #relationValuePaths: ReadonlyMap<string, readonly (readonly (string | number)[])[]>;
  readonly #relationReadEntries: ReadonlyMap<string, readonly AutomergePathFootprintEntry[]>;
  readonly #scalarCodec = createAutomergeStorageScalarCodec();
  readonly #projections = new WeakMap<object, Map<string, ProjectionResult<AutomergeMappedStorageRow>>>();
  readonly #previousProjections = new Map<string, {
    readonly sourceId: string;
    readonly heads: readonly string[];
    readonly result: ProjectionResult<AutomergeMappedStorageRow>;
  }>();

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
      relations.set(relationId, relation as MappedRelation);
    }
    this.#relations = relations;
    this.relationIds = Object.freeze([...relations.keys()]);
    this.#relationSelection = new Set(this.relationIds);
    const relationValuePaths = new Map<string, readonly AutomergePath[]>();
    const relationReadEntries = new Map<string, readonly AutomergePathFootprintEntry[]>();
    for (const [relationId, { mapping, valuePaths: compiledValuePaths }] of relations) {
      const valuePaths = compiledValuePaths as readonly AutomergePath[];
      relationValuePaths.set(relationId, valuePaths);
      relationReadEntries.set(relationId, mappedReadEntries(mapping, valuePaths));
    }
    this.#relationValuePaths = relationValuePaths;
    this.#relationReadEntries = relationReadEntries;
    this.declaredReadFootprint = automergePathFootprint([...this.#relationReadEntries.values()].flat());
    this.declaredWriteFootprint = automergePathFootprint([...relations.values()].flatMap(({ mapping }) => mappedWriteEntries(mapping)));
  }

  project = (
    snapshot: SourceSnapshot<Automerge.Doc<T>>,
    requestedRelations?: ReadonlySet<string>,
    requestedFields?: ReadonlyMap<string, ReadonlySet<string>>
  ): ProjectionResult<AutomergeMappedStorageRow> => {
    if (snapshot.state !== 'ready' || snapshot.storage === undefined) {
      return { rows: [], completeness: 'unknown', issues: [sourceIssue(snapshot.sourceId, snapshot.state)] };
    }
    const selected = requestedRelations === undefined
      ? this.#relationSelection
      : new Set(this.relationIds.filter((relationId) => requestedRelations.has(relationId)));
    const selectedFields = requestedFields === undefined
      ? undefined
      : new Map([...selected].map((relationId) => [
          relationId,
          requestedFields.get(relationId) ?? emptyFieldSelection
        ]));
    const cacheKey = projectionSelectionKey(snapshot.sourceId, selected, selectedFields);
    const cached = this.#projections.get(snapshot.storage)?.get(cacheKey);
    if (cached !== undefined) return cached;
    const previous = this.#previousProjections.get(cacheKey);
    const selectedValuePaths = selectedFields === undefined
      ? this.#relationValuePaths
      : new Map([...selected].map((relationId) => {
          const compiled = this.#relations.get(relationId) as MappedRelation;
          return [relationId, selectedMappedValuePaths(
            compiled.mapping,
            selectedFields.get(relationId) ?? emptyFieldSelection
          )] as const;
        }));
    const selectedReadEntries = selectedFields === undefined
      ? this.#relationReadEntries
      : new Map([...selectedValuePaths].map(([relationId, paths]) => [
          relationId,
          mappedReadEntries((this.#relations.get(relationId) as MappedRelation).mapping, paths)
        ]));
    const affected = previous?.result.completeness === 'exact'
      ? affectedMappedRelations(snapshot.sourceId, snapshot.storage, previous, selectedReadEntries)
      : undefined;
    if (affected !== undefined && affected.size === 0 && previous !== undefined) {
      rememberProjection(this.#projections, snapshot.storage, cacheKey, previous.result);
      this.#rememberPreviousProjection(cacheKey, {
        sourceId: snapshot.sourceId,
        heads: Automerge.getHeads(snapshot.storage),
        result: previous.result
      });
      return previous.result;
    }
    const projectedRelations = affected ?? selected;
    const projection = projectStorage(this.#mapping, snapshot.storage, {
      ...(this.#registry === undefined ? {} : { registry: this.#registry }),
      sourceId: snapshot.sourceId,
      relationIds: projectedRelations,
      ...(selectedFields === undefined ? {} : { fieldsByRelation: selectedFields }),
      scalarDecoder: this.#scalarCodec.decode,
      sourceMetadata: automergeSourceMetadata
    });
    const rows: AutomergeMappedStorageRow[] = affected === undefined || previous === undefined
      ? []
      : previous.result.rows.filter((row) => !affected.has(row.relationId));
    const issues: Issue[] = affected === undefined || previous === undefined
      ? []
      : previous.result.issues.filter((issue) => issue.relationId === undefined || !affected.has(issue.relationId));
    let incomplete = false;
    for (const [relationId, compiled] of this.#relations) {
      if (!projectedRelations.has(relationId)) continue;
      const relation = projection.relations.get(relationId);
      if (relation === undefined) {
        incomplete = true;
        issues.push(bindingIssue('mapping.relation_missing', snapshot.sourceId, relationId));
        continue;
      }
      issues.push(...relation.issues.map((issue) => rebaseProjectionIssue(issue, compiled.mapping.collection.path)));
      if (relation.completeness !== 'exact') incomplete = true;
      for (const projected of relation.rows) {
        const located = locateProjectedCandidate(snapshot.storage, compiled.mapping, projected.locator);
        if ('issue' in located) {
          incomplete = true;
          issues.push(bindingIssue(located.issue, snapshot.sourceId, relationId, compiled.mapping.collection.path));
          continue;
        }
        const { candidate, path, collectionConflict } = located;
        if (collectionConflict !== undefined) {
          incomplete = true;
          issues.push(createIssue({
            code: collectionConflict.code, phase: 'query', severity: 'warning', retry: 'manual_repair',
            sourceId: snapshot.sourceId, relationId, path,
            details: { changeHashes: collectionConflict.changeHashes }
          }));
          continue;
        }
        const mappedConflicts = conflictsAlongMappedPaths(
          snapshot.storage,
          path,
          selectedValuePaths.get(relationId) ?? []
        );
        if (mappedConflicts.length > 0) {
          incomplete = true;
          issues.push(...mappedConflicts.map((conflict) => createIssue({
            code: 'automerge.conflict_observed', phase: 'query', severity: 'warning', retry: 'manual_repair',
            sourceId: snapshot.sourceId, relationId, path: conflict.path,
            details: { changeHashes: conflict.changeHashes }
          })));
          continue;
        }
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
    const result = Object.freeze({
      rows: Object.freeze(rows),
      completeness: incomplete ? 'unknown' : 'exact',
      issues: Object.freeze(issues)
    });
    rememberProjection(this.#projections, snapshot.storage, cacheKey, result);
    this.#rememberPreviousProjection(cacheKey, {
      sourceId: snapshot.sourceId,
      heads: Automerge.getHeads(snapshot.storage),
      result
    });
    return result;
  };

  #rememberPreviousProjection(
    key: string,
    projection: {
      readonly sourceId: string;
      readonly heads: readonly string[];
      readonly result: ProjectionResult<AutomergeMappedStorageRow>;
    }
  ): void {
    if (!this.#previousProjections.has(key) && this.#previousProjections.size >= 64) {
      this.#previousProjections.delete(this.#previousProjections.keys().next().value as string);
    }
    this.#previousProjections.set(key, projection);
  }

  plan = (snapshot: SourceSnapshot<Automerge.Doc<T>>, edits: readonly LogicalEdit[]): PlanResult<AutomergeSourceCommand<T>> => {
    const handledEdits = edits.flatMap((edit, editIndex) => this.#relations.has(edit.relationId)
      ? [{ editIndex, mode: 'exclusive' as const }]
      : []);
    const relevant = handledEdits.map(({ editIndex }) => edits[editIndex] as LogicalEdit);
    const empty = automergePathFootprint([]);
    if (relevant.length === 0) return { handledEdits, readFootprint: empty, writeFootprint: empty, intents: [], issues: [] };
    if (snapshot.state !== 'ready' || snapshot.storage === undefined) {
      return { handledEdits, readFootprint: this.declaredReadFootprint, writeFootprint: empty, intents: [], issues: [sourceIssue(snapshot.sourceId, snapshot.state)] };
    }
    const projection = this.project(snapshot);
    const issues = [...projection.issues];
    if (projection.completeness !== 'exact') {
      return { handledEdits, readFootprint: this.declaredReadFootprint, writeFootprint: empty, intents: [], issues };
    }
    const rowsByLocator = new Map<string, AutomergeMappedStorageRow[]>();
    const existingKeys = relevant.some(({ kind }) => kind === 'insert')
      ? new Set<string>()
      : undefined;
    for (const row of projection.rows) {
      const key = compoundKey(row.relationId, canonicalizeJson(row.locator));
      const bucket = rowsByLocator.get(key);
      if (bucket === undefined) rowsByLocator.set(key, [row]);
      else bucket.push(row);
      existingKeys?.add(compoundKey(row.relationId, canonicalizeJson(row.key)));
    }
    const intents: { readonly footprint: AutomergePathFootprint; readonly command: AutomergeSourceCommand<T> }[] = [];
    for (const edit of relevant) {
      const compiled = this.#relations.get(edit.relationId) as MappedRelation;
      if (edit.kind === 'insert-generated-key') {
        const planned = planGeneratedKeyInsert({
          snapshot,
          compiled,
          relationId: edit.relationId,
          token: edit.token,
          fields: edit.fields,
          schema: this.#mapping.schema,
          ...(this.#registry === undefined ? {} : { registry: this.#registry }),
          scalarCodec: this.#scalarCodec
        });
        if ('issues' in planned) issues.push(...planned.issues);
        else intents.push(planned.intent);
        continue;
      }
      if (edit.kind === 'insert') {
        const logicalKey = compoundKey(edit.relationId, canonicalizeJson(edit.key));
        if (existingKeys?.has(logicalKey)) {
          issues.push(bindingIssue('transaction.upsert_conflict', snapshot.sourceId, edit.relationId, undefined, { key: edit.key }));
          continue;
        }
        const planned = this.#planInsert(snapshot, compiled, edit.relationId, edit.key, edit.fields);
        if ('issues' in planned) issues.push(...planned.issues);
        else {
          intents.push(planned.intent);
          existingKeys?.add(logicalKey);
        }
        continue;
      }
      const candidates = rowsByLocator.get(compoundKey(edit.relationId, canonicalizeJson(edit.locator))) ?? [];
      if (candidates.length !== 1) {
        issues.push(bindingIssue(candidates.length === 0 ? 'mapping.locator_stale' : 'mapping.locator_invalid', snapshot.sourceId, edit.relationId));
        continue;
      }
      const row = candidates[0] as AutomergeMappedStorageRow;
      if (!samePortableJson(row.key, edit.key)) {
        issues.push(bindingIssue('mapping.locator_stale', snapshot.sourceId, edit.relationId, row.storagePath, { reason: 'logical_key_changed' }));
        continue;
      }
      if (edit.kind === 'delete') {
        if (compiled.mapping.collection.kind === 'singleton') {
          issues.push(bindingIssue('transaction.capability_unavailable', snapshot.sourceId, edit.relationId, row.storagePath, { edit: 'delete', collection: 'singleton' }));
          continue;
        }
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
        if (!samePortableJson(parsed.value.key, row.key)) {
          issues.push(bindingIssue('mapping.rekey_required', snapshot.sourceId, edit.relationId, row.storagePath));
          continue;
        }
        const mappedInputs: (readonly [string, JsonValue | undefined])[] = [];
        for (const field of Object.keys(compiled.mapping.fields)) {
          const mapping = compiled.mapping.fields[field];
          if (mapping?.kind !== 'absent' || Object.hasOwn(parsed.value.row, field)) {
            mappedInputs.push([field, parsed.value.row[field]]);
          }
        }
        fieldInputs = mappedInputs;
      } else {
        fieldInputs = Object.entries(edit.fields);
      }
      for (const [field, input] of fieldInputs) {
        if (field in compiled.mapping.keys) {
          if (!samePortableJson(row.fields[field], input)) issues.push(bindingIssue('mapping.rekey_required', snapshot.sourceId, edit.relationId, row.storagePath, { field }));
          continue;
        }
        const fieldMapping = compiled.mapping.fields[field];
        const declaration = compiled.relation.declaration.fields[field];
        if (fieldMapping === undefined || declaration === undefined
          || fieldMapping.kind === 'absent'
          || fieldMapping.kind === 'source-metadata'
          || fieldMapping.write.kind !== 'replace') {
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
        if (samePortableJson(row.fields[field], parsed.value)) continue;
        const encoded = this.#scalarCodec.encode({
          value: parsed.value,
          declaration,
          relationId: edit.relationId,
          field,
          path
        });
        if (!encoded.success) {
          issues.push(...encoded.issues.map((issue) => withEvidence(issue, snapshot.sourceId, edit.relationId, path)));
          continue;
        }
        const planned = planPropertyEdit(snapshot.storage, { kind: 'replace', path, value: encoded.value });
        if ('issue' in planned) issues.push(projectionIssue(planned.issue.code, snapshot.sourceId, edit.relationId, planned.issue.path, planned.issue.details));
        else intents.push(intentAt(path, planned.command));
      }
    }
    const writeFootprint = automergePathFootprint(intents.flatMap(({ footprint }) => footprint.entries));
    const combinedCommand: AutomergeSourceCommand<T> | undefined = intents.length === 0
      ? undefined
      : {
          description: intents.map(({ command }) => command.description).join('; '),
          ...(intents.some(({ command }) => command.generatesKeys === true)
            ? { generatesKeys: true as const }
            : {}),
          apply: (draft, context) => {
            for (const intent of intents) intent.command.apply(draft, context);
          }
        };
    const combinedIntents = intents.length === 0
      ? []
      : [{
          footprint: writeFootprint,
          command: combinedCommand as AutomergeSourceCommand<T>
        }];
    return issues.some(({ severity }) => severity === 'error')
      ? { handledEdits, readFootprint: this.declaredReadFootprint, writeFootprint, intents: [], issues }
      : { handledEdits, readFootprint: this.declaredReadFootprint, writeFootprint, intents: combinedIntents, issues };
  };

  #planInsert(
    snapshot: SourceSnapshot<Automerge.Doc<T>>,
    compiled: MappedRelation,
    relationId: string,
    key: JsonValue,
    fields: Readonly<Record<string, JsonValue>>
  ): { readonly intent: { readonly footprint: AutomergePathFootprint; readonly command: AutomergeSourceCommand<T> } } | { readonly issues: readonly Issue[] } {
    const collectionMapping = compiled.mapping.collection;
    if (collectionMapping.kind === 'singleton') {
      return { issues: [bindingIssue('transaction.capability_unavailable', snapshot.sourceId, relationId, compiled.mapping.collection.path, { edit: 'insert', collection: compiled.mapping.collection.kind })] };
    }
    const keyValues = Array.isArray(key) ? key : [];
    const keyFields = compiled.relation.declaration.key;
    if (keyValues.length !== keyFields.length) return { issues: [bindingIssue('schema.key_arity', snapshot.sourceId, relationId)] };
    const logical: Record<string, JsonValue> = { ...fields };
    keyFields.forEach((field, index) => { logical[field] = keyValues[index] as JsonValue; });
    const mapKeys = Object.entries(compiled.mapping.keys).filter(([, mapping]) => mapping.kind === 'map-key');
    if ((collectionMapping.kind === 'object-map' && mapKeys.length !== 1)
      || (collectionMapping.kind === 'array' && mapKeys.length !== 0)) {
      return { issues: [bindingIssue('mapping.key_invalid', snapshot.sourceId, relationId, collectionMapping.path, {
        reason: collectionMapping.kind === 'object-map' ? 'single_map_key_required' : 'map_key_requires_object_map'
      })] };
    }
    const mapKeyField = mapKeys[0]?.[0];
    const rawMapKey = mapKeyField === undefined ? undefined : logical[mapKeyField];
    let candidatePath = collectionMapping.path as AutomergePath;
    if (typeof rawMapKey === 'string') candidatePath = [...candidatePath, rawMapKey] as AutomergePath;
    const parsed = parseRelationCandidate(this.#mapping.schema, compiled.relation, logical, this.#registry, { sourceId: snapshot.sourceId, relationId });
    if (!parsed.success) {
      return { issues: parsed.issues.map((issue) => withEvidence(issue, snapshot.sourceId, relationId, candidatePath, key)) };
    }
    const mapKey = mapKeyField === undefined ? undefined : parsed.value.row[mapKeyField];
    if (collectionMapping.kind === 'object-map'
      && (typeof mapKey !== 'string'
        || (collectionMapping.path.length === 0 && isAutomergeReservedRootProperty(mapKey)))) {
      return { issues: [bindingIssue('mapping.key_invalid', snapshot.sourceId, relationId, compiled.mapping.collection.path, { reason: 'string_map_key_required' })] };
    }
    const collection = valueAtAutomergePath(snapshot.storage, collectionMapping.path as AutomergePath);
    const createCollection = collection === undefined && collectionMapping.absent === 'creatable';
    const validCollection = collectionMapping.kind === 'array'
      ? Array.isArray(collection)
      : isRecord(collection);
    if (!validCollection && !createCollection) {
      return { issues: [bindingIssue('mapping.collection_invalid', snapshot.sourceId, relationId, compiled.mapping.collection.path)] };
    }
    if (collectionMapping.kind === 'object-map'
      && isRecord(collection)
      && typeof mapKey === 'string'
      && (Object.hasOwn(collection, mapKey) || conflictsAt(collection, mapKey).length > 0)) {
      return { issues: [bindingIssue('transaction.upsert_conflict', snapshot.sourceId, relationId, [...compiled.mapping.collection.path, mapKey])] };
    }
    if (collectionMapping.kind === 'array' && Array.isArray(collection)) {
      candidatePath = [...collectionMapping.path, collection.length] as AutomergePath;
    }
    const physical: Record<string, unknown> = {};
    for (const [field, mapping] of Object.entries(compiled.mapping.keys)) {
      if (mapping.kind === 'map-key') {
        if (mapping.mirrorPath !== undefined && !setStoragePath(physical, mapping.mirrorPath, parsed.value.row[field])) {
          return { issues: [bindingIssue('mapping.path_invalid', snapshot.sourceId, relationId, mapping.mirrorPath)] };
        }
      } else if (mapping.kind === 'field') {
        const declaration = compiled.relation.declaration.fields[field] as typeof compiled.relation.declaration.fields[string];
        const encoded = this.#scalarCodec.encode({ value: parsed.value.row[field], declaration, relationId, field, path: mapping.path });
        if (!encoded.success) return { issues: encoded.issues.map((issue) => withEvidence(issue, snapshot.sourceId, relationId, candidatePath)) };
        if (!setStoragePath(physical, mapping.path, encoded.value)) {
          return { issues: [bindingIssue('mapping.path_invalid', snapshot.sourceId, relationId, mapping.path)] };
        }
      } else if (mapping.kind === 'literal') {
        return { issues: [bindingIssue('mapping.key_invalid', snapshot.sourceId, relationId, compiled.mapping.collection.path, { reason: 'literal_key_requires_singleton' })] };
      } else {
        return { issues: [bindingIssue('transaction.capability_unavailable', snapshot.sourceId, relationId, candidatePath, { edit: 'insert', sourceMetadata: mapping.value })] };
      }
    }
    for (const [field, mapping] of Object.entries(compiled.mapping.fields)) {
      if (!Object.hasOwn(parsed.value.row, field)) continue;
      if (mapping.kind === 'absent' || mapping.kind === 'source-metadata') {
        return { issues: [bindingIssue('mapping.field_read_only', snapshot.sourceId, relationId, candidatePath, { field })] };
      }
      const declaration = compiled.relation.declaration.fields[field] as typeof compiled.relation.declaration.fields[string];
      const encoded = this.#scalarCodec.encode({ value: parsed.value.row[field], declaration, relationId, field, path: mapping.path });
      if (!encoded.success) return { issues: encoded.issues.map((issue) => withEvidence(issue, snapshot.sourceId, relationId, candidatePath)) };
      if (!setStoragePath(physical, mapping.path, encoded.value)) {
        return { issues: [bindingIssue('mapping.path_invalid', snapshot.sourceId, relationId, mapping.path)] };
      }
    }
    if (createCollection) {
      const collectionPath = collectionMapping.path as AutomergePath;
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
            description: 'create mapped collection and insert row',
            apply: (draft) => {
              const target = valueAtAutomergePath(draft, parentPath);
              if (!isRecord(target) || Object.hasOwn(target, member)) throw new Error('Mapped collection target changed after planning');
              target[member] = collectionMapping.kind === 'array'
                ? [copyStorageValue(physical)]
                : { [mapKey as string]: copyStorageValue(physical) };
            }
          }
        }
      };
    }
    if (collectionMapping.kind === 'array') {
      return {
        intent: {
          footprint: automergePathFootprint([{ scope: 'subtree', path: collectionMapping.path as AutomergePath }]),
          command: {
            description: 'append mapped array row',
            apply: (draft) => {
              const target = valueAtAutomergePath(draft, collectionMapping.path as AutomergePath);
              if (!Array.isArray(target)) throw new Error('Mapped insert target changed after planning');
              target.push(copyStorageValue(physical));
            }
          }
        }
      };
    }
    const storageMapKey = mapKey as string;
    const path = [...collectionMapping.path, storageMapKey] as AutomergePath;
    return {
      intent: intentAt(path, {
        description: 'insert mapped object row',
        apply: (draft) => {
          const target = valueAtAutomergePath(draft, compiled.mapping.collection.path as AutomergePath);
          if (!isRecord(target) || Object.hasOwn(target, storageMapKey)) throw new Error('Mapped insert target changed after planning');
          target[storageMapKey] = copyStorageValue(physical);
        }
      })
    };
  }

}

type GeneratedKeyInsertPlan<T extends object> = {
  readonly snapshot: SourceSnapshot<Automerge.Doc<T>>;
  readonly compiled: MappedRelation;
  readonly relationId: string;
  readonly token: string;
  readonly fields: Readonly<Record<string, JsonValue>>;
  readonly schema: CompiledStorageMapping['schema'];
  readonly registry?: CapabilityRegistry;
  readonly scalarCodec: ReturnType<typeof createAutomergeStorageScalarCodec>;
};

const planGeneratedKeyInsert = <T extends object>(
  input: GeneratedKeyInsertPlan<T>
): { readonly intent: { readonly footprint: AutomergePathFootprint; readonly command: AutomergeSourceCommand<T> } } | { readonly issues: readonly Issue[] } => {
    const { snapshot, compiled, relationId, token, fields } = input;
    const collection = compiled.mapping.collection;
    const keyMappings = Object.entries(compiled.mapping.keys);
    if (collection.kind !== 'array'
      || keyMappings.length === 0
      || keyMappings.some(([, mapping]) => mapping.kind !== 'source-metadata'
        || mapping.value !== 'collection-element-identity')) {
      return { issues: [bindingIssue(
        'transaction.capability_unavailable',
        snapshot.sourceId,
        relationId,
        collection.path,
        { edit: 'insert-generated-key', reason: 'source_generated_array_identity_required' }
      )] };
    }
    if (snapshot.storage === undefined) {
      return { issues: [sourceIssue(snapshot.sourceId, snapshot.state)] };
    }
    const physical: Record<string, unknown> = {};
    const issues: Issue[] = [];
    for (const [field, value] of Object.entries(fields)) {
      if (field in compiled.mapping.keys) {
        issues.push(bindingIssue('mapping.field_read_only', snapshot.sourceId, relationId, collection.path, { field }));
        continue;
      }
      const mapping = compiled.mapping.fields[field];
      const declaration = compiled.relation.declaration.fields[field];
      if (mapping === undefined || declaration === undefined) {
        issues.push(bindingIssue('mapping.field_unmapped', snapshot.sourceId, relationId, collection.path, { field }));
        continue;
      }
      if (mapping.kind === 'absent' || mapping.kind === 'source-metadata') {
        issues.push(bindingIssue('mapping.field_read_only', snapshot.sourceId, relationId, collection.path, { field }));
        continue;
      }
      const parsed = parseScalarValueForField(
        input.schema,
        declaration,
        value,
        input.registry,
        [field]
      );
      if (!parsed.success) {
        issues.push(...parsed.issues.map((issue) => withEvidence(issue, snapshot.sourceId, relationId, collection.path)));
        continue;
      }
      const encoded = input.scalarCodec.encode({
        value: parsed.value,
        declaration,
        relationId,
        field,
        path: mapping.path
      });
      if (!encoded.success) {
        issues.push(...encoded.issues.map((issue) => withEvidence(issue, snapshot.sourceId, relationId, collection.path)));
      } else if (!setStoragePath(physical, mapping.path, encoded.value)) {
        issues.push(bindingIssue('mapping.path_invalid', snapshot.sourceId, relationId, mapping.path));
      }
    }
    for (const [field, declaration] of Object.entries(compiled.relation.declaration.fields)) {
      const mapping = compiled.mapping.fields[field] ?? compiled.mapping.keys[field];
      const generated = mapping?.kind === 'source-metadata';
      if (!generated && declaration.optional !== true && !Object.hasOwn(fields, field)) {
        issues.push(bindingIssue('schema.field_missing', snapshot.sourceId, relationId, collection.path, { field }));
      }
    }
    if (issues.length > 0) return { issues };

    const current = valueAtAutomergePath(snapshot.storage, collection.path as AutomergePath);
    const createCollection = current === undefined && collection.absent === 'creatable';
    if (!Array.isArray(current) && !createCollection) {
      return { issues: [bindingIssue('mapping.collection_invalid', snapshot.sourceId, relationId, collection.path)] };
    }
    const recordInsertedKey = (
      inserted: unknown,
      context: Parameters<AutomergeSourceCommand<T>['apply']>[1]
    ): void => {
      const objectId = inserted !== null && typeof inserted === 'object'
        ? Automerge.getObjectId(inserted)
        : null;
      if (typeof objectId !== 'string') throw new Error('Generated Automerge row identity is unavailable');
      context.recordGeneratedKey(
        relationId,
        token,
        compiled.relation.declaration.key.map(() => objectId)
      );
    };
    const footprint = automergePathFootprint([{ scope: 'subtree', path: collection.path as AutomergePath }]);
    if (createCollection) {
      const collectionPath = collection.path as AutomergePath;
      if (collectionPath.length === 0) {
        return { issues: [bindingIssue('mapping.collection_invalid', snapshot.sourceId, relationId, collectionPath, { reason: 'root_collection_cannot_be_created' })] };
      }
      const parentPath = collectionPath.slice(0, -1) as AutomergePath;
      const member = collectionPath.at(-1);
      const parent = valueAtAutomergePath(snapshot.storage, parentPath);
      if (!isRecord(parent) || typeof member !== 'string' || conflictsAt(parent, member).length > 0 || Object.hasOwn(parent, member)) {
        return { issues: [bindingIssue('mapping.collection_invalid', snapshot.sourceId, relationId, collectionPath, { reason: 'uncreatable_or_ambiguous_parent' })] };
      }
      return { intent: { footprint, command: {
        description: 'create mapped collection and insert generated-key row',
        generatesKeys: true,
        apply: (draft, context) => {
          const target = valueAtAutomergePath(draft, parentPath);
          if (!isRecord(target) || Object.hasOwn(target, member)) throw new Error('Mapped collection target changed after planning');
          target[member] = [copyStorageValue(physical)];
          recordInsertedKey((target[member] as unknown[])[0], context);
        }
      } } };
    }
    return { intent: { footprint, command: {
      description: 'append mapped generated-key array row',
      generatesKeys: true,
      apply: (draft, context) => {
        const target = valueAtAutomergePath(draft, collection.path as AutomergePath);
        if (!Array.isArray(target)) throw new Error('Mapped insert target changed after planning');
        target.push(copyStorageValue(physical));
        recordInsertedKey(target[target.length - 1], context);
      }
    } } };
};

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

const rememberProjection = <Storage extends object, Row>(
  cache: WeakMap<object, Map<string, ProjectionResult<Row>>>,
  storage: Storage,
  key: string,
  result: ProjectionResult<Row>
): void => {
  const projections = cache.get(storage) ?? new Map<string, ProjectionResult<Row>>();
  if (!projections.has(key) && projections.size >= 64) projections.delete(projections.keys().next().value as string);
  projections.set(key, result);
  cache.set(storage, projections);
};

const ownValue = (input: object, key: string): unknown => {
  const descriptor = Object.getOwnPropertyDescriptor(input, key);
  if (descriptor === undefined) return undefined;
  if (!descriptor.enumerable || !('value' in descriptor)) throw new TypeError('Mapped Automerge binding option ' + key + ' must be an enumerable data property');
  return descriptor.value;
};

const compoundKey = (...parts: readonly string[]): string => {
  let key = '';
  for (const part of parts) key += part.length + ':' + part;
  return key;
};

const projectionSelectionKey = (
  sourceId: string,
  relationIds: ReadonlySet<string>,
  fieldsByRelation?: ReadonlyMap<string, ReadonlySet<string>>
): string => {
  let key = sourceId.length + ':' + sourceId;
  for (const relationId of relationIds) {
    key += relationId.length + ':' + relationId;
    if (fieldsByRelation === undefined) continue;
    const fields = fieldsByRelation.get(relationId);
    key += (fields?.size ?? 0) + ':';
    if (fields === undefined) continue;
    for (const field of fields) key += field.length + ':' + field;
  }
  return key;
};

const emptyFieldSelection: ReadonlySet<string> = new Set();

const selectedMappedValuePaths = (
  mapping: MappedRelation['mapping'],
  selectedFields: ReadonlySet<string>
): readonly AutomergePath[] => [
  ...Object.values(mapping.keys).flatMap((field) => {
    if (field.kind === 'field') return [field.path as AutomergePath];
    if (field.kind === 'map-key' && field.mirrorPath !== undefined) return [field.mirrorPath as AutomergePath];
    return [];
  }),
  ...Object.entries(mapping.fields).flatMap(([name, field]) =>
    selectedFields.has(name) && field.kind !== 'absent' && field.kind !== 'source-metadata'
      ? [field.path as AutomergePath]
      : [])
];

const intentAt = <T extends object>(path: AutomergePath, command: AutomergeSourceCommand<T>) => ({
  footprint: automergePathFootprint([{ scope: 'exact' as const, path }]),
  command
});

const setStoragePath = (root: Record<string, unknown>, path: readonly (string | number)[], value: unknown): boolean => {
  if (path.length === 0 || path.some((part) => typeof part !== 'string')) return false;
  let current = root;
  for (const [index, part] of path.entries()) {
    const key = part as string;
    if (index === path.length - 1) {
      current[key] = copyStorageValue(value);
      return true;
    }
    const child = current[key];
    if (child === undefined) {
      const created: Record<string, unknown> = {};
      current[key] = created;
      current = created;
    } else if (isRecord(child)) current = child;
    else return false;
  }
  return false;
};

const copyStorageValue = (value: unknown): unknown => {
  if (value instanceof Uint8Array) return new Uint8Array(value);
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(copyStorageValue);
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, copyStorageValue(child)]));
};

const automergeSourceMetadata: SourceMetadataResolver = ({ candidate }) => {
  const objectId = candidate !== null && typeof candidate === 'object'
    ? Automerge.getObjectId(candidate)
    : null;
  return typeof objectId === 'string' ? objectId : undefined;
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
  const relative = typeof issue.path?.[0] === 'number' ? issue.path.slice(1) : issue.path ?? [];
  if (locator?.kind === 'singleton') {
    return createIssue({ ...issue, path: [...collectionPath, ...relative] });
  }
  if (locator?.kind === 'array-position' && typeof locator.index === 'number') {
    return createIssue({ ...issue, path: [...collectionPath, locator.index, ...relative] });
  }
  if (locator?.kind !== 'object-map-key' || typeof locator.key !== 'string') return issue;
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
