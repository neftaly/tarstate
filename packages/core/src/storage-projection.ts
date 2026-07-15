import type {
  ProjectionResult,
  WritableLogicalRow
} from './logical-edit.js';

const maxDepth = 64;
const maxArrayMembers = 100_000;
const maxObjectMembers = 100_000;
const maxTotalMembers = 500_000;
const forbiddenPortableKeys = new Set(['__proto__', 'constructor', 'prototype']);
const sealedStorageProjections = new WeakSet<object>();

/**
 * Validates a binding-owned immutable projection once and seals its existing
 * identity so transaction execution can reuse it without repeated adoption.
 */
export const sealStorageProjection = <Row extends WritableLogicalRow>(
  projection: ProjectionResult<Row>
): ProjectionResult<Row> => {
  if (sealedStorageProjections.has(projection)) return projection;
  if (!isOwnedFrozenProjection(projection)) {
    throw new TypeError('Storage projection must contain deeply frozen portable writable rows and issue evidence');
  }
  sealedStorageProjections.add(projection);
  return projection;
};

/** @internal */
export const isSealedStorageProjection = (projection: ProjectionResult): boolean =>
  sealedStorageProjections.has(projection);

/** Pure descriptor-safe ownership and row-shape proof. */
const isOwnedFrozenProjection = (input: unknown): input is ProjectionResult<WritableLogicalRow> => {
  if (!isOwnedFrozenPortableData(input)) return false;
  return isRecord(input)
    && (input.completeness === 'exact' || input.completeness === 'unknown')
    && Array.isArray(input.rows)
    && Array.isArray(input.issues)
    && input.rows.every(isWritableLogicalRow);
};

const isWritableLogicalRow = (value: unknown): value is WritableLogicalRow => isRecord(value)
  && typeof value.relationId === 'string'
  && Object.hasOwn(value, 'key')
  && isRecord(value.fields)
  && Object.hasOwn(value, 'locator');

const isOwnedFrozenPortableData = (input: unknown): boolean => {
  let totalMembers = 0;
  let ancestors: Set<object> | undefined;

  const inspect = (value: unknown, depth: number): boolean => {
    if (depth > maxDepth) return false;
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
    if (typeof value === 'number') return Number.isFinite(value);
    if (typeof value !== 'object' || !Object.isFrozen(value)) return false;
    const activeAncestors = ancestors ??= new Set<object>();
    if (activeAncestors.has(value)) return false;
    try {
      activeAncestors.add(value);
      const keys = Reflect.ownKeys(value);
      if (Array.isArray(value)) {
        if (Object.getPrototypeOf(value) !== Array.prototype
          || value.length > maxArrayMembers
          || keys.length !== value.length + 1) return false;
        totalMembers += value.length;
        if (totalMembers > maxTotalMembers) return false;
        for (let index = 0; index < value.length; index += 1) {
          const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
          if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor) || !inspect(descriptor.value, depth + 1)) return false;
        }
        return true;
      }
      if (Object.getPrototypeOf(value) !== Object.prototype || keys.length > maxObjectMembers) return false;
      totalMembers += keys.length;
      if (totalMembers > maxTotalMembers) return false;
      for (const property of keys) {
        if (typeof property !== 'string' || forbiddenPortableKeys.has(property)) return false;
        const descriptor = Object.getOwnPropertyDescriptor(value, property);
        if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor) || !inspect(descriptor.value, depth + 1)) return false;
      }
      return true;
    } catch {
      return false;
    } finally {
      activeAncestors.delete(value);
    }
  };

  return inspect(input, 0);
};

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
