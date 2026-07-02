import { describe, expect, it } from 'vitest';
import {
  aggregate,
  and,
  as,
  booleanField,
  constrain,
  constRows,
  count,
  createDb,
  defineSchema,
  deleteByKey,
  deleteWhere,
  demat,
  eq,
  evaluate,
  field,
  from,
  fromObjectSource,
  gt,
  gte,
  insert,
  join,
  keyBy,
  leftJoin,
  lookup,
  mat,
  materializedRowsForQuery,
  maybe,
  numberField,
  pipe,
  project,
  qMany,
  qManyRows,
  qRows,
  queryKey,
  relation,
  sort,
  stringField,
  stripMeta,
  sum,
  trackTransact,
  tryTransact,
  unique,
  unwatch,
  updateByKey,
  updateWhere,
  value,
  watch,
  watchTargetKey,
  where,
  type Db,
  type DbData,
  type DbTransactionInput,
  type Query
} from '@tarstate/core';
import { diffRows } from '@tarstate/core/diff';
import { fromIndexedObjectSource } from '@tarstate/core/indexed-source';
import { diffQuery } from '@tarstate/core/watch';
import { coreSchema, sourceData } from './fixtures';

type ItemRow = {
  readonly id: string;
  readonly bucket: string;
  readonly value: number;
  readonly active: boolean;
};

const itemSchema = defineSchema({
  items: relation<ItemRow>({
    key: 'id',
    fields: {
      id: stringField(),
      bucket: stringField(),
      value: numberField(),
      active: booleanField()
    }
  })
});

const item = as(itemSchema.items, 'item');
const allItems = pipe(
  from(item),
  sort(item.id),
  project({
    id: item.id,
    bucket: item.bucket,
    value: item.value,
    active: item.active
  }),
  keyBy('id')
);
const visibleItems = pipe(
  from(item),
  where(eq(item.active, true)),
  sort(item.id),
  project({
    id: item.id,
    bucket: item.bucket,
    value: item.value
  }),
  keyBy('id')
);
const buckets = ['alpha', 'beta', 'gamma'] as const;

