import { describe, expect, it } from 'vitest';
import * as automerge from '../src/index.js';

describe('production Automerge surface', () => {
  it('exposes one standard database path', () => {
    expect(Object.keys(automerge)).toEqual(['openAutomergeDatabase']);
    expect(automerge.openAutomergeDatabase).toBeTypeOf('function');
  });
});
