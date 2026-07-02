import { describe, expect, it } from 'vitest';
import {
  constRows,
  hostCall,
  hostFn,
  pipe,
  project,
  queryKey,
  QueryKeyError,
  value,
  type QueryData
} from '@tarstate/core/query';

describe('queryKey host function contracts', () => {
  it('rejects raw functions instead of silently aliasing them', () => {
    const first = () => 'first';
    const second = () => 'second';
    const firstQuery: QueryData = { op: 'hostCall', fn: first, args: [] };
    const secondQuery: QueryData = { op: 'hostCall', fn: second, args: [] };

    expect(() => queryKey(firstQuery)).toThrow(QueryKeyError);
    expect(() => queryKey(secondQuery)).toThrow(QueryKeyError);
    expect(() => queryKey(firstQuery)).toThrow('raw function at $.fn');
  });

  it('uses registered host function names as stable key identity', () => {
    const byNameA = hostFn('text.slug', (input) => String(input).toLowerCase());
    const byNameB = hostFn('text.slug', (input) => String(input).toUpperCase());
    const otherName = hostFn('text.initial', (input) => String(input).slice(0, 1));

    const base = constRows([{ title: 'Hello World' }]);
    const firstQuery = pipe(base, project({ slug: hostCall(byNameA, value('Hello World')) }));
    const secondQuery = pipe(base, project({ slug: hostCall(byNameB, value('Hello World')) }));
    const thirdQuery = pipe(base, project({ slug: hostCall(otherName, value('Hello World')) }));

    expect(queryKey(firstQuery)).toBe(queryKey(secondQuery));
    expect(queryKey(firstQuery)).not.toBe(queryKey(thirdQuery));
    expect(queryKey(firstQuery)).toContain('"name":"text.slug"');
  });

  it('encodes undefined with a stable key distinct from null and omitted fields', () => {
    const undefinedQuery = value(undefined);
    const sameUndefinedQuery = value(undefined);
    const nullQuery = value(null);
    const omittedValueQuery: QueryData = { op: 'value' };

    expect(queryKey(undefinedQuery)).toBe(queryKey(sameUndefinedQuery));
    expect(queryKey(undefinedQuery)).not.toBe(queryKey(nullQuery));
    expect(queryKey(undefinedQuery)).not.toBe(queryKey(omittedValueQuery));
    expect(queryKey(undefinedQuery)).toContain('"value":~undefined');
  });
});
