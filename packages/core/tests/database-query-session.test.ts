import { describe, expect, expectTypeOf, it, vi } from 'vitest';
import {
  type AttachmentCatalog,
  type ObservableSource,
  type SourceSnapshot
} from '../src/database/index.js';
import {
  openDatabaseQuery,
  type MountableDatabaseSource
} from '../src/database/query-session.js';
import {
  prepareTypedQuery,
  prepareQuery,
  typedFrom,
  typedSelect,
  type RelationInput
} from '../src/query/index.js';
import { prepareManualReadOnlyAttachment } from '../src/attachment/preparation.js';
import { relationLiteral, sealSchema } from '../src/schema/index.js';

describe('database query session', () => {
  it('rejects an invalid authority scope before mounting sources', async () => {
    const mount = vi.fn();
    const plan = await prepareQuery({
      root: { kind: 'values', alias: 'row', rows: [] },
      registryFingerprint: 'registry:test',
      authorityFingerprint: 'authority:test',
      datasetId: 'dataset:test'
    });

    await expect(openDatabaseQuery({
      sources: [{ source: { mount } }],
      plan,
      queryAuthorityScope: ''
    })).rejects.toThrow('queryAuthorityScope must be a non-empty string');
    expect(mount).not.toHaveBeenCalled();
  });

  it('preserves required unresolved sources as incomplete evidence without fetching them', async () => {
    const plan = await prepareQuery({
      root: { kind: 'values', alias: 'row', rows: [] },
      registryFingerprint: 'registry:test',
      authorityFingerprint: 'authority:test',
      datasetId: 'dataset:test'
    });
    const session = await openDatabaseQuery({
      sources: [{
        unresolved: {
          attachmentId: 'attachment:remote-file',
          sourceId: 'https://example.test/file.json'
        },
        expectation: 'required',
        discoveryEdges: ['resource:https://example.test/file.json']
      }],
      plan,
      queryAuthorityScope: 'scope:test'
    });

    expect(session.getSnapshot()).toMatchObject({
      state: 'open',
      current: {
        readiness: 'incomplete',
        completeness: 'unknown',
        sourceStates: [{
          attachmentId: 'attachment:remote-file',
          sourceId: 'https://example.test/file.json',
          expectation: 'required',
          state: 'missing',
          discoveryEdges: ['resource:https://example.test/file.json']
        }]
      }
    });
    session.close();
  });

  it('owns mounting, typed observation, and idempotent reverse cleanup', async () => {
    const schema = await sealSchema({ body: { relations: { items: {
      relationId: 'test.item',
      key: ['id'],
      fields: {
        id: { type: { kind: 'string' } },
        score: { type: { kind: 'number' } }
      }
    } } } });
    const items = relationLiteral(schema, 'items');
    const itemQuery = typedFrom(items, 'item');
    const plan = await prepareTypedQuery(
      typedSelect(itemQuery, 'result', ({ item }) => ({
        id: item.row.id,
        score: item.row.score
      })),
      {
        registryFingerprint: 'registry:test',
        authorityFingerprint: 'authority:test',
        datasetId: 'dataset:test'
      }
    );
    const rows = [{ id: 'one', score: 1 }] as const;
    const sourceId = 'source:test';
    const source: ObservableSource<typeof rows> = {
      sourceId,
      snapshot: (): SourceSnapshot<typeof rows> => ({
        sourceId,
        operationEpoch: 'epoch:test',
        basis: { incarnation: 'source:test:one', revision: 0 },
        state: 'ready',
        freshness: 'current',
        storage: rows,
        issues: []
      }),
      subscribe: () => () => undefined
    };
    let mountedCatalog: AttachmentCatalog | undefined;
    const closeLease = vi.fn();
    const sourceView: MountableDatabaseSource = {
      mount: (catalog, options = {}) => {
        mountedCatalog = catalog;
        const discoveryEdges = Object.freeze([...(options.discoveryEdges ?? [])]);
        const lease = catalog.attach({
          attachmentId: 'attachment:test',
          incarnation: 'attachment:test:one',
          sourceId,
          source,
          authorityScope: 'scope:test',
          discoveryEdges,
          preparation: prepareManualReadOnlyAttachment<typeof rows, readonly RelationInput[]>({
            schemaViewIds: [schema.id],
            project: (snapshot) => ({
              state: 'ready',
              value: [{
                relation: { schemaView: items.schemaView, relationId: items.relationId },
                rows: snapshot.storage ?? [],
                occurrenceIds: (snapshot.storage ?? []).map(({ id }) => id),
                completeness: 'exact',
                sourceId,
                attachmentId: 'attachment:test',
                basis: snapshot.basis
              }],
              issues: []
            })
          })
        });
        return {
          attachmentId: 'attachment:test',
          sourceId,
          discoveryEdges,
          close: () => {
            closeLease();
            lease.close();
          }
        };
      }
    };

    const session = await openDatabaseQuery({
      sources: [{ source: sourceView, discoveryEdges: ['test'] }],
      plan,
      queryAuthorityScope: 'scope:test'
    });
    const snapshot = session.getSnapshot();
    if (snapshot.state !== 'open') throw new Error('expected open session');
    expectTypeOf(snapshot.current.rows).toEqualTypeOf<readonly { readonly id: string; readonly score: number }[]>();
    expect(snapshot.current).toMatchObject({
      readiness: 'ready',
      completeness: 'exact',
      rows
    });
    expect(mountedCatalog?.list()).toHaveLength(1);

    session.close();
    session.close();

    expect(session.getSnapshot()).toEqual({ state: 'closed' });
    expect(closeLease).toHaveBeenCalledOnce();
    expect(mountedCatalog?.list()).toHaveLength(0);
  });

  it('releases earlier mounts when a later mount fails', async () => {
    const close = vi.fn();
    const source: ObservableSource<readonly never[]> = {
      sourceId: 'source:first',
      snapshot: () => ({
        sourceId: 'source:first',
        operationEpoch: 'epoch:first',
        basis: { incarnation: 'source:first:one', revision: 0 },
        state: 'ready',
        freshness: 'current',
        storage: [],
        issues: []
      }),
      subscribe: () => () => undefined
    };
    const first: MountableDatabaseSource = {
      mount: (catalog) => {
        const lease = catalog.attach({
          attachmentId: 'attachment:first',
          incarnation: 'attachment:first:one',
          sourceId: source.sourceId,
          source,
          authorityScope: 'scope:test',
          discoveryEdges: [],
          preparation: prepareManualReadOnlyAttachment({
            schemaViewIds: [],
            project: () => ({ state: 'ready', value: [], issues: [] })
          })
        });
        return {
          attachmentId: 'attachment:first',
          sourceId: source.sourceId,
          discoveryEdges: [],
          close: () => {
            close();
            lease.close();
          }
        };
      }
    };
    const second: MountableDatabaseSource = {
      mount: () => { throw new Error('mount failed'); }
    };
    const plan = await prepareQuery({
      root: { kind: 'values', alias: 'row', rows: [] },
      registryFingerprint: 'registry:test',
      authorityFingerprint: 'authority:test',
      datasetId: 'dataset:test'
    });

    await expect(openDatabaseQuery({
      sources: [
        { source: first, expectation: 'required' },
        { source: second, expectation: 'required' }
      ],
      plan,
      queryAuthorityScope: 'scope:test',
      canRead: () => true
    })).rejects.toThrow('mount failed');
    expect(close).toHaveBeenCalledOnce();
  });
});
