import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  composeRelationRuntimes,
  isRelationAdapter,
  isRelationRuntime,
  relationApplyResultFromAdapterCommit,
  tryCommitAdapter,
  tryApplyRelationPatches,
  type AdapterCommitReport,
  type AdapterCommitStatus,
  type AdapterCommitResult,
  type AdapterSource,
  type RelationAdapter,
  type RelationApplyReport,
  type RelationApplyStatus,
  type RelationRuntime,
  type TarstateDiagnostic,
  type WritePatch
} from '@tarstate/core/adapter';
import { booleanField, defineSchema, idField, relation, stringField } from '@tarstate/core/schema';
import { write } from '@tarstate/core/write';

type Todo = {
  readonly id: string;
  readonly text: string;
  readonly done: boolean;
};

type Presence = {
  readonly id: string;
  readonly targetTodoId: string;
};

const schema = defineSchema({
  todos: relation<Todo>({
    key: 'id',
    fields: {
      id: idField('todo'),
      text: stringField(),
      done: booleanField()
    }
  }),
  presence: relation<Presence>({
    ephemeral: true,
    key: 'id',
    fields: {
      id: idField('presence'),
      targetTodoId: idField('todo')
    }
  })
});

const todos = write(schema.todos);
const presence = write(schema.presence);

type CommitSemantics = 'atomic' | 'partial';

