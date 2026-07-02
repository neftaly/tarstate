import * as Automerge from '@automerge/automerge';
import { describe, expect, expectTypeOf, it } from 'vitest';
import { isRelationRuntime, type RelationRuntime } from '@tarstate/core/adapter';
import { defineSchema, idField, relation, stringField } from '@tarstate/core/schema';
import { createRuntimeStore } from '@tarstate/core/store';
import { write, type WritePatch } from '@tarstate/core/write';
import {
  automergeMapAdapter,
  automergeMapSource,
  createAutomergeMapRuntime,
  withAutomergeRuntimeRelations,
  type AutomergeMapAdapter,
  type AutomergeMapPath,
  type AutomergeMapRuntime,
  type AutomergeMapRelation,
  type AutomergeMapSource
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

const taskMapping = [{ relation: schema.tasks, path: ['workspace', 'tasks'] }] as const;
const tasks = write(schema.tasks);
const labels = write(schema.labels);

describe('automerge public adapter contract', () => {
  it('preserves root exports and typed runtime shapes', async () => {
    const api = await import('@tarstate/automerge');
    const doc = Automerge.from<Record<string, unknown>>({});
    const adapter = automergeMapAdapter({ doc, relations: taskMapping });
    const source = automergeMapSource(doc, { relations: taskMapping });
    const runtime = createAutomergeMapRuntime({ doc, relations: taskMapping });

    expect(api.automergeMapAdapter).toBe(automergeMapAdapter);
    expect(api.automergeMapSource).toBe(automergeMapSource);
    expect(api.createAutomergeMapRuntime).toBe(createAutomergeMapRuntime);
    expect(api.withAutomergeRuntimeRelations).toBe(withAutomergeRuntimeRelations);
    expect('automergeDb' in api).toBe(false);
    expect('automergeDbRelationRuntime' in api).toBe(false);
    expect(isRelationRuntime(adapter)).toBe(true);
    expect(isRelationRuntime(runtime)).toBe(true);
    expect(runtime.kind).toBe('automergeMapRuntime');
    expect(runtime.adapter.getDoc()).toBe(doc);
    expectTypeOf(adapter).toMatchTypeOf<AutomergeMapAdapter>();
    expectTypeOf(source).toMatchTypeOf<AutomergeMapSource>();
    expectTypeOf(createAutomergeMapRuntime<Record<string, unknown>>).returns.toMatchTypeOf<AutomergeMapRuntime<Record<string, unknown>>>();
  });

  it('checks Automerge relation path roots against document shape keys', () => {
    const workspacePath = ['workspace', 'tasks'] as const satisfies AutomergeMapPath<WorkspaceDoc>;
    const workspaceMapping = taskMapping satisfies readonly AutomergeMapRelation<typeof schema.tasks, WorkspaceDoc>[];
    const invalidWorkspacePath =
      // @ts-expect-error Automerge map paths start with a document key.
      ['missing', 'tasks'] as const satisfies AutomergeMapPath<WorkspaceDoc>;

    expect(workspacePath[0]).toBe('workspace');
    expect(workspaceMapping[0].path[0]).toBe('workspace');
    void invalidWorkspacePath;
  });

  it('keeps Automerge pluggable through relation runtime metadata', () => {
    const runtime = withAutomergeRuntimeRelations({
      source: {
        relationNames: ['tasks'],
        rows: () => [{ id: 'task-a', title: 'from optional runtime' }]
      }
    }, schema.tasks);

    expect(runtime.relation).toBe(schema.tasks);
    expect(runtime.source.relationNames).toEqual(['tasks']);
    expect(isRelationRuntime(runtime)).toBe(true);
  });

  it('accepts interface document shapes and preserves extra runtime versions', () => {
    const doc: Automerge.Doc<WorkspaceDoc> = Automerge.from({ workspace: { tasks: [] as readonly TaskRow[] } });
    const extraRuntime = withAutomergeRuntimeRelations({
      source: {
        relationNames: ['tasks'],
        version: () => 1,
        rows: () => []
      }
    } satisfies RelationRuntime<number>, schema.tasks);
    const runtime = createAutomergeMapRuntime({ doc, relations: taskMapping, runtimes: [extraRuntime] });

    expect(runtime.adapter.getDoc()).toBe(doc);
    expectTypeOf(runtime).toMatchTypeOf<AutomergeMapRuntime<WorkspaceDoc, number>>();
    expectTypeOf(runtime.source.version).returns.toMatchTypeOf<
      Automerge.Heads | readonly [Automerge.Heads, ...number[]] | undefined
    >();
  });

  it('preserves composed runtime target routing, snapshots, diagnostics, and subscriptions', async () => {
    const doc: Automerge.Doc<WorkspaceDoc> = Automerge.from({ workspace: { tasks: [] as readonly TaskRow[] } });
    const listenerSet = new Set<() => void>();
    const appliedPatchBatches: (readonly WritePatch[])[] = [];
    let unsubscribeCalls = 0;
    const extraRuntime = withAutomergeRuntimeRelations({
      source: {
        relationNames: ['labels'],
        version: () => 7,
        rows: (relationRef) => relationRef.name === 'labels'
          ? [{ id: 'label-a', name: 'from optional runtime' }]
          : [],
        diagnostics: () => [{ code: 'diagnostic', message: 'extra source diagnostic' }]
      },
      target: {
        relationNames: ['labels'],
        apply: (patches) => {
          appliedPatchBatches.push(patches);

          return {
            status: 'accepted',
            patches: patches.length,
            applied: patches.length,
            deltas: [],
            diagnostics: [{ code: 'diagnostic', message: 'extra target diagnostic' }],
            durability: 'memory',
            version: 8
          };
        }
      },
      snapshot: () => ({
        source: {
          relationNames: ['labels'],
          version: () => 9,
          rows: (relationRef) => relationRef.name === 'labels'
            ? [{ id: 'label-b', name: 'from snapshot' }]
            : [],
          diagnostics: () => [{ code: 'diagnostic', message: 'extra snapshot source diagnostic' }]
        },
        version: 9,
        diagnostics: [{ code: 'diagnostic', message: 'extra snapshot diagnostic' }]
      }),
      subscribe: (listener) => {
        listenerSet.add(listener);

        return () => {
          unsubscribeCalls += 1;
          listenerSet.delete(listener);
        };
      }
    } satisfies RelationRuntime<number>, schema.labels);
    const runtime = createAutomergeMapRuntime({ doc, relations: taskMapping, runtimes: [extraRuntime] });
    let notifications = 0;
    const unsubscribe = runtime.subscribe(() => {
      notifications += 1;
    });

    expect(runtime.source.rows(schema.labels)).toEqual([{ id: 'label-a', name: 'from optional runtime' }]);
    expect(runtime.source.version?.()).toEqual([Automerge.getHeads(doc), 7]);
    expect(runtime.source.diagnostics?.()).toEqual([
      expect.objectContaining({ code: 'not_implemented' }),
      { code: 'diagnostic', message: 'extra source diagnostic' }
    ]);
    expect(runtime.target?.relationNames).toEqual(['tasks', 'labels']);
    expect(runtime.target?.ownsRelation?.('tasks')).toBe(true);
    expect(runtime.target?.ownsRelation?.('labels')).toBe(true);

    const result = await runtime.target?.apply([labels.insert({ id: 'label-a', name: 'urgent' })]);
    expect(result).toMatchObject({
      status: 'accepted',
      patches: 1,
      applied: 1,
      durability: 'memory',
      diagnostics: [{ code: 'diagnostic', message: 'extra target diagnostic' }],
      version: [Automerge.getHeads(doc), 7]
    });
    expect(appliedPatchBatches).toHaveLength(1);
    expect(appliedPatchBatches[0]).toEqual([labels.insert({ id: 'label-a', name: 'urgent' })]);

    const snapshot = runtime.snapshot?.();
    expect(snapshot?.source.rows(schema.labels)).toEqual([{ id: 'label-b', name: 'from snapshot' }]);
    expect(snapshot?.version).toEqual([Automerge.getHeads(doc), 9]);
    expect(snapshot?.diagnostics).toEqual([
      expect.objectContaining({ code: 'not_implemented' }),
      { code: 'diagnostic', message: 'extra snapshot diagnostic' },
      expect.objectContaining({ code: 'not_implemented' }),
      { code: 'diagnostic', message: 'extra snapshot source diagnostic' }
    ]);

    runtime.adapter.setDoc(doc);
    for (const listener of listenerSet) listener();
    expect(notifications).toBe(2);

    unsubscribe();
    expect(unsubscribeCalls).toBe(1);
    expect(listenerSet.size).toBe(0);
  });

  it('reports map writes as unimplemented without mutating the document', async () => {
    const doc = Automerge.from<Record<string, unknown>>({});
    const adapter = automergeMapAdapter({ doc, relations: taskMapping });

    const result = await adapter.target.apply([
      tasks.insert({ id: 'task-a', title: 'rewrite target' })
    ]);

    expect(result).toMatchObject({
      status: 'rejected',
      patches: 1,
      applied: 0,
      diagnostics: [expect.objectContaining({ code: 'not_implemented' })]
    });
    expect(adapter.getDoc()).toBe(doc);
    expect(adapter.source.rows(schema.tasks)).toEqual([]);
  });

  it('creates a runtime that plugs into the core store surface', async () => {
    const runtime = createAutomergeMapRuntime({
      doc: Automerge.from<Record<string, unknown>>({}),
      relations: taskMapping
    });
    const store = createRuntimeStore({ runtime, relations: runtime.relations, env: { tenant: 'acme' } });
    const snapshot = store.getSnapshot();
    const result = await store.commit(tasks.insert({ id: 'task-a', title: 'rewrite target' }));

    expect(snapshot.db.data).toEqual({});
    expect(runtime.adapter.source.diagnostics?.()).toEqual([expect.objectContaining({ code: 'not_implemented' })]);
    expect(result).toMatchObject({
      kind: 'tarstateCommit',
      status: 'rejected',
      diagnostics: [expect.objectContaining({ code: 'not_implemented' })]
    });
  });
});
