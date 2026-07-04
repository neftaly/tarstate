import * as Automerge from '@automerge/automerge';
import { describe, expect, it } from 'vitest';
import {
  as,
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
import { runtimeSystemRelations } from '@tarstate/core/adapter';
import type { RuntimeObjectLocationRow } from '@tarstate/core/adapter';
import { evaluate } from '@tarstate/core/evaluate';
import {
  defineSchema,
  idField,
  relation,
  stringField
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
import { mulberry32, randomInt } from './fuzz-helpers.js';

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
  };
};

type TrackedObject = {
  readonly relation: 'tasks' | 'labels';
  readonly key: string;
  readonly objectId: string;
};

type FuzzModel = {
  readonly tasks: Map<string, TaskRow>;
  readonly labels: Map<string, LabelRow>;
  readonly tracked: Map<string, TrackedObject>;
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

const seeds = [0x4f0b_1ec7, 0x95a5_221d, 0x2026_0703] as const;

describe('automerge object location fuzz', () => {
  it.each(seeds)('keeps object references queryable across seeded mutations %#', async (seed) => {
    const next = mulberry32(seed);
    const adapter = automergeMapAdapter({
      doc: initialDoc(seed),
      relations,
      runtimeId: `workspace-${seed.toString(16)}`
    });
    const model: FuzzModel = {
      tasks: new Map(taskRows(adapter).map((row) => [row.id, row])),
      labels: new Map(labelRows(adapter).map((row) => [row.id, row])),
      tracked: new Map()
    };

    captureTrackedObjects(adapter, model);
    assertObjectLocationInvariants(adapter, model, `seed ${seed} initial`);

    for (let step = 0; step < 48; step += 1) {
      const operation = randomInt(next, 8);

      if (operation === 0 || model.tasks.size === 0) {
        const row = { id: `task-${seed.toString(16)}-${step}`, title: `Task ${step}-${randomInt(next, 10)}` };
        const result = await adapter.target.apply([write(schema.tasks).insertOrReplace(row)]);
        expect(result.status, `seed ${seed} step ${step} insert task`).toBe('accepted');
        model.tasks.set(row.id, row);
      } else if (operation === 1) {
        const row = pickMapValue(model.tasks, next);
        const title = `${row.title} updated ${step}-${randomInt(next, 10)}`;
        const result = await adapter.target.apply([write(schema.tasks).updateByKey(row.id, { title })]);
        expect(result.status, `seed ${seed} step ${step} update task`).toBe('accepted');
        model.tasks.set(row.id, { ...row, title });
      } else if (operation === 2 && model.tasks.size > 1) {
        const row = pickMapValue(model.tasks, next);
        const result = await adapter.target.apply([write(schema.tasks).deleteByKey(row.id)]);
        expect(result.status, `seed ${seed} step ${step} delete task`).toBe('accepted');
        model.tasks.delete(row.id);
      } else if (operation === 3 || model.labels.size === 0) {
        const row = { id: `label-${seed.toString(16)}-${step}`, name: `Label ${step}-${randomInt(next, 10)}` };
        const result = await adapter.target.apply([write(schema.labels).insertOrReplace(row)]);
        expect(result.status, `seed ${seed} step ${step} insert label`).toBe('accepted');
        model.labels.set(row.id, row);
      } else if (operation === 4) {
        const row = pickMapValue(model.labels, next);
        const name = `${row.name} updated ${step}-${randomInt(next, 10)}`;
        const result = await adapter.target.apply([write(schema.labels).updateByKey(row.id, { name })]);
        expect(result.status, `seed ${seed} step ${step} update label`).toBe('accepted');
        model.labels.set(row.id, { ...row, name });
      } else if (operation === 5 && model.labels.size > 1) {
        const row = pickMapValue(model.labels, next);
        const result = await adapter.target.apply([write(schema.labels).deleteByKey(row.id)]);
        expect(result.status, `seed ${seed} step ${step} delete label`).toBe('accepted');
        model.labels.delete(row.id);
      } else if (operation === 6) {
        adapter.setDoc(Automerge.change(adapter.getDoc(), (draft) => {
          const tasks = draft.workspace.tasks as TaskRow[];
          tasks.unshift({ id: `task-${seed.toString(16)}-${step}-front`, title: `Front ${step}` });
        }));
        const row = adapter.getDoc().workspace.tasks[0];
        expect(row, `seed ${seed} step ${step} unshift row`).toBeDefined();
        if (row !== undefined) model.tasks.set(row.id, row);
      } else {
        let deletedId: string | undefined;
        adapter.setDoc(Automerge.change(adapter.getDoc(), (draft) => {
          const tasks = draft.workspace.tasks as TaskRow[];
          if (tasks.length > 1) {
            const [row] = tasks.splice(randomInt(next, tasks.length), 1);
            deletedId = row?.id;
          }
        }));
        if (deletedId !== undefined) model.tasks.delete(deletedId);
      }

      captureTrackedObjects(adapter, model);
      assertObjectLocationInvariants(adapter, model, `seed ${seed} step ${step}`);
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
      }
    }
  });
}

function captureTrackedObjects(adapter: AutomergeMapAdapter<WorkspaceDoc>, model: FuzzModel): void {
  for (const row of taskRows(adapter)) {
    const objectId = adapter.objectIdFor(schema.tasks, row.id);
    if (objectId !== null && !model.tracked.has(objectId)) {
      model.tracked.set(objectId, { relation: 'tasks', key: row.id, objectId });
    }
  }

  for (const row of labelRows(adapter)) {
    const objectId = adapter.objectIdFor(schema.labels, row.id);
    if (objectId !== null && !model.tracked.has(objectId)) {
      model.tracked.set(objectId, { relation: 'labels', key: row.id, objectId });
    }
  }
}

function assertObjectLocationInvariants(
  adapter: AutomergeMapAdapter<WorkspaceDoc>,
  model: FuzzModel,
  label: string
): void {
  const doc = adapter.getDoc();
  const tasks = taskRows(adapter);
  const labels = labelRows(adapter);

  expect(tasks, `${label} task rows`).toEqual(doc.workspace.tasks);
  expect(labels, `${label} label rows`).toEqual(Object.values(doc.workspace.labelsById));

  if (tasks.length > 0) {
    const firstTask = tasks[0];
    if (firstTask === undefined) throw new Error('expected first task');
    const firstObjectId = automergeObjectIdAt(doc, ['workspace', 'tasks', 0]);
    expect(firstObjectId, `${label} objectIdAt array index 0`).toBe(adapter.objectIdFor(schema.tasks, firstTask.id));
    expect(automergeObjectReferenceAt(doc, ['workspace', 'tasks', 0]), `${label} referenceAt array index 0`)
      .toMatchObject({ objectId: firstObjectId, path: ['workspace', 'tasks', 0] });
  }

  for (const task of tasks) {
    const objectId = adapter.objectIdFor(schema.tasks, task.id);
    const index = doc.workspace.tasks.findIndex((row) => row.id === task.id);
    expect(index, `${label} task index ${task.id}`).toBeGreaterThanOrEqual(0);
    expect(objectId, `${label} task object id ${task.id}`).toBe(automergeObjectIdAt(doc, ['workspace', 'tasks', index]));
    expect(adapter.objectReferenceFor(schema.tasks, task.id), `${label} task object reference ${task.id}`)
      .toMatchObject({ objectId, path: ['workspace', 'tasks', index], relation: 'tasks', key: task.id });
  }

  for (const labelRow of labels) {
    const objectId = adapter.objectIdFor(schema.labels, labelRow.id);
    expect(objectId, `${label} label object id ${labelRow.id}`)
      .toBe(automergeObjectIdAt(doc, ['workspace', 'labelsById', labelRow.id]));
    expect(adapter.objectReferenceFor(schema.labels, labelRow.id), `${label} label object reference ${labelRow.id}`)
      .toMatchObject({
        objectId,
        path: ['workspace', 'labelsById', labelRow.id],
        relation: 'labels',
        key: labelRow.id
      });
  }

  const locationRows = objectLocationRows(adapter);
  const runtimeLocation = as(runtimeSystemRelations.objectLocations, 'objectLocation');

  for (const tracked of model.tracked.values()) {
    const expectedPath = expectedTrackedPath(doc, tracked);
    const path = adapter.pathForObjectId(tracked.objectId);
    const locationRow = locationRows.find((row) => row.objectId === tracked.objectId);

    expect(path, `${label} adapter path for tracked ${tracked.objectId}`).toEqual(expectedPath);
    expect(automergePathForObjectId(doc, tracked.objectId), `${label} public path for tracked ${tracked.objectId}`)
      .toEqual(expectedPath);

    if (expectedPath === null) {
      expect(locationRow, `${label} deleted object omitted from runtime rows`).toBeUndefined();
      continue;
    }

    expect(locationRow, `${label} runtime row for ${tracked.objectId}`).toMatchObject({
      objectId: tracked.objectId,
      pathSegments: expectedPath,
      relation: tracked.relation,
      key: tracked.key
    });

    const presenceFocus = as(
      pipe(
        constRows([{ peer: `peer-${tracked.key}`, payload: { objectId: tracked.objectId } }]),
        qualify('presenceFocus')
      ),
      'presenceFocus'
    );
    const resolvedFocus = pipe(
      presenceFocus,
      join(
        from(runtimeLocation),
        eq(getKey<string>(presenceFocus.payload, value('objectId')), runtimeLocation.objectId)
      ),
      project({
        peer: presenceFocus.peer,
        objectId: runtimeLocation.objectId,
        path: runtimeLocation.pathSegments,
        relation: runtimeLocation.relation,
        key: runtimeLocation.key
      })
    );

    expect(evaluate(adapter.source, resolvedFocus).rows, `${label} presence-style objectId join`).toEqual([
      {
        peer: `peer-${tracked.key}`,
        objectId: tracked.objectId,
        path: expectedPath,
        relation: tracked.relation,
        key: tracked.key
      }
    ]);
  }
}

function expectedTrackedPath(doc: Automerge.Doc<WorkspaceDoc>, tracked: TrackedObject): readonly (string | number)[] | null {
  if (tracked.relation === 'tasks') {
    const index = doc.workspace.tasks.findIndex((row) => row.id === tracked.key);
    return index === -1 ? null : ['workspace', 'tasks', index];
  }

  return doc.workspace.labelsById[tracked.key] === undefined ? null : ['workspace', 'labelsById', tracked.key];
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

function pickMapValue<Value>(map: ReadonlyMap<string, Value>, next: () => number): Value {
  const values = Array.from(map.values());
  const valueAtIndex = values[randomInt(next, values.length)];
  if (valueAtIndex === undefined) throw new Error('expected non-empty map');
  return valueAtIndex;
}
