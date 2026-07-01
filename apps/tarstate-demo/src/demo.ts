import * as Automerge from '@automerge/automerge';
import { createElement, useMemo, useState, type ReactElement } from 'react';
import { automergeDb, type AutomergeDb } from '@tarstate/automerge';
import {
  aggregate,
  as,
  avg,
  btree,
  constrain,
  count,
  db,
  env,
  eq,
  explainMaterialization,
  fk,
  from,
  gte,
  hash,
  index,
  insert,
  join,
  keyBy,
  leftJoin,
  mat,
  materializationForQuery,
  maybe,
  neq,
  numberField,
  pipe,
  project as select,
  req,
  stringField,
  sum,
  updateByKey,
  unique,
  value,
  where,
  type Db,
  type Query,
  type TarstateDiagnostic
} from '@tarstate/core';
import {
  booleanField,
  defineSchema,
  idField,
  refField,
  relation
} from '@tarstate/core/schema';
import {
  createDbStore,
  TarstateProvider,
  useDb,
  useMaterialized,
  useQuery,
  useTransact,
  useWatch,
  type TarstateDbStore
} from '@tarstate/react';

export type ProjectRow = {
  readonly id: string;
  readonly name: string;
  readonly status: string;
};

export type PersonRow = {
  readonly id: string;
  readonly name: string;
  readonly role: string;
  readonly active: boolean;
};

export type TodoRow = {
  readonly id: string;
  readonly projectId: string;
  readonly ownerId: string;
  readonly title: string;
  readonly status: string;
  readonly points: number;
};

export type TodoCard = {
  readonly id: string;
  readonly projectId: string;
  readonly project: string;
  readonly owner: string | undefined;
  readonly title: string;
  readonly status: string;
  readonly points: number;
};

export type ProjectSummary = {
  readonly projectId: string;
  readonly todos: number;
  readonly points: number;
  readonly averagePoints: number;
};

export type ActivePerson = {
  readonly id: string;
  readonly name: string;
};

export type IndexedViews = {
  readonly setRawKind: string;
  readonly setIds: readonly string[];
  readonly hashRawKind: string;
  readonly hashProjectIds: readonly string[];
  readonly hashEntries: readonly string[];
  readonly btreeRawKind: string;
  readonly btreeOrdered: readonly number[];
  readonly btreeRangeIds: readonly string[];
  readonly uniqueRawKind: string;
  readonly uniqueCoreTitle: string;
  readonly uniqueEntries: readonly string[];
};

export type StoredRow<Row extends { readonly id: string }> = Omit<Row, 'id'> & {
  readonly id?: string;
};

export type CollaborationDocument = {
  readonly workspace: {
    readonly projects: Record<string, StoredRow<ProjectRow>>;
    readonly people: Record<string, StoredRow<PersonRow>>;
    readonly todos: Record<string, StoredRow<TodoRow>>;
  };
};

export type AutomergeExampleModel = {
  readonly relic: AutomergeDb<CollaborationDocument>;
  readonly store: TarstateDbStore;
  readonly beforeHeads: readonly string[];
};

export const todoSchema = defineSchema({
  projects: relation<ProjectRow>({
    key: 'id',
    fields: {
      id: idField('project'),
      name: stringField(),
      status: stringField()
    }
  }),
  people: relation<PersonRow>({
    key: 'id',
    fields: {
      id: idField('person'),
      name: stringField(),
      role: stringField(),
      active: booleanField()
    }
  }),
  todos: relation<TodoRow>({
    key: 'id',
    fields: {
      id: idField('todo'),
      projectId: refField('projects.id'),
      ownerId: refField('people.id'),
      title: stringField(),
      status: stringField(),
      points: numberField()
    }
  })
});

const projectRef = as(todoSchema.projects, 'project');
const personRef = as(todoSchema.people, 'person');
const todoRef = as(todoSchema.todos, 'todo');

