import { canonicalizeJson, type JsonValue } from '@tarstate/core/foundation';

/** Safe canonical equality at Automerge adapter protocol boundaries. */
export const samePortableJson = (left: unknown, right: unknown): boolean => {
  if (Object.is(left, right)) return true;
  try {
    return canonicalizeJson(left as JsonValue) === canonicalizeJson(right as JsonValue);
  } catch {
    return false;
  }
};
