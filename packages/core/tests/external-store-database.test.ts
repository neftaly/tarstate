import { builtInCapabilityRefs, registerBuiltInCapabilities } from '../src/builtins.js';
import { CapabilityRegistry } from '../src/registry.js';
import { sealConstraintSet } from '../src/constraint-artifact.js';
import {
  mappedRelationRows,
  openExternalStoreDatabase,
  type AtomicExternalStore,
  type HydrationState
} from '../src/database/external-store/index.js';
import { relationLiteral } from '../src/schema-authoring.js';
import { sealSchema } from '../src/schema.js';
import { sealStorageMapping } from '../src/mapping.js';
import { describe, expect, expectTypeOf, it, vi } from 'vitest';

type TaskState = {
  readonly tasks?: Readonly<Record<string, { readonly id: string; readonly title: string }>>;
  readonly archivedTasks?: Readonly<Record<string, { readonly id: string; readonly title: string }>>;
};

const createAtomicStore = <State extends object>(initial: State, initialHydration: HydrationState = 'ready') => {
  let state = initial;
  let hydration = initialHydration;
  const listeners = new Set<() => void>();
  const hydrationListeners = new Set<() => void>();
  let activeSubscriptions = 0;
  const store: AtomicExternalStore<State> = {
    getState: () => state,
    subscribe: (listener) => {
      activeSubscriptions += 1;
      listeners.add(listener);
      return () => {
        if (listeners.delete(listener)) activeSubscriptions -= 1;
      };
    },
    update: (fn) => {
      const next = fn(state);
      if (next.changed) {
        state = next.state;
        for (const listener of listeners) listener();
      }
      return next.result;
    },
    hydration: {
      getState: () => hydration,
      subscribe: (listener) => {
        hydrationListeners.add(listener);
        return () => { hydrationListeners.delete(listener); };
      }
    }
  };
  return {
    store,
    identity: {},
    get state() { return state; },
    get activeSubscriptions() { return activeSubscriptions; },
    externalUpdate(next: State) {
      state = next;
      for (const listener of listeners) listener();
    },
    setHydration(next: HydrationState) {
      hydration = next;
      for (const listener of hydrationListeners) listener();
    }
  };
};

