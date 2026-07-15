import { describe, expect, expectTypeOf, it } from 'vitest';
import * as core from '../src/index.js';
import * as artifacts from '@tarstate/core/artifacts';
import * as constraintArtifacts from '@tarstate/core/artifacts/constraint-set';
import * as queryArtifacts from '@tarstate/core/artifacts/query';
import * as schemaLensArtifacts from '@tarstate/core/artifacts/schema-lens';
import * as semanticArtifacts from '@tarstate/core/artifacts/semantic';
import * as storageMappingArtifacts from '@tarstate/core/artifacts/storage-mapping';
import * as transactionArtifacts from '@tarstate/core/artifacts/transaction';
import * as attachmentPreparation from '@tarstate/core/attachment/prepare';
import * as capabilities from '@tarstate/core/capabilities';
import * as database from '@tarstate/core/database';
import * as databaseIncremental from '@tarstate/core/database/incremental';
import * as databaseObserver from '@tarstate/core/database/observer';
import * as foundation from '@tarstate/core/foundation';
import * as query from '@tarstate/core/query';
import * as queryAuthoring from '@tarstate/core/query/authoring';
import * as queryEvaluate from '@tarstate/core/query/evaluate';
import * as queryIncremental from '@tarstate/core/query/incremental';
import * as queryModel from '@tarstate/core/query/model';
import * as queryPrepare from '@tarstate/core/query/prepare';
import * as schema from '@tarstate/core/schema';
import * as source from '@tarstate/core/source';
import * as sourceProjection from '@tarstate/core/source/projection';
import * as transactions from '@tarstate/core/transactions';
import * as transactionAuthoring from '@tarstate/core/transactions/authoring';
import * as transactionDelta from '@tarstate/core/transactions/delta';
import type { DocumentDeclaration } from '@tarstate/core/attachment';
import type { ObserverDiagnosticReporter as TopicObserverDiagnosticReporter } from '@tarstate/core/database';
import type { PreparedPlan as TopicPreparedPlan } from '@tarstate/core/query';
import type { AtomicSource } from '@tarstate/core/source';

