import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as core from '@tarstate/core';
import * as adapterExports from '@tarstate/core/adapter';
import * as constraintsExports from '@tarstate/core/constraints';
import type { ConstraintData } from '@tarstate/core/constraints';
import * as dbExports from '@tarstate/core/db';
import * as diagnosticsExports from '@tarstate/core/diagnostics';
import * as diffExports from '@tarstate/core/diff';
import * as evaluateExports from '@tarstate/core/evaluate';
import * as indexedSourceExports from '@tarstate/core/indexed-source';
import * as materializationExports from '@tarstate/core/materialization';
import type { MaterializationMetadata } from '@tarstate/core/materialization';
import * as memoryRuntimeExports from '@tarstate/core/memory-runtime';
import * as queryExports from '@tarstate/core/query';
import * as runtimeExports from '@tarstate/core/runtime';
import type { TrackTransactResult } from '@tarstate/core/runtime';
import * as schemaExports from '@tarstate/core/schema';
import * as sourceExports from '@tarstate/core/source';
import * as storeExports from '@tarstate/core/store';
import * as watchExports from '@tarstate/core/watch';
import type { WatchEvent } from '@tarstate/core/watch';
import * as writeExports from '@tarstate/core/write';

type CorePackageJson = {
  readonly exports: Readonly<Record<string, string>>;
};

const packageJson = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8')
) as CorePackageJson;
const packageRequire = createRequire(import.meta.url);

type DeltaExports = typeof import('../src/delta.js');

async function importCoreExport<Module extends object = object>(subpath: string): Promise<Module> {
  const specifier = subpath === '.' ? '@tarstate/core' : `@tarstate/core/${subpath.slice(2)}`;
  const resolved = packageRequire.resolve(specifier);

  return await import(pathToFileURL(resolved).href) as Module;
}

type Item = {
  readonly id: string;
  readonly label: string;
};

type ItemProjection = {
  readonly id: string;
  readonly label: string;
};

const schema = core.defineSchema({
  items: core.relation<Item>({
    key: 'id',
    fields: {
      id: core.idField('item'),
      label: core.stringField()
    }
  })
});

const item = schema.items;

describe('public core exports', () => {
  it('imports every package export subpath', async () => {
    const modules = Object.fromEntries(
      await Promise.all(Object.keys(packageJson.exports).map(async (subpath) => [
        subpath,
        await importCoreExport(subpath)
      ]))
    ) as Readonly<Record<string, object>>;

    expect(Object.keys(modules).sort()).toEqual(Object.keys(packageJson.exports).sort());

    for (const [subpath, module] of Object.entries(modules)) {
      expect(Object.keys(module).length, subpath).toBeGreaterThan(0);
    }
  });

  it('loads stable root and subpath APIs', async () => {
    const deltaExports = await importCoreExport<DeltaExports>('./delta');
    const itemRow = core.as(item, 'item');
    const query: core.Query<ItemProjection> = core.pipe(
      core.from(itemRow),
      core.project({
        id: itemRow.id,
        label: itemRow.label
      })
    );
    const source = core.fromIndexedObjectSource({ items: [{ id: 'a', label: 'Alpha' }] });
    const evaluated = await evaluateExports.evaluate(source, query);
    const db = materializationExports.mat(dbExports.createDb({ items: evaluated.rows }), query);
    const metadata: MaterializationMetadata<ItemProjection> | undefined =
      materializationExports.materializationForQuery(db, query);
    const watched = watchExports.watch(db, query);
    const tracked: TrackTransactResult = await runtimeExports.trackTransact(
      watched,
      writeExports.insert(item, { id: 'b', label: 'Beta' })
    );
    const events: WatchEvent<ItemProjection>[] = [];
    const handle = watchExports.watch(db, query, (event) => {
      events.push(event);
    });
    const memoryRuntime = memoryRuntimeExports.createMemoryRelationRuntime({ items: [] });
    const store = storeExports.createStore({ items: [{ id: 'a', label: 'Alpha' }] });
    const deltas = deltaExports.relationDeltas([{
      relation: item,
      added: [{ id: 'c', label: 'Gamma' }],
      removed: []
    }]);
    const collectedDiagnostics = await diagnosticsExports.collectDiagnostics({
      diagnostics: () => [diagnosticsExports.diagnostic({ code: 'test', message: 'test diagnostic' })]
    });

    const requiredConstraint: ConstraintData = constraintsExports.req(item, 'label');

    expect(requiredConstraint).toMatchObject({ op: 'req' });
    expect(sourceExports.isRelationSource(source)).toBe(true);
    expect(schemaExports.defineSchema).toBe(core.defineSchema);
    expect(adapterExports.isRelationRuntime(memoryRuntime)).toBe(true);
    expect(diffExports.diffRows([{ id: 'a' }], [{ id: 'b' }]).changes).toHaveLength(2);
    expect(diffExports.rowDiffKey({ id: 'a' }, { keyBy: ['id'] })).toBe(core.rowDiffKey({ id: 'a' }, { keyBy: ['id'] }));
    expect(writeExports.deleteRows(item, queryExports.eq(itemRow.id, 'a'))).toMatchObject({ op: 'delete' });
    expect(core.pipe(core.from(itemRow), core.aggregate({ aggregates: { total: core.count() } })).data)
      .toMatchObject({ op: 'aggregate' });
    expect(typeof core.maxBy).toBe('function');
    expect(typeof core.minBy).toBe('function');
    expect(core.diagnostic({ code: 'root', message: 'root diagnostic' })).toMatchObject({ code: 'root' });
    expect(core.normalizeDiagnostics('fallback detail', { code: 'fallback', message: 'fallback' })[0])
      .toMatchObject({ code: 'fallback', message: 'fallback detail' });
    await expect(core.collectDiagnostics({ diagnostics: () => collectedDiagnostics })).resolves.toHaveLength(1);
    expect(core.fromIndexedObjectSource).toBe(indexedSourceExports.fromIndexedObjectSource);
    expect(core.diffRows).toBe(diffExports.diffRows);
    expect(core.rowDiffKey).toBe(diffExports.rowDiffKey);
    expect(core.relationDeltas).toBe(deltaExports.relationDeltas);
    expect(core.createRuntimeStore).toBe(storeExports.createRuntimeStore);
    expect(deltaExports.relationDeltaNames(deltas).has('items')).toBe(true);
    expect(evaluated.rows).toEqual([{ id: 'a', label: 'Alpha' }]);
    expect(metadata?.kind).toBe('materialization');
    expect(handle.kind).toBe('watch');
    expect(events).toHaveLength(0);
    expect(handle.unwatch()).toMatchObject({ kind: 'unwatch', closed: true });
    expect(tracked).toMatchObject({ kind: 'trackTransact' });
    expect(tracked.changes.at(0)).toMatchObject({ kind: 'trackedChange' });
    await expect(store.query(query)).resolves.toMatchObject({ rows: [{ id: 'a', label: 'Alpha' }] });
  });

  it('does not expose removed runtime stubs', () => {
    expect('trackTransactPatches' in runtimeExports).toBe(false);
    expect('trackTransactPatches' in core).toBe(false);
  });
});
