import * as Automerge from '@automerge/automerge';
import { Repo, type DocHandle } from '@automerge/automerge-repo';
import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  call,
  correlate,
  env,
  eq,
  field,
  from,
  gte,
  hostFn,
  isMissing,
  isNull,
  notMissing,
  notNull,
  pipe,
  project,
  sel,
  sel1,
  tuple,
  value,
  where
} from '@tarstate/core';
import { isRelationRuntime, type RelationRuntime } from '@tarstate/core/adapter';
import { evaluate, validateRelationRow } from '@tarstate/core/evaluate';
import {
  anchoredPathField,
  booleanField,
  defineSchema,
  idField,
  jsonField,
  nullable,
  numberField,
  optional,
  refField,
  relation,
  stringField,
  type JsonValue
} from '@tarstate/core/schema';
import { write } from '@tarstate/core/write';
import {
  automergeChangeAt,
  automergeConflictDiagnostics,
  automergeConflictsAt,
  automergeBytesField,
  automergeCounterField,
  automergeDateField,
  automergeMapAdapter,
  automergeMapSource,
  automergeDocHandleAdapter,
  automergeFork,
  automergeMerge,
  automergeObjectId,
  automergeObjectIdAt,
  automergeTextField,
  automergeView,
  createAutomergeDocHandleRuntime,
  createAutomergeMapRuntime,
  defineAutomergeMapRelations,
  withAutomergeRuntimeRelations,
  type AutomergeConflict,
  type AutomergeDocHandleAdapter,
  type AutomergeDocHandleRuntime,
  type AutomergeMapAdapter,
  type AutomergeMapAdapterOptions,
  type AutomergeMapPath,
  type AutomergeMapRelation,
  type AutomergeMapRuntime,
  type AutomergeMapRuntimeOptions,
  type AutomergeMapSource,
  type AutomergeRelationRuntimeMetadata
} from '@tarstate/automerge';

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
    readonly body: Automerge.ImmutableString;
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
  })
});

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

describe('automerge map adapter', () => {
  it('preserves public exports and creates real source/adapter instances', async () => {
    const api = await import('@tarstate/automerge');
    const doc = workspaceDoc();
    const adapter = automergeMapAdapter({ doc, relations: taskMapping });
    const source = automergeMapSource(doc, { relations: taskMapping });

    expect(api.automergeMapAdapter).toBe(automergeMapAdapter);
    expect(api.automergeMapSource).toBe(automergeMapSource);
    expect(api.automergeDocHandleAdapter).toBe(automergeDocHandleAdapter);
    expect(api.automergeView).toBe(automergeView);
    expect(api.automergeFork).toBe(automergeFork);
    expect(api.automergeChangeAt).toBe(automergeChangeAt);
    expect(api.automergeMerge).toBe(automergeMerge);
    expect(api.automergeObjectId).toBe(automergeObjectId);
    expect(api.automergeObjectIdAt).toBe(automergeObjectIdAt);
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
    expect(adapter.snapshot().version).toEqual(Automerge.getHeads(doc));
    expectTypeOf(automergeMapAdapter<WorkspaceDoc>).returns.toMatchTypeOf<AutomergeMapAdapter<WorkspaceDoc>>();
    expectTypeOf(automergeDocHandleAdapter<WorkspaceDoc>).returns.toMatchTypeOf<AutomergeDocHandleAdapter<WorkspaceDoc>>();
    expectTypeOf(createAutomergeDocHandleRuntime<WorkspaceDoc>).returns
      .toMatchTypeOf<AutomergeDocHandleRuntime<WorkspaceDoc>>();
    expectTypeOf(automergeMapSource<WorkspaceDoc>).returns.toMatchTypeOf<AutomergeMapSource>();
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

    expect(source.relationNames).toEqual(['tasks', 'labels']);
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

  it('preserves mapped row object IDs for ordinary array and map updates', async () => {
    const adapter = automergeMapAdapter({ doc: workspaceDoc(), relations: allMappings });
    const taskObjectId = adapter.objectIdFor(schema.tasks, 'task-1');
    const labelObjectId = adapter.objectIdFor(schema.labels, 'label-1');

    const taskCollectionObjectId = automergeObjectIdAt(adapter.getDoc(), ['workspace', 'tasks']);
    expect(taskObjectId).toBeTruthy();
    expect(labelObjectId).toBeTruthy();
    expect(taskCollectionObjectId).toBe(automergeObjectId(adapter.getDoc().workspace.tasks));

    const result = await adapter.target.apply([
      write(schema.tasks).updateByKey('task-1', { title: 'Edited' }),
      write(schema.labels).updateByKey('label-1', { name: 'Important' })
    ]);

    expect(result).toMatchObject({ status: 'accepted', applied: 2 });
    expect(adapter.source.rows(schema.tasks)).toEqual([{ id: 'task-1', title: 'Edited' }]);
    expect(adapter.source.rows(schema.labels)).toEqual([{ id: 'label-1', name: 'Important' }]);
    expect(adapter.objectIdFor(schema.tasks, 'task-1')).toBe(taskObjectId);
    expect(adapter.objectIdFor(schema.labels, 'label-1')).toBe(labelObjectId);
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
    expect(runtime.relations.map((item) => item.name)).toEqual(['tasks', 'labels']);
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
