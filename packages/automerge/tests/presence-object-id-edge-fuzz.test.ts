import * as Automerge from '@automerge/automerge';
import { describe, expect, it } from 'vitest';
import {
  as,
  and,
  constRows,
  eq,
  from,
  getKey,
  join,
  pipe,
  project,
  qualify,
  value
} from '@tarstate/core';
import { runtimeSystemRelations, type RuntimeObjectLocationRow } from '@tarstate/core/adapter';
import { evaluate } from '@tarstate/core/evaluate';
import {
  defineSchema,
  idField,
  relation,
  stringField,
  type JsonValue
} from '@tarstate/core/schema';
import { write } from '@tarstate/core/write';
import {
  automergeMapAdapter,
  automergeObjectIdAt,
  automergeObjectReferenceAt,
  automergePathForObjectId,
  defineAutomergeMapRelations,
  type AutomergeMapAdapter
} from '@tarstate/automerge';

type TaskRow = {
  readonly id: string;
  readonly title: string;
};

type LabelRow = {
  readonly id: string;
  readonly name: string;
};

type WorkspaceDoc = {
  readonly workspace: {
    readonly tasks: readonly TaskRow[];
    readonly labelsById: Readonly<Record<string, LabelRow>>;
    readonly note: string;
  };
};

type PresencePayload = JsonValue | undefined;

type ResolvedPresenceLocation = {
  readonly peer: string;
  readonly objectId: string;
  readonly runtime: string;
  readonly path: readonly (string | number)[];
  readonly relation?: string;
  readonly key?: unknown;
};

const schema = defineSchema({
  tasks: relation<TaskRow>({
    key: 'id',
    fields: {
      id: idField('task'),
      title: stringField()
    }
  }),
  labels: relation<LabelRow>({
    key: 'id',
    fields: {
      id: idField('label'),
      name: stringField()
    }
  })
});

const defineWorkspaceRelations = defineAutomergeMapRelations<WorkspaceDoc>();
const relations = defineWorkspaceRelations([
  { relation: schema.tasks, path: ['workspace', 'tasks'] },
  { relation: schema.labels, path: ['workspace', 'labelsById'] }
]);

const seeds = [0xced1_2026, 0x0b1d_1df5, 0xa11c_a7ed] as const;

