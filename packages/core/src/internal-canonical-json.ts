import type { JsonValue } from './value.js';

export type CanonicalJsonCache = WeakMap<object, string>;

/** Canonicalizes an arbitrary JSON value without retaining identity-derived state. */
export const canonicalizeJsonValue = (value: JsonValue): string => canonicalize(value);

/** Canonicalizes immutable owned JSON while memoizing every container subtree. */
export const canonicalizeJsonWithCache = (value: JsonValue, cache: CanonicalJsonCache): string => canonicalize(value, cache);

const canonicalize = (value: JsonValue, cache?: CanonicalJsonCache): string => {
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'number' && !Number.isFinite(value)) throw new TypeError('Canonical JSON requires a finite number');
    if (typeof value === 'string') assertUnicodeScalarString(value);
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  const cached = cache?.get(value);
  if (cached !== undefined) return cached;
  const canonical = Array.isArray(value)
    ? '[' + value.map((member) => canonicalize(member, cache)).join(',') + ']'
    : canonicalizeRecord(value as Readonly<Record<string, JsonValue>>, cache);
  cache?.set(value, canonical);
  return canonical;
};

const canonicalizeRecord = (value: Readonly<Record<string, JsonValue>>, cache?: CanonicalJsonCache): string =>
  '{' + Object.keys(value).sort(compareUnicodeScalars).map((key) => {
    assertUnicodeScalarString(key);
    return JSON.stringify(key) + ':' + canonicalize(value[key] as JsonValue, cache);
  }).join(',') + '}';

export const compareUnicodeScalars = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0;

export const assertUnicodeScalarString = (value: string): void => {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) throw new TypeError('Lone surrogate');
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) throw new TypeError('Lone surrogate');
  }
};
