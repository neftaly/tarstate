import * as Automerge from '@automerge/automerge';
import { Repo, type Chunk, type DocHandle, type StorageAdapterInterface, type StorageKey } from '@automerge/automerge-repo';
import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  and,
  as,
  constRows,
  call,
  correlate,
  env,
  eq,
  field,
  from,
  getKey,
  gte,
  hostFn,
  isMissing,
  isNull,
  join,
  notMissing,
  notNull,
  pipe,
  project,
  qualify,
  sel,
  sel1,
  tuple,
  value,
  where
} from '@tarstate/core';
import { isRelationRuntime, runtimeSystemRelations, type RelationRuntime, type RuntimeHistoryRow } from '@tarstate/core/adapter';
import { evaluate, validateRelationRow } from '@tarstate/core/evaluate';
import {
  anchoredPathField,
  booleanField,
  customField,
  defineSchema,
  idField,
  jsonField,
  nullable,
  numberField,
  optional,
  refField,
  relation,
  stringField,
  toSchemaManifest,
  type JsonValue,
  type RelationRef
} from '@tarstate/core/schema';
import { createRuntimeStore } from '@tarstate/core/store';
import { write } from '@tarstate/core/write';
import {
  automergeChangeAt,
  automergeConflictDiagnostics,
  automergeConflictsAt,
  automergeBytesField,
  automergeCounterField,
  automergeDateField,
  automergeMapRelations,
  automergeMapAdapter,
  automergeMapSource,
  automergeDocHandleAdapter,
  automergeFork,
  automergeMerge,
  automergeObjectId,
  automergeObjectIdAt,
  automergeObjectLocations,
  automergeObjectReference,
  automergeObjectReferenceAt,
  automergeObjectReferenceField,
  automergePathForObjectId,
  automergeTextField,
  automergeView,
  createAutomergeDocHandleRuntime,
  createAutomergeMapRuntime,
  defineAutomergeMapRelations,
  normalizeAutomergeMapRelations,
  withAutomergeRuntimeRelations,
  type AutomergeConflict,
  type AutomergeDocHandleAdapter,
  type AutomergeDocHandleRuntime,
  type AutomergeObjectLocation,
  type AutomergeTextValue,
  type AutomergeMapAdapter,
  type AutomergeMapAdapterOptions,
  type AutomergeMapPath,
  type AutomergeMapRelation,
  type AutomergeMapRelationInput,
  type AutomergeMapRuntime,
  type AutomergeMapRuntimeOptions,
  type AutomergeMapSource,
  type AutomergeRelationDocument,
  type AutomergeRelationRuntimeMetadata
} from '@tarstate/automerge';
import { useAutomergeDocHandleStore } from '@tarstate/automerge/react';
import {
  automergePresenceRuntime,
  type AutomergePresenceFieldNames
} from '@tarstate/automerge/presence';

type TaskRow = {
  readonly id: string;
  readonly title: string;
  readonly memo?: string | null;
  readonly effort?: number | null;
  readonly done?: boolean;
  readonly projectId?: string;
  readonly anchor?: string;
  readonly meta?: JsonValue;
};

type LabelRow = {
  readonly id: string;
  readonly name: string;
};

type PresenceFocusRow = {
  readonly peer: string;
  readonly runtime: string;
  readonly objectId: string;
  readonly documentHeads?: JsonValue;
};

type PeerPresenceRow = {
  readonly peer: string;
  readonly topic: string;
  readonly payload?: JsonValue;
  readonly activeAt?: number;
  readonly seenAt?: number;
  readonly isLocal?: boolean;
};

type PeerPresenceState = Record<string, JsonValue | undefined>;

interface WorkspaceDoc {
  readonly workspace: {
    readonly tasks: readonly TaskRow[];
    readonly labelsById: Readonly<Record<string, LabelRow>>;
  };
}

type AutomergeScalarRow = {
  readonly id: string;
  readonly title: string;
  readonly body: string;
  readonly views: number;
  readonly bytes: string;
  readonly publishedAt: string;
};

type AutomergeScalarDoc = {
  readonly notes: readonly {
    readonly id: string;
    readonly title: string;
    readonly body: AutomergeTextValue;
    readonly views: Automerge.Counter;
    readonly bytes: Uint8Array;
    readonly publishedAt: Date;
  }[];
};

const schema = defineSchema({
  tasks: relation<TaskRow>({
    key: 'id',
    fields: {
      id: idField('task'),
      title: stringField(),
      memo: optional(nullable(stringField())),
      effort: optional(nullable(numberField())),
      done: optional(booleanField()),
      projectId: optional(refField('projects.id')),
      anchor: optional(anchoredPathField()),
      meta: optional(jsonField())
    }
  }),
  labels: relation<LabelRow>({
    key: 'id',
    fields: {
      id: idField('label'),
      name: stringField()
    }
  }),
  presenceFocus: relation<PresenceFocusRow>({
    key: 'peer',
    fields: {
      peer: idField('peer'),
      runtime: stringField(),
      objectId: stringField(),
      documentHeads: optional(jsonField())
    }
  }),
  peerPresence: relation<PeerPresenceRow>({
    ephemeral: true,
    key: ['peer', 'topic'] as const,
    fields: {
      peer: idField('peer'),
      topic: stringField(),
      payload: optional(jsonField()),
      activeAt: optional(numberField()),
      seenAt: optional(numberField()),
      isLocal: optional(booleanField())
    }
  })
});

const presenceFields = {
  peerId: 'peer',
  channel: 'topic',
  value: 'payload',
  lastActiveAt: 'activeAt',
  lastSeenAt: 'seenAt',
  local: 'isLocal'
} satisfies AutomergePresenceFieldNames;

const automergeScalarSchema = defineSchema({
  notes: relation<AutomergeScalarRow>({
    key: 'id',
    fields: {
      id: stringField(),
      title: stringField(),
      body: automergeTextField(),
      views: automergeCounterField(),
      bytes: automergeBytesField(),
      publishedAt: automergeDateField()
    }
  })
});

const defineWorkspaceRelations = defineAutomergeMapRelations<WorkspaceDoc>();
const defineAutomergeScalarRelations = defineAutomergeMapRelations<AutomergeScalarDoc>();
const taskMapping = defineWorkspaceRelations([
  { relation: schema.tasks, path: ['workspace', 'tasks'] }
]);
const allMappings = defineWorkspaceRelations([
  { relation: schema.tasks, path: ['workspace', 'tasks'] },
  { relation: schema.labels, path: ['workspace', 'labelsById'] }
]);
const automergeScalarMapping = defineAutomergeScalarRelations([
  { relation: automergeScalarSchema.notes, path: ['notes'] }
]);

function expectNativeScalarNote(
  note: AutomergeScalarDoc['notes'][number] | undefined,
  expected: {
    readonly body: string;
    readonly views: number;
    readonly bytes: readonly number[];
    readonly publishedAt: string;
  }
): void {
  expect(note).toBeDefined();
  expect(Automerge.isImmutableString(note?.body)).toBe(true);
  expect(String(note?.body)).toBe(expected.body);
  expect(Automerge.isCounter(note?.views)).toBe(true);
  expect(Number(note?.views)).toBe(expected.views);
  expect(note?.bytes).toBeInstanceOf(Uint8Array);
  expect(Array.from(note?.bytes ?? [])).toEqual(expected.bytes);
  expect(note?.publishedAt).toBeInstanceOf(Date);
  expect(note?.publishedAt.toISOString()).toBe(expected.publishedAt);
}