describe('external-store relational database', () => {
  it('opens the ordinary database surface and performs immutable mapped writes', async () => {
    const fixture = await createTaskFixture();
    expect(Object.keys(fixture.database).sort()).toEqual([
      'capabilities', 'close', 'getSnapshot', 'mount', 'simulate', 'subscribe', 'transact'
    ]);
    expect(fixture.database.getSnapshot()).toMatchObject({
      state: 'open',
      current: {
        readiness: 'ready',
        completeness: 'exact',
        rows: [{ relationId: 'tasks', fields: { id: 'first', title: 'First' } }]
      }
    });
    const before = fixture.atomic.state;
    await expect(fixture.database.transact(
      { kind: 'replace-tasks' },
      (snapshot) => snapshot.withRows(fixture.tasks, [
        { id: 'first', title: 'Renamed' },
        { id: 'second', title: 'Second' },
        { id: '__proto__', title: 'Safe data key' }
      ])
    )).resolves.toMatchObject({ outcome: 'committed' });
    expect(Object.keys(fixture.atomic.state.tasks ?? {}).sort()).toEqual([
      '__proto__', 'first', 'second'
    ]);
    expect(fixture.atomic.state.tasks?.first).toEqual({ id: 'first', title: 'Renamed' });
    expect(fixture.atomic.state.tasks?.second).toEqual({ id: 'second', title: 'Second' });
    expect(fixture.atomic.state.tasks?.['__proto__']).toEqual({
      id: '__proto__', title: 'Safe data key'
    });
    expect(Object.getPrototypeOf(fixture.atomic.state.tasks)).toBe(Object.prototype);
    expect(fixture.atomic.state).not.toBe(before);
    expect(fixture.atomic.state.tasks?.first).not.toBe(before.tasks?.first);
    fixture.database.close();
  });

  it('selects schema-verified typed rows without cloning projected row objects', async () => {
    const fixture = await createTaskFixture();
    const snapshot = fixture.database.getSnapshot();
    if (snapshot.state !== 'open') throw new Error('Expected an open database');
    const rows = mappedRelationRows(snapshot.current, fixture.tasks);
    expectTypeOf(rows).toEqualTypeOf<readonly {
      readonly id: string;
      readonly title: string;
    }[]>();
    expect(rows).toEqual([{ id: 'first', title: 'First' }]);
    expect(rows[0]).toBe(snapshot.current.rows[0]?.fields);
    expect(mappedRelationRows(snapshot.current, fixture.tasks)).toBe(rows);
    expect(mappedRelationRows(snapshot.current, fixture.archivedTasks)).toEqual([]);
    expect(Object.isFrozen(rows)).toBe(true);

    const otherSchema = await sealSchema({ id: 'urn:test:other-tasks:schema', body: {
      relations: { tasks: {
        relationId: 'tasks',
        key: ['id'],
        fields: {
          id: { type: { kind: 'string' } },
          title: { type: { kind: 'integer' } }
        }
      } }
    } });
    expect(() => mappedRelationRows(
      snapshot.current,
      relationLiteral(otherSchema, 'tasks')
    )).toThrow('Mapped relation belongs to a different schema view');
    fixture.database.close();
  });

  it('replays after an external exact-basis change without losing either update', async () => {
    const fixture = await createTaskFixture();
    let releaseFirst!: () => void;
    const firstPass = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let passes = 0;
    const transaction = fixture.database.transact(
      { kind: 'rename-first' },
      async (snapshot) => {
        passes += 1;
        if (passes === 1) await firstPass;
        return snapshot.withRows(
          fixture.tasks,
          snapshot.rows(fixture.tasks).map((task) => task.id === 'first'
            ? { ...task, title: 'Renamed' }
            : task)
        );
      }
    );
    await vi.waitFor(() => expect(passes).toBe(1));
    fixture.atomic.externalUpdate({
      tasks: {
        first: { id: 'first', title: 'First' },
        remote: { id: 'remote', title: 'Remote' }
      }
    });
    releaseFirst();
    await expect(transaction).resolves.toMatchObject({ outcome: 'committed' });
    expect(passes).toBeGreaterThanOrEqual(2);
    expect(fixture.atomic.state).toEqual({
      tasks: {
        first: { id: 'first', title: 'Renamed' },
        remote: { id: 'remote', title: 'Remote' }
      }
    });
    fixture.database.close();
  });

  it('preserves hydration lifecycle evidence and shares a runtime lease per identity', async () => {
    const artifacts = await taskArtifacts();
    const atomic = createAtomicStore<TaskState>({ tasks: {} }, 'loading');
    const first = await openTaskDatabase(atomic, artifacts);
    const second = await openTaskDatabase(atomic, artifacts);
    expect(atomic.activeSubscriptions).toBe(1);
    expect(first.getSnapshot()).toMatchObject({
      state: 'open',
      current: { readiness: 'incomplete', sourceState: 'loading', rows: [] }
    });
    atomic.setHydration('failed');
    expect(first.getSnapshot()).toMatchObject({
      state: 'open',
      current: {
        readiness: 'invalid',
        sourceState: 'failed',
        rows: [],
        issues: [{ code: 'source.hydration_failed' }]
      }
    });
    atomic.setHydration('ready');
    expect(first.getSnapshot()).toMatchObject({
      state: 'open', current: { readiness: 'ready', sourceState: 'ready' }
    });
    first.close();
    expect(atomic.activeSubscriptions).toBe(1);
    second.close();
    expect(atomic.activeSubscriptions).toBe(0);
  });

  it('validates constraints before publication', async () => {
    const fixture = await createTaskFixture({ constrained: true });
    await expect(fixture.database.simulate(
      { kind: 'forbid' },
      (snapshot) => snapshot.withRows(fixture.tasks, [{ id: 'first', title: 'Forbidden' }])
    )).resolves.toMatchObject({ outcome: 'rejected', issues: [{ code: 'test.task_invalid' }] });
    await expect(fixture.database.transact(
      { kind: 'forbid' },
      (snapshot) => snapshot.withRows(fixture.tasks, [{ id: 'first', title: 'Forbidden' }])
    )).resolves.toMatchObject({ outcome: 'rejected', issues: [{ code: 'test.task_invalid' }] });
    expect(fixture.atomic.state.tasks?.first?.title).toBe('First');
    fixture.database.close();
  });

  it('rejects source-generated object identity instead of emulating it', async () => {
    const schema = await sealSchema({ id: 'urn:test:external-generated:schema', body: {
      relations: { tasks: {
        relationId: 'tasks',
        key: ['id'],
        fields: {
          id: { type: { kind: 'string' } },
          title: { type: { kind: 'string' } }
        }
      } }
    } });
    const mapping = await sealStorageMapping({ id: 'urn:test:external-generated:mapping', body: {
      schema: reference(schema),
      model: 'json-tree-v1',
      relations: { tasks: {
        collection: { kind: 'array', path: ['tasks'], absent: 'creatable' },
        keys: { id: { kind: 'source-metadata', value: 'collection-element-identity' } },
        fields: {
          title: { path: ['title'], write: { replace: builtInCapabilityRefs.fieldReplace } }
        }
      } }
    } });
    const atomic = createAtomicStore({ tasks: [] as { title: string }[] });
    await expect(openExternalStoreDatabase({
      sourceId: 'source:generated',
      store: atomic.store,
      storeIdentity: atomic.identity,
      declaration: declaration(schema, mapping),
      embeddedArtifacts: [schema, mapping],
      authorityScope: 'scope:test'
    })).resolves.toMatchObject({
      success: false,
      issues: [{ code: 'mapping.source_metadata_unavailable' }]
    });
    expect(atomic.activeSubscriptions).toBe(0);
  });

  it('rejects a writable mapping whose operation has no binding handler', async () => {
    const schema = await sealSchema({ id: 'urn:test:external-splice:schema', body: {
      relations: { tasks: {
        relationId: 'tasks',
        key: ['id'],
        fields: {
          id: { type: { kind: 'string' } },
          title: { type: { kind: 'string' } }
        }
      } }
    } });
    const mapping = await sealStorageMapping({ id: 'urn:test:external-splice:mapping', body: {
      schema: reference(schema),
      model: 'json-tree-v1',
      relations: { tasks: {
        collection: { kind: 'object-map', path: ['tasks'], absent: 'empty' },
        keys: { id: { kind: 'map-key', mirrorPath: ['id'], onMismatch: 'reject' } },
        fields: {
          title: { path: ['title'], write: { textSplice: builtInCapabilityRefs.textSplice } }
        }
      } }
    } });
    const atomic = createAtomicStore({ tasks: { first: { id: 'first', title: 'First' } } });
    const registry = new CapabilityRegistry('test:external-splice');
    await registerBuiltInCapabilities(registry);
    registry.registerImplementation({
      ref: builtInCapabilityRefs.textSplice,
      integrity: 'test:text-splice-v2',
      implementation: Object.freeze({ kind: 'test-text-splice' })
    });

    await expect(openExternalStoreDatabase({
      sourceId: 'source:external-splice',
      store: atomic.store,
      storeIdentity: atomic.identity,
      declaration: declaration(schema, mapping),
      embeddedArtifacts: [schema, mapping],
      authorityScope: 'scope:test',
      registry
    })).resolves.toMatchObject({
      success: false,
      issues: [expect.objectContaining({
        code: 'mapping.binding_incompatible',
        details: { field: 'title', operation: 'text-splice' }
      })]
    });
    expect(atomic.activeSubscriptions).toBe(0);
  });

  it('applies array replacements before descending deletes and appends', async () => {
    const fixture = await createArrayTaskFixture({
      tasks: [
        { id: 'a', title: 'A' },
        { id: 'b', title: 'B' },
        { id: 'c', title: 'C' }
      ]
    });
    await expect(fixture.database.transact(
      { kind: 'rewrite-array' },
      (snapshot) => snapshot.withRows(fixture.tasks, [
        { id: 'b', title: 'B2' },
        { id: 'd', title: 'D' }
      ])
    )).resolves.toMatchObject({ outcome: 'committed' });
    expect(fixture.atomic.state.tasks).toEqual([
      { id: 'b', title: 'B2' },
      { id: 'd', title: 'D' }
    ]);
    fixture.database.close();
  });

  it('creates one absent array collection for multiple inserts', async () => {
    const fixture = await createArrayTaskFixture({});
    await expect(fixture.database.transact(
      { kind: 'create-array' },
      (snapshot) => snapshot.withRows(fixture.tasks, [
        { id: 'a', title: 'A' },
        { id: 'b', title: 'B' }
      ])
    )).resolves.toMatchObject({ outcome: 'committed' });
    expect(fixture.atomic.state.tasks).toEqual([
      { id: 'a', title: 'A' },
      { id: 'b', title: 'B' }
    ]);
    fixture.database.close();
  });
});

