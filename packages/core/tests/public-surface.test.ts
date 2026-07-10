import { describe, expect, it } from 'vitest';
import * as core from '../src/index.js';
import * as spike from '../src/v1-spike.js';

describe('clean rewrite core surface', () => {
  it('promotes exactly the proven v1 seed at the package root', () => {
    expect(Object.keys(core).sort()).toEqual(Object.keys(spike).sort());
    expect(core.evaluateQuery).toBe(spike.evaluateQuery);
    expect(core.InMemorySpikeSource).toBe(spike.InMemorySpikeSource);
  });

  it('does not retain legacy API names', () => {
    for (const name of ['createDb', 'defineSchema', 'mat', 'project', 'relicChanges', 'transact', 'watch', 'write']) {
      expect(name in core, name).toBe(false);
    }
  });
});