describe('automerge map adapter', () => {
  it('preserves public exports and creates real source/adapter instances', async () => {
    const api = await import('@tarstate/automerge');
    const doc = workspaceDoc();
    const adapter = automergeMapAdapter({ doc, relations: taskMapping });
    const source = automergeMapSource(doc, { relations: taskMapping });

    expect(api.automergeMapAdapter).toBe(automergeMapAdapter);
    expect(api.automergeMapSource).toBe(automergeMapSource);
    expect(api.automergeMapRelations).toBe(automergeMapRelations);
    expect(api.normalizeAutomergeMapRelations).toBe(normalizeAutomergeMapRelations);
    expect(api.automergeDocHandleAdapter).toBe(automergeDocHandleAdapter);
    expect(api.automergeView).toBe(automergeView);
    expect(api.automergeFork).toBe(automergeFork);
    expect(api.automergeChangeAt).toBe(automergeChangeAt);
    expect(api.automergeMerge).toBe(automergeMerge);
    expect(api.automergeObjectId).toBe(automergeObjectId);
    expect(api.automergeObjectIdAt).toBe(automergeObjectIdAt);
    expect(api.automergeObjectLocations).toBe(automergeObjectLocations);
    expect(api.automergeObjectReference).toBe(automergeObjectReference);
    expect(api.automergeObjectReferenceAt).toBe(automergeObjectReferenceAt);
    expect(api.automergeObjectReferenceField).toBe(automergeObjectReferenceField);
    expect(api.automergePathForObjectId).toBe(automergePathForObjectId);
    expect(api.automergeConflictsAt).toBe(automergeConflictsAt);
    expect(api.automergeConflictDiagnostics).toBe(automergeConflictDiagnostics);
    expect(api.createAutomergeDocHandleRuntime).toBe(createAutomergeDocHandleRuntime);
    expect(api.createAutomergeMapRuntime).toBe(createAutomergeMapRuntime);
    expect(api.defineAutomergeMapRelations).toBe(defineAutomergeMapRelations);
    expect(api.withAutomergeRuntimeRelations).toBe(withAutomergeRuntimeRelations);
    expect('automergeDb' in api).toBe(false);
    expect('automergeDbRelationRuntime' in api).toBe(false);
    expect('automergeSchema' in api).toBe(false);
    expect('keyhive' in api).toBe(false);
    expect('sedimentree' in api).toBe(false);
    expect(adapter.source.rows(schema.tasks)).toEqual([{ id: 'task-1', title: 'Draft' }]);
    expect(source.rows(schema.tasks)).toEqual([{ id: 'task-1', title: 'Draft' }]);
    expect(source.rows(runtimeSystemRelations.sources)).toEqual([
      expect.objectContaining({
        runtime: 'automergeMapSource',
        source: 'automerge.document',
        state: 'ready'
      })
    ]);
    expect(adapter.snapshot().version).toEqual(Automerge.getHeads(doc));
    expect(automergeMapRelations({ tasks: schema.tasks, labels: schema.labels })).toEqual([
      { relation: schema.tasks, path: ['tasks'] },
      { relation: schema.labels, path: ['labels'] }
    ]);
    expect(normalizeAutomergeMapRelations(taskMapping)).toBe(taskMapping);
    expect(normalizeAutomergeMapRelations({ tasks: schema.tasks })).toEqual([
      { relation: schema.tasks, path: ['tasks'] }
    ]);
    expect(automergeMapSource(Automerge.from<AutomergeRelationDocument<{ readonly tasks: typeof schema.tasks }>>({
      tasks: [{ id: 'task-root', title: 'Root task' }]
    }), { relations: { tasks: schema.tasks } }).rows(schema.tasks)).toEqual([
      { id: 'task-root', title: 'Root task' }
    ]);
    expectTypeOf(automergeMapAdapter<WorkspaceDoc>).returns.toMatchTypeOf<AutomergeMapAdapter<WorkspaceDoc>>();
    expectTypeOf(automergeDocHandleAdapter<WorkspaceDoc>).returns.toMatchTypeOf<AutomergeDocHandleAdapter<WorkspaceDoc>>();
    expectTypeOf(createAutomergeDocHandleRuntime<WorkspaceDoc>).returns
      .toMatchTypeOf<AutomergeDocHandleRuntime<WorkspaceDoc>>();
    expectTypeOf(automergeMapSource<WorkspaceDoc>).returns.toMatchTypeOf<AutomergeMapSource>();
    expectTypeOf<AutomergeMapRelationInput<WorkspaceDoc>>()
      .toMatchTypeOf<readonly AutomergeMapRelation<RelationRef, WorkspaceDoc>[] | Readonly<Record<string, RelationRef>>>();
    expectTypeOf<AutomergeRelationDocument<{ readonly tasks: typeof schema.tasks }>>()
      .toEqualTypeOf<{ readonly tasks: readonly TaskRow[] }>();
  });

  it('exports the React DocHandle store hook from the React subpath', async () => {
    const api = await import('@tarstate/automerge/react');

    expect(api.useAutomergeDocHandleStore).toBe(useAutomergeDocHandleStore);
    expect(useAutomergeDocHandleStore).toBeTypeOf('function');
  });

  it('exports automerge field helper codec overrides without alias conflicts', () => {
    const overriddenSchema = defineSchema({
      notes: relation<{ readonly id: string; readonly body: string; readonly views: number }>({
        key: 'id',
        fields: {
          id: stringField(),
          body: automergeTextField({ codec: 'app.text' }),
          views: automergeCounterField({ codec: 'app.counter' })
        }
      })
    });

    expect(overriddenSchema.notes.fields.body?.custom?.codec).toBe('app.text');
    expect(overriddenSchema.notes.fields.body?.custom).not.toHaveProperty('kind');
    expect(overriddenSchema.notes.fields.views?.custom?.codec).toBe('app.counter');
    expect(overriddenSchema.notes.fields.views?.custom).not.toHaveProperty('kind');
    const manifest = toSchemaManifest(overriddenSchema, { schemaId: 'automerge.codec@1' });
    expect(manifest.relations.notes?.fields.body).toEqual({ type: 'custom', codec: 'app.text' });
    expect(manifest.relations.notes?.fields.views).toEqual({ type: 'custom', codec: 'app.counter' });
    expect(manifest.codecs?.['app.text']).toEqual({ description: 'an Automerge text value', keyable: true });
    expect(manifest.codecs?.['app.counter']).toEqual({ description: 'an Automerge counter value', keyable: true });
  });

  it('preserves native Automerge scalar behavior when helper codec names are overridden', async () => {
    type OverrideRow = {
      readonly id: string;
      readonly body: string;
      readonly views: number;
    };
    type OverrideDoc = {
      readonly notes: readonly {
        readonly id: string;
        readonly body: string;
        readonly views: Automerge.Counter;
      }[];
    };
    const overrideSchema = defineSchema({
      notes: relation<OverrideRow>({
        key: 'id',
        fields: {
          id: stringField(),
          body: automergeTextField({ codec: 'app.text' }),
          views: automergeCounterField({ codec: 'app.counter' })
        }
      })
    });
    const overrideRelations = defineAutomergeMapRelations<OverrideDoc>()([
      { relation: overrideSchema.notes, path: ['notes'] }
    ]);
    const adapter = automergeMapAdapter({
      doc: Automerge.from<OverrideDoc>({
        notes: [{ id: 'note-1', body: 'hello', views: new Automerge.Counter(3) }]
      }),
      relations: overrideRelations
    });

    const result = await adapter.target.apply([
      write(overrideSchema.notes).updateByKey('note-1', { body: 'hullo' }),
      write(overrideSchema.notes).incrementByKey('note-1', 'views', 4)
    ]);

    expect(result.status).toBe('accepted');
    expect(result.diagnostics).toEqual([]);
    expect(adapter.source.rows(overrideSchema.notes)).toEqual([{ id: 'note-1', body: 'hullo', views: 7 }]);
    expect(typeof adapter.getDoc().notes[0]?.body).toBe('string');
    expect(Automerge.isImmutableString(adapter.getDoc().notes[0]?.body)).toBe(false);
    expect(Automerge.isCounter(adapter.getDoc().notes[0]?.views)).toBe(true);
    expect(Number(adapter.getDoc().notes[0]?.views)).toBe(7);
  });

  it('publishes Automerge runtime state and active view interests as relation rows', () => {
    const runtime = createAutomergeMapRuntime({
      doc: workspaceDoc(),
      relations: taskMapping,
      runtimeId: 'workspace'
    });
    const store = createRuntimeStore({ runtime });
    const relationNotifications: string[][] = [];
    const unsubscribeRuntime = runtime.subscribe((notification) => {
      if (notification?.relationNames !== undefined) relationNotifications.push([...notification.relationNames]);
    });
    const view = store.view(from(schema.tasks));
    const unsubscribe = view.subscribe(() => {});

    expect(runtime.source.rows(runtimeSystemRelations.sync)).toEqual([
      expect.objectContaining({
        runtime: 'workspace',
        state: 'synced',
        localHeads: runtime.adapter.source.version?.()
      })
    ]);
    expect(store.query(runtimeSystemRelations.interests).rows).toEqual([
      expect.objectContaining({
        runtime: 'workspace',
        queryKey: view.queryKey,
        state: 'active',
        relationNames: ['tasks']
      })
    ]);

    unsubscribe();
    expect(store.query(runtimeSystemRelations.interests).rows).toEqual([]);
    expect(relationNotifications).toEqual([
      [runtimeSystemRelations.interests.name],
      [runtimeSystemRelations.interests.name]
    ]);

    unsubscribeRuntime();
    store.close();
  });

  it('reads Automerge runtime system rows without materializing unrelated relations', () => {
    const reads = {
      sources: 0,
      diagnostics: 0,
      peers: 0,
      sync: 0,
      conflicts: 0,
      history: 0,
      objectLocations: 0,
      storage: 0,
      interests: 0
    };
    const callerInterest = {
      id: 'caller:interest:tasks',
      runtime: 'caller',
      queryKey: 'query:tasks',
      state: 'active',
      relationNames: ['tasks']
    } as const;
    const runtime = createAutomergeMapRuntime({
      doc: workspaceDoc(),
      relations: taskMapping,
      runtimeId: 'workspace',
      system: () => ({
        get sources() {
          reads.sources += 1;
          return [];
        },
        get diagnostics() {
          reads.diagnostics += 1;
          return [];
        },
        get peers() {
          reads.peers += 1;
          return [];
        },
        get sync() {
          reads.sync += 1;
          return [];
        },
        get conflicts() {
          reads.conflicts += 1;
          return [];
        },
        get history() {
          reads.history += 1;
          return [];
        },
        get objectLocations() {
          reads.objectLocations += 1;
          return [];
        },
        get storage() {
          reads.storage += 1;
          return [];
        },
        get interests() {
          reads.interests += 1;
          return [callerInterest];
        }
      })
    });

    expect(runtime.source.rows(runtimeSystemRelations.interests)).toEqual([callerInterest]);
    expect(reads).toEqual({
      sources: 0,
      diagnostics: 0,
      peers: 0,
      sync: 0,
      conflicts: 0,
      history: 0,
      objectLocations: 0,
      storage: 0,
      interests: 1
    });
  });

  it('publishes Automerge history rows for active history interests', () => {
    const changedAt = 1_783_036_800;
    const doc = Automerge.change(workspaceDoc(), { message: 'rename task', time: changedAt }, (draft) => {
      (draft.workspace.tasks[0] as { title: string }).title = 'Ready';
    });
    const runtime = createAutomergeMapRuntime({
      doc,
      relations: taskMapping,
      runtimeId: 'workspace'
    });
    const store = createRuntimeStore({ runtime });

    expect(runtime.source.rows(runtimeSystemRelations.history)).toEqual([]);

    const view = store.view(from(runtimeSystemRelations.history));
    const unsubscribe = view.subscribe(() => {});
    const historyRows = store.query(runtimeSystemRelations.history).rows as readonly RuntimeHistoryRow[];

    expect(historyRows).toEqual(expect.arrayContaining([
      expect.objectContaining({
        runtime: 'workspace',
        message: 'rename task',
        time: changedAt,
        actor: expect.any(String),
        hash: expect.any(String),
        deps: expect.any(Array),
        detail: expect.objectContaining({
          seq: expect.any(Number),
          startOp: expect.any(Number),
          opCount: expect.any(Number)
        })
      })
    ]));
    expect(historyRows.find((row) => row.message === 'rename task')?.hash).toEqual(expect.any(String));

    unsubscribe();
    expect(runtime.source.rows(runtimeSystemRelations.history)).toEqual([]);
    store.close();
  });

  it('publishes mapped Automerge conflicts as runtime conflict rows', () => {
    const base = workspaceDoc();
    const left = Automerge.change(automergeFork(base), (draft) => {
      (draft.workspace.tasks[0] as { title: string }).title = 'Left title';
    });
    const right = Automerge.change(automergeFork(base), (draft) => {
      (draft.workspace.tasks[0] as { title: string }).title = 'Right title';
    });
    const callerConflict = {
      id: 'caller:conflict',
      runtime: 'caller',
      path: 'caller.path',
      conflictCount: 1
    };
    const runtime = createAutomergeMapRuntime({
      doc: automergeMerge(left, right),
      relations: taskMapping,
      runtimeId: 'workspace',
      system: { conflicts: [callerConflict] }
    });
    const conflicts = runtime.source.rows(runtimeSystemRelations.conflicts);

    expect(conflicts).toEqual(expect.arrayContaining([
      expect.objectContaining({
        runtime: 'workspace',
        relation: 'tasks',
        field: 'title',
        conflictCount: 2,
        values: expect.arrayContaining(['Left title', 'Right title']),
        detail: expect.objectContaining({
          key: 'task-1',
          pathSegments: ['workspace', 'tasks', 0, 'title']
        })
      }),
      callerConflict
    ]));
  });

  it('publishes conservative repo-fed system rows for DocHandle runtimes', async () => {
    const storage = new MemoryStorageAdapter();
    const repo = new Repo({ peerId: 'peer-local' as never, storage });
    const handle = repo.create<WorkspaceDoc>({
      workspace: {
        tasks: [{ id: 'task-1', title: 'Draft' }],
        labelsById: {
          'label-1': { id: 'label-1', name: 'Urgent' }
        }
      }
    });
    const remoteStorageId = 'storage-remote' as never;

    repo.networkSubsystem.emit('peer', {
      peerId: 'peer-remote' as never,
      peerMetadata: { storageId: remoteStorageId, isEphemeral: true }
    });
    handle.setSyncInfo(remoteStorageId, {
      lastHeads: ['remote-head'] as never,
      lastSyncTimestamp: 123
    });

    const runtime = createAutomergeDocHandleRuntime({
      repo,
      handle,
      relations: taskMapping,
      runtimeId: 'workspace',
      system: {
        peers: [{
          id: 'caller:peer',
          runtime: 'caller',
          peerId: 'caller-peer',
          state: 'unknown'
        }]
      }
    });

    expect(runtime.source.rows(runtimeSystemRelations.peers)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'workspace:peer:peer-remote',
        runtime: 'workspace',
        peerId: 'peer-remote',
        state: 'connected',
        connected: true,
        ephemeral: true
      }),
      expect.objectContaining({
        id: 'caller:peer',
        peerId: 'caller-peer'
      })
    ]));
    expect(runtime.source.rows(runtimeSystemRelations.sync)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'workspace:sync:local-heads',
        runtime: 'workspace',
        documentId: String(handle.documentId),
        state: 'synced',
        localHeads: Automerge.getHeads(handle.doc())
      }),
      expect.objectContaining({
        id: 'workspace:sync:remote:storage-remote',
        runtime: 'workspace',
        documentId: String(handle.documentId),
        peerId: 'peer-remote',
        storageId: 'storage-remote',
        state: 'synced',
        remoteHeads: ['remote-head'],
        updatedAt: 123
      })
    ]));

    const storageRows = runtime.source.rows(runtimeSystemRelations.storage) as readonly Record<string, unknown>[];
    expect(storageRows).toHaveLength(1);
    expect(storageRows[0]).toEqual(expect.objectContaining({
      runtime: 'workspace',
      storage: expect.any(String),
      durability: 'durable'
    }));
    expect(['idle', 'synced']).toContain(storageRows[0]?.state);
    expect(storageRows[0]).not.toHaveProperty('pendingWrites');
    expect(storageRows[0]).not.toHaveProperty('lastFlushAt');

    const unsubscribe = runtime.subscribe(() => {});

    repo.emit('doc-metrics', {
      type: 'doc-saved',
      documentId: String(handle.documentId) as never,
      durationMillis: 5,
      sinceHeads: []
    });

    expect(runtime.source.rows(runtimeSystemRelations.storage)).toEqual([
      expect.objectContaining({
        runtime: 'workspace',
        state: 'synced',
        detail: expect.objectContaining({
          lastCompleted: expect.objectContaining({
            type: 'doc-saved',
            documentId: String(handle.documentId)
          })
        })
      })
    ]);

    unsubscribe();
    runtime.close();
    await repo.shutdown();
  });

  it('drops onDocChange from adapter options', () => {
    const adapterOptions = {
      doc: workspaceDoc(),
      relations: taskMapping
    } satisfies AutomergeMapAdapterOptions<WorkspaceDoc>;
    const legacyAdapterOptions = {
      doc: workspaceDoc(),
      relations: taskMapping,
      // @ts-expect-error onDocChange was removed; subscribe and call getDoc() instead.
      onDocChange: () => {}
    } satisfies AutomergeMapAdapterOptions<WorkspaceDoc>;

    void adapterOptions;
    void legacyAdapterOptions;
  });

  it('drops ignored storage codec adapter options', () => {
    const adapterOptions = {
      doc: workspaceDoc(),
      relations: taskMapping
    } satisfies AutomergeMapAdapterOptions<WorkspaceDoc>;
    const storageOptions = {
      doc: workspaceDoc(),
      relations: taskMapping,
      // @ts-expect-error storage codec options were removed because they were ignored.
      storage: { codec: 'map-v1' }
    } satisfies AutomergeMapAdapterOptions<WorkspaceDoc>;

    void adapterOptions;
    void storageOptions;
  });

  it('checks Automerge relation path roots through the helper', () => {
    const workspacePath = ['workspace', 'tasks'] as const satisfies AutomergeMapPath<WorkspaceDoc>;
    const workspaceMapping = taskMapping satisfies readonly AutomergeMapRelation<typeof schema.tasks, WorkspaceDoc>[];
    const invalidWorkspacePath =
      // @ts-expect-error Automerge map paths start with a document key.
      ['missing', 'tasks'] as const satisfies AutomergeMapPath<WorkspaceDoc>;
    const invalidWorkspaceMapping = defineWorkspaceRelations([
      {
        relation: schema.tasks,
        // @ts-expect-error Automerge map paths start with a document key.
        path: ['missing', 'tasks']
      }
    ]);

    expect(workspacePath[0]).toBe('workspace');
    expect(workspaceMapping[0]?.path[0]).toBe('workspace');
    void invalidWorkspacePath;
    void invalidWorkspaceMapping;
  });

  it('maps array and map collections to relation rows', () => {
    const source = automergeMapSource(workspaceDoc(), { relations: allMappings });

    expect(source.relationNames).toEqual([
      'tasks',
      'labels',
      ...Object.values(runtimeSystemRelations).map((relationRef) => relationRef.name)
    ]);
    expect(source.rows(schema.tasks)).toEqual([{ id: 'task-1', title: 'Draft' }]);
    expect(source.rows(schema.labels)).toEqual([{ id: 'label-1', name: 'Urgent' }]);
    expect(source.lookup?.({ relation: schema.tasks, field: 'id', value: 'task-1' })).toEqual([
      { id: 'task-1', title: 'Draft' }
    ]);
    expect(source.rangeLookup?.({
      relation: schema.tasks,
      field: 'title',
      lower: { value: 'A', inclusive: true },
      upper: { value: 'M', inclusive: false }
    })).toEqual([{ id: 'task-1', title: 'Draft' }]);
  });

  it('projects stable Automerge scalar field views for queries', async () => {
    const publishedAt = new Date('2026-07-03T00:00:00.000Z');
    const adapter = automergeMapAdapter({ doc: Automerge.from<AutomergeScalarDoc>({
      notes: [
        {
          id: 'note-1',
          title: 'Initial',
          body: new Automerge.ImmutableString('hello'),
          views: new Automerge.Counter(3),
          bytes: new Uint8Array([1, 2, 255]),
          publishedAt
        }
      ]
    }), relations: automergeScalarMapping });

    expect(adapter.source.rows(automergeScalarSchema.notes)).toEqual([
      {
        id: 'note-1',
        title: 'Initial',
        body: 'hello',
        views: 3,
        bytes: '0102ff',
        publishedAt: publishedAt.toISOString()
      }
    ]);
    expect(adapter.source.lookup?.({
      relation: automergeScalarSchema.notes,
      field: 'body',
      value: 'hello'
    })).toEqual(adapter.source.rows(automergeScalarSchema.notes));
    expect(adapter.source.rangeLookup?.({
      relation: automergeScalarSchema.notes,
      field: 'views',
      lower: { value: 2, inclusive: true }
    })).toEqual(adapter.source.rows(automergeScalarSchema.notes));

    const bodyBefore = adapter.getDoc().notes[0]?.body;
    const viewsBefore = adapter.getDoc().notes[0]?.views;
    const bytesBefore = adapter.getDoc().notes[0]?.bytes;
    const dateBefore = adapter.getDoc().notes[0]?.publishedAt;

    const updateResult = await adapter.target.apply([
      write(automergeScalarSchema.notes).updateByKey('note-1', { title: 'Edited' })
    ]);

    expect(updateResult).toMatchObject({ status: 'accepted', applied: 1 });
    expect(adapter.source.rows(automergeScalarSchema.notes)[0]).toMatchObject({ title: 'Edited', body: 'hello' });
    expect(adapter.getDoc().notes[0]?.body).toBe(bodyBefore);
    expect(adapter.getDoc().notes[0]?.views).toBe(viewsBefore);
    expect(adapter.getDoc().notes[0]?.bytes).toBe(bytesBefore);
    expect(adapter.getDoc().notes[0]?.publishedAt).toBe(dateBefore);
  });

  it('encodes changed Automerge scalar field views back to native doc values', async () => {
    const publishedAt = '2026-07-04T00:00:00.000Z';
    const adapter = automergeMapAdapter({ doc: Automerge.from<AutomergeScalarDoc>({
      notes: [
        {
          id: 'note-1',
          title: 'Initial',
          body: new Automerge.ImmutableString('hello'),
          views: new Automerge.Counter(3),
          bytes: new Uint8Array([1, 2, 255]),
          publishedAt: new Date('2026-07-03T00:00:00.000Z')
        }
      ]
    }), relations: automergeScalarMapping });

    const updateResult = await adapter.target.apply([
      write(automergeScalarSchema.notes).updateByKey('note-1', {
        body: 'changed',
        views: 9,
        bytes: '0a0bff',
        publishedAt
      })
    ]);

    expect(updateResult).toMatchObject({ status: 'accepted', applied: 1 });
    expect(adapter.source.rows(automergeScalarSchema.notes)[0]).toMatchObject({
      body: 'changed',
      views: 9,
      bytes: '0a0bff',
      publishedAt
    });
    expectNativeScalarNote(adapter.getDoc().notes[0], {
      body: 'changed',
      views: 9,
      bytes: [10, 11, 255],
      publishedAt
    });
  });

  it('increments mapped Automerge counter fields with native Counter semantics', async () => {
    const base = Automerge.from<AutomergeScalarDoc>({
      notes: [
        {
          id: 'note-1',
          title: 'Initial',
          body: new Automerge.ImmutableString('hello'),
          views: new Automerge.Counter(3),
          bytes: new Uint8Array([1, 2, 255]),
          publishedAt: new Date('2026-07-03T00:00:00.000Z')
        }
      ]
    });
    const concurrent = Automerge.change(Automerge.clone(base), (draft) => {
      draft.notes[0]?.views.increment(2);
    });
    const adapter = automergeMapAdapter({ doc: base, relations: automergeScalarMapping });

    const result = await adapter.target.apply([
      write(automergeScalarSchema.notes).incrementByKey('note-1', 'views', 4)
    ]);

    expect(result).toMatchObject({ status: 'accepted', applied: 1 });
    expect(adapter.source.rows(automergeScalarSchema.notes)[0]).toMatchObject({ views: 7 });
    expect(Automerge.isCounter(adapter.getDoc().notes[0]?.views)).toBe(true);
    expect(Number(adapter.getDoc().notes[0]?.views)).toBe(7);

    const merged = Automerge.merge(adapter.getDoc(), concurrent);
    expect(Automerge.isCounter(merged.notes[0]?.views)).toBe(true);
    expect(Number(merged.notes[0]?.views)).toBe(9);
  });

  it('rejects increments for non-counter mapped fields', async () => {
    const adapter = automergeMapAdapter({ doc: workspaceDoc([
      { id: 'task-1', title: 'Draft', effort: 3 }
    ]), relations: taskMapping });
    const beforeDoc = adapter.getDoc();

    const result = await adapter.target.apply([
      write(schema.tasks).incrementByKey('task-1', 'effort', 2)
    ]);

    expect(result.status).toBe('rejected');
    expect(result.applied).toBe(0);
    expect(result.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'field_invalid', relation: 'tasks', field: 'effort' })
    ]));
    expect(adapter.getDoc()).toBe(beforeDoc);
    expect(adapter.source.rows(schema.tasks)[0]).toMatchObject({ effort: 3 });
  });

  it('rejects counter increments when the mapped field is stored as a plain number', async () => {
    const adapter = automergeMapAdapter({ doc: Automerge.from<AutomergeScalarDoc>({
      notes: [
        {
          id: 'note-1',
          title: 'Initial',
          body: new Automerge.ImmutableString('hello'),
          views: 3 as unknown as Automerge.Counter,
          bytes: new Uint8Array([1, 2, 255]),
          publishedAt: new Date('2026-07-03T00:00:00.000Z')
        }
      ]
    }), relations: automergeScalarMapping });
    const beforeDoc = adapter.getDoc();

    const result = await adapter.target.apply([
      write(automergeScalarSchema.notes).incrementByKey('note-1', 'views', 4)
    ]);

    expect(result.status).toBe('rejected');
    expect(result.applied).toBe(0);
    expect(result.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'field_invalid', relation: 'notes', field: 'views' })
    ]));
    expect(adapter.getDoc()).toBe(beforeDoc);
    expect(Automerge.isCounter(adapter.getDoc().notes[0]?.views)).toBe(false);
    expect(adapter.source.rows(automergeScalarSchema.notes)[0]).toMatchObject({ views: 3 });
  });

  it('updates existing plain-string text fields without replacing them with ImmutableString', async () => {
    const adapter = automergeMapAdapter({ doc: Automerge.from<AutomergeScalarDoc>({
      notes: [
        {
          id: 'note-1',
          title: 'Initial',
          body: 'hello',
          views: new Automerge.Counter(3),
          bytes: new Uint8Array([1, 2, 255]),
          publishedAt: new Date('2026-07-03T00:00:00.000Z')
        }
      ]
    }), relations: automergeScalarMapping });

    const updateResult = await adapter.target.apply([
      write(automergeScalarSchema.notes).updateByKey('note-1', { body: 'hullo' })
    ]);

    expect(updateResult).toMatchObject({ status: 'accepted', applied: 1 });
    expect(adapter.source.rows(automergeScalarSchema.notes)[0]).toMatchObject({ body: 'hullo' });
    expect(adapter.getDoc().notes[0]?.body).toBe('hullo');
    expect(Automerge.isImmutableString(adapter.getDoc().notes[0]?.body)).toBe(false);
  });

  it('keeps replacement encoding for ImmutableString because updateText cannot target immutable scalar text', async () => {
    const doc = Automerge.from<AutomergeScalarDoc>({
      notes: [
        {
          id: 'note-1',
          title: 'Initial',
          body: new Automerge.ImmutableString('hello'),
          views: new Automerge.Counter(3),
          bytes: new Uint8Array([1, 2, 255]),
          publishedAt: new Date('2026-07-03T00:00:00.000Z')
        }
      ]
    });
    const bodyBefore = doc.notes[0]?.body;

    expect(() => Automerge.change(doc, (draft) => {
      Automerge.updateText(draft, ['notes', 0, 'body'], 'hullo');
    })).toThrow(/path did not refer to an object/u);

    const adapter = automergeMapAdapter({ doc, relations: automergeScalarMapping });
    const updateResult = await adapter.target.apply([
      write(automergeScalarSchema.notes).updateByKey('note-1', { body: 'hullo' })
    ]);

    expect(updateResult).toMatchObject({ status: 'accepted', applied: 1 });
    expect(String(adapter.getDoc().notes[0]?.body)).toBe('hullo');
    expect(Automerge.isImmutableString(adapter.getDoc().notes[0]?.body)).toBe(true);
    expect(adapter.getDoc().notes[0]?.body).not.toBe(bodyBefore);
  });

  it('encodes inserted and replaced Automerge scalar field rows back to native doc values', async () => {
    const insertedAt = '2026-07-04T01:00:00.000Z';
    const insertAdapter = automergeMapAdapter({
      doc: Automerge.from<AutomergeScalarDoc>({ notes: [] }),
      relations: automergeScalarMapping
    });

    const insertResult = await insertAdapter.target.apply([
      write(automergeScalarSchema.notes).insertOrReplace({
        id: 'note-1',
        title: 'Inserted',
        body: 'inserted',
        views: 4,
        bytes: '010203',
        publishedAt: insertedAt
      })
    ]);

    expect(insertResult).toMatchObject({ status: 'accepted', applied: 1 });
    expectNativeScalarNote(insertAdapter.getDoc().notes[0], {
      body: 'inserted',
      views: 4,
      bytes: [1, 2, 3],
      publishedAt: insertedAt
    });

    const replacedAt = '2026-07-04T02:00:00.000Z';
    const replaceAdapter = automergeMapAdapter({
      doc: Automerge.from<AutomergeScalarDoc>({ notes: [] }),
      relations: automergeScalarMapping
    });

    const replaceResult = await replaceAdapter.target.apply([
      write(automergeScalarSchema.notes).replaceAll([
        {
          id: 'note-1',
          title: 'Replaced',
          body: 'replaced',
          views: 7,
          bytes: '0c0d',
          publishedAt: replacedAt
        }
      ])
    ]);

    expect(replaceResult).toMatchObject({ status: 'accepted', applied: 1 });
    expectNativeScalarNote(replaceAdapter.getDoc().notes[0], {
      body: 'replaced',
      views: 7,
      bytes: [12, 13],
      publishedAt: replacedAt
    });
  });

  it('rejects malformed Automerge scalar relation writes before encoding', async () => {
    const adapter = automergeMapAdapter({ doc: Automerge.from<AutomergeScalarDoc>({
      notes: [
        {
          id: 'note-1',
          title: 'Initial',
          body: new Automerge.ImmutableString('hello'),
          views: new Automerge.Counter(3),
          bytes: new Uint8Array([1, 2, 255]),
          publishedAt: new Date('2026-07-03T00:00:00.000Z')
        }
      ]
    }), relations: automergeScalarMapping });
    const beforeDoc = adapter.getDoc();

    const result = await adapter.target.apply([
      write(automergeScalarSchema.notes).updateByKey('note-1', {
        bytes: 'xyz',
        publishedAt: 'not-a-date'
      })
    ]);

    expect(result.status).toBe('rejected');
    expect(result.applied).toBe(0);
    expect(result.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'field_invalid', field: 'bytes' }),
      expect.objectContaining({ code: 'field_invalid', field: 'publishedAt' })
    ]));
    expect(adapter.getDoc()).toBe(beforeDoc);
  });

  it('pushes where evaluation through Automerge source lookup hooks', () => {
    const source = automergeMapSource(workspaceDoc([
      { id: 'task-1', title: 'Draft', effort: 1 },
      { id: 'task-2', title: 'Build', effort: 3 },
      { id: 'task-3', title: 'Ship', effort: 5 }
    ]), { relations: taskMapping });
    const reads = { rows: 0, lookup: 0, rangeLookup: 0 };
    const counted: AutomergeMapSource = {
      ...source,
      rows: (relationRef) => {
        reads.rows += 1;
        return source.rows(relationRef);
      },
      lookup: (lookupValue) => {
        reads.lookup += 1;
        return source.lookup?.(lookupValue);
      },
      rangeLookup: (lookupValue) => {
        reads.rangeLookup += 1;
        return source.rangeLookup?.(lookupValue);
      }
    };

    const lookupResult = evaluate(
      counted,
      pipe(
        from(schema.tasks),
        where(eq(field<string>('tasks', 'id'), value('task-2')))
      )
    );
    const rangeResult = evaluate(
      counted,
      pipe(
        from(schema.tasks),
        where(gte(field<number>('tasks', 'effort'), value(3)))
      )
    );

    expect(lookupResult).toEqual({
      rows: [{ id: 'task-2', title: 'Build', effort: 3 }],
      diagnostics: []
    });
    expect(rangeResult).toEqual({
      rows: [
        { id: 'task-2', title: 'Build', effort: 3 },
        { id: 'task-3', title: 'Ship', effort: 5 }
      ],
      diagnostics: []
    });
    expect(reads).toEqual({ rows: 0, lookup: 1, rangeLookup: 1 });
  });

  it('reports missing mapped paths and rejects writes without creating them', async () => {
    const missingMapping = defineWorkspaceRelations([
      { relation: schema.tasks, path: ['workspace', 'missingTasks'] }
    ]);
    const adapter = automergeMapAdapter({ doc: workspaceDoc(), relations: missingMapping });
    const beforeDoc = adapter.getDoc();
    const beforeHeads = Automerge.getHeads(beforeDoc);

    expect(adapter.source.rows(schema.tasks)).toEqual([]);
    expect(adapter.source.diagnostics?.()).toEqual([
      expect.objectContaining({
        code: 'runtime_unsupported',
        severity: 'warning',
        relation: 'tasks'
      })
    ]);

    const result = await adapter.target.apply([
      write(schema.tasks).insert({ id: 'task-2', title: 'Should not create path' })
    ]);

    expect(result.status).toBe('rejected');
    expect(result.applied).toBe(0);
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        code: 'runtime_unsupported',
        relation: 'tasks'
      })
    ]);
    expect(adapter.getDoc()).toBe(beforeDoc);
    expect(Automerge.getHeads(adapter.getDoc())).toEqual(beforeHeads);
    expect('missingTasks' in adapter.getDoc().workspace).toBe(false);
  });

  it('does not inject missing key fields from Automerge map keys', async () => {
    const doc = Automerge.from({
      workspace: {
        tasks: [],
        labelsById: {
          'label-1': { name: 'Urgent' }
        }
      }
    }) as unknown as Automerge.Doc<WorkspaceDoc>;
    const adapter = automergeMapAdapter({ doc, relations: allMappings });

    expect(adapter.source.rows(schema.labels)).toEqual([{ name: 'Urgent' }]);
    expect(adapter.source.diagnostics?.()).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'field_missing',
        severity: 'error',
        relation: 'labels',
        field: 'id'
      })
    ]));

    const result = await adapter.target.apply([
      write(schema.labels).updateByKey('label-1', { name: 'Later' })
    ]);

    expect(result.status).toBe('rejected');
    expect(result.applied).toBe(0);
    expect(result.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'field_missing',
        relation: 'labels',
        field: 'id'
      })
    ]));
    expect(adapter.source.rows(schema.labels)).toEqual([{ name: 'Urgent' }]);
  });

  it('applies key, predicate, and map-v1 writes back to an immutable Automerge doc', async () => {
    const doc = workspaceDoc();
    const adapter = automergeMapAdapter({
      doc,
      relations: allMappings,
      changeMessage: (patches) => `tarstate ${patches.length}`
    });
    let notifications = 0;
    const unsubscribe = adapter.subscribe(() => {
      notifications += 1;
    });

    const result = await adapter.target.apply([
      write(schema.tasks).insert({ id: 'task-2', title: 'Ship' }),
      write(schema.tasks).updateByKey('task-1', { title: 'Renamed' }),
      write(schema.labels).insertOrReplace({ id: 'label-2', name: 'Later' })
    ]);

    expect(result.status).toBe('accepted');
    expect(result.applied).toBe(3);
    expect(result.diagnostics).toEqual([]);
    expect(result.deltas.map((delta) => delta.relation.name)).toEqual(['tasks', 'labels']);
    expect(notifications).toBe(1);
    expect(adapter.getDoc()).not.toBe(doc);
    expect(adapter.source.rows(schema.tasks)).toEqual([
      { id: 'task-1', title: 'Renamed' },
      { id: 'task-2', title: 'Ship' }
    ]);
    expect(adapter.source.rows(schema.labels)).toEqual([
      { id: 'label-1', name: 'Urgent' },
      { id: 'label-2', name: 'Later' }
    ]);
    expect(adapter.getDoc().workspace.labelsById['label-2']).toEqual({ id: 'label-2', name: 'Later' });

    const deleteResult = await adapter.target.apply([
      write(schema.tasks).delete(eq(field('tasks', 'title'), 'Renamed'))
    ]);

    expect(deleteResult.status).toBe('accepted');
    expect(adapter.source.rows(schema.tasks)).toEqual([{ id: 'task-2', title: 'Ship' }]);
    expect(notifications).toBe(2);
    unsubscribe();
  });

  it('matches core null and missing semantics for predicate writes', async () => {
    const adapter = automergeMapAdapter({ doc: predicateWorkspaceDoc(), relations: taskMapping });
    const memo = field('tasks', 'memo');

    expect(adapter.target.apply([
      write(schema.tasks).update(notNull(memo), { title: 'Not null' })
    ])).toMatchObject({ status: 'accepted', applied: 1 });
    expect(adapter.source.rows(schema.tasks)).toEqual([
      { id: 'task-1', title: 'Not null', memo: 'ready' },
      { id: 'task-2', title: 'Null memo', memo: null },
      { id: 'task-3', title: 'Missing memo' }
    ]);

    expect(adapter.target.apply([
      write(schema.tasks).update(isNull(memo), { title: 'Null' })
    ])).toMatchObject({ status: 'accepted', applied: 1 });
    expect(adapter.source.rows(schema.tasks)).toEqual([
      { id: 'task-1', title: 'Not null', memo: 'ready' },
      { id: 'task-2', title: 'Null', memo: null },
      { id: 'task-3', title: 'Missing memo' }
    ]);

    expect(adapter.target.apply([
      write(schema.tasks).update(isMissing(memo), { title: 'Missing' })
    ])).toMatchObject({ status: 'accepted', applied: 1 });
    expect(adapter.source.rows(schema.tasks)).toEqual([
      { id: 'task-1', title: 'Not null', memo: 'ready' },
      { id: 'task-2', title: 'Null', memo: null },
      { id: 'task-3', title: 'Missing' }
    ]);

    expect(adapter.target.apply([
      write(schema.tasks).delete(notMissing(memo))
    ])).toMatchObject({ status: 'accepted', applied: 1 });
    expect(adapter.source.rows(schema.tasks)).toEqual([
      { id: 'task-3', title: 'Missing' }
    ]);
  });

  it('requires exact full-row equality for deleteExact', async () => {
    const adapter = automergeMapAdapter({ doc: workspaceDoc(), relations: taskMapping });

    const partialResult = await adapter.target.apply([
      write(schema.tasks).deleteExact({ id: 'task-1' } as TaskRow)
    ]);

    expect(partialResult.status).toBe('accepted');
    expect(partialResult.applied).toBe(0);
    expect(adapter.source.rows(schema.tasks)).toEqual([{ id: 'task-1', title: 'Draft' }]);

    const exactResult = await adapter.target.apply([
      write(schema.tasks).deleteExact({ id: 'task-1', title: 'Draft' })
    ]);

    expect(exactResult.status).toBe('accepted');
    expect(exactResult.applied).toBe(1);
    expect(adapter.source.rows(schema.tasks)).toEqual([]);
  });

  it('evaluates expression-valued update maps against current rows', async () => {
    const adapter = automergeMapAdapter({ doc: expressionWorkspaceDoc(), relations: taskMapping });
    const upper = hostFn<string>('text.upper', (input) => String(input).toUpperCase());
    const join = hostFn<string>('text.join', (...parts) => parts.map(String).join(''));
    const taskId = field<string>('tasks', 'id');
    const taskTitle = field<string>('tasks', 'title');

    const result = await adapter.target.apply([
      write(schema.tasks).updateByKey('task-1', {
        title: call(upper, taskTitle)
      }),
      write(schema.tasks).update(eq(taskId, 'task-2'), {
        memo: call(join, taskId, value(':memo'))
      }),
      write(schema.tasks).update(eq(tuple(taskId, taskTitle), tuple(value('task-2'), value('Todo'))), {
        effort: 3
      }),
      write(schema.tasks).insertOrUpdate({ id: 'task-1', title: 'Ignored incoming' }, {
        update: { title: call(join, taskTitle, value('!')) }
      }),
      write(schema.tasks).insertOrMerge({ id: 'task-3', title: 'Incoming' }, {
        merge: () => ({ title: call(join, taskTitle, value('+merged')) })
      })
    ]);

    expect(result.status).toBe('accepted');
    expect(result.applied).toBe(5);
    expect(result.diagnostics).toEqual([]);
    expect(adapter.source.rows(schema.tasks)).toEqual([
      { id: 'task-1', title: 'DRAFT!' },
      { id: 'task-2', title: 'Todo', memo: 'task-2:memo', effort: 3 },
      { id: 'task-3', title: 'Merge+merged' }
    ]);
  });

  it('evaluates env and selection expressions against staged Automerge rows', async () => {
    const adapter = automergeMapAdapter({
      doc: workspaceDoc([
        { id: 'task-1', title: 'Draft', projectId: 'label-1' },
        { id: 'task-2', title: 'Todo', projectId: 'label-2' }
      ]),
      relations: allMappings,
      env: { prefix: 'Ready' }
    });
    const join = hostFn<string>('text.join', (...parts) => parts.map(String).join(''));
    const labelName = hostFn<string>('label.name', (input) =>
      typeof input === 'object' && input !== null && 'name' in input
        ? String((input as { readonly name: unknown }).name)
        : 'missing');
    const labelForTask = sel1(from(schema.labels), correlate<TaskRow, LabelRow>({ projectId: 'id' }));
    const labelsForTask = sel(
      pipe(
        from(schema.labels),
        project({
          id: field<string>('labels', 'id'),
          name: field<string>('labels', 'name')
        })
      ),
      correlate<TaskRow, Pick<LabelRow, 'id' | 'name'>>({ projectId: 'id' })
    );

    const result = await adapter.target.apply([
      write(schema.labels).insertOrReplace({ id: 'label-2', name: 'Later' }),
      write(schema.tasks).update(notMissing(labelForTask), {
        title: call(join, env<string>('prefix'), value(': '), field<string>('tasks', 'title')),
        memo: call(labelName, labelForTask),
        meta: labelsForTask
      })
    ]);

    expect(result.status).toBe('accepted');
    expect(result.applied).toBe(2);
    expect(result.diagnostics).toEqual([]);
    expect(adapter.source.rows(schema.tasks)).toEqual([
      {
        id: 'task-1',
        title: 'Ready: Draft',
        projectId: 'label-1',
        memo: 'Urgent',
        meta: [{ id: 'label-1', name: 'Urgent' }]
      },
      {
        id: 'task-2',
        title: 'Ready: Todo',
        projectId: 'label-2',
        memo: 'Later',
        meta: [{ id: 'label-2', name: 'Later' }]
      }
    ]);
  });

  it('uses apply context env for expression-valued writes', async () => {
    const adapter = automergeMapAdapter({
      doc: workspaceDoc(),
      relations: taskMapping,
      env: { prefix: 'Adapter' }
    });
    const join = hostFn<string>('text.join', (...parts) => parts.map(String).join(''));

    const result = await adapter.target.apply([
      write(schema.tasks).updateByKey('task-1', {
        title: call(join, env<string>('prefix'), value(': '), field<string>('tasks', 'title'))
      })
    ], { env: { prefix: 'Context' } });

    expect(result.status).toBe('accepted');
    expect(result.diagnostics).toEqual([]);
    expect(adapter.source.rows(schema.tasks)).toEqual([
      { id: 'task-1', title: 'Context: Draft' }
    ]);
  });

  it('fuzzes adapter write validation against core row validation', async () => {
    const invalidRows = generatedInvalidTaskRows();
    const baselineRows = [{ id: 'task-1', title: 'Draft' }] satisfies readonly TaskRow[];

    for (const row of invalidRows) {
      const coreDiagnostics = summarizeDiagnostics(validateRelationRow(schema.tasks, row as never));
      expect(coreDiagnostics.length, `core accepted invalid row ${JSON.stringify(row)}`).toBeGreaterThan(0);

      const insertPatches = [
        write(schema.tasks).insert(row as never),
        write(schema.tasks).insertIgnore(row as never),
        write(schema.tasks).insertOrReplace(row as never),
        write(schema.tasks).insertOrMerge(row as never),
        write(schema.tasks).insertOrUpdate(row as never),
        write(schema.tasks).replaceAll([row as never])
      ];

      for (const patch of insertPatches) {
        const adapter = automergeMapAdapter({ doc: workspaceDoc(baselineRows), relations: taskMapping });
        const result = await adapter.target.apply([patch]);

        expect(result.status, `adapter accepted invalid row ${JSON.stringify(row)}`).toBe('rejected');
        expect(result.applied).toBe(0);
        expect(summarizeDiagnostics(result.diagnostics)).toEqual(coreDiagnostics);
        expect(adapter.source.rows(schema.tasks)).toEqual(baselineRows);
      }
    }
  });

  it('fuzzes valid writes and invalid update maps without mutating rejected docs', async () => {
    const validRows = generatedValidTaskRows();
    const invalidUpdates = generatedInvalidTaskUpdates();
    const taskId = field('tasks', 'id');

    for (const [index, row] of validRows.entries()) {
      const insertCases = [
        write(schema.tasks).insert(row),
        write(schema.tasks).insertIgnore(row),
        write(schema.tasks).insertOrReplace(row),
        write(schema.tasks).insertOrMerge(row),
        write(schema.tasks).insertOrUpdate(row)
      ];

      for (const patch of insertCases) {
        const adapter = automergeMapAdapter({ doc: workspaceDoc([]), relations: taskMapping });
        const result = await adapter.target.apply([patch]);

        expect(result.status).toBe('accepted');
        expect(result.applied).toBe(1);
        expect(adapter.source.rows(schema.tasks)).toEqual([row]);
      }

      const nextTitle = `Updated ${index}`;
      const byKeyAdapter = automergeMapAdapter({ doc: workspaceDoc([row]), relations: taskMapping });
      const byKeyResult = await byKeyAdapter.target.apply([
        write(schema.tasks).updateByKey(row.id, { title: nextTitle })
      ]);
      expect(byKeyResult.status).toBe('accepted');
      expect(byKeyResult.applied).toBe(1);
      expect(byKeyAdapter.source.rows(schema.tasks)).toEqual([{ ...row, title: nextTitle }]);

      const predicateAdapter = automergeMapAdapter({ doc: workspaceDoc([row]), relations: taskMapping });
      const predicateResult = await predicateAdapter.target.apply([
        write(schema.tasks).update(eq(taskId, row.id), { title: nextTitle })
      ]);
      expect(predicateResult.status).toBe('accepted');
      expect(predicateResult.applied).toBe(1);
      expect(predicateAdapter.source.rows(schema.tasks)).toEqual([{ ...row, title: nextTitle }]);

      const replacement = { ...row, title: `Replaced ${index}` };
      const replaceExistingAdapter = automergeMapAdapter({ doc: workspaceDoc([row]), relations: taskMapping });
      const replaceExistingResult = await replaceExistingAdapter.target.apply([
        write(schema.tasks).insertOrReplace(replacement)
      ]);
      expect(replaceExistingResult.status).toBe('accepted');
      expect(replaceExistingResult.applied).toBe(1);
      expect(replaceExistingAdapter.source.rows(schema.tasks)).toEqual([replacement]);

      const mergeExistingAdapter = automergeMapAdapter({ doc: workspaceDoc([row]), relations: taskMapping });
      const mergeExistingResult = await mergeExistingAdapter.target.apply([
        write(schema.tasks).insertOrMerge({ ...row, title: `Merged ${index}` }, { merge: ['title'] })
      ]);
      expect(mergeExistingResult.status).toBe('accepted');
      expect(mergeExistingResult.applied).toBe(1);
      expect(mergeExistingAdapter.source.rows(schema.tasks)).toEqual([{ ...row, title: `Merged ${index}` }]);

      const updateExistingAdapter = automergeMapAdapter({ doc: workspaceDoc([row]), relations: taskMapping });
      const updateExistingResult = await updateExistingAdapter.target.apply([
        write(schema.tasks).insertOrUpdate({ ...row, title: 'Ignored incoming' }, { update: { title: nextTitle } })
      ]);
      expect(updateExistingResult.status).toBe('accepted');
      expect(updateExistingResult.applied).toBe(1);
      expect(updateExistingAdapter.source.rows(schema.tasks)).toEqual([{ ...row, title: nextTitle }]);
    }

    const replaceRows = validRows.slice(0, 8);
    const replaceAdapter = automergeMapAdapter({ doc: workspaceDoc(), relations: taskMapping });
    const replaceResult = await replaceAdapter.target.apply([
      write(schema.tasks).replaceAll(replaceRows)
    ]);
    expect(replaceResult.status).toBe('accepted');
    expect(replaceResult.applied).toBe(1);
    expect(replaceAdapter.source.rows(schema.tasks)).toEqual(replaceRows);

    for (const changes of invalidUpdates) {
      const adapter = automergeMapAdapter({ doc: workspaceDoc(), relations: taskMapping });
      const byKeyResult = await adapter.target.apply([
        write(schema.tasks).updateByKey('task-1', changes as never)
      ]);
      expect(byKeyResult.status).toBe('rejected');
      expect(byKeyResult.applied).toBe(0);
      expect(byKeyResult.diagnostics.some((diagnostic) => diagnostic.severity === 'error')).toBe(true);
      expect(adapter.source.rows(schema.tasks)).toEqual([{ id: 'task-1', title: 'Draft' }]);

      const predicateAdapter = automergeMapAdapter({ doc: workspaceDoc(), relations: taskMapping });
      const predicateResult = await predicateAdapter.target.apply([
        write(schema.tasks).update(eq(taskId, 'task-1'), changes as never)
      ]);
      expect(predicateResult.status).toBe('rejected');
      expect(predicateResult.applied).toBe(0);
      expect(predicateResult.diagnostics.some((diagnostic) => diagnostic.severity === 'error')).toBe(true);
      expect(predicateAdapter.source.rows(schema.tasks)).toEqual([{ id: 'task-1', title: 'Draft' }]);

      const mergeAdapter = automergeMapAdapter({ doc: workspaceDoc(), relations: taskMapping });
      const mergeResult = await mergeAdapter.target.apply([
        write(schema.tasks).insertOrMerge({ id: 'task-1', title: 'Incoming' }, { merge: () => changes as never })
      ]);
      expect(mergeResult.status).toBe('rejected');
      expect(mergeResult.applied).toBe(0);
      expect(mergeResult.diagnostics.some((diagnostic) => diagnostic.severity === 'error')).toBe(true);
      expect(mergeAdapter.source.rows(schema.tasks)).toEqual([{ id: 'task-1', title: 'Draft' }]);

      const upsertUpdateAdapter = automergeMapAdapter({ doc: workspaceDoc(), relations: taskMapping });
      const upsertUpdateResult = await upsertUpdateAdapter.target.apply([
        write(schema.tasks).insertOrUpdate({ id: 'task-1', title: 'Incoming' }, { update: changes as never })
      ]);
      expect(upsertUpdateResult.status).toBe('rejected');
      expect(upsertUpdateResult.applied).toBe(0);
      expect(upsertUpdateResult.diagnostics.some((diagnostic) => diagnostic.severity === 'error')).toBe(true);
      expect(upsertUpdateAdapter.source.rows(schema.tasks)).toEqual([{ id: 'task-1', title: 'Draft' }]);
    }
  });

  it('rejects mixed batches without committing callback-mutated staged rows', async () => {
    const baselineRows = [
      { id: 'task-1', title: 'Draft' },
      { id: 'task-2', title: 'Todo' }
    ] satisfies readonly TaskRow[];
    const taskId = field('tasks', 'id');
    const cases = [
      write(schema.tasks).insertOrMerge({ id: 'task-1', title: 'Incoming' }, {
        merge: ((current: TaskRow) => {
          (current as unknown as Record<string, unknown>).title = 'Mutated by merge callback';
          return { title: null };
        }) as never
      }),
      write(schema.tasks).insertOrUpdate({ id: 'task-1', title: 'Incoming' }, {
        update: ((current: TaskRow) => {
          (current as unknown as Record<string, unknown>).title = 'Mutated by update callback';
          return { title: null };
        }) as never
      })
    ];

    for (const rejectedPatch of cases) {
      const adapter = automergeMapAdapter({ doc: workspaceDoc(baselineRows), relations: taskMapping });
      const beforeDoc = adapter.getDoc();
      const beforeHeads = Automerge.getHeads(beforeDoc);

      const result = await adapter.target.apply([
        write(schema.tasks).update(eq(taskId, 'task-2'), { title: 'Changed first' }),
        rejectedPatch
      ]);

      expect(result.status).toBe('rejected');
      expect(result.applied).toBe(0);
      expect(result.diagnostics.some((diagnostic) => diagnostic.severity === 'error')).toBe(true);
      expect(adapter.getDoc()).toBe(beforeDoc);
      expect(Automerge.getHeads(adapter.getDoc())).toEqual(beforeHeads);
      expect(adapter.source.rows(schema.tasks)).toEqual(baselineRows);
    }
  });

  it('ignores insertOrMerge callback current mutations unless returned', async () => {
    const adapter = automergeMapAdapter({
      doc: workspaceDoc([{ id: 'task-1', title: 'Draft' }]),
      relations: taskMapping
    });

    const result = await adapter.target.apply([
      write(schema.tasks).insertOrMerge({ id: 'task-1', title: 'Incoming' }, {
        merge: ((current: TaskRow) => {
          (current as unknown as Record<string, unknown>).title = 'MUTATED';
          return { memo: 'ok' };
        }) as never
      })
    ]);

    expect(result.status).toBe('accepted');
    expect(result.applied).toBe(1);
    expect(adapter.source.rows(schema.tasks)).toEqual([
      { id: 'task-1', title: 'Draft', memo: 'ok' }
    ]);
  });

  it('rejects unsupported update expressions instead of storing expression objects', async () => {
    const adapter = automergeMapAdapter({ doc: workspaceDoc(), relations: taskMapping });

    const result = await adapter.target.apply([
      write(schema.tasks).updateByKey('task-1', {
        title: { op: 'customExpr', name: 'title' } as never
      })
    ]);

    expect(result.status).toBe('rejected');
    expect(result.applied).toBe(0);
    expect(result.diagnostics[0]).toMatchObject({
      code: 'runtime_unsupported',
      relation: 'tasks'
    });
    expect(adapter.source.rows(schema.tasks)).toEqual([{ id: 'task-1', title: 'Draft' }]);
  });

  it('rejects non-object update output instead of accepting a no-op', async () => {
    const taskId = field('tasks', 'id');
    const cases = [
      write(schema.tasks).updateByKey('task-1', null as never),
      write(schema.tasks).update(eq(taskId, 'task-1'), 'not an update' as never),
      write(schema.tasks).insertOrUpdate({ id: 'task-1', title: 'Incoming' }, { update: 42 as never }),
      write(schema.tasks).insertOrUpdate({ id: 'task-1', title: 'Incoming' }, { update: (() => null) as never }),
      write(schema.tasks).insertOrMerge({ id: 'task-1', title: 'Incoming' }, { merge: (() => 'no row') as never })
    ];

    for (const patch of cases) {
      const adapter = automergeMapAdapter({ doc: workspaceDoc(), relations: taskMapping });
      const beforeDoc = adapter.getDoc();

      const result = await adapter.target.apply([patch]);

      expect(result.status).toBe('rejected');
      expect(result.applied).toBe(0);
      expect(result.diagnostics).toEqual([
        expect.objectContaining({
          code: 'row_invalid',
          severity: 'error',
          relation: 'tasks'
        })
      ]);
      expect(adapter.getDoc()).toBe(beforeDoc);
      expect(adapter.source.rows(schema.tasks)).toEqual([{ id: 'task-1', title: 'Draft' }]);
    }
  });

  it('supports setDoc/snapshot and reports unsupported writes honestly', async () => {
    const adapter = automergeMapAdapter({ doc: workspaceDoc(), relations: taskMapping });
    let notifications = 0;
    adapter.subscribe(() => {
      notifications += 1;
    });

    const nextDoc = Automerge.change(adapter.getDoc(), (draft) => {
      (draft.workspace.tasks as TaskRow[]).push({ id: 'task-2', title: 'From setDoc' });
    });
    adapter.setDoc(nextDoc);

    const result = await adapter.target.apply([
      write(schema.labels).insert({ id: 'label-2', name: 'Unmapped' })
    ]);

    expect(notifications).toBe(1);
    expect(adapter.snapshot().source.rows(schema.tasks)).toEqual([
      { id: 'task-1', title: 'Draft' },
      { id: 'task-2', title: 'From setDoc' }
    ]);
    expect(result.status).toBe('rejected');
    expect(result.diagnostics[0]?.code).toBe('runtime_unsupported');
  });

  it('subscribes to DocHandle changes and writes through the handle', async () => {
    const handle = workspaceHandle();
    const adapter = createAutomergeDocHandleRuntime({ handle, relations: taskMapping });
    let notifications = 0;
    const unsubscribe = adapter.subscribe(() => {
      notifications += 1;
    });

    handle.change((draft) => {
      (draft.workspace.tasks as TaskRow[]).push({ id: 'task-2', title: 'Remote-ish' });
    });

    const result = await adapter.target.apply([
      write(schema.tasks).updateByKey('task-2', { title: 'Via handle runtime' })
    ]);

    expect(adapter.handle).toBe(handle);
    expect(adapter.kind).toBe('automergeDocHandleRuntime');
    expect(adapter.source.rows(schema.tasks)).toEqual([
      { id: 'task-1', title: 'Draft' },
      { id: 'task-2', title: 'Via handle runtime' }
    ]);
    expect(handle.doc().workspace.tasks[1]?.title).toBe('Via handle runtime');
    expect(adapter.snapshot().version).toEqual(Automerge.getHeads(handle.doc()));
    expect(result).toMatchObject({ status: 'accepted', applied: 1 });
    expect(notifications).toBe(2);

    unsubscribe();
    adapter.close();
  });

  it('attaches DocHandle change listeners only while runtime subscribers are active', () => {
    const handle = workspaceHandle();
    const originalOn = handle.on.bind(handle);
    const originalOff = handle.off.bind(handle);
    let changeListeners = 0;
    handle.on = ((eventName, listener) => {
      if (eventName === 'change') changeListeners += 1;
      return originalOn(eventName as never, listener as never);
    }) as typeof handle.on;
    handle.off = ((eventName, listener) => {
      if (eventName === 'change') changeListeners -= 1;
      return originalOff(eventName as never, listener as never);
    }) as typeof handle.off;

    const adapter = createAutomergeDocHandleRuntime({ handle, relations: taskMapping });

    expect(changeListeners).toBe(0);

    const unsubscribe = adapter.subscribe(() => {});
    expect(changeListeners).toBe(1);

    unsubscribe();
    expect(changeListeners).toBe(0);

    adapter.close();
    expect(changeListeners).toBe(0);
  });

  it('preserves mapped row object IDs for ordinary array and map updates', async () => {
    const adapter = automergeMapAdapter({ doc: workspaceDoc(), relations: allMappings, runtimeId: 'workspace' });
    const taskObjectId = adapter.objectIdFor(schema.tasks, 'task-1');
    const labelObjectId = adapter.objectIdFor(schema.labels, 'label-1');

    const taskCollectionObjectId = automergeObjectIdAt(adapter.getDoc(), ['workspace', 'tasks']);
    expect(taskObjectId).toBeTruthy();
    expect(labelObjectId).toBeTruthy();
    if (taskObjectId === null || labelObjectId === null) throw new Error('expected mapped row object IDs');
    expect(taskCollectionObjectId).toBe(automergeObjectId(adapter.getDoc().workspace.tasks));
    expect(automergeObjectIdAt(adapter.getDoc(), ['workspace', 'tasks', 0])).toBe(taskObjectId);
    expect(automergeObjectReferenceAt(adapter.getDoc(), ['workspace', 'tasks', 0])).toMatchObject({
      objectId: taskObjectId,
      path: ['workspace', 'tasks', 0]
    });
    expect(adapter.objectReferenceFor(schema.tasks, 'task-1')).toMatchObject({
      objectId: taskObjectId,
      path: ['workspace', 'tasks', 0],
      relation: 'tasks',
      key: 'task-1'
    });
    expect(adapter.pathForObjectId(taskObjectId)).toEqual(['workspace', 'tasks', 0]);
    expect(automergePathForObjectId(adapter.getDoc(), taskObjectId)).toEqual(['workspace', 'tasks', 0]);
    const publicLocations = automergeObjectLocations(adapter.getDoc(), { relations: allMappings });
    expect(publicLocations).toEqual(expect.arrayContaining([
      expect.objectContaining({
        objectId: taskObjectId,
        path: ['workspace', 'tasks', 0],
        relation: 'tasks',
        key: 'task-1'
      }) satisfies Partial<AutomergeObjectLocation>
    ]));
    expect(publicLocations.some((location) => 'pathSegments' in location)).toBe(false);
    expect(adapter.source.rows(runtimeSystemRelations.objectLocations)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        runtime: 'workspace',
        objectId: taskObjectId,
        pathSegments: ['workspace', 'tasks', 0],
        relation: 'tasks',
        key: 'task-1'
      }),
      expect.objectContaining({
        runtime: 'workspace',
        objectId: labelObjectId,
        pathSegments: ['workspace', 'labelsById', 'label-1'],
        relation: 'labels',
        key: 'label-1'
      })
    ]));
    const objectLocation = as(runtimeSystemRelations.objectLocations, 'objectLocation');
    const presenceFocus = as(
      pipe(
        constRows([{ peer: 'peer-remote', payload: { objectId: taskObjectId } }]),
        qualify('presenceFocus')
      ),
      'presenceFocus'
    );
    const resolvedFocus = pipe(
      presenceFocus,
      join(
        from(objectLocation),
        eq(getKey<string>(presenceFocus.row.payload, value('objectId')), objectLocation.row.objectId)
      ),
      project({
        peer: presenceFocus.row.peer,
        path: objectLocation.row.pathSegments,
        relation: objectLocation.row.relation,
        key: objectLocation.row.key
      })
    );

    expect(evaluate(adapter.source, resolvedFocus)).toEqual({
      rows: [
        {
          peer: 'peer-remote',
          path: ['workspace', 'tasks', 0],
          relation: 'tasks',
          key: 'task-1'
        }
      ],
      diagnostics: []
    });

    const result = await adapter.target.apply([
      write(schema.tasks).updateByKey('task-1', { title: 'Edited' }),
      write(schema.labels).updateByKey('label-1', { name: 'Important' })
    ]);

    expect(result).toMatchObject({ status: 'accepted', applied: 2 });
    expect(adapter.source.rows(schema.tasks)).toEqual([{ id: 'task-1', title: 'Edited' }]);
    expect(adapter.source.rows(schema.labels)).toEqual([{ id: 'label-1', name: 'Important' }]);
    expect(adapter.objectIdFor(schema.tasks, 'task-1')).toBe(taskObjectId);
    expect(adapter.objectIdFor(schema.labels, 'label-1')).toBe(labelObjectId);

    const editedHeads = Automerge.getHeads(adapter.getDoc());
    adapter.setDoc(Automerge.change(adapter.getDoc(), (draft) => {
      (draft.workspace.tasks as TaskRow[]).unshift({ id: 'task-0', title: 'Prep' });
    }));
    expect(adapter.pathForObjectId(taskObjectId)).toEqual(['workspace', 'tasks', 1]);
    expect(automergePathForObjectId(automergeView(adapter.getDoc(), editedHeads), taskObjectId))
      .toEqual(['workspace', 'tasks', 0]);

    adapter.setDoc(Automerge.change(adapter.getDoc(), (draft) => {
      (draft.workspace.tasks as TaskRow[]).splice(1, 1);
    }));
    expect(adapter.pathForObjectId(taskObjectId)).toBeNull();
  });

  it('resolves map object IDs by composite custom storage key and checks the row key', () => {
    type OwnerKey = {
      readonly kind: string;
      readonly id: string;
    };
    type RoutedRow = {
      readonly owner: OwnerKey;
      readonly localId: string;
      readonly title: string;
    };
    interface CompositeStorageDoc {
      readonly itemsByKey: Readonly<Record<string, RoutedRow>>;
    }

    const isOwnerKey = (value: unknown): value is OwnerKey =>
      typeof value === 'object'
      && value !== null
      && typeof (value as Partial<OwnerKey>).kind === 'string'
      && typeof (value as Partial<OwnerKey>).id === 'string';
    const ownerKey = (value: unknown) =>
      isOwnerKey(value) ? `${value.kind}:${value.id}` : String(value);
    const ownerAlpha = { kind: 'team', id: 'alpha' };
    const ownerBeta = { kind: 'team', id: 'beta' };
    const storageKey = JSON.stringify(['team:alpha', 'first']);
    const mismatchedStorageKey = JSON.stringify(['team:alpha', 'second']);
    const compositeSchema = defineSchema({
      routedItems: relation<RoutedRow>({
        key: ['owner', 'localId'],
        fields: {
          owner: customField<OwnerKey>({
            codec: 'owner-key',
            stableKey: ownerKey
          }),
          localId: stringField(),
          title: stringField()
        }
      })
    });
    const compositeRelations = defineAutomergeMapRelations<CompositeStorageDoc>()([
      { relation: compositeSchema.routedItems, path: ['itemsByKey'] }
    ]);
    const doc: Automerge.Doc<CompositeStorageDoc> = Automerge.from({
      itemsByKey: {
        stale: { owner: ownerAlpha, localId: 'first', title: 'Duplicate under stale key' },
        [storageKey]: { owner: ownerAlpha, localId: 'first', title: 'Stored row' },
        [mismatchedStorageKey]: { owner: ownerBeta, localId: 'second', title: 'Mismatched row' }
      }
    });
    const adapter = automergeMapAdapter({ doc, relations: compositeRelations });
    const staleObjectId = automergeObjectIdAt(doc, ['itemsByKey', 'stale']);
    const storedObjectId = automergeObjectIdAt(doc, ['itemsByKey', storageKey]);
    const mismatchedObjectId = automergeObjectIdAt(doc, ['itemsByKey', mismatchedStorageKey]);

    if (staleObjectId === null || storedObjectId === null || mismatchedObjectId === null) {
      throw new Error('expected mapped Automerge object IDs');
    }

    expect(staleObjectId).not.toBe(storedObjectId);
    expect(adapter.objectIdFor(compositeSchema.routedItems, ['team:alpha', 'first'])).toBe(storedObjectId);
    expect(adapter.objectIdFor(compositeSchema.routedItems, [ownerAlpha, 'first'])).toBeNull();
    expect(adapter.objectIdFor(compositeSchema.routedItems, ['team:alpha', 'second'])).toBeNull();
  });

  it('wraps stable Automerge view, fork, changeAt, and merge flows', () => {
    let doc = workspaceDoc();
    const baseHeads = Automerge.getHeads(doc);

    doc = Automerge.change(doc, (draft) => {
      (draft.workspace.tasks as TaskRow[]).push({ id: 'task-live', title: 'Live branch' });
    });

    const fork = automergeFork(automergeView(doc, baseHeads));
    const editedFork = Automerge.change(fork, (draft) => {
      (draft.workspace.tasks as TaskRow[]).push({ id: 'task-fork', title: 'Fork branch' });
    });
    const merged = automergeMerge(doc, editedFork);
    const changedAt = automergeChangeAt(merged, baseHeads, (draft) => {
      (draft.workspace.tasks as TaskRow[]).push({ id: 'task-at', title: 'Backdated branch' });
    }, 'backdated task');

    expect(automergeView(merged, baseHeads).workspace.tasks).toEqual([{ id: 'task-1', title: 'Draft' }]);
    expect(changedAt.newHeads).not.toBeNull();
    expect(changedAt.newDoc.workspace.tasks.map((task) => task.id).sort()).toEqual([
      'task-1',
      'task-at',
      'task-fork',
      'task-live'
    ]);
  });

  it('queries schemas over rewound Automerge heads and forks edits from old state', async () => {
    let doc = workspaceDoc([{ id: 'task-1', title: 'Draft', effort: 1 }]);
    const baseHeads = Automerge.getHeads(doc);

    doc = Automerge.change(doc, (draft) => {
      (draft.workspace.tasks as TaskRow[]).push({ id: 'task-live', title: 'Live branch', effort: 5 });
    });

    const liveSource = automergeMapSource(doc, { relations: allMappings });
    const oldDoc = automergeView(doc, baseHeads);
    const oldSource = automergeMapSource(oldDoc, { relations: allMappings });
    const activeTasks = pipe(
      from(schema.tasks),
      where(gte(field<number>('tasks', 'effort'), value(2))),
      project({
        id: field<string>('tasks', 'id'),
        title: field<string>('tasks', 'title')
      })
    );

    expect(liveSource.version?.()).toEqual(Automerge.getHeads(doc));
    expect(oldSource.version?.()).toEqual(baseHeads);
    expect(evaluate(liveSource, activeTasks)).toEqual({
      rows: [{ id: 'task-live', title: 'Live branch' }],
      diagnostics: []
    });
    expect(evaluate(oldSource, activeTasks)).toEqual({ rows: [], diagnostics: [] });
    expect(oldSource.rows(schema.labels)).toEqual([{ id: 'label-1', name: 'Urgent' }]);

    const forkAdapter = automergeMapAdapter({
      doc: automergeFork(oldDoc),
      relations: allMappings
    });
    const forkResult = await forkAdapter.target.apply([
      write(schema.tasks).insert({ id: 'task-fork', title: 'Fork branch', effort: 3 })
    ]);

    expect(forkResult).toMatchObject({ status: 'accepted', applied: 1 });
    expect(evaluate(forkAdapter.source, activeTasks)).toEqual({
      rows: [{ id: 'task-fork', title: 'Fork branch' }],
      diagnostics: []
    });
    expect(evaluate(liveSource, activeTasks)).toEqual({
      rows: [{ id: 'task-live', title: 'Live branch' }],
      diagnostics: []
    });

    const merged = automergeMerge(doc, forkAdapter.getDoc());
    const backdated = automergeChangeAt(merged, baseHeads, (draft) => {
      (draft.workspace.tasks as TaskRow[]).push({ id: 'task-at', title: 'Backdated branch', effort: 4 });
    }, 'backdated task');
    const mergedSource = automergeMapSource(backdated.newDoc, { relations: allMappings });
    const taskIds = mergedSource.rows(schema.tasks)
      .map((row) => (row as TaskRow).id)
      .sort();

    expect(backdated.newHeads).not.toBeNull();
    expect(taskIds).toEqual(['task-1', 'task-at', 'task-fork', 'task-live']);
    expect(automergeMapSource(automergeView(backdated.newDoc, baseHeads), { relations: allMappings })
      .rows(schema.tasks))
      .toEqual([{ id: 'task-1', title: 'Draft', effort: 1 }]);
  });

  it('pins Automerge adapter snapshot sources to captured document heads', () => {
    const adapter = automergeMapAdapter({
      doc: workspaceDoc([{ id: 'task-1', title: 'Draft', effort: 1 }]),
      relations: allMappings,
      runtimeId: 'workspace'
    });
    const snapshot = adapter.snapshot();
    const taskObjectId = adapter.objectIdFor(schema.tasks, 'task-1');
    if (taskObjectId === null) throw new Error('expected task object id');

    adapter.setDoc(Automerge.change(adapter.getDoc(), (draft) => {
      (draft.workspace.tasks as TaskRow[]).unshift({ id: 'task-0', title: 'Prep', effort: 2 });
    }));

    expect(snapshot.version).not.toEqual(Automerge.getHeads(adapter.getDoc()));
    expect(snapshot.source.version?.()).toEqual(snapshot.version);
    expect(snapshot.source.rows(schema.tasks)).toEqual([{ id: 'task-1', title: 'Draft', effort: 1 }]);
    expect(adapter.source.rows(schema.tasks)).toEqual([
      { id: 'task-0', title: 'Prep', effort: 2 },
      { id: 'task-1', title: 'Draft', effort: 1 }
    ]);
    expect(snapshot.source.rows(runtimeSystemRelations.objectLocations)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        objectId: taskObjectId,
        pathSegments: ['workspace', 'tasks', 0],
        relation: 'tasks',
        key: 'task-1'
      })
    ]));
    expect(adapter.source.rows(runtimeSystemRelations.objectLocations)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        objectId: taskObjectId,
        pathSegments: ['workspace', 'tasks', 1],
        relation: 'tasks',
        key: 'task-1'
      })
    ]));
  });

  it('composes historical document views with separately versioned presence-like state', () => {
    type PresenceVersion = {
      readonly kind: 'presence';
      readonly revision: number;
    };

    let doc = workspaceDoc([{ id: 'task-1', title: 'Draft', effort: 1 }]);
    const baseHeads = Automerge.getHeads(doc);
    const oldDoc = automergeView(doc, baseHeads);
    const taskObjectId = automergeObjectIdAt(oldDoc, ['workspace', 'tasks', 0]);
    if (taskObjectId === null) throw new Error('expected task object id');

    doc = Automerge.change(doc, (draft) => {
      (draft.workspace.tasks as TaskRow[]).unshift({ id: 'task-0', title: 'Prep', effort: 2 });
    });

    const presenceVersion = { kind: 'presence', revision: 7 } satisfies PresenceVersion;
    const presenceRows: readonly PresenceFocusRow[] = [{
      peer: 'peer-remote',
      runtime: 'workspace',
      objectId: taskObjectId,
      documentHeads: [...baseHeads]
    }];
    const presenceSource = {
      relationNames: [schema.presenceFocus.name],
      version: () => presenceVersion,
      rows: (relationRef) => relationRef.name === schema.presenceFocus.name ? presenceRows : []
    } satisfies RelationRuntime<PresenceVersion>['source'];
    const presenceRuntime = withAutomergeRuntimeRelations({
      source: presenceSource,
      snapshot: () => ({ source: presenceSource, version: presenceVersion })
    } satisfies RelationRuntime<PresenceVersion>, schema.presenceFocus);
    const historicalRuntime = createAutomergeMapRuntime({
      doc: oldDoc,
      relations: allMappings,
      runtimeId: 'workspace',
      runtimes: [presenceRuntime]
    });
    const liveRuntime = createAutomergeMapRuntime({
      doc,
      relations: allMappings,
      runtimeId: 'workspace',
      runtimes: [presenceRuntime]
    });
    const presenceFocus = as(schema.presenceFocus, 'presenceFocus');
    const objectLocations = runtimeSystemRelations.objectLocations;
    const resolvedFocus = pipe(
      from(presenceFocus),
      join(
        from(objectLocations),
        and(
          eq(presenceFocus.row.runtime, field<string>(objectLocations.name, 'runtime')),
          eq(presenceFocus.row.objectId, field<string>(objectLocations.name, 'objectId'))
        )
      ),
      project({
        peer: presenceFocus.row.peer,
        runtime: presenceFocus.row.runtime,
        documentHeads: presenceFocus.row.documentHeads,
        path: field<readonly (string | number)[]>(objectLocations.name, 'pathSegments'),
        relation: field<string | undefined>(objectLocations.name, 'relation'),
        key: field<unknown>(objectLocations.name, 'key')
      })
    );
    const historicalSnapshot = historicalRuntime.snapshot?.();

    expect(historicalRuntime.source.version?.()).toEqual([baseHeads, presenceVersion]);
    expect(historicalSnapshot?.version).toEqual([baseHeads, presenceVersion]);
    expect(evaluate(historicalSnapshot?.source ?? historicalRuntime.source, resolvedFocus)).toEqual({
      rows: [{
        peer: 'peer-remote',
        runtime: 'workspace',
        documentHeads: [...baseHeads],
        path: ['workspace', 'tasks', 0],
        relation: 'tasks',
        key: 'task-1'
      }],
      diagnostics: []
    });
    expect(evaluate(liveRuntime.source, resolvedFocus)).toEqual({
      rows: [{
        peer: 'peer-remote',
        runtime: 'workspace',
        documentHeads: [...baseHeads],
        path: ['workspace', 'tasks', 1],
        relation: 'tasks',
        key: 'task-1'
      }],
      diagnostics: []
    });
  });

  it('composes real presence runtime rows with Automerge object locations', () => {
    const repo = new Repo({ peerId: 'peer-local' as never });
    const handle = repo.create<WorkspaceDoc>({
      workspace: {
        tasks: [{ id: 'task-1', title: 'Draft', effort: 1 }],
        labelsById: {
          'label-1': { id: 'label-1', name: 'Urgent' }
        }
      }
    });
    const doc = handle.doc();
    const heads = Automerge.getHeads(doc);
    const objectId = automergeObjectIdAt(doc, ['workspace', 'tasks', 0]);
    if (objectId === null) throw new Error('expected task object id');

    const presence = automergePresenceRuntime<PeerPresenceState, WorkspaceDoc>({
      handle,
      relation: schema.peerPresence,
      fields: presenceFields,
      localPeerId: 'peer-local',
      includeLocalRows: true,
      initialState: {
        cursor: {
          runtime: 'workspace',
          objectId,
          heads: [...heads]
        }
      }
    });
    presence.start();

    const runtime = createAutomergeMapRuntime({
      doc,
      relations: allMappings,
      runtimeId: 'workspace',
      runtimes: [withAutomergeRuntimeRelations(presence, schema.peerPresence)]
    });
    const peerPresence = as(schema.peerPresence, 'peerPresence');
    const objectLocations = runtimeSystemRelations.objectLocations;
    const resolvedPresence = pipe(
      from(peerPresence),
      join(
        from(objectLocations),
        and(
          eq(getKey<string>(peerPresence.row.payload, value('runtime')), field<string>(objectLocations.name, 'runtime')),
          eq(getKey<string>(peerPresence.row.payload, value('objectId')), field<string>(objectLocations.name, 'objectId'))
        )
      ),
      project({
        peer: peerPresence.row.peer,
        topic: peerPresence.row.topic,
        heads: getKey<readonly string[]>(peerPresence.row.payload, value('heads')),
        path: field<readonly (string | number)[]>(objectLocations.name, 'pathSegments'),
        relation: field<string | undefined>(objectLocations.name, 'relation'),
        key: field<unknown>(objectLocations.name, 'key')
      })
    );
    const version = runtime.source.version?.();

    expect(Array.isArray(version) ? version[0] : undefined).toEqual(heads);
    expect(Array.isArray(version) ? version[1] : undefined).toMatchObject({
      revision: 1,
      localPeerId: 'peer-local'
    });
    expect(evaluate(runtime.source, resolvedPresence)).toEqual({
      rows: [{
        peer: 'peer-local',
        topic: 'cursor',
        heads: [...heads],
        path: ['workspace', 'tasks', 0],
        relation: 'tasks',
        key: 'task-1'
      }],
      diagnostics: []
    });

    presence.stop();
  });

  it('reports object ids and conflicts at explicit Automerge paths', () => {
    const base = workspaceDoc();
    const left = Automerge.change(automergeFork(base), (draft) => {
      (draft.workspace.tasks[0] as { title: string }).title = 'Left title';
    });
    const right = Automerge.change(automergeFork(base), (draft) => {
      (draft.workspace.tasks[0] as { title: string }).title = 'Right title';
    });
    const merged = automergeMerge(left, right);
    const conflicts = automergeConflictsAt(merged, ['workspace', 'tasks', 0, 'title']);
    const diagnostics = automergeConflictDiagnostics(merged, [['workspace', 'tasks', 0, 'title']], {
      relation: schema.tasks.name,
      field: 'title'
    });

    expect(automergeObjectIdAt(merged)).toBe('_root');
    expect(automergeObjectIdAt(merged, ['workspace', 'tasks', 0])).toEqual(expect.any(String));
    expect(conflicts.map((conflict) => conflict.value).sort((left, right) => String(left).localeCompare(String(right)))).toEqual([
      'Left title',
      'Right title'
    ]);
    expect(diagnostics).toEqual([
      expect.objectContaining({
        code: 'automerge_conflict',
        severity: 'warning',
        relation: 'tasks',
        field: 'title'
      })
    ]);
    expectTypeOf<AutomergeConflict['opId']>().toEqualTypeOf<string>();
  });

  it('normalizes Automerge runtime metadata to relations only', () => {
    const runtime = withAutomergeRuntimeRelations({
      source: {
        relationNames: ['tasks'],
        rows: () => []
      }
    }, schema.tasks);
    const mappedRuntime = withAutomergeRuntimeRelations({
      source: {
        relationNames: ['tasks'],
        rows: () => []
      }
    }, taskMapping);
    const metadata = { relations: [schema.tasks] } satisfies AutomergeRelationRuntimeMetadata;

    expect(runtime.relations).toEqual([schema.tasks]);
    expect(mappedRuntime.relations).toEqual([schema.tasks]);
    expect(isRelationRuntime(runtime)).toBe(true);
    expectTypeOf(runtime.relations).toMatchTypeOf<AutomergeRelationRuntimeMetadata['relations']>();
    // @ts-expect-error singular relation metadata was removed.
    void runtime.relation;
    void metadata;
  });

  it('composes adapter and optional runtimes through core runtime composition', async () => {
    const extraRuntime = withAutomergeRuntimeRelations({
      source: {
        relationNames: ['labels'],
        version: () => 1,
        rows: (relationRef) => relationRef.name === 'labels' ? [{ id: 'label-extra', name: 'Extra' }] : []
      },
      target: {
        relationNames: ['labels'],
        apply: (patches) => ({
          status: 'accepted',
          patches: patches.length,
          applied: patches.length,
          deltas: [],
          diagnostics: [],
          version: 2,
          durability: 'memory'
        })
      }
    } satisfies RelationRuntime<number>, schema.labels);
    const runtime = createAutomergeMapRuntime({
      doc: workspaceDoc(),
      relations: taskMapping,
      runtimes: [extraRuntime]
    });

    expect(runtime.kind).toBe('automergeMapRuntime');
    expect(runtime.adapter.source.rows(schema.tasks)).toEqual([{ id: 'task-1', title: 'Draft' }]);
    expect(runtime.source.rows(schema.tasks)).toEqual([{ id: 'task-1', title: 'Draft' }]);
    expect(runtime.source.rows(schema.labels)).toEqual([{ id: 'label-extra', name: 'Extra' }]);
    expect(runtime.relations.map((item) => item.name)).toEqual([
      'tasks',
      'labels',
      ...Object.values(runtimeSystemRelations).map((relationRef) => relationRef.name)
    ]);
    expect(isRelationRuntime(runtime)).toBe(true);
    expect(runtime.source.version?.()).toEqual([runtime.adapter.source.version?.(), 1]);
    await expect(runtime.target?.apply([
      write(schema.tasks).insert({ id: 'task-2', title: 'Via composed runtime' }),
      write(schema.labels).insert({ id: 'label-2', name: 'Via extra runtime' })
    ])).resolves.toMatchObject({ status: 'accepted', patches: 2, applied: 2 });
  });

  it('keeps adapter-only and composed runtime version types distinct', () => {
    const extraRuntime = withAutomergeRuntimeRelations({
      source: {
        relationNames: ['labels'],
        version: () => 1,
        rows: () => []
      }
    } satisfies RelationRuntime<number>, schema.labels);
    const adapterOnlyOptions = {
      doc: workspaceDoc(),
      relations: taskMapping
    } satisfies AutomergeMapRuntimeOptions<WorkspaceDoc>;
    const composedOptions = {
      doc: workspaceDoc(),
      relations: taskMapping,
      runtimes: [extraRuntime]
    } satisfies AutomergeMapRuntimeOptions<WorkspaceDoc, number>;
    const createAdapterOnly = () => createAutomergeMapRuntime(adapterOnlyOptions);
    const createComposed = () => createAutomergeMapRuntime(composedOptions);

    expectTypeOf(createAdapterOnly).returns.toMatchTypeOf<AutomergeMapRuntime<WorkspaceDoc>>();
    expectTypeOf(createComposed).returns.toMatchTypeOf<AutomergeMapRuntime<WorkspaceDoc, number>>();
    expectTypeOf<NonNullable<AutomergeMapRuntime<WorkspaceDoc>['source']['version']>>()
      .returns.toMatchTypeOf<Automerge.Heads | undefined>();
    expectTypeOf<NonNullable<AutomergeMapRuntime<WorkspaceDoc, number>['source']['version']>>()
      .returns.toMatchTypeOf<readonly [Automerge.Heads, ...number[]] | undefined>();
  });
});

