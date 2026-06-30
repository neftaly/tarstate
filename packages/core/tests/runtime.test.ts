import { describe, expect, it } from 'vitest';
import type {
  AdapterCommitResult,
  AdapterSnapshot,
  AdapterSource,
  RelationAdapter,
  RelationApplyResult,
  RelationRuntime
} from '@tarstate/core/adapter';
import { attachConstraints, check, constrain } from '@tarstate/core/constraints';
import { createDb, dbSource, tryTransact, type Db } from '@tarstate/core/db';
import type { TarstateDiagnostic } from '@tarstate/core/diagnostics';
import { stableRowKey } from '@tarstate/core/diff';
import { materializationForQuery, materializedRowsFor, materializeSnapshot } from '@tarstate/core/materialization';
import { as, eq, field, from, pipe, project, where } from '@tarstate/core/query';
import { trackRuntimeCommit, trackTransact } from '@tarstate/core/runtime';
import { booleanField, defineSchema, idField, relation, stringField } from '@tarstate/core/schema';
import type { RelationSource } from '@tarstate/core/source';
import { watch } from '@tarstate/core/watch';
import { write, type WritePatch } from '@tarstate/core/write';

const schema = defineSchema({
  todos: relation<{
    id: string;
    title: string;
    done: boolean;
  }>({
    key: 'id',
    fields: {
      id: idField('todo'),
      title: stringField(),
      done: booleanField()
    }
  }),
  logs: relation<{
    id: string;
    message: string;
  }>({
    key: 'id',
    fields: {
      id: idField('log'),
      message: stringField()
    }
  })
});

const todo = as(schema.todos, 'todo');
const log = as(schema.logs, 'log');
const openTodos = pipe(
  from(todo),
  where(eq(todo.done, false)),
  project({
    id: todo.id,
    title: todo.title
  })
);
const equivalentOpenTodos = pipe(
  from(todo),
  where(eq(todo.done, false)),
  project({
    id: todo.id,
    title: todo.title
  })
);
const logRows = pipe(
  from(log),
  project({
    id: log.id,
    message: log.message
  })
);
const projectedAlphaTitles = pipe(
  from(todo),
  project({
    title: todo.title
  }),
  where(eq(field('', 'title'), 'Alpha'))
);

type CountedSource = {
  readonly source: RelationSource;
  readonly rowsCalls: () => number;
  readonly diagnosticsCalls: () => number;
};
type RuntimeMode = 'accepted' | 'partialFirst' | 'rejected' | 'acceptedWithoutDeltas';
type RuntimeSeed = {
  readonly todos?: readonly TodoRow[];
  readonly logs?: readonly LogRow[];
};
type TodoRow = {
  readonly id: string;
  readonly title: string;
  readonly done: boolean;
};
type LogRow = {
  readonly id: string;
  readonly message: string;
};

function countedSource(
  data: Record<string, readonly unknown[]>,
  diagnostics: readonly TarstateDiagnostic[] = []
): CountedSource {
  let rowsCalls = 0;
  let diagnosticsCalls = 0;
  const source: RelationSource = {
    relationNames: Object.keys(data),
    rows: (relationRef) => {
      rowsCalls += 1;
      return data[relationRef.name] ?? [];
    },
    version: () => data,
    ...(diagnostics.length === 0
      ? {}
      : {
          diagnostics: () => {
            diagnosticsCalls += 1;
            return diagnostics;
          }
        })
  };

  return {
    source,
    rowsCalls: () => rowsCalls,
    diagnosticsCalls: () => diagnosticsCalls
  };
}

class MutableRuntime implements RelationRuntime<number> {
  private db: Db;
  private versionId = 0;

  readonly snapshotSources: RelationSource[] = [];
  readonly source: AdapterSource<number> = {
    relationNames: [schema.todos.name, schema.logs.name],
    rows: (relationRef) => this.db.data[relationRef.name] ?? [],
    version: () => this.versionId
  };
  readonly target = {
    apply: (patches: readonly WritePatch[]) => this.apply(patches)
  };

  constructor(
    seed: RuntimeSeed,
    private readonly mode: RuntimeMode = 'accepted'
  ) {
    this.db = createDb({
      todos: seed.todos ?? [],
      logs: seed.logs ?? []
    });
  }

  snapshot = (): AdapterSnapshot<number> => {
    const version = this.versionId;
    const source = {
      ...dbSource(this.db),
      version: () => version
    };

    this.snapshotSources.push(source);
    return { source, version };
  };

  commitAdapter = (patches: readonly WritePatch[]): AdapterCommitResult<number> => this.commitAll(patches);

