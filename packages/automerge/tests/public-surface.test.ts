import { describe, expect, it } from 'vitest';
import * as automerge from '../src/index.js';
import * as spike from '../src/v1-spike.js';

describe('clean rewrite Automerge surface', () => {
  it('promotes exactly the measured v1 seed at the package root', () => {
    expect(Object.keys(automerge).sort()).toEqual(Object.keys(spike).sort());
    expect(automerge.copyRelocateAutomerge).toBe(spike.copyRelocateAutomerge);
  });

  it('does not retain legacy adapter or React names', () => {
    for (const name of ['automergeMapAdapter', 'automergeMapSource', 'automergePresenceRuntime', 'useAutomergeStore']) {
      expect(name in automerge, name).toBe(false);
    }
  });
});
