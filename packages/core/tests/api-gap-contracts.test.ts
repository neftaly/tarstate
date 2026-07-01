import { describe, expect, it } from 'vitest';
import {
  as,
  asc,
  createDb,
  deleteByKey,
  eq,
  from,
  insert,
  pipe,
  project,
  qRows,
  sort,
  tryTransact,
  updateByKey,
  where,
  type RelationSource,
  type TarstateDiagnostic
} from '@tarstate/core';
import * as diagnosticsModule from '@tarstate/core/diagnostics';
import { diffRows } from '@tarstate/core/experimental/diff';
import { stableKey, stableValue } from '@tarstate/core/experimental/identity';
import { relationDeltaNames, relationDeltas } from '@tarstate/core/experimental/delta';
import { applyWritesAtomic } from '@tarstate/core/experimental/write-apply';
import { defineSchema, idField, relation, stringField } from '@tarstate/core/schema';

type MembershipRow = {
  readonly tenantId: string;
  readonly userId: string;
  readonly role: string;
};

type DiagnosticsApi = {
  readonly diagnostic?: (input: TarstateDiagnostic) => TarstateDiagnostic;
  readonly normalizeDiagnostics?: (
    input: unknown,
    fallback: Pick<TarstateDiagnostic, 'code' | 'message' | 'relation' | 'field' | 'key'>
  ) => readonly TarstateDiagnostic[];
  readonly collectDiagnostics?: (...sources: readonly RelationSource[]) => Promise<readonly TarstateDiagnostic[]>;
};

const membershipSchema = defineSchema({
  memberships: relation<MembershipRow>({
    key: ['tenantId', 'userId'],
    fields: {
      tenantId: idField('tenant'),
      userId: idField('user'),
      role: stringField()
    }
  })
});

const adaMember = { tenantId: 'acme', userId: 'ada', role: 'reader' } satisfies MembershipRow;
const beaMember = { tenantId: 'acme', userId: 'bea', role: 'writer' } satisfies MembershipRow;
const adaOwner = { tenantId: 'acme', userId: 'ada', role: 'owner' } satisfies MembershipRow;

