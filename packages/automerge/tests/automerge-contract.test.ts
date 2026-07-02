import * as Automerge from '@automerge/automerge';
import { describe, expect, expectTypeOf, it } from 'vitest';
import { isRelationRuntime } from '@tarstate/core/adapter';
import { defineSchema, idField, relation, stringField } from '@tarstate/core/schema';
import { write } from '@tarstate/core/write';
import {
  automergeDb,
  automergeDbRelationRuntime,
  automergeMapAdapter,
  automergeMapSource,
  type AutomergeDb,
  type AutomergeDbVersion,
  type AutomergeMapAdapter,
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
  it('preserves root exports and typed facade shapes', async () => {
    const api = await import('@tarstate/automerge');
    const doc = Automerge.from<Record<string, unknown>>({});
    const adapter = automergeMapAdapter({ doc, relations: taskMapping });
    const source = automergeMapSource(doc, { relations: taskMapping });
    const db = automergeDb(doc, { relations: taskMapping });

    expect(api.automergeDb).toBe(automergeDb);
    expect(api.automergeDbRelationRuntime).toBe(automergeDbRelationRuntime);
    expect(api.automergeMapAdapter).toBe(automergeMapAdapter);
    expect(api.automergeMapSource).toBe(automergeMapSource);
    expect(isRelationRuntime(adapter)).toBe(true);
    expect(db.kind).toBe('automergeDb');
    expectTypeOf(adapter).toMatchTypeOf<AutomergeMapAdapter>();
    expectTypeOf(source).toMatchTypeOf<AutomergeMapSource>();
    expectTypeOf(automergeDb<Record<string, unknown>>).returns.toMatchTypeOf<AutomergeDb<Record<string, unknown>>>();
    expectTypeOf<Awaited<ReturnType<typeof db.getSnapshot>>['version']>().toMatchTypeOf<AutomergeDbVersion | undefined>();
  });

  it('keeps Automerge pluggable through relation runtime metadata', () => {
    const runtime = automergeDbRelationRuntime({
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

  it('exposes a compiling DB facade over an empty core snapshot', async () => {
    const relic = automergeDb(Automerge.from<Record<string, unknown>>({}), {
      relations: taskMapping,
      env: { tenant: 'acme' }
    });
    const snapshot = await relic.getSnapshot();
    const result = await relic.tryTransact(tasks.insert({ id: 'task-a', title: 'rewrite target' }));

    expect(snapshot.db.env).toEqual({ tenant: 'acme' });
    expect(snapshot.db.data).toEqual({});
    expect(snapshot.diagnostics).toEqual([expect.objectContaining({ code: 'not_implemented' })]);
    expect(result).toMatchObject({
      kind: 'automergeDbTransaction',
      committed: false,
      patches: 1,
      applied: 0,
      diagnostics: [expect.objectContaining({ code: 'not_implemented' })]
    });
    await expect(relic.q(schema.tasks)).resolves.toMatchObject({
      rows: [],
      diagnostics: []
    });
  });
});
