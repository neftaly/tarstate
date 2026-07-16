import { describe, expect, expectTypeOf, it } from 'vitest';
import * as root from '../src/root.js';
import * as artifacts from '@tarstate/core/artifacts';
import * as attachmentPreparation from '@tarstate/core/attachment/prepare';
import * as attachmentTransactions from '@tarstate/core/attachment/transact';
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
import type { DocumentDeclaration } from '@tarstate/core/attachment';
import type { ObserverDiagnosticReporter } from '@tarstate/core/database';
import type { PreparedPlan } from '@tarstate/core/query';
import type { AtomicSource } from '@tarstate/core/source';

describe('topic-focused core surface', () => {
  it('keeps the package root identical to the small foundation entry', () => {
    expect(Object.keys(root).sort()).toEqual(Object.keys(foundation).sort());
    expect(root.safeParseArtifactText).toBe(foundation.safeParseArtifactText);
    expect('evaluateQuery' in root).toBe(false);
    expect('DatabaseView' in root).toBe(false);
    expect('executePreparedTransaction' in root).toBe(false);
  });

  it('exposes runtime features only from their topic entries', () => {
    expect(artifacts.ExactArtifactResolver).toBeTypeOf('function');
    expect(attachmentPreparation.prepareDatabaseAttachment).toBeTypeOf('function');
    expect(capabilities.CapabilityRegistry).toBeTypeOf('function');
    expect(database.DatabaseView).toBeTypeOf('function');
    expect(databaseIncremental.createIncrementalDatabaseQueryMaintenance).toBeTypeOf('function');
    expect(queryEvaluate.evaluateQuery).toBe(query.evaluateQuery);
    expect(queryIncremental.openIncrementalQueryMaintenance).toBe(query.openIncrementalQueryMaintenance);
    expect(queryIncremental.createQueryOccurrenceIds).toBeTypeOf('function');
    expect(queryPrepare.prepareQuery).toBe(query.prepareQuery);
    expect(queryAuthoring.typedSelect).toBe(query.typedSelect);
    expect(schema.prepareSchema).toBeTypeOf('function');
    expect(attachmentTransactions.createAttachmentTransactionService).toBeTypeOf('function');
    expect('prepareWritableExecutionContext' in transactions).toBe(false);
    expect('executePreparedTransaction' in transactions).toBe(false);
    expect('simulatePreparedTransaction' in transactions).toBe(false);
    expect(transactionAuthoring.sealTransaction).toBe(transactions.sealTransaction);
  });

  it('creates immutable occurrence identities at the incremental input boundary', () => {
    const rows = [{ id: 'first' }, { id: 'second' }];
    const visited: number[] = [];
    const occurrenceIds = queryIncremental.createQueryOccurrenceIds(rows, (row, index) => {
      visited.push(index);
      return `${row.id}:${index}`;
    });

    expect(occurrenceIds).toEqual(['first:0', 'second:1']);
    expect(visited).toEqual([0, 1]);
    expect(Object.isFrozen(occurrenceIds)).toBe(true);
  });

  it('keeps deliberately type-only and narrow runtime entries narrow', () => {
    expect(Object.keys(source)).toEqual([]);
    expect(Object.keys(queryModel)).toEqual([]);
    expect(Object.keys(sourceProjection)).toEqual(['sealStorageProjection']);
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

  it('publishes immutable constants and adopts sealed storage projections', () => {
    expect(Object.isFrozen(root.artifactKinds)).toBe(true);
    expect(Object.isFrozen(root.defaultArtifactParseBudget)).toBe(true);
    expect(Object.isFrozen(root.defaultValueParseBudget)).toBe(true);
    expect(Object.isFrozen(root.builtInCapabilityRefs)).toBe(true);
    expect(Object.values(root.builtInCapabilityRefs).every(Object.isFrozen)).toBe(true);
    expect(Object.isFrozen(root.builtInCapabilityDeclarations)).toBe(true);

    const input = Object.freeze({
      rows: Object.freeze([Object.freeze({
        relationId: 'test.row',
        key: Object.freeze(['one']),
        fields: Object.freeze({ nested: Object.freeze({ value: 1 }) }),
        locator: Object.freeze(['one'])
      })]),
      completeness: 'exact' as const,
      issues: Object.freeze([])
    });
    const sealed = sourceProjection.sealStorageProjection(input);
    expect(sealed).toBe(input);
    expect(Object.isFrozen(sealed)).toBe(true);
    expect(Object.isFrozen(sealed.rows)).toBe(true);
    expect(Object.isFrozen(sealed.rows[0])).toBe(true);
    expect(Object.isFrozen(sealed.rows[0]?.fields.nested)).toBe(true);
    expect(() => sourceProjection.sealStorageProjection({
      rows: [{ relationId: 'test.row', key: ['one'], fields: {}, locator: ['one'] }],
      completeness: 'exact',
      issues: []
    } as never)).toThrow(TypeError);
  });

  it('shares provenance across focused query entries', async () => {
    const queryRoot = { kind: 'values', alias: 'value', rows: [{ id: 1 }] } as const;
    const prepared = await queryPrepare.prepareQuery({ root: queryRoot, registryFingerprint: 'registry:test', authorityFingerprint: 'authority:test', datasetId: 'dataset:test' });
    expect(queryEvaluate.evaluatePreparedQuery(prepared, { relations: [] }).rows).toEqual([{ id: 1 }]);
  });
});
