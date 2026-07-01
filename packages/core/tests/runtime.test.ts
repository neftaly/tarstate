import { describe, expect, it } from 'vitest';
import type {
  AdapterCommitResult,
  AdapterSnapshot,
  AdapterSource,
  RelationAdapter,
  RelationApplyResult,
  RelationRuntime
} from '@tarstate/core/adapter';
import { attachConstraints, check, constrain } from '@tarstate/core/experimental/constraints';
import { createDb, dbSource, stripMeta, tryTransact, type Db } from '@tarstate/core/db';
import type { TarstateDiagnostic } from '@tarstate/core/diagnostics';
import { as, eq, from, pipe, project, where } from '@tarstate/core/query';
import { trackRuntimeCommit, trackTransact, trackTransactPatches } from '@tarstate/core/experimental/runtime';
import { booleanField, defineSchema, idField, relation, stringField } from '@tarstate/core/schema';
import { watch } from '@tarstate/core/experimental/watch';
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
const openTodos = pipe(
  from(todo),
  where(eq(todo.done, false)),
  project({
    id: todo.id,
    title: todo.title
  })
);
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

class MutableRuntime implements RelationRuntime<number> {
  private db: Db;
  private versionId = 0;

  readonly source: AdapterSource<number> = {
    relationNames: [schema.todos.name, schema.logs.name],
    rows: (relationRef) => stripMeta(this.db)[relationRef.name] ?? [],
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
      status: 'accepted',
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
      patches: result.patches,
      applied: 0,
      deltas: [],
      diagnostics: result.diagnostics,
      ...testVersionProperty(result.version)
    };
  }

  if (result.status === 'accepted') {
    return {
      status: 'accepted',
      patches: result.patches,
      applied: result.applied,
      deltas: result.deltas,
      diagnostics: result.diagnostics,
      ...testVersionProperty(result.version)
    };
  }

  return {
    status: 'partial',
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
        todos.updateByKey('todo-a', { done: true }),
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
          rows: [
            { id: 'todo-b', title: 'Beta' },
            { id: 'todo-c', title: 'Gamma' }
          ]
        }
      ]
    });
    expect(stripMeta(result.db).todos).toEqual([
      { id: 'todo-a', title: 'Alpha', done: true },
      { id: 'todo-b', title: 'Beta', done: false },
      { id: 'todo-c', title: 'Gamma', done: false }
    ]);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      id: handle.id,
      changed: true,
      rows: [
        { id: 'todo-b', title: 'Beta' },
        { id: 'todo-c', title: 'Gamma' }
      ]
    });

    const secondResult = await trackTransact(result.db, (current) =>
      tryTransact(current, [todos.updateByKey('todo-b', { done: true })])
    );

    expect(secondResult).toMatchObject({
      supported: true,
      changes: [
        {
          id: handle.id,
          changed: true,
          rows: [{ id: 'todo-c', title: 'Gamma' }]
        }
      ]
    });

    await expect(handle.refresh()).resolves.toMatchObject({
      delivered: true,
      rows: [{ id: 'todo-c', title: 'Gamma' }],
      diagnostics: []
    });

    expect(handle.unwatch()).toMatchObject({ closed: true, diagnostics: [] });
  });

  it('tracks object-backed patch inputs through a convenience facade', async () => {
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

    const result = await trackTransactPatches(
      db,
      todos.updateByKey('todo-a', { done: true }),
      [todos.insert({ id: 'todo-c', title: 'Gamma', done: false })]
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
          rows: [
            { id: 'todo-b', title: 'Beta' },
            { id: 'todo-c', title: 'Gamma' }
          ]
        }
      ]
    });
    expect(stripMeta(result.db).todos).toEqual([
      { id: 'todo-a', title: 'Alpha', done: true },
      { id: 'todo-b', title: 'Beta', done: false },
      { id: 'todo-c', title: 'Gamma', done: false }
    ]);
    expect(result).not.toHaveProperty('committed');
    expect(result).not.toHaveProperty('patches');
    expect(result).not.toHaveProperty('applied');
    expect(events).toHaveLength(1);
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
      tryTransact(current, [todos.updateByKey('todo-a', { done: false })])
    );

    expect(result.changes).toMatchObject([
      {
        id: handle.id,
        changed: false,
        rows: [{ id: 'todo-a', title: 'Alpha' }]
      }
    ]);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      changed: false,
      rows: [{ id: 'todo-a', title: 'Alpha' }]
    });
  });

  it('reports tracked watch listener errors as diagnostics', async () => {
    const db = createDb({
      todos: [{ id: 'todo-a', title: 'Alpha', done: false }]
    });
    const todos = write(schema.todos);
    const handle = watch(db, openTodos, () => {
      throw new Error('listener failed');
    });

    const result = await trackTransact(db, (current) =>
      tryTransact(current, [todos.insert({ id: 'todo-b', title: 'Beta', done: false })])
    );

    expect(result).toMatchObject({
      supported: true,
      changes: [
        {
          id: handle.id,
          diagnostics: [expect.objectContaining({ code: 'watch_listener_error' })]
        }
      ],
      diagnostics: [expect.objectContaining({ code: 'watch_listener_error' })]
    });
  });

  it('enforces attached constraints across object-backed tracked transactions', async () => {
    const db = createDb({
      todos: [{ id: 'todo-a', title: 'Alpha', done: false }]
    });
    const todos = write(schema.todos);

    attachConstraints(db, constrain(check(from(todo), eq(todo.done, false), { name: 'todos-stay-open' })));

    const result = await trackTransact(db, (current) =>
      tryTransact(current, [todos.updateByKey('todo-a', { done: true })])
    );

    expect(result).toMatchObject({
      kind: 'trackTransact',
      db,
      supported: true,
      changes: [],
      diagnostics: [
        expect.objectContaining({ code: 'invalid_row' })
      ]
    });
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
      diagnostics: [
        expect.objectContaining({ code: 'unsupported_lookup' })
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

    expect(result.changes).toEqual([]);
    expect(events).toEqual([]);
  });

  it('treats empty transaction deltas as known no changes', async () => {
    const db = createDb({
      todos: [{ id: 'todo-a', title: 'Alpha', done: false }]
    });
    const events: unknown[] = [];

    watch(db, openTodos, (event) => {
      events.push(event);
    });

    const result = await trackTransact(db, (current) => tryTransact(current, []));

    expect(result.changes).toEqual([]);
    expect(events).toEqual([]);
  });

  it('tracks accepted adapter-like runtime patch commits through watched queries', async () => {
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

    const handle = watch(adapter.source, openTodos, (event) => {
      events.push(event);
    }, { keyFields: ['id'] });

    const result = await trackRuntimeCommit(adapter, [
      todos.updateByKey('todo-a', { done: true }),
      todos.insert({ id: 'todo-c', title: 'Gamma', done: false })
    ], { label: 'adapter-commit' });

    expect(result).toMatchObject({
      kind: 'trackRuntimeCommit',
      runtime: adapter,
      source: adapter.source,
      supported: true,
      status: 'accepted',
      patches: 2,
      applied: 2,
      version: 1,
      label: 'adapter-commit',
      diagnostics: []
    });
    expect(result.changes).toMatchObject([
      {
        id: handle.id,
        changed: true,
        rows: [
          { id: 'todo-b', title: 'Beta' },
          { id: 'todo-c', title: 'Gamma' }
        ]
      }
    ]);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      id: handle.id,
      changed: true
    });
  });

  it('returns unsupported commit result without source for invalid runtime-like input', async () => {
    const invalidRuntime = {
      target: {
        apply: () => {
          throw new Error('invalid runtime target should not be called');
        }
      }
    };
    const todos = write(schema.todos);

    const result = await trackRuntimeCommit(invalidRuntime, [
      todos.updateByKey('todo-a', { done: true })
    ], { label: 'invalid-runtime' });

    expect(result).toMatchObject({
      kind: 'trackRuntimeCommit',
      runtime: invalidRuntime,
      supported: false,
      status: 'rejected',
      patches: 1,
      applied: 0,
      changes: [],
      diagnostics: [{ code: 'change_tracking_unsupported' }],
      label: 'invalid-runtime'
    });
    expect(result.source).toBeUndefined();
  });

  it('tracks partial generic runtime patch commits', async () => {
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
      todos.updateByKey('todo-a', { done: true }),
      todos.updateByKey('todo-b', { done: true })
    ]);

    expect(result).toMatchObject({
      kind: 'trackRuntimeCommit',
      runtime,
      source: runtime.source,
      supported: true,
      status: 'partial',
      patches: 2,
      applied: 1,
      version: 1,
      diagnostics: [expect.objectContaining({ code: 'source_error' })]
    });
    expect(result.changes).toMatchObject([
      {
        id: handle.id,
        changed: true,
        rows: [{ id: 'todo-b', title: 'Beta' }]
      }
    ]);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      id: handle.id,
      changed: true
    });
  });

  it('does not emit watched changes for rejected runtime patch commits', async () => {
    const runtime = new MutableRuntime({
      todos: [{ id: 'todo-a', title: 'Alpha', done: false }]
    }, 'rejected');
    const todos = write(schema.todos);
    const events: unknown[] = [];

    watch(runtime.source, openTodos, (event) => {
      events.push(event);
    });

    const result = await trackRuntimeCommit(runtime, [
      todos.updateByKey('todo-a', { done: true })
    ]);

    expect(result).toMatchObject({
      kind: 'trackRuntimeCommit',
      runtime,
      source: runtime.source,
      supported: true,
      status: 'rejected',
      patches: 1,
      applied: 0,
      changes: [],
      diagnostics: [expect.objectContaining({ code: 'source_error' })]
    });
    if (!result.supported) {
      throw new Error('expected supported runtime commit result');
    }
    expect(events).toEqual([]);
  });

  it('tracks accepted runtime commits that omit change details without reporting watched row changes', async () => {
    const runtime = new MutableRuntime({
      todos: [{ id: 'todo-a', title: 'Alpha', done: false }],
      logs: []
    }, 'acceptedWithoutDeltas');
    const logs = write(schema.logs);
    const events: unknown[] = [];
    const handle = watch(runtime.source, openTodos, (event) => {
      events.push(event);
    }, { keyFields: ['id'] });

    const result = await trackRuntimeCommit(runtime, [
      logs.insert({ id: 'log-a', message: 'unreported relation delta' })
    ]);

    expect(result).toMatchObject({
      kind: 'trackRuntimeCommit',
      runtime,
      source: runtime.source,
      supported: true,
      status: 'accepted',
      patches: 1,
      applied: 1,
      version: 1,
      diagnostics: []
    });
    if (!result.supported) {
      throw new Error('expected supported runtime commit result');
    }
    expect(result.changes).toMatchObject([
      {
        id: handle.id,
        changed: false,
        rows: [{ id: 'todo-a', title: 'Alpha' }],
        diagnostics: []
      }
    ]);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      id: handle.id,
      changed: false,
      rows: [{ id: 'todo-a', title: 'Alpha' }]
    });
  });
});
