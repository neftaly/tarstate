import { canonicalizeJsonValue as canonicalizeJson } from '../../internal-canonical-json.js';
import { comparePortableStrings } from '../../portable-order.js';
import { logicalUnknown, type JsonValue } from '../../value.js';
import type { QueryLogicalValue } from '../model.js';

const canonicalValues = new WeakMap<object, string>();
const sortedRecordKeys = new WeakMap<object, readonly string[]>();

/** Deterministic ordering for every portable query value, including unlike JSON kinds. */
export const compareQueryJsonValuesTotal = (left: JsonValue, right: JsonValue): number => {
  if (Object.is(left, right)) return 0;
  const comparable = compareQueryJsonValues(left, right);
  if (comparable !== undefined) return comparable;
  const leftOrder = jsonValueOrder(left);
  const rightOrder = jsonValueOrder(right);
  return leftOrder < rightOrder ? -1 : leftOrder > rightOrder ? 1 : 0;
};

export const compareQueryJsonValues = (left: JsonValue, right: JsonValue): number | undefined => {
  if (left === null || right === null) return left === right ? 0 : left === null ? -1 : 1;
  if (typeof left === 'number' && typeof right === 'number') return left < right ? -1 : left > right ? 1 : 0;
  if (typeof left === 'string' && typeof right === 'string') return left < right ? -1 : left > right ? 1 : 0;
  if (typeof left === 'boolean' && typeof right === 'boolean') return left === right ? 0 : left ? 1 : -1;
  if (Array.isArray(left) && Array.isArray(right)) {
    const length = Math.min(left.length, right.length);
    for (let index = 0; index < length; index += 1) {
      const comparison = compareQueryJsonValuesTotal(left[index] as JsonValue, right[index] as JsonValue);
      if (comparison !== 0) return comparison;
    }
    return left.length < right.length ? -1 : left.length > right.length ? 1 : 0;
  }
  if (Array.isArray(left) && typeof right === 'object') return -1;
  if (typeof left === 'object' && Array.isArray(right)) return 1;
  if (typeof left === 'object' && typeof right === 'object') {
    const leftRecord = left as Readonly<Record<string, JsonValue>>;
    const rightRecord = right as Readonly<Record<string, JsonValue>>;
    const leftKeys = stableRecordKeys(leftRecord);
    const rightKeys = stableRecordKeys(rightRecord);
    const length = Math.min(leftKeys.length, rightKeys.length);
    for (let index = 0; index < length; index += 1) {
      const leftKey = leftKeys[index] as string;
      const rightKey = rightKeys[index] as string;
      const keyComparison = comparePortableStrings(leftKey, rightKey);
      if (keyComparison !== 0) return keyComparison;
      const valueComparison = compareQueryJsonValuesTotal(leftRecord[leftKey] as JsonValue, rightRecord[rightKey] as JsonValue);
      if (valueComparison !== 0) return valueComparison;
    }
    return leftKeys.length < rightKeys.length ? -1 : leftKeys.length > rightKeys.length ? 1 : 0;
  }
  return undefined;
};

const jsonValueOrder = (value: JsonValue): number => value === null
  ? 0
  : typeof value === 'string'
    ? 1
    : typeof value === 'number'
      ? 2
      : typeof value === 'boolean'
        ? 3
        : Array.isArray(value)
          ? 4
          : 5;

export const containsQueryLogicalUnknown = (value: QueryLogicalValue): boolean => {
  if (value === logicalUnknown) return true;
  if (Array.isArray(value)) {
    for (const child of value) if (containsQueryLogicalUnknown(child)) return true;
  } else if (value !== null && typeof value === 'object') {
    const record = value as Readonly<Record<string, QueryLogicalValue>>;
    for (const key in record) {
      if (Object.hasOwn(record, key) && containsQueryLogicalUnknown(record[key] as QueryLogicalValue)) return true;
    }
  }
  return false;
};

/** Canonical internal equality key; tags keep logical unknown disjoint from every JSON value. */
export const canonicalizeQueryValue = (value: QueryLogicalValue): string => {
  if (value === logicalUnknown) return 'u';
  if (value !== null && typeof value === 'object') {
    const cached = canonicalValues.get(value);
    if (cached !== undefined) return cached;
  }
  const canonical = renderQueryValue(value);
  if (value !== null && typeof value === 'object' && Object.isFrozen(value)) canonicalValues.set(value, canonical);
  return canonical;
};

/** Pure canonical rendering; the public wrapper owns immutable-value memoization. */
const renderQueryValue = (value: Exclude<QueryLogicalValue, typeof logicalUnknown>): string => {
  let canonical: string;
  if (Array.isArray(value)) {
    canonical = 'a[';
    for (let index = 0; index < value.length; index += 1) {
      if (index !== 0) canonical += ',';
      canonical += canonicalizeQueryValue(value[index] as QueryLogicalValue);
    }
    canonical += ']';
  }
  else if (value !== null && typeof value === 'object') {
    const record = value as Readonly<Record<string, QueryLogicalValue>>;
    const keys = stableRecordKeys(record);
    canonical = 'o{';
    for (let index = 0; index < keys.length; index += 1) {
      if (index !== 0) canonical += ',';
      const key = keys[index] as string;
      canonical += JSON.stringify(key) + ':' + canonicalizeQueryValue(record[key] as QueryLogicalValue);
    }
    canonical += '}';
  } else canonical = 'j' + canonicalizeJson(value);
  return canonical;
};

const stableRecordKeys = (record: Readonly<Record<string, unknown>>): readonly string[] => {
  const cached = sortedRecordKeys.get(record);
  if (cached !== undefined) return cached;
  const keys = sortedKeys(record);
  if (Object.isFrozen(record)) sortedRecordKeys.set(record, keys);
  return keys;
};

const sortedKeys = (record: Readonly<Record<string, unknown>>): readonly string[] =>
  Object.keys(record).sort(comparePortableStrings);

export const queryValueEqual = (left: QueryLogicalValue, right: QueryLogicalValue): boolean => {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    for (let index = 0; index < left.length; index += 1) {
      if (!queryValueEqual(left[index] as QueryLogicalValue, right[index] as QueryLogicalValue)) return false;
    }
    return true;
  }
  if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object') return false;
  const leftRecord = left as Readonly<Record<string, QueryLogicalValue>>;
  const rightRecord = right as Readonly<Record<string, QueryLogicalValue>>;
  let leftCount = 0;
  for (const key in leftRecord) {
    if (!Object.hasOwn(leftRecord, key)) continue;
    leftCount += 1;
    if (!Object.hasOwn(rightRecord, key) || !queryValueEqual(leftRecord[key] as QueryLogicalValue, rightRecord[key] as QueryLogicalValue)) return false;
  }
  let rightCount = 0;
  for (const key in rightRecord) if (Object.hasOwn(rightRecord, key)) rightCount += 1;
  return leftCount === rightCount;
};
