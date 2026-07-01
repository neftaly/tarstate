import { createElement, type ReactElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { describe, expect, it } from 'vitest';
import { TarstateProvider } from '@tarstate/react';
import {
  AutomergeCollaborationExample,
  BasicTodoQueryExample,
  ConstraintsWatchExample,
  DashboardMaterializationExample,
  ReactExampleSuite,
  createAutomergeExampleModel,
  createConstrainedDemoStore,
  createDemoStore,
  createMaterializedDemoStore,
  openTodoCardsQuery,
  plannedOpenTodosQuery,
  projectSummaryQuery,
  seedData,
  todoSchema,
  type AutomergeExampleModel
} from './demo.js';
import type { TarstateDbStore } from '@tarstate/react';

describe('React-first Tarstate examples', () => {
  it('keeps schema, seed data, and queries as shared plain TypeScript modules', () => {
    expect(Object.keys(todoSchema)).toEqual(['projects', 'people', 'todos']);
    expect(seedData()).toEqual({
      projects: [
        { id: 'project-launch', name: 'Launch board', status: 'active' },
        { id: 'project-ops', name: 'Operations', status: 'active' }
      ],
      people: [
        { id: 'person-ada', name: 'Ada', role: 'engineer', active: true },
        { id: 'person-bea', name: 'Bea', role: 'designer', active: true },
        { id: 'person-cy', name: 'Cy', role: 'ops', active: false }
      ],
      todos: [
        {
          id: 'todo-core',
          projectId: 'project-launch',
          ownerId: 'person-ada',
          title: 'Ship core API',
          status: 'doing',
          points: 5
        },
        {
          id: 'todo-docs',
          projectId: 'project-launch',
          ownerId: 'person-bea',
          title: 'Write customer docs',
          status: 'todo',
          points: 3
        },
        {
          id: 'todo-release',
          projectId: 'project-ops',
          ownerId: 'person-ada',
          title: 'Run release checklist',
          status: 'done',
          points: 2
        },
        {
          id: 'todo-feedback',
          projectId: 'project-ops',
          ownerId: 'person-cy',
          title: 'Triage feedback',
          status: 'todo',
          points: 1
        }
      ]
    });
    expect(openTodoCardsQuery.data.op).toBe('keyBy');
    expect(projectSummaryQuery.data.op).toBe('keyBy');
    expect(plannedOpenTodosQuery.data.op).toBe('keyBy');
  });

  it('renders BasicTodoQueryExample with useDb, useQuery, and a computed useTransact update', async () => {
    const store = createDemoStore();
    const renderer = await renderWithProvider(store, createElement(BasicTodoQueryExample));

    await waitFor(() => {
      expect(status(renderer)).toBe('ready');
      expect(rowIds(renderer)).toEqual(['todo-core', 'todo-docs', 'todo-feedback']);
    });
    expect(metric(renderer, 'Open')).toBe('3');
    expect(metric(renderer, 'Points')).toBe('9');

    await click(renderer, 'compute-docs');
    await waitFor(() => {
      expect(rowText(renderer, 'todo-docs')).toContain('doing / 5');
    });
    expect(store.getSnapshot().db.data.todos).toContainEqual(expect.objectContaining({
      id: 'todo-docs',
      status: 'doing',
      points: 5
    }));
  });

  it('renders DashboardMaterializationExample from a materialized DB store', async () => {
    const store = await createMaterializedDemoStore();
    const renderer = await renderWithProvider(store, createElement(DashboardMaterializationExample));

    await waitFor(() => {
      expect(status(renderer)).toBe('ready');
      expect(metric(renderer, 'Materialized')).toBe('yes');
    });
    expect(metric(renderer, 'Metadata')).toBe('open-todos');
    expect(metric(renderer, 'Planning')).toBe('snapshot');
    expect(metric(renderer, 'Project rows')).toBe('2');
    expect(metric(renderer, 'Unique lookup')).toBe('Ship core API');
    expect(rowIds(renderer)).toEqual(['todo-core', 'todo-docs', 'todo-feedback']);
  });

  it('renders ConstraintsWatchExample with rejected diagnostics and watch events', async () => {
    const store = createConstrainedDemoStore();
    const renderer = await renderWithProvider(store, createElement(ConstraintsWatchExample));

    await waitFor(() => {
      expect(status(renderer)).toBe('ready');
      expect(Number(metric(renderer, 'Watch events'))).toBeGreaterThanOrEqual(1);
    });

    await click(renderer, 'insert-invalid');
    await waitFor(() => {
      expect(metric(renderer, 'Last committed')).toBe('no');
      expect(metric(renderer, 'Diagnostics')).toBe('constraint_unique');
    });
    expect(rowIds(renderer)).toEqual(['todo-core', 'todo-docs', 'todo-feedback']);
    expect(store.getSnapshot().db.data.people).not.toContainEqual(expect.objectContaining({ id: 'person-duplicate' }));
  });

  it('renders AutomergeCollaborationExample through the same provider/query hooks', async () => {
    const model = await createAutomergeExampleModel();
    const renderer = await renderAutomerge(model);

    await waitFor(() => {
      expect(status(renderer)).toBe('ready');
      expect(rowIds(renderer)).toEqual(['todo-core']);
    });

    await click(renderer, 'automerge-commit');
    await waitFor(() => {
      expect(metric(renderer, 'Heads changed')).toBe('yes');
      expect(rowIds(renderer)).toEqual(['todo-docs']);
    });
    expect(model.relic.getDoc().workspace.todos).toEqual({
      'todo-core': {
        projectId: 'project-launch',
        ownerId: 'person-ada',
        title: 'Ship core API',
        status: 'done',
        points: 5
      },
      'todo-docs': {
        projectId: 'project-launch',
        ownerId: 'person-bea',
        title: 'Write customer docs',
        status: 'todo',
        points: 3
      }
    });
  });

  it('exports a ReactExampleSuite composed from provider-scoped examples', async () => {
    const model = await createAutomergeExampleModel();
    let renderer: ReactTestRenderer | undefined;

    await act(async () => {
      renderer = create(createElement(ReactExampleSuite, { automerge: model }));
    });

    expect(renderer?.root.findAllByProps({ 'data-example': 'BasicTodoQueryExample' })).toHaveLength(1);
    expect(renderer?.root.findAllByProps({ 'data-example': 'DashboardMaterializationExample' })).toHaveLength(1);
    expect(renderer?.root.findAllByProps({ 'data-example': 'ConstraintsWatchExample' })).toHaveLength(1);
    expect(renderer?.root.findAllByProps({ 'data-example': 'AutomergeCollaborationExample' })).toHaveLength(1);
  });
});

async function renderWithProvider(
  store: TarstateDbStore,
  child: ReactElement
): Promise<ReactTestRenderer> {
  let renderer: ReactTestRenderer | undefined;
  await act(async () => {
    renderer = create(createElement(TarstateProvider, { store }, child));
  });
  if (renderer === undefined) {
    throw new Error('renderer was not created');
  }
  return renderer;
}

function renderAutomerge(model: AutomergeExampleModel): Promise<ReactTestRenderer> {
  return renderWithProvider(
    model.store,
    createElement(AutomergeCollaborationExample, { model })
  );
}

async function click(renderer: ReactTestRenderer, action: string): Promise<void> {
  const button = renderer.root.findByProps({ 'data-action': action });
  await act(async () => {
    await button.props.onClick();
  });
}

function status(renderer: ReactTestRenderer): string {
  return String(renderer.root.findAllByProps({ className: 'status' }).at(0)?.props['data-status']);
}

function metric(renderer: ReactTestRenderer, label: string): string {
  const node = renderer.root.findByProps({ 'data-metric': label });
  return textContent(node.findByType('strong').children);
}

function rowIds(renderer: ReactTestRenderer): readonly string[] {
  return renderer.root
    .findAll((node) => typeof node.props['data-row-id'] === 'string')
    .map((node) => String(node.props['data-row-id']));
}

function rowText(renderer: ReactTestRenderer, id: string): string {
  return textContent(renderer.root.findByProps({ 'data-row-id': id }).children);
}

function textContent(children: readonly unknown[]): string {
  return children
    .filter((child): child is string | number => typeof child === 'string' || typeof child === 'number')
    .map((child) => `${child}`)
    .join('');
}

async function waitFor(assertion: () => void): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    }
  }
  throw lastError;
}
