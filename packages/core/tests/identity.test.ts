import { describe, expect, it } from 'vitest';
import { stableKey, stableValue } from '@tarstate/core/identity';

describe('tarstate stable identity', () => {
  it('canonicalizes object key order and undefined values', () => {
    expect(stableValue({ b: 2, missing: undefined, a: 1 })).toEqual({
      a: 1,
      b: 2,
      missing: { $tarstate: 'undefined' }
    });
    expect(stableKey({ b: 2, a: 1 })).toBe(stableKey({ a: 1, b: 2 }));
    expect(stableKey({ a: undefined })).not.toBe(stableKey({}));
  });
});
