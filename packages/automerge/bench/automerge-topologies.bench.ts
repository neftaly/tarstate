import { performance } from 'node:perf_hooks';
import * as Automerge from '@automerge/automerge';
import { afterAll, bench, describe } from 'vitest';
import {
  booleanField,
  defineSchema,
  idField,
  jsonField,
  numberField,
  optional,
  relation,
  stringField,
  type JsonValue
} from '@tarstate/core/schema';
import { automergeMapSource, defineAutomergeMapRelations } from '@tarstate/automerge';
import { colorAt, valueAt } from './bench-helpers.js';

type TaskRow = {
  readonly id: string;
  readonly title: string;
  readonly effort?: number;
  readonly done?: boolean;
  readonly projectId?: string;
  readonly ownerId?: string;
  readonly dueDay?: number;
  readonly meta?: JsonValue;
};

type LabelRow = {
  readonly id: string;
  readonly name: string;
  readonly color?: string;
  readonly projectId?: string;
};

type MilestoneRow = {
  readonly id: string;
  readonly title: string;
  readonly projectId?: string;
  readonly dueDay?: number;
};

interface WorkspaceDoc {
  readonly workspace: {
    readonly tasks: readonly TaskRow[];
    readonly labelsById: Readonly<Record<string, LabelRow>>;
    readonly milestonesById: Readonly<Record<string, MilestoneRow>>;
    readonly boards: readonly {
      readonly id: string;
      readonly columns: readonly {
        readonly id: string;
        readonly cardIds: readonly string[];
      }[];
    }[];
  };
}

type TopologyName =
  | 'array rows'
  | 'map rows'
  | 'mixed mappings'
  | 'sparse optional fields'
  | 'larger mixed doc';
type ProbeKind = 'rows' | 'lookup' | 'rangeLookup';
type ProbeMode = 'current' | 'oracle';
type ProbeRelation = 'tasks' | 'labels' | 'milestones';
type ProbeMetric = {
  readonly topology: TopologyName;
  readonly relation: ProbeRelation;
  readonly probe: ProbeKind;
  readonly mode: ProbeMode;
  samples: number;
  elapsedMs: number;
  rowsVisited: number;
  rowsReturned: number;
};
type BenchTopology = {
  readonly name: TopologyName;
  readonly tasks: readonly TaskRow[];
  readonly labels: readonly LabelRow[];
  readonly milestones: readonly MilestoneRow[];
  readonly source: ReturnType<typeof automergeMapSource<WorkspaceDoc>>;
};

const PROJECT_COUNT = 96;
const SAMPLE_OPS = 12;
const QUERY_VARIANT_COUNT = 12;
const BENCH_OPTIONS = {
  time: 90,
  iterations: 4,
  warmupTime: 10,
  warmupIterations: 1
};

const schema = defineSchema({
  tasks: relation<TaskRow>({
    key: 'id',
    fields: {
      id: idField('task'),
      title: stringField(),
      effort: optional(numberField()),
      done: optional(booleanField()),
      projectId: optional(stringField()),
      ownerId: optional(stringField()),
      dueDay: optional(numberField()),
      meta: optional(jsonField())
    }
  }),
  labels: relation<LabelRow>({
    key: 'id',
    fields: {
      id: idField('label'),
      name: stringField(),
      color: optional(stringField()),
      projectId: optional(stringField())
    }
  }),
  milestones: relation<MilestoneRow>({
    key: 'id',
    fields: {
      id: idField('milestone'),
      title: stringField(),
      projectId: optional(stringField()),
      dueDay: optional(numberField())
    }
  })
});

