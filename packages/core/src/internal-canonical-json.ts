import type { JsonValue } from './value-model.js';

export type CanonicalJsonCache = WeakMap<object, string>;
const ownedCanonicalJson = new WeakMap<object, string>();

/** Canonicalizes an arbitrary JSON value without retaining identity-derived state. */
export const canonicalizeJsonValue = (value: JsonValue): string => canonicalize(value);

/** Canonicalizes immutable owned JSON while memoizing only the requested root. */
export const canonicalizeJsonWithCache = (
  value: JsonValue,
  cache: CanonicalJsonCache
): string => canonicalize(value, cache);

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
  const canonical = renderCanonicalJson(value);
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

type CanonicalFrame =
  | {
      readonly kind: 'array';
      readonly value: readonly JsonValue[];
      index: number;
    }
  | {
      readonly kind: 'record';
      readonly value: Readonly<Record<string, JsonValue>>;
      readonly keys: readonly string[];
      index: number;
    };

/** Iterative rendering keeps narrow deep values linear in work and retained text. */
const renderCanonicalJson = (root: JsonValue): string => {
  const chunks: string[] = [];
  const stack: CanonicalFrame[] = [];
  let current = root;
  let hasCurrent = true;
  while (hasCurrent || stack.length > 0) {
    if (hasCurrent) {
      if (current === null || typeof current !== 'object') {
        chunks.push(canonicalizePrimitive(current));
        hasCurrent = false;
        continue;
      }
      if (Array.isArray(current)) {
        chunks.push('[');
        if (current.length === 0) {
          chunks.push(']');
          hasCurrent = false;
        } else {
          stack.push({ kind: 'array', value: current, index: 0 });
          current = current[0] as JsonValue;
          hasCurrent = true;
        }
        continue;
      }
      const record = current as Readonly<Record<string, JsonValue>>;
      const keys = Object.keys(record).sort(compareUnicodeScalars);
      chunks.push('{');
      if (keys.length === 0) {
        chunks.push('}');
        hasCurrent = false;
      } else {
        const key = keys[0] as string;
        assertUnicodeScalarString(key);
        chunks.push(JSON.stringify(key), ':');
        stack.push({ kind: 'record', value: record, keys, index: 0 });
        current = record[key] as JsonValue;
        hasCurrent = true;
      }
      continue;
    }
    const frame = stack.at(-1) as CanonicalFrame;
    frame.index += 1;
    const length = frame.kind === 'array'
      ? frame.value.length
      : frame.keys.length;
    if (frame.index >= length) {
      chunks.push(frame.kind === 'array' ? ']' : '}');
      stack.pop();
      continue;
    }
    chunks.push(',');
    if (frame.kind === 'array') {
      current = frame.value[frame.index] as JsonValue;
      hasCurrent = true;
    } else {
      const key = frame.keys[frame.index] as string;
      assertUnicodeScalarString(key);
      chunks.push(JSON.stringify(key), ':');
      current = frame.value[key] as JsonValue;
      hasCurrent = true;
    }
  }
  return chunks.join('');
};

export const compareUnicodeScalars = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0;

const loneSurrogate = /[\uD800-\uDFFF]/u;

export const assertUnicodeScalarString = (value: string): void => {
  if (loneSurrogate.test(value)) throw new TypeError('Lone surrogate');
};
