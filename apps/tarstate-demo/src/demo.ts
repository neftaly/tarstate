import * as Automerge from '@automerge/automerge';
import { createElement, useEffect, useMemo, useState, type ReactElement } from 'react';
import { automergeDb, type AutomergeDb } from '@tarstate/automerge';
import {
  aggregate,
  as,
  avg,
  btree,
  check,
  constrain,
  count,
  db,
  desc,
  eq,
  field,
  fk,
  from,
  gt,
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
  pipe,
  project as select,
  q,
  qRows,
  req,
  sort,
  stringField,
  sum,
  unique,
  updateByKey,
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
  numberField,
  optional,
  relation
} from '@tarstate/core/schema';
import {
  createDbStore,
  TarstateProvider,
  useDb,
  useMaterialized,
  useQuery,
  useTarstateStore,
  useWatch,
  type TarstateDbStore,
  type TarstateTransactResult
} from '@tarstate/react';

export type ProjectRow = {
  readonly id: string;
  readonly name: string;
};

export type PersonRow = {
  readonly id: string;
  readonly name: string;
  readonly active: boolean;
};

export type TaskRow = {
  readonly id: string;
  readonly projectId: string;
  readonly ownerId: string;
  readonly title: string;
  readonly status: string;
  readonly points: number;
};

export type TaskCard = {
  readonly id: string;
  readonly projectId: string;
  readonly project: string;
  readonly ownerId: string;
  readonly owner: string | undefined;
  readonly title: string;
  readonly status: string;
  readonly points: number;
};

export type ProjectSummary = {
  readonly projectId: string;
  readonly openTasks: number;
  readonly points: number;
  readonly averagePoints: number;
};

export type ConstraintTaskRow = {
  readonly id: string;
  readonly projectId: string;
  readonly ownerId: string;
  readonly title: string;
  readonly status: string;
  readonly points: number;
};

export type TutorialIndexViews = {
  readonly setRawKind: string;
  readonly setTitles: readonly string[];
  readonly statusRawKind: string;
  readonly todoTitles: readonly string[];
  readonly statusEntries: readonly string[];
  readonly projectRawKind: string;
  readonly launchTitles: readonly string[];
  readonly pointsRawKind: string;
  readonly pointsOrdered: readonly number[];
  readonly pointsRangeTitles: readonly string[];
  readonly uniqueRawKind: string;
  readonly uniqueDocsOwner: string;
  readonly uniqueEntries: readonly string[];
};

export type ReadableDiagnostic = {
  readonly code: string;
  readonly label: string;
  readonly relation: string;
  readonly field: string;
};

export type InvalidDataExample = {
  readonly invalidRow: Record<string, unknown>;
  readonly rows: readonly TaskCard[];
  readonly diagnostics: readonly ReadableDiagnostic[];
};

export type StoredRow<Row extends { readonly id: string }> = Omit<Row, 'id'> & {
  readonly id?: string;
};

export type TutorialDocument = {
  readonly workspace: {
    readonly projects: Record<string, StoredRow<ProjectRow>>;
    readonly people: Record<string, StoredRow<PersonRow>>;
    readonly tasks: Record<string, StoredRow<TaskRow>>;
  };
};

export type AutomergeTutorialBacking = {
  readonly relic: AutomergeDb<TutorialDocument>;
  readonly beforeHeads: readonly string[];
};

export type TutorialModel = {
  readonly store: TarstateDbStore;
  readonly automerge: AutomergeTutorialBacking;
};

export const tutorialSchema = defineSchema({
  projects: relation<ProjectRow>({
    key: 'id',
    fields: {
      id: idField('project'),
      name: stringField()
    }
  }),
  people: relation<PersonRow>({
    key: 'id',
    fields: {
      id: idField('person'),
      name: stringField(),
      active: booleanField()
    }
  }),
  tasks: relation<TaskRow>({
    key: 'id',
    fields: {
      id: idField('task'),
      projectId: stringField(),
      ownerId: stringField(),
      title: optional(stringField()),
      status: optional(stringField()),
      points: numberField()
    }
  })
});