const defineWorkspaceRelations = defineAutomergeMapRelations<WorkspaceDoc>();
const allMappings = defineWorkspaceRelations([
  { relation: schema.tasks, path: ['workspace', 'tasks'] },
  { relation: schema.labels, path: ['workspace', 'labelsById'] },
  { relation: schema.milestones, path: ['workspace', 'milestonesById'] }
]);
const projectIds = Array.from({ length: PROJECT_COUNT }, (_, index) => `project-${index}`);
const lookupValues = projectIds.slice(0, QUERY_VARIANT_COUNT);
const effortLowerBounds = Array.from(
  { length: QUERY_VARIANT_COUNT },
  (_, index) => 1_200 + index * 375
);
const topologies = [
  makeTopology('array rows', { taskCount: 1_200, labelCount: 0, milestoneCount: 0, sparse: false }),
  makeTopology('map rows', { taskCount: 0, labelCount: 1_200, milestoneCount: 0, sparse: false }),
  makeTopology('mixed mappings', { taskCount: 900, labelCount: 320, milestoneCount: 180, sparse: false }),
  makeTopology('sparse optional fields', { taskCount: 1_200, labelCount: 360, milestoneCount: 180, sparse: true }),
  makeTopology('larger mixed doc', { taskCount: 4_800, labelCount: 1_200, milestoneCount: 720, sparse: true })
] as const;
const metrics: ProbeMetric[] = [];

let sink = 0;

describe('Automerge document topology baselines', () => {
  for (const topology of topologies) {
    describe(topology.name, () => {
      if (topology.tasks.length > 0) {
        bench(
          'tasks rows via source',
          sourceRowsProbe(topology, schema.tasks, 'tasks', topology.tasks.length),
          BENCH_OPTIONS
        );
        bench('tasks rows oracle', oracleRowsProbe(topology.name, 'tasks', topology.tasks), BENCH_OPTIONS);
        bench('tasks project lookup via source', sourceLookupProbe(topology, schema.tasks, 'projectId'), BENCH_OPTIONS);
        bench('tasks project lookup oracle', taskProjectLookupOracle(topology), BENCH_OPTIONS);
        bench('tasks effort range via source', sourceRangeProbe(topology), BENCH_OPTIONS);
        bench('tasks effort range oracle', taskEffortRangeOracle(topology), BENCH_OPTIONS);
      }

      if (topology.labels.length > 0) {
        bench(
          'labels rows via source',
          sourceRowsProbe(topology, schema.labels, 'labels', topology.labels.length),
          BENCH_OPTIONS
        );
        bench('labels rows oracle', oracleRowsProbe(topology.name, 'labels', topology.labels), BENCH_OPTIONS);
        bench('labels project lookup via source', sourceLookupProbe(topology, schema.labels, 'projectId'), BENCH_OPTIONS);
        bench('labels project lookup oracle', labelProjectLookupOracle(topology), BENCH_OPTIONS);
      }

      if (topology.milestones.length > 0) {
        bench(
          'milestones due range via source',
          sourceMilestoneRangeProbe(topology),
          BENCH_OPTIONS
        );
        bench('milestones due range oracle', milestoneDueRangeOracle(topology), BENCH_OPTIONS);
      }
    });
  }
});

afterAll(() => {
  if (metrics.length === 0) return;

  console.table(metrics.map((metric) => ({
    topology: metric.topology,
    relation: metric.relation,
    probe: metric.probe,
    mode: metric.mode,
    samples: metric.samples,
    rowsVisited: metric.rowsVisited,
    rowsReturned: metric.rowsReturned,
    usPerSample: micros(metric.elapsedMs, metric.samples),
    rowsVisitedPerReturned: ratio(metric.rowsVisited, metric.rowsReturned)
  })));
  console.table(ratioRows());
  console.info([
    'Topology benchmark guidance:',
    '- Compare current/oracle ratios within the same topology; absolute times vary by machine and runner load.',
    '- Array-backed rows price indexed reads over list-shaped relations.',
    '- Map-backed rows price object-map traversal and keyed object access.',
    '- Mixed mappings keep array and map relations in the same Automerge document to expose cross-topology overhead.',
    '- Sparse optional fields include missing projectId/effort/dueDay/meta values so lookup and range paths see realistic gaps.',
    '- Larger mixed docs show whether costs scale with returned rows or full relation/document shape.'
  ].join('\n'));
});

