import { describe, expect, it } from 'vitest';
import type { MutationEntry, MutationState } from '../src/contracts.js';
import { nextMutationState } from '../src/mutation-store.js';

const initialState: MutationState = Object.freeze({
  pendingCount: 0,
  mutations: Object.freeze([])
});

const pendingEntry = (mutationId: number): MutationEntry => ({
  mutationId,
  operationEpoch: 'epoch:test',
  operationId: `operation:${mutationId}`,
  attachmentId: 'attachment:test',
  state: 'pending'
});

const failedEntry = (mutationId: number): MutationEntry => ({
  ...pendingEntry(mutationId),
  state: 'failed',
  error: { name: 'Error', message: `failure:${mutationId}` }
});

describe('mutation state transformation', () => {
  it('retains every pending mutation while bounding settled history', () => {
    let state = initialState;
    for (let mutationId = 1; mutationId <= 125; mutationId += 1) {
      state = nextMutationState(state, pendingEntry(mutationId));
    }
    expect(state.pendingCount).toBe(125);
    expect(state.mutations).toHaveLength(125);

    for (let mutationId = 1; mutationId <= 125; mutationId += 1) {
      state = nextMutationState(state, failedEntry(mutationId));
      expect(state.pendingCount).toBe(125 - mutationId);
    }

    const mutationIds = state.mutations.map(({ mutationId }) => mutationId);
    expect(state.mutations).toHaveLength(100);
    expect(mutationIds).toEqual([...mutationIds].sort((left, right) => left - right));
    expect(new Set(mutationIds).size).toBe(mutationIds.length);
    expect(state.mutations.every(({ state: entryState }) => entryState === 'failed')).toBe(true);
    expect(Object.isFrozen(state)).toBe(true);
    expect(Object.isFrozen(state.mutations)).toBe(true);
  });
});
