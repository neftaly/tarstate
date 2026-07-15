import { canonicalizeJsonValue } from './internal-canonical-json.js';
import type { JsonValue } from './value.js';

/** Safe canonical equality for values entering through structurally typed protocols. */
export const samePortableJson = (left: unknown, right: unknown): boolean => {
  if (Object.is(left, right)) return true;
  try {
    return canonicalizeJsonValue(left as JsonValue) === canonicalizeJsonValue(right as JsonValue);
  } catch {
    return false;
  }
};