  private apply(patches: readonly WritePatch[]): RelationApplyResult<number> {
    switch (this.mode) {
      case 'accepted':
        return relationApplyResultFromCommit(this.commitAll(patches));
      case 'partialFirst':
        return this.applyFirstPatch(patches);
      case 'rejected':
        return {
          status: 'rejected',
          accepted: false,
          patches: patches.length,
          applied: 0,
          deltas: [],
          diagnostics: [runtimeDiagnostic('runtime rejected patches')],
          version: this.versionId
        };
      case 'acceptedWithoutDeltas':
        return this.applyWithoutDeltas(patches);
    }
  }

  private applyFirstPatch(patches: readonly WritePatch[]): RelationApplyResult<number> {
    const firstPatch = patches[0];
    const result = this.commitAll(firstPatch === undefined ? [] : [firstPatch]);

    return {
      status: 'partial',
      accepted: false,
      patches: patches.length,
      applied: result.applied,
      deltas: result.deltas,
      diagnostics: [runtimeDiagnostic('runtime applied only the first patch')],
      version: this.versionId
    };
  }

  private applyWithoutDeltas(patches: readonly WritePatch[]): RelationApplyResult<number> {
    const result = this.commitAll(patches);

    return {
      status: 'accepted',
      accepted: true,
      patches: result.patches,
      applied: result.applied,
      diagnostics: result.diagnostics,
      version: this.versionId
    } as unknown as RelationApplyResult<number>;
  }

  private commitAll(patches: readonly WritePatch[]): AdapterCommitResult<number> {
    const transaction = tryTransact(this.db, patches);

    if (!transaction.committed) {
      return {
        status: 'rejected',
        committed: false,
        patches: transaction.patches,
        applied: 0,
        deltas: [],
        diagnostics: transaction.diagnostics,
        version: this.versionId
      };
    }

    this.db = transaction.db;
    this.versionId += 1;

    return {
      status: 'committed',
      committed: true,
      patches: transaction.patches,
      applied: transaction.applied,
      deltas: transaction.deltas,
      diagnostics: [],
      version: this.versionId
    };
  }
}

function runtimeDiagnostic(message: string): TarstateDiagnostic {
  return {
    code: 'source_error',
    message
  };
}

function relationApplyResultFromCommit(result: AdapterCommitResult<number>): RelationApplyResult<number> {
  if (result.status === 'rejected') {
    return {
      status: 'rejected',
      accepted: false,
      patches: result.patches,
      applied: 0,
      deltas: [],
      diagnostics: result.diagnostics,
      ...testVersionProperty(result.version)
    };
  }

  if (result.status === 'committed') {
    return {
      status: 'accepted',
      accepted: true,
      patches: result.patches,
      applied: result.applied,
      deltas: result.deltas,
      diagnostics: result.diagnostics,
      ...testVersionProperty(result.version)
    };
  }

  return {
    status: 'partial',
    accepted: false,
    patches: result.patches,
    applied: result.applied,
    deltas: result.deltas,
    diagnostics: result.diagnostics,
    ...testVersionProperty(result.version)
  };
}

function testVersionProperty(version: number | undefined): { readonly version?: number } {
  return version === undefined ? {} : { version };
}