const projectRef = as(tutorialSchema.projects, 'project');
const personRef = as(tutorialSchema.people, 'person');
const taskRef = as(tutorialSchema.tasks, 'task');

export const openTaskCardsQuery = pipe(
  from(taskRef),
  hash(taskRef.status),
  hash(taskRef.projectId),
  btree(taskRef.points),
  where(neq(taskRef.status, 'done')),
  join(from(projectRef), eq(taskRef.projectId, projectRef.id)),
  leftJoin(from(personRef), eq(taskRef.ownerId, personRef.id)),
  sort(desc(taskRef.points)),
  select({
    id: taskRef.id,
    projectId: taskRef.projectId,
    project: projectRef.name,
    ownerId: taskRef.ownerId,
    owner: maybe(personRef.name),
    title: taskRef.title,
    status: taskRef.status,
    points: taskRef.points
  }),
  keyBy('id')
) as unknown as Query<TaskCard>;

export const projectSummaryQuery = pipe(
  from(taskRef),
  where(neq(taskRef.status, 'done')),
  aggregate({
    groupBy: { projectId: taskRef.projectId },
    aggregates: {
      openTasks: count(),
      points: sum(taskRef.points),
      averagePoints: avg(taskRef.points)
    }
  }),
  keyBy('projectId')
) as unknown as Query<ProjectSummary>;

export const constraintTaskRowsQuery = pipe(
  from(taskRef),
  where(neq(taskRef.status, 'done')),
  select({
    id: taskRef.id,
    projectId: taskRef.projectId,
    ownerId: taskRef.ownerId,
    title: taskRef.title,
    status: taskRef.status,
    points: taskRef.points
  }),
  keyBy('id')
) as unknown as Query<ConstraintTaskRow>;

export function seedTutorialData(): Db['data'] {
  return {
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
      {
        id: 'task-api',
        projectId: 'project-launch',
        ownerId: 'person-ada',
        title: 'Ship query API',
        status: 'doing',
        points: 5
      },
      {
        id: 'task-guide',
        projectId: 'project-docs',
        ownerId: 'person-bea',
        title: 'Write React guide',
        status: 'todo',
        points: 3
      },
      {
        id: 'task-release',
        projectId: 'project-launch',
        ownerId: 'person-ada',
        title: 'Run release checklist',
        status: 'done',
        points: 2
      },
      {
        id: 'task-triage',
        projectId: 'project-docs',
        ownerId: 'person-cy',
        title: 'Triage feedback',
        status: 'todo',
        points: 1
      }
    ]
  };
}

export function createTutorialDb(input: Db['data'] = seedTutorialData()): Db {
  return mat(
    db(input),
    constrain(
      req(constraintTaskRowsQuery, 'title'),
      req(constraintTaskRowsQuery, 'status'),
      unique(constraintTaskRowsQuery, 'title'),
      fk(constraintTaskRowsQuery, 'projectId', tutorialSchema.projects, 'id'),
      fk(constraintTaskRowsQuery, 'ownerId', tutorialSchema.people, 'id'),
      check(constraintTaskRowsQuery, gt(field('task', 'points'), value(0)))
    )
  );
}

export function invalidTutorialData(): Db['data'] {
  return {
    ...seedTutorialData(),
    tasks: [
      ...(seedTutorialData().tasks ?? []),
      {
        id: 'task-broken',
        projectId: 'project-docs',
        ownerId: 'person-bea',
        title: 'Estimate migration',
        status: 'todo',
        points: 'many'
      }
    ]
  };
}

export async function buildInvalidDataExample(): Promise<InvalidDataExample> {
  const invalidRow = (invalidTutorialData().tasks ?? []).at(-1);
  const result = await q(db(invalidTutorialData()), openTaskCardsQuery);
  return {
    invalidRow: isRecord(invalidRow) ? invalidRow : {},
    rows: result.rows,
    diagnostics: readableDiagnostics(result.diagnostics)
  };
}

export async function createTutorialStore(input: Db = createTutorialDb()): Promise<TarstateDbStore> {
  const store = createDbStore(input);
  await store.materialize(openTaskCardsQuery, { id: 'open-task-cards' });
  await store.materialize(projectSummaryQuery, { id: 'project-summary' });
  return store;
}

