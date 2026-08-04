import * as Automerge from '@automerge/automerge';
import type { Patch as AutomergePatch } from '@automerge/automerge';
import { type JsonValue } from '@tarstate/core';
import type { CapabilityRegistry } from '@tarstate/core/capabilities';
import {
  parseScalarValueForField,
  type CompiledStorageMapping,
  type StorageScalarDecoder
} from '@tarstate/core/schema';
import type { AutomergePath } from '../document/projection.js';
import { samePortableJson } from '../shared/portable-json.js';
import type { AutomergeMappedStorageRow } from './mapped-storage-model.js';

type MappedRelation = CompiledStorageMapping['relations'] extends
  ReadonlyMap<string, infer Relation> ? Relation : never;
type StoredScalarTarget = {
  readonly field: string;
  readonly path: AutomergePath;
  readonly key: boolean;
};

const targetsByRelation = new WeakMap<object, readonly StoredScalarTarget[]>();

/**
 * Applies exact scalar puts without materializing an Automerge list element.
 * Unsupported patch shapes return undefined so the caller can use full source
 * projection as the correctness oracle.
 */
export const projectRecursiveScalarPatches = (input: {
  readonly schema: CompiledStorageMapping['schema'];
  readonly compiled: MappedRelation;
  readonly relationId: string;
  readonly rowPath: AutomergePath;
  readonly patches: readonly AutomergePatch[];
  readonly previous: AutomergeMappedStorageRow;
  readonly registry: CapabilityRegistry | undefined;
  readonly scalarDecoder: StorageScalarDecoder;
}): AutomergeMappedStorageRow | undefined => {
  const targets = storedScalarTargets(input.compiled);
  const values = new Map<string, unknown>();
  for (const patch of input.patches) {
    const relative = patch.path.slice(input.rowPath.length) as AutomergePath;
    if (patch.action !== 'put') continue;
    if (!targets.some(({ path }) => samePath(path, relative))
      || patch.conflict === true
      || !isSelfContainedScalar(patch.value)) {
      return undefined;
    }
    const identity = pathKey(relative);
    if (values.has(identity)) return undefined;
    values.set(identity, patch.value);
  }
  if (values.size === 0) return undefined;
  for (const patch of input.patches) {
    if (patch.action === 'put') continue;
    const relative = patch.path.slice(input.rowPath.length) as AutomergePath;
    const valuePath = pathKey(relative.slice(0, -1));
    const value = values.get(valuePath);
    const index = relative.at(-1);
    if (patch.action !== 'splice'
      || value !== ''
      || index !== 0) {
      return undefined;
    }
    values.set(valuePath, patch.value);
  }

  const fields: Record<string, JsonValue> = { ...input.previous.fields };
  let keyTouched = false;
  for (const { field, path, key } of targets) {
    const value = values.get(pathKey(path));
    if (value === undefined) continue;
    const declaration = input.compiled.relation.declaration.fields[field];
    if (declaration === undefined) return undefined;
    const decoded = input.scalarDecoder({
      value,
      declaration,
      relationId: input.relationId,
      field,
      path
    });
    if (!decoded.success) return undefined;
    const parsed = parseScalarValueForField(
      input.schema,
      declaration,
      decoded.value,
      input.registry,
      [field]
    );
    if (!parsed.success) return undefined;
    fields[field] = parsed.value as JsonValue;
    keyTouched ||= key;
  }
  let projectedKey = input.previous.key;
  if (keyTouched) {
    const keyValues = input.compiled.relation.declaration.key.map((field) =>
      fields[field]);
    if (keyValues.length === 0
      || keyValues.some((value) => value === undefined)) {
      return undefined;
    }
    projectedKey = keyValues as [JsonValue, ...JsonValue[]];
  }
  const keyUnchanged = projectedKey === input.previous.key
    || samePortableJson(input.previous.key, projectedKey);
  if (keyUnchanged
    && samePortableJson(input.previous.fields, fields)) {
    return input.previous;
  }
  return Object.freeze({
    ...input.previous,
    key: keyUnchanged ? input.previous.key : Object.freeze(projectedKey),
    fields: Object.freeze(fields)
  });
};

const storedScalarTargets = (
  compiled: MappedRelation
): readonly StoredScalarTarget[] => {
  const cached = targetsByRelation.get(compiled);
  if (cached !== undefined) return cached;
  const targets: StoredScalarTarget[] = [];
  for (const [field, mapping] of Object.entries(compiled.mapping.keys)) {
    if (mapping.kind === 'field') {
      targets.push({ field, path: mapping.path as AutomergePath, key: true });
    }
  }
  for (const [field, mapping] of Object.entries(compiled.mapping.fields)) {
    if (mapping.kind !== 'absent' && mapping.kind !== 'source-metadata') {
      targets.push({ field, path: mapping.path as AutomergePath, key: false });
    }
  }
  targetsByRelation.set(compiled, targets);
  return targets;
};

const isSelfContainedScalar = (value: unknown): boolean => value === null
  || typeof value === 'string'
  || typeof value === 'number'
  || typeof value === 'boolean'
  || value instanceof Date
  || value instanceof Uint8Array
  || Automerge.isImmutableString(value);

const samePath = (
  left: readonly (string | number)[],
  right: readonly (string | number)[]
): boolean => left.length === right.length
  && left.every((part, index) => Object.is(part, right[index]));

const pathKey = (path: readonly (string | number)[]): string => {
  let key = '';
  for (const part of path) {
    key += typeof part === 'number'
      ? `n${part};`
      : `s${part.length}:${part}`;
  }
  return key;
};
