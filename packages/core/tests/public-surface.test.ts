import { describe, expect, it } from 'vitest';
import * as core from '../src/index.js';
import * as artifacts from '@tarstate/core/artifacts';
import * as database from '@tarstate/core/database';
import * as query from '@tarstate/core/query';
import * as schema from '@tarstate/core/schema';
import * as transactions from '@tarstate/core/transactions';

describe('clean rewrite core surface', () => {
  it('exposes the production foundation at the package root', () => {
    expect(core.safeParseArtifactText).toBeTypeOf('function');
    expect(core.safeParseQueryArtifact).toBeTypeOf('function');
    expect(core.safePrepareTransactionArtifact).toBeTypeOf('function');
    expect(core.CapabilityRegistry).toBeTypeOf('function');
    expect(core.HostRuntimeRegistry).toBeTypeOf('function');
    expect(core.evaluateQuery).toBeTypeOf('function');
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
    expect(database.DatabaseView).toBe(core.DatabaseView);
    expect(query.evaluateQuery).toBe(core.evaluateQuery);
    expect(query.prepareTypedQuery).toBe(core.prepareTypedQuery);
    expect(query.typedSelect).toBe(core.typedSelect);
    expect(schema.prepareSchema).toBe(core.prepareSchema);
    expect(schema.schemaLiteral).toBe(core.schemaLiteral);
    expect(transactions.sealTransaction).toBe(core.sealTransaction);
    expect(transactions.typedReturning).toBe(core.typedReturning);
    expect('createPooledIncrementalQueryRuntime' in query).toBe(false);
    expect('typedReturning' in query).toBe(false);
    expect('typedSelect' in schema).toBe(false);
  });

  it('does not retain legacy API names', () => {
    for (const name of ['createDb', 'defineSchema', 'emptyStatementResult', 'mat', 'project', 'relicChanges', 'runGoldenConformanceWorkloads', 'sealTypedArtifact', 'transact', 'watch', 'write', 'InMemorySpikeSource']) {
      expect(name in core, name).toBe(false);
    }
  });
});