export async function createTutorialModel(): Promise<TutorialModel> {
  return {
    store: await createTutorialStore(),
    automerge: createAutomergeTutorialBacking()
  };
}

export function createAutomergeTutorialBacking(): AutomergeTutorialBacking {
  const relic = automergeDb<TutorialDocument>(Automerge.from<TutorialDocument>({
    workspace: {
      projects: {
        'project-launch': { name: 'Launch' },
        'project-docs': { name: 'Docs' }
      },
      people: {
        'person-ada': { name: 'Ada', active: true },
        'person-bea': { name: 'Bea', active: true }
      },
      tasks: {
        'task-api': {
          projectId: 'project-launch',
          ownerId: 'person-ada',
          title: 'Ship query API',
          status: 'doing',
          points: 5
        },
        'task-guide': {
          projectId: 'project-docs',
          ownerId: 'person-bea',
          title: 'Write React guide',
          status: 'todo',
          points: 3
        }
      }
    }
  }), {
    relations: [
      { relation: tutorialSchema.projects, path: ['workspace', 'projects'] },
      { relation: tutorialSchema.people, path: ['workspace', 'people'] },
      { relation: tutorialSchema.tasks, path: ['workspace', 'tasks'] }
    ]
  });

  return {
    relic,
    beforeHeads: Automerge.getHeads(relic.getDoc())
  };
}

export async function runBoostGuideTransaction(store: TarstateDbStore): Promise<TarstateTransactResult> {
  const current = taskById(store.getSnapshot().db, 'task-guide');
  return store.transact(updateByKey(tutorialSchema.tasks, 'task-guide', {
    status: 'doing',
    points: (current?.points ?? 0) + 2
  }));
}

export async function runCompleteGuideTransaction(store: TarstateDbStore): Promise<TarstateTransactResult> {
  return store.transact(updateByKey(tutorialSchema.tasks, 'task-guide', {
    status: 'done'
  }));
}

export async function runInvalidTutorialTransaction(store: TarstateDbStore): Promise<TarstateTransactResult> {
  return store.transact(
    insert(tutorialSchema.tasks, {
      id: 'task-invalid',
      projectId: 'project-missing',
      ownerId: 'person-missing',
      status: 'todo',
      points: -1
    } as TaskRow),
    insert(tutorialSchema.tasks, {
      id: 'task-duplicate',
      projectId: 'project-launch',
      ownerId: 'person-ada',
      title: 'Ship query API',
      status: 'todo',
      points: 1
    })
  );
}

export async function runAutomergeQuery(backing: AutomergeTutorialBacking): Promise<readonly TaskCard[]> {
  const snapshot = await backing.relic.getSnapshot();
  return qRows(snapshot.db, openTaskCardsQuery);
}

export function tutorialIndexViewsForDb(currentDb: Db): TutorialIndexViews {
  const setView = index<TaskCard>(currentDb, openTaskCardsQuery);
  const byStatus = index<TaskCard, string>(currentDb, openTaskCardsQuery, {
    kind: 'hash',
    field: 'status'
  });
  const byProject = index<TaskCard, string>(currentDb, openTaskCardsQuery, {
    kind: 'hash',
    field: 'projectId'
  });
  const byPoints = index<TaskCard, number>(currentDb, openTaskCardsQuery, {
    kind: 'btree',
    field: 'points'
  });
  const uniqueByTitle = index<TaskCard, string>(currentDb, openTaskCardsQuery, {
    kind: 'unique',
    field: 'title'
  });

  return {
    setRawKind: collectionKind(setView.raw),
    setTitles: [...setView.raw].map((row) => row.title),
    statusRawKind: collectionKind(byStatus.raw),
    todoTitles: rowsFromNested(byStatus.raw.get('todo')).map((row) => row.title),
    statusEntries: [...byStatus.raw].map(([key, rows]) => `${key}:${rowsFromNested(rows).length}`),
    projectRawKind: collectionKind(byProject.raw),
    launchTitles: rowsFromNested(byProject.raw.get('project-launch')).map((row) => row.title),
    pointsRawKind: collectionKind(byPoints.raw),
    pointsOrdered: byPoints.ordered,
    pointsRangeTitles: byPoints.range({ lower: { value: 3 } }).map((row) => row.title),
    uniqueRawKind: collectionKind(uniqueByTitle.raw),
    uniqueDocsOwner: ownerFromUnique(uniqueByTitle.raw.get('Write React guide')),
    uniqueEntries: [...uniqueByTitle.raw].map(([key, row]) => `${key}:${ownerFromUnique(row)}`)
  };
}

