import { describe, expect, it } from 'vitest';
import type { TarstateDiagnostic } from '@tarstate/core/diagnostics';
import { evaluate } from '@tarstate/core/evaluate';
import { as, eq, from, leftJoin, maybe, pipe, project } from '@tarstate/core/query';
import {
  anchoredPathField,
  defineSchema,
  idField,
  numberField,
  optional,
  refField,
  relation,
  stringField
} from '@tarstate/core/schema';
import {
  composeSources,
  fromIndexedObjectSource,
  fromObjectSource,
  isRelationSource,
  type RelationSource
} from '@tarstate/core/source';

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
const rangeSchema = defineSchema({
  ranks: relation<{
    id: string;
    rank: number;
  }>({
    key: 'id',
    fields: {
      id: idField('rank'),
      rank: numberField()
    }
  })
});

const focusedObjects = pipe(
  from(object),
  leftJoin(from(presence), eq(object.id, presence.targetObjectId)),
  project({
    id: object.id,
    title: object.title,
    focusedBy: maybe(presence.peerId)
  })
);

describe('tarstate sources', () => {
  it('builds relation sources from object row maps', async () => {
    const source = fromObjectSource({
      objects: [{ id: 'object-a', kind: 'file', title: 'Alpha' }]
    });

    expect(isRelationSource(source)).toBe(true);
    expect(source.relationNames).toEqual(['objects']);
    expect(Array.from(await source.rows(schema.objects))).toEqual([
      { id: 'object-a', kind: 'file', title: 'Alpha' }
    ]);
  });

  it('composes durable rows, ephemeral presence rows, and visibility diagnostics', async () => {
    const unreadableDiagnostic: TarstateDiagnostic = {
      code: 'unreadable_ref',
      message: 'linked Automerge document is unreadable',
      relation: 'objects',
      key: 'document:secret'
    };
    const visibilitySource: RelationSource = {
      rows: () => [],
      diagnostics: () => [unreadableDiagnostic]
    };

    const source = composeSources(
      fromObjectSource({
        objects: [{ id: 'object-a', kind: 'file', title: 'Alpha' }]
      }),
      fromObjectSource({
        presence: [
          {
            workspaceId: 'workspace-a',
            peerId: 'peer-a',
            clientId: 'client-a',
            targetObjectId: 'object-a',
            focusPath: ['object-a']
          }
        ]
      }),
      visibilitySource
    );

    expect(source.relationNames).toBeUndefined();
    expect(source.version).toBeUndefined();

    const result = await evaluate(source, focusedObjects);

    expect(result.rows).toEqual([{ id: 'object-a', title: 'Alpha', focusedBy: 'peer-a' }]);
    expect(result.diagnostics).toEqual([unreadableDiagnostic]);
  });

  it('routes rows and lookups only to sources that declare a matching relation', async () => {
    const objectSource = fromObjectSource({
      objects: [{ id: 'object-a', kind: 'file', title: 'Alpha' }]
    });
    const presenceSource = fromObjectSource({
      presence: [{ workspaceId: 'workspace-a', peerId: 'peer-a', clientId: 'client-a', targetObjectId: 'object-a' }]
    });
    const source = composeSources(objectSource, presenceSource);

    expect(source.relationNames).toEqual(['objects', 'presence']);
    expect(Array.from(await source.rows(schema.objects))).toEqual([
      { id: 'object-a', kind: 'file', title: 'Alpha' }
    ]);
    expect(Array.from(await source.rows(schema.presence))).toEqual([
      { workspaceId: 'workspace-a', peerId: 'peer-a', clientId: 'client-a', targetObjectId: 'object-a' }
    ]);
  });

  it('does not answer composed lookup unless every relevant source can answer it', async () => {
    const source = composeSources(
      fromIndexedObjectSource({
        objects: [{ id: 'object-a', kind: 'file', title: 'Alpha' }]
      }),
      fromObjectSource({
        objects: [{ id: 'object-b', kind: 'file', title: 'Beta' }]
      })
    );

    expect(await source.lookup?.({ relation: schema.objects, field: 'id', value: 'object-a' })).toBeUndefined();
  });

  it('does not answer composed lookup when a relevant source returns unsupported lookup', async () => {
    const source = composeSources(
      fromIndexedObjectSource({
        objects: [{ id: 'object-a', kind: 'file', title: 'Alpha' }]
      }),
      {
        relationNames: ['objects'],
        rows: () => [{ id: 'object-b', kind: 'file', title: 'Beta' }],
        lookup: () => undefined
      }
    );

    expect(await source.lookup?.({ relation: schema.objects, field: 'id', value: 'object-a' })).toBeUndefined();
  });

  it('answers indexed object source range lookups over supported primitive fields', async () => {
    const source = fromIndexedObjectSource({
      objects: [
        { id: 'object-a', kind: 'file', title: 'Alpha' },
        { id: 'object-b', kind: 'file', title: 'Beta' },
        { id: 'object-d', kind: 'file', title: 'Delta' },
        { id: 'object-g', kind: 'file', title: 'Gamma' }
      ]
    });

    const result = await source.rangeLookup?.({
      relation: schema.objects,
      field: 'title',
      lower: { value: 'Beta', inclusive: true },
      upper: { value: 'Gamma', inclusive: false }
    });

    expect(result === undefined ? result : Array.from(result)).toEqual([
      { id: 'object-b', kind: 'file', title: 'Beta' },
      { id: 'object-d', kind: 'file', title: 'Delta' }
    ]);

    const numberSource = fromIndexedObjectSource({
      ranks: [
        { id: 'rank-1', rank: 1 },
        { id: 'rank-2', rank: 2 },
        { id: 'rank-3', rank: 3 },
        { id: 'rank-4', rank: 4 }
      ]
    });
    const numberResult = await numberSource.rangeLookup?.({
      relation: rangeSchema.ranks,
      field: 'rank',
      lower: { value: 2, inclusive: false },
      upper: { value: 4, inclusive: true }
    });

    expect(numberResult === undefined ? numberResult : Array.from(numberResult)).toEqual([
      { id: 'rank-3', rank: 3 },
      { id: 'rank-4', rank: 4 }
    ]);
  });

  it('does not answer indexed object source range lookups for unsupported requests', async () => {
    const source = fromIndexedObjectSource({
      objects: [{ id: 'object-a', kind: 'file', title: 'Alpha' }]
    });
    const unorderableSource = fromIndexedObjectSource({
      objects: [{ id: 'object-a', kind: 'file', title: { text: 'Alpha' } }]
    });

    expect(
      await source.rangeLookup?.({
        relation: schema.objects,
        field: 'title',
        lower: { value: 1, inclusive: true }
      })
    ).toBeUndefined();
    expect(await source.rangeLookup?.({ relation: schema.objects, field: 'title' })).toBeUndefined();
    expect(
      await source.rangeLookup?.({
        relation: schema.objects,
        field: 'missing',
        lower: { value: 'A', inclusive: true }
      })
    ).toBeUndefined();
    expect(
      await unorderableSource.rangeLookup?.({
        relation: schema.objects,
        field: 'title',
        lower: { value: 'A', inclusive: true }
      })
    ).toBeUndefined();
  });

  it('composes range lookups across relevant sources that can answer them', async () => {
    const alphaSource: RelationSource = {
      relationNames: ['objects'],
      rows: () => [{ id: 'object-a', kind: 'file', title: 'Alpha' }],
      rangeLookup: () => [{ id: 'object-a', kind: 'file', title: 'Alpha' }]
    };
    const betaSource: RelationSource = {
      relationNames: ['objects'],
      rows: () => [{ id: 'object-b', kind: 'file', title: 'Beta' }],
      rangeLookup: () => [{ id: 'object-b', kind: 'file', title: 'Beta' }]
    };
    const source = composeSources(alphaSource, betaSource);

    expect(
      await source.rangeLookup?.({
        relation: schema.objects,
        field: 'title',
        lower: { value: 'A', inclusive: true }
      })
    ).toEqual([
      { id: 'object-a', kind: 'file', title: 'Alpha' },
      { id: 'object-b', kind: 'file', title: 'Beta' }
    ]);
  });

  it('does not answer composed range lookup unless every relevant source can answer it', async () => {
    const source = composeSources(
      {
        relationNames: ['objects'],
        rows: () => [{ id: 'object-a', kind: 'file', title: 'Alpha' }],
        rangeLookup: () => [{ id: 'object-a', kind: 'file', title: 'Alpha' }]
      },
      fromObjectSource({
        objects: [{ id: 'object-b', kind: 'file', title: 'Beta' }]
      })
    );

    expect(
      await source.rangeLookup?.({
        relation: schema.objects,
        field: 'title',
        lower: { value: 'A', inclusive: true }
      })
    ).toBeUndefined();
  });

  it('exposes optional opaque source versions', async () => {
    const objectData = {
      objects: [{ id: 'object-a', kind: 'file', title: 'Alpha' }]
    };
    const presenceData = {
      presence: [{ workspaceId: 'workspace-a', peerId: 'peer-a', clientId: 'client-a' }]
    };
    const objectSource = fromObjectSource(objectData);
    const presenceSource = fromIndexedObjectSource(presenceData);
    const source = composeSources(objectSource, presenceSource);

    expect(await objectSource.version?.()).toBe(objectData);
    expect(await presenceSource.version?.()).toBe(presenceData);
    const composedVersion = await source.version?.();
    expect(composedVersion).toEqual([objectData, presenceData]);
    expect(await source.version?.()).toBe(composedVersion);
  });

  it('withholds composed source versions when any child version is unknown', async () => {
    const objectData = {
      objects: [{ id: 'object-a', kind: 'file', title: 'Alpha' }]
    };
    const dynamicPresenceSource: RelationSource = {
      relationNames: ['presence'],
      rows: () => [{ workspaceId: 'workspace-a', peerId: 'peer-a', clientId: 'client-a' }]
    };
    const unknownVersionSource: RelationSource = {
      relationNames: ['presence'],
      rows: () => [],
      version: () => undefined
    };
    const missingVersion = composeSources(fromObjectSource(objectData), dynamicPresenceSource);
    const unknownVersion = composeSources(fromObjectSource(objectData), unknownVersionSource);

    expect(missingVersion.version).toBeUndefined();
    expect(await unknownVersion.version?.()).toBeUndefined();
  });
});