describe('presence object-id edge fuzz', () => {
  it.each(seeds)('rejects false object-id matches for malformed presence payloads %#', async (seed) => {
    const runtimeId = `runtime-${seed.toString(16)}`;
    const adapter = automergeMapAdapter({
      doc: initialDoc(seed),
      relations,
      runtimeId
    });
    const random = mulberry32(seed);

    assertScalarAndMissingPathHelpers(adapter, `seed ${seed} initial`);

    for (let step = 0; step < 32; step += 1) {
      const existingTask = pick(taskRows(adapter), random);
      const existingLabel = pick(labelRows(adapter), random);
      const taskObjectId = adapter.objectIdFor(schema.tasks, existingTask.id);
      const labelObjectId = adapter.objectIdFor(schema.labels, existingLabel.id);
      expect(taskObjectId, `seed ${seed} step ${step} task object id`).toEqual(expect.any(String));
      expect(labelObjectId, `seed ${seed} step ${step} label object id`).toEqual(expect.any(String));
      if (taskObjectId === null || labelObjectId === null) throw new Error('expected row object ids');

      const deletedTask = await deleteTrackedTask(adapter, random, seed, step);
      const currentTask = pick(taskRows(adapter), random);
      const currentLabel = pick(labelRows(adapter), random);
      const currentTaskObjectId = adapter.objectIdFor(schema.tasks, currentTask.id);
      const currentLabelObjectId = adapter.objectIdFor(schema.labels, currentLabel.id);
      expect(currentTaskObjectId, `seed ${seed} step ${step} current task object id`).toEqual(expect.any(String));
      expect(currentLabelObjectId, `seed ${seed} step ${step} current label object id`).toEqual(expect.any(String));
      if (currentTaskObjectId === null || currentLabelObjectId === null) {
        throw new Error('expected current row object ids');
      }

      assertDeletedObjectHelpers(adapter, deletedTask.objectId, `seed ${seed} step ${step}`);
      assertRelationKeyHelpers(adapter, currentTask, currentLabel, `seed ${seed} step ${step}`);

      const validPayload = objectPayload({
        objectId: currentTaskObjectId,
        runtime: runtimeId,
        relation: schema.tasks.name,
        key: currentTask.id,
        path: runtimeLocationPath(adapter, currentTaskObjectId)
      });
      const validLabelPayload = objectPayload({
        objectId: currentLabelObjectId,
        runtime: runtimeId,
        relation: schema.labels.name,
        key: currentLabel.id,
        path: runtimeLocationPath(adapter, currentLabelObjectId)
      });
      const edgePayloads: readonly [string, PresencePayload][] = [
        ['valid task reference', validPayload],
        ['valid label reference', validLabelPayload],
        ['stale deleted object id', objectPayload({
          objectId: deletedTask.objectId,
          runtime: runtimeId,
          relation: schema.tasks.name,
          key: deletedTask.id
        })],
        ['wrong runtime', objectPayload({
          objectId: currentTaskObjectId,
          runtime: `${runtimeId}-other`,
          relation: schema.tasks.name,
          key: currentTask.id
        })],
        ['wrong relation', objectPayload({
          objectId: currentTaskObjectId,
          runtime: runtimeId,
          relation: schema.labels.name,
          key: currentTask.id
        })],
        ['wrong key', objectPayload({
          objectId: currentTaskObjectId,
          runtime: runtimeId,
          relation: schema.tasks.name,
          key: currentLabel.id
        })],
        ['invalid object id string', objectPayload({
          objectId: `${seed.toString(16)}:${step}@stale-actor`,
          runtime: runtimeId,
          relation: schema.tasks.name,
          key: currentTask.id
        })],
        ['scalar-path null object id', objectPayload({
          objectId: automergeObjectIdAt(adapter.getDoc(), ['workspace', 'note']),
          runtime: runtimeId,
          relation: schema.tasks.name,
          key: currentTask.id
        })],
        ['undefined payload', undefined],
        ['null payload', null],
        ['scalar payload', `object:${currentTaskObjectId}`],
        ['array payload', [currentTaskObjectId, runtimeId]],
        ['object id wrong type', objectPayload({
          objectId: step,
          runtime: runtimeId,
          relation: schema.tasks.name,
          key: currentTask.id
        })],
        ['location path wrong type', objectPayload({
          objectId: currentTaskObjectId,
          runtime: runtimeId,
          relation: schema.tasks.name,
          key: currentTask.id,
          path: `workspace.tasks.${step}`
        })],
        ['malformed path segments', objectPayload({
          objectId: currentTaskObjectId,
          runtime: runtimeId,
          relation: schema.tasks.name,
          key: currentTask.id,
          path: ['workspace', { bad: step }]
        })],
        ['nested object id only', { focus: { objectId: currentTaskObjectId } }]
      ];

      const expectedByLabel = new Map<string, readonly ResolvedPresenceLocation[]>([
        ['valid task reference', [expectedLocation(adapter, currentTaskObjectId, 'peer-0-valid task reference')]],
        ['valid label reference', [expectedLocation(adapter, currentLabelObjectId, 'peer-1-valid label reference')]],
        ['location path wrong type', [expectedLocation(adapter, currentTaskObjectId, 'peer-13-location path wrong type')]],
        ['malformed path segments', [expectedLocation(adapter, currentTaskObjectId, 'peer-14-malformed path segments')]]
      ]);

      const strictRows = resolvePresencePayloads(adapter, edgePayloads);
      expect(strictRows, `seed ${seed} step ${step} strict object location join`)
        .toEqual(Array.from(expectedByLabel.values()).flat());
      assertResolvedRowsAreValid(adapter, strictRows, `seed ${seed} step ${step} strict rows`);

      const pathAwareRows = resolvePresencePayloadsByObjectIdAndPath(adapter, edgePayloads);
      expect(pathAwareRows, `seed ${seed} step ${step} path-aware object location join`).toEqual([
        expectedLocation(adapter, currentTaskObjectId, 'peer-0-valid task reference'),
        expectedLocation(adapter, currentLabelObjectId, 'peer-1-valid label reference')
      ]);
      assertResolvedRowsAreValid(adapter, pathAwareRows, `seed ${seed} step ${step} path-aware rows`);

      const idOnlyRows = resolvePresencePayloadsByObjectId(adapter, edgePayloads);
      assertResolvedRowsAreValid(adapter, idOnlyRows, `seed ${seed} step ${step} id-only rows`);
      expect(idOnlyRows.some((row) => row.objectId === deletedTask.objectId), `seed ${seed} step ${step} stale id`)
        .toBe(false);
      expect(idOnlyRows.some((row) => row.peer.includes('invalid object id')), `seed ${seed} step ${step} invalid id`)
        .toBe(false);
      expect(idOnlyRows.some((row) => row.peer.includes('scalar-path null object id')), `seed ${seed} step ${step} scalar id`)
        .toBe(false);

      await insertReplacementTask(adapter, seed, step);
      assertScalarAndMissingPathHelpers(adapter, `seed ${seed} step ${step} after replacement`);
    }
  });
});