export function readableDiagnostics(diagnostics: readonly TarstateDiagnostic[]): readonly ReadableDiagnostic[] {
  return diagnostics.map((diagnostic) => {
    const detail = isRecord(diagnostic.detail) ? diagnostic.detail : {};
    const error = typeof detail.error === 'string' ? detail.error : diagnostic.code;
    return {
      code: diagnostic.code,
      label: readableError(error),
      relation: typeof diagnostic.relation === 'string' ? diagnostic.relation.replace(/^query:/, '') : 'unknown',
      field: typeof diagnostic.field === 'string' ? diagnostic.field : 'unknown'
    };
  });
}

export function TutorialApp({ model }: { readonly model: TutorialModel }): ReactElement {
  return createElement(
    TarstateProvider,
    { store: model.store },
    createElement(TutorialWalkthrough, { automerge: model.automerge })
  );
}

export function TutorialWalkthrough({
  automerge
}: {
  readonly automerge: AutomergeTutorialBacking;
}): ReactElement {
  const currentDb = useDb();
  const store = useTarstateStore();
  const query = useQuery(openTaskCardsQuery, {
    select: (rows) => ({
      openTasks: rows.length,
      totalPoints: rows.reduce((total, row) => total + row.points, 0)
    })
  });
  const materializedCards = useMaterialized(openTaskCardsQuery);
  const materializedSummary = useMaterialized(projectSummaryQuery);
  const watch = useWatch(openTaskCardsQuery, undefined, { keyBy: ['id'] });
  const indexes = useMemo(() => tutorialIndexViewsForDb(currentDb), [currentDb]);
  const metadata = materializationForQuery(currentDb, openTaskCardsQuery);
  const [transactionText, setTransactionText] = useState('No transaction run yet.');
  const [diagnostics, setDiagnostics] = useState<readonly ReadableDiagnostic[]>([]);
  const [automergeRows, setAutomergeRows] = useState<readonly TaskCard[]>([]);
  const [invalidExample, setInvalidExample] = useState<InvalidDataExample | undefined>();
  const seed = seedTutorialData();

  useEffect(() => {
    let active = true;
    void buildInvalidDataExample().then((example) => {
      if (active) setInvalidExample(example);
    }).catch((error: unknown) => {
      if (active) {
        setInvalidExample({
          invalidRow: {},
          rows: [],
          diagnostics: [{
            code: 'example_error',
            label: error instanceof Error ? error.message : String(error),
            relation: 'tutorial',
            field: 'invalid-data'
          }]
        });
      }
    });
    return () => {
      active = false;
    };
  }, []);

  const boostGuide = async (): Promise<void> => {
    const before = taskById(store.getSnapshot().db, 'task-guide');
    const result = await runBoostGuideTransaction(store);
    const after = taskById(result.db, 'task-guide');
    setTransactionText(
      result.committed
        ? `task-guide points: ${before?.points ?? 'missing'} -> ${after?.points ?? 'missing'}; store revision ${result.revision}`
        : `Rejected: ${result.diagnostics.map((item) => item.code).join(', ')}`
    );
  };

  const completeGuide = async (): Promise<void> => {
    await runCompleteGuideTransaction(store);
  };

  const tryInvalidWrite = async (): Promise<void> => {
    const result = await runInvalidTutorialTransaction(store);
    setDiagnostics(readableDiagnostics(result.diagnostics));
  };

  const queryAutomerge = async (): Promise<void> => {
    setAutomergeRows(await runAutomergeQuery(automerge));
  };

  return createElement(
    'main',
    { className: 'page', 'data-tutorial': 'TarstateWalkthrough' },
    createElement('header', { className: 'hero' },
      createElement('p', { className: 'eyebrow' }, 'Tarstate React walkthrough'),
      createElement('h1', null, 'Relational state for React, one query at a time'),
      createElement('p', { className: 'dek' },
        'Tarstate helps when nested app objects start duplicating data. Put rows in small relations, describe reads as query values, and reuse those values for React hooks, transactions, materialized views, indexes, constraints, watchers, and pluggable backing stores.'
      ),
      createElement('div', { className: 'api-strip', 'aria-label': 'Hook API' },
        ...['createDbStore', 'TarstateProvider', 'useQuery', 'useTransact', 'useMaterialized', 'useWatch'].map((name) =>
          createElement('code', { key: name }, name)
        )
      )
    ),
    tutorialSection(
      '01',
      'Why normalized relational state',
      'Avoid duplicated nested objects',
      'Instead of copying the same person or project into every task, keep each concept once and join rows when the UI needs a view.',
      codeBlock(`// Nested state duplicates owners and projects in every task.
task.owner.name
task.project.name

// Tarstate keeps rows separate.
people[id]
projects[id]
tasks[id].ownerId`),
      outputGrid(
        metric('Nested change', 'Rename Ada in every copied task'),
        metric('Normalized change', 'Rename one people row')
      )
    ),
    tutorialSection(
      '02',
      'Tiny schema and seed rows',
      'Three relations, one stable example',
      'The rest of the walkthrough uses these same projects, people, and tasks so the concepts build instead of resetting context.',
      codeBlock(`const schema = defineSchema({
  projects: relation({ key: 'id', fields: { id, name } }),
  people: relation({ key: 'id', fields: { id, name, active } }),
  tasks: relation({ key: 'id', fields: { id, projectId, ownerId, title, status, points } })
});

const store = createDbStore(db(seedRows));`),
      outputGrid(
        metric('Relations', Object.keys(tutorialSchema).join(', ')),
        metric('Seed rows', `${seed.projects?.length ?? 0} projects / ${seed.people?.length ?? 0} people / ${seed.tasks?.length ?? 0} tasks`)
      ),
      seedTables(seed)
    ),
    tutorialSection(
      '03',
      'Invalid rows become diagnostics',
      'Valid rows still query cleanly',
      'Tarstate validates relation rows while reading. A malformed row is omitted from the query result and reported as a diagnostic the UI can render.',
      codeBlock(`// points should be a number.
{ id: 'task-broken', title: 'Estimate migration', points: 'many' }

const result = await q(db(data), openTaskCards);
result.rows        // valid task cards only
result.diagnostics // invalid_row / tasks / points`),
      outputGrid(
        metric('Invalid row', invalidExample === undefined ? 'loading' : `points=${String(invalidExample.invalidRow.points)}`),
        metric('Rows returned', invalidExample?.rows.length ?? 'loading'),
        metric('Diagnostics', invalidExample?.diagnostics.map((item) => `${item.code}/${item.relation}/${item.field}`).join(', ') ?? 'loading')
      )
    ),
    tutorialSection(
      '04',
      'Query as data',
      'Inspect it, run it, reuse it',
      'A query is a value. React uses the same value that tests, materialization, indexes, constraints, and Automerge can use.',
      codeBlock(`const openTaskCards = pipe(
  from(task),
  where(neq(task.status, 'done')),
  join(from(project), eq(task.projectId, project.id)),
  leftJoin(from(person), eq(task.ownerId, person.id)),
  project({ title: task.title, project: project.name, owner: maybe(person.name), points: task.points }),
  keyBy('id')
);

const { rows } = useQuery(openTaskCards);`),
      outputGrid(
        metric('Query op', openTaskCardsQuery.data.op),
        metric('React status', query.status),
        metric('Open output', `${query.data?.openTasks ?? 0} rows / ${query.data?.totalPoints ?? 0} points`)
      ),
      taskTable(query.rows)
    ),
    tutorialSection(
      '05',
      'Transactions are immutable changes',
      'Compute from the current DB, publish a new DB',
      'useTransact runs writes against the current immutable database. The result includes the previous DB, next DB, diagnostics, and commit status.',
      codeBlock(`const transact = useTransact();
const task = db.data.tasks.find((row) => row.id === 'task-guide');

await transact(updateByKey(schema.tasks, 'task-guide', {
  status: 'doing',
  points: task.points + 2
}));`),
      outputGrid(
        metric('Last transaction', transactionText),
        metric('task-guide row', guideTaskText(currentDb))
      ),
      actionRow(button('boost-guide', 'Run computed update', () => void boostGuide()))
    ),
    tutorialSection(
      '06',
      'Derived and materialized views',
      'The same query can be cached for React reads',
      'Materialization keeps a derived view available on the provider DB. Here the live output is an aggregate dashboard over open tasks.',
      codeBlock(`await store.materialize(openTaskCards, { id: 'open-task-cards' });
await store.materialize(projectSummary, { id: 'project-summary' });

const cards = useMaterialized(openTaskCards);
const summary = useMaterialized(projectSummary);`),
      outputGrid(
        metric('Cards materialized', materializedCards.materialized ? 'yes' : 'no'),
        metric('Metadata id', metadata?.id ?? 'missing'),
        metric('Dependencies', (metadata?.dependencies ?? []).join(', ') || 'none')
      ),
      summaryTable(materializedSummary.rows)
    ),
    tutorialSection(
      '07',
      'Indexes over materialized rows',
      'Concrete Set and Map lookups',
      'Indexes expose simple raw shapes: a Set for all rows and Maps for hash, btree, and unique lookup paths.',
      codeBlock(`const all = index(db, openTaskCards);               // raw Set
const byStatus = index(db, openTaskCards, { kind: 'hash', field: 'status' });   // raw Map
const byPoints = index(db, openTaskCards, { kind: 'btree', field: 'points' });  // raw Map
const byTitle = index(db, openTaskCards, { kind: 'unique', field: 'title' });   // raw Map`),
      indexOutput(indexes)
    ),
    tutorialSection(
      '08',
      'Constraints reject bad writes',
      'Readable diagnostics instead of silent drift',
      'This section attaches query-bound required, unique, foreign-key, and check constraints to the same task rows.',
      codeBlock(`const constrained = mat(db(seedRows), constrain(
  req(openTasks, 'title'),
  unique(openTasks, 'title'),
  fk(openTasks, 'ownerId', schema.people, 'id'),
  check(openTasks, gt(field('task', 'points'), value(0)))
));`),
      actionRow(button('invalid-write', 'Try invalid write', () => void tryInvalidWrite())),
      diagnosticsList(diagnostics)
    ),
    tutorialSection(
      '09',
      'Watch and track changes',
      'The same query reports added and deleted rows',
      'useWatch compares query rows across provider revisions. Marking the guide task done removes it from the open-task query, so the deleted alias becomes concrete.',
      codeBlock(`const watch = useWatch(openTaskCards, undefined, { keyBy: ['id'] });

watch.event?.added
watch.event?.deleted`),
      outputGrid(
        metric('Watch events', watch.events.length),
        metric('Last added', watch.event?.added.map((row) => row.title).join(', ') || 'none'),
        metric('Last deleted', watch.event?.deleted.map((row) => row.title).join(', ') || 'none')
      ),
      actionRow(button('complete-guide', 'Mark guide done', () => void completeGuide()))
    ),
    tutorialSection(
      '10',
      'Pluggable backing',
      'Automerge can feed the same query shape',
      'automergeDb adapts a collaborative document into the same relational snapshot. The query does not change.',
      codeBlock(`const relic = automergeDb(doc, {
  relations: [{ relation: schema.tasks, path: ['workspace', 'tasks'] }]
});

const snapshot = await relic.getSnapshot();
const rows = await qRows(snapshot.db, openTaskCards);`),
      outputGrid(
        metric('Automerge heads', automerge.beforeHeads.length),
        metric('Rows from Automerge', automergeRows.length === 0 ? 'not run' : automergeRows.map((row) => row.title).join(', '))
      ),
      actionRow(button('run-automerge', 'Run query on Automerge snapshot', () => void queryAutomerge()))
    )
  );
}