export const openTodoCardsQuery = pipe(
  from(todoRef),
  where(neq(todoRef.status, 'done')),
  join(from(projectRef), eq(todoRef.projectId, projectRef.id)),
  leftJoin(from(personRef), eq(todoRef.ownerId, personRef.id)),
  select({
    id: todoRef.id,
    projectId: projectRef.id,
    project: projectRef.name,
    owner: maybe(personRef.name),
    title: todoRef.title,
    status: todoRef.status,
    points: todoRef.points
  }),
  keyBy('id')
) as unknown as Query<TodoCard>;

export const projectSummaryQuery = pipe(
  from(todoRef),
  where(neq(todoRef.status, 'done')),
  where(gte(todoRef.points, env<number>('minimumPoints'))),
  aggregate({
    groupBy: { projectId: todoRef.projectId },
    aggregates: {
      todos: count(),
      points: sum(todoRef.points),
      averagePoints: avg(todoRef.points)
    }
  }),
  keyBy('projectId')
) as unknown as Query<ProjectSummary>;

export const activePeopleQuery = pipe(
  from(personRef),
  where(eq(personRef.active, true)),
  select({
    id: personRef.id,
    name: personRef.name
  }),
  keyBy('id')
) as unknown as Query<ActivePerson>;

export const plannedOpenTodosQuery = pipe(
  from(todoRef),
  hash(todoRef.projectId),
  btree(todoRef.points),
  where(neq(todoRef.status, 'done')),
  where(gte(todoRef.points, value(3))),
  select({ id: todoRef.id, title: todoRef.title }),
  keyBy('id')
) as unknown as Query<{ readonly id: string; readonly title: string }>;

export function seedData(): Db['data'] {
  return {
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
  };
}

export function createDemoStore(input: Db = db(seedData(), { env: { minimumPoints: 1 } })): TarstateDbStore {
  return createDbStore(input);
}

export async function createMaterializedDemoStore(): Promise<TarstateDbStore> {
  const store = createDemoStore();
  await store.materialize(openTodoCardsQuery, { id: 'open-todos' });
  return store;
}

export async function createIndexedDemoStore(): Promise<TarstateDbStore> {
  return createMaterializedDemoStore();
}

export function createConstrainedDemoStore(): TarstateDbStore {
  return createDemoStore(mat(
    db(seedData(), { env: { minimumPoints: 1 } }),
    constrain(
      req(openTodoCardsQuery, 'title'),
      unique(activePeopleQuery, 'name'),
      fk(todoSchema.todos, 'ownerId', todoSchema.people, 'id'),
      fk(todoSchema.todos, 'projectId', todoSchema.projects, 'id', { cascade: 'delete' })
    )
  ));
}

export async function createAutomergeExampleModel(): Promise<AutomergeExampleModel> {
  const relic = automergeDb<CollaborationDocument>(Automerge.from<CollaborationDocument>({
    workspace: {
      projects: {
        'project-launch': { name: 'Launch board', status: 'active' },
        'project-ops': { name: 'Operations', status: 'active' }
      },
      people: {
        'person-ada': { name: 'Ada', role: 'engineer', active: true },
        'person-bea': { name: 'Bea', role: 'designer', active: true }
      },
      todos: {
        'todo-core': {
          projectId: 'project-launch',
          ownerId: 'person-ada',
          title: 'Ship core API',
          status: 'doing',
          points: 5
        }
      }
    }
  }), {
    env: { minimumPoints: 1 },
    relations: [
      { relation: todoSchema.projects, path: ['workspace', 'projects'] },
      { relation: todoSchema.people, path: ['workspace', 'people'] },
      { relation: todoSchema.todos, path: ['workspace', 'todos'] }
    ]
  });
  const snapshot = await relic.getSnapshot();

  return {
    relic,
    store: createDemoStore(snapshot.db),
    beforeHeads: Automerge.getHeads(relic.getDoc())
  };
}

