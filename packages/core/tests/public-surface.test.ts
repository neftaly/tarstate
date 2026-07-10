import { describe, expect, it } from 'vitest';
import * as core from '../src/index.js';

describe('clean rewrite core surface', () => {
  it('exposes the production foundation at the package root', () => {
    expect(core.safeParseArtifactText).toBeTypeOf('function');
    expect(core.CapabilityRegistry).toBeTypeOf('function');
    expect(core.HostRuntimeRegistry).toBeTypeOf('function');
    expect(core.FullRecomputeStrategy).toBeTypeOf('function');
    expect(core.evaluateQuery).toBeTypeOf('function');
    expect(core.acquireExternalStoreRuntime).toBeTypeOf('function');
  });

  it('does not retain legacy API names', () => {
    for (const name of ['createDb', 'defineSchema', 'mat', 'project', 'relicChanges', 'transact', 'watch', 'write']) {
      expect(name in core, name).toBe(false);
    }
  });
});