function tutorialSection(
  step: string,
  title: string,
  subtitle: string,
  description: string,
  ...children: readonly ReactElement[]
): ReactElement {
  return createElement(
    'section',
    { className: 'tutorial-card', 'data-section': title },
    createElement('div', { className: 'section-heading' },
      createElement('span', { className: 'step' }, step),
      createElement('div', null,
        createElement('h2', null, title),
        createElement('p', { className: 'subhead' }, subtitle)
      )
    ),
    createElement('p', { className: 'section-copy' }, description),
    createElement('div', { className: 'section-body' }, ...children)
  );
}

function codeBlock(source: string): ReactElement {
  return createElement('pre', { className: 'snippet' }, createElement('code', null, source));
}

function outputGrid(...children: readonly ReactElement[]): ReactElement {
  return createElement('div', { className: 'output-grid' }, ...children);
}

function actionRow(...children: readonly ReactElement[]): ReactElement {
  return createElement('div', { className: 'actions' }, ...children);
}

function metric(label: string, value: string | number): ReactElement {
  return createElement(
    'div',
    { className: 'metric', 'data-metric': label },
    createElement('span', null, label),
    createElement('strong', null, String(value))
  );
}

function seedTables(seed: Db['data']): ReactElement {
  return createElement(
    'div',
    { className: 'mini-tables' },
    miniTable('projects', ['id', 'name'], seed.projects ?? []),
    miniTable('people', ['id', 'name', 'active'], seed.people ?? []),
    miniTable('tasks', ['id', 'projectId', 'ownerId', 'status', 'points'], seed.tasks ?? [])
  );
}

