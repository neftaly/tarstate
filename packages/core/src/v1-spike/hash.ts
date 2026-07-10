import { canonicalJson, type JsonValue } from './wire.js';

export const sha256Canonical = async (value: JsonValue): Promise<`sha256:${string}`> => {
  const bytes = new TextEncoder().encode(canonicalJson(value));
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return `sha256:${[...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')}`;
};