describe('tarstate adapter contract', () => {
  it('exposes commit status as the result discriminator', () => {
    expectTypeOf<AdapterCommitResult<number>['status']>().toEqualTypeOf<AdapterCommitStatus>();
    expectTypeOf<AdapterCommitReport<number>['source']>().toEqualTypeOf<AdapterSource<number>>();
    expectTypeOf<RelationApplyReport<number>['source']>().toEqualTypeOf<AdapterSource<number>>();
    expectTypeOf<RelationApplyStatus>().toEqualTypeOf<'accepted' | 'partial' | 'rejected'>();

    const rejected: AdapterCommitResult<number> = {
      status: 'rejected',
      committed: false,
      patches: 1,
      applied: 0,
      deltas: [],
      diagnostics: [missingRowDiagnostic('todo-missing')],
      version: 0
    };

    if (rejected.status === 'rejected') {
      expectTypeOf(rejected.committed).toEqualTypeOf<false>();
      expectTypeOf(rejected.applied).toEqualTypeOf<0>();
      expectTypeOf(rejected.deltas).toEqualTypeOf<readonly []>();
    }
  });

  it('bridges adapter commit results to relation apply results', () => {
    const version = { revision: 3 };
    const delta = {
      relation: schema.todos,
      added: [{ id: 'todo-a', text: 'Buy oat milk', done: true }],
      removed: [{ id: 'todo-a', text: 'Buy oat milk', done: false }]
    };
    const partialDiagnostics = [missingRowDiagnostic('todo-missing')];
    const rejectedDiagnostics = [missingRowDiagnostic('todo-missing')];

    const committed = relationApplyResultFromAdapterCommit({
      status: 'committed',
      committed: true,
      patches: 1,
      applied: 1,
      deltas: [delta],
      diagnostics: [],
      version
    });

    expect(committed).toEqual({
      status: 'accepted',
      accepted: true,
      patches: 1,
      applied: 1,
      deltas: [delta],
      diagnostics: [],
      version
    });
    expect('committed' in committed).toBe(false);
    expect(committed.version).toBe(version);

    const partial = relationApplyResultFromAdapterCommit({
      status: 'partial',
      committed: false,
      patches: 2,
      applied: 1,
      deltas: [delta],
      diagnostics: partialDiagnostics,
      version
    });

    expect(partial).toEqual({
      status: 'partial',
      accepted: false,
      patches: 2,
      applied: 1,
      deltas: [delta],
      diagnostics: partialDiagnostics,
      version
    });
    expect(partial.diagnostics).toBe(partialDiagnostics);
    expect(partial.version).toBe(version);

    const rejected = relationApplyResultFromAdapterCommit({
      status: 'rejected',
      committed: false,
      patches: 2,
      applied: 99,
      deltas: [delta],
      diagnostics: rejectedDiagnostics,
      version
    } as unknown as AdapterCommitResult<typeof version>);

    expect(rejected).toEqual({
      status: 'rejected',
      accepted: false,
      patches: 2,
      applied: 0,
      deltas: [],
      diagnostics: rejectedDiagnostics,
      version
    });
    expect('committed' in rejected).toBe(false);
    expect(rejected.diagnostics).toBe(rejectedDiagnostics);
    expect(rejected.version).toBe(version);

    if (rejected.status === 'rejected') {
      expectTypeOf(rejected.applied).toEqualTypeOf<0>();
      expectTypeOf(rejected.deltas).toEqualTypeOf<readonly []>();
    }
  });

  it('normalizes generic relation runtime patch application', async () => {
    let version = 0;
    const source: AdapterSource<number> = {
      rows: () => [],
      version: () => version
    };
    const runtime: RelationRuntime<number> = {
      source,
      target: {
        apply: async () => {
          version += 1;
          return {
            status: 'accepted',
            accepted: true,
            patches: 99,
            applied: 99,
            deltas: [],
            diagnostics: [],
            durability: 'ephemeral'
          };
        }
      }
    };

    expect(isRelationRuntime(runtime)).toBe(true);

    const result = await tryApplyRelationPatches(runtime, [
      todos.insert({ id: 'todo-a', text: 'Buy oat milk', done: false })
    ]);

    expect(result).toEqual({
      source,
      status: 'accepted',
      accepted: true,
      patches: 1,
      applied: 99,
      deltas: [],
      diagnostics: [],
      durability: 'ephemeral',
      version: 1
    });
  });

  it('rejects generic relation runtime application when no target is present', async () => {
    const runtime: RelationRuntime<number> = {
      source: {
        rows: () => [],
        version: () => 1
      }
    };

    const result = await tryApplyRelationPatches(runtime, [
      todos.insert({ id: 'todo-a', text: 'Buy oat milk', done: false })
    ]);

    expect(result).toMatchObject({
      status: 'rejected',
      accepted: false,
      patches: 1,
      applied: 0,
      deltas: [],
      version: 1,
      diagnostics: [
        {
          code: 'source_error',
          message: 'relation runtime does not support applying patches'
        }
      ]
    });
  });

  it('composes relation runtimes and routes patches by relation ownership', async () => {
    let todoVersion = 0;
    let presenceVersion = 0;
    const todoPatches: WritePatch[] = [];
    const presencePatches: WritePatch[] = [];
    const todoRuntime: RelationRuntime<number> = {
      source: {
        relationNames: [schema.todos.name],
        rows: () => [],
        version: () => todoVersion
      },
      target: {
        apply: (patches) => {
          todoPatches.push(...patches);
          todoVersion += 1;
          return {
            status: 'accepted',
            accepted: true,
            patches: patches.length,
            applied: patches.length,
            deltas: [],
            diagnostics: []
          };
        }
      }
    };
    const presenceRuntime: RelationRuntime<number> = {
      source: {
        relationNames: [schema.presence.name],
        rows: () => [],
        version: () => presenceVersion
      },
      target: {
        apply: (patches) => {
          presencePatches.push(...patches);
          presenceVersion += 1;
          return {
            status: 'accepted',
            accepted: true,
            patches: patches.length,
            applied: patches.length,
            deltas: [],
            diagnostics: [],
            durability: 'ephemeral'
          };
        }
      }
    };
    const runtime = composeRelationRuntimes(todoRuntime, presenceRuntime);

    expect(runtime.source.relationNames).toEqual(['todos', 'presence']);
    const initialVersion = await runtime.source.version?.();
    expect(initialVersion).toEqual([0, 0]);
    expect(await runtime.source.version?.()).toBe(initialVersion);

    const todoPatch = todos.insert({ id: 'todo-a', text: 'Buy oat milk', done: false });
    const presencePatch = presence.insert({ id: 'peer-a', targetTodoId: 'todo-a' });
    const result = await tryApplyRelationPatches(runtime, [todoPatch, presencePatch]);

    expect(todoPatches).toEqual([todoPatch]);
    expect(presencePatches).toEqual([presencePatch]);
    expect(result).toMatchObject({
      status: 'accepted',
      accepted: true,
      patches: 2,
      applied: 2,
      diagnostics: [],
      version: [1, 1]
    });
    const nextVersion = await runtime.source.version?.();
    expect(nextVersion).toEqual([1, 1]);
    expect(nextVersion).not.toBe(initialVersion);
    expect(result.version).toBe(nextVersion);
    expect(await runtime.source.version?.()).toBe(nextVersion);
  });

  it('reuses composed runtime snapshot version identity for its snapshot source', async () => {
    const todoVersion = { revision: 'todos-1' };
    const presenceVersion = { revision: 'presence-1' };
    const runtime = composeRelationRuntimes(
      {
        source: {
          relationNames: [schema.todos.name],
          rows: () => [],
          version: () => ({ revision: 'todos-live' })
        },
        snapshot: () => ({
          source: {
            relationNames: [schema.todos.name],
            rows: () => [],
            version: () => todoVersion
          },
          version: todoVersion
        })
      },
      {
        source: {
          relationNames: [schema.presence.name],
          rows: () => [],
          version: () => ({ revision: 'presence-live' })
        },
        snapshot: () => ({
          source: {
            relationNames: [schema.presence.name],
            rows: () => [],
            version: () => presenceVersion
          },
          version: presenceVersion
        })
      }
    );
    const snapshot = runtime.snapshot?.();
    const snapshotSourceVersion = await snapshot?.source.version?.();

    expect(snapshot?.version).toEqual([todoVersion, presenceVersion]);
    expect(snapshotSourceVersion).toBe(snapshot?.version);
    expect(await snapshot?.source.version?.()).toBe(snapshot?.version);
  });

  it('withholds composed runtime source versions when any child version is unknown', async () => {
    const versionedRuntime: RelationRuntime<number> = {
      source: {
        relationNames: [schema.todos.name],
        rows: () => [],
        version: () => 1
      }
    };
    const unversionedRuntime: RelationRuntime = {
      source: {
        relationNames: [schema.presence.name],
        rows: () => []
      }
    };
    const unknownVersionRuntime: RelationRuntime<number> = {
      source: {
        relationNames: [schema.presence.name],
        rows: () => [],
        version: () => undefined
      }
    };
    const runtime = composeRelationRuntimes(versionedRuntime, unversionedRuntime);
    const unknownRuntime = composeRelationRuntimes(versionedRuntime, unknownVersionRuntime);
    const snapshot = runtime.snapshot?.();

    expect(runtime.source.version).toBeUndefined();
    expect(snapshot?.version).toBeUndefined();
    expect(snapshot?.source.version).toBeUndefined();
    expect(await unknownRuntime.source.version?.()).toBeUndefined();
    expect(unknownRuntime.snapshot?.().source.version).toBeUndefined();
  });

  it('rejects composed runtime writes when relation ownership is ambiguous', async () => {
    const runtime = composeRelationRuntimes(
      {
        source: { relationNames: [schema.todos.name], rows: () => [] },
        target: {
          apply: () => {
            throw new Error('first target should not be called');
          }
        }
      },
      {
        source: { relationNames: [schema.todos.name], rows: () => [] },
        target: {
          apply: () => {
            throw new Error('second target should not be called');
          }
        }
      }
    );

    const result = await tryApplyRelationPatches(runtime, [
      todos.insert({ id: 'todo-a', text: 'Buy oat milk', done: false })
    ]);

    expect(result).toMatchObject({
      status: 'rejected',
      accepted: false,
      patches: 1,
      applied: 0,
      deltas: [],
      diagnostics: [
        {
          code: 'source_error',
          relation: 'todos',
          message: 'no unambiguous relation runtime target owns relation todos'
        }
      ]
    });
  });

  it('lets a custom non-object-backed adapter apply patches and expose rows, lookups, versions, and deltas', async () => {
    const adapter = new MapTodoAdapter([{ id: 'todo-a', text: 'Buy oat milk', done: false }]);

    expectTypeOf(adapter).toMatchTypeOf<RelationAdapter<number>>();
    expect(isRelationAdapter(adapter)).toBe(true);
    expect(await adapter.source.version?.()).toBe(0);
    expect(await adapter.source.lookup?.({ relation: schema.todos, field: 'id', value: 'todo-a' })).toEqual([
      { id: 'todo-a', text: 'Buy oat milk', done: false }
    ]);

    const result = adapter.commit([
      todos.insert({ id: 'todo-b', text: 'Water basil', done: false }),
      todos.update('todo-a', { done: true })
    ]);

    expect(result).toEqual({
      status: 'committed',
      committed: true,
      patches: 2,
      applied: 2,
      version: 1,
      deltas: [
        {
          relation: schema.todos,
          added: [
            { id: 'todo-b', text: 'Water basil', done: false },
            { id: 'todo-a', text: 'Buy oat milk', done: true }
          ],
          removed: [{ id: 'todo-a', text: 'Buy oat milk', done: false }]
        }
      ],
      diagnostics: []
    });
    expect(Array.from(await adapter.source.rows(schema.todos))).toEqual([
      { id: 'todo-a', text: 'Buy oat milk', done: true },
      { id: 'todo-b', text: 'Water basil', done: false }
    ]);
  });

  it('pins atomic adapter rejection semantics across applied count, deltas, diagnostics, and version', async () => {
    const adapter = new MapTodoAdapter([{ id: 'todo-a', text: 'Buy oat milk', done: false }]);

    const result = adapter.commit([todos.update('todo-a', { done: true }), todos.delete('todo-missing')]);

    expect(result).toMatchObject({
      status: 'rejected',
      committed: false,
      patches: 2,
      applied: 0,
      deltas: [],
      version: 0
    });
    expect(result.diagnostics).toMatchObject([{ code: 'missing_ref', key: 'todo-missing' }]);
    expect(Array.from(await adapter.source.rows(schema.todos))).toEqual([
      { id: 'todo-a', text: 'Buy oat milk', done: false }
    ]);
    expect(await adapter.source.version?.()).toBe(0);
  });

  it('pins partial adapter commit semantics across applied count, deltas, diagnostics, and version', async () => {
    const adapter = new MapTodoAdapter([{ id: 'todo-a', text: 'Buy oat milk', done: false }], 'partial');

    const result = adapter.commit([todos.update('todo-a', { done: true }), todos.delete('todo-missing')]);

    expect(result).toMatchObject({
      status: 'partial',
      committed: false,
      patches: 2,
      applied: 1,
      version: 1
    });
    expect(result.deltas).toEqual([
      {
        relation: schema.todos,
        added: [{ id: 'todo-a', text: 'Buy oat milk', done: true }],
        removed: [{ id: 'todo-a', text: 'Buy oat milk', done: false }]
      }
    ]);
    expect(result.diagnostics).toMatchObject([{ code: 'missing_ref', key: 'todo-missing' }]);
    expect(Array.from(await adapter.source.rows(schema.todos))).toEqual([
      { id: 'todo-a', text: 'Buy oat milk', done: true }
    ]);
    expect(await adapter.source.version?.()).toBe(1);
  });

  it('normalizes rejected helper results to no reflected effects and attaches source identity', async () => {
    const source: AdapterSource<number> = {
      rows: () => [],
      version: async () => 7
    };
    const adapter: RelationAdapter<number> = {
      source,
      commit: async (_patches) =>
        ({
          status: 'rejected',
          committed: true,
          patches: 99,
          applied: 1,
          deltas: [
            {
              relation: schema.todos,
              added: [{ id: 'todo-a', text: 'Buy oat milk', done: true }],
              removed: []
            }
          ],
          diagnostics: [missingRowDiagnostic('todo-missing')]
        }) as unknown as AdapterCommitResult<number>
    };

    const result = await tryCommitAdapter(adapter, [todos.delete('todo-missing')]);

    expect(result.source).toBe(source);
    expect(result).toMatchObject({
      status: 'rejected',
      committed: false,
      patches: 1,
      applied: 0,
      deltas: [],
      version: 7
    });
    expect(result.diagnostics).toMatchObject([{ code: 'missing_ref', key: 'todo-missing' }]);
  });

  it('preserves adapter-owned partial helper semantics', async () => {
    const adapter = new MapTodoAdapter([{ id: 'todo-a', text: 'Buy oat milk', done: false }], 'partial');

    const result = await tryCommitAdapter(adapter, [
      todos.update('todo-a', { done: true }),
      todos.delete('todo-missing')
    ]);

    expect(result.source).toBe(adapter.source);
    expect(result).toMatchObject({
      status: 'partial',
      committed: false,
      patches: 2,
      applied: 1,
      version: 1
    });
    expect(result.deltas).toEqual([
      {
        relation: schema.todos,
        added: [{ id: 'todo-a', text: 'Buy oat milk', done: true }],
        removed: [{ id: 'todo-a', text: 'Buy oat milk', done: false }]
      }
    ]);
    expect(result.diagnostics).toMatchObject([{ code: 'missing_ref', key: 'todo-missing' }]);
  });

  it('returns a rejected helper report when adapter commit throws without changing raw commit behavior', async () => {
    const commitError = new Error('write store unavailable');
    const adapter: RelationAdapter<number> = {
      source: {
        rows: () => [],
        version: () => {
          throw new Error('version should not be read');
        }
      },
      commit: () => {
        throw commitError;
      }
    };
    const patches = [todos.update('todo-a', { done: true }), todos.delete('todo-b')];

    expect(() => adapter.commit(patches)).toThrow('write store unavailable');

    const result = await tryCommitAdapter(adapter, patches, { readVersion: false });

    expect(result.source).toBe(adapter.source);
    expect(result).toMatchObject({
      status: 'rejected',
      committed: false,
      patches: 2,
      applied: 0,
      deltas: []
    });
    expect(result.version).toBeUndefined();
    expect(result.diagnostics).toMatchObject([
      {
        code: 'source_error',
        message: 'adapter commit failed'
      }
    ]);
    expect(result.diagnostics[0]?.detail).toBe(commitError);
  });

  it('returns a rejected helper report when adapter commit rejects and preserves source version fallback', async () => {
    const commitError = new Error('commit rejected');
    const adapter: RelationAdapter<number> = {
      source: {
        rows: () => [],
        version: async () => 7
      },
      commit: async () => {
        throw commitError;
      }
    };

    const result = await tryCommitAdapter(adapter, [todos.delete('todo-missing')]);

    expect(result.source).toBe(adapter.source);
    expect(result).toMatchObject({
      status: 'rejected',
      committed: false,
      patches: 1,
      applied: 0,
      deltas: [],
      version: 7
    });
    expect(result.diagnostics).toMatchObject([
      {
        code: 'source_error',
        message: 'adapter commit failed'
      }
    ]);
    expect(result.diagnostics[0]?.detail).toBe(commitError);
  });

  it('keeps commit failure diagnostics ahead of source version fallback failures', async () => {
    const commitError = new Error('commit rejected');
    const versionError = new Error('version unavailable');
    const adapter: RelationAdapter<number> = {
      source: {
        rows: () => [],
        version: async () => {
          throw versionError;
        }
      },
      commit: async () => {
        throw commitError;
      }
    };

    const result = await tryCommitAdapter(adapter, []);

    expect(result).toMatchObject({
      status: 'rejected',
      committed: false,
      patches: 0,
      applied: 0,
      deltas: []
    });
    expect(result.version).toBeUndefined();
    expect(result.diagnostics).toMatchObject([
      {
        code: 'source_error',
        message: 'adapter commit failed'
      },
      {
        code: 'source_error',
        message: 'adapter source version failed'
      }
    ]);
    expect(result.diagnostics[0]?.detail).toBe(commitError);
    expect(result.diagnostics[1]?.detail).toBe(versionError);
  });

  it('derives missing helper status without reading source version when disabled', async () => {
    const delta = {
      relation: schema.todos,
      added: [{ id: 'todo-a', text: 'Buy oat milk', done: true }],
      removed: [{ id: 'todo-a', text: 'Buy oat milk', done: false }]
    };
    const adapter: RelationAdapter<number> = {
      source: {
        rows: () => [],
        version: () => {
          throw new Error('version should not be read');
        }
      },
      commit: () =>
        ({
          status: undefined,
          committed: false,
          patches: 99,
          applied: 1,
          deltas: [delta],
          diagnostics: []
        }) as unknown as AdapterCommitResult<number>
    };

    const result = await tryCommitAdapter(adapter, [todos.update('todo-a', { done: true })], {
      readVersion: false
    });

    expect(result.status).toBe('partial');
    expect(result.committed).toBe(false);
    expect(result.patches).toBe(1);
    expect(result.applied).toBe(1);
    expect(result.deltas).toEqual([delta]);
    expect(result.version).toBeUndefined();
  });

  it('reports source version fallback failures without changing commit status', async () => {
    const adapter: RelationAdapter<number> = {
      source: {
        rows: () => [],
        version: async () => {
          throw new Error('version unavailable');
        }
      },
      commit: () => ({
        status: 'committed',
        committed: true,
        patches: 0,
        applied: 0,
        deltas: [],
        diagnostics: []
      })
    };

    const result = await tryCommitAdapter(adapter, []);

    expect(result).toMatchObject({
      status: 'committed',
      committed: true,
      patches: 0,
      applied: 0,
      deltas: []
    });
    expect(result.version).toBeUndefined();
    expect(result.diagnostics).toMatchObject([
      {
        code: 'source_error',
        message: 'adapter source version failed'
      }
    ]);
  });
});

