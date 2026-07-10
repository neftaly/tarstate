import * as Automerge from '@automerge/automerge';
import { describe, expect, it } from 'vitest';
import { AutomergeSourceRuntime } from '../src/source.js';

const configuredRuns = Number.parseInt(process.env.TARSTATE_FUZZ_RUNS ?? '128', 10);
const runs = Number.isSafeInteger(configuredRuns) && configuredRuns > 0 ? configuredRuns : 128;
const configuredSeed = Number.parseInt(process.env.TARSTATE_FUZZ_SEED ?? '12648430', 10);
const initialSeed = Number.isSafeInteger(configuredSeed) ? configuredSeed >>> 0 : 12_648_430;
const random = seededRandom(initialSeed);
const integer = (limit: number): number => Math.floor(random() * limit);
const hash = (value: number): `sha256:${string}` => `sha256:${(value % 16).toString(16).repeat(64)}`;

describe('Automerge operation fuzz properties (seed ' + initialSeed + ')', () => {
  it('keeps replays exact and retired epochs permanently expired', async () => {
    const runtime = new AutomergeSourceRuntime({ sourceId: 'source:fuzz', doc: Automerge.from({ count: 0 }) });
    const retired = new Set<string>();
    const known = new Map<string, { readonly intentHash: `sha256:${string}`; readonly result: Awaited<ReturnType<typeof runtime.commit>> }>();
    for (let run = 0; run < runs; run += 1) {
      const epoch = 'epoch:' + integer(8);
      if (integer(5) === 0) {
        await runtime.retireOperationEpoch(epoch);
        retired.add(epoch);
        for (const key of known.keys()) if (key.startsWith(epoch + '\u0000')) known.delete(key);
        expect(runtime.queryOutcome({ operationEpoch: epoch, operationId: 'unknown', intentHash: hash(0) })).toEqual({ status: 'expired' });
        continue;
      }
      const operationId = 'operation:' + integer(24);
      const intentHash = hash(integer(16));
      const key = epoch + '\u0000' + operationId;
      const input = { operationEpoch: epoch, operationId, intentHash, expectedBasis: runtime.snapshot().basis, commands: [] };
      const previous = known.get(key);
      const result = await runtime.commit(input);
      if (retired.has(epoch)) {
        expect(result).toMatchObject({ outcome: 'rejected', issues: [{ code: 'transaction.operation_epoch_expired' }] });
      } else if (previous === undefined) {
        expect(result.outcome).toBe('committed');
        known.set(key, { intentHash, result });
      } else if (previous.intentHash === intentHash) {
        expect(result).toBe(previous.result);
      } else {
        expect(result).toMatchObject({ outcome: 'rejected', issues: [{ code: 'transaction.operation_id_ambiguous' }] });
        expect(runtime.queryOutcome({ operationEpoch: epoch, operationId, intentHash: previous.intentHash })).toMatchObject({ status: 'known', result: previous.result });
      }
    }
  });
});

function seededRandom(seed: number): () => number {
  let state = seed;
  return () => {
    state += 0x6D2B79F5;
    let value = state;
    value = Math.imul(value ^ value >>> 15, value | 1);
    value ^= value + Math.imul(value ^ value >>> 7, value | 61);
    return ((value ^ value >>> 14) >>> 0) / 4_294_967_296;
  };
}
