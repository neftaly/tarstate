import type { JsonValue } from './value.js';

/** Allocation-light equality for portable values on observer and query hot paths. */
export const sameStructuralJson = (left: unknown, right: unknown): boolean => {
  try {
    return sameJsonValue(left as JsonValue, right as JsonValue);
  } catch {
    return false;
  }
};

const sameJsonValue = (left: JsonValue, right: JsonValue): boolean => {
  if (left === right) return typeof left !== 'number' || Number.isFinite(left);
  if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object') return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    for (let index = 0; index < left.length; index += 1) {
      if (!sameJsonValue(left[index] as JsonValue, right[index] as JsonValue)) return false;
    }
    return true;
  }
  const leftRecord = left as Readonly<Record<string, JsonValue>>;
  const rightRecord = right as Readonly<Record<string, JsonValue>>;
  const leftKeys = Object.keys(leftRecord);
  if (leftKeys.length !== Object.keys(rightRecord).length) return false;
  for (const key of leftKeys) {
    if (!Object.hasOwn(rightRecord, key)
      || !sameJsonValue(leftRecord[key] as JsonValue, rightRecord[key] as JsonValue)) {
      return false;
    }
  }
  return true;
};
