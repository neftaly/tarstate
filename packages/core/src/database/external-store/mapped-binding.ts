import { canonicalizeJson } from '../../canonical-json.js';
import { createIssue, type Issue } from '../../issues.js';
import { detachAndFreezeJsonValue } from '../../internal-owned-json.js';
import { samePortableJson } from '../../internal-json-equality.js';
import {
  parseRelationCandidate,
  parseScalarValueForField,
  type PreparedRelation
} from '../../schema.js';
import {
  projectStorage,
  type CompiledStorageMapping,
  type MappingLocator,
  type RelationStorageMapping,
  type StoragePath
} from '../../mapping.js';
import type { CapabilityRegistry } from '../../registry.js';
import type {
  BindingRelationWriteCapabilities,
  LogicalEdit,
  PlanResult,
  ProjectionResult,
  SourceSnapshot,
  StorageBinding
} from '../../source-protocol.js';
import type { JsonValue } from '../../value.js';
import {
  applyJsonTreeCommands,
  jsonTreePathFootprint,
  type JsonTreeCommand,
  type JsonTreePathFootprint
} from './json-tree.js';
import { setEnumerableDataProperty } from './record-property.js';

export type ExternalStoreMappedRow = {
  readonly relationId: string;
  readonly key: JsonValue;
  readonly fields: Readonly<Record<string, JsonValue>>;
  readonly locator: {
    readonly namespace: string;
    readonly token: MappingLocator;
    readonly rowIncarnation: string;
  };
  readonly storagePath: StoragePath;
};

export type ExternalStoreMappedBinding<State extends object> = StorageBinding<
  State,
  JsonTreeCommand,
  ExternalStoreMappedRow
>;

type MappedRelation = {
  readonly relation: PreparedRelation;
  readonly mapping: RelationStorageMapping;
  readonly valuePaths: readonly StoragePath[];
};

