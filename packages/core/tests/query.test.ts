import { describe, expect, it } from 'vitest';
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
  it('lowers field refs, joins, and projections to inspectable canonical data', () => {
    const focusedObjects = pipe(
      from(object),
      leftJoin(from(presence), eq(object.id, presence.targetObjectId)),
      project({
        id: object.id,
        title: object.title,
        focusedBy: maybe(presence.peerId)
      })
    );

    expect(focusedObjects.data).toEqual({
      op: 'select',
      input: {
        op: 'join',
        kind: 'left',
        left: { op: 'from', relation: 'objects', alias: 'object' },
        right: { op: 'from', relation: 'presence', alias: 'presence' },
        on: {
          op: 'eq',
          left: { op: 'field', alias: 'object', field: 'id' },
          right: { op: 'field', alias: 'presence', field: 'targetObjectId' }
        }
      },
      projection: {
        id: { op: 'field', alias: 'object', field: 'id' },
        title: { op: 'field', alias: 'object', field: 'title' },
        focusedBy: {
          kind: 'optionalProjection',
          expr: { op: 'field', alias: 'presence', field: 'peerId' }
        }
      }
    });
  });

  it('supports variadic functional pipe without chaining', () => {
    const filesByKind = pipe(
      from(object),
      where(eq(object.kind, 'file')),
      project({ id: object.id, title: object.title })
    );

    expect(filesByKind.data).toEqual({
      op: 'select',
      input: {
        op: 'where',
        input: { op: 'from', relation: 'objects', alias: 'object' },
        predicate: {
          op: 'eq',
          left: { op: 'field', alias: 'object', field: 'kind' },
          right: { op: 'value', value: 'file' }
        }
      },
      projection: {
        id: { op: 'field', alias: 'object', field: 'id' },
        title: { op: 'field', alias: 'object', field: 'title' }
      }
    });
  });
});