describe('deterministic core properties', () => {
  it('evaluates representative queries equivalently across DB, object source, indexed source, and batches', async () => {
    const state = createDb(sourceData);
    const queries = fixtureQueries();
    const entries = Object.entries(queries) as readonly (readonly [string, Query<unknown>])[];
    const individualRows: Record<string, readonly unknown[]> = {};

    for (const [name, query] of entries) {
      const dbRows = await qRows(state, query);
      const objectResult = await evaluate(fromObjectSource(sourceData), query);
      const indexedResult = await evaluate(fromIndexedObjectSource(sourceData), query);

      expect(objectResult.diagnostics).toEqual([]);
      expect(indexedResult.diagnostics).toEqual([]);
      expect(dbRows).toEqual(objectResult.rows);
      expect(dbRows).toEqual(indexedResult.rows);
      individualRows[name] = dbRows;
    }

    expect(await qManyRows(state, queries)).toEqual(individualRows);
    expect(rowsFromBatch(await qMany(state, queries))).toEqual(individualRows);

    const rebuilt = fixtureQueries();
    expect(queryKey(queries.activeAdults)).toBe(queryKey(rebuilt.activeAdults));
    expect(queryKey(queries.activeAdults.data)).toBe(queryKey(rebuilt.activeAdults.data));
    expect(queryKey(queries.usersByEngineering)).toBe(queryKey(rebuilt.usersByEngineering));
    expect(queryKey(queries.openTasks.data)).toBe(queryKey(rebuilt.openTasks.data));
    expect(queryKey(queries.taskSummary)).toBe(queryKey(rebuilt.taskSummary));
  });

  it('keeps generated write transactions deterministic, immutable, and all-or-nothing on rejection', async () => {
    for (const seed of [1, 7, 19]) {
      const rng = seeded(seed);
      const seen = new Set<Operation>();
      let model: readonly ItemRow[] = [
        { id: `${seed}-seed-a`, bucket: 'alpha', value: seed, active: true },
        { id: `${seed}-seed-b`, bucket: 'beta', value: seed + 1, active: false },
        { id: `${seed}-seed-c`, bucket: 'gamma', value: seed + 2, active: true }
      ];
      let state = createDb({ items: model });

      for (let step = 0; step < 20; step += 1) {
        const scheduled = operations[step % operations.length] ?? 'insert';
        const op: Operation = model.length === 0 ? 'insert' : scheduled;
        seen.add(op);

        switch (op) {
          case 'insert': {
            const row = randomItem(rng, `${seed}-${step}`);
            const nextModel = [...model, row];
            state = await commitAccepted(state, model, insert(itemSchema.items, row), nextModel);
            model = nextModel;
            break;
          }
          case 'updateByKey': {
            const target = pickExisting(model, rng);
            const changes = { value: target.value + 10 + rng.int(11), active: rng.bool() };
            const nextModel = model.map((row) => row.id === target.id ? { ...row, ...changes } : row);
            state = await commitAccepted(
              state,
              model,
              updateByKey(itemSchema.items, target.id, changes),
              nextModel
            );
            model = nextModel;
            break;
          }
          case 'updateWhere': {
            const targetBucket = pickExisting(model, rng).bucket;
            const changes = { value: rng.int(100), active: rng.bool() };
            const nextModel = model.map((row) => row.bucket === targetBucket ? { ...row, ...changes } : row);
            state = await commitAccepted(
              state,
              model,
              updateWhere(itemSchema.items, eq(item.bucket, value(targetBucket)), changes),
              nextModel
            );
            model = nextModel;
            break;
          }
          case 'deleteByKey': {
            const target = pickExisting(model, rng);
            const nextModel = model.filter((row) => row.id !== target.id);
            state = await commitAccepted(
              state,
              model,
              deleteByKey(itemSchema.items, target.id),
              nextModel
            );
            model = nextModel;
            break;
          }
          case 'deleteWhere': {
            const targetBucket = pickExisting(model, rng).bucket;
            const nextModel = model.filter((row) => row.bucket !== targetBucket);
            state = await commitAccepted(
              state,
              model,
              deleteWhere(itemSchema.items, eq(item.bucket, value(targetBucket))),
              nextModel
            );
            model = nextModel;
            break;
          }
        }
      }

      expect(seen).toEqual(new Set(operations));
      await expect(qRows(state, allItems)).resolves.toEqual(sortedItems(model));
    }

    const duplicateModel: readonly ItemRow[] = [
      { id: 'existing', bucket: 'alpha', value: 1, active: true }
    ];
    const duplicateBase = createDb({ items: duplicateModel });
    const duplicateResult = tryTransact(duplicateBase, [
      insert(itemSchema.items, { id: 'new-before-duplicate', bucket: 'beta', value: 2, active: true }),
      insert(itemSchema.items, { id: 'existing', bucket: 'gamma', value: 3, active: false })
    ]);

    expect(duplicateResult).toMatchObject({
      committed: false,
      db: duplicateBase,
      applied: 0,
      deltas: []
    });
    expect(duplicateResult.db).toBe(duplicateBase);
    await expect(qRows(duplicateResult.db, allItems)).resolves.toEqual(sortedItems(duplicateModel));

    const constrainedBase = mat(createDb({
      items: [
        { id: 'a', bucket: 'alpha', value: 1, active: true },
        { id: 'b', bucket: 'beta', value: 2, active: true }
      ]
    }), constrain(unique(itemSchema.items, 'bucket')));
    const constrainedBefore = cloneData(stripMeta(constrainedBase));
    const constrainedResult = tryTransact(
      constrainedBase,
      insert(itemSchema.items, { id: 'c', bucket: 'alpha', value: 3, active: false })
    );

    expect(constrainedResult).toMatchObject({
      committed: false,
      db: constrainedBase,
      applied: 0,
      deltas: [],
      diagnostics: [expect.objectContaining({ code: 'constraint_unique' })]
    });
    expect(constrainedResult.db).toBe(constrainedBase);
    expect(stripMeta(constrainedBase)).toEqual(constrainedBefore);
  });

  it('keeps materialized rows, watched changes, and explicit diffs in agreement', async () => {
    const beforeData: readonly ItemRow[] = [
      { id: 'a', bucket: 'alpha', value: 1, active: true },
      { id: 'b', bucket: 'beta', value: 2, active: true },
      { id: 'c', bucket: 'gamma', value: 3, active: true },
      { id: 'd', bucket: 'alpha', value: 4, active: false }
    ];
    const materialized = mat(createDb({ items: beforeData }), visibleItems, { id: 'visible-items' });
    const before = watch(materialized, visibleItems, itemSchema.items);
    const beforeRows = await qRows(before, visibleItems);
    const beforeRelationRows = await qRows(before, itemSchema.items);

    const tracked = await trackTransact(before, [
      insert(itemSchema.items, { id: 'e', bucket: 'beta', value: 5, active: true }),
      updateByKey(itemSchema.items, 'a', { value: 11 }),
      updateByKey(itemSchema.items, 'b', { active: false }),
      deleteByKey(itemSchema.items, 'd')
    ]);
    const next = tracked.db;
    const afterRows = await qRows(next, visibleItems);
    const evaluatedRows = (await evaluate(fromObjectSource(stripMeta(next)), visibleItems)).rows;
    const explicitDiff = diffRows(beforeRows, afterRows, { keyBy: ['id'] });
    const queryDiff = await diffQuery(before, next, visibleItems);
    const relationDiff = diffRows(beforeRelationRows, await qRows(next, itemSchema.items), { keyBy: ['id'] });
    const queryChanges = tracked.changes.filter((change) => change.targetKey === queryKey(visibleItems));
    const relationChange = tracked.changesByTargetKey.get(watchTargetKey(itemSchema.items));

    expect(tracked.result).toMatchObject({ committed: true, applied: 4 });
    expect(materializedRowsForQuery(next, visibleItems)).toEqual(afterRows);
    expect(afterRows).toEqual(evaluatedRows);
    expect(queryDiff.rowChanges).toEqual(explicitDiff.changes);
    expect(queryChanges).not.toHaveLength(0);
    expect(queryChanges.map((change) => change.rowChanges)).toContainEqual(explicitDiff.changes);
    expect(relationChange?.rowChanges).toEqual(relationDiff.changes);

    const dematerialized = demat(next, visibleItems);
    expect(materializedRowsForQuery(dematerialized, visibleItems)).toBeUndefined();
    await expect(qRows(dematerialized, visibleItems)).resolves.toEqual(afterRows);
  });

  it('carries materialized rows across metadata-only watch forks', () => {
    const state = mat(createDb({
      items: [
        { id: 'a', bucket: 'alpha', value: 1, active: true },
        { id: 'b', bucket: 'beta', value: 2, active: false }
      ]
    }), visibleItems, { id: 'visible-items' });
    const rows = materializedRowsForQuery(state, visibleItems);

    const watched = watch(state, visibleItems, itemSchema.items) as Db;
    expect(materializedRowsForQuery(watched, visibleItems)).toBe(rows);

    const unwatched = unwatch(watched, visibleItems, itemSchema.items) as Db;
    expect(materializedRowsForQuery(unwatched, visibleItems)).toBe(rows);
  });

  it('keeps Object.is equality semantics on optimized joins', async () => {
    const leftX = field<number>('left', 'x');
    const rightY = field<number>('right', 'y');
    const leftLabel = field<string>('left', 'leftLabel');
    const rightLabel = field<string>('right', 'rightLabel');
    const joined = pipe(
      constRows([
        { x: -0, leftLabel: 'negative-zero' },
        { x: Number.NaN, leftLabel: 'nan' }
      ]),
      join(constRows([
        { y: 0, rightLabel: 'zero' },
        { y: Number.NaN, rightLabel: 'nan' }
      ]), eq(leftX, rightY)),
      project({
        left: leftLabel,
        right: rightLabel
      })
    );

    await expect(qRows(createDb(), joined)).resolves.toEqual([
      { left: 'nan', right: 'nan' }
    ]);
  });
});

