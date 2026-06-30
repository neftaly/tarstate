import { describe, expect, it } from 'vitest';
import { relationDeltaNames, relationDeltas, type RelationDelta } from '@tarstate/core/delta';
import { defineSchema, idField, relation, stringField } from '@tarstate/core/schema';

const schema = defineSchema({
  todos: relation<{
    id: string;
    text: string;
  }>({
    key: 'id',
    fields: {
      id: idField('todo'),
      text: stringField()
    }
  })
});

describe('tarstate relation deltas', () => {
  it('publishes adapter-produced added and removed rows as immutable deltas', () => {
    const added = [
      { id: 'todo-a', text: 'After' },
      { id: 'todo-b', text: 'New' }
    ];
    const removed = [{ id: 'todo-a', text: 'Before' }];
    const adapterDeltas: readonly RelationDelta[] = [
      {
        relation: schema.todos,
        added,
        removed
      }
    ];

    const deltas = relationDeltas(adapterDeltas);
    added.push({ id: 'todo-c', text: 'Later mutation' });
    removed.push({ id: 'todo-c', text: 'Earlier mutation' });

    expect(deltas).toEqual([
      {
        relation: schema.todos,
        added: [
          { id: 'todo-a', text: 'After' },
          { id: 'todo-b', text: 'New' }
        ],
        removed: [{ id: 'todo-a', text: 'Before' }]
      }
    ]);
    expect(relationDeltaNames(deltas)).toEqual(new Set(['todos']));
    expect(Object.isFrozen(deltas)).toBe(true);
    expect(Object.isFrozen(deltas[0])).toBe(true);
    expect(Object.isFrozen(deltas[0]?.added)).toBe(true);
    expect(Object.isFrozen(deltas[0]?.removed)).toBe(true);
  });
});