function initialDoc(seed: number): Automerge.Doc<WorkspaceDoc> {
  return Automerge.from({
    workspace: {
      tasks: [
        { id: `task-${seed.toString(16)}-0`, title: 'Zero' },
        { id: `task-${seed.toString(16)}-1`, title: 'One' },
        { id: `task-${seed.toString(16)}-2`, title: 'Two' }
      ],
      labelsById: {
        [`label-${seed.toString(16)}-0`]: { id: `label-${seed.toString(16)}-0`, name: 'First' },
        [`label-${seed.toString(16)}-1`]: { id: `label-${seed.toString(16)}-1`, name: 'Second' }
      },
      note: `scalar-${seed.toString(16)}`
    }
  });
}

async function deleteTrackedTask(
  adapter: AutomergeMapAdapter<WorkspaceDoc>,
  random: () => number,
  seed: number,
  step: number
): Promise<{ readonly id: string; readonly objectId: string }> {
  const tasks = taskRows(adapter);
  expect(tasks.length, `seed ${seed} step ${step} task count before delete`).toBeGreaterThan(1);
  const task = pick(tasks, random);
  const objectId = adapter.objectIdFor(schema.tasks, task.id);
  expect(objectId, `seed ${seed} step ${step} deleted object id`).toEqual(expect.any(String));
  if (objectId === null) throw new Error('expected object id before delete');

  const result = await adapter.target.apply([write(schema.tasks).deleteByKey(task.id)]);
  expect(result.status, `seed ${seed} step ${step} delete status`).toBe('accepted');
  expect(result.applied, `seed ${seed} step ${step} delete applied`).toBe(1);
  return { id: task.id, objectId };
}

async function insertReplacementTask(
  adapter: AutomergeMapAdapter<WorkspaceDoc>,
  seed: number,
  step: number
): Promise<void> {
  const row = {
    id: `task-${seed.toString(16)}-replacement-${step}`,
    title: `Replacement ${step}`
  };
  const result = await adapter.target.apply([write(schema.tasks).insertOrReplace(row)]);
  expect(result.status, `seed ${seed} step ${step} replacement status`).toBe('accepted');
  expect(result.applied, `seed ${seed} step ${step} replacement applied`).toBe(1);
}

function assertDeletedObjectHelpers(
  adapter: AutomergeMapAdapter<WorkspaceDoc>,
  objectId: string,
  label: string
): void {
  expect(adapter.pathForObjectId(objectId), `${label} adapter stale path`).toBeNull();
  expect(automergePathForObjectId(adapter.getDoc(), objectId), `${label} public stale path`).toBeNull();
  expect(objectLocationRows(adapter).some((row) => row.objectId === objectId), `${label} stale runtime row`)
    .toBe(false);
}

