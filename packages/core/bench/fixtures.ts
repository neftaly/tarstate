import {
  aggregate,
  as,
  asc,
  avg,
  btree,
  booleanField,
  count,
  createDb,
  defineSchema,
  desc,
  eq,
  expand,
  field,
  from,
  fromObjectSource,
  gte,
  hash,
  idField,
  join,
  jsonField,
  keyBy,
  leftJoin,
  lookup,
  maybe,
  numberField,
  optional,
  pipe,
  project,
  refField,
  relation,
  sortLimit,
  stringField,
  sum,
  uniqueIndex,
  where,
  type Db,
  type RelationSource
} from '@tarstate/core';
import { fromIndexedObjectSource } from '@tarstate/core/indexed-source';

export type ProjectRow = {
  readonly id: string;
  readonly name: string;
  readonly status: string;
  readonly priority: number;
  readonly budget: number;
};

export type PersonRow = {
  readonly id: string;
  readonly name: string;
  readonly email: string;
  readonly role: string;
  readonly region: string;
  readonly active: boolean;
  readonly capacity: number;
  readonly skills: readonly string[];
};

export type TaskLabel = {
  readonly name: string;
  readonly weight: number;
};

export type TaskRow = {
  readonly id: string;
  readonly projectId: string;
  readonly ownerId: string;
  readonly reviewerId?: string;
  readonly title: string;
  readonly status: string;
  readonly done: boolean;
  readonly points: number;
  readonly priority: number;
  readonly createdAt: number;
  readonly labels: readonly TaskLabel[];
};

export type BenchData = Record<string, readonly unknown[]> & {
  readonly projects: readonly ProjectRow[];
  readonly people: readonly PersonRow[];
  readonly tasks: readonly TaskRow[];
};

export const benchSchema = defineSchema({
  projects: relation<ProjectRow>({
    key: 'id',
    fields: {
      id: idField('project'),
      name: stringField(),
      status: stringField(),
      priority: numberField(),
      budget: numberField()
    }
  }),
  people: relation<PersonRow>({
    key: 'id',
    fields: {
      id: idField('person'),
      name: stringField(),
      email: stringField(),
      role: stringField(),
      region: stringField(),
      active: booleanField(),
      capacity: numberField(),
      skills: jsonField()
    }
  }),
  tasks: relation<TaskRow>({
    key: 'id',
    fields: {
      id: idField('task'),
      projectId: refField('projects.id'),
      ownerId: refField('people.id'),
      reviewerId: optional(refField('people.id')),
      title: stringField(),
      status: stringField(),
      done: booleanField(),
      points: numberField(),
      priority: numberField(),
      createdAt: numberField(),
      labels: jsonField()
    }
  })
});

export const projectRef = as(benchSchema.projects, 'project');
export const personRef = as(benchSchema.people, 'person');
export const taskRef = as(benchSchema.tasks, 'task');

export const benchScaleSpecs = {
  small: { projects: 8, people: 32, tasks: 240 },
  medium: { projects: 24, people: 96, tasks: 960 },
  large: { projects: 64, people: 256, tasks: 4096 }
} as const;

export type BenchScaleName = keyof typeof benchScaleSpecs;
export type BenchScaleSpec = (typeof benchScaleSpecs)[BenchScaleName];

export type BenchQueries = ReturnType<typeof createBenchQueries>;
export type BenchFixture = {
  readonly scale: BenchScaleName;
  readonly spec: BenchScaleSpec;
  readonly data: BenchData;
  readonly db: Db;
  readonly objectSource: RelationSource;
  readonly indexedSource: RelationSource;
  readonly queries: BenchQueries;
};

