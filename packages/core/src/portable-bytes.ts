import { createIssue, type ParseResult } from './issues.js';
import type { TaggedValue } from './value.js';

export type PortableBytes = TaggedValue & {
  readonly type: 'bytes';
  readonly value: string;
};

const base64UrlAlphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const base64UrlValues = new Uint8Array(128).fill(255);
for (let index = 0; index < base64UrlAlphabet.length; index += 1) {
  base64UrlValues[base64UrlAlphabet.charCodeAt(index)] = index;
}

/** Converts native bytes to Tarstate's canonical portable scalar representation. */
export const toPortableBytes = (bytes: Uint8Array): PortableBytes => Object.freeze({
  kind: 'tarstate.value',
  type: 'bytes',
  value: encodeBase64Url(bytes)
});

/** Materializes a canonical Tarstate bytes scalar without throwing for invalid data. */
export const safeMaterializePortableBytes = (input: unknown): ParseResult<Uint8Array<ArrayBuffer>> => {
  const encoded = inspectPortableBytes(input);
  if (encoded === undefined) return invalidPortableBytes();
  const decoded = decodeBase64Url(encoded);
  return decoded === undefined ? invalidPortableBytes() : { success: true, value: decoded, issues: [] };
};

const encodeBase64Url = (bytes: Uint8Array): string => {
  const chunks: string[] = [];
  let chunk = '';
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index] as number;
    const second = bytes[index + 1];
    const third = bytes[index + 2];
    chunk += base64UrlAlphabet[first >>> 2];
    chunk += base64UrlAlphabet[((first & 3) << 4) | ((second ?? 0) >>> 4)];
    if (second !== undefined) {
      chunk += base64UrlAlphabet[((second & 15) << 2) | ((third ?? 0) >>> 6)];
    }
    if (third !== undefined) chunk += base64UrlAlphabet[third & 63];
    if (chunk.length >= 16_384) {
      chunks.push(chunk);
      chunk = '';
    }
  }
  if (chunk.length > 0) chunks.push(chunk);
  return chunks.join('');
};

const decodeBase64Url = (value: string): Uint8Array<ArrayBuffer> | undefined => {
  if (value.length % 4 === 1) return undefined;
  const output = new Uint8Array(Math.floor(value.length * 6 / 8));
  let bits = 0;
  let bitCount = 0;
  let outputIndex = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= base64UrlValues.length) return undefined;
    const decoded = base64UrlValues[code] as number;
    if (decoded === 255) return undefined;
    bits = (bits << 6) | decoded;
    bitCount += 6;
    if (bitCount < 8) continue;
    bitCount -= 8;
    output[outputIndex] = (bits >>> bitCount) & 255;
    outputIndex += 1;
    bits &= bitCount === 0 ? 0 : (1 << bitCount) - 1;
  }
  return outputIndex === output.length && bits === 0 ? output : undefined;
};

const inspectPortableBytes = (input: unknown): string | undefined => {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return undefined;
  try {
    if (Object.getPrototypeOf(input) !== Object.prototype) return undefined;
    const read = (key: 'kind' | 'type' | 'value'): unknown => {
      const descriptor = Object.getOwnPropertyDescriptor(input, key);
      return descriptor?.enumerable === true && 'value' in descriptor ? descriptor.value : undefined;
    };
    const kind = read('kind');
    const type = read('type');
    const value = read('value');
    return kind === 'tarstate.value' && type === 'bytes' && typeof value === 'string'
      ? value
      : undefined;
  } catch {
    return undefined;
  }
};

const invalidPortableBytes = (): ParseResult<never> => ({
  success: false,
  issues: [createIssue({
    code: 'schema.bytes_invalid',
    phase: 'parse',
    severity: 'error',
    retry: 'after_input'
  })]
});
