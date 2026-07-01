import { describe, expect, it } from 'vitest';
import { stableKey } from '@tarstate/core/experimental/identity';

describe('tarstate stable identity', () => {
  it('treats structurally equivalent values as the same identity', () => {
    expect(stableKey({ b: 2, a: 1 })).toBe(stableKey({ a: 1, b: 2 }));
    expect(stableKey({ a: undefined })).not.toBe(stableKey({}));
  });
});