describe('tarstate runtime orchestration', () => {
  it('tracks watched query changes across object-backed transactions', async () => {
    const db = createDb({
      todos: [
        { id: 'todo-a', title: 'Alpha', done: false },
        { id: 'todo-b', title: 'Beta', done: false }
      ]
    });
    const todos = write(schema.todos);
    const events: unknown[] = [];
    const handle = watch(db, openTodos, (event) => {
      events.push(event);
    });

    const result = await trackTransact(db, (current) =>
      tryTransact(current, [
        todos.update('todo-a', { done: true }),
        todos.insert({ id: 'todo-c', title: 'Gamma', done: false })
      ])
    );

    expect(result).toMatchObject({
      kind: 'trackTransact',
      supported: true,
      diagnostics: [],
      changes: [
        {
          kind: 'trackedChange',
          id: handle.id,
          target: openTodos,
          changed: true,
          previousRows: [
            { id: 'todo-a', title: 'Alpha' },
            { id: 'todo-b', title: 'Beta' }
          ],
          rows: [
            { id: 'todo-b', title: 'Beta' },
            { id: 'todo-c', title: 'Gamma' }
          ],
          addedRows: [{ id: 'todo-c', title: 'Gamma' }],
          removedRows: [{ id: 'todo-a', title: 'Alpha' }],
          unchangedRows: [{ id: 'todo-b', title: 'Beta' }],
          rowChanges: [
            {
              op: 'insert',
              key: stableRowKey({ id: 'todo-c', title: 'Gamma' }),
              after: { id: 'todo-c', title: 'Gamma' }
            },
            {
              op: 'delete',
              key: stableRowKey({ id: 'todo-a', title: 'Alpha' }),
              before: { id: 'todo-a', title: 'Alpha' }
            }
          ]
        }
      ]
    });
    expect(result.deltas).toEqual([
      {
        relation: schema.todos,
        added: [
          { id: 'todo-a', title: 'Alpha', done: true },
          { id: 'todo-c', title: 'Gamma', done: false }
        ],
        removed: [{ id: 'todo-a', title: 'Alpha', done: false }]
      }
    ]);
    expect(result.db.data.todos).toEqual([
      { id: 'todo-a', title: 'Alpha', done: true },
      { id: 'todo-b', title: 'Beta', done: false },
      { id: 'todo-c', title: 'Gamma', done: false }
    ]);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      id: handle.id,
      changed: true,
      addedRows: [{ id: 'todo-c', title: 'Gamma' }],
      removedRows: [{ id: 'todo-a', title: 'Alpha' }],
      rowChanges: [
        {
          op: 'insert',
          key: stableRowKey({ id: 'todo-c', title: 'Gamma' }),
          after: { id: 'todo-c', title: 'Gamma' }
        },
        {
          op: 'delete',
          key: stableRowKey({ id: 'todo-a', title: 'Alpha' }),
          before: { id: 'todo-a', title: 'Alpha' }
        }
      ],
      changes: { deltas: result.deltas }
    });

    const secondResult = await trackTransact(result.db, (current) =>
      tryTransact(current, [todos.update('todo-b', { done: true })])
    );

    expect(secondResult).toMatchObject({
      supported: true,
      changes: [
        {
          id: handle.id,
          changed: true,
          addedRows: [],
          removedRows: [{ id: 'todo-b', title: 'Beta' }],
          unchangedRows: [{ id: 'todo-c', title: 'Gamma' }],
          rowChanges: [
            {
              op: 'delete',
              key: stableRowKey({ id: 'todo-b', title: 'Beta' }),
              before: { id: 'todo-b', title: 'Beta' }
            }
          ]
        }
      ]
    });

    await expect(handle.refresh()).resolves.toMatchObject({
      delivered: true,
      previousRows: [{ id: 'todo-c', title: 'Gamma' }],
      rows: [{ id: 'todo-c', title: 'Gamma' }],
      addedRows: [],
      removedRows: [],
      unchangedRows: [{ id: 'todo-c', title: 'Gamma' }],
      diagnostics: []
    });

    expect(handle.unwatch()).toMatchObject({ closed: true, diagnostics: [] });
  });

  it('reports tracked relation writes that leave watched result rows unchanged', async () => {
    const db = createDb({
      todos: [{ id: 'todo-a', title: 'Alpha', done: false }]
    });
    const todos = write(schema.todos);
    const events: unknown[] = [];

    const handle = watch(db, openTodos, (event) => {
      events.push(event);
    });

    const result = await trackTransact(db, (current) =>
      tryTransact(current, [todos.update('todo-a', { done: false })])
    );

    expect(result.changes).toMatchObject([
      {
        id: handle.id,
        changed: false,
        addedRows: [],
        removedRows: [],
        unchangedRows: [{ id: 'todo-a', title: 'Alpha' }],
        rowChanges: []
      }
    ]);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      changed: false,
      addedRows: [],
      removedRows: [],
      unchangedRows: [{ id: 'todo-a', title: 'Alpha' }],
      rowChanges: []
    });
  });

  it('reports tracked watch listener errors as diagnostics and keeps transferred refresh state', async () => {
    const db = createDb({
      todos: [{ id: 'todo-a', title: 'Alpha', done: false }]
    });
    const todos = write(schema.todos);
    let fail = true;
    const handle = watch(db, openTodos, () => {
      if (fail) {
        throw new Error('listener failed');
      }
    });

    const result = await trackTransact(db, (current) =>
      tryTransact(current, [todos.insert({ id: 'todo-b', title: 'Beta', done: false })])
    );

    expect(result).toMatchObject({
      supported: true,
      changes: [
        {
          id: handle.id,
          diagnostics: [{ code: 'watch_listener_error', surface: 'watch' }]
        }
      ],
      diagnostics: [{ code: 'watch_listener_error', surface: 'watch' }]
    });

    fail = false;
    await expect(handle.refresh()).resolves.toMatchObject({
      delivered: true,
      previousRows: [
        { id: 'todo-a', title: 'Alpha' },
        { id: 'todo-b', title: 'Beta' }
      ],
      rows: [
        { id: 'todo-a', title: 'Alpha' },
        { id: 'todo-b', title: 'Beta' }
      ],
      addedRows: [],
      removedRows: [],
      unchangedRows: [
        { id: 'todo-a', title: 'Alpha' },
        { id: 'todo-b', title: 'Beta' }
      ],
      diagnostics: []
    });
  });

  it('carries materialized snapshots through tracked transactions', async () => {
    const db = createDb({
      todos: [{ id: 'todo-a', title: 'Alpha', done: false }]
    });
    const todos = write(schema.todos);

    await materializeSnapshot(db, openTodos, { id: 'open-todos' });

    const result = await trackTransact(db, (current) =>
      tryTransact(current, [todos.insert({ id: 'todo-b', title: 'Beta', done: false })])
    );

    expect(materializedRowsFor(result.db, 'open-todos')).toEqual([
      { id: 'todo-a', title: 'Alpha' },
      { id: 'todo-b', title: 'Beta' }
    ]);
  });

  it('exposes materialization maintenance counts after tracked transactions', async () => {
    const db = createDb({
      todos: [{ id: 'todo-a', title: 'Alpha', done: false }],
      logs: [{ id: 'log-a', message: 'unchanged' }]
    });
    const todos = write(schema.todos);

    await materializeSnapshot(db, openTodos, { id: 'open-todos' });
    await materializeSnapshot(db, logRows, { id: 'logs' });

    const result = await trackTransact(db, (current) =>
      tryTransact(current, [todos.insert({ id: 'todo-b', title: 'Beta', done: false })])
    );

    expect(result.materializations).toMatchObject({
      kind: 'materializationMaintenance',
      maintained: 2,
      recomputed: 1,
      carried: 1,
      changes: [
        { kind: 'materializationMaintenanceChange', id: 'open-todos', update: 'recomputed' },
        { kind: 'materializationMaintenanceChange', id: 'logs', update: 'carried' }
      ],
      diagnostics: [],
      sourceVersion: result.db.data
    });
    expect(materializedRowsFor(result.db, 'open-todos')).toEqual([
      { id: 'todo-a', title: 'Alpha' },
      { id: 'todo-b', title: 'Beta' }
    ]);
    expect(materializedRowsFor(result.db, 'logs')).toEqual([{ id: 'log-a', message: 'unchanged' }]);
  });

  it('uses maintained materialization query changes for matching watched query keys', async () => {
    const before = countedSource({
      todos: [{ id: 'todo-a', title: 'Alpha', done: false }]
    });
    const after = countedSource({
      todos: [
        { id: 'todo-a', title: 'Alpha', done: false },
        { id: 'todo-b', title: 'Beta', done: false }
      ]
    });
    const events: unknown[] = [];

    await materializeSnapshot(before.source, openTodos, { id: 'open-todos' });
    const handle = watch(before.source, equivalentOpenTodos, (event) => {
      events.push(event);
    }, { keyFields: ['id'] });

    const result = await trackTransact(before.source, () => ({
      db: after.source,
      deltas: [
        {
          relation: schema.todos,
          added: [{ id: 'todo-b', title: 'Beta', done: false }],
          removed: []
        }
      ]
    }));

    expect(before.rowsCalls()).toBe(1);
    expect(after.rowsCalls()).toBe(1);
    expect(result.changes).toMatchObject([
      {
        id: handle.id,
        target: equivalentOpenTodos,
        changed: true,
        previousRows: [{ id: 'todo-a', title: 'Alpha' }],
        rows: [
          { id: 'todo-a', title: 'Alpha' },
          { id: 'todo-b', title: 'Beta' }
        ],
        addedRows: [{ id: 'todo-b', title: 'Beta' }],
        removedRows: [],
        unchangedRows: [{ id: 'todo-a', title: 'Alpha' }],
        rowChanges: [
          {
            op: 'insert',
            key: stableRowKey('todo-b'),
            after: { id: 'todo-b', title: 'Beta' }
          }
        ],
        diagnostics: []
      }
    ]);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      id: handle.id,
      changed: true,
      addedRows: [{ id: 'todo-b', title: 'Beta' }],
      rowChanges: [
        {
          op: 'insert',
          key: stableRowKey('todo-b'),
          after: { id: 'todo-b', title: 'Beta' }
        }
      ],
      changes: { deltas: result.deltas },
      diagnostics: []
    });
    expect(materializedRowsFor(result.db, 'open-todos')).toEqual([
      { id: 'todo-a', title: 'Alpha' },
      { id: 'todo-b', title: 'Beta' }
    ]);
  });

  it('falls back to recomputing watched queries when materialization previous rows are unavailable', async () => {
    const before = countedSource({
      todos: [{ id: 'todo-a', title: 'Alpha', done: false }]
    });
    const after = countedSource({
      todos: [
        { id: 'todo-a', title: 'Alpha', done: false },
        { id: 'todo-b', title: 'Beta', done: false }
      ]
    });

    await materializeSnapshot(before.source, openTodos, { id: 'open-todos' });
    const metadata = materializationForQuery(before.source, openTodos);

    if (metadata === undefined) {
      throw new Error('expected openTodos materialization metadata');
    }

    (metadata as { id: string }).id = 'open-todos-missing-cache';
    const handle = watch(before.source, openTodos, () => undefined);

    const result = await trackTransact(before.source, () => ({
      db: after.source,
      deltas: [
        {
          relation: schema.todos,
          added: [{ id: 'todo-b', title: 'Beta', done: false }],
          removed: []
        }
      ]
    }));

    expect(result.materializations?.changes).toMatchObject([
      {
        id: 'open-todos-missing-cache',
        previousRowsAvailable: false,
        previousRows: undefined,
        addedRows: [],
        removedRows: []
      }
    ]);
    expect(before.rowsCalls()).toBe(2);
    expect(after.rowsCalls()).toBe(2);
    expect(result.changes).toMatchObject([
      {
        id: handle.id,
        changed: true,
        previousRows: [{ id: 'todo-a', title: 'Alpha' }],
        rows: [
          { id: 'todo-a', title: 'Alpha' },
          { id: 'todo-b', title: 'Beta' }
        ],
        addedRows: [{ id: 'todo-b', title: 'Beta' }],
        removedRows: [],
        diagnostics: []
      }
    ]);
  });

  it('falls back to recomputing watched queries when matching materialization changes have diagnostics', async () => {
    const sourceDiagnostic: TarstateDiagnostic = {
      code: 'source_error',
      message: 'after source diagnostic'
    };
    const before = countedSource({
      todos: [{ id: 'todo-a', title: 'Alpha', done: false }]
    });
    const after = countedSource({
      todos: [
        { id: 'todo-a', title: 'Alpha', done: false },
        { id: 'todo-b', title: 'Beta', done: false }
      ]
    }, [sourceDiagnostic]);

    await materializeSnapshot(before.source, openTodos, { id: 'open-todos' });
    const handle = watch(before.source, openTodos, () => undefined);

    const result = await trackTransact(before.source, () => ({
      db: after.source,
      deltas: [
        {
          relation: schema.todos,
          added: [{ id: 'todo-b', title: 'Beta', done: false }],
          removed: []
        }
      ]
    }));

    expect(result.materializations?.changes).toMatchObject([
      {
        id: 'open-todos',
        previousRowsAvailable: true,
        diagnostics: [sourceDiagnostic]
      }
    ]);
    expect(before.rowsCalls()).toBe(2);
    expect(after.rowsCalls()).toBe(2);
    expect(after.diagnosticsCalls()).toBe(2);
    expect(result.changes).toMatchObject([
      {
        id: handle.id,
        changed: true,
        diagnostics: [sourceDiagnostic]
      }
    ]);
  });

  it('exposes materialization maintenance diagnostics after tracked transactions', async () => {
    const db = createDb({
      todos: [{ id: 'todo-a', title: 'Alpha', done: false }]
    });
    const todos = write(schema.todos);

    await materializeSnapshot(db, projectedAlphaTitles, {
      id: 'alpha-titles',
      mode: 'incremental'
    });

    const result = await trackTransact(db, (current) =>
      tryTransact(current, [todos.update('todo-a', { title: 'Alpha updated' })])
    );

    expect(result.materializations).toMatchObject({
      kind: 'materializationMaintenance',
      maintained: 1,
      recomputed: 1,
      carried: 0,
      changes: [
        {
          kind: 'materializationMaintenanceChange',
          id: 'alpha-titles',
          update: 'recomputed',
          diagnostics: [{ code: 'materialization_unsupported', surface: 'materialization' }]
        }
      ],
      diagnostics: [{ code: 'materialization_unsupported', surface: 'materialization' }]
    });
    expect(result.diagnostics).toEqual(result.materializations?.diagnostics);
    expect(materializedRowsFor(result.db, 'alpha-titles')).toEqual([]);
  });

  it('enforces attached constraints across object-backed tracked transactions', async () => {
    const db = createDb({
      todos: [{ id: 'todo-a', title: 'Alpha', done: false }]
    });
    const todos = write(schema.todos);

    attachConstraints(db, constrain(check(from(todo), eq(todo.done, false), { name: 'todos-stay-open' })));
    await materializeSnapshot(db, openTodos, { id: 'open-todos' });

    const result = await trackTransact(db, (current) =>
      tryTransact(current, [todos.update('todo-a', { done: true })])
    );

    expect(result).toMatchObject({
      kind: 'trackTransact',
      db,
      supported: true,
      changes: [],
      deltas: [],
      diagnostics: [
        {
          code: 'invalid_row',
          message: 'check constraint failed',
          detail: {
            op: 'check',
            name: 'todos-stay-open',
            row: {
              todo: { id: 'todo-a', title: 'Alpha', done: true }
            }
          }
        }
      ]
    });
    expect(materializedRowsFor(result.db, 'open-todos')).toEqual([{ id: 'todo-a', title: 'Alpha' }]);
  });

  it('reports unsupported automatic enforcement for attached constraints on non-object-backed sources', async () => {
    const source = {
      rows: () => [{ id: 'todo-a', title: 'Alpha', done: false }]
    };
    const nextSource = {
      rows: () => [{ id: 'todo-a', title: 'Alpha', done: true }]
    };

    attachConstraints(source, constrain(check(from(todo), eq(todo.done, false))));

    await expect(trackTransact(source, () => nextSource)).resolves.toMatchObject({
      kind: 'trackTransact',
      db: nextSource,
      supported: true,
      changes: [],
      deltas: [],
      diagnostics: [
        {
          code: 'unsupported_lookup',
          message: 'attached constraints can only be automatically enforced for object-backed DB transactions',
          detail: {
            surface: 'constraints',
            constraints: 1
          }
        }
      ]
    });
  });

  it('skips watched queries when relation deltas cannot affect their dependencies', async () => {
    const db = createDb({
      todos: [{ id: 'todo-a', title: 'Alpha', done: false }],
      logs: []
    });
    const logs = write(schema.logs);
    const events: unknown[] = [];

    watch(db, openTodos, (event) => {
      events.push(event);
    });

    const result = await trackTransact(db, (current) =>
      tryTransact(current, [logs.insert({ id: 'log-a', message: 'unrelated write' })])
    );

    expect(result.deltas).toEqual([
      {
        relation: schema.logs,
        added: [{ id: 'log-a', message: 'unrelated write' }],
        removed: []
      }
    ]);
    expect(result.changes).toEqual([]);
    expect(events).toEqual([]);
  });

  it('treats empty transaction deltas as known no changes', async () => {
    const db = createDb({
      todos: [{ id: 'todo-a', title: 'Alpha', done: false }]
    });
    const events: unknown[] = [];

    await materializeSnapshot(db, openTodos, { id: 'open-todos' });
    watch(db, openTodos, (event) => {
      events.push(event);
    });

    const result = await trackTransact(db, (current) => tryTransact(current, []));

    expect(result.deltas).toEqual([]);
    expect(result.changes).toEqual([]);
    expect(events).toEqual([]);
    expect(materializedRowsFor(result.db, 'open-todos')).toEqual([{ id: 'todo-a', title: 'Alpha' }]);
  });

  it('tracks accepted adapter-like runtime patch commits through materializations and watched queries', async () => {
    const runtime = new MutableRuntime({
      todos: [
        { id: 'todo-a', title: 'Alpha', done: false },
        { id: 'todo-b', title: 'Beta', done: false }
      ]
    });
    const adapter: RelationAdapter<number> = {
      source: runtime.source,
      snapshot: runtime.snapshot,
      target: {
        apply: () => {
          throw new Error('target apply should not be called for adapter-like commits');
        }
      },
      commit: runtime.commitAdapter
    };
    const todos = write(schema.todos);
    const events: unknown[] = [];

    await materializeSnapshot(adapter.source, openTodos, { id: 'runtime-open' });
    const handle = watch(adapter.source, openTodos, (event) => {
      events.push(event);
    }, { keyFields: ['id'] });

    const result = await trackRuntimeCommit(adapter, [
      todos.update('todo-a', { done: true }),
      todos.insert({ id: 'todo-c', title: 'Gamma', done: false })
    ], { label: 'adapter-commit' });

    expect(result).toMatchObject({
      kind: 'trackRuntimeCommit',
      runtime: adapter,
      source: adapter.source,
      supported: true,
      status: 'accepted',
      accepted: true,
      patches: 2,
      applied: 2,
      version: 1,
      label: 'adapter-commit',
      diagnostics: []
    });
    expect(result.deltas).toEqual([
      {
        relation: schema.todos,
        added: [
          { id: 'todo-a', title: 'Alpha', done: true },
          { id: 'todo-c', title: 'Gamma', done: false }
        ],
        removed: [{ id: 'todo-a', title: 'Alpha', done: false }]
      }
    ]);
    expect(runtime.snapshotSources).toHaveLength(2);
    expect(runtime.snapshotSources[0]).not.toBe(runtime.snapshotSources[1]);
    expect(result.materializations).toMatchObject({
      maintained: 1,
      recomputed: 1,
      carried: 0,
      changes: [{ id: 'runtime-open', update: 'recomputed' }],
      sourceVersion: 1
    });
    expect(materializedRowsFor(adapter.source, 'runtime-open')).toEqual([
      { id: 'todo-b', title: 'Beta' },
      { id: 'todo-c', title: 'Gamma' }
    ]);
    expect(result.changes).toMatchObject([
      {
        id: handle.id,
        changed: true,
        addedRows: [{ id: 'todo-c', title: 'Gamma' }],
        removedRows: [{ id: 'todo-a', title: 'Alpha' }],
        unchangedRows: [{ id: 'todo-b', title: 'Beta' }],
        rowChanges: [
          {
            op: 'insert',
            key: stableRowKey('todo-c'),
            after: { id: 'todo-c', title: 'Gamma' }
          },
          {
            op: 'delete',
            key: stableRowKey('todo-a'),
            before: { id: 'todo-a', title: 'Alpha' }
          }
        ]
      }
    ]);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      id: handle.id,
      changed: true,
      changes: { deltas: result.deltas, diagnostics: [] }
    });
  });

  it('tracks partial generic runtime patch commits with only reported deltas', async () => {
    const runtime = new MutableRuntime({
      todos: [
        { id: 'todo-a', title: 'Alpha', done: false },
        { id: 'todo-b', title: 'Beta', done: false }
      ]
    }, 'partialFirst');
    const todos = write(schema.todos);
    const events: unknown[] = [];
    const handle = watch(runtime.source, openTodos, (event) => {
      events.push(event);
    }, { keyFields: ['id'] });

    const result = await trackRuntimeCommit(runtime, [
      todos.update('todo-a', { done: true }),
      todos.update('todo-b', { done: true })
    ]);

    expect(result).toMatchObject({
      kind: 'trackRuntimeCommit',
      runtime,
      source: runtime.source,
      supported: true,
      status: 'partial',
      accepted: false,
      patches: 2,
      applied: 1,
      version: 1,
      diagnostics: [{ code: 'source_error', message: 'runtime applied only the first patch' }]
    });
    expect(result.deltas).toEqual([
      {
        relation: schema.todos,
        added: [{ id: 'todo-a', title: 'Alpha', done: true }],
        removed: [{ id: 'todo-a', title: 'Alpha', done: false }]
      }
    ]);
    expect(runtime.snapshotSources).toHaveLength(2);
    expect(result.changes).toMatchObject([
      {
        id: handle.id,
        changed: true,
        addedRows: [],
        removedRows: [{ id: 'todo-a', title: 'Alpha' }],
        unchangedRows: [{ id: 'todo-b', title: 'Beta' }],
        rowChanges: [
          {
            op: 'delete',
            key: stableRowKey('todo-a'),
            before: { id: 'todo-a', title: 'Alpha' }
          }
        ]
      }
    ]);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      id: handle.id,
      changed: true,
      changes: { deltas: result.deltas, diagnostics: [] }
    });
  });

  it('recomputes runtime materializations in source order when commits report deltas', async () => {
    const alpha = { id: 'todo-a', title: 'Alpha', done: false };
    const beta = { id: 'todo-b', title: 'Beta', done: false };
    let rows = [alpha];
    let version = 0;
    const source: AdapterSource<number> = {
      relationNames: ['todos'],
      rows: (relationRef) => relationRef.name === 'todos' ? rows : [],
      version: () => version
    };
    const runtime: RelationRuntime<number> = {
      source,
      snapshot: () => ({ source, version }),
      target: {
        apply: (patches) => {
          rows = [beta, ...rows];
          version += 1;

          return {
            status: 'accepted',
            accepted: true,
            patches: patches.length,
            applied: patches.length,
            deltas: [{ relation: schema.todos, added: [beta], removed: [] }],
            diagnostics: [],
            version
          };
        }
      }
    };
    const todos = write(schema.todos);

    await materializeSnapshot(runtime.source, openTodos, { id: 'runtime-ordered-open', mode: 'incremental' });

    const result = await trackRuntimeCommit(runtime, [
      todos.insert(beta)
    ]);

    expect(result.deltas).toEqual([
      { relation: schema.todos, added: [beta], removed: [] }
    ]);
    expect(result.materializations).toMatchObject({
      maintained: 1,
      recomputed: 1,
      carried: 0,
      changes: [
        {
          id: 'runtime-ordered-open',
          update: 'recomputed',
          rows: [
            { id: 'todo-b', title: 'Beta' },
            { id: 'todo-a', title: 'Alpha' }
          ],
          addedRows: [{ id: 'todo-b', title: 'Beta' }],
          removedRows: []
        }
      ]
    });
    expect(materializedRowsFor(runtime.source, 'runtime-ordered-open')).toEqual([
      { id: 'todo-b', title: 'Beta' },
      { id: 'todo-a', title: 'Alpha' }
    ]);
  });

  it('does not maintain materializations or emit watched changes for rejected runtime patch commits', async () => {
    const runtime = new MutableRuntime({
      todos: [{ id: 'todo-a', title: 'Alpha', done: false }]
    }, 'rejected');
    const todos = write(schema.todos);
    const events: unknown[] = [];

    await materializeSnapshot(runtime.source, openTodos, { id: 'runtime-rejected-open' });
    watch(runtime.source, openTodos, (event) => {
      events.push(event);
    });

    const result = await trackRuntimeCommit(runtime, [
      todos.update('todo-a', { done: true })
    ]);

    expect(result).toMatchObject({
      kind: 'trackRuntimeCommit',
      runtime,
      source: runtime.source,
      supported: true,
      status: 'rejected',
      accepted: false,
      patches: 1,
      applied: 0,
      changes: [],
      deltas: [],
      diagnostics: [{ code: 'source_error', message: 'runtime rejected patches' }]
    });
    expect(result.materializations).toBeUndefined();
    expect(events).toEqual([]);
    expect(runtime.snapshotSources).toHaveLength(1);
    expect(materializedRowsFor(runtime.source, 'runtime-rejected-open')).toEqual([
      { id: 'todo-a', title: 'Alpha' }
    ]);
  });

  it('recomputes tracking without fake row changes when a runtime commit omits deltas', async () => {
    const runtime = new MutableRuntime({
      todos: [{ id: 'todo-a', title: 'Alpha', done: false }],
      logs: []
    }, 'acceptedWithoutDeltas');
    const logs = write(schema.logs);
    const events: unknown[] = [];
    const handle = watch(runtime.source, openTodos, (event) => {
      events.push(event);
    }, { keyFields: ['id'] });

    await materializeSnapshot(runtime.source, openTodos, { id: 'runtime-no-deltas-open' });

    const result = await trackRuntimeCommit(runtime, [
      logs.insert({ id: 'log-a', message: 'unreported relation delta' })
    ]);

    expect(result).toMatchObject({
      kind: 'trackRuntimeCommit',
      runtime,
      source: runtime.source,
      supported: true,
      status: 'accepted',
      accepted: true,
      patches: 1,
      applied: 1,
      version: 1,
      deltas: [],
      diagnostics: []
    });
    expect(result.materializations).toMatchObject({
      maintained: 1,
      recomputed: 1,
      carried: 0,
      changes: [
        {
          id: 'runtime-no-deltas-open',
          update: 'recomputed',
          previousRowsAvailable: true,
          previousRows: [{ id: 'todo-a', title: 'Alpha' }],
          rows: [{ id: 'todo-a', title: 'Alpha' }],
          addedRows: [],
          removedRows: []
        }
      ],
      sourceVersion: 1
    });
    expect(result.changes).toMatchObject([
      {
        id: handle.id,
        changed: false,
        addedRows: [],
        removedRows: [],
        unchangedRows: [{ id: 'todo-a', title: 'Alpha' }],
        rowChanges: [],
        diagnostics: []
      }
    ]);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      id: handle.id,
      changed: false,
      addedRows: [],
      removedRows: [],
      rowChanges: [],
      changes: { diagnostics: [] }
    });
    expect(Object.hasOwn((events[0] as { readonly changes: object }).changes, 'deltas')).toBe(false);
  });
});
