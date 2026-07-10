import type { ArtifactRef } from './artifacts.js';
import { ExternalStoreRuntime, type AtomicExternalStore } from './external-store.js';
import { SourceLifecycleCoordinator } from './lifecycle-governance.js';
import { projectLensRelation, translateLensEdits, type LensRows, type SchemaLensBody } from './lens.js';
import { InMemoryAtomicSource } from './memory-source.js';
import type { PreparedPlan } from './maintenance.js';
import { diffQueryMaintenanceSnapshots, openIncrementalQueryMaintenance, type QueryMaintenanceSnapshot, type QueryNode, type QueryRecord, type QueryResult, type RelationInput } from './query.js';
import { executeSequence, type SequenceReceipt, type SourceLifecycleCommand } from './receipts.js';
import { sealTransaction } from './transaction.js';

export type GoldenFixtureStatus = 'synthetic' | 'migrated-synthetic';
export type GoldenWorkloadLabel =
  | 'leaderboard-windows'
  | 'schema-v1-v200-lens'
  | 'real-estate-join-aggregate'
  | 'patchpit-folder-recursion'
  | 'probability-scene-move-external-store';

export type GoldenWorkloadTrace = {
  readonly label: GoldenWorkloadLabel;
  readonly fixtureStatus: GoldenFixtureStatus;
  readonly evidence: Readonly<Record<string, unknown>>;
};

const hash = (character: string) => `sha256:${character.repeat(64)}` as const;
const schemaView: ArtifactRef = { id: 'urn:tarstate:golden:schema', contentHash: hash('a') };

const relation = (relationId: string, rows: readonly QueryRecord[]): RelationInput => ({
  relation: { schemaView, relationId },
  rows,
  occurrenceIds: rows.map((_, index) => `${relationId}:${index}`),
  completeness: 'exact',
  sourceId: `golden:${relationId}`,
  attachmentId: `golden:${relationId}`,
  basis: 1
});
const from = (relationId: string, alias: string): QueryNode => ({ kind: 'from', relation: { schemaView, relationId }, alias });
const field = (alias: string, name: string) => ({ kind: 'field', alias, name } as const);

const openGoldenMaintenance = (label: GoldenWorkloadLabel, root: QueryNode, relations: readonly RelationInput[]) =>
  openIncrementalQueryMaintenance({
    planId: 'golden:' + label,
    rootNodeId: 'golden:' + label + ':root',
    query: root,
    registryFingerprint: 'golden:registry',
    authorityFingerprint: 'golden:authority',
    datasetId: 'golden:dataset'
  } satisfies PreparedPlan<QueryNode>, { relations });

const runGoldenQuery = (label: GoldenWorkloadLabel, root: QueryNode, relations: readonly RelationInput[]): QueryResult => {
  const session = openGoldenMaintenance(label, root, relations);
  const { state: _state, ...result } = session.getCurrentResult();
  session.close();
  return result;
};

export const runLeaderboardGolden = (): GoldenWorkloadTrace => {
  const input = from('golden.leaderboard', 'score');
  const root: QueryNode = {
    kind: 'order',
    input: {
      kind: 'window',
      input,
      alias: 'score',
      fields: {
        rowNumber: { kind: 'window', op: 'row-number', orderBy: [{ value: field('score', 'points'), direction: 'desc' }] },
        rank: { kind: 'window', op: 'rank', orderBy: [{ value: field('score', 'points'), direction: 'desc' }] },
        previousPoints: { kind: 'window', op: 'lag', value: field('score', 'points'), orderBy: [{ value: field('score', 'points'), direction: 'desc' }] }
      }
    },
    by: [{ value: field('score', 'points'), direction: 'desc' }]
  };
  const result = runGoldenQuery('leaderboard-windows', root, [relation('golden.leaderboard', [
      { player: 'Ada', points: 12 },
      { player: 'Bob', points: 8 },
      { player: 'Cy', points: 8 },
      { player: 'Dee', points: 3 }
    ])]);
  return { label: 'leaderboard-windows', fixtureStatus: 'synthetic', evidence: { rows: result.rows, resultKeys: result.resultKeys, completeness: result.completeness } };
};

