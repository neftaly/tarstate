import { describe, expect, it } from 'vitest';
import {
  call,
  constRows,
  hostFn,
  pipe,
  project,
  queryKey,
  QueryKeyError,
  value,
  type QueryData
} from '@tarstate/core/query';
import { createSeededRandom } from './fuzz-helpers.js';

const seeds = [3, 7, 11, 19, 31, 47, 73, 101] as const;

describe('queryKey seeded fuzz behavior', () => {
  it('rejects generated raw function positions with useful paths', () => {
    for (const seed of seeds) {
      const fn = () => `raw-${seed}`;
      const cases: readonly RawFunctionCase[] = [
        {
          label: 'call fn',
          query: { op: 'call', fn, args: [] },
          path: '$.fn'
        },
        {
          label: 'project expr fn',
          query: {
            op: 'project',
            input: constRows([{ id: seed }]).data,
            shape: { marker: { op: 'call', fn, args: [value(seed)] } }
          },
          path: '$.shape.marker.fn'
        },
        {
          label: 'array arg fn',
          query: {
            op: 'call',
            fn: hostFn(`queryKey.raw.receiver.${seed}`, () => seed),
            args: [{ op: 'value', value: [seed, fn] }]
          },
          path: '$.args[0].value[1]'
        }
      ];

      for (const testCase of cases) {
        expect(() => queryKey(testCase.query), `seed ${seed} ${testCase.label} error`).toThrow(QueryKeyError);
        expect(() => queryKey(testCase.query), `seed ${seed} ${testCase.label} path`).toThrow(
          `raw function at ${testCase.path}`
        );
      }
    }
  });

  it('uses host function names as stable identity across generated same-name and different-name cases', () => {
    for (const seed of seeds) {
      const next = createSeededRandom(seed);
      const name = `text.case.${Math.floor(next() * 5)}`;
      const otherName = `${name}.other.${seed}`;
      const first = hostFn(name, (input) => String(input).toLowerCase());
      const sameName = hostFn(name, (input) => String(input).toUpperCase());
      const other = hostFn(otherName, (input) => String(input).slice(0, 1));
      const literal = `Hello ${seed}`;
      const base = constRows([{ title: literal, seed }]);

      const firstQuery = pipe(base, project({ slug: call(first, value(literal)) }));
      const sameNameQuery = pipe(base, project({ slug: call(sameName, value(literal)) }));
      const otherQuery = pipe(base, project({ slug: call(other, value(literal)) }));

      expect(queryKey(firstQuery), `seed ${seed} same host name`).toBe(queryKey(sameNameQuery));
      expect(queryKey(firstQuery), `seed ${seed} different host name`).not.toBe(queryKey(otherQuery));
      expect(queryKey(firstQuery), `seed ${seed} encoded host name`).toContain(`"name":"${name}"`);
      expect(queryKey(firstQuery), `seed ${seed} no raw function source`).not.toContain('toLowerCase');
    }
  });

  it('keeps undefined, null, and omitted fields distinct across generated query shapes', () => {
    for (const seed of seeds) {
      const prefix = seed % 2 === 0 ? 'value' : 'nested';
      const undefinedQuery = maybeNested(prefix, { op: 'value', value: undefined });
      const sameUndefinedQuery = maybeNested(prefix, { op: 'value', value: undefined });
      const nullQuery = maybeNested(prefix, { op: 'value', value: null });
      const omittedQuery = maybeNested(prefix, { op: 'value' });

      expect(queryKey(undefinedQuery), `seed ${seed} stable undefined`).toBe(queryKey(sameUndefinedQuery));
      expect(queryKey(undefinedQuery), `seed ${seed} undefined vs null`).not.toBe(queryKey(nullQuery));
      expect(queryKey(undefinedQuery), `seed ${seed} undefined vs omitted`).not.toBe(queryKey(omittedQuery));
      expect(queryKey(undefinedQuery), `seed ${seed} undefined marker`).toContain('"value":~undefined');
    }
  });

  it('canonicalizes generated object key-order permutations without collapsing distinct values', () => {
    for (const seed of seeds) {
      const fields = {
        alpha: value(seed),
        beta: { op: 'value', value: seed % 2 === 0 ? null : undefined },
        gamma: { op: 'field', alias: `row${seed % 3}`, field: 'title' }
      } satisfies Record<string, QueryData>;
      const ordered = {
        op: 'project',
        input: { op: 'constRows', rows: [{ id: seed, title: `Title ${seed}` }] },
        shape: fields
      };
      const permuted = {
        shape: reorder(fields, seed),
        input: reorder(ordered.input, seed + 1),
        op: 'project'
      };
      const changed = {
        op: 'project',
        input: { op: 'constRows', rows: [{ id: seed, title: `Title ${seed}` }] },
        shape: { ...fields, alpha: value(seed + 1) }
      };

      expect(queryKey(ordered), `seed ${seed} key order`).toBe(queryKey(permuted));
      expect(queryKey(ordered), `seed ${seed} changed value`).not.toBe(queryKey(changed));
    }
  });

  it('encodes representative object-reference-shaped values by structure instead of reference identity', () => {
    for (const seed of seeds) {
      const relationName = `entries_${seed % 4}`;
      const firstRef = objectRefShape(seed, relationName);
      const sameRef = objectRefShape(seed, relationName);
      const otherRef = objectRefShape(seed, `${relationName}_other`);
      const query = sourceLikeQuery(firstRef);
      const sameQuery = sourceLikeQuery(reorder(sameRef, seed));
      const otherQuery = sourceLikeQuery(otherRef);

      expect(queryKey(query), `seed ${seed} same object-ref shape`).toBe(queryKey(sameQuery));
      expect(queryKey(query), `seed ${seed} changed object-ref name`).not.toBe(queryKey(otherQuery));
      expect(queryKey(query), `seed ${seed} includes relation name`).toContain(`"name":"${relationName}"`);
    }
  });
});

type RawFunctionCase = {
  readonly label: string;
  readonly query: QueryData;
  readonly path: string;
};

function maybeNested(prefix: string, query: QueryData): QueryData {
  return prefix === 'nested'
    ? { op: 'project', input: constRows([{ id: prefix }]).data, shape: { literal: query } }
    : query;
}

function reorder<Value extends Record<string, unknown>>(input: Value, seed: number): Value {
  const keys = Object.keys(input);
  const next = createSeededRandom(seed);
  const shuffled = [...keys].sort((left, right) => {
    const leftRank = Math.floor(next() * 1_000) + left.charCodeAt(0);
    const rightRank = Math.floor(next() * 1_000) + right.charCodeAt(0);
    return leftRank - rightRank;
  });
  const output: Record<string, unknown> = {};
  for (const key of shuffled) output[key] = input[key];
  return output as Value;
}

function objectRefShape(seed: number, name: string): Record<string, unknown> {
  return {
    kind: 'relation',
    name,
    key: seed % 2 === 0 ? 'id' : ['accountId', 'posted'],
    fields: {
      id: { kind: 'string' },
      amount: { kind: 'number', optional: seed % 3 === 0 },
      memo: { kind: 'string', nullable: true }
    }
  };
}

function sourceLikeQuery(ref: Record<string, unknown>): QueryData {
  return {
    op: 'from',
    source: ref,
    as: 'entry'
  };
}