const PROJECT_STATUSES = ['planned', 'active', 'paused', 'done'] as const;
const TASK_STATUSES = ['todo', 'doing', 'review', 'done', 'blocked'] as const;
const ROLES = ['engineer', 'designer', 'manager', 'analyst', 'researcher', 'support'] as const;
const REGIONS = ['apac', 'emea', 'amer', 'remote'] as const;
const SKILLS = ['ui', 'data', 'infra', 'runtime', 'docs', 'ops', 'qa', 'product'] as const;
const LABELS = ['core', 'ux', 'sync', 'api', 'schema', 'docs', 'release', 'support'] as const;

export function createBenchFixture(scale: BenchScaleName = 'medium'): BenchFixture {
  const data = createBenchData(scale);

  return {
    scale,
    spec: benchScaleSpecs[scale],
    data,
    db: createDb(data, { env: { minimumPoints: 5 } }),
    objectSource: fromObjectSource(data),
    indexedSource: fromIndexedObjectSource(data),
    queries: createBenchQueries(data)
  };
}

export function createBenchData(scale: BenchScaleName): BenchData {
  const spec = benchScaleSpecs[scale];
  const projects = Array.from({ length: spec.projects }, (_, index) => projectRow(index));
  const people = Array.from({ length: spec.people }, (_, index) => personRow(index));
  const tasks = Array.from({ length: spec.tasks }, (_, index) => taskRow(index, projects, people));

  return { projects, people, tasks };
}

export function createBenchQueries(data: BenchData) {
  const lookupOwnerId = at(data.tasks, Math.floor(data.tasks.length / 3)).ownerId;
  const totalPoints = field<number>('taskRollup', 'totalPoints');

  const relationScan = from(taskRef);
  const activePeople = pipe(
    from(personRef),
    where(eq(personRef.active, true)),
    project({
      id: personRef.id,
      name: personRef.name,
      email: personRef.email,
      role: personRef.role,
      region: personRef.region,
      capacity: personRef.capacity
    }),
    keyBy('id')
  );
  const openTasks = pipe(
    from(taskRef),
    where(eq(taskRef.done, false)),
    project({
      id: taskRef.id,
      projectId: taskRef.projectId,
      ownerId: taskRef.ownerId,
      points: taskRef.points,
      priority: taskRef.priority
    }),
    keyBy('id')
  );
  const filteredProjectedTasks = pipe(
    from(taskRef),
    where(gte(taskRef.points, 5)),
    where(eq(taskRef.done, false)),
    project({
      id: taskRef.id,
      projectId: taskRef.projectId,
      ownerId: taskRef.ownerId,
      points: taskRef.points,
      priority: taskRef.priority
    })
  );
  const taskProjectOwnerJoin = pipe(
    from(taskRef),
    join(from(projectRef), eq(taskRef.projectId, projectRef.id)),
    join(from(personRef), eq(taskRef.ownerId, personRef.id)),
    project({
      id: taskRef.id,
      project: projectRef.name,
      owner: personRef.name,
      role: personRef.role,
      points: taskRef.points
    }),
    keyBy('id')
  );
  const reviewerLeftJoinMissHeavy = pipe(
    from(taskRef),
    leftJoin(from(personRef), eq(taskRef.reviewerId, personRef.id)),
    project({
      id: taskRef.id,
      reviewer: maybe(personRef.name),
      points: taskRef.points
    }),
    keyBy('id')
  );
  const topPriorityTasks = pipe(
    from(taskRef),
    sortLimit(40, desc(taskRef.priority), desc(taskRef.points), asc(taskRef.createdAt)),
    project({
      id: taskRef.id,
      projectId: taskRef.projectId,
      ownerId: taskRef.ownerId,
      points: taskRef.points,
      priority: taskRef.priority
    })
  );
  const projectTaskAggregates = pipe(
    from(taskRef),
    aggregate({
      groupBy: { projectId: taskRef.projectId },
      aggregates: {
        tasks: count(),
        totalPoints: sum(taskRef.points),
        averagePoints: avg(taskRef.points)
      }
    }),
    sortLimit(16, desc(totalPoints))
  );
  const expandedTaskLabels = pipe(
    from(taskRef),
    expand(taskRef.labels, { as: 'label' }),
    project({
      taskId: taskRef.id,
      label: field<string>('label', 'name'),
      weight: field<number>('label', 'weight')
    })
  );
  const lookupTasksByOwner = pipe(
    lookup(taskRef, 'ownerId', lookupOwnerId),
    sortLimit(25, desc(taskRef.points)),
    project({
      id: taskRef.id,
      ownerId: taskRef.ownerId,
      points: taskRef.points,
      status: taskRef.status
    })
  );
  const indexedPeople = pipe(
    from(personRef),
    hash(personRef.id),
    uniqueIndex(personRef.email),
    btree(personRef.capacity),
    project({
      id: personRef.id,
      email: personRef.email,
      capacity: personRef.capacity
    }),
    keyBy('id')
  );

  return {
    relationScan,
    activePeople,
    openTasks,
    filteredProjectedTasks,
    taskProjectOwnerJoin,
    reviewerLeftJoinMissHeavy,
    topPriorityTasks,
    projectTaskAggregates,
    expandedTaskLabels,
    lookupTasksByOwner,
    indexedPeople,
    batch: {
      activePeople,
      openTasks,
      projectTaskAggregates
    }
  };
}

