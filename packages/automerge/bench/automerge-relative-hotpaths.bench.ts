import { performance } from 'node:perf_hooks';
import * as Automerge from '@automerge/automerge';
import { afterAll, bench, describe } from 'vitest';
import { runtimeSystemRelations } from '@tarstate/core/adapter';
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
import {
  automergeMapAdapter,
  automergeMapSource,
  automergeObjectLocations,
  automergePathForObjectId,
  defineAutomergeMapRelations,
  type AutomergeObjectLocation,
  type AutomergeObjectReference
} from '@tarstate/automerge';
import { colorAt, stableSize, valueAt } from './bench-helpers.js';

type TaskRow = {
  readonly id: string;
  readonly title: string;
  readonly effort?: number;
  readonly done?: boolean;
  readonly projectId?: string;
  readonly meta?: JsonValue;
};

type LabelRow = {
  readonly id: string;
  readonly name: string;
  readonly color?: string;
};

interface WorkspaceDoc {
  readonly workspace: {
    readonly tasks: readonly TaskRow[];
    readonly labelsById: Readonly<Record<string, LabelRow>>;
    readonly boards: readonly {
      readonly id: string;
      readonly columns: readonly {
        readonly id: string;
        readonly cardIds: readonly string[];
      }[];
    }[];
  };
}

type ProbeMode = 'current' | 'baseline';
type ProbeMetric = {
  readonly group: string;
  readonly probe: string;
  readonly mode: ProbeMode;
  samples: number;
  elapsedMs: number;
  rowsVisited: number;
  rowsReturned: number;
  objectsVisited: number;
  objectLookups: number;
};

const ROW_COUNT = 900;
const LABEL_COUNT = 180;
const PROJECT_COUNT = 90;
const BOARD_COUNT = 6;
const QUERY_VARIANT_COUNT = 12;
const SAMPLE_OPS = 16;
const BENCH_OPTIONS = {
  time: 80,
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
      meta: optional(jsonField())
    }
  }),
  labels: relation<LabelRow>({
    key: 'id',
    fields: {
      id: idField('label'),
      name: stringField(),
      color: optional(stringField())
    }
  })
});

const defineWorkspaceRelations = defineAutomergeMapRelations<WorkspaceDoc>();
const mappings = defineWorkspaceRelations([
  { relation: schema.tasks, path: ['workspace', 'tasks'] },
  { relation: schema.labels, path: ['workspace', 'labelsById'] }
]);
const doc = makeDoc();
const source = automergeMapSource(doc, { relations: mappings });
const adapter = automergeMapAdapter({
  doc,
  relations: mappings,
  runtimeId: 'automerge-relative-hotpaths'
});
const taskRows = doc.workspace.tasks;
const labelsById = doc.workspace.labelsById;
const projectIds = Array.from({ length: PROJECT_COUNT }, (_, index) => `project-${index}`);
const lookupValues = projectIds.slice(0, QUERY_VARIANT_COUNT);
const rangeLowerBounds = Array.from(
  { length: QUERY_VARIANT_COUNT },
  (_, index) => 1_500 + index * 450
);
const labelKeys = Array.from({ length: QUERY_VARIANT_COUNT }, (_, index) =>
  `label-${(index * 37) % LABEL_COUNT}`);
const lookupBuckets = bucketTasksByProject(taskRows);
const tasksByEffort = [...taskRows].sort((left, right) =>
  (left.effort ?? Number.NEGATIVE_INFINITY) - (right.effort ?? Number.NEGATIVE_INFINITY));
const locations = automergeObjectLocations(doc, { relations: mappings });
const objectIds = locations.map((location) => location.objectId);
const locationByObjectId = new Map(locations.map((location) => [location.objectId, location]));
const labelLocationByKey = new Map(
  locations
    .filter((location) => location.relation === schema.labels.name && typeof location.key === 'string')
    .map((location) => [location.key as string, location])
);
const cachedRuntimeLocationRows = adapter.source.rows(runtimeSystemRelations.objectLocations);
const objectVisitCount = locations.length;
const metrics: ProbeMetric[] = [];
let sink = 0;