function sourceRowsProbe(
  topology: BenchTopology,
  relationValue: typeof schema.tasks | typeof schema.labels,
  relationName: ProbeRelation,
  rowCount: number
): () => void {
  const metric = registerMetric(topology.name, relationName, 'rows', 'current');

  return () => {
    const startedAt = performance.now();

    for (let index = 0; index < SAMPLE_OPS; index += 1) {
      consume(topology.source.rows(relationValue as never));
    }

    record(metric, performance.now() - startedAt, {
      rowsVisited: rowCount * SAMPLE_OPS,
      rowsReturned: rowCount * SAMPLE_OPS
    });
  };
}

function oracleRowsProbe<Row>(
  topology: TopologyName,
  relationName: ProbeRelation,
  rows: readonly Row[]
): () => void {
  const metric = registerMetric(topology, relationName, 'rows', 'oracle');

  return () => {
    const startedAt = performance.now();

    for (let index = 0; index < SAMPLE_OPS; index += 1) {
      consume(rows);
    }

    record(metric, performance.now() - startedAt, {
      rowsVisited: rows.length * SAMPLE_OPS,
      rowsReturned: rows.length * SAMPLE_OPS
    });
  };
}

function sourceLookupProbe(
  topology: BenchTopology,
  relationValue: typeof schema.tasks | typeof schema.labels,
  field: 'projectId'
): () => void {
  const metric = registerMetric(topology.name, relationValue.name as ProbeRelation, 'lookup', 'current');
  let cursor = 0;

  return () => {
    const startedAt = performance.now();
    let rowsReturned = 0;

    for (let index = 0; index < SAMPLE_OPS; index += 1) {
      const rows = topology.source.lookup?.({
        relation: relationValue as never,
        field,
        value: valueAt(lookupValues, cursor)
      }) ?? [];
      cursor += 1;
      rowsReturned += rows.length;
      consume(rows);
    }

    record(metric, performance.now() - startedAt, {
      rowsVisited: rowsReturned,
      rowsReturned
    });
  };
}

function taskProjectLookupOracle(topology: BenchTopology): () => void {
  const metric = registerMetric(topology.name, 'tasks', 'lookup', 'oracle');
  const buckets = bucketByProject(topology.tasks);
  let cursor = 0;

  return () => {
    const startedAt = performance.now();
    let rowsReturned = 0;

    for (let index = 0; index < SAMPLE_OPS; index += 1) {
      const rows = buckets.get(valueAt(lookupValues, cursor)) ?? [];
      cursor += 1;
      rowsReturned += rows.length;
      consume(rows);
    }

    record(metric, performance.now() - startedAt, {
      rowsVisited: rowsReturned,
      rowsReturned
    });
  };
}

function labelProjectLookupOracle(topology: BenchTopology): () => void {
  const metric = registerMetric(topology.name, 'labels', 'lookup', 'oracle');
  const buckets = bucketByProject(topology.labels);
  let cursor = 0;

  return () => {
    const startedAt = performance.now();
    let rowsReturned = 0;

    for (let index = 0; index < SAMPLE_OPS; index += 1) {
      const rows = buckets.get(valueAt(lookupValues, cursor)) ?? [];
      cursor += 1;
      rowsReturned += rows.length;
      consume(rows);
    }

    record(metric, performance.now() - startedAt, {
      rowsVisited: rowsReturned,
      rowsReturned
    });
  };
}

function sourceRangeProbe(topology: BenchTopology): () => void {
  const metric = registerMetric(topology.name, 'tasks', 'rangeLookup', 'current');
  let cursor = 0;

  return () => {
    const startedAt = performance.now();
    let rowsVisited = 0;
    let rowsReturned = 0;

    for (let index = 0; index < SAMPLE_OPS; index += 1) {
      const rows = topology.source.rangeLookup?.({
        relation: schema.tasks,
        field: 'effort',
        lower: { value: valueAt(effortLowerBounds, cursor), inclusive: true }
      }) ?? [];
      cursor += 1;
      rowsVisited += binarySearchVisitCount(topology.tasks.length) + rows.length;
      rowsReturned += rows.length;
      consume(rows);
    }

    record(metric, performance.now() - startedAt, {
      rowsVisited,
      rowsReturned
    });
  };
}