function assertRelationKeyHelpers(
  adapter: AutomergeMapAdapter<WorkspaceDoc>,
  task: TaskRow,
  labelRow: LabelRow,
  label: string
): void {
  expect(adapter.objectIdFor(schema.tasks, task.id), `${label} task object id`).toEqual(expect.any(String));
  expect(adapter.objectReferenceFor(schema.tasks, task.id), `${label} task reference`)
    .toEqual(expect.objectContaining({ relation: schema.tasks.name, key: task.id }));
  expect(adapter.objectIdFor(schema.labels, labelRow.id), `${label} label object id`).toEqual(expect.any(String));
  expect(adapter.objectReferenceFor(schema.labels, labelRow.id), `${label} label reference`)
    .toEqual(expect.objectContaining({ relation: schema.labels.name, key: labelRow.id }));
  expect(adapter.objectIdFor(schema.tasks, labelRow.id), `${label} wrong relation/key object id`).toBeNull();
  expect(adapter.objectReferenceFor(schema.tasks, labelRow.id), `${label} wrong relation/key reference`).toBeNull();
  expect(adapter.objectIdFor(schema.labels, task.id), `${label} inverse wrong relation/key object id`).toBeNull();
  expect(adapter.objectReferenceFor(schema.labels, task.id), `${label} inverse wrong relation/key reference`).toBeNull();
}

function assertScalarAndMissingPathHelpers(adapter: AutomergeMapAdapter<WorkspaceDoc>, label: string): void {
  const doc = adapter.getDoc();
  expect(automergeObjectIdAt(doc, ['workspace', 'note']), `${label} scalar object id`).toBeNull();
  expect(automergeObjectReferenceAt(doc, ['workspace', 'note']), `${label} scalar reference`).toBeNull();
  expect(automergeObjectIdAt(doc, ['workspace', 'missing']), `${label} missing object id`).toBeNull();
  expect(automergeObjectReferenceAt(doc, ['workspace', 'missing']), `${label} missing reference`).toBeNull();
  expect(automergeObjectIdAt(doc, ['workspace', 'tasks', 1000]), `${label} missing array object id`).toBeNull();
  expect(automergeObjectReferenceAt(doc, ['workspace', 'tasks', 1000]), `${label} missing array reference`).toBeNull();
}

function resolvePresencePayloads(
  adapter: AutomergeMapAdapter<WorkspaceDoc>,
  payloads: readonly [string, PresencePayload][]
): readonly ResolvedPresenceLocation[] {
  const objectLocation = as(runtimeSystemRelations.objectLocations, 'objectLocation');
  const presenceFocus = as(
    pipe(
      constRows(payloads.map(([label, payload], index) => ({
        peer: `peer-${index}-${label}`,
        payload
      }))),
      qualify('presenceFocus')
    ),
    'presenceFocus'
  );
  const query = pipe(
    presenceFocus,
    join(
      from(objectLocation),
      and(
        eq(getKey<string>(presenceFocus.payload, value('objectId')), objectLocation.objectId),
        eq(getKey<string>(presenceFocus.payload, value('runtime')), objectLocation.runtime),
        eq(getKey<string>(presenceFocus.payload, value('relation')), objectLocation.relation),
        eq(getKey<unknown>(presenceFocus.payload, value('key')), objectLocation.key)
      )
    ),
    project({
      peer: presenceFocus.peer,
      objectId: objectLocation.objectId,
      runtime: objectLocation.runtime,
      path: objectLocation.pathSegments,
      relation: objectLocation.relation,
      key: objectLocation.key
    })
  );

  return sortedResolvedRows(evaluate(adapter.source, query).rows);
}

function resolvePresencePayloadsByObjectIdAndPath(
  adapter: AutomergeMapAdapter<WorkspaceDoc>,
  payloads: readonly [string, PresencePayload][]
): readonly ResolvedPresenceLocation[] {
  const objectLocation = as(runtimeSystemRelations.objectLocations, 'objectLocationByPath');
  const presenceFocus = as(
    pipe(
      constRows(payloads.map(([label, payload], index) => ({
        peer: `peer-${index}-${label}`,
        payload
      }))),
      qualify('presenceFocusByPath')
    ),
    'presenceFocusByPath'
  );
  const query = pipe(
    presenceFocus,
    join(
      from(objectLocation),
      and(
        eq(getKey<string>(presenceFocus.payload, value('objectId')), objectLocation.objectId),
        eq(getKey<string>(presenceFocus.payload, value('runtime')), objectLocation.runtime),
        eq(getKey<string>(presenceFocus.payload, value('path')), objectLocation.path)
      )
    ),
    project({
      peer: presenceFocus.peer,
      objectId: objectLocation.objectId,
      runtime: objectLocation.runtime,
      path: objectLocation.pathSegments,
      relation: objectLocation.relation,
      key: objectLocation.key
    })
  );

  return sortedResolvedRows(evaluate(adapter.source, query).rows);
}

