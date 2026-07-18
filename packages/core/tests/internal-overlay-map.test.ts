import { describe, expect, it } from 'vitest';
import { OverlayMap } from '../src/query/internal/overlay-map.js';

describe('incremental overlay map', () => {
  it('applies replacements and deletions without changing its base', () => {
    const base = new Map([['a', 1], ['b', 2]]);
    const overlay = new OverlayMap(base, new Map([['a', 3], ['b', undefined]]));

    expect([...overlay]).toEqual([['a', 3]]);
    expect(overlay.size).toBe(1);
    expect(base).toEqual(new Map([['a', 1], ['b', 2]]));
  });

  it('compacts a bounded chain while preserving every effective entry', () => {
    let current: ReadonlyMap<string, number> = new Map();
    let compacted: OverlayMap<number> | undefined;
    for (let index = 0; index < 256; index += 1) {
      const next = new OverlayMap(current, new Map([['key:' + index, index]]));
      if (next.compacted) compacted = next;
      current = next;
    }

    expect(compacted).toBeDefined();
    expect(current.size).toBe(256);
    expect(current.get('key:0')).toBe(0);
    expect(current.get('key:255')).toBe(255);
  });

  it('passes the overlay view to ReadonlyMap callbacks', () => {
    const overlay = new OverlayMap(new Map([['a', 1]]), new Map());
    let callbackMap: ReadonlyMap<string, number> | undefined;
    overlay.forEach((_value, _key, map) => { callbackMap = map; });
    expect(callbackMap).toBe(overlay);
  });
});
