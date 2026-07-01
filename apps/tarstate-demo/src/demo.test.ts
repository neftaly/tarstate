import { createElement, type ReactElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { describe, expect, it } from 'vitest';
import {
  TutorialApp,
  TutorialWalkthrough,
  buildInvalidDataExample,
  constraintTaskRowsQuery,
  createAutomergeTutorialBacking,
  createTutorialModel,
  createTutorialStore,
  openTaskCardsQuery,
  projectSummaryQuery,
  readableDiagnostics,
  runAutomergeQuery,
  runBoostGuideTransaction,
  runInvalidTutorialTransaction,
  seedTutorialData,
  tutorialIndexViewsForDb,
  tutorialSchema,
  type TutorialModel
} from './demo.js';
import { TarstateProvider, type TarstateDbStore } from '@tarstate/react';

describe('Tarstate React walkthrough', () => {
  it('builds the tiny normalized schema and seed rows as plain TypeScript data', () => {
    expect(Object.keys(tutorialSchema)).toEqual(['projects', 'people', 'tasks']);
    expect(seedTutorialData()).toMatchObject({
      projects: [
        { id: 'project-launch', name: 'Launch' },
        { id: 'project-docs', name: 'Docs' }
      ],
      people: [
        { id: 'person-ada', name: 'Ada', active: true },
        { id: 'person-bea', name: 'Bea', active: true },
        { id: 'person-cy', name: 'Cy', active: false }
      ],
      tasks: [
        { id: 'task-api', title: 'Ship query API', status: 'doing', points: 5 },
        { id: 'task-guide', title: 'Write React guide', status: 'todo', points: 3 },
        { id: 'task-release', title: 'Run release checklist', status: 'done', points: 2 },
        { id: 'task-triage', title: 'Triage feedback', status: 'todo', points: 1 }
      ]
    });
  });

  it('keeps query values inspectable and reusable', async () => {
    const store = await createTutorialStore();

    expect(openTaskCardsQuery.data.op).toBe('keyBy');
    expect(projectSummaryQuery.data.op).toBe('keyBy');
    expect(constraintTaskRowsQuery.data.op).toBe('keyBy');
    await expect(store.rows(openTaskCardsQuery)).resolves.toMatchObject([
      { id: 'task-api', project: 'Launch', owner: 'Ada', points: 5 },
      { id: 'task-guide', project: 'Docs', owner: 'Bea', points: 3 },
      { id: 'task-triage', project: 'Docs', owner: 'Cy', points: 1 }
    ]);
  });

  it('shows invalid data diagnostics while returning valid query rows', async () => {
    const example = await buildInvalidDataExample();

    expect(example.invalidRow).toMatchObject({
      id: 'task-broken',
      points: 'many'
    });
    expect(example.rows.map((row) => row.id)).toEqual(['task-api', 'task-guide', 'task-triage']);
    expect(example.diagnostics).toContainEqual(expect.objectContaining({
      code: 'invalid_row',
      label: 'Invalid row',
      relation: 'tasks',
      field: 'points'
    }));
  });

  it('runs functional transactions as immutable DB changes', async () => {
    const store = await createTutorialStore();
    const beforeDb = store.getSnapshot().db;
    const beforeRevision = store.getSnapshot().revision;
    const result = await runBoostGuideTransaction(store);

    expect(result.committed).toBe(true);
    expect(result.previousDb).toBe(beforeDb);
    expect(result.db).not.toBe(beforeDb);
    expect(result.revision).toBe(beforeRevision + 1);
    await expect(store.rows(openTaskCardsQuery)).resolves.toContainEqual(expect.objectContaining({
      id: 'task-guide',
      status: 'doing',
      points: 5
    }));
  });

  it('materializes aggregate output and exposes concrete raw index shapes', async () => {
    const store = await createTutorialStore();
    const summary = await store.readMaterialized(projectSummaryQuery);
    const views = tutorialIndexViewsForDb(store.getSnapshot().db);

    expect(summary.materialized).toBe(true);
    expect(summary.rows).toEqual([
      { projectId: 'project-launch', openTasks: 1, points: 5, averagePoints: 5 },
      { projectId: 'project-docs', openTasks: 2, points: 4, averagePoints: 2 }
    ]);
    expect(views).toMatchObject({
      setRawKind: 'Set',
      setTitles: ['Ship query API', 'Write React guide', 'Triage feedback'],
      statusRawKind: 'Map',
      todoTitles: ['Write React guide', 'Triage feedback'],
      projectRawKind: 'Map',
      launchTitles: ['Ship query API'],
      pointsRawKind: 'Map',
      pointsOrdered: [1, 3, 5],
      pointsRangeTitles: ['Write React guide', 'Ship query API'],
      uniqueRawKind: 'Map',
      uniqueDocsOwner: 'Bea'
    });
  });

  it('returns readable constraint diagnostics for a rejected write', async () => {
    const store = await createTutorialStore();
    const result = await runInvalidTutorialTransaction(store);
    const readable = readableDiagnostics(result.diagnostics);

    expect(result.committed).toBe(false);
    expect(readable.map((diagnostic) => diagnostic.code)).toEqual(expect.arrayContaining([
      'constraint_req',
      'constraint_unique',
      'constraint_fk',
      'constraint_check'
    ]));
    expect(readable).toContainEqual(expect.objectContaining({
      code: 'constraint_req',
      label: 'Missing required field',
      field: 'title'
    }));
    await expect(store.rows(openTaskCardsQuery)).resolves.toHaveLength(3);
  });

  it('runs the same query shape over an Automerge-backed snapshot', async () => {
    const backing = createAutomergeTutorialBacking();

    await expect(runAutomergeQuery(backing)).resolves.toEqual([
      expect.objectContaining({ id: 'task-api', title: 'Ship query API' }),
      expect.objectContaining({ id: 'task-guide', title: 'Write React guide' })
    ]);
  });

  it('renders ordered beginner-first tutorial sections', async () => {
    const model = await createTutorialModel();
    const renderer = await renderApp(model);

    await waitFor(() => {
      expect(sectionTitles(renderer)).toEqual([
        'Why normalized relational state',
        'Tiny schema and seed rows',
        'Invalid rows become diagnostics',
        'Query as data',
        'Transactions are immutable changes',
        'Derived and materialized views',
        'Indexes over materialized rows',
        'Constraints reject bad writes',
        'Watch and track changes',
        'Pluggable backing'
      ]);
      expect(metric(renderer, 'Open output')).toBe('3 rows / 9 points');
      expect(metric(renderer, 'Diagnostics')).toBe('invalid_row/tasks/points');
      expect(rowIds(renderer)).toEqual(['task-api', 'task-guide', 'task-triage']);
      expect(metric(renderer, 'Set raw')).toContain('Set(');
    });
  });

  it('renders live transaction, constraints, watch, and Automerge outputs', async () => {
    const model = await createTutorialModel();
    const renderer = await renderApp(model);

    await waitFor(() => {
      expect(metric(renderer, 'task-guide row')).toBe('todo / 3 points');
    });

    await click(renderer, 'boost-guide');
    await waitFor(() => {
      expect(metric(renderer, 'task-guide row')).toBe('doing / 5 points');
      expect(metric(renderer, 'Last transaction')).toContain('3 -> 5');
    });

    await click(renderer, 'invalid-write');
    await waitFor(() => {
      expect(diagnosticCodes(renderer)).toEqual(expect.arrayContaining([
        'constraint_req',
        'constraint_unique',
        'constraint_fk',
        'constraint_check'
      ]));
    });

    await click(renderer, 'complete-guide');
    await waitFor(() => {
      expect(metric(renderer, 'Last deleted')).toBe('Write React guide');
    });

    await click(renderer, 'run-automerge');
    await waitFor(() => {
      expect(metric(renderer, 'Rows from Automerge')).toBe('Ship query API, Write React guide');
    });
  });

  it('exports one provider-scoped TutorialApp for the browser entry', async () => {
    const model = await createTutorialModel();
    let renderer: ReactTestRenderer | undefined;

    await act(async () => {
      renderer = create(createElement(TutorialApp, { model }));
    });

    expect(renderer?.root.findAllByProps({ 'data-tutorial': 'TarstateWalkthrough' })).toHaveLength(1);
  });
});

async function renderApp(model: TutorialModel): Promise<ReactTestRenderer> {
  return renderWithProvider(model.store, createElement(TutorialWalkthrough, { automerge: model.automerge }));
}

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

async function click(renderer: ReactTestRenderer, action: string): Promise<void> {
  const button = renderer.root.findByProps({ 'data-action': action });
  await act(async () => {
    await button.props.onClick();
  });
}

function sectionTitles(renderer: ReactTestRenderer): readonly string[] {
  return renderer.root
    .findAll((node) => typeof node.props['data-section'] === 'string')
    .map((node) => String(node.props['data-section']));
}

function metric(renderer: ReactTestRenderer, label: string): string {
  const node = renderer.root.findByProps({ 'data-metric': label });
  return textContentDeep(node.findByType('strong'));
}

function rowIds(renderer: ReactTestRenderer): readonly string[] {
  return renderer.root
    .findAll((node) => typeof node.props['data-row-id'] === 'string')
    .map((node) => String(node.props['data-row-id']));
}

function diagnosticCodes(renderer: ReactTestRenderer): readonly string[] {
  return renderer.root
    .findAll((node) => typeof node.props['data-diagnostic-code'] === 'string')
    .map((node) => String(node.props['data-diagnostic-code']));
}

function textContentDeep(node: { readonly children: readonly unknown[] }): string {
  return node.children.map((child) => {
    if (typeof child === 'string' || typeof child === 'number') return String(child);
    if (isRendererNode(child)) return textContentDeep(child);
    return '';
  }).join('');
}

function isRendererNode(input: unknown): input is { readonly children: readonly unknown[] } {
  return typeof input === 'object' && input !== null && Array.isArray((input as { readonly children?: unknown }).children);
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