export function extraPerson(index: number, overrides: Partial<PersonRow> = {}): PersonRow {
  return {
    ...personRow(1_000_000 + index),
    ...overrides
  };
}

export function extraTask(data: BenchData, index: number, overrides: Partial<TaskRow> = {}): TaskRow {
  return {
    ...taskRow(1_000_000 + index, data.projects, data.people),
    ...overrides
  };
}

export function extraTasks(data: BenchData, count: number, offset = 0): readonly TaskRow[] {
  return Array.from({ length: count }, (_, index) => extraTask(data, offset + index));
}

export function duplicateEmailPerson(data: BenchData): PersonRow {
  return extraPerson(42, { email: at(data.people, 0).email });
}

let benchSink = 0;

export function consumeBenchResult(value: unknown): void {
  consumeValue(value, 0, new WeakSet());
  (globalThis as typeof globalThis & { __tarstateCoreBenchSink?: number }).__tarstateCoreBenchSink = benchSink;
}

function consumeValue(value: unknown, depth: number, seen: WeakSet<object>): void {
  if (depth > 6) {
    absorbString('depth');
    return;
  }

  switch (typeof value) {
    case 'undefined':
      absorbNumber(0);
      return;
    case 'boolean':
      absorbNumber(value ? 1 : 2);
      return;
    case 'number':
      absorbNumber(Number.isFinite(value) ? value : 0);
      return;
    case 'string':
      absorbString(value);
      return;
    case 'bigint':
    case 'symbol':
      absorbString(String(value));
      return;
    case 'function':
      absorbString(value.name);
      return;
    case 'object':
      consumeObject(value, depth, seen);
      return;
  }
}

function consumeObject(value: object | null, depth: number, seen: WeakSet<object>): void {
  if (value === null) {
    absorbNumber(3);
    return;
  }

  if (seen.has(value)) {
    absorbString('cycle');
    return;
  }

  seen.add(value);

  if (Array.isArray(value)) {
    consumeArray(value, depth, seen);
    return;
  }

  if (value instanceof Set) {
    consumeSet(value, depth, seen);
    return;
  }

  if (value instanceof Map) {
    consumeMap(value, depth, seen);
    return;
  }

  const entries = Object.entries(value);
  absorbString(value.constructor.name);
  absorbNumber(entries.length);
  for (const [key, item] of entries) {
    absorbString(key);
    consumeValue(item, depth + 1, seen);
  }
}

function consumeArray(items: readonly unknown[], depth: number, seen: WeakSet<object>): void {
  absorbString('array');
  absorbNumber(items.length);
  for (const index of sampleIndexes(items.length)) {
    absorbNumber(index);
    consumeValue(items[index], depth + 1, seen);
  }
}

