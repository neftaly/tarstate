import { describe, expect, it } from 'vitest';
import { evaluate } from '@tarstate/core/evaluate';
import {
  aggregate,
  as,
  avg,
  btree,
  call,
  constRows,
  count,
  dependencies,
  eq,
  env,
  expand,
  field,
  from,
  hash,
  keyBy,
  leftJoin,
  lookup,
  maybe,
  pipe,
  project,
  queryKey,
  queryRowKeyFields,
  relationDependencies,
  rename,
  rowKeyFields,
  sel,
  sel1,
  where,
  without
} from '@tarstate/core/query';
import {
  anchoredPathField,
  defineSchema,
  idField,
  optional,
  refField,
  relation,
  stringField
} from '@tarstate/core/schema';
import { fromObjectSource } from '@tarstate/core/source';

const schema = defineSchema({
  objects: relation<{
    id: string;
    kind: string;
    title: string;
  }>({
    key: 'id',
    fields: {
      id: idField('object'),
      kind: stringField(),
      title: stringField()
    }
  }),
  presence: relation<{
    workspaceId: string;
    peerId: string;
    clientId: string;
    targetObjectId?: string;
    focusPath?: readonly unknown[];
  }>({
    ephemeral: true,
    key: ['workspaceId', 'peerId', 'clientId'],
    fields: {
      workspaceId: idField('workspace'),
      peerId: idField('peer'),
      clientId: stringField(),
      targetObjectId: optional(refField('objects.id')),
      focusPath: optional(anchoredPathField())
    }
  })
});

const object = as(schema.objects, 'object');
const presence = as(schema.presence, 'presence');

