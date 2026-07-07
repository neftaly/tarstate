import { describe, expect, it } from 'vitest';
import * as rootApi from '@tarstate/core';
import * as materializationApi from '@tarstate/core/materialization';
import * as queryApi from '@tarstate/core/query';
import * as runtimeApi from '@tarstate/core/runtime';
import * as watchApi from '@tarstate/core/watch';
import * as writeApi from '@tarstate/core/write';
import { account, entry, type Account, type Entry } from './behavior-fixtures.js';

describe('Relic public API parity', () => {
  it('exports dependencies as an alias for relationDependencies', () => {
    const joined = queryApi.pipe(
      queryApi.from(entry),
      queryApi.join(queryApi.from(account), queryApi.clauses<Entry, Account>({ accountId: 'id' })),
      queryApi.project({
        id: entry.row.id,
        accountName: account.row.name
      })
    );

    expect(queryApi.dependencies).toBe(queryApi.relationDependencies);
    expect(rootApi.dependencies).toBe(rootApi.relationDependencies);
    expect(rootApi.dependencies(joined)).toEqual(queryApi.relationDependencies(joined));
    expect(new Set(rootApi.dependencies(joined))).toEqual(new Set(['entries', 'accounts']));
  });

  it('exports Relic-shaped query aliases for canonical helpers', () => {
    expect(queryApi.select).toBe(queryApi.project);
    expect(queryApi.agg).toBe(queryApi.aggregate);
    expect(queryApi.constantRows).toBe(queryApi.constRows);
    expect(queryApi.constRelation).toBe(queryApi.constRows);

    expect(rootApi.select).toBe(queryApi.project);
    expect(rootApi.agg).toBe(queryApi.aggregate);
    expect(rootApi.constantRows).toBe(queryApi.constRows);
    expect(rootApi.constRelation).toBe(queryApi.constRows);
  });

  it('keeps Relic-shaped query aggregate and subquery helpers on the root export', () => {
    const root = rootApi as Record<string, unknown>;
    const query = queryApi as Record<string, unknown>;

    for (const name of [
      'top',
      'bottom',
      'topBy',
      'bottomBy',
      'setConcat',
      'countDistinct',
      'notAny',
      'env',
      'sel',
      'sel1'
    ]) {
      expect(root[name]).toBe(query[name]);
    }
  });

  it('keeps runtime change-tracking helpers on the root export', () => {
    const root = rootApi as Record<string, unknown>;
    const runtime = runtimeApi as Record<string, unknown>;

    for (const name of [
      'trackRuntimeCommit',
      'trackTransact',
      'UnsupportedChangeTrackingError'
    ]) {
      expect(root[name]).toBe(runtime[name]);
    }
  });

  it('keeps materialization lifecycle helpers on the root export', () => {
    const root = rootApi as Record<string, unknown>;
    const materialization = materializationApi as Record<string, unknown>;

    for (const name of [
      'demat',
      'explainMaterialization',
      'index',
      'isMaterialized',
      'maintainMaterializationSnapshots',
      'maintainMaterializations',
      'mat',
      'materializationForQuery',
      'materializationsFor',
      'materializedRelationFor',
      'materializedRelationForQuery',
      'materializedRowsFor',
      'materializedRowsForQuery',
      'materializedSourceFor',
      'readMaterializedQuery'
    ]) {
      expect(root[name]).toBe(materialization[name]);
    }
  });

  it('keeps watch helpers on the root export', () => {
    const root = rootApi as Record<string, unknown>;
    const watch = watchApi as Record<string, unknown>;

    for (const name of [
      'attachWatches',
      'diffOptionsForTarget',
      'diffQuery',
      'isWatchMaterialization',
      'subscribeWatch',
      'trackedChangeFromMaterializationChange',
      'trackedChangesForDbTransition',
      'transferWatches',
      'unwatch',
      'unwatchTarget',
      'watch',
      'watchChangeKeyMap',
      'watchChangeMap',
      'watchRuntime',
      'watchTarget',
      'watchTargetKey'
    ]) {
      expect(root[name]).toBe(watch[name]);
    }
  });

  it('keeps Relic-shaped write variants on the root export', () => {
    const root = rootApi as Record<string, unknown>;
    const write = writeApi as Record<string, unknown>;

    for (const name of [
      'insertIgnore',
      'insertOrReplace',
      'insertOrMerge',
      'insertOrUpdate',
      'update',
      'deleteExact',
      'replaceAll'
    ]) {
      expect(root[name]).toBe(write[name]);
    }
  });
});