class MapTodoAdapter implements RelationAdapter<number> {
  private rowsById = new Map<string, Todo>();
  private versionId = 0;

  readonly source: AdapterSource<number> = {
    relationNames: [schema.todos.name],
    rows: (relationRef) => (relationRef.name === schema.todos.name ? this.rowsById.values() : []),
    lookup: ({ relation: relationRef, field, value }) => {
      if (relationRef.name !== schema.todos.name || field !== 'id') {
        return undefined;
      }

      const row = typeof value === 'string' ? this.rowsById.get(value) : undefined;
      return row === undefined ? [] : [row];
    },
    version: () => this.versionId,
    diagnostics: () => []
  };

  constructor(
    seedRows: readonly Todo[],
    private readonly commitSemantics: CommitSemantics = 'atomic'
  ) {
    for (const row of seedRows) {
      this.rowsById.set(row.id, row);
    }
  }

  commit = (patches: readonly WritePatch[]): AdapterCommitResult<number> => {
    const patchList = [...patches];
    const stagedRows = new Map(this.rowsById);
    const added: Todo[] = [];
    const removed: Todo[] = [];
    const diagnostics: TarstateDiagnostic[] = [];
    let stagedApplied = 0;

    for (const patch of patchList) {
      if (patch.relation.name !== schema.todos.name) {
        diagnostics.push({
          code: 'source_error',
          message: `adapter does not own relation ${patch.relation.name}`,
          relation: patch.relation.name
        });
        continue;
      }

      switch (patch.op) {
        case 'insert':
          stagedApplied += stageInsert(stagedRows, added, diagnostics, patch.row, patch.onConflict);
          break;
        case 'update':
          stagedApplied += stageUpdate(stagedRows, added, removed, diagnostics, patch.key, patch.changes);
          break;
        case 'upsert':
          stagedApplied += stageUpsert(stagedRows, added, removed, diagnostics, patch.row, patch.mode);
          break;
        case 'delete':
          stagedApplied += stageDelete(stagedRows, removed, diagnostics, patch.key);
          break;
        case 'deleteExact':
          stagedApplied += stageDeleteExact(stagedRows, removed, diagnostics, patch.row);
          break;
        case 'replaceAll':
          stagedApplied += stageReplaceAll(stagedRows, added, removed, diagnostics, patch.rows);
          break;
      }
    }

    if (diagnostics.length > 0) {
      if (this.commitSemantics === 'partial' && stagedApplied > 0) {
        this.rowsById = stagedRows;
        this.versionId += 1;

        return {
          status: 'partial',
          committed: false,
          patches: patchList.length,
          applied: stagedApplied,
          deltas: added.length === 0 && removed.length === 0 ? [] : [{ relation: schema.todos, added, removed }],
          diagnostics,
          version: this.versionId
        };
      }

      return {
        status: 'rejected',
        committed: false,
        patches: patchList.length,
        applied: 0,
        deltas: [],
        diagnostics,
        version: this.versionId
      };
    }

    this.rowsById = stagedRows;
    this.versionId += 1;

    return {
      status: 'committed',
      committed: true,
      patches: patchList.length,
      applied: stagedApplied,
      deltas: added.length === 0 && removed.length === 0 ? [] : [{ relation: schema.todos, added, removed }],
      diagnostics: [],
      version: this.versionId
    };
  };
}