export const runSchemaV1V200Golden = (): GoldenWorkloadTrace => {
  const stored: ArtifactRef = { id: 'urn:tarstate:golden:work-items:200', contentHash: hash('b') };
  const view: ArtifactRef = { id: 'urn:tarstate:golden:tasks:1', contentHash: hash('c') };
  const lens: SchemaLensBody = {
    from: stored,
    to: view,
    relations: [{
      fromRelationId: 'golden.task',
      toRelationId: 'golden.task',
      steps: [
        { kind: 'lens.field', from: 'legacySlug', to: 'slug', write: 'invertible' },
        { kind: 'lens.field', from: 'name', to: 'title', write: 'invertible' },
        {
          kind: 'lens.value-map', from: 'state', to: 'state', unmapped: 'reject', cases: [
            { from: 'open', to: 'open', writeBack: 'to-from' },
            { from: 'done', to: 'done', writeBack: 'to-from' },
            { from: 'blocked', to: 'open', writeBack: 'reject' }
          ]
        },
        { kind: 'lens.hide', from: 'notes', write: 'preserve' },
        { kind: 'lens.hide', from: 'serverOnly', write: 'preserve' }
      ]
    }]
  };
  const rows: LensRows = {
    'golden.task': [
      { id: 'task-1', legacySlug: 'draft-plan', name: 'Draft plan', state: 'open', notes: 'v200 only', serverOnly: { retained: true } },
      { id: 'task-2', legacySlug: 'blocked-plan', name: 'Blocked plan', state: 'blocked', notes: 'hidden' }
    ]
  };
  const projection = projectLensRelation(lens, 'golden.task', rows);
  const patch = translateLensEdits(lens, 'golden.task', rows['golden.task']?.[0] ?? {}, { title: 'Renamed by v1' }, rows);
  return {
    label: 'schema-v1-v200-lens',
    fixtureStatus: 'synthetic',
    evidence: {
      rows: projection.rows,
      completeness: projection.completeness,
      issueCodes: projection.issues.map(({ code }) => code),
      preservingPatch: patch.success ? patch.value : null,
      preservedStorage: rows['golden.task']?.[0]
    }
  };
};

export const runRealEstateGolden = (): GoldenWorkloadTrace => {
  const joined: QueryNode = {
    kind: 'join',
    join: 'inner',
    left: from('golden.listing', 'listing'),
    right: from('golden.agent', 'agent'),
    on: { kind: 'compare', op: 'eq', left: field('listing', 'agentId'), right: field('agent', 'id') }
  };
  const root: QueryNode = {
    kind: 'order',
    input: {
      kind: 'aggregate',
      input: joined,
      alias: 'summary',
      groupBy: { agentId: field('agent', 'id'), agentName: field('agent', 'name') },
      measures: {
        listings: { kind: 'aggregate', op: 'count' },
        totalPrice: { kind: 'aggregate', op: 'sum', value: field('listing', 'price') },
        averagePrice: { kind: 'aggregate', op: 'average', value: field('listing', 'price') }
      }
    },
    by: [{ value: field('summary', 'totalPrice'), direction: 'desc' }]
  };
  const result = runGoldenQuery('real-estate-join-aggregate', root, [
      relation('golden.agent', [{ id: 'agent-a', name: 'Aroha' }, { id: 'agent-b', name: 'Ben' }]),
      relation('golden.listing', [
        { id: 'home-1', agentId: 'agent-a', price: 900_000 },
        { id: 'home-2', agentId: 'agent-a', price: 700_000 },
        { id: 'home-3', agentId: 'agent-b', price: 500_000 }
      ])
    ]);
  return { label: 'real-estate-join-aggregate', fixtureStatus: 'synthetic', evidence: { rows: result.rows, completeness: result.completeness } };
};

