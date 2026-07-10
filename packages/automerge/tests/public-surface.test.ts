import { describe, expect, it } from 'vitest';
import * as automerge from '../src/index.js';

describe('production Automerge surface', () => {
  it('exports source, projection, binding, and fallback move implementations', () => {
    expect(automerge.AutomergeSourceRuntime).toBeTypeOf('function');
    expect(automerge.AutomergeAtomicSource).toBeTypeOf('function');
    expect(automerge.AutomergeMapStorageBinding).toBeTypeOf('function');
    expect(automerge.AutomergeCoreMapStorageBinding).toBeTypeOf('function');
    expect(automerge.readAutomergeMetadata).toBeTypeOf('function');
    expect(automerge.planAutomergeMetadataMutation).toBeTypeOf('function');
    expect(automerge.automergeIssueDeclarations.length).toBeGreaterThan(0);
    expect(automerge.projectAutomergeFacts).toBeTypeOf('function');
    expect(automerge.copyRelocateAutomerge).toBeTypeOf('function');
    expect(automerge.resolveAutomergeMoveReference).toBeTypeOf('function');
    expect(automerge.repairAutomergeLiveFork).toBeTypeOf('function');
  });

  it('does not retain legacy adapter or React names', () => {
    for (const name of ['automergeMapAdapter', 'automergeMapSource', 'automergePresenceRuntime', 'useAutomergeStore']) {
      expect(name in automerge, name).toBe(false);
    }
  });
});
