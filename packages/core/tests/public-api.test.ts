import { describe, expect, it } from 'vitest';
import * as core from '@tarstate/core';
import * as adapter from '@tarstate/core/adapter';
import * as db from '@tarstate/core/db';
import * as evaluateModule from '@tarstate/core/evaluate';
import * as memoryRuntime from '@tarstate/core/memory-runtime';
import * as query from '@tarstate/core/query';
import * as schema from '@tarstate/core/schema';
import * as source from '@tarstate/core/source';
import * as store from '@tarstate/core/store';
import * as write from '@tarstate/core/write';
import * as constraints from '@tarstate/core/experimental/constraints';
import * as diff from '@tarstate/core/experimental/diff';
import * as indexedSourceModule from '@tarstate/core/experimental/indexed-source';
import * as materialization from '@tarstate/core/experimental/materialization';
import * as runtime from '@tarstate/core/experimental/runtime';
import * as watch from '@tarstate/core/experimental/watch';
import * as writeApply from '@tarstate/core/experimental/write-apply';
import { coreSchema } from './fixtures';

describe('public API surface', () => {
  it('exports the finalized root constructors', () => {
    expect(core).toMatchObject({
      createDb: expect.any(Function),
      createStore: expect.any(Function),
      evaluate: expect.any(Function),
      fromObjectSource: expect.any(Function),
      from: expect.any(Function),
      project: expect.any(Function),
      insert: expect.any(Function),
      createMemoryRelationRuntime: expect.any(Function)
    });
  });

  it('keeps public subpaths importable', () => {
    expect([
      adapter.isRelationRuntime,
      db.tryTransact,
      evaluateModule.evaluate,
      memoryRuntime.createMemoryRelationRuntime,
      query.from,
      schema.defineSchema,
      source.composeSources,
      store.createStore,
      write.write,
      constraints.validateConstraints,
      diff.diffRows,
      indexedSourceModule.fromIndexedObjectSource,
      materialization.materializeSnapshot,
      runtime.trackRuntimeCommit,
      watch.diffQuery,
      writeApply.applyWrites
    ]).toEqual(Array.from({ length: 16 }, () => expect.any(Function)));
  });

  it('constructs canonical relation and field metadata', () => {
    expect(coreSchema.users).toMatchObject({
      kind: 'relation',
      name: 'users',
      key: 'id',
      ephemeral: false,
      fields: {
        id: { kind: 'field', valueKind: 'id', idDomain: 'user' },
        teamId: { kind: 'field', valueKind: 'ref', ref: 'teams.id' },
        active: { kind: 'field', valueKind: 'boolean' }
      }
    });
  });

  it('constructs canonical query and write shapes', () => {
    const user = core.as(coreSchema.users, 'user');
    const queryValue = core.pipe(
      core.from(user),
      core.where(core.eq(user.active, true)),
      core.project({ id: user.id, name: user.name })
    );
    const patch = core.write(coreSchema.users).insert({
      id: 'dia',
      teamId: 'eng',
      name: 'Dia',
      active: true,
      age: 24,
      tags: []
    });

    expect(queryValue.data).toMatchObject({
      op: 'select',
      input: { op: 'where', input: { op: 'from', relation: 'users', alias: 'user' } }
    });
    expect(patch).toMatchObject({
      op: 'insert',
      relation: coreSchema.users,
      row: { id: 'dia', name: 'Dia' }
    });
  });
});
