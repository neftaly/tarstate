import { describe, expect, it } from 'vitest';
import {
  buildDemoPatches,
  buildWriterActionScenario,
  createTarstateDemoSnapshot,
  seedSourceRows
} from './demo.js';

const initialRows = [
  { id: 'todo-a', text: 'Sketch relation schema', done: true, writer: 'Mina' },
  { id: 'todo-b', text: 'Evaluate a query over object rows', done: false, writer: undefined },
  { id: 'todo-c', text: 'Apply writer patches', done: false, writer: 'Jules' }
];

const nextRows = [
  { id: 'todo-a', text: 'Sketch relation schema', done: true, writer: 'Mina' },
  { id: 'todo-b', text: 'Evaluate a query over object rows', done: true, writer: undefined },
  { id: 'todo-c', text: 'Apply writer patches', done: false, writer: undefined },
  { id: 'todo-d', text: 'Benchmark the Automerge adapter', done: false, writer: 'Mina' }
];

describe('tarstate demo contract', () => {
  it('provides stable seed rows for the public todo demo relations', () => {
    expect(seedSourceRows()).toEqual({
      todos: [
        { id: 'todo-a', text: 'Sketch relation schema', done: true },
        { id: 'todo-b', text: 'Evaluate a query over object rows', done: false },
        { id: 'todo-c', text: 'Apply writer patches', done: false }
      ],
      todoWriters: [
        { todoId: 'todo-a', writerId: 'writer-mina' },
        { todoId: 'todo-c', writerId: 'writer-jules' }
      ],
      writers: [
        { id: 'writer-mina', name: 'Mina' },
        { id: 'writer-jules', name: 'Jules' }
      ]
    });
  });

  it('declares the writer batch as ordered public patch intents', () => {
    const scenario = buildWriterActionScenario();
    const patches = buildDemoPatches();

    expect(scenario).toMatchObject({
      title: 'Writer batch: finish, add, assign, unassign',
      actions: [
        { intent: 'Mark the object-backed query work complete.' },
        { intent: 'Add a follow-up todo for adapter benchmarking.' },
        { intent: 'Assign the new todo to an existing writer.' },
        { intent: 'Remove the stale writer assignment from the patching task.' }
      ]
    });
    expect(patches).toEqual(scenario.actions.map((action) => action.patch));
    expect(patches.map((patch) => [patch.op, patch.relation.name])).toEqual([
      ['updateByKey', 'todos'],
      ['insert', 'todos'],
      ['insertOrUpdate', 'todoWriters'],
      ['deleteByKey', 'todoWriters']
    ]);
  });

  it('builds a snapshot with query rows, patch logs, write results, and next query rows', async () => {
    const snapshot = await createTarstateDemoSnapshot();

    expect(snapshot.schema).toEqual([
      { name: 'todos', key: 'id', fields: ['id', 'text', 'done'] },
      { name: 'writers', key: 'id', fields: ['id', 'name'] },
      { name: 'todoWriters', key: 'todoId', fields: ['todoId', 'writerId'] }
    ]);
    expect(snapshot.queryResult).toEqual({ rows: initialRows, diagnostics: [] });
    expect(snapshot.patchLog.map((entry) => ({
      index: entry.index,
      op: entry.op,
      relation: entry.relation,
      intent: entry.intent
    }))).toEqual([
      {
        index: 1,
        op: 'updateByKey',
        relation: 'todos',
        intent: 'Mark the object-backed query work complete.'
      },
      {
        index: 2,
        op: 'insert',
        relation: 'todos',
        intent: 'Add a follow-up todo for adapter benchmarking.'
      },
      {
        index: 3,
        op: 'insertOrUpdate',
        relation: 'todoWriters',
        intent: 'Assign the new todo to an existing writer.'
      },
      {
        index: 4,
        op: 'deleteByKey',
        relation: 'todoWriters',
        intent: 'Remove the stale writer assignment from the patching task.'
      }
    ]);
    expect(snapshot.writeResult).toMatchObject({ patches: 4, applied: 4, diagnostics: [] });
    expect(snapshot.nextQueryResult).toEqual({ rows: nextRows, diagnostics: [] });
  });
});