const createTaskFixture = async (options: { readonly constrained?: boolean } = {}) => {
  const artifacts = await taskArtifacts(options);
  const atomic = createAtomicStore<TaskState>({
    tasks: { first: { id: 'first', title: 'First' } }
  });
  const database = await openTaskDatabase(atomic, artifacts);
  return {
    database,
    atomic,
    tasks: relationLiteral(artifacts.schema, 'tasks'),
    archivedTasks: relationLiteral(artifacts.schema, 'archivedTasks')
  };
};

const openTaskDatabase = async (
  atomic: ReturnType<typeof createAtomicStore<TaskState>>,
  artifacts: Awaited<ReturnType<typeof taskArtifacts>>
) => {
  const opened = await openExternalStoreDatabase({
    sourceId: 'source:external-tasks',
    store: atomic.store,
    storeIdentity: atomic.identity,
    declaration: {
      ...declaration(artifacts.schema, artifacts.mapping),
      ...(artifacts.constraint === undefined
        ? {}
        : { constraints: { set: reference(artifacts.constraint), mode: 'required' as const } })
    },
    embeddedArtifacts: [
      artifacts.schema,
      artifacts.mapping,
      ...(artifacts.constraint === undefined ? [] : [artifacts.constraint])
    ],
    authorityScope: 'scope:test'
  });
  if (!opened.success) throw new Error(JSON.stringify(opened.issues));
  return opened.value;
};