export function indexedViewsForDb(currentDb: Db): IndexedViews {
  const setView = index<TodoCard>(currentDb, openTodoCardsQuery);
  const hashByProject = index<TodoCard, string>(currentDb, openTodoCardsQuery, {
    kind: 'hash',
    field: 'projectId'
  });
  const btreeByPoints = index<TodoCard, number>(currentDb, openTodoCardsQuery, {
    kind: 'btree',
    field: 'points'
  });
  const uniqueById = index<TodoCard, string>(currentDb, 'open-todos', {
    kind: 'unique',
    field: 'id'
  });

  return {
    setRawKind: collectionKind(setView.raw),
    setIds: [...setView.raw].map((row) => row.id),
    hashRawKind: collectionKind(hashByProject.raw),
    hashProjectIds: rowsFromNested(hashByProject.raw.get('project-launch')).map((row) => row.id),
    hashEntries: [...hashByProject.raw].map(([key, rows]) => `${key}:${rowsFromNested(rows).length}`),
    btreeRawKind: collectionKind(btreeByPoints.raw),
    btreeOrdered: btreeByPoints.ordered,
    btreeRangeIds: btreeByPoints.range({ lower: { value: 3 } }).map((row) => row.id),
    uniqueRawKind: collectionKind(uniqueById.raw),
    uniqueCoreTitle: titleFromUnique(uniqueById.raw.get('todo-core')),
    uniqueEntries: [...uniqueById.raw].map(([key, row]) => `${key}:${titleFromUnique(row)}`)
  };
}

export function BasicTodoQueryExample(): ReactElement {
  const currentDb = useDb();
  const query = useQuery(openTodoCardsQuery, {
    select: (rows) => ({
      openCount: rows.length,
      totalPoints: rows.reduce((total, row) => total + row.points, 0)
    })
  });
  const transact = useTransact();

  return examplePanel(
    'BasicTodoQueryExample',
    'Schema, model, useQuery, useTransact, and a computed update from the current DB.',
    statusLine(query.status, query.diagnostics.length),
    metric('Open', query.data?.openCount ?? 0),
    metric('Points', query.data?.totalPoints ?? 0),
    todoList(query.rows),
    button('compute-docs', 'Start docs', async () => {
      const docs = (currentDb.data.todos ?? []).find((row): row is TodoRow =>
        isTodoRow(row) && row.id === 'todo-docs'
      );
      await transact(updateByKey(todoSchema.todos, 'todo-docs', {
        status: 'doing',
        points: (docs?.points ?? 0) + 2
      }));
    })
  );
}

export function DerivedDashboardExample(): ReactElement {
  const currentDb = useDb();
  const materialized = useMaterialized(openTodoCardsQuery);
  const summaries = useQuery(projectSummaryQuery);
  const explanation = useMemo(() => explainMaterialization(openTodoCardsQuery, {
    id: 'open-todos',
    mode: 'incremental'
  }), []);
  const metadata = materializationForQuery(currentDb, openTodoCardsQuery);

  return examplePanel(
    'DerivedDashboardExample',
    'Joined todo cards, aggregate project summaries, and materialization maintenance metadata.',
    statusLine(materialized.status, materialized.diagnostics.length + summaries.diagnostics.length),
    metric('Materialized', materialized.materialized ? 'yes' : 'no'),
    metric('Metadata', metadata?.id ?? 'missing'),
    metric('Maintenance', metadata?.maintenance ?? explanation.maintenance),
    metric('Dependencies', (metadata?.dependencies ?? explanation.dependencies).join(',')),
    metric('Summary rows', summaries.rows.length),
    todoList(materialized.rows),
    summaryList(summaries.rows)
  );
}

export function IndexedViewsExample(): ReactElement {
  const currentDb = useDb();
  const materialized = useMaterialized(openTodoCardsQuery);
  const views = indexedViewsForDb(currentDb);

  return examplePanel(
    'IndexedViewsExample',
    'Materialized query indexes expose raw Relic-like Set/Map values and iterable facades.',
    statusLine(materialized.status, materialized.diagnostics.length),
    metric('Set raw', `${views.setRawKind}:${views.setIds.length}`),
    metric('Hash raw', `${views.hashRawKind}:${views.hashEntries.join('|')}`),
    metric('Hash lookup', views.hashProjectIds.join(',')),
    metric('Btree raw', `${views.btreeRawKind}:${views.btreeOrdered.join(',')}`),
    metric('Btree range', views.btreeRangeIds.join(',')),
    metric('Unique raw', `${views.uniqueRawKind}:${views.uniqueCoreTitle}`),
    metric('Unique iterable', views.uniqueEntries.length)
  );
}

