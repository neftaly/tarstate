import { describe, expect, it } from 'vitest';
import * as automerge from '../src/index.js';

describe('production Automerge surface', () => {
  it('exports source, projection, binding, and metadata implementations', () => {
    expect(automerge.AutomergeSourceRuntime).toBeTypeOf('function');
    expect(automerge.automergeRepoSourceRuntime).toBeTypeOf('function');
    expect(automerge.AutomergeAtomicSource).toBeTypeOf('function');
    expect(automerge.AutomergeMapProjectionPlanner).toBeTypeOf('function');
    expect(automerge.AutomergeMapStorageBinding).toBeTypeOf('function');
    expect(automerge.AutomergeMappedStorageBinding).toBeTypeOf('function');
    expect(automerge.automergeArtifactResourceDriver).toBeTypeOf('function');
    expect(automerge.extractAutomergeArtifactCarrier).toBeTypeOf('function');
    expect(automerge.readAutomergeMetadata).toBeTypeOf('function');
    expect(automerge.planAutomergeMetadataMutation).toBeTypeOf('function');
    expect(automerge.automergeIssueDeclarations.length).toBeGreaterThan(0);
    expect(automerge.projectAutomergeFacts).toBeTypeOf('function');
    expect(automerge.snapshotAutomergeDocument).toBeTypeOf('function');
    expect(Object.isFrozen(automerge.defaultAutomergeProjectionBudget)).toBe(true);
  });

  it('does not expose legacy names, move metadata, or internal row materializers', () => {
    for (const name of ['automergeMapAdapter', 'automergeMapSource', 'automergePresenceRuntime', 'useAutomergeStore', 'copyRelocateAutomerge', 'readAutomergeMoveRecords', 'repairAutomergeLiveFork', 'materializeAutomergePeerRow', 'materializeAutomergeConnectionRow', 'materializeAutomergeSyncRow', 'materializeAutomergePresenceRow', 'conflictsAt', 'normalizeAutomergeValue', 'planPropertyEdit', 'valueAtAutomergePath']) {
      expect(name in automerge, name).toBe(false);
    }
  });
});
