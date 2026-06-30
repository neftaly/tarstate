import { describe, expect, it } from 'vitest';
import { diffRows, stableRowKey } from '@tarstate/core/diff';

describe('tarstate row diffs', () => {
  it('diffs rows as a structural multiset', () => {
    expect(
      diffRows(
        [
          { id: 'todo-a', done: false },
          { id: 'todo-a', done: false },
          { id: 'todo-b', done: false }
        ],
        [
          { id: 'todo-a', done: false },
          { id: 'todo-c', done: false }
        ]
      )
    ).toEqual({
      addedRows: [{ id: 'todo-c', done: false }],
      removedRows: [
        { id: 'todo-a', done: false },
        { id: 'todo-b', done: false }
      ],
      unchangedRows: [{ id: 'todo-a', done: false }],
      rowChanges: [
        {
          op: 'insert',
          key: stableRowKey({ id: 'todo-c', done: false }),
          after: { id: 'todo-c', done: false }
        },
        {
          op: 'delete',
          key: stableRowKey({ id: 'todo-a', done: false }),
          before: { id: 'todo-a', done: false }
        },
        {
          op: 'delete',
          key: stableRowKey({ id: 'todo-b', done: false }),
          before: { id: 'todo-b', done: false }
        }
      ]
    });
  });

  it('collapses keyed delete and insert pairs into row updates', () => {
    const before = { id: 'todo-a', title: 'Alpha' };
    const after = { id: 'todo-a', title: 'Alpha updated' };

    expect(diffRows([before], [after], { keyFields: ['id'] })).toEqual({
      addedRows: [after],
      removedRows: [before],
      unchangedRows: [],
      rowChanges: [
        {
          op: 'update',
          key: stableRowKey('todo-a'),
          before,
          after
        }
      ]
    });
  });

  it('falls back instead of pairing rows with missing or undefined keys', () => {
    const before = { title: 'Alpha' };
    const after = { id: undefined, title: 'Alpha updated' };

    expect(diffRows([before], [after], { keyFields: ['id'] })).toEqual({
      addedRows: [after],
      removedRows: [before],
      unchangedRows: [],
      rowChanges: [
        {
          op: 'insert',
          key: stableRowKey(after),
          after
        },
        {
          op: 'delete',
          key: stableRowKey(before),
          before
        }
      ],
      rowChangeDiagnostics: [
        {
          code: 'row_key_missing',
          message: 'before row change key field id is missing',
          surface: 'diff',
          side: 'before',
          field: 'id',
          detail: {
            row: before,
            reason: 'missing',
            keyFields: ['id']
          }
        },
        {
          code: 'row_key_missing',
          message: 'after row change key field id is undefined',
          surface: 'diff',
          side: 'after',
          field: 'id',
          detail: {
            row: after,
            reason: 'undefined',
            keyFields: ['id']
          }
        }
      ]
    });
  });

  it('falls back instead of pairing rows when a row key selector returns undefined', () => {
    const before = { id: 'todo-a', title: 'Alpha' };
    const after = { id: 'todo-a', title: 'Beta' };

    expect(diffRows([before], [after], { rowKey: () => undefined })).toEqual({
      addedRows: [after],
      removedRows: [before],
      unchangedRows: [],
      rowChanges: [
        {
          op: 'insert',
          key: stableRowKey(after),
          after
        },
        {
          op: 'delete',
          key: stableRowKey(before),
          before
        }
      ],
      rowChangeDiagnostics: [
        {
          code: 'row_key_missing',
          message: 'before row change key is undefined',
          surface: 'diff',
          side: 'before',
          detail: {
            row: before,
            reason: 'undefined_key'
          }
        },
        {
          code: 'row_key_missing',
          message: 'after row change key is undefined',
          surface: 'diff',
          side: 'after',
          detail: {
            row: after,
            reason: 'undefined_key'
          }
        }
      ]
    });
  });

  it('falls back for duplicate keyed rows while preserving unique keyed updates', () => {
    const beforeUnique = { id: 'todo-a', title: 'Alpha' };
    const afterUnique = { id: 'todo-a', title: 'Alpha updated' };
    const beforeDuplicateA = { id: 'todo-dupe', title: 'First' };
    const beforeDuplicateB = { id: 'todo-dupe', title: 'Second' };
    const afterDuplicate = { id: 'todo-dupe', title: 'Replacement' };

    expect(
      diffRows([beforeUnique, beforeDuplicateA, beforeDuplicateB], [afterDuplicate, afterUnique], { keyFields: ['id'] })
    ).toEqual({
      addedRows: [afterDuplicate, afterUnique],
      removedRows: [beforeUnique, beforeDuplicateA, beforeDuplicateB],
      unchangedRows: [],
      rowChanges: [
        {
          op: 'insert',
          key: stableRowKey(afterDuplicate),
          after: afterDuplicate
        },
        {
          op: 'update',
          key: stableRowKey('todo-a'),
          before: beforeUnique,
          after: afterUnique
        },
        {
          op: 'delete',
          key: stableRowKey(beforeDuplicateA),
          before: beforeDuplicateA
        },
        {
          op: 'delete',
          key: stableRowKey(beforeDuplicateB),
          before: beforeDuplicateB
        }
      ],
      rowChangeDiagnostics: [
        {
          code: 'row_key_duplicate',
          message: `before row change key ${stableRowKey('todo-dupe')} is duplicated`,
          surface: 'diff',
          side: 'before',
          key: stableRowKey('todo-dupe'),
          detail: {
            rows: [beforeDuplicateA, beforeDuplicateB],
            count: 2,
            keyFields: ['id']
          }
        }
      ]
    });
  });

  it('uses stable object key ordering for row identity', () => {
    expect(stableRowKey({ id: 'todo-a', nested: { b: 2, a: 1 } })).toBe(
      stableRowKey({ nested: { a: 1, b: 2 }, id: 'todo-a' })
    );
    expect(stableRowKey({ id: 'todo-a', value: undefined })).not.toBe(stableRowKey({ id: 'todo-a' }));
  });
});
