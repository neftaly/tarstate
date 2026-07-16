import { canonicalizeJsonValue } from './internal-canonical-json.js';
import type { JsonValue } from './value.js';

export type ContentHash = `sha256:${string}`;

const hashPattern = /^sha256:[0-9a-f]{64}$/;

export const isContentHash = (value: unknown): value is ContentHash =>
  typeof value === 'string' && hashPattern.test(value);

export const canonicalizeJson = canonicalizeJsonValue;

export const sha256Bytes = async (bytes: Uint8Array): Promise<ContentHash> => {
  const input: Uint8Array<ArrayBuffer> = bytes.buffer instanceof ArrayBuffer
    ? new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    : Uint8Array.from(bytes);
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', input));
  let hex = '';
  for (const byte of digest) hex += byte.toString(16).padStart(2, '0');
  return `sha256:${hex}`;
};

export const sha256Json = (value: JsonValue): Promise<ContentHash> =>
  sha256Bytes(new TextEncoder().encode(canonicalizeJson(value)));