export const createExternalStoreMappedBinding = <State extends object>(input: {
  readonly mapping: CompiledStorageMapping;
  readonly registry: CapabilityRegistry;
  readonly id?: string;
}): ExternalStoreMappedBinding<State> => {
  const id = input.id ?? 'external-store-mapping';
  const relationIds = Object.freeze([...input.mapping.relations.keys()]);
  const relationSelection = new Set(relationIds);
  const writeCapabilities = externalStoreWriteCapabilities(input.mapping, input.registry);
  const declaredReadFootprint = jsonTreePathFootprint(
    [...input.mapping.relations.values()].map(({ mapping }) => ({
      scope: 'subtree' as const,
      path: mapping.collection.path
    }))
  );
  const declaredWriteFootprint = declaredReadFootprint;
  const projections = new WeakMap<object, Map<string, ProjectionResult<ExternalStoreMappedRow>>>();

  const project = (
    snapshot: SourceSnapshot<State>,
    requestedRelations?: ReadonlySet<string>,
    requestedFields?: ReadonlyMap<string, ReadonlySet<string>>
  ): ProjectionResult<ExternalStoreMappedRow> => {
    if (snapshot.state !== 'ready' || snapshot.storage === undefined) {
      return Object.freeze({
        rows: Object.freeze([]),
        completeness: 'unknown',
        issues: Object.freeze([sourceIssue(snapshot.sourceId, snapshot.state)])
      });
    }
    const selected = requestedRelations === undefined
      ? relationSelection
      : new Set(relationIds.filter((relationId) => requestedRelations.has(relationId)));
    const selectedFields = requestedFields === undefined
      ? undefined
      : new Map([...selected].map((relationId) => [
          relationId,
          requestedFields.get(relationId) ?? emptyFieldSelection
        ]));
    const cacheKey = projectionSelectionKey(snapshot.sourceId, selected, selectedFields);
    const cached = projections.get(snapshot.storage)?.get(cacheKey);
    if (cached !== undefined) return cached;

    const projection = projectStorage(input.mapping, snapshot.storage, {
      registry: input.registry,
      sourceId: snapshot.sourceId,
      relationIds: selected,
      ...(selectedFields === undefined ? {} : { fieldsByRelation: selectedFields })
    });
    const rows: ExternalStoreMappedRow[] = [];
    const issues = [...projection.issues];
    let completeness: ProjectionResult['completeness'] = projection.completeness;
    for (const [relationId, relation] of projection.relations) {
      const compiled = input.mapping.relations.get(relationId) as MappedRelation | undefined;
      if (compiled === undefined) {
        completeness = 'unknown';
        issues.push(bindingIssue('mapping.relation_missing', snapshot.sourceId, relationId));
        continue;
      }
      for (const row of relation.rows) {
        const storagePath = candidatePath(compiled.mapping, row.locator);
        if (storagePath === undefined) {
          completeness = 'unknown';
          issues.push(bindingIssue('mapping.locator_invalid', snapshot.sourceId, relationId));
          continue;
        }
        const token = Object.freeze({ ...row.locator }) as MappingLocator;
        rows.push(Object.freeze({
          relationId,
          key: row.key,
          fields: row.row as Readonly<Record<string, JsonValue>>,
          locator: Object.freeze({
            namespace: id,
            token,
            rowIncarnation: locatorOccurrenceId(token)
          }),
          storagePath: Object.freeze(storagePath)
        }));
      }
    }
    const result = Object.freeze({
      rows: Object.freeze(rows),
      completeness,
      issues: Object.freeze(issues)
    });
    rememberProjection(projections, snapshot.storage, cacheKey, result);
    return result;
  };

  const plan = (
    snapshot: SourceSnapshot<State>,
    edits: readonly LogicalEdit[]
  ): PlanResult<JsonTreeCommand> => {
    const handledEdits: { readonly editIndex: number; readonly mode: 'exclusive' }[] = [];
    const relevant: LogicalEdit[] = [];
    for (let editIndex = 0; editIndex < edits.length; editIndex += 1) {
      const edit = edits[editIndex] as LogicalEdit;
      if (!relationSelection.has(edit.relationId)) continue;
      handledEdits.push({ editIndex, mode: 'exclusive' });
      relevant.push(edit);
    }
    const empty = jsonTreePathFootprint([]);
    if (relevant.length === 0) {
      return { handledEdits, readFootprint: empty, writeFootprint: empty, intents: [], issues: [] };
    }
    if (snapshot.state !== 'ready' || snapshot.storage === undefined) {
      return {
        handledEdits,
        readFootprint: declaredReadFootprint,
        writeFootprint: empty,
        intents: [],
        issues: [sourceIssue(snapshot.sourceId, snapshot.state)]
      };
    }
    const projected = project(snapshot);
    const issues = [...projected.issues];
    if (projected.completeness !== 'exact') {
      return {
        handledEdits,
        readFootprint: declaredReadFootprint,
        writeFootprint: empty,
        intents: [],
        issues
      };
    }
    const rowsByLocator = relevant.some(({ kind }) => kind !== 'insert' && kind !== 'insert-generated-key')
      ? new Map<string, ExternalStoreMappedRow[]>()
      : undefined;
    const existingKeys = relevant.some(({ kind }) => kind === 'insert')
      ? new Set<string>()
      : undefined;
    for (const row of projected.rows) {
      if (rowsByLocator !== undefined) {
        const locatorKey = compoundKey(row.relationId, canonicalizeJson(row.locator));
        const bucket = rowsByLocator.get(locatorKey);
        if (bucket === undefined) rowsByLocator.set(locatorKey, [row]);
        else bucket.push(row);
      }
      existingKeys?.add(compoundKey(row.relationId, canonicalizeJson(row.key)));
    }

    const intents: { readonly footprint: JsonTreePathFootprint; readonly command: JsonTreeCommand }[] = [];
    let planningStorage = snapshot.storage;
    for (const edit of relevant) {
      const compiled = input.mapping.relations.get(edit.relationId) as MappedRelation;
      if (edit.kind === 'insert-generated-key') {
        issues.push(bindingIssue(
          'transaction.capability_unavailable',
          snapshot.sourceId,
          edit.relationId,
          compiled.mapping.collection.path,
          { edit: edit.kind, reason: 'plain_json_has_no_generated_row_identity' }
        ));
        continue;
      }
      if (edit.kind === 'insert') {
        const logicalKey = compoundKey(edit.relationId, canonicalizeJson(edit.key));
        if (existingKeys?.has(logicalKey)) {
          issues.push(bindingIssue('transaction.upsert_conflict', snapshot.sourceId, edit.relationId, undefined, { key: edit.key }));
          continue;
        }
        const inserted = planInsert({
          snapshot,
          storage: planningStorage,
          mapping: input.mapping,
          compiled,
          registry: input.registry,
          relationId: edit.relationId,
          key: edit.key,
          fields: edit.fields
        });
        if ('issues' in inserted) issues.push(...inserted.issues);
        else {
          intents.push(inserted.intent);
          const staged = applyJsonTreeCommands(planningStorage, [inserted.intent.command]);
          if (staged.issues.length > 0) {
            issues.push(...staged.issues);
            continue;
          }
          planningStorage = staged.state;
          existingKeys?.add(logicalKey);
        }
        continue;
      }
      const candidates = rowsByLocator?.get(
        compoundKey(edit.relationId, canonicalizeJson(edit.locator))
      ) ?? [];
      if (candidates.length !== 1) {
        issues.push(bindingIssue(
          candidates.length === 0 ? 'mapping.locator_stale' : 'mapping.locator_invalid',
          snapshot.sourceId,
          edit.relationId
        ));
        continue;
      }
      const row = candidates[0] as ExternalStoreMappedRow;
      if (!samePortableJson(row.key, edit.key)) {
        issues.push(bindingIssue(
          'mapping.locator_stale',
          snapshot.sourceId,
          edit.relationId,
          row.storagePath,
          { reason: 'logical_key_changed' }
        ));
        continue;
      }
      if (edit.kind === 'delete') {
        if (compiled.mapping.collection.kind === 'singleton') {
          issues.push(bindingIssue(
            'transaction.capability_unavailable',
            snapshot.sourceId,
            edit.relationId,
            row.storagePath,
            { edit: 'delete', collection: 'singleton' }
          ));
          continue;
        }
        const footprint = compiled.mapping.collection.kind === 'array'
          ? subtreeFootprint(compiled.mapping.collection.path)
          : exactFootprint(row.storagePath);
        intents.push({ footprint, command: Object.freeze({ kind: 'delete', path: row.storagePath }) });
        continue;
      }
      if (edit.kind !== 'replace-fields' && edit.kind !== 'replace-row') {
        issues.push(bindingIssue(
          'transaction.capability_unavailable',
          snapshot.sourceId,
          edit.relationId,
          row.storagePath,
          { edit: edit.kind }
        ));
        continue;
      }
      const fieldInputs = replacementFields(
        input.mapping,
        compiled,
        input.registry,
        edit,
        row,
        snapshot.sourceId,
        issues
      );
      if (fieldInputs === undefined) continue;
      for (const [field, fieldInput] of fieldInputs) {
        if (field in compiled.mapping.keys) {
          if (!samePortableJson(row.fields[field], fieldInput)) {
            issues.push(bindingIssue('mapping.rekey_required', snapshot.sourceId, edit.relationId, row.storagePath, { field }));
          }
          continue;
        }
        const fieldMapping = compiled.mapping.fields[field];
        const declaration = compiled.relation.declaration.fields[field];
        if (fieldMapping === undefined
          || declaration === undefined
          || fieldMapping.kind === 'absent'
          || fieldMapping.kind === 'source-metadata'
          || fieldMapping.write.replace === undefined) {
          issues.push(bindingIssue('mapping.field_read_only', snapshot.sourceId, edit.relationId, row.storagePath, { field }));
          continue;
        }
        const replaceCapability = fieldMapping.write.replace;
        if (!input.registry.satisfies(replaceCapability)) {
          issues.push(createIssue({
            code: 'mapping.capability_unavailable',
            sourceId: snapshot.sourceId,
            relationId: edit.relationId,
            requiredCapabilities: [replaceCapability],
            retry: 'after_capability',
            details: { field }
          }));
          continue;
        }
        const path = Object.freeze([...row.storagePath, ...fieldMapping.path]);
        if (fieldInput === undefined) {
          if (!Object.hasOwn(row.fields, field)) continue;
          intents.push({ footprint: exactFootprint(path), command: Object.freeze({ kind: 'delete', path }) });
          continue;
        }
        const parsed = parseScalarValueForField(
          input.mapping.schema,
          declaration,
          fieldInput,
          input.registry,
          [field]
        );
        if (!parsed.success) {
          issues.push(...parsed.issues.map((issue) => withEvidence(issue, snapshot.sourceId, edit.relationId, row.storagePath)));
          continue;
        }
        if (samePortableJson(row.fields[field], parsed.value)) continue;
        intents.push({
          footprint: exactFootprint(path),
          command: Object.freeze({ kind: 'replace', path, value: parsed.value })
        });
      }
    }
    const writeFootprint = jsonTreePathFootprint(
      intents.flatMap(({ footprint }) => footprint.entries)
    );
    const combinedIntents = intents.length === 0
      ? []
      : [{
          footprint: writeFootprint,
          command: intents.length === 1
            ? (intents[0] as (typeof intents)[number]).command
            : Object.freeze({
                kind: 'batch' as const,
                commands: Object.freeze(orderCommands(intents.map(({ command }) => command)))
              })
        }];
    return issues.some(({ severity }) => severity === 'error')
      ? { handledEdits, readFootprint: declaredReadFootprint, writeFootprint, intents: [], issues }
      : { handledEdits, readFootprint: declaredReadFootprint, writeFootprint, intents: combinedIntents, issues };
  };

  return Object.freeze({
    id,
    relationIds,
    declaredReadFootprint,
    declaredWriteFootprint,
    writeCapabilities,
    project,
    plan
  });
};