function stageInsert(
  rowsById: Map<string, Todo>,
  added: Todo[],
  diagnostics: TarstateDiagnostic[],
  row: unknown,
  onConflict: 'error' | 'ignore' | undefined
): number {
  if (!isTodo(row)) {
    diagnostics.push(invalidRowDiagnostic(row));
    return 0;
  }

  if (rowsById.has(row.id)) {
    if (onConflict === 'ignore') {
      return 1;
    }

    diagnostics.push(duplicateDiagnostic(row.id));
    return 0;
  }

  rowsById.set(row.id, row);
  added.push(row);
  return 1;
}

function stageUpdate(
  rowsById: Map<string, Todo>,
  added: Todo[],
  removed: Todo[],
  diagnostics: TarstateDiagnostic[],
  key: unknown,
  changes: unknown
): number {
  const id = keyId(key);
  const previous = id === undefined ? undefined : rowsById.get(id);

  if (id === undefined || previous === undefined || !isRecord(changes)) {
    diagnostics.push(missingRowDiagnostic(id));
    return 0;
  }

  const next = { ...previous, ...changes };

  if (!isTodo(next)) {
    diagnostics.push(invalidRowDiagnostic(next));
    return 0;
  }

  rowsById.set(id, next);
  removed.push(previous);
  added.push(next);
  return 1;
}

