import { describe, expect, it } from 'vitest';
import { evaluate } from '@tarstate/core/evaluate';
import { as, eq, from, join, pipe, project, where } from '@tarstate/core/query';
import { defineSchema, idField, relation, stringField } from '@tarstate/core/schema';
import { composeSources, fromObjectSource } from '@tarstate/core/source';

type DocumentRow = {
  readonly id: string;
  readonly title: string;
};

type PresenceChannelRow = {
  readonly peerId: string;
  readonly channel: string;
  readonly value: string;
};

const schema = defineSchema({
  documents: relation<DocumentRow>({
    key: 'id',
    fields: {
      id: idField('document'),
      title: stringField()
    }
  }),
  presence: relation<PresenceChannelRow>({
    ephemeral: true,
    key: ['peerId', 'channel'],
    fields: {
      peerId: idField('peer'),
      channel: stringField(),
      value: stringField()
    }
  })
});

const document = as(schema.documents, 'document');
const presence = as(schema.presence, 'presence');
const focusedDocuments = pipe(
  from(document),
  join(
    pipe(
      from(presence),
      where(eq(presence.channel, 'focusedDocumentId'))
    ),
    eq(document.id, presence.value)
  ),
  project({
    documentId: document.id,
    title: document.title,
    peerId: presence.peerId
  })
);

describe('presence foreign-key queries', () => {
  it('treats presence rows as a generic data source with app-level foreign-key meaning', async () => {
    const durableSource = fromObjectSource({
      documents: [
        { id: 'document-a', title: 'Alpha' },
        { id: 'document-b', title: 'Beta' }
      ]
    });
    const presenceSource = fromObjectSource({
      presence: [
        { peerId: 'peer-a', channel: 'focusedDocumentId', value: 'document-b' },
        { peerId: 'peer-b', channel: 'cursorColor', value: 'red' }
      ]
    });
    const source = composeSources(durableSource, presenceSource);

    await expect(evaluate(source, focusedDocuments)).resolves.toEqual({
      rows: [{ documentId: 'document-b', title: 'Beta', peerId: 'peer-a' }],
      diagnostics: []
    });
    expect(source.relationNames).toEqual(['documents', 'presence']);
  });
});