function taskEffortRangeOracle(topology: BenchTopology): () => void {
  const metric = registerMetric(topology.name, 'tasks', 'rangeLookup', 'oracle');
  const sortedRows = topology.tasks
    .filter((row) => row.effort !== undefined)
    .sort((left, right) => requiredNumber(left.effort) - requiredNumber(right.effort));
  let cursor = 0;

  return () => {
    const startedAt = performance.now();
    let rowsVisited = 0;
    let rowsReturned = 0;

    for (let index = 0; index < SAMPLE_OPS; index += 1) {
      const startIndex = lowerBoundByNumber(sortedRows, valueAt(effortLowerBounds, cursor), (row) =>
        requiredNumber(row.effort));
      cursor += 1;
      const rows = sortedRows.slice(startIndex);
      rowsVisited += binarySearchVisitCount(sortedRows.length) + rows.length;
      rowsReturned += rows.length;
      consume(rows);
    }

    record(metric, performance.now() - startedAt, {
      rowsVisited,
      rowsReturned
    });
  };
}

function sourceMilestoneRangeProbe(topology: BenchTopology): () => void {
  const metric = registerMetric(topology.name, 'milestones', 'rangeLookup', 'current');
  let cursor = 0;

  return () => {
    const startedAt = performance.now();
    let rowsVisited = 0;
    let rowsReturned = 0;

    for (let index = 0; index < SAMPLE_OPS; index += 1) {
      const rows = topology.source.rangeLookup?.({
        relation: schema.milestones,
        field: 'dueDay',
        lower: { value: valueAt(effortLowerBounds, cursor), inclusive: true }
      }) ?? [];
      cursor += 1;
      rowsVisited += binarySearchVisitCount(topology.milestones.length) + rows.length;
      rowsReturned += rows.length;
      consume(rows);
    }

    record(metric, performance.now() - startedAt, {
      rowsVisited,
      rowsReturned
    });
  };
}

function milestoneDueRangeOracle(topology: BenchTopology): () => void {
  const metric = registerMetric(topology.name, 'milestones', 'rangeLookup', 'oracle');
  const sortedRows = topology.milestones
    .filter((row) => row.dueDay !== undefined)
    .sort((left, right) => requiredNumber(left.dueDay) - requiredNumber(right.dueDay));
  let cursor = 0;

  return () => {
    const startedAt = performance.now();
    let rowsVisited = 0;
    let rowsReturned = 0;

    for (let index = 0; index < SAMPLE_OPS; index += 1) {
      const startIndex = lowerBoundByNumber(sortedRows, valueAt(effortLowerBounds, cursor), (row) =>
        requiredNumber(row.dueDay));
      cursor += 1;
      const rows = sortedRows.slice(startIndex);
      rowsVisited += binarySearchVisitCount(sortedRows.length) + rows.length;
      rowsReturned += rows.length;
      consume(rows);
    }

    record(metric, performance.now() - startedAt, {
      rowsVisited,
      rowsReturned
    });
  };
}

function makeTopology(
  name: TopologyName,
  options: {
    readonly taskCount: number;
    readonly labelCount: number;
    readonly milestoneCount: number;
    readonly sparse: boolean;
  }
): BenchTopology {
  const tasks = makeTasks(options.taskCount, options.sparse);
  const labels = makeLabels(options.labelCount, options.sparse);
  const milestones = makeMilestones(options.milestoneCount, options.sparse);
  const doc = Automerge.from({
    workspace: {
      tasks,
      labelsById: Object.fromEntries(labels.map((row) => [row.id, row])),
      milestonesById: Object.fromEntries(milestones.map((row) => [row.id, row])),
      boards: makeBoards(Math.max(1, Math.ceil(options.taskCount / 600)), Math.max(1, options.taskCount))
    }
  }) as Automerge.Doc<WorkspaceDoc>;

  return {
    name,
    tasks,
    labels,
    milestones,
    source: automergeMapSource(doc, { relations: allMappings })
  };
}

