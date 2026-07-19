import type { JsonValue } from './value.js';

export type CanonicalJsonCache = WeakMap<object, string>;
const ownedCanonicalJson = new WeakMap<object, string>();

/** Canonicalizes an arbitrary JSON value without retaining identity-derived state. */
export const canonicalizeJsonValue = (value: JsonValue): string => canonicalize(value);

/** Canonicalizes immutable owned JSON while memoizing every container subtree. */
export const canonicalizeJsonWithCache = (value: JsonValue, cache: CanonicalJsonCache): string => canonicalize(value, cache);

/** Reuses canonical text only for containers already owned as immutable values. */
export const canonicalizeOwnedJsonValue = (value: JsonValue): string =>
  value !== null && typeof value === 'object' && Object.isFrozen(value)
    ? canonicalize(value, ownedCanonicalJson)
    : canonicalize(value);

const canonicalize = (value: JsonValue, cache?: CanonicalJsonCache): string => {
  if (value === null || typeof value !== 'object') {
    return canonicalizePrimitive(value);
  }
  const cached = cache?.get(value);
  if (cached !== undefined) return cached;
  const canonical = Array.isArray(value)
    ? canonicalizeArray(value, cache)
    : canonicalizeRecord(value as Readonly<Record<string, JsonValue>>, cache);
  cache?.set(value, canonical);
  return canonical;
};

const canonicalizePrimitive = (value: null | string | number | boolean): string => {
  if (typeof value === 'number' && !Number.isFinite(value)) throw new TypeError('Canonical JSON requires a finite number');
  if (typeof value === 'string') assertUnicodeScalarString(value);
  const canonical = JSON.stringify(Object.is(value, -0) ? 0 : value);
  if (canonical === undefined) throw new TypeError('Canonical JSON requires a JSON value');
  return canonical;
};

/** Pure container rendering; cache ownership remains in `canonicalize`. */
const canonicalizeArray = (value: readonly JsonValue[], cache?: CanonicalJsonCache): string => {
  let canonical = '[';
  for (let index = 0; index < value.length; index += 1) {
    if (index !== 0) canonical += ',';
    canonical += canonicalize(value[index] as JsonValue, cache);
  }
  return canonical + ']';
};

/** Pure key ordering and rendering; cache ownership remains in `canonicalize`. */
const canonicalizeRecord = (value: Readonly<Record<string, JsonValue>>, cache?: CanonicalJsonCache): string => {
  const keys = Object.keys(value).sort(compareUnicodeScalars);
  let canonical = '{';
  for (let index = 0; index < keys.length; index += 1) {
    if (index !== 0) canonical += ',';
    const key = keys[index] as string;
    assertUnicodeScalarString(key);
    canonical += JSON.stringify(key) + ':' + canonicalize(value[key] as JsonValue, cache);
  }
  return canonical + '}';
};

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
