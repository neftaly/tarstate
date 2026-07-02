import * as Automerge from '@automerge/automerge';
import { describe, expect, expectTypeOf, it } from 'vitest';
import { isRelationRuntime } from '@tarstate/core/adapter';
import { defineSchema, idField, relation, stringField } from '@tarstate/core/schema';
import { createRuntimeStore } from '@tarstate/core/store';
import { write } from '@tarstate/core/write';
import {
  automergeMapAdapter,
  automergeMapSource,
  createAutomergeMapRuntime,
  withAutomergeRuntimeRelations,
  type AutomergeMapAdapter,
  type AutomergeMapRuntime,
  type AutomergeMapSource
} from '@tarstate/automerge';

type TaskRow = {
  readonly id: string;
  readonly title: string;
};

const schema = defineSchema({
  tasks: relation<TaskRow>({
    key: 'id',
    fields: {
      id: idField('task'),
      title: stringField()
    }
  })
});

const taskMapping = [{ relation: schema.tasks, path: ['workspace', 'tasks'] }] as const;
const tasks = write(schema.tasks);

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
