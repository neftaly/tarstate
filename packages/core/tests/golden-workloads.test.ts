import { describe, expect, it } from 'vitest';
import {
  runGoldenConformanceWorkloads,
  runLeaderboardGolden,
  runPatchpitCreationFailureGolden,
  runPatchpitFolderGolden,
  runProbabilityGolden,
  runRealEstateGolden,
  runSchemaV1V200Golden
} from '../src/golden-workloads.js';

describe('small labeled golden conformance workloads', () => {
  it('runs the synthetic leaderboard window subset', () => {
    const trace = runLeaderboardGolden();
    expect(trace).toMatchObject({ label: 'leaderboard-windows', fixtureStatus: 'synthetic' });
    expect(trace.evidence.rows).toEqual([
      { player: 'Ada', points: 12, rowNumber: 1, rank: 1, previousPoints: null },
      { player: 'Bob', points: 8, rowNumber: 2, rank: 2, previousPoints: 12 },
      { player: 'Cy', points: 8, rowNumber: 3, rank: 2, previousPoints: 8 },
      { player: 'Dee', points: 3, rowNumber: 4, rank: 4, previousPoints: 8 }
    ]);
  });

  it('runs the synthetic v1/v200 read and preserving-write lens trace', () => {
    const trace = runSchemaV1V200Golden();
    expect(trace).toMatchObject({ label: 'schema-v1-v200-lens', fixtureStatus: 'synthetic' });
    expect(trace.evidence.rows).toEqual([
      { slug: 'draft-plan', title: 'Draft plan', state: 'open' },
      { slug: 'blocked-plan', title: 'Blocked plan', state: 'open' }
    ]);
    expect(trace.evidence.issueCodes).toEqual(['lens.lossy_value']);
    expect(trace.evidence.preservingPatch).toEqual({ name: 'Renamed by v1' });
    expect(trace.evidence.preservedStorage).toMatchObject({ notes: 'v200 only', serverOnly: { retained: true } });
  });

  it('runs the synthetic Real Estate cross-relation aggregate', () => {
    const trace = runRealEstateGolden();
    expect(trace).toMatchObject({ label: 'real-estate-join-aggregate', fixtureStatus: 'synthetic' });
    expect(trace.evidence.rows).toEqual([
      { agentId: 'agent-a', agentName: 'Aroha', listings: 2, totalPrice: 1_600_000, averagePrice: 800_000 },
      { agentId: 'agent-b', agentName: 'Ben', listings: 1, totalPrice: 500_000, averagePrice: 500_000 }
    ]);
  });

  it('runs the migrated/synthetic Patchpit cycle and resource trace', () => {
    const trace = runPatchpitFolderGolden();
    expect(trace).toMatchObject({ label: 'patchpit-folder-recursion', fixtureStatus: 'migrated-synthetic' });
    expect(trace.evidence.visitedFolders).toEqual([{ id: 'A' }, { id: 'B' }]);
    expect(trace.evidence.tigerResource).toEqual({ kind: 'bytes', mediaType: 'image/svg+xml', relationalSource: false });
    expect(trace.evidence).toMatchObject({ completeness: 'exact', identityModel: 'stable-entry-id' });
  });

  it('executes the Patchpit create-then-link failure and names the orphan', async () => {
    const receipt = await runPatchpitCreationFailureGolden();
    expect(receipt).toMatchObject({
      sequenceId: 'golden:patchpit:create-and-link:C',
      outcome: 'partial',
      orphanedSourceIds: ['golden:folder:C'],
      steps: [
        { stepId: 'create-source', outcome: 'applied', receipt: { kind: 'source-lifecycle', outcome: 'committed', sourceId: 'golden:folder:C' } },
        { stepId: 'link-folder-entry', outcome: 'failed', receipt: { kind: 'commit', outcome: 'rejected', issues: [{ code: 'transaction.expected_basis_stale' }] } }
      ]
    });
  });

  it('runs the migrated/synthetic Probability scene, move, and external-store trace', () => {
    const trace = runProbabilityGolden();
    expect(trace).toMatchObject({ label: 'probability-scene-move-external-store', fixtureStatus: 'migrated-synthetic' });
    expect(trace.evidence).toMatchObject({ sceneParent: 'column-2', moveMechanism: 'copyRelocate', stableLogicalReference: 'label-1', externalStoreRevision: 1, crossSourceAtomic: false });
    expect(trace.evidence.afterRows).toEqual([
      { entity: { id: 'panel-1', parentId: 'column-2', kind: 'panel' }, geometry: { entityId: 'panel-1', x: 40, y: 20 } },
      { entity: { id: 'label-1', parentId: 'panel-1', kind: 'label' }, geometry: { entityId: 'label-1', x: 12, y: 24 } }
    ]);
  });

  it('runs the complete staged set with explicit provenance labels', () => {
    const traces = runGoldenConformanceWorkloads();
    expect(traces.map(({ label }) => label)).toEqual([
      'leaderboard-windows',
      'schema-v1-v200-lens',
      'real-estate-join-aggregate',
      'patchpit-folder-recursion',
      'probability-scene-move-external-store'
    ]);
    expect(traces.filter(({ fixtureStatus }) => fixtureStatus === 'migrated-synthetic').map(({ label }) => label))
      .toEqual(['patchpit-folder-recursion', 'probability-scene-move-external-store']);
  });
});