export const runPatchpitFolderGolden = (): GoldenWorkloadTrace => {
  const recursive: QueryNode = {
    kind: 'recursive',
    name: 'folders',
    seed: { kind: 'values', alias: 'folder', rows: [{ id: 'A' }] },
    step: {
      kind: 'select',
      alias: 'folder',
      input: {
        kind: 'where',
        input: {
          kind: 'join',
          join: 'inner',
          left: { kind: 'recursion-ref', name: 'folders' },
          right: from('golden.folder-entry', 'entry'),
          on: { kind: 'compare', op: 'eq', left: field('folder', 'id'), right: field('entry', 'parentId') }
        },
        predicate: { kind: 'compare', op: 'eq', left: field('entry', 'kind'), right: { kind: 'literal', value: 'folder' } }
      },
      fields: { id: field('entry', 'targetId') }
    },
    key: [field('folder', 'id')]
  };
  const result = runGoldenQuery('patchpit-folder-recursion', recursive, [relation('golden.folder-entry', [
      { entryId: 'a-app', parentId: 'A', kind: 'folder', targetId: 'B', ref: 'automerge:B' },
      { entryId: 'a-tiger', parentId: 'A', kind: 'resource', targetId: 'tiger', ref: 'https://example.test/Ghostscript_Tiger.svg' },
      { entryId: 'a-missing', parentId: 'A', kind: 'unavailable', targetId: 'C', ref: 'automerge:C' },
      { entryId: 'b-cycle', parentId: 'B', kind: 'folder', targetId: 'A', ref: 'automerge:A' }
    ])]);
  return {
    label: 'patchpit-folder-recursion',
    fixtureStatus: 'migrated-synthetic',
    evidence: {
      visitedFolders: result.rows,
      completeness: result.completeness,
      tigerResource: { kind: 'bytes', mediaType: 'image/svg+xml', relationalSource: false },
      unavailableTargets: [{ id: 'C', state: 'missing' }],
      identityModel: 'stable-entry-id'
    }
  };
};

/**
 * Executes Patchpit's non-atomic create-then-link shell workflow. The source
 * creation and folder transaction use the real coordinators; the stale folder
 * basis makes the second step fail without pretending the first can roll back.
 */
export const runPatchpitCreationFailureGolden = async (): Promise<SequenceReceipt> => {
  const sourceCapability = { id: 'urn:tarstate:golden:automerge-source', version: '1', contractHash: hash('d') };
  const lifecycle = new SourceLifecycleCoordinator({
    lifecycleCoordinatorId: 'golden:patchpit:lifecycle',
    operationEpoch: 'golden:patchpit:lifecycle:1',
    authorityViewFingerprint: hash('e'),
    authorize: () => ({ allowed: true }),
    adapter: {
      allocateSourceId: () => 'golden:folder:C',
      create: ({ context }) => {
        context.markMutationPossible();
        return { outcome: 'committed', durability: 'memory', issues: [] };
      },
      delete: () => ({ outcome: 'committed', durability: 'memory', issues: [] })
    }
  });
  const create: SourceLifecycleCommand = {
    lifecycleCoordinatorId: lifecycle.lifecycleCoordinatorId,
    operationEpoch: lifecycle.ledger.activeEpoch,
    operationId: 'golden:create:C',
    request: { action: 'create', sourceCapability, input: { kind: 'folder', title: 'C' } }
  };
  const folder = new InMemoryAtomicSource({
    sourceId: 'golden:folder:A',
    incarnation: 'golden:folder:A:1',
    operationEpoch: 'golden:folder:A:operations:1',
    state: { entries: [] },
    relations: [{ relationId: 'golden.folder-entry', schemaView, keyFields: ['entryId'] }],
    attachments: [{
      attachmentId: 'golden:folder:A:attachment',
      fingerprint: hash('f'),
      authorityViewFingerprint: hash('e'),
      schemaView,
      writable: true
    }]
  });
  const link = await sealTransaction({ body: {
    schemaView,
    parameters: {},
    guards: [],
    requiredCapabilities: [],
    statements: [{
      kind: 'statement.insert',
      relation: { relationId: 'golden.folder-entry', schemaView },
      rows: [{
        entryId: { kind: 'literal', value: 'a-folder-c' },
        kind: { kind: 'literal', value: 'folder' },
        targetId: { kind: 'literal', value: 'C' },
        ref: { kind: 'literal', value: 'automerge:C' }
      }]
    }]
  } });
  return executeSequence({
    sequenceId: 'golden:patchpit:create-and-link:C',
    steps: [
      { stepId: 'create-source', run: () => lifecycle.execute(create) },
      { stepId: 'link-folder-entry', run: () => folder.commit({
        operationEpoch: 'golden:folder:A:operations:1',
        operationId: 'golden:link:C',
        attachmentId: 'golden:folder:A:attachment',
        expectedBasis: { incarnation: 'stale-folder-incarnation', revision: 0 },
        transaction: link
      }) }
    ]
  });
};

