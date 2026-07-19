import { describe, expect, it } from 'vitest';
import * as automerge from '../src/index.js';
import * as automergeView from '../src/view/index.js';

describe('production Automerge surface', () => {
  it('exposes one standard database path', () => {
    expect(Object.keys(automerge).sort()).toEqual(['mappedRelationRows', 'openAutomergeDatabase']);
    expect(automerge.mappedRelationRows).toBeTypeOf('function');
    expect(automerge.openAutomergeDatabase).toBeTypeOf('function');
  });

  it('keeps exact-basis materialization in its focused topic', () => {
    expect(Object.keys(automergeView)).toEqual(['viewAutomergeDocumentAtBasis']);
    expect(automergeView.viewAutomergeDocumentAtBasis).toBeTypeOf('function');
  });
});