function stageUpsert(
  rowsById: Map<string, Todo>,
  added: Todo[],
  removed: Todo[],
  diagnostics: TarstateDiagnostic[],
  row: unknown,
  mode: 'replace' | 'merge' | undefined
): number {
  if (!isRecord(row) || typeof row.id !== 'string') {
    diagnostics.push(invalidRowDiagnostic(row));
    return 0;
  }

  const previous = rowsById.get(row.id);
  const next = mode === 'merge' && previous !== undefined ? { ...previous, ...row } : row;

  if (!isTodo(next)) {
    diagnostics.push(invalidRowDiagnostic(next));
    return 0;
  }

  if (previous !== undefined) {
    removed.push(previous);
  }

  rowsById.set(next.id, next);
  added.push(next);
  return 1;
}

function stageDelete(
  rowsById: Map<string, Todo>,
  removed: Todo[],
  diagnostics: TarstateDiagnostic[],
  key: unknown
): number {
  const id = keyId(key);
  const previous = id === undefined ? undefined : rowsById.get(id);

  if (id === undefined || previous === undefined) {
    diagnostics.push(missingRowDiagnostic(id));
    return 0;
  }

  rowsById.delete(id);
  removed.push(previous);
  return 1;
}

function stageDeleteExact(
  rowsById: Map<string, Todo>,
  removed: Todo[],
  diagnostics: TarstateDiagnostic[],
  row: unknown
): number {
  if (!isTodo(row)) {
    diagnostics.push(invalidRowDiagnostic(row));
    return 0;
  }

  const previous = rowsById.get(row.id);

  if (previous === undefined) {
    diagnostics.push(missingRowDiagnostic(row.id));
    return 0;
  }

  if (!sameTodo(previous, row)) {
    diagnostics.push(invalidRowDiagnostic(row));
    return 0;
  }

  rowsById.delete(row.id);
  removed.push(previous);
  return 1;
}

