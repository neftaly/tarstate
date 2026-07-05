import type { JsonValue } from '@tarstate/core/schema';

export function stringifyStableJson(input: JsonValue): string {
  if (input === null || typeof input === 'boolean' || typeof input === 'number' || typeof input === 'string') {
    return JSON.stringify(input);
  }
  if (Array.isArray(input)) return `[${input.map((item) => stringifyStableJson(item)).join(',')}]`;
  return `{${Object.entries(input).sort(([left], [right]) => compareCodeUnits(left, right)).map(([key, value]) => `${JSON.stringify(key)}:${stringifyStableJson(value)}`).join(',')}}`;
}

export function stringifyStableJsonPretty(input: JsonValue): string {
  return JSON.stringify(sortJsonValue(input), null, 2);
}

function sortJsonValue(input: JsonValue): JsonValue {
  if (input === null || typeof input !== 'object') return input;
  if (Array.isArray(input)) return input.map(sortJsonValue);
  return Object.fromEntries(Object.entries(input).sort(([left], [right]) => compareCodeUnits(left, right)).map(([key, value]) => [key, sortJsonValue(value)]));
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