function consumeSet(items: ReadonlySet<unknown>, depth: number, seen: WeakSet<object>): void {
  absorbString('set');
  absorbNumber(items.size);
  let index = 0;
  for (const item of items) {
    if (index >= 4) break;
    absorbNumber(index);
    consumeValue(item, depth + 1, seen);
    index += 1;
  }
}

function consumeMap(items: ReadonlyMap<unknown, unknown>, depth: number, seen: WeakSet<object>): void {
  absorbString('map');
  absorbNumber(items.size);
  let index = 0;
  for (const [key, value] of items) {
    if (index >= 4) break;
    absorbNumber(index);
    consumeValue(key, depth + 1, seen);
    consumeValue(value, depth + 1, seen);
    index += 1;
  }
}

function sampleIndexes(length: number): readonly number[] {
  if (length <= 4) {
    return Array.from({ length }, (_, index) => index);
  }

  return [0, Math.floor(length / 3), Math.floor((length * 2) / 3), length - 1];
}

function absorbString(value: string): void {
  absorbNumber(value.length);
  for (let index = 0; index < value.length && index < 32; index += 1) {
    absorbNumber(value.charCodeAt(index));
  }
}

function absorbNumber(value: number): void {
  const normalized = Math.trunc(value * 1_000) | 0;
  benchSink = Math.imul(benchSink ^ normalized, 16_777_619) >>> 0;
}

function projectRow(index: number): ProjectRow {
  return {
    id: id('project', index),
    name: `Project ${padded(index)}`,
    status: pick(PROJECT_STATUSES, index * 3),
    priority: 1 + index % 5,
    budget: 25_000 + index * 137
  };
}

function personRow(index: number): PersonRow {
  const idValue = id('person', index);

  return {
    id: idValue,
    name: `Person ${padded(index)}`,
    email: `${idValue}@bench.local`,
    role: pick(ROLES, index * 5),
    region: pick(REGIONS, index * 7),
    active: index % 7 !== 0,
    capacity: 20 + index % 31,
    skills: [
      pick(SKILLS, index),
      pick(SKILLS, index + 3),
      pick(SKILLS, index + 5)
    ]
  };
}

function taskRow(index: number, projects: readonly ProjectRow[], people: readonly PersonRow[]): TaskRow {
  const status = pick(TASK_STATUSES, index * 7);
  const reviewerId = reviewerIdFor(index, people);
  const row = {
    id: id('task', index),
    projectId: at(projects, index * 11).id,
    ownerId: at(people, index * 17 + Math.floor(index / 13)).id,
    title: `Task ${padded(index)}`,
    status,
    done: status === 'done',
    points: 1 + index % 13,
    priority: 1 + index % 5,
    createdAt: 1_700_000_000 + index * 97,
    labels: labelsFor(index)
  };

  return reviewerId === undefined ? row : { ...row, reviewerId };
}

function labelsFor(index: number): readonly TaskLabel[] {
  const count = 1 + index % 3;
  return Array.from({ length: count }, (_, labelIndex) => ({
    name: pick(LABELS, index + labelIndex * 2),
    weight: 1 + (index + labelIndex) % 4
  }));
}

function reviewerIdFor(index: number, people: readonly PersonRow[]): string | undefined {
  if (index % 11 === 0 || index % 5 === 0 || index % 5 === 1 || index % 5 === 2) {
    return undefined;
  }

  return at(people, index * 19 + 3).id;
}

function id(prefix: string, index: number): string {
  return `${prefix}-${padded(index)}`;
}

function padded(index: number): string {
  return index.toString().padStart(6, '0');
}

function pick<const Values extends readonly [string, ...string[]]>(values: Values, index: number): Values[number] {
  return values[index % values.length] ?? values[0];
}

function at<Row>(rows: readonly Row[], index: number): Row {
  const row = rows[index % rows.length];
  if (row === undefined) {
    throw new RangeError('benchmark fixture scale must create non-empty relations');
  }

  return row;
}