function stageReplaceAll(
  rowsById: Map<string, Todo>,
  added: Todo[],
  removed: Todo[],
  diagnostics: TarstateDiagnostic[],
  rows: readonly unknown[]
): number {
  const nextRows = new Map<string, Todo>();
  const previousDiagnostics = diagnostics.length;

  for (const row of rows) {
    if (!isTodo(row)) {
      diagnostics.push(invalidRowDiagnostic(row));
      continue;
    }

    if (nextRows.has(row.id)) {
      diagnostics.push(duplicateDiagnostic(row.id));
      continue;
    }

    nextRows.set(row.id, row);
  }

  if (diagnostics.length > previousDiagnostics) {
    return 0;
  }

  removed.push(...rowsById.values());
  added.push(...nextRows.values());
  rowsById.clear();

  for (const [id, row] of nextRows) {
    rowsById.set(id, row);
  }

  return 1;
}

function keyId(key: unknown): string | undefined {
  if (typeof key === 'string') {
    return key;
  }

  return isRecord(key) && typeof key.id === 'string' ? key.id : undefined;
}

function isTodo(input: unknown): input is Todo {
  return (
    isRecord(input) &&
    typeof input.id === 'string' &&
    typeof input.text === 'string' &&
    typeof input.done === 'boolean'
  );
}

function sameTodo(left: Todo, right: Todo): boolean {
  return left.id === right.id && left.text === right.text && left.done === right.done;
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === 'object' && input !== null && !Array.isArray(input);
}

function invalidRowDiagnostic(row: unknown): TarstateDiagnostic {
  return {
    code: 'invalid_row',
    message: 'todo adapter received an invalid row',
    relation: schema.todos.name,
    detail: row
  };
}

function duplicateDiagnostic(id: string): TarstateDiagnostic {
  return {
    code: 'duplicate_key',
    message: `todo ${id} already exists`,
    relation: schema.todos.name,
    field: 'id',
    key: id
  };
}

function missingRowDiagnostic(id: string | undefined): TarstateDiagnostic {
  const diagnostic: TarstateDiagnostic = {
    code: 'missing_ref',
    message: id === undefined ? 'todo key is missing' : `todo ${id} does not exist`,
    relation: schema.todos.name,
    field: 'id'
  };

  return id === undefined ? diagnostic : { ...diagnostic, key: id };
}
