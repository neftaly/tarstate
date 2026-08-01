import type {
  ScalarDeclaration,
  ValueDeclaration
} from './codec.js';

type ScalarGuard = (value: unknown) => value is ScalarDeclaration;

/** Exact structural guard used while adopting finite value declarations. */
export const isValueDeclaration = (
  value: unknown,
  isScalar: ScalarGuard,
  depth = 0
): value is ValueDeclaration => {
  if (depth > 64 || !isRecord(value) || typeof value.kind !== 'string') return false;
  if (isScalar(value)) return true;
  if (value.kind === 'null') return hasOnlyKeys(value, ['kind']);
  if (value.kind === 'array') {
    return hasOnlyKeys(value, ['kind', 'items', 'maxItems'])
      && (value.maxItems === undefined
        || (Number.isSafeInteger(value.maxItems)
          && (value.maxItems as number) >= 0))
      && isValueDeclaration(value.items, isScalar, depth + 1);
  }
  if (value.kind === 'tuple') {
    return hasOnlyKeys(value, ['kind', 'items'])
      && Array.isArray(value.items)
      && value.items.every((item) =>
        isValueDeclaration(item, isScalar, depth + 1));
  }
  if (value.kind === 'record') {
    return hasOnlyKeys(value, ['kind', 'fields', 'optional'])
      && isRecord(value.fields)
      && Object.values(value.fields).every((field) =>
        isValueDeclaration(field, isScalar, depth + 1))
      && (value.optional === undefined
        || (Array.isArray(value.optional)
          && value.optional.every((name) => typeof name === 'string')));
  }
  return value.kind === 'union'
    && hasOnlyKeys(value, ['kind', 'alternatives'])
    && Array.isArray(value.alternatives)
    && value.alternatives.length >= 2
    && value.alternatives.every((alternative) =>
      isValueDeclaration(alternative, isScalar, depth + 1));
};

const hasOnlyKeys = (
  value: Readonly<Record<string, unknown>>,
  allowed: readonly string[]
): boolean => Object.keys(value).every((key) => allowed.includes(key));

const isRecord = (
  value: unknown
): value is Readonly<Record<string, unknown>> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
