import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  composeRelationRuntimes,
  isRelationAdapter,
  isRelationRuntime,
  tryCommitAdapter,
  tryApplyRelationPatches,
  type AdapterCommitReport,
  type AdapterCommitStatus,
  type AdapterCommitResult,
  type AdapterSource,
  type RelationAdapter,
  type RelationApplyReport,
  type RelationApplyStatus,
  type RelationPatchTarget,
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
    expectTypeOf<RelationPatchTarget<number>['relationNames']>().toEqualTypeOf<readonly string[] | undefined>();
    expectTypeOf<RelationPatchTarget<number>['ownsRelation']>().toEqualTypeOf<
      ((relationName: string) => boolean) | undefined
    >();

    const rejected: AdapterCommitResult<number> = {
      status: 'rejected',
      patches: 1,
      applied: 0,
      deltas: [],
      diagnostics: [missingRowDiagnostic('todo-missing')],
      version: 0
    };

    if (rejected.status === 'rejected') {
      expectTypeOf(rejected.applied).toEqualTypeOf<0>();
    }
  });

  it('validates relation target ownership metadata at runtime', () => {
    expect(isRelationRuntime({
      source: { rows: () => [] },
      target: {
        relationNames: [schema.todos.name],
        ownsRelation: (relationName: string) => relationName === schema.todos.name,
        apply: () => ({
          status: 'accepted',
          patches: 0,
          applied: 0,
          deltas: [],
          diagnostics: []
        })
      }
    })).toBe(true);

    expect(isRelationRuntime({
      source: { rows: () => [] },
      target: {
        relationNames: [schema.todos.name, 1],
        apply: () => ({
          status: 'accepted',
          patches: 0,
          applied: 0,
          deltas: [],
          diagnostics: []
        })
      }
    })).toBe(false);

    expect(isRelationRuntime({
      source: { rows: () => [] },
      target: {
        ownsRelation: true,
        apply: () => ({
          status: 'accepted',
          patches: 0,
          applied: 0,
          deltas: [],
          diagnostics: []
        })
      }
    })).toBe(false);
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
      patches: 1,
      applied: 0,
      deltas: [],
      version: 1,
      diagnostics: [
        {
          code: 'source_error'
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
        relationNames: [schema.todos.name],
        apply: (patches) => {
          todoPatches.push(...patches);
          todoVersion += 1;
          return {
            status: 'accepted',
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
        relationNames: [schema.presence.name],
        apply: (patches) => {
          presencePatches.push(...patches);
          presenceVersion += 1;
          return {
            status: 'accepted',
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
          relationNames: [schema.todos.name],
          apply: () => {
            throw new Error('first target should not be called');
          }
        }
      },
      {
        source: { relationNames: [schema.todos.name], rows: () => [] },
        target: {
          relationNames: [schema.todos.name],
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
      patches: 1,
      applied: 0,
      deltas: [],
      diagnostics: [
        {
          code: 'source_error',
          relation: 'todos'
        }
      ]
    });
  });

  it('routes composed runtime writes by target relation ownership', async () => {
    const todoPatches: WritePatch[] = [];
    const presencePatches: WritePatch[] = [];
    const runtime = composeRelationRuntimes(
      {
        source: { rows: () => [] },
        target: {
          relationNames: [schema.presence.name],
          apply: (patches) => {
            presencePatches.push(...patches);
            return {
              status: 'accepted',
              patches: patches.length,
              applied: patches.length,
              deltas: [],
              diagnostics: []
            };
          }
        }
      },
      {
        source: { rows: () => [] },
        target: {
          ownsRelation: (relationName) => relationName === schema.todos.name,
          apply: (patches) => {
            todoPatches.push(...patches);
            return {
              status: 'accepted',
              patches: patches.length,
              applied: patches.length,
              deltas: [],
              diagnostics: []
            };
          }
        }
      }
    );

    const todoPatch = todos.insert({ id: 'todo-a', text: 'Buy oat milk', done: false });
    const presencePatch = presence.insert({ id: 'peer-a', targetTodoId: 'todo-a' });
    const result = await tryApplyRelationPatches(runtime, [todoPatch, presencePatch]);

    expect(result).toMatchObject({
      status: 'accepted',
      patches: 2,
      applied: 2,
      diagnostics: []
    });
    expect(todoPatches).toEqual([todoPatch]);
    expect(presencePatches).toEqual([presencePatch]);
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
      todos.updateByKey('todo-a', { done: true })
    ]);

    expect(result).toEqual({
      status: 'accepted',
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

  it('reports atomic adapter rejection semantics across applied count, deltas, diagnostics, and version', async () => {
    const adapter = new MapTodoAdapter([{ id: 'todo-a', text: 'Buy oat milk', done: false }]);

    const result = adapter.commit([todos.updateByKey('todo-a', { done: true }), todos.deleteByKey('todo-missing')]);

    expect(result).toMatchObject({
      status: 'rejected',
      patches: 2,
      applied: 0,
      version: 0
    });
    expect(result.diagnostics).toMatchObject([{ code: 'missing_ref' }]);
    expect(Array.from(await adapter.source.rows(schema.todos))).toEqual([
      { id: 'todo-a', text: 'Buy oat milk', done: false }
    ]);
    expect(await adapter.source.version?.()).toBe(0);
  });

  it('reports partial adapter commit semantics across applied count, diagnostics, and version', async () => {
    const adapter = new MapTodoAdapter([{ id: 'todo-a', text: 'Buy oat milk', done: false }], 'partial');

    const result = adapter.commit([todos.updateByKey('todo-a', { done: true }), todos.deleteByKey('todo-missing')]);

    expect(result).toMatchObject({
      status: 'partial',
      patches: 2,
      applied: 1,
      version: 1
    });
    expect(result.diagnostics).toMatchObject([{ code: 'missing_ref' }]);
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

    const result = await tryCommitAdapter(adapter, [todos.deleteByKey('todo-missing')]);

    expect(result.source).toBe(source);
    expect(result).toMatchObject({
      status: 'rejected',
      patches: 1,
      applied: 0,
      version: 7
    });
    expect(result.diagnostics).toMatchObject([{ code: 'missing_ref' }]);
  });

  it('preserves adapter-owned partial helper semantics', async () => {
    const adapter = new MapTodoAdapter([{ id: 'todo-a', text: 'Buy oat milk', done: false }], 'partial');

    const result = await tryCommitAdapter(adapter, [
      todos.updateByKey('todo-a', { done: true }),
      todos.deleteByKey('todo-missing')
    ]);

    expect(result.source).toBe(adapter.source);
    expect(result).toMatchObject({
      status: 'partial',
      patches: 2,
      applied: 1,
      version: 1
    });
    expect(result.diagnostics).toMatchObject([{ code: 'missing_ref' }]);
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
    const patches = [todos.updateByKey('todo-a', { done: true }), todos.deleteByKey('todo-b')];

    expect(() => adapter.commit(patches)).toThrow(Error);

    const result = await tryCommitAdapter(adapter, patches, { readVersion: false });

    expect(result.source).toBe(adapter.source);
    expect(result).toMatchObject({
      status: 'rejected',
      patches: 2,
      applied: 0,
      deltas: []
    });
    expect(result.version).toBeUndefined();
    expect(result.diagnostics).toMatchObject([
      {
        code: 'source_error'
      }
    ]);
    expect(result.diagnostics).toHaveLength(1);
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
          patches: 99,
          applied: 1,
          deltas: [delta],
          diagnostics: []
        }) as unknown as AdapterCommitResult<number>
    };

    const result = await tryCommitAdapter(adapter, [todos.updateByKey('todo-a', { done: true })], {
      readVersion: false
    });

    expect(result.status).toBe('partial');
    expect(result.patches).toBe(1);
    expect(result.applied).toBe(1);
    expect(result.version).toBeUndefined();
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
          stagedApplied += stageInsert(stagedRows, added, diagnostics, patch.row, false);
          break;
        case 'insertIgnore':
          stagedApplied += stageInsert(stagedRows, added, diagnostics, patch.row, true);
          break;
        case 'insertOrReplace':
          stagedApplied += stageInsertOrReplace(stagedRows, added, removed, diagnostics, patch.row);
          break;
        case 'updateByKey':
          stagedApplied += stageUpdate(stagedRows, added, removed, diagnostics, patch.key, patch.changes);
          break;
        case 'update':
          diagnostics.push({
            code: 'unsupported_expression',
            message: 'predicate update is not supported by this adapter fixture',
            relation: patch.relation.name,
            detail: patch.predicate
          });
          break;
        case 'insertOrMerge':
          stagedApplied += stageInsertOrMerge(stagedRows, added, removed, diagnostics, patch.row);
          break;
        case 'insertOrUpdate':
          stagedApplied += stageInsertOrUpdate(stagedRows, added, removed, diagnostics, patch.row, patch.update);
          break;
        case 'deleteByKey':
          stagedApplied += stageDelete(stagedRows, removed, diagnostics, patch.key);
          break;
        case 'delete':
          diagnostics.push({
            code: 'unsupported_expression',
            message: 'predicate delete is not supported by this adapter fixture',
            relation: patch.relation.name,
            detail: patch.predicate
          });
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
          patches: patchList.length,
          applied: stagedApplied,
          deltas: added.length === 0 && removed.length === 0 ? [] : [{ relation: schema.todos, added, removed }],
          diagnostics,
          version: this.versionId
        };
      }

      return {
        status: 'rejected',
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
      status: 'accepted',
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
  ignoreConflict: boolean
): number {
  if (!isTodo(row)) {
    diagnostics.push(invalidRowDiagnostic(row));
    return 0;
  }

  if (rowsById.has(row.id)) {
    if (ignoreConflict) {
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

function stageInsertOrMerge(
  rowsById: Map<string, Todo>,
  added: Todo[],
  removed: Todo[],
  diagnostics: TarstateDiagnostic[],
  row: unknown
): number {
  if (!isRecord(row) || typeof row.id !== 'string') {
    diagnostics.push(invalidRowDiagnostic(row));
    return 0;
  }

  const previous = rowsById.get(row.id);
  const next = previous === undefined ? row : { ...previous, ...row };

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

function stageInsertOrReplace(
  rowsById: Map<string, Todo>,
  added: Todo[],
  removed: Todo[],
  diagnostics: TarstateDiagnostic[],
  row: unknown
): number {
  if (!isTodo(row)) {
    diagnostics.push(invalidRowDiagnostic(row));
    return 0;
  }

  const previous = rowsById.get(row.id);

  if (previous !== undefined) {
    removed.push(previous);
  }

  rowsById.set(row.id, row);
  added.push(row);
  return 1;
}

function stageInsertOrUpdate(
  rowsById: Map<string, Todo>,
  added: Todo[],
  removed: Todo[],
  diagnostics: TarstateDiagnostic[],
  row: unknown,
  update: unknown
): number {
  if (!isRecord(row) || typeof row.id !== 'string') {
    diagnostics.push(invalidRowDiagnostic(row));
    return 0;
  }

  return rowsById.has(row.id)
    ? stageUpdate(rowsById, added, removed, diagnostics, row.id, update)
    : stageInsert(rowsById, added, diagnostics, row, false);
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
    message: 'invalid todo row',
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