function miniTable(title: string, columns: readonly string[], rows: readonly unknown[]): ReactElement {
  return createElement(
    'div',
    { className: 'mini-table', 'data-table': title },
    createElement('h3', null, title),
    createElement('table', null,
      createElement('thead', null,
        createElement('tr', null, ...columns.map((column) => createElement('th', { key: column }, column)))
      ),
      createElement('tbody', null,
        ...rows.map((row, indexValue) =>
          createElement('tr', { key: `${title}-${indexValue}` },
            ...columns.map((column) => createElement('td', { key: column }, cellValue(row, column)))
          )
        )
      )
    )
  );
}

function taskTable(rows: readonly TaskCard[]): ReactElement {
  return createElement(
    'table',
    { className: 'result-table', 'data-rows': rows.length },
    createElement('thead', null,
      createElement('tr', null,
        createElement('th', null, 'title'),
        createElement('th', null, 'project'),
        createElement('th', null, 'owner'),
        createElement('th', null, 'status'),
        createElement('th', null, 'points')
      )
    ),
    createElement('tbody', null,
      ...rows.map((row) =>
        createElement('tr', { key: row.id, 'data-row-id': row.id },
          createElement('td', null, row.title),
          createElement('td', null, row.project),
          createElement('td', null, row.owner ?? 'missing'),
          createElement('td', null, row.status),
          createElement('td', null, row.points)
        )
      )
    )
  );
}