const externalStoreWriteCapabilities = (
  mapping: CompiledStorageMapping,
  registry: CapabilityRegistry
): ReadonlyMap<string, BindingRelationWriteCapabilities> => new Map(
  [...mapping.relations].map(([relationId, compiled]) => {
    const fields: Record<string, { readonly replace: true }> = {};
    for (const [field, fieldMapping] of Object.entries(compiled.mapping.fields)) {
      if (fieldMapping.kind !== 'absent'
        && fieldMapping.kind !== 'source-metadata'
        && fieldMapping.write.replace !== undefined
        && registry.satisfies(fieldMapping.write.replace)) {
        fields[field] = { replace: true };
      }
    }
    const collectionWritable = compiled.mapping.collection.kind !== 'singleton';
    return [relationId, Object.freeze({
      relationId,
      ...(collectionWritable ? { insert: true as const, delete: true as const } : {}),
      fields: Object.freeze(fields)
    })] as const;
  })
);

const planInsert = <State extends object>(input: {
  readonly snapshot: SourceSnapshot<State>;
  readonly storage: State;
  readonly mapping: CompiledStorageMapping;
  readonly compiled: MappedRelation;
  readonly registry: CapabilityRegistry;
  readonly relationId: string;
  readonly key: JsonValue;
  readonly fields: Readonly<Record<string, JsonValue>>;
}): { readonly intent: { readonly footprint: JsonTreePathFootprint; readonly command: JsonTreeCommand } }
  | { readonly issues: readonly Issue[] } => {
  const collection = input.compiled.mapping.collection;
  if (collection.kind === 'singleton') {
    return { issues: [bindingIssue(
      'transaction.capability_unavailable',
      input.snapshot.sourceId,
      input.relationId,
      collection.path,
      { edit: 'insert', collection: 'singleton' }
    )] };
  }
  const keyValues = Array.isArray(input.key) ? input.key : [];
  const keyFields = input.compiled.relation.declaration.key;
  if (keyValues.length !== keyFields.length) {
    return { issues: [bindingIssue('schema.key_arity', input.snapshot.sourceId, input.relationId)] };
  }
  const logical: Record<string, JsonValue> = { ...input.fields };
  keyFields.forEach((field, index) => {
    setEnumerableDataProperty(logical, field, keyValues[index] as JsonValue);
  });
  const mapKeys = Object.entries(input.compiled.mapping.keys)
    .filter(([, mapping]) => mapping.kind === 'map-key');
  if ((collection.kind === 'object-map' && mapKeys.length !== 1)
    || (collection.kind === 'array' && mapKeys.length !== 0)) {
    return { issues: [bindingIssue('mapping.key_invalid', input.snapshot.sourceId, input.relationId, collection.path)] };
  }
  const parsed = parseRelationCandidate(
    input.mapping.schema,
    input.compiled.relation,
    logical,
    input.registry,
    { sourceId: input.snapshot.sourceId, relationId: input.relationId }
  );
  if (!parsed.success) return { issues: parsed.issues };
  const physical: Record<string, unknown> = {};
  for (const [field, mapping] of Object.entries(input.compiled.mapping.keys)) {
    if (mapping.kind === 'map-key') {
      if (mapping.mirrorPath !== undefined
        && !setStoragePath(physical, mapping.mirrorPath, parsed.value.row[field])) {
        return { issues: [bindingIssue('mapping.path_invalid', input.snapshot.sourceId, input.relationId, mapping.mirrorPath)] };
      }
    } else if (mapping.kind === 'field') {
      if (!setStoragePath(physical, mapping.path, parsed.value.row[field])) {
        return { issues: [bindingIssue('mapping.path_invalid', input.snapshot.sourceId, input.relationId, mapping.path)] };
      }
    } else {
      return { issues: [bindingIssue(
        mapping.kind === 'literal' ? 'mapping.key_invalid' : 'transaction.capability_unavailable',
        input.snapshot.sourceId,
        input.relationId,
        collection.path,
        { keyMapping: mapping.kind }
      )] };
    }
  }
  for (const [field, mapping] of Object.entries(input.compiled.mapping.fields)) {
    if (!Object.hasOwn(parsed.value.row, field)) continue;
    if (mapping.kind === 'absent' || mapping.kind === 'source-metadata') {
      return { issues: [bindingIssue('mapping.field_read_only', input.snapshot.sourceId, input.relationId, collection.path, { field })] };
    }
    if (!setStoragePath(physical, mapping.path, parsed.value.row[field])) {
      return { issues: [bindingIssue('mapping.path_invalid', input.snapshot.sourceId, input.relationId, mapping.path)] };
    }
  }
  const ownedRow = detachAndFreezeJsonValue(physical);
  if (!ownedRow.success) return { issues: ownedRow.issues };
  const current = readPath(input.storage, collection.path);
  const createCollection = !current.present && collection.absent === 'creatable';
  if (!createCollection && !current.present) {
    return { issues: [bindingIssue('mapping.collection_invalid', input.snapshot.sourceId, input.relationId, collection.path)] };
  }
  if (current.present
    && (collection.kind === 'array' ? !Array.isArray(current.value) : !isRecord(current.value))) {
    return { issues: [bindingIssue('mapping.collection_invalid', input.snapshot.sourceId, input.relationId, collection.path)] };
  }
  if (collection.kind === 'array') {
    if (createCollection) {
      const value = Object.freeze([ownedRow.value]);
      return { intent: {
        footprint: subtreeFootprint(collection.path),
        command: Object.freeze({ kind: 'insert', path: collection.path, value })
      } };
    }
    return { intent: {
      footprint: subtreeFootprint(collection.path),
      command: Object.freeze({ kind: 'append', path: collection.path, value: ownedRow.value })
    } };
  }
  const mapKeyField = mapKeys[0]?.[0];
  const mapKey = mapKeyField === undefined ? undefined : parsed.value.row[mapKeyField];
  if (typeof mapKey !== 'string') {
    return { issues: [bindingIssue('mapping.key_invalid', input.snapshot.sourceId, input.relationId, collection.path, { reason: 'string_map_key_required' })] };
  }
  if (createCollection) {
    const value = Object.freeze({ [mapKey]: ownedRow.value });
    return { intent: {
      footprint: subtreeFootprint(collection.path),
      command: Object.freeze({ kind: 'insert', path: collection.path, value })
    } };
  }
  if (current.present && isRecord(current.value) && Object.hasOwn(current.value, mapKey)) {
    return { issues: [bindingIssue('transaction.upsert_conflict', input.snapshot.sourceId, input.relationId, [...collection.path, mapKey])] };
  }
  const path = Object.freeze([...collection.path, mapKey]);
  return { intent: {
    footprint: exactFootprint(path),
    command: Object.freeze({ kind: 'insert', path, value: ownedRow.value })
  } };
};