function resolvePresencePayloadsByObjectId(
  adapter: AutomergeMapAdapter<WorkspaceDoc>,
  payloads: readonly [string, PresencePayload][]
): readonly ResolvedPresenceLocation[] {
  const objectLocation = as(runtimeSystemRelations.objectLocations, 'objectLocationById');
  const presenceFocus = as(
    pipe(
      constRows(payloads.map(([label, payload], index) => ({
        peer: `peer-${index}-${label}`,
        payload
      }))),
      qualify('presenceFocusById')
    ),
    'presenceFocusById'
  );
  const query = pipe(
    presenceFocus,
    join(
      from(objectLocation),
      eq(getKey<string>(presenceFocus.payload, value('objectId')), objectLocation.objectId)
    ),
    project({
      peer: presenceFocus.peer,
      objectId: objectLocation.objectId,
      runtime: objectLocation.runtime,
      path: objectLocation.pathSegments,
      relation: objectLocation.relation,
      key: objectLocation.key
    })
  );

  return sortedResolvedRows(evaluate(adapter.source, query).rows);
}

function assertResolvedRowsAreValid(
  adapter: AutomergeMapAdapter<WorkspaceDoc>,
  rows: readonly ResolvedPresenceLocation[],
  label: string
): void {
  const locations = objectLocationRows(adapter);
  for (const row of rows) {
    const location = locations.find((candidate) =>
      candidate.objectId === row.objectId
      && candidate.runtime === row.runtime
      && jsonEqual(candidate.pathSegments, row.path)
      && candidate.relation === row.relation
      && jsonEqual(candidate.key, row.key)
    );
    expect(location, `${label} valid joined row ${JSON.stringify(row)}`).toBeDefined();
  }
}

function expectedLocation(
  adapter: AutomergeMapAdapter<WorkspaceDoc>,
  objectId: string,
  peer: string
): ResolvedPresenceLocation {
  const location = objectLocationRows(adapter).find((row) => row.objectId === objectId);
  expect(location, `expected runtime location ${objectId}`).toBeDefined();
  if (location === undefined) throw new Error(`missing location for ${objectId}`);
  return {
    peer,
    objectId: location.objectId,
    runtime: location.runtime,
    path: location.pathSegments,
    ...(location.relation === undefined ? {} : { relation: location.relation }),
    ...(location.key === undefined ? {} : { key: location.key })
  };
}

function runtimeLocationPath(adapter: AutomergeMapAdapter<WorkspaceDoc>, objectId: string): string {
  const location = objectLocationRows(adapter).find((row) => row.objectId === objectId);
  expect(location, `expected runtime path ${objectId}`).toBeDefined();
  if (location === undefined) throw new Error(`missing location for ${objectId}`);
  return location.path;
}

function objectPayload(value: Record<string, unknown>): PresencePayload {
  return value as PresencePayload;
}

function taskRows(adapter: AutomergeMapAdapter<WorkspaceDoc>): readonly TaskRow[] {
  return adapter.source.rows(schema.tasks) as readonly TaskRow[];
}

function labelRows(adapter: AutomergeMapAdapter<WorkspaceDoc>): readonly LabelRow[] {
  return adapter.source.rows(schema.labels) as readonly LabelRow[];
}

function objectLocationRows(adapter: AutomergeMapAdapter<WorkspaceDoc>): readonly RuntimeObjectLocationRow[] {
  return adapter.source.rows(runtimeSystemRelations.objectLocations) as readonly RuntimeObjectLocationRow[];
}

function sortedResolvedRows(rows: readonly unknown[]): readonly ResolvedPresenceLocation[] {
  return rows
    .map((row) => row as ResolvedPresenceLocation)
    .sort((left, right) => `${left.peer}:${left.objectId}`.localeCompare(`${right.peer}:${right.objectId}`));
}

function pick<T>(values: readonly T[], random: () => number): T {
  const valueAtIndex = values[Math.floor(random() * values.length)];
  if (valueAtIndex === undefined) throw new Error('expected non-empty values');
  return valueAtIndex;
}

function jsonEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;

  return () => {
    state += 0x6d2b_79f5;
    let mixed = state;
    mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4_294_967_296;
  };
}