function summaryTable(rows: readonly ProjectSummary[]): ReactElement {
  return createElement(
    'table',
    { className: 'result-table', 'data-summary-rows': rows.length },
    createElement('thead', null,
      createElement('tr', null,
        createElement('th', null, 'projectId'),
        createElement('th', null, 'openTasks'),
        createElement('th', null, 'points'),
        createElement('th', null, 'average')
      )
    ),
    createElement('tbody', null,
      ...rows.map((row) =>
        createElement('tr', { key: row.projectId, 'data-summary-id': row.projectId },
          createElement('td', null, row.projectId),
          createElement('td', null, row.openTasks),
          createElement('td', null, row.points),
          createElement('td', null, Math.round(row.averagePoints))
        )
      )
    )
  );
}

function indexOutput(views: TutorialIndexViews): ReactElement {
  return createElement(
    'dl',
    { className: 'index-output' },
    indexLine('Set raw', `${views.setRawKind}(${views.setTitles.join(', ')})`),
    indexLine('Map status=todo', `${views.statusRawKind} -> ${views.todoTitles.join(', ')}`),
    indexLine('Map project=Launch', `${views.projectRawKind} -> ${views.launchTitles.join(', ')}`),
    indexLine('Btree points', `${views.pointsRawKind} keys ${views.pointsOrdered.join(', ')}`),
    indexLine('Btree range >= 3', views.pointsRangeTitles.join(', ')),
    indexLine('Unique title lookup', `${views.uniqueRawKind} -> ${views.uniqueDocsOwner}`),
    indexLine('Unique entries', String(views.uniqueEntries.length))
  );
}