function makeTasks(count: number, sparse: boolean): readonly TaskRow[] {
  return Array.from({ length: count }, (_, index) => {
    const row: TaskRow = {
      id: `task-${index}`,
      title: `Task ${index}`
    };
    if (!sparse || index % 7 !== 0) {
      (row as Mutable<TaskRow>).effort = (index * 31) % 8_000;
    }
    if (!sparse || index % 5 !== 0) {
      (row as Mutable<TaskRow>).projectId = `project-${index % PROJECT_COUNT}`;
    }
    if (!sparse || index % 4 !== 0) {
      (row as Mutable<TaskRow>).done = index % 3 === 0;
    }
    if (!sparse || index % 6 !== 0) {
      (row as Mutable<TaskRow>).ownerId = `owner-${index % 48}`;
    }
    if (!sparse || index % 8 !== 0) {
      (row as Mutable<TaskRow>).dueDay = (index * 17) % 8_000;
    }
    if (!sparse || index % 9 !== 0) {
      (row as Mutable<TaskRow>).meta = {
        rank: index,
        tags: [`tag-${index % 13}`, `tag-${index % 29}`],
        checklist: Array.from({ length: index % 5 }, (_, itemIndex) => ({
          id: `task-${index}-check-${itemIndex}`,
          done: (index + itemIndex) % 2 === 0
        }))
      };
    }
    return row;
  });
}

function makeLabels(count: number, sparse: boolean): readonly LabelRow[] {
  return Array.from({ length: count }, (_, index) => {
    const row: LabelRow = {
      id: `label-${index}`,
      name: `Label ${index}`
    };
    if (!sparse || index % 4 !== 0) {
      (row as Mutable<LabelRow>).projectId = `project-${index % PROJECT_COUNT}`;
    }
    if (!sparse || index % 3 !== 0) {
      (row as Mutable<LabelRow>).color = colorAt(index);
    }
    return row;
  });
}

function makeMilestones(count: number, sparse: boolean): readonly MilestoneRow[] {
  return Array.from({ length: count }, (_, index) => {
    const row: MilestoneRow = {
      id: `milestone-${index}`,
      title: `Milestone ${index}`
    };
    if (!sparse || index % 5 !== 0) {
      (row as Mutable<MilestoneRow>).projectId = `project-${index % PROJECT_COUNT}`;
    }
    if (!sparse || index % 6 !== 0) {
      (row as Mutable<MilestoneRow>).dueDay = (index * 43) % 8_000;
    }
    return row;
  });
}

function makeBoards(boardCount: number, taskCount: number) {
  return Array.from({ length: boardCount }, (_, boardIndex) => ({
    id: `board-${boardIndex}`,
    columns: Array.from({ length: 5 }, (_, columnIndex) => ({
      id: `board-${boardIndex}-column-${columnIndex}`,
      cardIds: Array.from({ length: 16 }, (_, cardIndex) =>
        `task-${(boardIndex * 313 + columnIndex * 37 + cardIndex * 11) % taskCount}`)
    }))
  }));
}

function bucketByProject<Row extends { readonly projectId?: string }>(
  rows: readonly Row[]
): ReadonlyMap<string, readonly Row[]> {
  const buckets = new Map<string, Row[]>();
  for (const row of rows) {
    if (row.projectId === undefined) continue;
    const bucket = buckets.get(row.projectId);
    if (bucket === undefined) {
      buckets.set(row.projectId, [row]);
    } else {
      bucket.push(row);
    }
  }
  return buckets;
}

