import { describe, expect, it } from 'vitest';
import {
  as,
  composeSources,
  evaluate,
  from,
  insert,
  pipe,
  project,
  tryApplyRelationPatches,
  tryCommitAdapter,
  type RelationAdapter,
  type RelationRuntime,
  type RelationSource,
  type TarstateDiagnostic
} from '@tarstate/core';
import { adaUser, beaUser, coreSchema } from './fixtures';

const staleDiagnostic = {
  code: 'invalid_row',
  message: 'stale fixture row',
  relation: 'users',
  key: 'stale'
} satisfies TarstateDiagnostic;

describe('source error propagation contracts', () => {
  it('composes sources without dropping successful rows and records rows/lookup/range/version diagnostics', async () => {
    const goodSource: RelationSource = {
      relationNames: ['users'],
      rows: () => [adaUser],
      lookup: () => [adaUser],
      rangeLookup: () => [adaUser],
      version: () => 'good-v1',
      diagnostics: () => [staleDiagnostic]
    };
    const badSource: RelationSource = {
      relationNames: ['users'],
      rows: () => {
        throw new Error('rows unavailable');
      },
      lookup: () => Promise.reject(new Error('lookup unavailable')),
      rangeLookup: () => {
        throw new Error('range unavailable');
      },
      version: () => Promise.reject(new Error('version unavailable')),
      diagnostics: () => Promise.reject(new Error('diagnostics unavailable'))
    };
    const source = composeSources(goodSource, badSource);

    await expect(source.rows(coreSchema.users)).resolves.toEqual([adaUser]);
    await expect(Promise.resolve(source.lookup?.({
      relation: coreSchema.users,
      field: 'id',
      value: 'ada'
    }))).resolves.toEqual([adaUser]);
    await expect(Promise.resolve(source.rangeLookup?.({
      relation: coreSchema.users,
      field: 'age',
      lower: { value: 30, inclusive: true }
    }))).resolves.toEqual([adaUser]);
    await expect(Promise.resolve(source.version?.())).resolves.toEqual(['good-v1', undefined]);
    await expect(Promise.resolve(source.diagnostics?.())).resolves.toEqual([
      staleDiagnostic,
      expect.objectContaining({ code: 'source_error', message: 'rows unavailable', relation: 'users' }),
      expect.objectContaining({ code: 'source_error', message: 'lookup unavailable', relation: 'users', field: 'id' }),
      expect.objectContaining({ code: 'source_error', message: 'range unavailable', relation: 'users', field: 'age' }),
      expect.objectContaining({ code: 'source_error', message: 'version unavailable' }),
      expect.objectContaining({ code: 'source_error', message: 'diagnostics unavailable' })
    ]);
  });

  it('returns source diagnostics from evaluate instead of rejecting when relation rows fail', async () => {
    const user = as(coreSchema.users, 'user');
    const query = pipe(from(user), project({ id: user.id, name: user.name }));
    const source: RelationSource = {
      relationNames: ['users'],
      rows: () => Promise.reject(new Error('cannot read users')),
      diagnostics: () => [staleDiagnostic]
    };

    await expect(evaluate(source, query)).resolves.toEqual({
      rows: [],
      diagnostics: [
        staleDiagnostic,
        expect.objectContaining({ code: 'source_error', message: 'cannot read users', relation: 'users' })
      ]
    });
  });

  it('surfaces source_error diagnostics from write apply and version read failures', async () => {
    const runtime: RelationRuntime = {
      source: { rows: () => [] },
      target: {
        relationNames: ['users'],
        apply: () => {
          throw new Error('apply failed');
        }
      }
    };
    const adapter: RelationAdapter<string> = {
      source: {
        rows: () => [],
        version: () => {
          throw new Error('version failed');
        }
      },
      commit: () => ({ status: 'accepted', patches: 0, applied: 0, deltas: [], diagnostics: [] })
    };

    await expect(tryApplyRelationPatches(runtime, [insert(coreSchema.users, beaUser)])).resolves.toMatchObject({
      status: 'rejected',
      patches: 1,
      applied: 0,
      deltas: [],
      diagnostics: [
        expect.objectContaining({ code: 'source_error', message: 'apply failed' })
      ]
    });
    await expect(tryCommitAdapter(adapter, [], { readVersion: true })).resolves.toMatchObject({
      status: 'accepted',
      patches: 0,
      applied: 0,
      diagnostics: [
        expect.objectContaining({ code: 'source_error', message: 'version failed' })
      ]
    });
  });
});
