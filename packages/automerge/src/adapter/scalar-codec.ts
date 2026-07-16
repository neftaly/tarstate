import * as Automerge from '@automerge/automerge';
import {
  createIssue,
  type ParseResult,
  type PortableValue
} from '@tarstate/core';
import type {
  StorageScalarCodecInput,
  StorageScalarDecoder
} from '@tarstate/core/schema';

const base64UrlAlphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const base64UrlValues = new Uint8Array(128).fill(255);
for (let index = 0; index < base64UrlAlphabet.length; index += 1) {
  base64UrlValues[base64UrlAlphabet.charCodeAt(index)] = index;
}

/** Canonical scalar conversion at the Automerge storage boundary. */
export const createAutomergeStorageScalarCodec = (): {
  readonly decode: StorageScalarDecoder;
  readonly encode: (input: StorageScalarCodecInput) => ParseResult<unknown>;
} => {
  const logicalBytes = new WeakMap<Uint8Array, PortableValue>();
  return {
    decode: (input) => {
      if (input.declaration.type.kind === 'string' && Automerge.isImmutableString(input.value)) {
        return success(input.value.toString());
      }
      if (input.declaration.type.kind !== 'bytes' || !(input.value instanceof Uint8Array)) {
        return success(input.value);
      }
      const cached = logicalBytes.get(input.value);
      if (cached !== undefined) return success(cached);
      const value = {
        kind: 'tarstate.value' as const,
        type: 'bytes',
        value: encodeBase64Url(input.value)
      };
      logicalBytes.set(input.value, value);
      return success(value);
    },
    encode: (input) => {
      if (input.declaration.type.kind !== 'bytes') return success(input.value);
      if (!isLogicalBytes(input.value)) return failure();
      const decoded = decodeBase64Url(input.value.value);
      return decoded === undefined ? failure() : success(decoded);
    }
  };
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
    if (second !== undefined) chunk += base64UrlAlphabet[((second & 15) << 2) | ((third ?? 0) >>> 6)];
    if (third !== undefined) chunk += base64UrlAlphabet[third & 63];
    if (chunk.length >= 16_384) {
      chunks.push(chunk);
      chunk = '';
    }
  }
  if (chunk.length > 0) chunks.push(chunk);
  return chunks.join('');
};

const decodeBase64Url = (value: string): Uint8Array | undefined => {
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

const isLogicalBytes = (value: unknown): value is { readonly kind: 'tarstate.value'; readonly type: 'bytes'; readonly value: string } =>
  value !== null
  && typeof value === 'object'
  && !Array.isArray(value)
  && (value as { readonly kind?: unknown }).kind === 'tarstate.value'
  && (value as { readonly type?: unknown }).type === 'bytes'
  && typeof (value as { readonly value?: unknown }).value === 'string';

const success = <Value>(value: Value): ParseResult<Value> => ({ success: true, value, issues: [] });

const failure = (): ParseResult<never> => ({
  success: false,
  issues: [createIssue({ code: 'schema.bytes_invalid', phase: 'parse', severity: 'error', retry: 'after_input' })]
});
