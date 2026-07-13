import type { ParseResult } from './issues.js';
import { safeParseJsonValue, type JsonValue, type ValueParseBudget } from './value.js';

/** Detaches portable semantic data from its caller and makes the owned graph immutable. */
export const detachAndFreezeJsonValue = (input: unknown, budget?: ValueParseBudget): ParseResult<JsonValue> => {
  const parsed = safeParseJsonValue(input, budget);
  if (!parsed.success) return parsed;
  return { success: true, value: freezeOwnedJsonValue(parsed.value), issues: [] };
};

/** Freezes a parser-owned JSON graph in place without traversing it through validation again. */
export const freezeOwnedJsonValue = (value: JsonValue): JsonValue => {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    for (const member of value) freezeOwnedJsonValue(member);
    return Object.freeze(value);
  }
  for (const member of Object.values(value)) freezeOwnedJsonValue(member);
  return Object.freeze(value);
};
