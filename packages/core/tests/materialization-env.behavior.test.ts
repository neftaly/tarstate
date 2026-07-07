import { describe, expect, it } from 'vitest';
import { createDb, q, setEnvTx, transact, tryTransact } from '@tarstate/core/db';
import { mat } from '@tarstate/core/materialization';
import { asc, env, eq, from, pipe, project, sort, value, where } from '@tarstate/core/query';
import { entry, makeDb } from './behavior-fixtures.js';

describe('materialization env behavior', () => {
  it('refreshes materialized query rows when dependent env values change', () => {
    const envFilteredEntries = pipe(
      from(entry),
      where(eq(entry.row.accountId, env<string>('accountId'))),
      sort(asc(entry.row.id)),
      project({
        id: entry.row.id,
        accountId: entry.row.accountId
      })
    );
    const db = mat(createDb(makeDb().data, { env: { accountId: 'cash' } }), envFilteredEntries);
    const first = q(db, envFilteredEntries);

    expect(first).toEqual([
      { id: 'e1', accountId: 'cash' },
      { id: 'e4', accountId: 'cash' }
    ]);

    const next = transact(db, setEnvTx({ accountId: 'sales' }));
    const changed = q(next, envFilteredEntries);

    expect(changed).not.toBe(first);
    expect(changed).toEqual([
      { id: 'e2', accountId: 'sales' }
    ]);
  });

  it('refreshes materialized query rows when dependent non-plain env values are replaced with same-shape values', () => {
    class EnvMarker {
      constructor(readonly label: string) {}
    }

    const envProjectedEntry = pipe(
      from(entry),
      where(eq(entry.row.id, value('e1'))),
      project({
        id: entry.row.id,
        stamp: env<Date>('stamp'),
        marker: env<EnvMarker>('marker')
      })
    );
    const firstStamp = new Date('2026-01-01T00:00:00.000Z');
    const firstMarker = new EnvMarker('same-shape');
    const db = mat(createDb(makeDb().data, { env: { stamp: firstStamp, marker: firstMarker } }), envProjectedEntry);
    const first = q(db, envProjectedEntry);

    const nextStamp = new Date('2026-01-01T00:00:00.000Z');
    const nextMarker = new EnvMarker('same-shape');
    const result = tryTransact(db, setEnvTx({ stamp: nextStamp, marker: nextMarker }));
    const changed = q(result.db, envProjectedEntry);

    expect(result.committed).toBe(true);
    expect(result.materializations?.changes[0]).toEqual(expect.objectContaining({
      update: 'recomputed',
      recomputed: true,
      touchedEnvDependencies: ['stamp', 'marker']
    }));
    expect(changed).not.toBe(first);
    expect(changed).toHaveLength(1);
    expect(changed[0]).toEqual(expect.objectContaining({ id: 'e1' }));
    expect((changed[0] as { readonly stamp: Date }).stamp).toBe(nextStamp);
    expect((changed[0] as { readonly marker: EnvMarker }).marker).toBe(nextMarker);
    expect((changed[0] as { readonly stamp: Date }).stamp).not.toBe(firstStamp);
    expect((changed[0] as { readonly marker: EnvMarker }).marker).not.toBe(firstMarker);
  });

  it('does not throw when setEnvTx touches another key while env contains a cyclic object', () => {
    const envFilteredEntries = pipe(
      from(entry),
      where(eq(entry.row.accountId, env<string>('accountId'))),
      sort(asc(entry.row.id)),
      project({
        id: entry.row.id,
        accountId: entry.row.accountId
      })
    );
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const db = mat(createDb(makeDb().data, { env: { accountId: 'cash', cyclic } }), envFilteredEntries);

    const result = tryTransact(db, setEnvTx((envValue) => ({ ...envValue, accountId: 'sales' })));
    const changed = q(result.db, envFilteredEntries);

    expect(result.committed).toBe(true);
    expect(result.materializations?.changes[0]).toEqual(expect.objectContaining({
      update: 'recomputed',
      recomputed: true,
      touchedEnvDependencies: ['accountId']
    }));
    expect(changed).toEqual([
      { id: 'e2', accountId: 'sales' }
    ]);
  });

  it('refreshes materialized query rows when setEnvTx mutates env in place', () => {
    const envFilteredEntries = pipe(
      from(entry),
      where(eq(entry.row.accountId, env<string>('accountId'))),
      sort(asc(entry.row.id)),
      project({
        id: entry.row.id,
        accountId: entry.row.accountId
      })
    );
    const db = mat(createDb(makeDb().data, { env: { accountId: 'cash' } }), envFilteredEntries);
    const first = q(db, envFilteredEntries);

    const result = tryTransact(db, setEnvTx((envValue) => {
      // @ts-expect-error mutating readonly env verifies runtime change detection for updater callbacks.
      envValue.accountId = 'sales';
      return envValue;
    }));
    const changed = q(result.db, envFilteredEntries);

    expect(first).toEqual([
      { id: 'e1', accountId: 'cash' },
      { id: 'e4', accountId: 'cash' }
    ]);
    expect(result.committed).toBe(true);
    expect(result.materializations?.changes[0]).toEqual(expect.objectContaining({
      update: 'recomputed',
      recomputed: true,
      touchedEnvDependencies: ['accountId'],
      rows: [
        { id: 'e2', accountId: 'sales' }
      ],
      diagnostics: expect.arrayContaining([
        expect.objectContaining({
          code: 'materialization_unsupported',
          message: 'env dependency changed: accountId'
        })
      ])
    }));
    expect(changed).not.toBe(first);
    expect(changed).toEqual([
      { id: 'e2', accountId: 'sales' }
    ]);
  });

  it('refreshes materialized query rows when setEnvTx mutates Map and Set env internals in place', () => {
    const envProjectedEntry = pipe(
      from(entry),
      where(eq(entry.row.id, value('e1'))),
      project({
        id: entry.row.id,
        routing: env<Map<string, string>>('routing'),
        flags: env<Set<string>>('flags')
      })
    );
    const routing = new Map([['accountId', 'cash']]);
    const flags = new Set(['posted']);
    const db = mat(createDb(makeDb().data, { env: { routing, flags } }), envProjectedEntry);
    const first = q(db, envProjectedEntry);

    expect((first[0] as { readonly routing: Map<string, string> }).routing.get('accountId')).toBe('cash');
    expect((first[0] as { readonly flags: Set<string> }).flags.has('reviewed')).toBe(false);

    const result = tryTransact(db, setEnvTx((envValue) => {
      (envValue.routing as Map<string, string>).set('accountId', 'sales');
      (envValue.flags as Set<string>).add('reviewed');
      return envValue;
    }));
    const changed = q(result.db, envProjectedEntry);
    const changedRow = changed[0] as { readonly routing: Map<string, string>; readonly flags: Set<string> };

    expect(result.committed).toBe(true);
    expect(result.materializations?.changes[0]).toEqual(expect.objectContaining({
      update: 'recomputed',
      recomputed: true,
      touchedEnvDependencies: ['routing', 'flags'],
      diagnostics: expect.arrayContaining([
        expect.objectContaining({
          code: 'materialization_unsupported',
          message: 'env dependency changed: routing, flags'
        })
      ])
    }));
    expect(changed).not.toBe(first);
    expect(changedRow.routing).toBe(routing);
    expect(changedRow.flags).toBe(flags);
    expect(changedRow.routing.get('accountId')).toBe('sales');
    expect(changedRow.flags.has('reviewed')).toBe(true);
  });

});