const operations = ['insert', 'updateByKey', 'updateWhere', 'deleteByKey', 'deleteWhere'] as const;
type Operation = (typeof operations)[number];

function fixtureQueries() {
  const user = as(coreSchema.users, 'user');
  const team = as(coreSchema.teams, 'team');
  const task = as(coreSchema.tasks, 'task');

  return {
    activeAdults: pipe(
      from(user),
      where(and(eq(user.active, true), gte(user.age, 30))),
      sort(user.id),
      project({ id: user.id, name: user.name, age: user.age, teamId: user.teamId }),
      keyBy('id')
    ),
    usersByEngineering: pipe(
      lookup(user, 'teamId', 'eng'),
      sort(user.id),
      project({ id: user.id, name: user.name, teamId: user.teamId }),
      keyBy('id')
    ),
    openTasks: pipe(
      from(task),
      where(eq(task.done, false)),
      join(from(user), eq(task.ownerId, user.id)),
      sort(task.id),
      project({
        id: task.id,
        owner: user.name,
        title: task.title,
        points: task.points
      }),
      keyBy('id')
    ),
    userTeamsLeft: pipe(
      from(user),
      leftJoin(from(team), eq(user.teamId, team.id)),
      sort(user.id),
      project({
        id: user.id,
        name: user.name,
        team: maybe(team.name)
      }),
      keyBy('id')
    ),
    residualTaskOwners: pipe(
      from(task),
      join(from(user), and(eq(task.ownerId, user.id), gt(task.points, value(4)))),
      sort(task.id),
      project({
        id: task.id,
        owner: user.name,
        points: task.points
      }),
      keyBy('id')
    ),
    taskSummary: pipe(
      from(task),
      where(gt(task.points, 0)),
      aggregate({
        groupBy: { ownerId: task.ownerId },
        aggregates: { tasks: count(), points: sum(task.points) }
      }),
      sort(task.ownerId)
    )
  };
}