export function ConstraintsWatchExample(): ReactElement {
  const query = useQuery(openTodoCardsQuery);
  const watchState = useWatch(openTodoCardsQuery, undefined, { keyBy: ['id'] });
  const transact = useTransact();
  const [rejectedCodes, setRejectedCodes] = useState<readonly string[]>([]);
  const [rejectedDetail, setRejectedDetail] = useState('none');
  const [committed, setCommitted] = useState<boolean | undefined>();
  const event = watchState.event;

  return examplePanel(
    'ConstraintsWatchExample',
    'Query-bound constraints, rejected diagnostics, and the useWatch change feed.',
    statusLine(query.status, query.diagnostics.length + watchState.diagnostics.length),
    metric('Watch events', watchState.events.length),
    metric('Watch aliases', event === undefined ? 'none' : `+${event.added.length}/-${event.deleted.length}`),
    metric('Last committed', committed === undefined ? 'none' : committed ? 'yes' : 'no'),
    metric('Diagnostics', rejectedCodes.join(',') || 'none'),
    metric('Detail', rejectedDetail),
    todoList(query.rows),
    button('insert-invalid', 'Insert duplicate active person', async () => {
      const result = await transact(insert(todoSchema.people, {
        id: 'person-duplicate',
        name: 'Ada',
        role: 'support',
        active: true
      }));
      setCommitted(result.committed);
      setRejectedCodes(result.diagnostics.map((diagnostic) => diagnostic.code));
      setRejectedDetail(diagnosticSummary(
        result.diagnostics.find((diagnostic) => diagnostic.code === 'constraint_unique') ?? result.diagnostics[0]
      ));
    })
  );
}

export function AutomergeCollaborationExample({ model }: { readonly model: AutomergeExampleModel }): ReactElement {
  const currentDb = useDb();
  const query = useQuery(openTodoCardsQuery);
  const [headsChanged, setHeadsChanged] = useState(false);

  return examplePanel(
    'AutomergeCollaborationExample',
    'An automergeDb-backed snapshot uses the same provider, query, and transaction path.',
    statusLine(query.status, query.diagnostics.length),
    metric('Rows', query.rows.length),
    metric('Heads changed', headsChanged ? 'yes' : 'no'),
    metric('DB todos', (currentDb.data.todos ?? []).length),
    todoList(query.rows),
    button('automerge-commit', 'Commit Automerge change', async () => {
      const nextDb = await model.relic.transact([
        updateByKey(todoSchema.todos, 'todo-core', { status: 'done' }),
        insert(todoSchema.todos, {
          id: 'todo-docs',
          projectId: 'project-launch',
          ownerId: 'person-bea',
          title: 'Write customer docs',
          status: 'todo',
          points: 3
        })
      ]);
      await model.store.replaceDb(nextDb);
      setHeadsChanged(JSON.stringify(model.beforeHeads) !== JSON.stringify(Automerge.getHeads(model.relic.getDoc())));
    })
  );
}

export function ReactExampleSuite({ automerge }: { readonly automerge: AutomergeExampleModel }): ReactElement {
  const basicStore = useMemo(() => createDemoStore(), []);
  const dashboardStore = useMemo(() => createDemoStore(mat(
    db(seedData(), { env: { minimumPoints: 1 } }),
    openTodoCardsQuery,
    { id: 'open-todos' }
  )), []);
  const indexedStore = useMemo(() => createDemoStore(mat(
    db(seedData(), { env: { minimumPoints: 1 } }),
    openTodoCardsQuery,
    { id: 'open-todos' }
  )), []);
  const constrainedStore = useMemo(() => createConstrainedDemoStore(), []);

  return createElement(
    'main',
    { className: 'page' },
    createElement('header', { className: 'hero' },
      createElement('p', { className: 'eyebrow' }, 'Tarstate React examples'),
      createElement('h1', null, 'DB-first hooks over Relic state'),
      createElement('p', { className: 'dek' }, 'A small React suite for provider setup, queries, transactions, materialized views, raw indexes, constraints, watch changes, and Automerge-backed DB snapshots.')
    ),
    createElement(TarstateProvider, { store: basicStore }, createElement(BasicTodoQueryExample)),
    createElement(TarstateProvider, { store: dashboardStore }, createElement(DerivedDashboardExample)),
    createElement(TarstateProvider, { store: indexedStore }, createElement(IndexedViewsExample)),
    createElement(TarstateProvider, { store: constrainedStore }, createElement(ConstraintsWatchExample)),
    createElement(TarstateProvider, { store: automerge.store },
      createElement(AutomergeCollaborationExample, { model: automerge })
    )
  );
}