const taskArtifacts = async (options: { readonly constrained?: boolean } = {}) => {
  const schema = await sealSchema({ id: 'urn:test:external-tasks:schema', body: {
    relations: { tasks: {
      relationId: 'tasks',
      key: ['id'],
      fields: {
        id: { type: { kind: 'string' } },
        title: { type: { kind: 'string' } }
      }
    },
    archivedTasks: {
      relationId: 'archived-tasks',
      key: ['id'],
      fields: {
        id: { type: { kind: 'string' } },
        title: { type: { kind: 'string' } }
      }
    } }
  } });
  const mapping = await sealStorageMapping({ id: 'urn:test:external-tasks:mapping', body: {
    schema: reference(schema),
    model: 'json-tree-v1',
    relations: { tasks: {
      collection: { kind: 'object-map', path: ['tasks'], absent: 'creatable' },
      keys: { id: { kind: 'map-key', mirrorPath: ['id'], onMismatch: 'reject' } },
      fields: {
        title: { path: ['title'], write: { replace: builtInCapabilityRefs.fieldReplace } }
      }
    },
    'archived-tasks': {
      collection: { kind: 'object-map', path: ['archivedTasks'], absent: 'empty' },
      keys: { id: { kind: 'map-key', mirrorPath: ['id'], onMismatch: 'reject' } },
      fields: {
        title: { path: ['title'], write: { replace: builtInCapabilityRefs.fieldReplace } }
      }
    } }
  } });
  const constraint = options.constrained === true
    ? await sealConstraintSet({ id: 'urn:test:external-tasks:constraint', body: {
        schemaView: reference(schema),
        constraints: [{
          id: 'task-validity',
          code: 'test.task_invalid',
          dependencyRelations: ['tasks'],
          violationQuery: {
            kind: 'select',
            input: {
              kind: 'where',
              input: {
                kind: 'from',
                relation: { schemaView: reference(schema), relationId: 'tasks' },
                alias: 'task'
              },
              predicate: {
                kind: 'compare',
                op: 'eq',
                left: { kind: 'field', alias: 'task', name: 'title' },
                right: { kind: 'literal', value: 'Forbidden' }
              }
            },
            alias: 'violation',
            fields: {
              subject: {
                kind: 'record',
                fields: {
                  relationId: { kind: 'literal', value: 'tasks' },
                  key: { kind: 'field', alias: 'task', name: 'id' }
                }
              }
            }
          }
        }],
        requiredCapabilities: []
      } })
    : undefined;
  return { schema, mapping, constraint };
};

const createArrayTaskFixture = async (initial: {
  readonly tasks?: readonly { readonly id: string; readonly title: string }[];
}) => {
  const schema = await sealSchema({ id: 'urn:test:external-array:schema', body: {
    relations: { tasks: {
      relationId: 'array-tasks',
      key: ['id'],
      fields: {
        id: { type: { kind: 'string' } },
        title: { type: { kind: 'string' } }
      }
    } }
  } });
  const mapping = await sealStorageMapping({ id: 'urn:test:external-array:mapping', body: {
    schema: reference(schema),
    model: 'json-tree-v1',
    relations: { 'array-tasks': {
      collection: { kind: 'array', path: ['tasks'], absent: 'creatable' },
      keys: { id: { kind: 'field', path: ['id'] } },
      fields: {
        title: { path: ['title'], write: { replace: builtInCapabilityRefs.fieldReplace } }
      }
    } }
  } });
  const atomic = createAtomicStore(initial);
  const opened = await openExternalStoreDatabase({
    sourceId: 'source:external-array',
    store: atomic.store,
    storeIdentity: atomic.identity,
    declaration: declaration(schema, mapping),
    embeddedArtifacts: [schema, mapping],
    authorityScope: 'scope:test'
  });
  if (!opened.success) throw new Error(JSON.stringify(opened.issues));
  return {
    database: opened.value,
    atomic,
    tasks: relationLiteral(schema, 'tasks')
  };
};

const declaration = (
  schema: { readonly id: string; readonly contentHash: `sha256:${string}` },
  mapping: { readonly id: string; readonly contentHash: `sha256:${string}` }
) => ({
  formatVersion: 1,
  storageSchema: reference(schema),
  projection: { kind: 'storage-mapping' as const, storageMapping: reference(mapping) }
});

const reference = (artifact: { readonly id: string; readonly contentHash: `sha256:${string}` }) => ({
  id: artifact.id,
  contentHash: artifact.contentHash
});