function rowsFromBatch(batch: Record<string, { readonly rows: readonly unknown[] }>): Record<string, readonly unknown[]> {
  return Object.fromEntries(Object.entries(batch).map(([name, result]) => [name, result.rows]));
}

async function commitAccepted(
  state: Db,
  model: readonly ItemRow[],
  input: DbTransactionInput,
  nextModel: readonly ItemRow[]
): Promise<Db> {
  const oldRows = await qRows(state, allItems);
  const oldData = cloneData(stripMeta(state));
  const result = tryTransact(state, input);

  expect(result.committed).toBe(true);
  expect(oldRows).toEqual(sortedItems(model));
  await expect(qRows(state, allItems)).resolves.toEqual(oldRows);
  expect(stripMeta(state)).toEqual(oldData);
  await expect(qRows(result.db, allItems)).resolves.toEqual(sortedItems(nextModel));
  return result.db;
}

function seeded(seed: number) {
  let state = seed >>> 0;
  const next = () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state;
  };

  return {
    int(max: number): number {
      return next() % max;
    },
    bool(): boolean {
      return (next() & 1) === 1;
    }
  };
}

function randomItem(rng: ReturnType<typeof seeded>, suffix: string): ItemRow {
  return {
    id: `item-${suffix}`,
    bucket: buckets[rng.int(buckets.length)] ?? 'alpha',
    value: rng.int(50),
    active: rng.bool()
  };
}

function pickExisting(rows: readonly ItemRow[], rng: ReturnType<typeof seeded>): ItemRow {
  const row = rows[rng.int(rows.length)];
  if (row === undefined) {
    throw new Error('expected at least one item row');
  }
  return row;
}

function sortedItems(rows: readonly ItemRow[]): readonly ItemRow[] {
  return rows.map((row) => ({ ...row })).sort((left, right) => left.id.localeCompare(right.id));
}

function cloneData(data: DbData): Record<string, readonly unknown[]> {
  return Object.fromEntries(Object.entries(data).map(([name, rows]) => [
    name,
    rows.map((row) => isRecord(row) ? { ...row } : row)
  ]));
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === 'object' && input !== null && !Array.isArray(input);
}