class MemoryStorageAdapter implements StorageAdapterInterface {
  readonly #values = new Map<string, Uint8Array>();

  async load(key: StorageKey): Promise<Uint8Array | undefined> {
    return this.#values.get(this.#key(key));
  }

  async save(key: StorageKey, data: Uint8Array): Promise<void> {
    this.#values.set(this.#key(key), data);
  }

  async remove(key: StorageKey): Promise<void> {
    this.#values.delete(this.#key(key));
  }

  async loadRange(keyPrefix: StorageKey): Promise<Chunk[]> {
    const prefix = this.#key(keyPrefix);
    const chunks: Chunk[] = [];

    for (const [key, data] of this.#values) {
      const segments = key.split('\u0000');
      if (segments.slice(0, keyPrefix.length).join('\u0000') === prefix) chunks.push({ key: segments, data });
    }

    return chunks;
  }

  async removeRange(keyPrefix: StorageKey): Promise<void> {
    const prefix = this.#key(keyPrefix);

    for (const key of this.#values.keys()) {
      if (key === prefix || key.startsWith(`${prefix}\u0000`)) this.#values.delete(key);
    }
  }

  #key(key: StorageKey): string {
    return key.join('\u0000');
  }
}

function workspaceDoc(tasks: readonly TaskRow[] = [{ id: 'task-1', title: 'Draft' }]): Automerge.Doc<WorkspaceDoc> {
  const doc: Automerge.Doc<WorkspaceDoc> = Automerge.from({
    workspace: {
      tasks,
      labelsById: {
        'label-1': { id: 'label-1', name: 'Urgent' }
      }
    }
  });

  return doc;
}

