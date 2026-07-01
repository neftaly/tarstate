import { describe, expect, it } from 'vitest';
import { diffRows } from '@tarstate/core/experimental/diff';

describe('tarstate row diffs', () => {
  it('diffs rows as a structural multiset', () => {
    const diff = diffRows(
      [
        { id: 'todo-a', done: false },
        { id: 'todo-a', done: false },
        { id: 'todo-b', done: false }
      ],
      [
        { id: 'todo-a', done: false },
        { id: 'todo-c', done: false }
      ]
    );

    expect(diff).toMatchObject({
      addedRows: [{ id: 'todo-c', done: false }],
      removedRows: [
        { id: 'todo-a', done: false },
        { id: 'todo-b', done: false }
      ],
      unchangedRows: [{ id: 'todo-a', done: false }]
    });
  });

  it('collapses keyed delete and insert pairs into row updates', () => {
    const before = { id: 'todo-a', title: 'Alpha' };
    const after = { id: 'todo-a', title: 'Alpha updated' };

    const diff = diffRows([before], [after], { keyFields: ['id'] });

    expect(diff).toMatchObject({
      addedRows: [after],
      removedRows: [before],
      unchangedRows: []
    });
  });

  it('falls back instead of pairing rows with missing or undefined keys', () => {
    const before = { title: 'Alpha' };
    const after = { id: undefined, title: 'Alpha updated' };

    const diff = diffRows([before], [after], { keyFields: ['id'] });

    expect(diff).toMatchObject({
      addedRows: [after],
      removedRows: [before],
      unchangedRows: []
    });
    expect(diff.rowChangeDiagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'row_key_missing', field: 'id' })])
    );
  });

  it('falls back instead of pairing rows when a row key selector returns undefined', () => {
    const before = { id: 'todo-a', title: 'Alpha' };
    const after = { id: 'todo-a', title: 'Beta' };

    const diff = diffRows([before], [after], { rowKey: () => undefined });

    expect(diff).toMatchObject({
      addedRows: [after],
      removedRows: [before],
      unchangedRows: []
    });
    expect(diff.rowChangeDiagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'row_key_missing' })])
    );
  });

  it('falls back for duplicate keyed rows while preserving unique keyed updates', () => {
    const beforeUnique = { id: 'todo-a', title: 'Alpha' };
    const afterUnique = { id: 'todo-a', title: 'Alpha updated' };
    const beforeDuplicateA = { id: 'todo-dupe', title: 'First' };
    const beforeDuplicateB = { id: 'todo-dupe', title: 'Second' };
    const afterDuplicate = { id: 'todo-dupe', title: 'Replacement' };

    const diff = diffRows(
      [beforeUnique, beforeDuplicateA, beforeDuplicateB],
      [afterDuplicate, afterUnique],
      { keyFields: ['id'] }
    );

    expect(diff).toMatchObject({
      addedRows: [afterDuplicate, afterUnique],
      removedRows: [beforeUnique, beforeDuplicateA, beforeDuplicateB],
      unchangedRows: []
    });
    expect(diff.rowChangeDiagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'row_key_duplicate' })])
    );
  });
});