function registerMetric(
  topology: TopologyName,
  relationName: ProbeRelation,
  probe: ProbeKind,
  mode: ProbeMode
): ProbeMetric {
  const metric = {
    topology,
    relation: relationName,
    probe,
    mode,
    samples: 0,
    elapsedMs: 0,
    rowsVisited: 0,
    rowsReturned: 0
  };
  metrics.push(metric);
  return metric;
}

function record(
  metric: ProbeMetric,
  elapsedMs: number,
  counts: {
    readonly rowsVisited?: number;
    readonly rowsReturned?: number;
  }
): void {
  metric.samples += SAMPLE_OPS;
  metric.elapsedMs += elapsedMs;
  metric.rowsVisited += counts.rowsVisited ?? 0;
  metric.rowsReturned += counts.rowsReturned ?? 0;
}

function ratioRows(): readonly {
  readonly topology: string;
  readonly relation: string;
  readonly probe: string;
  readonly currentUsPerSample: string;
  readonly oracleUsPerSample: string;
  readonly currentToOracle: string;
  readonly currentRowsVisitedPerReturned: string;
  readonly oracleRowsVisitedPerReturned: string;
}[] {
  const groups = new Map<string, { current?: ProbeMetric; oracle?: ProbeMetric }>();
  for (const metric of metrics) {
    const key = `${metric.topology}:${metric.relation}:${metric.probe}`;
    const group = groups.get(key) ?? {};
    group[metric.mode] = metric;
    groups.set(key, group);
  }

  return Array.from(groups.entries()).flatMap(([key, group]) => {
    if (group.current === undefined || group.oracle === undefined) return [];
    const [topology, relationName, probe] = key.split(':');
    return [{
      topology: topology ?? '',
      relation: relationName ?? '',
      probe: probe ?? '',
      currentUsPerSample: micros(group.current.elapsedMs, group.current.samples),
      oracleUsPerSample: micros(group.oracle.elapsedMs, group.oracle.samples),
      currentToOracle: ratio(
        microsNumber(group.current.elapsedMs, group.current.samples),
        microsNumber(group.oracle.elapsedMs, group.oracle.samples)
      ),
      currentRowsVisitedPerReturned: ratio(group.current.rowsVisited, group.current.rowsReturned),
      oracleRowsVisitedPerReturned: ratio(group.oracle.rowsVisited, group.oracle.rowsReturned)
    }];
  });
}

function lowerBoundByNumber<Row>(
  rows: readonly Row[],
  value: number,
  numberFor: (row: Row) => number
): number {
  let lower = 0;
  let upper = rows.length;
  while (lower < upper) {
    const middle = lower + Math.floor((upper - lower) / 2);
    const row = rows[middle];
    if (row === undefined) throw new Error('unexpected sparse sorted rows');
    if (numberFor(row) < value) {
      lower = middle + 1;
    } else {
      upper = middle;
    }
  }
  return lower;
}

function binarySearchVisitCount(length: number): number {
  return Math.max(1, Math.ceil(Math.log2(Math.max(1, length))));
}

function requiredNumber(value: number | undefined): number {
  if (value === undefined) throw new Error('expected benchmark field to be present');
  return value;
}

function micros(elapsedMs: number, samples: number): string {
  return microsNumber(elapsedMs, samples).toFixed(3);
}

function microsNumber(elapsedMs: number, samples: number): number {
  return samples === 0 ? 0 : (elapsedMs * 1_000) / samples;
}

function ratio(numerator: number, denominator: number): string {
  if (denominator === 0) return numerator === 0 ? '0.00' : 'inf';
  return (numerator / denominator).toFixed(2);
}

function consume(rows: readonly unknown[]): void {
  sink = (sink + rows.length) % Number.MAX_SAFE_INTEGER;
  if (sink < 0) throw new Error('unreachable benchmark sink');
}

type Mutable<Value> = {
  -readonly [Key in keyof Value]: Value[Key];
};