const replacementFields = (
  mapping: CompiledStorageMapping,
  compiled: MappedRelation,
  registry: CapabilityRegistry,
  edit: Extract<LogicalEdit, { readonly kind: 'replace-fields' | 'replace-row' }>,
  row: ExternalStoreMappedRow,
  sourceId: string,
  issues: Issue[]
): readonly (readonly [string, JsonValue | undefined])[] | undefined => {
  if (edit.kind === 'replace-fields') return Object.entries(edit.fields);
  const parsed = parseRelationCandidate(mapping.schema, compiled.relation, edit.fields, registry, {
    sourceId,
    relationId: edit.relationId
  });
  if (!parsed.success) {
    issues.push(...parsed.issues.map((issue) => withEvidence(issue, sourceId, edit.relationId, row.storagePath)));
    return undefined;
  }
  if (!samePortableJson(parsed.value.key, row.key)) {
    issues.push(bindingIssue('mapping.rekey_required', sourceId, edit.relationId, row.storagePath));
    return undefined;
  }
  return Object.keys(compiled.mapping.fields).map((field) => [field, parsed.value.row[field]] as const);
};

const setStoragePath = (
  root: Record<string, unknown>,
  path: StoragePath,
  value: unknown
): boolean => {
  if (path.length === 0 || path.some((member) => typeof member !== 'string')) return false;
  let current = root;
  for (let index = 0; index < path.length; index += 1) {
    const key = path[index] as string;
    if (index === path.length - 1) {
      setEnumerableDataProperty(current, key, value);
      return true;
    }
    const child = current[key];
    if (child === undefined) {
      const created: Record<string, unknown> = {};
      setEnumerableDataProperty(current, key, created);
      current = created;
    } else if (isRecord(child)) {
      current = child;
    } else {
      return false;
    }
  }
  return false;
};

