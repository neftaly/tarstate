import { describe, expect, it } from 'vitest';
import {
  safeMaterializePortableBytes,
  toPortableBytes
} from '../src/portable-bytes.js';

describe('portable bytes', () => {
  it('materializes canonical bytes without exposing base64url details to consumers', () => {
    const portable = toPortableBytes(new Uint8Array([0, 1, 2, 253, 254, 255]));
    const materialized = safeMaterializePortableBytes(portable);

    expect(portable).toEqual({
      kind: 'tarstate.value',
      type: 'bytes',
      value: 'AAEC_f7_'
    });
    expect(Object.isFrozen(portable)).toBe(true);
    expect(materialized).toMatchObject({
      success: true,
      value: new Uint8Array([0, 1, 2, 253, 254, 255])
    });
    if (!materialized.success) return;
    const blobPart: BlobPart = materialized.value;
    expect(new Blob([blobPart]).size).toBe(6);
  });

  it.each([
    null,
    { kind: 'tarstate.value', type: 'bytes', value: 'A' },
    { kind: 'tarstate.value', type: 'bytes', value: 'AB' },
    { kind: 'tarstate.value', type: 'bytes', value: 'AQ==' },
    { kind: 'tarstate.value', type: 'text', value: 'AQ' },
    Object.create({ kind: 'tarstate.value', type: 'bytes', value: 'AQ' })
  ])('returns byte parse evidence for invalid input %#', (input) => {
    expect(safeMaterializePortableBytes(input)).toMatchObject({
      success: false,
      issues: [{ code: 'schema.bytes_invalid' }]
    });
  });

  it('ignores unrelated properties rather than retaining or interpreting them', () => {
    expect(safeMaterializePortableBytes({
      kind: 'tarstate.value',
      type: 'bytes',
      value: 'AQ',
      futureMetadata: true
    })).toMatchObject({ success: true, value: new Uint8Array([1]) });
  });

  it('contains hostile inspection failures', () => {
    const hostile = new Proxy({}, {
      getPrototypeOf: () => { throw new Error('hostile'); }
    });

    expect(safeMaterializePortableBytes(hostile)).toMatchObject({
      success: false,
      issues: [{ code: 'schema.bytes_invalid' }]
    });
  });
});