function examplePanel(title: string, subtitle: string, ...children: readonly ReactElement[]): ReactElement {
  return createElement(
    'section',
    { className: 'panel', 'data-example': title },
    createElement('h2', null, title),
    createElement('p', { className: 'section-dek' }, subtitle),
    createElement('div', { className: 'metrics' }, ...children)
  );
}

function statusLine(status: string, diagnostics: number): ReactElement {
  return createElement(
    'p',
    { className: 'status', 'data-status': status, 'data-diagnostics': diagnostics },
    `${status} / diagnostics ${diagnostics}`
  );
}

function metric(label: string, value: string | number): ReactElement {
  return createElement(
    'div',
    { className: 'metric', 'data-metric': label },
    createElement('span', null, label),
    createElement('strong', null, String(value))
  );
}

function todoList(rows: readonly TodoCard[]): ReactElement {
  return createElement(
    'ol',
    { className: 'todo-list', 'data-rows': rows.length },
    ...rows.map((row) =>
      createElement('li', { key: row.id, 'data-row-id': row.id },
        `${row.title} / ${row.project} / ${row.owner ?? 'unassigned'} / ${row.status} / ${row.points}`
      )
    )
  );
}

function summaryList(rows: readonly ProjectSummary[]): ReactElement {
  return createElement(
    'ol',
    { className: 'summary-list', 'data-summary-rows': rows.length },
    ...rows.map((row) =>
      createElement('li', { key: row.projectId, 'data-summary-id': row.projectId },
        `${row.projectId}: ${row.todos} todos, ${row.points} points, avg ${row.averagePoints}`
      )
    )
  );
}

function button(action: string, label: string, onClick: () => void | Promise<void>): ReactElement {
  return createElement('button', { type: 'button', 'data-action': action, onClick }, label);
}

function rowsFromNested(input: unknown): readonly TodoCard[] {
  if (input instanceof Set) {
    return [...input].filter(isTodoCard);
  }
  if (input instanceof Map) {
    return [...input.values()].flatMap(rowsFromNested);
  }
  return [];
}

function titleFromUnique(input: unknown): string {
  if (isTodoCard(input)) return input.title;
  if (input instanceof Map) {
    const first = input.values().next();
    return first.done === true ? 'missing' : titleFromUnique(first.value);
  }
  return 'missing';
}

function collectionKind(input: unknown): string {
  if (input instanceof Set) return 'Set';
  if (input instanceof Map) return 'Map';
  return 'unknown';
}

function diagnosticSummary(diagnostic: TarstateDiagnostic | undefined): string {
  if (diagnostic === undefined) return 'none';
  const detail = isRecord(diagnostic.detail) ? diagnostic.detail : {};
  const error = typeof detail.error === 'string' ? detail.error : diagnostic.code;
  const relation = typeof diagnostic.relation === 'string' && diagnostic.relation.startsWith('query:')
    ? 'query'
    : diagnostic.relation;
  const field = typeof diagnostic.field === 'string' ? diagnostic.field : 'unknown';
  return `${error}/${relation ?? 'unknown'}/${field}`;
}

function isTodoRow(input: unknown): input is TodoRow {
  return isRecord(input) &&
    typeof input.id === 'string' &&
    typeof input.title === 'string';
}

function isTodoCard(input: unknown): input is TodoCard {
  return isRecord(input) &&
    typeof input.id === 'string' &&
    typeof input.title === 'string' &&
    typeof input.projectId === 'string' &&
    typeof input.project === 'string' &&
    typeof input.status === 'string' &&
    typeof input.points === 'number';
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === 'object' && input !== null && !Array.isArray(input);
}