function workspaceHandle(tasks: readonly TaskRow[] = [{ id: 'task-1', title: 'Draft' }]): DocHandle<WorkspaceDoc> {
  const repo = new Repo({ peerId: 'peer-workspace' as never });
  return repo.create<WorkspaceDoc>({
    workspace: {
      tasks,
      labelsById: {
        'label-1': { id: 'label-1', name: 'Urgent' }
      }
    }
  });
}

type DiagnosticSummary = {
  readonly code?: string;
  readonly severity?: string;
  readonly relation?: string;
  readonly field?: string;
};

type SeededRandom = {
  readonly int: (maxExclusive: number) => number;
  readonly bool: () => boolean;
  readonly pick: <Value>(values: readonly Value[]) => Value;
};

function summarizeDiagnostics(diagnostics: readonly DiagnosticSummary[]): readonly DiagnosticSummary[] {
  return diagnostics.map((diagnostic) => {
    const summary: {
      code?: string;
      severity?: string;
      relation?: string;
      field?: string;
    } = {};

    if (diagnostic.code !== undefined) summary.code = diagnostic.code;
    if (diagnostic.severity !== undefined) summary.severity = diagnostic.severity;
    if (diagnostic.relation !== undefined) summary.relation = diagnostic.relation;
    if (diagnostic.field !== undefined) summary.field = diagnostic.field;

    return summary;
  });
}

