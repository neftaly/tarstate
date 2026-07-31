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
  const leftValues: JsonValue[] = [left];
  const rightValues: JsonValue[] = [right];
  while (leftValues.length > 0) {
    const leftValue = leftValues.pop() as JsonValue;
    const rightValue = rightValues.pop() as JsonValue;
    if (leftValue === rightValue) {
      if (typeof leftValue === 'number' && !Number.isFinite(leftValue)) {
        return false;
      }
      continue;
    }
    if (leftValue === null
      || rightValue === null
      || typeof leftValue !== 'object'
      || typeof rightValue !== 'object') {
      return false;
    }
    if (Array.isArray(leftValue) || Array.isArray(rightValue)) {
      if (!Array.isArray(leftValue)
        || !Array.isArray(rightValue)
        || leftValue.length !== rightValue.length) {
        return false;
      }
      for (let index = 0; index < leftValue.length; index += 1) {
        leftValues.push(leftValue[index] as JsonValue);
        rightValues.push(rightValue[index] as JsonValue);
      }
      continue;
    }
    if (Object.getPrototypeOf(leftValue) !== Object.prototype
      || Object.getPrototypeOf(rightValue) !== Object.prototype) {
      return false;
    }
    const leftRecord = leftValue as Readonly<Record<string, JsonValue>>;
    const rightRecord = rightValue as Readonly<Record<string, JsonValue>>;
    const leftKeys = Object.keys(leftRecord);
    if (leftKeys.length !== Object.keys(rightRecord).length) return false;
    for (const key of leftKeys) {
      if (!Object.hasOwn(rightRecord, key)) return false;
      leftValues.push(leftRecord[key] as JsonValue);
      rightValues.push(rightRecord[key] as JsonValue);
    }
  }
  return true;
};