export const runProbabilityGolden = (): GoldenWorkloadTrace => {
  type GeometryState = { readonly rows: readonly QueryRecord[] };
  let state: GeometryState = { rows: [{ entityId: 'panel-1', x: 10, y: 20 }, { entityId: 'label-1', x: 12, y: 24 }] };
  const listeners = new Set<() => void>();
  const store: AtomicExternalStore<GeometryState> = {
    getState: () => state,
    subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    update: (update) => {
      const next = update(state);
      state = next.state;
      if (next.changed) for (const listener of listeners) listener();
      return next.result;
    }
  };
  const runtime = new ExternalStoreRuntime('golden:geometry', store);
  const query: QueryNode = {
    kind: 'join',
    join: 'inner',
    left: from('golden.scene-entity', 'entity'),
    right: from('golden.geometry', 'geometry'),
    on: { kind: 'compare', op: 'eq', left: field('entity', 'id'), right: field('geometry', 'entityId') }
  };
  const beforeScene = [{ id: 'panel-1', parentId: 'root', kind: 'panel' }, { id: 'label-1', parentId: 'panel-1', kind: 'label' }];
  const beforeSnapshot = runtime.snapshot();
  const beforeQuery: QueryMaintenanceSnapshot = { relations: [relation('golden.scene-entity', beforeScene), relation('golden.geometry', beforeSnapshot.storage?.rows ?? [])] };
  const maintenance = openGoldenMaintenance('probability-scene-move-external-store', query, beforeQuery.relations);
  const { state: _beforeState, ...before } = maintenance.getCurrentResult();
  const committed = runtime.commit(beforeSnapshot.basis, (current) => ({
    state: { rows: current.rows.map((row) => row.entityId === 'panel-1' ? { ...row, x: 40 } : row) },
    changed: true,
    result: 'geometry-updated' as const
  }));
  const movedScene = beforeScene.map((row) => row.id === 'panel-1' ? { ...row, parentId: 'column-2' } : row);
  const afterSnapshot = runtime.snapshot();
  const afterQuery: QueryMaintenanceSnapshot = { relations: [relation('golden.scene-entity', movedScene), relation('golden.geometry', afterSnapshot.storage?.rows ?? [])] };
  const { state: _afterState, ...after } = maintenance.applyUpdate(diffQueryMaintenanceSnapshots(beforeQuery, afterQuery));
  maintenance.close();
  runtime.close();
  return {
    label: 'probability-scene-move-external-store',
    fixtureStatus: 'migrated-synthetic',
    evidence: {
      beforeRows: before.rows,
      afterRows: after.rows,
      sceneParent: 'column-2',
      moveMechanism: 'application-parent-field',
      stableLogicalReference: 'label-1',
      externalStoreRevision: committed.outcome === 'committed' ? committed.afterBasis.revision : null,
      crossSourceAtomic: false
    }
  };
};

export const runGoldenConformanceWorkloads = (): readonly GoldenWorkloadTrace[] => [
  runLeaderboardGolden(),
  runSchemaV1V200Golden(),
  runRealEstateGolden(),
  runPatchpitFolderGolden(),
  runProbabilityGolden()
];
