import * as Automerge from '@automerge/automerge';
import { createElement, useMemo, useState, type ReactElement } from 'react';
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
  type Query
} from '@tarstate/core';
import { automergeDb, type AutomergeDb } from '@tarstate/automerge';
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

export function createConstrainedDemoStore(): TarstateDbStore {
  return createDemoStore(mat(
    db(seedData(), { env: { minimumPoints: 1 } }),
    constrain(
      req(todoSchema.todos, 'title'),
      unique(todoSchema.people, 'name'),
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
    'useDb + useQuery + useTransact',
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

export function DashboardMaterializationExample(): ReactElement {
  const currentDb = useDb();
  const materialized = useMaterialized(openTodoCardsQuery);
  const summaries = useQuery(projectSummaryQuery);
  const explanation = useMemo(() => explainMaterialization(openTodoCardsQuery, {
    id: 'open-todos',
    mode: 'incremental'
  }), []);
  const metadata = materializationForQuery(currentDb, openTodoCardsQuery);
  const byProject = index<TodoCard, string>(currentDb, openTodoCardsQuery, {
    kind: 'hash',
    field: 'projectId'
  });
  const uniqueTodo = index<TodoCard, string>(currentDb, 'open-todos', {
    kind: 'unique',
    field: 'id'
  });

  return examplePanel(
    'DashboardMaterializationExample',
    'useMaterialized + useQuery with materialization metadata',
    statusLine(materialized.status, materialized.diagnostics.length),
    metric('Materialized', materialized.materialized ? 'yes' : 'no'),
    metric('Metadata', metadata?.id ?? 'missing'),
    metric('Planning', explanation.maintenance),
    metric('Project rows', byProject.index?.get('project-launch').length ?? 0),
    metric('Unique lookup', uniqueTodo.index?.get('todo-core')?.title ?? 'missing'),
    todoList(materialized.rows),
    summaryList(summaries.rows)
  );
}

export function ConstraintsWatchExample(): ReactElement {
  const query = useQuery(openTodoCardsQuery);
  const watchState = useWatch(openTodoCardsQuery, undefined, { keyBy: ['id'] });
  const transact = useTransact();
  const [rejectedCodes, setRejectedCodes] = useState<readonly string[]>([]);
  const [committed, setCommitted] = useState<boolean | undefined>();

  return examplePanel(
    'ConstraintsWatchExample',
    'useQuery + useWatch + constrained useTransact',
    statusLine(query.status, query.diagnostics.length),
    metric('Watch events', watchState.events.length),
    metric('Last committed', committed === undefined ? 'none' : committed ? 'yes' : 'no'),
    metric('Diagnostics', rejectedCodes.join(',') || 'none'),
    todoList(query.rows),
    button('insert-invalid', 'Insert invalid', async () => {
      const result = await transact(insert(todoSchema.people, {
        id: 'person-duplicate',
        name: 'Ada',
        role: 'support',
        active: true
      }));
      setCommitted(result.committed);
      setRejectedCodes(result.diagnostics.map((diagnostic) => diagnostic.code));
    })
  );
}

export function AutomergeCollaborationExample({ model }: { readonly model: AutomergeExampleModel }): ReactElement {
  const currentDb = useDb();
  const query = useQuery(openTodoCardsQuery);
  const [headsChanged, setHeadsChanged] = useState(false);

  return examplePanel(
    'AutomergeCollaborationExample',
    'automergeDb snapshots through TarstateProvider + useQuery',
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
  const materializedStore = useMemo(() => createDemoStore(mat(
    db(seedData(), { env: { minimumPoints: 1 } }),
    openTodoCardsQuery,
    { id: 'open-todos' }
  )), []);
  const constrainedStore = useMemo(() => createConstrainedDemoStore(), []);
  const basicStore = useMemo(() => createDemoStore(), []);

  return createElement(
    'main',
    { className: 'page' },
    createElement('header', { className: 'hero' },
      createElement('p', { className: 'eyebrow' }, 'Tarstate React examples'),
      createElement('h1', null, 'DB-first hooks over Relic state'),
      createElement('p', { className: 'dek' }, 'A small React suite built around provider setup, queries, transactions, materialization, constraints, watch changes, and Automerge-backed DB snapshots.')
    ),
    createElement(TarstateProvider, { store: basicStore }, createElement(BasicTodoQueryExample)),
    createElement(TarstateProvider, { store: materializedStore }, createElement(DashboardMaterializationExample)),
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
    { className: 'todo-list', 'data-summary-rows': rows.length },
    ...rows.map((row) =>
      createElement('li', { key: row.projectId },
        `${row.projectId}: ${row.todos} todos, ${row.points} points`
      )
    )
  );
}

function button(action: string, label: string, onClick: () => void | Promise<void>): ReactElement {
  return createElement('button', { type: 'button', 'data-action': action, onClick }, label);
}

function isTodoRow(input: unknown): input is TodoRow {
  return typeof input === 'object' &&
    input !== null &&
    !Array.isArray(input) &&
    typeof (input as { readonly id?: unknown }).id === 'string' &&
    typeof (input as { readonly title?: unknown }).title === 'string';
}