function generatedValidTaskRows(): readonly TaskRow[] {
  const random = seededRandom(0x5eed2026);

  return Array.from({ length: 32 }, (_, index) => {
    const row: Record<string, unknown> = {
      id: `task-fuzz-${index}`,
      title: `Task ${index}`
    };

    if (random.bool()) row.memo = random.pick(['memo', '', null]);
    if (random.bool()) row.effort = random.pick([0, 1, index + 0.5, null]);
    if (random.bool()) row.done = random.bool();
    if (random.bool()) row.projectId = `project-${random.int(4)}`;
    if (random.bool()) row.anchor = `/workspace/tasks/${index}`;
    if (random.bool()) row.meta = randomJson(random, 2);

    return row as TaskRow;
  });
}

function generatedInvalidTaskRows(): readonly unknown[] {
  const random = seededRandom(0xbad2026);
  const rows: unknown[] = [null, undefined, 42, 'task', true, []];

  for (let index = 0; index < 72; index += 1) {
    const row: Record<string, unknown> = {
      id: `task-invalid-${index}`,
      title: `Invalid ${index}`
    };

    switch (random.int(14)) {
      case 0:
        delete row.id;
        break;
      case 1:
        row.id = null;
        break;
      case 2:
        row.id = 12;
        break;
      case 3:
        delete row.title;
        break;
      case 4:
        row.title = undefined;
        break;
      case 5:
        row.title = null;
        break;
      case 6:
        row.title = false;
        break;
      case 7:
        row.memo = 12;
        break;
      case 8:
        row.effort = 'large';
        break;
      case 9:
        row.effort = Number.POSITIVE_INFINITY;
        break;
      case 10:
        row.done = 'yes';
        break;
      case 11:
        row.projectId = 8;
        break;
      case 12:
        row.anchor = { path: '/workspace/tasks/1' };
        break;
      default:
        row.meta = { nested: undefined };
        break;
    }

    rows.push(row);
  }

  return rows;
}

