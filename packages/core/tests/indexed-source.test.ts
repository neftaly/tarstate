import { describe, expect, it } from 'vitest';
import { fromIndexedObjectSource } from '@tarstate/core/experimental/indexed-source';
import { defineSchema, idField, numberField, relation, stringField } from '@tarstate/core/schema';

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

describe('experimental indexed object source', () => {
  it('answers equality lookups over object rows', async () => {
    const source = fromIndexedObjectSource({
      objects: [
        { id: 'object-a', kind: 'file', title: 'Alpha' },
        { id: 'object-b', kind: 'folder', title: 'Beta' }
      ]
    });

    expect(await source.lookup?.({ relation: schema.objects, field: 'id', value: 'object-a' })).toEqual([
      { id: 'object-a', kind: 'file', title: 'Alpha' }
    ]);
    expect(await source.lookup?.({ relation: schema.objects, field: 'kind', value: 'file' })).toEqual([
      { id: 'object-a', kind: 'file', title: 'Alpha' }
    ]);
  });

  it('answers range lookups over supported primitive fields', async () => {
    const source = fromIndexedObjectSource({
      objects: [
        { id: 'object-a', kind: 'file', title: 'Alpha' },
        { id: 'object-b', kind: 'file', title: 'Beta' },
        { id: 'object-d', kind: 'file', title: 'Delta' },
        { id: 'object-g', kind: 'file', title: 'Gamma' }
      ],
      ranks: [
        { id: 'rank-1', rank: 1 },
        { id: 'rank-2', rank: 2 },
        { id: 'rank-3', rank: 3 },
        { id: 'rank-4', rank: 4 }
      ]
    });

    const stringResult = await source.rangeLookup?.({
      relation: schema.objects,
      field: 'title',
      lower: { value: 'Beta', inclusive: true },
      upper: { value: 'Gamma', inclusive: false }
    });
    const numberResult = await source.rangeLookup?.({
      relation: schema.ranks,
      field: 'rank',
      lower: { value: 2, inclusive: false },
      upper: { value: 4, inclusive: true }
    });

    expect(stringResult === undefined ? stringResult : Array.from(stringResult)).toEqual([
      { id: 'object-b', kind: 'file', title: 'Beta' },
      { id: 'object-d', kind: 'file', title: 'Delta' }
    ]);
    expect(numberResult === undefined ? numberResult : Array.from(numberResult)).toEqual([
      { id: 'rank-3', rank: 3 },
      { id: 'rank-4', rank: 4 }
    ]);
  });

  it('does not answer unsupported range requests', async () => {
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
});
