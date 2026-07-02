import * as Automerge from '@automerge/automerge';
import { describe, expect, expectTypeOf, it } from 'vitest';
import { isRelationRuntime, type RelationRuntime } from '@tarstate/core/adapter';
import { defineSchema, idField, relation, stringField } from '@tarstate/core/schema';
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
    readonly labels: readonly LabelRow[];
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

describe('automerge public API contract', () => {
  it('preserves root exports as API stubs', async () => {
    const api = await import('@tarstate/automerge');
    const doc = workspaceDoc();

    expect(api.automergeMapAdapter).toBe(automergeMapAdapter);
    expect(api.automergeMapSource).toBe(automergeMapSource);
    expect(api.createAutomergeMapRuntime).toBe(createAutomergeMapRuntime);
    expect(api.defineAutomergeMapRelations).toBe(defineAutomergeMapRelations);
    expect(api.withAutomergeRuntimeRelations).toBe(withAutomergeRuntimeRelations);
    expect('automergeDb' in api).toBe(false);
    expect('automergeDbRelationRuntime' in api).toBe(false);
    expect(() => automergeMapAdapter({ doc, relations: taskMapping })).toThrow(/not implemented/);
    expect(() => automergeMapSource(doc, { relations: taskMapping })).toThrow(/not implemented/);
    expect(() => createAutomergeMapRuntime({ doc, relations: taskMapping })).toThrow(/not implemented/);
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
      tasks: [],
      labels: []
    }
  });

  return doc;
}
