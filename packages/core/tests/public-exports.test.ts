import { describe, expect, it } from 'vitest';
import { req, type ConstraintData } from '@tarstate/core/constraints';
import { req as experimentalReq } from '@tarstate/core/experimental/constraints';
import { diffRows } from '@tarstate/core/diff';
import { diffRows as experimentalDiffRows } from '@tarstate/core/experimental/diff';
import { mat, materializationForQuery, type MaterializationMetadata } from '@tarstate/core/materialization';
import {
  mat as experimentalMat,
  materializationForQuery as experimentalMaterializationForQuery
} from '@tarstate/core/experimental/materialization';
import { trackTransact, type TrackTransactResult } from '@tarstate/core/runtime';
import { trackTransact as experimentalTrackTransact } from '@tarstate/core/experimental/runtime';
import { watch, type WatchEvent } from '@tarstate/core/watch';
import { watch as experimentalWatch } from '@tarstate/core/experimental/watch';
import {
  as,
  createDb,
  defineSchema,
  deleteRows,
  eq,
  from,
  idField,
  insert,
  pipe,
  project,
  relation,
  stringField,
  type Query
} from '@tarstate/core';

type Item = {
  readonly id: string;
  readonly label: string;
};

type ItemProjection = {
  readonly id: string;
  readonly label: string;
};

const schema = defineSchema({
  items: relation<Item>({
    key: 'id',
    fields: {
      id: idField('item'),
      label: stringField()
    }
  })
});

const item = schema.items;

describe('public Relic-shaped exports', () => {
  it('loads stable subpath APIs for constraints, materialization, runtime, watch, diff, and writes', async () => {
    const itemRow = as(item, 'item');
    const query = pipe(
      from(itemRow),
      project({
        id: itemRow.id,
        label: itemRow.label
      })
    ) satisfies Query<ItemProjection>;
    const db = mat(createDb({ items: [{ id: 'a', label: 'Alpha' }] }), query);
    const metadata = materializationForQuery(db, query) satisfies MaterializationMetadata<ItemProjection> | undefined;
    const watched = watch(db, query);
    const tracked = await trackTransact(watched, insert(item, { id: 'b', label: 'Beta' })) satisfies TrackTransactResult;
    const events: WatchEvent<ItemProjection>[] = [];
    const handle = watch(db, query, (event) => {
      events.push(event);
    });

    expect(req(item, 'label') satisfies ConstraintData).toMatchObject({ op: 'req' });
    expect(diffRows([{ id: 'a' }], [{ id: 'b' }]).changes).toHaveLength(2);
    expect(deleteRows(item, eq(itemRow.id, 'a'))).toMatchObject({ op: 'delete' });
    expect(metadata?.kind).toBe('materialization');
    expect(handle.kind).toBe('watch');
    expect(events).toHaveLength(0);
    expect(handle.unwatch()).toMatchObject({ kind: 'unwatch', closed: true });
    expect(tracked).toMatchObject({ kind: 'trackTransact' });
    expect(tracked.changes.at(0)).toMatchObject({ kind: 'trackedChange' });
  });

  it('keeps legacy experimental aliases loadable beside stable subpaths', async () => {
    const itemRow = as(item, 'item');
    const query = pipe(
      from(itemRow),
      project({
        id: itemRow.id,
        label: itemRow.label
      })
    ) satisfies Query<ItemProjection>;
    const db = experimentalMat(createDb({ items: [{ id: 'a', label: 'Alpha' }] }), query);
    const metadata = experimentalMaterializationForQuery(db, query) satisfies MaterializationMetadata<ItemProjection> | undefined;
    const watched = experimentalWatch(db, query);
    const tracked = await experimentalTrackTransact(watched, insert(item, { id: 'b', label: 'Beta' })) satisfies TrackTransactResult;

    expect(experimentalReq(item, 'label') satisfies ConstraintData).toMatchObject({ op: 'req' });
    expect(experimentalDiffRows([{ id: 'a' }], [{ id: 'b' }]).changes).toHaveLength(2);
    expect(metadata?.kind).toBe('materialization');
    expect(tracked.kind).toBe('trackTransact');
  });
});
