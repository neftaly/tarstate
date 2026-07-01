import { describe, expect, it } from 'vitest';
import type { TarstateDiagnostic } from '@tarstate/core/diagnostics';
import { evaluate } from '@tarstate/core/evaluate';
import { as, eq, from, leftJoin, maybe, pipe, project } from '@tarstate/core/query';
import {
  anchoredPathField,
  defineSchema,
  idField,
  optional,
  refField,
  relation,
  stringField
} from '@tarstate/core/schema';
import {
  composeSources,
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
      message: 'object is not readable',
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
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        code: 'unreadable_ref',
        relation: 'objects',
        key: 'document:secret'
      })
    ]);
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
      {
        relationNames: ['objects'],
        rows: () => [{ id: 'object-a', kind: 'file', title: 'Alpha' }],
        lookup: ({ value }) => (value === 'object-a' ? [{ id: 'object-a', kind: 'file', title: 'Alpha' }] : [])
      },
      fromObjectSource({
        objects: [{ id: 'object-b', kind: 'file', title: 'Beta' }]
      })
    );

    expect(await source.lookup?.({ relation: schema.objects, field: 'id', value: 'object-a' })).toBeUndefined();
  });

  it('does not answer composed lookup when a relevant source returns unsupported lookup', async () => {
    const source = composeSources(
      {
        relationNames: ['objects'],
        rows: () => [{ id: 'object-a', kind: 'file', title: 'Alpha' }],
        lookup: ({ value }) => (value === 'object-a' ? [{ id: 'object-a', kind: 'file', title: 'Alpha' }] : [])
      },
      {
        relationNames: ['objects'],
        rows: () => [{ id: 'object-b', kind: 'file', title: 'Beta' }],
        lookup: () => undefined
      }
    );

    expect(await source.lookup?.({ relation: schema.objects, field: 'id', value: 'object-a' })).toBeUndefined();
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
    const presenceSource = fromObjectSource(presenceData);
    const source = composeSources(objectSource, presenceSource);

    const objectVersion = await objectSource.version?.();
    const presenceVersion = await presenceSource.version?.();

    expect(objectVersion).toBeDefined();
    expect(presenceVersion).toBeDefined();
    expect(await objectSource.version?.()).toBe(objectVersion);
    expect(await presenceSource.version?.()).toBe(presenceVersion);
    const composedVersion = await source.version?.();
    expect(composedVersion).toBeDefined();
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