describe('core API gap contracts', () => {
  it('exports diagnostics helpers that create, normalize, and collect canonical diagnostics', async () => {
    const diagnosticsApi = diagnosticsModule as DiagnosticsApi;
    const fallback = {
      code: 'source_error',
      message: 'source diagnostics failed',
      relation: 'memberships'
    } satisfies Pick<TarstateDiagnostic, 'code' | 'message' | 'relation'>;
    const duplicate = diagnosticsApi.diagnostic?.({
      code: 'duplicate_key',
      message: 'duplicate composite key',
      relation: 'memberships',
      key: stableKey(['acme', 'ada'])
    });
    const normalized = diagnosticsApi.normalizeDiagnostics?.([
      duplicate,
      new Error('rows failed'),
      'plain failure'
    ], fallback);
    const collected = await diagnosticsApi.collectDiagnostics?.(
      { rows: () => [], diagnostics: () => [duplicate as TarstateDiagnostic] },
      { rows: () => [], diagnostics: () => Promise.reject(new Error('diagnostics failed')) }
    );

    expect(diagnosticsApi).toMatchObject({
      diagnostic: expect.any(Function),
      normalizeDiagnostics: expect.any(Function),
      collectDiagnostics: expect.any(Function)
    });
    expect(normalized).toEqual([
      duplicate,
      expect.objectContaining({ code: 'source_error', message: 'rows failed', relation: 'memberships' }),
      expect.objectContaining({ code: 'source_error', message: 'plain failure', relation: 'memberships' })
    ]);
    expect(collected).toEqual([
      duplicate,
      expect.objectContaining({ code: 'source_error', message: 'diagnostics failed' })
    ]);
  });

  it('keeps stable identity structural, ordered, and collision resistant for composite keys', () => {
    expect(stableValue({ z: undefined, a: ['x', { b: 2, a: 1 }] })).toEqual({
      a: ['x', { a: 1, b: 2 }],
      z: { $tarstate: 'undefined' }
    });

    expect(stableKey({ b: 2, a: 1 })).toBe(stableKey({ a: 1, b: 2 }));
    expect(stableKey(['tenant:id', 'row'])).not.toBe(stableKey(['tenant', 'id:row']));
    expect(stableKey(['acme', undefined])).not.toBe(stableKey(['acme', { $tarstate: 'undefined' }]));
    expect(stableKey(['acme', 'ada'])).not.toBe(stableKey('["acme","ada"]'));
  });

  it('publishes immutable relation deltas and names changed relations', () => {
    const mutableDelta = {
      relation: membershipSchema.memberships,
      added: [adaMember],
      removed: [beaMember]
    };
    const published = relationDeltas(new Map([[membershipSchema.memberships.name, mutableDelta]]));

    mutableDelta.added.push(adaOwner);

    expect(published).toEqual([
      { relation: membershipSchema.memberships, added: [adaMember], removed: [beaMember] }
    ]);
    expect([...relationDeltaNames(published)]).toEqual(['memberships']);
    expect(relationDeltas([])).toEqual([]);
    const firstDelta = published[0];
    expect(firstDelta).toBeDefined();
    if (firstDelta === undefined) {
      throw new Error('expected one published delta');
    }
    expect(() => {
      (firstDelta.added as unknown[]).push(adaOwner);
    }).toThrow(TypeError);
  });

  it('treats empty and no-op write batches as successful commits without deltas', () => {
    const data = { memberships: [adaMember] };
    const empty = applyWritesAtomic(data, []);
    const noOp = applyWritesAtomic(data, updateByKey(membershipSchema.memberships, ['missing', 'none'], {
      role: 'owner'
    }));

    expect(empty).toEqual({ committed: true, patches: 0, applied: 0, deltas: [], diagnostics: [] });
    expect(noOp).toEqual({ committed: true, patches: 1, applied: 0, deltas: [], diagnostics: [] });
    expect(data.memberships).toEqual([adaMember]);
  });

  it('turns composite-key inserts, updates, and deletes into relation deltas', () => {
    const data = { memberships: [adaMember, beaMember] };
    const result = applyWritesAtomic(data, [
      updateByKey(membershipSchema.memberships, ['acme', 'ada'], { role: 'owner' }),
      deleteByKey(membershipSchema.memberships, ['acme', 'bea']),
      insert(membershipSchema.memberships, { tenantId: 'beta', userId: 'cal', role: 'reader' })
    ]);

    expect(result).toMatchObject({ committed: true, patches: 3, applied: 3, diagnostics: [] });
    expect(result.deltas).toEqual([
      {
        relation: membershipSchema.memberships,
        removed: [adaMember, beaMember],
        added: [adaOwner, { tenantId: 'beta', userId: 'cal', role: 'reader' }]
      }
    ]);
    expect(data.memberships).toEqual([
      adaOwner,
      { tenantId: 'beta', userId: 'cal', role: 'reader' }
    ]);
  });

  it('pairs diffRows updates by composite key without colliding on overlapping values', () => {
    const before = [
      adaMember,
      beaMember,
      { tenantId: 'acme:bea', userId: 'reader', role: 'odd' },
      { tenantId: 'acme', userId: 'bea:reader', role: 'other' }
    ] satisfies readonly MembershipRow[];
    const after = [
      adaOwner,
      { tenantId: 'acme', userId: 'cal', role: 'reader' },
      { tenantId: 'acme:bea', userId: 'reader', role: 'odd' },
      { tenantId: 'acme', userId: 'bea:reader', role: 'other' }
    ] satisfies readonly MembershipRow[];

    expect(diffRows(before, after, { keyBy: ['tenantId', 'userId'] })).toEqual({
      changes: [
        { kind: 'updated', key: stableKey(['acme', 'ada']), before: adaMember, after: adaOwner },
        { kind: 'removed', key: stableKey(['acme', 'bea']), row: beaMember },
        {
          kind: 'added',
          key: stableKey(['acme', 'cal']),
          row: { tenantId: 'acme', userId: 'cal', role: 'reader' }
        }
      ],
      diagnostics: []
    });
  });

  it('queries rows after update/delete by composite key through the core db API', async () => {
    const db = createDb({ memberships: [adaMember, beaMember] });
    const result = tryTransact(
      db,
      updateByKey(membershipSchema.memberships, ['acme', 'ada'], { role: 'owner' }),
      deleteByKey(membershipSchema.memberships, ['acme', 'bea'])
    );
    const member = as(membershipSchema.memberships, 'member');
    const query = pipe(
      from(member),
      where(eq(member.tenantId, 'acme')),
      project({ tenantId: member.tenantId, userId: member.userId, role: member.role }),
      sort(asc(member.userId))
    );

    expect(result).toMatchObject({ committed: true, patches: 2, applied: 2, diagnostics: [] });
    await expect(qRows(result.db, query)).resolves.toEqual([
      { tenantId: 'acme', userId: 'ada', role: 'owner' }
    ]);
  });
});