const candidatePath = (
  mapping: RelationStorageMapping,
  locator: MappingLocator
): StoragePath | undefined => {
  if (mapping.collection.kind === 'singleton' && locator.kind === 'singleton') {
    return [...mapping.collection.path];
  }
  if (mapping.collection.kind === 'array' && locator.kind === 'array-position') {
    return [...mapping.collection.path, locator.index];
  }
  if (mapping.collection.kind === 'object-map' && locator.kind === 'object-map-key') {
    return [...mapping.collection.path, locator.key];
  }
  return undefined;
};

type PathRead = { readonly present: true; readonly value: unknown } | { readonly present: false };

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

const exactFootprint = (path: StoragePath): JsonTreePathFootprint =>
  jsonTreePathFootprint([{ scope: 'exact', path }]);

const subtreeFootprint = (path: StoragePath): JsonTreePathFootprint =>
  jsonTreePathFootprint([{ scope: 'subtree', path }]);

const orderCommands = (commands: readonly JsonTreeCommand[]): JsonTreeCommand[] => {
  const ordinary: JsonTreeCommand[] = [];
  const deletes: Extract<JsonTreeCommand, { readonly kind: 'delete' }>[] = [];
  const appends: JsonTreeCommand[] = [];
  for (const command of commands) {
    if (command.kind === 'append') appends.push(command);
    else if (command.kind === 'delete' && typeof command.path.at(-1) === 'number') deletes.push(command);
    else ordinary.push(command);
  }
  deletes.sort((left, right) => {
    const leftParent = canonicalizeJson(left.path.slice(0, -1));
    const rightParent = canonicalizeJson(right.path.slice(0, -1));
    if (leftParent !== rightParent) return leftParent < rightParent ? -1 : 1;
    return (right.path.at(-1) as number) - (left.path.at(-1) as number);
  });
  return [...ordinary, ...deletes, ...appends];
};

