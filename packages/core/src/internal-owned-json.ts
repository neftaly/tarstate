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
  const containers: object[] = [];
  const pending: object[] = [value];
  while (pending.length > 0) {
    const container = pending.pop() as JsonValue[] | Record<string, JsonValue>;
    containers.push(container);
    const children = Array.isArray(container)
      ? container
      : Object.values(container);
    for (const child of children) {
      if (child !== null && typeof child === 'object') pending.push(child);
    }
  }
  for (let index = containers.length - 1; index >= 0; index -= 1) {
    Object.freeze(containers[index]);
  }
  return value;
};