describe('Automerge relative hotpath baselines', () => {
  describe('source.lookup vs prebuilt Map', () => {
    bench('source.lookup projectId', sourceLookupProbe(), BENCH_OPTIONS);
    bench('prebuilt Map projectId', bucketLookupProbe(), BENCH_OPTIONS);
  });

  describe('source.rangeLookup vs sorted lower-bound slice', () => {
    bench('source.rangeLookup effort lower bound', sourceRangeLookupProbe(), BENCH_OPTIONS);
    bench('sorted lower-bound slice', sortedRangeLookupProbe(), BENCH_OPTIONS);
  });

  describe('objectIdFor on map-backed relation vs direct doc map access', () => {
    bench('adapter.objectIdFor labels', objectIdForProbe(), BENCH_OPTIONS);
    bench('direct doc map labels', directLabelObjectIdProbe(), BENCH_OPTIONS);
  });

  describe('object reference/path APIs vs prebuilt object locations', () => {
    bench('automergePathForObjectId pure traversal', purePathForObjectIdProbe(), BENCH_OPTIONS);
    bench('adapter.pathForObjectId cached', adapterPathForObjectIdProbe(), BENCH_OPTIONS);
    bench('prebuilt objectId to path', prebuiltPathProbe(), BENCH_OPTIONS);
    bench('adapter.objectReferenceFor labels cached', objectReferenceForProbe(), BENCH_OPTIONS);
    bench('prebuilt label object reference', prebuiltReferenceProbe(), BENCH_OPTIONS);
  });

  describe('runtime objectLocations cached adapter rows vs captured rows', () => {
    bench('adapter runtime objectLocations cached rows', runtimeObjectRowsProbe(), BENCH_OPTIONS);
    bench('captured runtime objectLocations rows', cachedRuntimeObjectRowsProbe(), BENCH_OPTIONS);
  });
});

afterAll(() => {
  if (metrics.length === 0) return;

  console.table(metrics.map((metric) => ({
    group: metric.group,
    probe: metric.probe,
    mode: metric.mode,
    samples: metric.samples,
    rowsVisited: metric.rowsVisited,
    rowsReturned: metric.rowsReturned,
    objectsVisited: metric.objectsVisited,
    objectLookups: metric.objectLookups,
    usPerSample: micros(metric.elapsedMs, metric.samples),
    rowsVisitedPerReturned: ratio(metric.rowsVisited, metric.rowsReturned),
    objectsVisitedPerLookup: ratio(metric.objectsVisited, metric.objectLookups)
  })));

  console.table(ratioRows());
  console.info([
    'Decomplection guidance:',
    '- Ratios near 1.0 mean the current path is close enough to the simple baseline for this dataset; prefer implementation simplicity.',
    '- Large lookup/range ratios with rowsVisitedPerReturned near the full relation size justify an index only if the workload repeats those reads between writes.',
    '- Large pure object path ratios price repeated full document location traversal in automergePathForObjectId.',
    '- Cached adapter path/reference and runtime-row ratios price map/snapshot access after the location cache is warm.',
    '- If cached adapter/runtime ratios are still large, the remaining target is the per-call lookup or row-return overhead, not object traversal.'
  ].join('\n'));
});

function sourceLookupProbe(): () => void {
  const metric = registerMetric('lookup', 'source.lookup', 'current');
  let cursor = 0;

  return () => {
    const startedAt = performance.now();
    let rowsReturned = 0;

    for (let index = 0; index < SAMPLE_OPS; index += 1) {
      const projectId = valueAt(lookupValues, cursor);
      cursor += 1;
      const rows = source.lookup?.({ relation: schema.tasks, field: 'projectId', value: projectId }) ?? [];
      rowsReturned += rows.length;
      consume(rows);
    }

    record(metric, performance.now() - startedAt, {
      rowsVisited: rowsReturned,
      rowsReturned
    });
  };
}

