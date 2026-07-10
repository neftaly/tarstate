import type { JsonValue } from '@tarstate/core';

/** Small adapter-local canonicalizer used by the frozen move wire format. */
export const canonicalAutomergeJson = (value: JsonValue): string => {
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'number' && !Number.isFinite(value)) throw new TypeError('Canonical JSON requires finite numbers');
    if (typeof value === 'string') assertUnicodeScalarString(value);
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (Array.isArray(value)) return '[' + value.map(canonicalAutomergeJson).join(',') + ']';
  const record = value as Readonly<Record<string, JsonValue>>;
  return '{' + Object.keys(record).sort(compareUnicodeScalars).map((key) => {
    assertUnicodeScalarString(key);
    return JSON.stringify(key) + ':' + canonicalAutomergeJson(record[key] as JsonValue);
  }).join(',') + '}';
};

export const sha256AutomergeJson = async (value: JsonValue): Promise<`sha256:${string}`> => {
  const bytes = new TextEncoder().encode(canonicalAutomergeJson(value));
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return `sha256:${[...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')}`;
};

const compareUnicodeScalars = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0;

const assertUnicodeScalarString = (value: string): void => {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) throw new TypeError('Canonical JSON rejects lone surrogates');
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      throw new TypeError('Canonical JSON rejects lone surrogates');
    }
  }
};
