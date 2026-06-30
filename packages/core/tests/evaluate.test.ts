import { describe, expect, it } from 'vitest';
import { evaluate } from '@tarstate/core/evaluate';
import { as, eq, from, leftJoin, maybe, pipe, project, where } from '@tarstate/core/query';
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
  fromIndexedObjectSource,
  fromObjectSource,
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

describe('tarstate evaluator', () => {
  it('keeps durable rows when ephemeral presence is absent', async () => {
    const result = await evaluate(
      fromObjectSource({
        objects: [
          { id: 'object-a', kind: 'file', title: 'Alpha' },
          { id: 'object-b', kind: 'file', title: 'Beta' }
        ],
        presence: []
      }),
      focusedObjects
    );

    expect(result.rows).toEqual([
      { id: 'object-a', title: 'Alpha', focusedBy: undefined },
      { id: 'object-b', title: 'Beta', focusedBy: undefined }
    ]);
    expect(result.diagnostics).toEqual([]);
  });

  it('joins multiple peer presence rows to one durable object', async () => {
    const result = await evaluate(
      fromObjectSource({
        objects: [{ id: 'object-a', kind: 'file', title: 'Alpha' }],
        presence: [
          { workspaceId: 'workspace-a', peerId: 'peer-a', clientId: 'client-a', targetObjectId: 'object-a' },
          { workspaceId: 'workspace-a', peerId: 'peer-b', clientId: 'client-b', targetObjectId: 'object-a' }
        ]
      }),
      focusedObjects
    );

    expect(result.rows).toEqual([
      { id: 'object-a', title: 'Alpha', focusedBy: 'peer-a' },
      { id: 'object-a', title: 'Alpha', focusedBy: 'peer-b' }
    ]);
  });

  it('reports invalid rows and duplicate durable keys without crashing queries', async () => {
    const result = await evaluate(
      fromObjectSource({
        objects: [
          { id: 'object-a', kind: 'file', title: 'Alpha' },
          { id: 'object-a', kind: 'file', title: 'Duplicate' },
          { id: 'object-c', kind: 'file' }
        ],
        presence: [{ workspaceId: 'workspace-a', peerId: 123, clientId: 'client-a', targetObjectId: 'object-a' }]
      }),
      focusedObjects
    );

    expect(result.rows).toEqual([
      { id: 'object-a', title: 'Alpha', focusedBy: undefined },
      { id: 'object-a', title: 'Duplicate', focusedBy: undefined },
      { id: 'object-c', title: undefined, focusedBy: undefined }
    ]);
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      'duplicate_key',
      'invalid_row',
      'invalid_row'
    ]);
  });

  it('uses lookup when available and falls back to scan when lookup is unsupported', async () => {
    const filesByKind = pipe(
      from(object),
      where(eq(object.kind, 'file')),
      project({ id: object.id })
    );

    const data = {
      objects: [
        { id: 'object-a', kind: 'file', title: 'Alpha' },
        { id: 'object-b', kind: 'folder', title: 'Beta' }
      ]
    };

    await expect(evaluate(fromIndexedObjectSource(data), filesByKind)).resolves.toEqual({
      rows: [{ id: 'object-a' }],
      diagnostics: []
    });

    await expect(evaluate(fromObjectSource(data), filesByKind)).resolves.toEqual({
      rows: [{ id: 'object-a' }],
      diagnostics: []
    });
  });

  it('uses lookup for simple equality joins when available', async () => {
    const source: RelationSource = {
      rows: (relationRef) => {
        if (relationRef.name === 'presence') {
          throw new Error('join should use lookup for presence');
        }

        return [{ id: 'object-a', kind: 'file', title: 'Alpha' }];
      },
      lookup: ({ relation: relationRef, field, value }) => {
        if (relationRef.name !== 'presence' || field !== 'targetObjectId' || value !== 'object-a') {
          return undefined;
        }

        return [{ workspaceId: 'workspace-a', peerId: 'peer-a', clientId: 'client-a', targetObjectId: 'object-a' }];
      }
    };

    const result = await evaluate(source, focusedObjects);

    expect(result.rows).toEqual([{ id: 'object-a', title: 'Alpha', focusedBy: 'peer-a' }]);
    expect(result.diagnostics).toEqual([]);
  });

  it('falls back to scan when a composed lookup would be incomplete', async () => {
    const result = await evaluate(
      composeSources(
        fromObjectSource({
          objects: [{ id: 'object-a', kind: 'file', title: 'Alpha' }]
        }),
        fromIndexedObjectSource({
          presence: [{ workspaceId: 'workspace-a', peerId: 'peer-a', clientId: 'client-a', targetObjectId: 'object-a' }]
        }),
        fromObjectSource({
          presence: [{ workspaceId: 'workspace-a', peerId: 'peer-b', clientId: 'client-b', targetObjectId: 'object-a' }]
        })
      ),
      focusedObjects
    );

    expect(result.rows).toEqual([
      { id: 'object-a', title: 'Alpha', focusedBy: 'peer-a' },
      { id: 'object-a', title: 'Alpha', focusedBy: 'peer-b' }
    ]);
    expect(result.diagnostics).toEqual([]);
  });

  it('does not duplicate left diagnostics when a join lookup falls back', async () => {
    const source: RelationSource = {
      rows: (relationRef) =>
        relationRef.name === 'objects'
          ? [
              { id: 'object-a', kind: 'file' },
              { id: 'object-b', kind: 'file', title: 'Beta' }
            ]
          : [],
      lookup: ({ value }) => (value === 'object-a' ? [] : undefined)
    };

    const result = await evaluate(source, focusedObjects);

    expect(result.rows).toEqual([
      { id: 'object-a', title: undefined, focusedBy: undefined },
      { id: 'object-b', title: 'Beta', focusedBy: undefined }
    ]);
    expect(result.diagnostics).toEqual([
      {
        code: 'invalid_row',
        message: 'missing required field title in relation objects',
        relation: 'objects',
        field: 'title'
      }
    ]);
  });

  it('drops invalid ephemeral lookup rows before projection', async () => {
    const peerPresence = pipe(
      from(presence),
      where(eq(presence.peerId, 'peer-a')),
      project({ peerId: presence.peerId })
    );
    const data = {
      presence: [
        { workspaceId: 'workspace-a', peerId: 'peer-a', clientId: 'client-a' },
        { peerId: 'peer-a', clientId: 'client-b' }
      ]
    };

    await expect(evaluate(fromIndexedObjectSource(data), peerPresence)).resolves.toEqual({
      rows: [{ peerId: 'peer-a' }],
      diagnostics: [
        {
          code: 'invalid_row',
          message: 'missing required field workspaceId in relation presence',
          relation: 'presence',
          field: 'workspaceId'
        }
      ]
    });

    await expect(evaluate(fromObjectSource(data), peerPresence)).resolves.toEqual({
      rows: [{ peerId: 'peer-a' }],
      diagnostics: [
        {
          code: 'invalid_row',
          message: 'missing required field workspaceId in relation presence',
          relation: 'presence',
          field: 'workspaceId'
        }
      ]
    });
  });

  it('surfaces lookup errors as diagnostics and falls back to scanning', async () => {
    const filesByKind = pipe(
      from(object),
      where(eq(object.kind, 'file')),
      project({ id: object.id })
    );

    const source: RelationSource = {
      rows: () => [
        { id: 'object-a', kind: 'file', title: 'Alpha' },
        { id: 'object-b', kind: 'folder', title: 'Beta' }
      ],
      lookup: () => {
        throw new Error('index unavailable');
      }
    };

    const result = await evaluate(source, filesByKind);

    expect(result.rows).toEqual([{ id: 'object-a' }]);
    expect(result.diagnostics).toMatchObject([
      {
        code: 'source_error',
        relation: 'objects',
        field: 'kind'
      }
    ]);
  });
});
