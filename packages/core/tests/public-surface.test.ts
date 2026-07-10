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
    expect(core.prepareSchema).toBeTypeOf('function');
    expect(core.resolveLensPath).toBeTypeOf('function');
    expect(core.InMemoryAtomicSource).toBeTypeOf('function');
    expect(core.sealTransaction).toBeTypeOf('function');
    expect(core.ResourceResolver).toBeTypeOf('function');
    expect(core.DatabaseView).toBeTypeOf('function');
    expect(core.coordinateSourceCommit).toBeTypeOf('function');
    expect(core.createDifferentialQueryMaintenanceStrategy).toBeTypeOf('function');
    expect(core.safeParseReceipt).toBeTypeOf('function');
    expect(core.createSystemSchemaArtifact).toBeTypeOf('function');
    expect(core.runGoldenConformanceWorkloads).toBeTypeOf('function');
    expect(core.verifyBuiltInCapabilities).toBeTypeOf('function');
  });

  it('does not retain legacy API names', () => {
    for (const name of ['createDb', 'defineSchema', 'mat', 'project', 'relicChanges', 'transact', 'watch', 'write', 'InMemorySpikeSource']) {
      expect(name in core, name).toBe(false);
    }
  });
});