const rememberProjection = <State extends object>(
  cache: WeakMap<object, Map<string, ProjectionResult<ExternalStoreMappedRow>>>,
  storage: State,
  key: string,
  result: ProjectionResult<ExternalStoreMappedRow>
): void => {
  const values = cache.get(storage) ?? new Map();
  if (!values.has(key) && values.size >= 64) values.delete(values.keys().next().value as string);
  values.set(key, result);
  cache.set(storage, values);
};

const projectionSelectionKey = (
  sourceId: string,
  relationIds: ReadonlySet<string>,
  fieldsByRelation?: ReadonlyMap<string, ReadonlySet<string>>
): string => {
  let key = sourceId.length + ':' + sourceId;
  for (const relationId of relationIds) {
    key += relationId.length + ':' + relationId;
    const fields = fieldsByRelation?.get(relationId);
    if (fields === undefined) continue;
    key += fields.size + ':';
    for (const field of fields) key += field.length + ':' + field;
  }
  return key;
};

const compoundKey = (...parts: readonly string[]): string => {
  let key = '';
  for (const part of parts) key += part.length + ':' + part;
  return key;
};

const locatorOccurrenceId = (locator: MappingLocator): string => {
  if (locator.kind === 'singleton') return 'singleton';
  if (locator.kind === 'array-position') return 'array:' + locator.index;
  return 'object:' + locator.key.length + ':' + locator.key;
};

const withEvidence = (
  issue: Issue,
  sourceId: string,
  relationId: string,
  path: StoragePath
): Issue => createIssue({ ...issue, sourceId, relationId, path: [...path, ...(issue.path ?? [])] });

const bindingIssue = (
  code: string,
  sourceId: string,
  relationId?: string,
  path?: readonly unknown[],
  details?: unknown
): Issue => createIssue({
  code,
  phase: 'plan',
  severity: 'error',
  retry: code.includes('stale')
    ? 'after_refresh'
    : code.includes('capability')
      ? 'after_capability'
      : 'after_input',
  sourceId,
  ...(relationId === undefined ? {} : { relationId }),
  ...(path === undefined ? {} : { path }),
  ...(details === undefined ? {} : { details })
});

const sourceIssue = (sourceId: string, state: SourceSnapshot<unknown>['state']): Issue => createIssue({
  code: state === 'closed' ? 'source.closed' : 'source.not_ready',
  phase: state === 'closed' ? 'lifecycle' : 'load',
  severity: 'error',
  retry: state === 'closed' ? 'never' : 'after_refresh',
  sourceId,
  details: { state }
});

const emptyFieldSelection: ReadonlySet<string> = new Set();

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