function bucketLookupProbe(): () => void {
  const metric = registerMetric('lookup', 'prebuilt Map', 'baseline');
  let cursor = 0;

  return () => {
    const startedAt = performance.now();
    let rowsReturned = 0;

    for (let index = 0; index < SAMPLE_OPS; index += 1) {
      const rows = lookupBuckets.get(valueAt(lookupValues, cursor)) ?? [];
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

function sourceRangeLookupProbe(): () => void {
  const metric = registerMetric('rangeLookup', 'source.rangeLookup', 'current');
  let cursor = 0;

  return () => {
    const startedAt = performance.now();
    let rowsVisited = 0;
    let rowsReturned = 0;

    for (let index = 0; index < SAMPLE_OPS; index += 1) {
      const lower = valueAt(rangeLowerBounds, cursor);
      cursor += 1;
      const rows = source.rangeLookup?.({
        relation: schema.tasks,
        field: 'effort',
        lower: { value: lower, inclusive: true }
      }) ?? [];
      rowsVisited += binarySearchVisitCount(ROW_COUNT) + rows.length;
      rowsReturned += rows.length;
      consume(rows);
    }

    record(metric, performance.now() - startedAt, {
      rowsVisited,
      rowsReturned
    });
  };
}

function sortedRangeLookupProbe(): () => void {
  const metric = registerMetric('rangeLookup', 'sorted lower-bound', 'baseline');
  let cursor = 0;

  return () => {
    const startedAt = performance.now();
    let rowsVisited = 0;
    let rowsReturned = 0;

    for (let index = 0; index < SAMPLE_OPS; index += 1) {
      const startIndex = lowerBound(tasksByEffort, valueAt(rangeLowerBounds, cursor));
      cursor += 1;
      const rows = tasksByEffort.slice(startIndex);
      rowsVisited += binarySearchVisitCount(tasksByEffort.length) + rows.length;
      rowsReturned += rows.length;
      consume(rows);
    }

    record(metric, performance.now() - startedAt, {
      rowsVisited,
      rowsReturned
    });
  };
}

function objectIdForProbe(): () => void {
  const metric = registerMetric('objectIdFor', 'adapter.objectIdFor labels', 'current');
  let cursor = 0;

  return () => {
    const startedAt = performance.now();

    for (let index = 0; index < SAMPLE_OPS; index += 1) {
      consumeValue(adapter.objectIdFor(schema.labels, valueAt(labelKeys, cursor)));
      cursor += 1;
    }

    record(metric, performance.now() - startedAt, {
      rowsVisited: SAMPLE_OPS,
      objectLookups: SAMPLE_OPS
    });
  };
}

function directLabelObjectIdProbe(): () => void {
  const metric = registerMetric('objectIdFor', 'direct doc map labels', 'baseline');
  let cursor = 0;

  return () => {
    const startedAt = performance.now();

    for (let index = 0; index < SAMPLE_OPS; index += 1) {
      const label = labelsById[valueAt(labelKeys, cursor)];
      cursor += 1;
      consumeValue(label === undefined ? null : Automerge.getObjectId(label));
    }

    record(metric, performance.now() - startedAt, {
      rowsVisited: SAMPLE_OPS,
      objectLookups: SAMPLE_OPS
    });
  };
}

function purePathForObjectIdProbe(): () => void {
  const metric = registerMetric('pure pathForObjectId', 'automergePathForObjectId traversal', 'current');
  let cursor = 0;

  return () => {
    const startedAt = performance.now();

    for (let index = 0; index < SAMPLE_OPS; index += 1) {
      consumeValue(automergePathForObjectId(doc, valueAt(objectIds, cursor)));
      cursor += 1;
    }

    record(metric, performance.now() - startedAt, {
      objectsVisited: objectVisitCount * SAMPLE_OPS,
      objectLookups: SAMPLE_OPS
    });
  };
}

function adapterPathForObjectIdProbe(): () => void {
  const metric = registerMetric('cached pathForObjectId', 'adapter.pathForObjectId cached', 'current');
  let cursor = 0;

  consumeValue(adapter.pathForObjectId(valueAt(objectIds, cursor)));

  return () => {
    const startedAt = performance.now();

    for (let index = 0; index < SAMPLE_OPS; index += 1) {
      consumeValue(adapter.pathForObjectId(valueAt(objectIds, cursor)));
      cursor += 1;
    }

    record(metric, performance.now() - startedAt, {
      objectLookups: SAMPLE_OPS
    });
  };
}

function prebuiltPathProbe(): () => void {
  const metric = registerMetric('pure pathForObjectId', 'prebuilt objectId path', 'baseline');
  const cachedMetric = registerMetric('cached pathForObjectId', 'prebuilt objectId path', 'baseline');
  let cursor = 0;

  return () => {
    const startedAt = performance.now();

    for (let index = 0; index < SAMPLE_OPS; index += 1) {
      consumeValue(locationByObjectId.get(valueAt(objectIds, cursor))?.path ?? null);
      cursor += 1;
    }

    const elapsedMs = performance.now() - startedAt;

    record(metric, elapsedMs, {
      objectLookups: SAMPLE_OPS
    });
    record(cachedMetric, elapsedMs, {
      objectLookups: SAMPLE_OPS
    });
  };
}

function objectReferenceForProbe(): () => void {
  const metric = registerMetric('cached objectReferenceFor', 'adapter.objectReferenceFor labels cached', 'current');
  let cursor = 0;

  consumeValue(adapter.objectReferenceFor(schema.labels, valueAt(labelKeys, cursor)));

  return () => {
    const startedAt = performance.now();

    for (let index = 0; index < SAMPLE_OPS; index += 1) {
      consumeValue(adapter.objectReferenceFor(schema.labels, valueAt(labelKeys, cursor)));
      cursor += 1;
    }

    record(metric, performance.now() - startedAt, {
      rowsVisited: SAMPLE_OPS,
      objectLookups: SAMPLE_OPS
    });
  };
}

function prebuiltReferenceProbe(): () => void {
  const metric = registerMetric('cached objectReferenceFor', 'prebuilt label reference', 'baseline');
  const heads = Automerge.getHeads(doc);
  let cursor = 0;

  return () => {
    const startedAt = performance.now();

    for (let index = 0; index < SAMPLE_OPS; index += 1) {
      const key = valueAt(labelKeys, cursor);
      cursor += 1;
      const location = labelLocationByKey.get(key);
      consumeValue(location === undefined ? null : objectReferenceFromLocation(location, heads));
    }

    record(metric, performance.now() - startedAt, {
      rowsVisited: SAMPLE_OPS,
      objectLookups: SAMPLE_OPS
    });
  };
}

function runtimeObjectRowsProbe(): () => void {
  const metric = registerMetric('runtime objectLocations cached rows', 'adapter.source.rows cached', 'current');

  return () => {
    const startedAt = performance.now();
    let rowsReturned = 0;

    for (let index = 0; index < SAMPLE_OPS; index += 1) {
      const rows = adapter.source.rows(runtimeSystemRelations.objectLocations);
      rowsReturned += rows.length;
      consume(rows);
    }

    record(metric, performance.now() - startedAt, {
      rowsVisited: rowsReturned,
      rowsReturned,
      objectLookups: SAMPLE_OPS
    });
  };
}

function cachedRuntimeObjectRowsProbe(): () => void {
  const metric = registerMetric('runtime objectLocations cached rows', 'captured rows', 'baseline');

  return () => {
    const startedAt = performance.now();
    let rowsReturned = 0;

    for (let index = 0; index < SAMPLE_OPS; index += 1) {
      rowsReturned += cachedRuntimeLocationRows.length;
      consume(cachedRuntimeLocationRows);
    }

    record(metric, performance.now() - startedAt, {
      rowsVisited: rowsReturned,
      rowsReturned,
      objectLookups: SAMPLE_OPS
    });
  };
}

function makeDoc(): Automerge.Doc<WorkspaceDoc> {
  return Automerge.from({
    workspace: {
      tasks: Array.from({ length: ROW_COUNT }, (_, index) => ({
        id: `task-${index}`,
        title: `Task ${index}`,
        effort: (index * 31) % 7_500,
        done: index % 5 === 0,
        projectId: `project-${index % PROJECT_COUNT}`,
        meta: {
          rank: index,
          tags: [`tag-${index % 11}`, `tag-${index % 19}`],
          checklist: Array.from({ length: index % 3 }, (_, itemIndex) => ({
            id: `task-${index}-check-${itemIndex}`,
            done: (index + itemIndex) % 2 === 0
          }))
        }
      })),
      labelsById: Object.fromEntries(Array.from({ length: LABEL_COUNT }, (_, index) => [
        `label-${index}`,
        {
          id: `label-${index}`,
          name: `Label ${index}`,
          color: colorAt(index)
        }
      ])),
      boards: Array.from({ length: BOARD_COUNT }, (_, boardIndex) => ({
        id: `board-${boardIndex}`,
        columns: Array.from({ length: 5 }, (_, columnIndex) => ({
          id: `board-${boardIndex}-column-${columnIndex}`,
          cardIds: Array.from({ length: 12 }, (_, cardIndex) =>
            `task-${(boardIndex * 89 + columnIndex * 23 + cardIndex * 7) % ROW_COUNT}`)
        }))
      }))
    }
  });
}

function bucketTasksByProject(rows: readonly TaskRow[]): ReadonlyMap<string, readonly TaskRow[]> {
  const buckets = new Map<string, TaskRow[]>();

  for (const row of rows) {
    if (row.projectId === undefined) continue;
    const bucket = buckets.get(row.projectId);
    if (bucket === undefined) buckets.set(row.projectId, [row]);
    else bucket.push(row);
  }

  return buckets;
}

function lowerBound(rows: readonly TaskRow[], effort: number): number {
  let low = 0;
  let high = rows.length;

  while (low < high) {
    const mid = low + Math.floor((high - low) / 2);
    if ((rows[mid]?.effort ?? Number.NEGATIVE_INFINITY) < effort) low = mid + 1;
    else high = mid;
  }

  return low;
}

function binarySearchVisitCount(length: number): number {
  return Math.max(1, Math.ceil(Math.log2(Math.max(2, length))));
}

function objectReferenceFromLocation(
  location: AutomergeObjectLocation,
  heads: Automerge.Heads
): AutomergeObjectReference {
  return {
    objectId: location.objectId,
    path: location.path,
    heads,
    ...(location.relation === undefined ? {} : { relation: location.relation }),
    ...(location.key === undefined ? {} : { key: location.key })
  };
}

function registerMetric(group: string, probe: string, mode: ProbeMode): ProbeMetric {
  const metric: ProbeMetric = {
    group,
    probe,
    mode,
    samples: 0,
    elapsedMs: 0,
    rowsVisited: 0,
    rowsReturned: 0,
    objectsVisited: 0,
    objectLookups: 0
  };
  metrics.push(metric);
  return metric;
}

function record(
  metric: ProbeMetric,
  elapsedMs: number,
  counters: Partial<Pick<ProbeMetric, 'rowsVisited' | 'rowsReturned' | 'objectsVisited' | 'objectLookups'>>
): void {
  metric.samples += 1;
  metric.elapsedMs += elapsedMs;
  metric.rowsVisited += counters.rowsVisited ?? 0;
  metric.rowsReturned += counters.rowsReturned ?? 0;
  metric.objectsVisited += counters.objectsVisited ?? 0;
  metric.objectLookups += counters.objectLookups ?? 0;
}

function ratioRows(): readonly Record<string, string | number>[] {
  const rows: Record<string, string | number>[] = [];

  for (const current of metrics.filter((metric) => metric.mode === 'current')) {
    const baseline = metrics.find((candidate) =>
      candidate.group === current.group && candidate.mode === 'baseline');
    if (baseline === undefined) continue;

    rows.push({
      group: current.group,
      current: current.probe,
      baseline: baseline.probe,
      meanSampleRatio: ratio(mean(current.elapsedMs, current.samples), mean(baseline.elapsedMs, baseline.samples)),
      rowsVisitedPerSampleRatio: ratio(
        mean(current.rowsVisited, current.samples),
        mean(baseline.rowsVisited, baseline.samples)
      ),
      rowsVisitedPerReturnedRatio: ratio(
        mean(current.rowsVisited, current.rowsReturned),
        mean(baseline.rowsVisited, baseline.rowsReturned)
      ),
      objectsVisitedPerLookupRatio: ratio(
        mean(current.objectsVisited, current.objectLookups),
        mean(baseline.objectsVisited, baseline.objectLookups)
      )
    });
  }

  return rows;
}

function mean(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator;
}

function ratio(numerator: number, denominator: number): string {
  if (denominator === 0) return numerator === 0 ? '0.00x' : 'inf';
  return `${(numerator / denominator).toFixed(2)}x`;
}

function micros(elapsedMs: number, count: number): string {
  if (count === 0) return 'n/a';
  return `${((elapsedMs * 1_000) / count).toFixed(2)}us`;
}

function consume(rows: readonly unknown[]): void {
  sink = (sink + rows.length) % Number.MAX_SAFE_INTEGER;
  if (sink < 0) throw new Error('unreachable benchmark sink');
}

function consumeValue(value: unknown): void {
  sink = (sink + stableSize(value)) % Number.MAX_SAFE_INTEGER;
  if (sink < 0) throw new Error('unreachable benchmark sink');
}