function indexLine(label: string, valueText: string): ReactElement {
  return createElement(
    'div',
    { 'data-metric': label },
    createElement('dt', null, label),
    createElement('dd', null, createElement('strong', null, valueText))
  );
}

function diagnosticsList(diagnostics: readonly ReadableDiagnostic[]): ReactElement {
  return createElement(
    'ul',
    { className: 'diagnostics', 'data-diagnostics': diagnostics.length },
    ...(diagnostics.length === 0
      ? [createElement('li', { key: 'empty' }, 'No rejected write yet.')]
      : diagnostics.map((diagnostic, indexValue) =>
          createElement('li', { key: `${diagnostic.code}-${indexValue}`, 'data-diagnostic-code': diagnostic.code },
            createElement('strong', null, diagnostic.label),
            createElement('span', null, `${diagnostic.code} / ${diagnostic.relation} / ${diagnostic.field}`)
          )
        ))
  );
}

function button(action: string, label: string, onClick: () => void): ReactElement {
  return createElement('button', { type: 'button', 'data-action': action, onClick }, label);
}

function taskById(currentDb: Db, id: string): TaskRow | undefined {
  return (currentDb.data.tasks ?? []).find((row): row is TaskRow => isTaskRow(row) && row.id === id);
}

function guideTaskText(currentDb: Db): string {
  const task = taskById(currentDb, 'task-guide');
  return task === undefined ? 'missing' : `${task.status} / ${task.points} points`;
}

function cellValue(row: unknown, fieldName: string): string {
  if (!isRecord(row)) return '';
  const valueAtField = row[fieldName];
  return typeof valueAtField === 'string' || typeof valueAtField === 'number' || typeof valueAtField === 'boolean'
    ? String(valueAtField)
    : '';
}

function rowsFromNested(input: unknown): readonly TaskCard[] {
  if (input instanceof Set) {
    return [...input].filter(isTaskCard);
  }
  if (input instanceof Map) {
    return [...input.values()].flatMap(rowsFromNested);
  }
  return [];
}

function ownerFromUnique(input: unknown): string {
  if (isTaskCard(input)) return input.owner ?? 'missing';
  if (input instanceof Map) {
    const first = input.values().next();
    return first.done === true ? 'missing' : ownerFromUnique(first.value);
  }
  return 'missing';
}

function collectionKind(input: unknown): string {
  if (input instanceof Set) return 'Set';
  if (input instanceof Map) return 'Map';
  return 'unknown';
}

function readableError(error: string): string {
  switch (error) {
    case 'required-field-violation':
      return 'Missing required field';
    case 'unique-key-violation':
      return 'Duplicate value';
    case 'foreign-key-violation':
      return 'Missing referenced row';
    case 'check-violation':
      return 'Check failed';
    case 'invalid_row':
      return 'Invalid row';
    default:
      return error;
  }
}

function isTaskRow(input: unknown): input is TaskRow {
  return isRecord(input) &&
    typeof input.id === 'string' &&
    typeof input.projectId === 'string' &&
    typeof input.ownerId === 'string' &&
    typeof input.points === 'number';
}

function isTaskCard(input: unknown): input is TaskCard {
  return isRecord(input) &&
    typeof input.id === 'string' &&
    typeof input.title === 'string' &&
    typeof input.projectId === 'string' &&
    typeof input.status === 'string' &&
    typeof input.points === 'number';
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === 'object' && input !== null && !Array.isArray(input);
}