describe('clean rewrite core surface', () => {
  it('exposes the production foundation at the package root', () => {
    expect(core.safeParseArtifactText).toBeTypeOf('function');
    expect(core.safeParseQueryArtifact).toBeTypeOf('function');
    expect(core.safePrepareTransactionArtifact).toBeTypeOf('function');
    expect(core.CapabilityRegistry).toBeTypeOf('function');
    expect(core.HostRuntimeRegistry).toBeTypeOf('function');
    expect(core.evaluateQuery).toBeTypeOf('function');
    expect(core.evaluatePreparedQuery).toBeTypeOf('function');
    expect(core.openIncrementalQueryMaintenance).toBeTypeOf('function');
    expect(core.acquireExternalStoreRuntime).toBeTypeOf('function');
    expect(core.prepareSchema).toBeTypeOf('function');
    expect(core.sealSchema).toBeTypeOf('function');
    expect(core.sealStorageMapping).toBeTypeOf('function');
    expect(core.sealSchemaLens).toBeTypeOf('function');
    expect(core.schemaLiteral).toBeTypeOf('function');
    expect(core.typedFrom).toBeTypeOf('function');
    expect(core.resolveLensPath).toBeTypeOf('function');
    expect(core.InMemoryAtomicSource).toBeTypeOf('function');
    expect(core.sealTransaction).toBeTypeOf('function');
    expect(core.ResourceResolver).toBeTypeOf('function');
    expect(core.DatabaseView).toBeTypeOf('function');
    expect(core.queryObservationKey).toBeTypeOf('function');
    expect(core.coordinateSourceCommit).toBeTypeOf('function');
    expect(core.prepareWritableExecutionContext).toBeTypeOf('function');
    expect(core.executePreparedTransaction).toBeTypeOf('function');
    expect(core.ExactArtifactResolver).toBeTypeOf('function');
    expect(core.SourceLifecycleCoordinator).toBeTypeOf('function');
    expect(core.GovernanceCoordinator).toBeTypeOf('function');
    expect(core.safeParseReceipt).toBeTypeOf('function');
    expect(core.createSystemSchemaArtifact).toBeTypeOf('function');
    expect(core.verifyBuiltInCapabilities).toBeTypeOf('function');
  });

  it('matches the curated runtime export surface', () => {
    expect(Object.keys(core).sort()).toMatchSnapshot();
  });

  it('offers additive topic entry points with the same runtime identities', () => {
    expect(artifacts.safeParseArtifactText).toBe(core.safeParseArtifactText);
    expect(queryArtifacts.safeParseQueryArtifact).toBe(core.safeParseQueryArtifact);
    expect(transactionArtifacts.safeParseTransactionArtifact).toBe(core.safeParseTransactionArtifact);
    expect(constraintArtifacts.safeParseConstraintSetArtifact).toBe(core.safeParseConstraintSetArtifact);
    expect(storageMappingArtifacts.safeParseStorageMappingArtifact).toBe(core.safeParseStorageMappingArtifact);
    expect(schemaLensArtifacts.safeParseSchemaLensArtifact).toBe(core.safeParseSchemaLensArtifact);
    expect(semanticArtifacts.safeEvaluateQueryArtifact).toBe(core.safeEvaluateQueryArtifact);
    expect(attachmentPreparation.prepareDatabaseAttachment).toBe(core.prepareDatabaseAttachment);
    expect(capabilities.CapabilityRegistry).toBe(core.CapabilityRegistry);
    expect(capabilities.registerBuiltInCapabilities).toBe(core.registerBuiltInCapabilities);
    expect(database.DatabaseView).toBe(core.DatabaseView);
    expect(databaseObserver.DatabaseView).toBe(core.DatabaseView);
    expect(databaseIncremental.createIncrementalDatabaseQueryMaintenance).toBe(core.createIncrementalDatabaseQueryMaintenance);
    expect(foundation.logicalUnknown).toBe(core.logicalUnknown);
    expect(foundation.missingValue).toBe(core.missingValue);
    expect(foundation.capabilityUnavailable).toBe(core.capabilityUnavailable);
    expect(query.evaluateQuery).toBe(core.evaluateQuery);
    expect(queryEvaluate.evaluateQuery).toBe(core.evaluateQuery);
    expect(queryIncremental.openIncrementalQueryMaintenance).toBe(core.openIncrementalQueryMaintenance);
    expect(queryPrepare.prepareQuery).toBe(core.prepareQuery);
    expect(queryPrepare.prepareQueryMaintenanceSnapshot).toBe(core.prepareQueryMaintenanceSnapshot);
    expect(queryAuthoring.typedSelect).toBe(core.typedSelect);
    expect(query.evaluatePreparedQuery).toBe(core.evaluatePreparedQuery);
    expect(query.prepareTypedQuery).toBe(core.prepareTypedQuery);
    expect(query.typedSelect).toBe(core.typedSelect);
    expect(schema.prepareSchema).toBe(core.prepareSchema);
    expect(schema.schemaLiteral).toBe(core.schemaLiteral);
    expect(transactions.sealTransaction).toBe(core.sealTransaction);
    expect(transactions.typedReturning).toBe(core.typedReturning);
    expect(transactions.authorExactKeyedRelationDelta).toBeTypeOf('function');
    expect(transactionAuthoring.sealTransaction).toBe(core.sealTransaction);
    expect(transactionDelta.authorExactKeyedRelationDelta).toBe(transactions.authorExactKeyedRelationDelta);
    expect('executePreparedTransaction' in transactionAuthoring).toBe(false);
    expect('sealTransaction' in transactionDelta).toBe(false);
    expect('authorExactKeyedRelationDelta' in core).toBe(false);
    expect(sourceProjection.sealStorageProjection).toBeTypeOf('function');
    expect(Object.keys(sourceProjection)).toEqual(['sealStorageProjection']);
    expect(Object.keys(source)).toEqual([]);
    expect(Object.keys(queryModel)).toEqual([]);
    expect('openIncrementalQueryMaintenance' in queryEvaluate).toBe(false);
    expect('safeParseQueryArtifact' in artifacts).toBe(false);
    expect('safeParseTransactionArtifact' in artifacts).toBe(false);
    expect('evaluateQuery' in queryIncremental).toBe(false);
    expect('evaluateQuery' in queryPrepare).toBe(false);
    expect('openIncrementalQueryMaintenance' in queryAuthoring).toBe(false);
    expect('schemaLiteral' in queryAuthoring).toBe(false);
    expect('typedReturning' in queryAuthoring).toBe(false);
    expect('registerBuiltInCapabilities' in foundation).toBe(false);
    expect('createIncrementalDatabaseQueryMaintenance' in databaseObserver).toBe(false);
    expect('createPooledIncrementalQueryRuntime' in query).toBe(false);
    expect('typedReturning' in query).toBe(false);
    expect('typedSelect' in schema).toBe(false);
    expect('typedSelect' in transactions).toBe(false);
    expectTypeOf<TopicObserverDiagnosticReporter>().toMatchTypeOf<import('../src/observer-diagnostics.js').ObserverDiagnosticReporter>();
    expectTypeOf<TopicPreparedPlan>().toMatchTypeOf<import('../src/maintenance.js').PreparedPlan>();
    expectTypeOf<AtomicSource<unknown, unknown>>().toMatchTypeOf<core.AtomicSource<unknown, unknown>>();
    expectTypeOf<DocumentDeclaration>().toMatchTypeOf<core.DocumentDeclaration>();
  });

  it('shares prepared-plan provenance across the root and query entry points', async () => {
    const root = { kind: 'values', alias: 'value', rows: [{ id: 1 }] } as const;
    const fromTopic = await query.prepareQuery({ root, registryFingerprint: 'registry:test', authorityFingerprint: 'authority:test', datasetId: 'dataset:test' });
    const fromRoot = await core.prepareQuery({ root, registryFingerprint: 'registry:test', authorityFingerprint: 'authority:test', datasetId: 'dataset:test' });

    expect(core.evaluatePreparedQuery(fromTopic, { relations: [] }).rows).toEqual([{ id: 1 }]);
    expect(query.evaluatePreparedQuery(fromRoot, { relations: [] }).rows).toEqual([{ id: 1 }]);
  });

  it('does not retain legacy API names', () => {
    for (const name of ['createDb', 'defineSchema', 'emptyStatementResult', 'mat', 'project', 'relicChanges', 'runGoldenConformanceWorkloads', 'sealTypedArtifact', 'transact', 'watch', 'write', 'InMemorySpikeSource']) {
      expect(name in core, name).toBe(false);
    }
  });
});