function generatedInvalidTaskUpdates(): readonly Record<string, unknown>[] {
  return [
    { id: null },
    { id: 7 },
    { title: undefined },
    { title: null },
    { title: 7 },
    { memo: { text: 'memo' } },
    { effort: Number.NaN },
    { done: 1 },
    { projectId: false },
    { anchor: ['/workspace/tasks/1'] },
    { meta: { nested: undefined } }
  ];
}

function seededRandom(seed: number): SeededRandom {
  let state = seed >>> 0;
  const next = (): number => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };

  return {
    int: (maxExclusive) => Math.floor(next() * maxExclusive),
    bool: () => next() >= 0.5,
    pick: (values) => values[Math.floor(next() * values.length)] as never
  };
}

function randomJson(random: SeededRandom, depth: number): JsonValue {
  if (depth <= 0) return random.pick([null, true, false, 'json', random.int(100)]);

  switch (random.int(5)) {
    case 0:
      return random.pick([null, true, false, 'json', random.int(100)]);
    case 1:
      return [randomJson(random, depth - 1), randomJson(random, depth - 1)];
    case 2:
      return { note: randomJson(random, depth - 1), count: random.int(10) };
    case 3:
      return [];
    default:
      return {};
  }
}

function predicateWorkspaceDoc(): Automerge.Doc<WorkspaceDoc> {
  const doc: Automerge.Doc<WorkspaceDoc> = Automerge.from({
    workspace: {
      tasks: [
        { id: 'task-1', title: 'Present memo', memo: 'ready' },
        { id: 'task-2', title: 'Null memo', memo: null },
        { id: 'task-3', title: 'Missing memo' }
      ],
      labelsById: {
        'label-1': { id: 'label-1', name: 'Urgent' }
      }
    }
  });

  return doc;
}

function expressionWorkspaceDoc(): Automerge.Doc<WorkspaceDoc> {
  const doc: Automerge.Doc<WorkspaceDoc> = Automerge.from({
    workspace: {
      tasks: [
        { id: 'task-1', title: 'Draft' },
        { id: 'task-2', title: 'Todo' },
        { id: 'task-3', title: 'Merge' }
      ],
      labelsById: {
        'label-1': { id: 'label-1', name: 'Urgent' }
      }
    }
  });

  return doc;
}