describe('tarstate query DSL', () => {
  it('builds composable relation queries that evaluate through joins and projections', async () => {
    const focusedObjects = pipe(
      from(object),
      leftJoin(from(presence), eq(object.id, presence.targetObjectId)),
      project({
        id: object.id,
        title: object.title,
        focusedBy: maybe(presence.peerId)
      })
    );

    await expect(
      evaluate(
        fromObjectSource({
          objects: [
            { id: 'object-a', kind: 'file', title: 'Alpha' },
            { id: 'object-b', kind: 'file', title: 'Beta' }
          ],
          presence: [
            { workspaceId: 'workspace-a', peerId: 'peer-a', clientId: 'client-a', targetObjectId: 'object-a' }
          ]
        }),
        focusedObjects
      )
    ).resolves.toEqual({
      rows: [
        { id: 'object-a', title: 'Alpha', focusedBy: 'peer-a' },
        { id: 'object-b', title: 'Beta', focusedBy: undefined }
      ],
      diagnostics: []
    });
  });

  it('supports pipe, lookup, and index-declaration helpers without changing result rows', async () => {
    const filesByKind = pipe(
      from(object),
      hash(object.kind),
      btree(object.title),
      where(eq(object.kind, 'file')),
      project({ id: object.id, title: object.title })
    );
    const objectById = pipe(
      lookup(object, 'id', 'object-a'),
      project({ id: object.id, title: object.title })
    );
    const source = fromObjectSource({
      objects: [
        { id: 'object-a', kind: 'file', title: 'Alpha' },
        { id: 'object-b', kind: 'folder', title: 'Beta' }
      ]
    });

    await expect(evaluate(source, filesByKind)).resolves.toMatchObject({
      rows: [{ id: 'object-a', title: 'Alpha' }],
      diagnostics: []
    });
    await expect(evaluate(source, objectById)).resolves.toMatchObject({
      rows: [{ id: 'object-a', title: 'Alpha' }],
      diagnostics: []
    });
  });

  it('keeps structural query keys stable across equivalent values', () => {
    const first = constRows([{ b: 2, a: 1, missing: undefined }]);
    const second = constRows([{ missing: undefined, a: 1, b: 2 }]);
    const different = constRows([{ a: 1, b: 3, missing: undefined }]);

    expect(queryKey(first)).toBe(queryKey(second));
    expect(queryKey(first)).not.toBe(queryKey(different));
  });

  it('carries query-owned row identity only through compatible final row shapes', () => {
    const keyedObjects = pipe(
      from(object),
      project({
        id: object.id,
        title: object.title
      }),
      keyBy('id')
    );

    expect(queryRowKeyFields(keyedObjects)).toEqual(['id']);
    expect(rowKeyFields(keyedObjects)).toEqual(['id']);
    expect(queryRowKeyFields(pipe(keyedObjects, where(eq(field('', 'id'), 'object-a'))))).toEqual(['id']);
    expect(queryRowKeyFields(pipe(keyedObjects, project({ title: field('', 'title') })))).toBeUndefined();
    expect(queryRowKeyFields(pipe(keyedObjects, without('id')))).toBeUndefined();
    expect(queryRowKeyFields(pipe(keyedObjects, rename({ id: 'objectId' })))).toEqual(['objectId']);
  });

  it('tracks relation dependencies without asserting query node layout', () => {
    const focusedObjects = pipe(
      from(object),
      leftJoin(from(presence), eq(object.id, presence.targetObjectId)),
      project({
        id: object.id,
        focusedBy: maybe(presence.peerId)
      })
    );

    expect(relationDependencies(focusedObjects)).toEqual(['objects', 'presence']);
    expect(dependencies(focusedObjects)).toEqual(['objects', 'presence']);
    expect(dependencies(constRows([{ id: 'object-a' }]))).toEqual([]);
  });

  it('evaluates expression, aggregate, expand, and subquery helpers', async () => {
    const focusRows = pipe(
      from(presence),
      where(eq(presence.targetObjectId, object.id)),
      project({ peerId: presence.peerId })
    );
    const projected = pipe(
      from(object),
      project({
        id: object.id,
        label: call('label', object.title),
        workspace: env('workspaceId'),
        focusedPeers: sel(focusRows),
        firstFocus: sel1(focusRows)
      })
    );
    const grouped = pipe(
      constRows([
        { kind: 'file', rank: 1 },
        { kind: 'file', rank: 3 },
        { kind: 'folder', rank: 10 }
      ]),
      aggregate({
        groupBy: { kind: field('', 'kind') },
        aggregates: {
          total: count(),
          averageRank: avg(field('', 'rank'))
        }
      })
    );
    const expanded = pipe(
      constRows([{ customerId: 42, items: [{ product: 'sku-a', quantity: 2 }] }]),
      expand(field('', 'items'), { fields: ['product', 'quantity'] as const }),
      without('items')
    );
    const source = fromObjectSource({
      objects: [{ id: 'object-a', kind: 'file', title: 'Alpha' }],
      presence: [
        { workspaceId: 'workspace-a', peerId: 'peer-a', clientId: 'client-a', targetObjectId: 'object-a' }
      ]
    });

    await expect(
      evaluate(source, projected, {
        env: { workspaceId: 'workspace-a' },
        functions: { label: (value) => `object:${String(value)}` }
      })
    ).resolves.toMatchObject({
      rows: [
        {
          id: 'object-a',
          label: 'object:Alpha',
          workspace: 'workspace-a',
          focusedPeers: [{ peerId: 'peer-a' }],
          firstFocus: { peerId: 'peer-a' }
        }
      ],
      diagnostics: []
    });
    await expect(evaluate(fromObjectSource({}), grouped)).resolves.toMatchObject({
      rows: [
        { kind: 'file', total: 2, averageRank: 2 },
        { kind: 'folder', total: 1, averageRank: 10 }
      ],
      diagnostics: []
    });
    await expect(evaluate(fromObjectSource({}), expanded)).resolves.toMatchObject({
      rows: [{ customerId: 42, product: 'sku-a', quantity: 2 }],
      diagnostics: []
    });
  });
});
