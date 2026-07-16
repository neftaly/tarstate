import { describe, expect, it } from 'vitest';
import * as automerge from '../src/index.js';

describe('production Automerge surface', () => {
  it('exposes one standard attachment path', () => {
    expect(Object.keys(automerge)).toEqual(['openAutomergeAttachment']);
    expect(automerge.openAutomergeAttachment).toBeTypeOf('function');
  });
});
