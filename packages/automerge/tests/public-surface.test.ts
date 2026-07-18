import { describe, expect, it } from 'vitest';
import * as automerge from '../src/index.js';

describe('production Automerge surface', () => {
  it('exposes one standard database path', () => {
    expect(Object.keys(automerge).sort()).toEqual(['mappedRelationRows', 'openAutomergeDatabase']);
    expect(automerge.mappedRelationRows).toBeTypeOf('function');
    expect(automerge.openAutomergeDatabase).toBeTypeOf('function');
  });
});
