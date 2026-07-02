import * as Automerge from '@automerge/automerge';
import { describe, expect, expectTypeOf, it } from 'vitest';
import { eq, field } from '@tarstate/core';
import { isRelationRuntime, type RelationRuntime } from '@tarstate/core/adapter';
import { defineSchema, idField, relation, stringField } from '@tarstate/core/schema';
import { write } from '@tarstate/core/write';
import {
  automergeMapAdapter,
  automergeMapSource,
  createAutomergeMapRuntime,
  defineAutomergeMapRelations,
  withAutomergeRuntimeRelations,
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

const schema = defineSchema({
  tasks: relation<TaskRow>({
    key: 'id',
    fields: {
      id: idField('task'),
      title: stringField()
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

const defineWorkspaceRelations = defineAutomergeMapRelations<WorkspaceDoc>();
const taskMapping = defineWorkspaceRelations([
  { relation: schema.tasks, path: ['workspace', 'tasks'] }
]);
const allMappings = defineWorkspaceRelations([
  { relation: schema.tasks, path: ['workspace', 'tasks'] },
  { relation: schema.labels, path: ['workspace', 'labelsById'] }
]);

describe('automerge map adapter', () => {
  it('preserves public exports and creates real source/adapter instances', async () => {
    const api = await import('@tarstate/automerge');
    const doc = workspaceDoc();
    const adapter = automergeMapAdapter({ doc, relations: taskMapping });
    const source = automergeMapSource(doc, { relations: taskMapping });

    expect(api.automergeMapAdapter).toBe(automergeMapAdapter);
    expect(api.automergeMapSource).toBe(automergeMapSource);
    expect(api.createAutomergeMapRuntime).toBe(createAutomergeMapRuntime);
    expect(api.defineAutomergeMapRelations).toBe(defineAutomergeMapRelations);
    expect(api.withAutomergeRuntimeRelations).toBe(withAutomergeRuntimeRelations);
    expect('automergeDb' in api).toBe(false);
    expect('automergeDbRelationRuntime' in api).toBe(false);
    expect(adapter.source.rows(schema.tasks)).toEqual([{ id: 'task-1', title: 'Draft' }]);
    expect(source.rows(schema.tasks)).toEqual([{ id: 'task-1', title: 'Draft' }]);
    expect(adapter.snapshot().version).toEqual(Automerge.getHeads(doc));
    expectTypeOf(automergeMapAdapter<WorkspaceDoc>).returns.toMatchTypeOf<AutomergeMapAdapter<WorkspaceDoc>>();
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

function workspaceDoc(): Automerge.Doc<WorkspaceDoc> {
  const doc: Automerge.Doc<WorkspaceDoc> = Automerge.from({
    workspace: {
      tasks: [{ id: 'task-1', title: 'Draft' }],
      labelsById: {
        'label-1': { id: 'label-1', name: 'Urgent' }
      }
    }
  });

  return doc;
}
