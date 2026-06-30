import { describe, expect, it } from 'vitest';
import { buildWriterActionScenario, createTarstateDemoSnapshot } from './demo.js';

describe('tarstate demo data', () => {
  it('evaluates the seed query and applies the writer patches', async () => {
    const snapshot = await createTarstateDemoSnapshot();

    expect(snapshot.queryResult.diagnostics).toEqual([]);
    expect(snapshot.queryResult.rows).toEqual([
      { id: 'todo-a', text: 'Sketch relation schema', done: true, writer: 'Mina' },
      { id: 'todo-b', text: 'Evaluate a query over object rows', done: false, writer: undefined },
      { id: 'todo-c', text: 'Apply writer patches', done: false, writer: 'Jules' }
    ]);
    expect(snapshot.writeResult).toEqual({ patches: 4, applied: 4, diagnostics: [] });
    expect(snapshot.nextRows.todos).toEqual([
      { id: 'todo-a', text: 'Sketch relation schema', done: true },
      { id: 'todo-b', text: 'Evaluate a query over object rows', done: true },
      { id: 'todo-c', text: 'Apply writer patches', done: false },
      { id: 'todo-d', text: 'Keep Automerge as a planned adapter', done: false }
    ]);
    expect(snapshot.nextRows.todoWriters).toEqual([
      { todoId: 'todo-a', writerId: 'writer-mina' },
      { todoId: 'todo-d', writerId: 'writer-mina' }
    ]);
    expect(snapshot.nextQueryResult.diagnostics).toEqual([]);
    expect(snapshot.nextQueryResult.rows).toEqual([
      { id: 'todo-a', text: 'Sketch relation schema', done: true, writer: 'Mina' },
      { id: 'todo-b', text: 'Evaluate a query over object rows', done: true, writer: undefined },
      { id: 'todo-c', text: 'Apply writer patches', done: false, writer: undefined },
      { id: 'todo-d', text: 'Keep Automerge as a planned adapter', done: false, writer: 'Mina' }
    ]);
    expect(snapshot.patchLog.map((entry) => entry.op)).toEqual(['update', 'insert', 'upsert', 'delete']);
  });

  it('builds a writer action scenario with supported patch operations', () => {
    const scenario = buildWriterActionScenario();

    expect(scenario.actions.map((action) => action.patch.op)).toEqual(['update', 'insert', 'upsert', 'delete']);
    expect(scenario.actions.map((action) => action.intent)).toEqual([
      'Mark the object-backed query work complete.',
      'Add a follow-up todo for the next adapter boundary.',
      'Assign the new todo to an existing writer.',
      'Remove the stale writer assignment from the patching task.'
    ]);
  });
});
