import { describe, expect, expectTypeOf, it } from 'vitest';
import * as root from '../src/root.js';
import * as artifacts from '@tarstate/core/artifacts';
import * as attachmentAdapter from '@tarstate/core/attachment/adapter';
import * as capabilities from '@tarstate/core/capabilities';
import * as database from '@tarstate/core/database';
import * as databaseIncremental from '@tarstate/core/database/incremental';
import * as databaseObserver from '@tarstate/core/database/observer';
import * as query from '@tarstate/core/query';
import * as queryAuthoring from '@tarstate/core/query/authoring';
import * as queryEvaluate from '@tarstate/core/query/evaluate';
import * as queryIncremental from '@tarstate/core/query/incremental';
import * as queryModel from '@tarstate/core/query/model';
import * as queryPrepare from '@tarstate/core/query/prepare';
import * as schema from '@tarstate/core/schema';
import * as source from '@tarstate/core/source';
import * as transactions from '@tarstate/core/transactions';
import * as transactionAuthoring from '@tarstate/core/transactions/authoring';
import type { DocumentDeclaration } from '@tarstate/core/attachment';
import type { ObserverDiagnosticReporter } from '@tarstate/core/database';
import type { PreparedPlan } from '@tarstate/core/query';
import type { AtomicSource } from '@tarstate/core/source';

describe('topic-focused core surface', () => {
  it('keeps the package root limited to portable foundation values', () => {
    expect(root.safeParseArtifactText).toBeTypeOf('function');
    expect('evaluateQuery' in root).toBe(false);
    expect('DatabaseView' in root).toBe(false);
    expect('executePreparedTransaction' in root).toBe(false);
  });

  it('exposes runtime features only from their topic entries', () => {
    expect(artifacts.ExactArtifactResolver).toBeTypeOf('function');
    expect(attachmentAdapter.prepareDatabaseAttachment).toBeTypeOf('function');
    expect(capabilities.CapabilityRegistry).toBeTypeOf('function');
    expect(database.DatabaseView).toBeTypeOf('function');
    expect('prepareDatabaseAttachment' in database).toBe(false);
    expect('coordinateSourceCommit' in database).toBe(false);
    expect('InMemoryAtomicSource' in database).toBe(false);
    expect(databaseIncremental.createIncrementalDatabaseQueryMaintenance).toBeTypeOf('function');
    expect(queryEvaluate.evaluateQuery).toBe(query.evaluateQuery);
    expect('evaluatePreparedQuery' in queryEvaluate).toBe(false);
    expect('evaluatePreparedQuery' in query).toBe(false);
    expect('evaluatePreparedExpression' in queryEvaluate).toBe(false);
    expect('evaluatePreparedExpression' in query).toBe(false);
    expect(queryIncremental.openIncrementalQueryMaintenance).toBe(query.openIncrementalQueryMaintenance);
    expect(queryPrepare.prepareQuery).toBe(query.prepareQuery);
    expect('preparePlan' in queryPrepare).toBe(false);
    expect('preparePlan' in query).toBe(false);
    expect('typedPreparedPlan' in queryAuthoring).toBe(false);
    expect('typedPreparedPlan' in query).toBe(false);
    expect(queryAuthoring.typedSelect).toBe(query.typedSelect);
    expect(schema.prepareSchema).toBeTypeOf('function');
    expect(attachmentAdapter.createAttachmentTransactionService).toBeTypeOf('function');
    expect('prepareWritableExecutionContext' in transactions).toBe(false);
    expect('executePreparedTransaction' in transactions).toBe(false);
    expect('simulatePreparedTransaction' in transactions).toBe(false);
    expect(transactionAuthoring.sealTransaction).toBe(transactions.sealTransaction);
  });

  it('keeps deliberately type-only and narrow runtime entries narrow', () => {
    expect(Object.keys(source)).toEqual([]);
    expect(Object.keys(queryModel)).toEqual([]);
    expect('prepareQuery' in queryEvaluate).toBe(false);
    expect('prepareQueryMaintenanceSnapshot' in queryEvaluate).toBe(false);
    expect('prepareQueryMaintenanceSnapshot' in query).toBe(false);
    expect('prepareQueryMaintenanceSnapshot' in queryPrepare).toBe(false);
    expect('openIncrementalQueryMaintenance' in queryEvaluate).toBe(false);
    expect('evaluateQuery' in queryIncremental).toBe(false);
    expect('executeNonAtomicBatch' in transactionAuthoring).toBe(false);
    expect('createIncrementalDatabaseQueryMaintenance' in databaseObserver).toBe(false);
    expectTypeOf<ObserverDiagnosticReporter>().toMatchTypeOf<import('../src/observer-diagnostics.js').ObserverDiagnosticReporter>();
    expectTypeOf<PreparedPlan>().toMatchTypeOf<import('../src/maintenance.js').PreparedPlan>();
    expectTypeOf<AtomicSource<unknown, unknown>>().toMatchTypeOf<import('../src/source-protocol.js').AtomicSource<unknown, unknown>>();
    expectTypeOf<DocumentDeclaration>().toMatchTypeOf<import('../src/attachment-model.js').DocumentDeclaration>();
  });

  it('publishes immutable constants', () => {
    expect(Object.isFrozen(root.artifactKinds)).toBe(true);
    expect(Object.isFrozen(root.defaultArtifactParseBudget)).toBe(true);
    expect(Object.isFrozen(root.defaultValueParseBudget)).toBe(true);
    expect(Object.isFrozen(root.builtInCapabilityRefs)).toBe(true);
    expect(Object.values(root.builtInCapabilityRefs).every(Object.isFrozen)).toBe(true);
    expect(Object.isFrozen(root.builtInCapabilityDeclarations)).toBe(true);
  });

  it('shares provenance across focused query entries', async () => {
    const queryRoot = { kind: 'values', alias: 'value', rows: [{ id: 1 }] } as const;
    const prepared = await queryPrepare.prepareQuery({ root: queryRoot, registryFingerprint: 'registry:test', authorityFingerprint: 'authority:test', datasetId: 'dataset:test' });
    expect(queryEvaluate.evaluateQuery({ root: prepared, relations: [] }).rows).toEqual([{ id: 1 }]);
  });
});
