import { describe, expect, it } from 'vitest';
import {
  aggregate,
  any,
  as,
  asc,
  avg,
  bottom,
  bottomBy,
  call,
  constRows,
  count,
  countDistinct,
  dependencies,
  desc,
  difference,
  eq,
  env,
  extend,
  expand,
  field,
  from,
  gt,
  gte,
  btree,
  hash,
  intersection,
  join,
  keyBy,
  leftJoin,
  limit,
  lookup,
  lt,
  lte,
  max,
  maybe,
  min,
  notAny,
  neq,
  pipe,
  project,
  qualify,
  queryKey,
  queryRowKeyFields,
  rename,
  relationDependencies,
  select,
  sel,
  sel1,
  setConcat,
  sort,
  sortLimit,
  sum,
  top,
  topBy,
  tuple,
  union,
  value,
  where,
  without
} from '@tarstate/core/query';
import {
  anchoredPathField,
  defineSchema,
  idField,
  optional,
  refField,
  relation,
  stringField
} from '@tarstate/core/schema';

const schema = defineSchema({
  objects: relation<{
    id: string;
    kind: string;
    title: string;
  }>({
    key: 'id',
    fields: {
      id: idField('object'),
      kind: stringField(),
      title: stringField()
    }
  }),
  presence: relation<{
    workspaceId: string;
    peerId: string;
    clientId: string;
    targetObjectId?: string;
    focusPath?: readonly unknown[];
  }>({
    ephemeral: true,
    key: ['workspaceId', 'peerId', 'clientId'],
    fields: {
      workspaceId: idField('workspace'),
      peerId: idField('peer'),
      clientId: stringField(),
      targetObjectId: optional(refField('objects.id')),
      focusPath: optional(anchoredPathField())
    }
  })
});

const object = as(schema.objects, 'object');
const presence = as(schema.presence, 'presence');

describe('tarstate query DSL', () => {
  it('lowers field refs, joins, and projections to inspectable canonical data', () => {
    const focusedObjects = pipe(
      from(object),
      leftJoin(from(presence), eq(object.id, presence.targetObjectId)),
      project({
        id: object.id,
        title: object.title,
        focusedBy: maybe(presence.peerId)
      })
    );

    const keyedJoined = keyBy('object', 'presence')(
      join(from(presence), eq(object.id, presence.targetObjectId))(from(object))
    );
    expect(keyedJoined.data).toMatchObject({ op: 'keyBy', fields: ['object', 'presence'] });

    expect(focusedObjects.data).toEqual({
      op: 'select',
      input: {
        op: 'join',
        kind: 'left',
        left: { op: 'from', relation: 'objects', alias: 'object' },
        right: { op: 'from', relation: 'presence', alias: 'presence' },
        on: {
          op: 'eq',
          left: { op: 'field', alias: 'object', field: 'id' },
          right: { op: 'field', alias: 'presence', field: 'targetObjectId' }
        }
      },
      projection: {
        id: { op: 'field', alias: 'object', field: 'id' },
        title: { op: 'field', alias: 'object', field: 'title' },
        focusedBy: {
          kind: 'optionalProjection',
          expr: { op: 'field', alias: 'presence', field: 'peerId' }
        }
      }
    });
  });

  it('supports variadic functional pipe without chaining', () => {
    const filesByKind = pipe(
      from(object),
      where(eq(object.kind, 'file')),
      project({ id: object.id, title: object.title })
    );

    expect(filesByKind.data).toEqual({
      op: 'select',
      input: {
        op: 'where',
        input: { op: 'from', relation: 'objects', alias: 'object' },
        predicate: {
          op: 'eq',
          left: { op: 'field', alias: 'object', field: 'kind' },
          right: { op: 'value', value: 'file' }
        }
      },
      projection: {
        id: { op: 'field', alias: 'object', field: 'id' },
        title: { op: 'field', alias: 'object', field: 'title' }
      }
    });
  });

  it('builds explicit lookup query nodes', () => {
    expect(lookup(object, 'id', 'object-a').data).toEqual({
      op: 'lookup',
      relation: 'objects',
      alias: 'object',
      field: 'id',
      value: { op: 'value', value: 'object-a' }
    });
  });

  it('builds index declaration nodes without changing query row shape', () => {
    const indexed = pipe(
      from(object),
      hash(object.kind),
      btree(object.title)
    );

    expect(indexed.data).toEqual({
      op: 'btree',
      expressions: [{ op: 'field', alias: 'object', field: 'title' }],
      input: {
        op: 'hash',
        expressions: [{ op: 'field', alias: 'object', field: 'kind' }],
        input: { op: 'from', relation: 'objects', alias: 'object' }
      }
    });
  });


  it('builds stable structural query keys', () => {
    const first = constRows([{ b: 2, a: 1, missing: undefined }]);
    const second = constRows([{ missing: undefined, a: 1, b: 2 }]);

    expect(queryKey(first)).toBe(queryKey(first.data));
    expect(queryKey(first)).toBe(queryKey(second));
    expect(queryKey(first)).toBe(
      'query:{"op":"constRows","rows":[{"a":1,"b":2,"missing":{"$tarstate":"undefined"}}]}'
    );
  });

  it('lowers query-owned row identity metadata without changing row shape', () => {
    const keyedObjects = pipe(
      from(object),
      project({
        id: object.id,
        title: object.title
      }),
      keyBy('id')
    );

    expect(keyedObjects.data).toEqual({
      op: 'keyBy',
      fields: ['id'],
      input: {
        op: 'select',
        input: { op: 'from', relation: 'objects', alias: 'object' },
        projection: {
          id: { op: 'field', alias: 'object', field: 'id' },
          title: { op: 'field', alias: 'object', field: 'title' }
        }
      }
    });
    expect(queryRowKeyFields(keyedObjects)).toEqual(['id']);
    expect(queryRowKeyFields(keyedObjects.data)).toEqual(['id']);
  });

  it('carries query-owned row identity only through compatible final row shapes', () => {
    const keyedObjects = pipe(
      from(object),
      project({
        id: object.id,
        title: object.title
      }),
      keyBy('id')
    );

    expect(queryRowKeyFields(pipe(
      keyedObjects,
      where(eq(value(true), true)),
      sort(value(1)),
      limit(10)
    ))).toEqual(['id']);
    expect(queryRowKeyFields(pipe(keyedObjects, project({ title: value('Title') })))).toBeUndefined();
    expect(queryRowKeyFields(pipe(keyedObjects, without('id')))).toBeUndefined();
    expect(queryRowKeyFields(pipe(keyedObjects, rename({ id: 'objectId' })))).toEqual(['objectId']);
    expect(queryRowKeyFields(pipe(keyedObjects, qualify('object')))).toBeUndefined();
  });

  it('builds comparison and expression constructor data for Relic alignment', () => {
    const rank = field<number>('object', 'rank');

    expect([
      neq(object.kind, 'folder'),
      lt(rank, 10),
      lte(rank, 10),
      gt(rank, 0),
      gte(rank, 0)
    ]).toEqual([
      {
        op: 'neq',
        left: { op: 'field', alias: 'object', field: 'kind' },
        right: { op: 'value', value: 'folder' }
      },
      {
        op: 'lt',
        left: { op: 'field', alias: 'object', field: 'rank' },
        right: { op: 'value', value: 10 }
      },
      {
        op: 'lte',
        left: { op: 'field', alias: 'object', field: 'rank' },
        right: { op: 'value', value: 10 }
      },
      {
        op: 'gt',
        left: { op: 'field', alias: 'object', field: 'rank' },
        right: { op: 'value', value: 0 }
      },
      {
        op: 'gte',
        left: { op: 'field', alias: 'object', field: 'rank' },
        right: { op: 'value', value: 0 }
      }
    ]);
    expect(call('coalesce', object.title, 'Untitled')).toEqual({
      op: 'call',
      name: 'coalesce',
      args: [
        { op: 'field', alias: 'object', field: 'title' },
        { op: 'value', value: 'Untitled' }
      ]
    });
    expect(env<string>('workspaceId')).toEqual({
      op: 'env',
      name: 'workspaceId'
    });
    expect(tuple(object.id, value('stable'))).toEqual({
      op: 'tuple',
      items: [
        { op: 'field', alias: 'object', field: 'id' },
        { op: 'value', value: 'stable' }
      ]
    });
  });

  it('builds Relic-aligned query transform nodes', () => {
    const ranked = pipe(
      from(object),
      extend({
        searchableTitle: call('lower', object.title)
      }),
      sort(asc(object.title), desc(object.id, 'last')),
      limit(10, 5),
      sortLimit(3, desc(object.title)),
      select({
        id: object.id,
        title: object.title
      }),
      without('title'),
      rename({ id: 'objectId' }),
      qualify('result')
    );

    expect(ranked.data).toEqual({
      op: 'qualify',
      alias: 'result',
      input: {
        op: 'rename',
        fields: { id: 'objectId' },
        input: {
          op: 'without',
          fields: ['title'],
          input: {
            op: 'select',
            input: {
              op: 'sortLimit',
              count: 3,
              order: [
                {
                  expr: { op: 'field', alias: 'object', field: 'title' },
                  direction: 'desc'
                }
              ],
              input: {
                op: 'limit',
                count: 10,
                offset: 5,
                input: {
                  op: 'sort',
                  order: [
                    {
                      expr: { op: 'field', alias: 'object', field: 'title' },
                      direction: 'asc'
                    },
                    {
                      expr: { op: 'field', alias: 'object', field: 'id' },
                      direction: 'desc',
                      nulls: 'last'
                    }
                  ],
                  input: {
                    op: 'extend',
                    projection: {
                      searchableTitle: {
                        op: 'call',
                        name: 'lower',
                        args: [{ op: 'field', alias: 'object', field: 'title' }]
                      }
                    },
                    input: { op: 'from', relation: 'objects', alias: 'object' }
                  }
                }
              }
            },
            projection: {
              id: { op: 'field', alias: 'object', field: 'id' },
              title: { op: 'field', alias: 'object', field: 'title' }
            }
          }
        }
      }
    });
  });

  it('reports relation dependencies from query data', () => {
    const focusedObjects = pipe(
      from(object),
      leftJoin(from(presence), eq(object.id, presence.targetObjectId)),
      project({
        id: object.id,
        focusedBy: maybe(presence.peerId)
      })
    );

    expect(relationDependencies(focusedObjects)).toEqual(['objects', 'presence']);
    expect(dependencies(focusedObjects)).toEqual(['objects', 'presence']);
    expect(dependencies(focusedObjects.data)).toEqual(['objects', 'presence']);
    expect(dependencies(constRows([{ id: 'object-a' }]))).toEqual([]);
  });

  it('builds literal rows, set operations, and aggregate nodes', () => {
    const left = constRows([{ id: 'object-a', rank: 1 }]);
    const right = constRows([{ id: 'object-b', rank: 2 }]);
    const rank = field<number>('object', 'rank');
    const grouped = pipe(
      from(object),
      aggregate({
        groupBy: { kind: object.kind },
        aggregates: {
          total: count(),
          distinctTitles: countDistinct(object.title),
          rankSum: sum(rank),
          averageRank: avg(rank),
          firstTitle: min(object.title),
          lastTitle: max(object.title),
          anyTitle: any(object.title),
          noTitle: notAny(object.title),
          titles: setConcat(object.title),
          topRanks: top(2, rank),
          bottomRanks: bottom(2, rank),
          topRows: topBy(2, rank),
          bottomRows: bottomBy(2, rank)
        }
      })
    );

    expect(left.data).toEqual({
      op: 'constRows',
      rows: [{ id: 'object-a', rank: 1 }]
    });
    expect(union(left, right).data).toEqual({
      op: 'union',
      inputs: [left.data, right.data]
    });
    expect(pipe(left, intersection(right)).data).toEqual({
      op: 'intersection',
      inputs: [left.data, right.data]
    });
    expect(pipe(left, difference(right)).data).toEqual({
      op: 'difference',
      left: left.data,
      right: right.data
    });
    expect(grouped.data).toEqual({
      op: 'aggregate',
      input: { op: 'from', relation: 'objects', alias: 'object' },
      groupBy: {
        kind: { op: 'field', alias: 'object', field: 'kind' }
      },
      aggregates: {
        total: { op: 'aggregateCall', name: 'count', distinct: false },
        distinctTitles: {
          op: 'aggregateCall',
          name: 'count',
          expr: { op: 'field', alias: 'object', field: 'title' },
          distinct: true
        },
        rankSum: {
          op: 'aggregateCall',
          name: 'sum',
          expr: { op: 'field', alias: 'object', field: 'rank' },
          distinct: false
        },
        averageRank: {
          op: 'aggregateCall',
          name: 'avg',
          expr: { op: 'field', alias: 'object', field: 'rank' },
          distinct: false
        },
        firstTitle: {
          op: 'aggregateCall',
          name: 'min',
          expr: { op: 'field', alias: 'object', field: 'title' },
          distinct: false
        },
        lastTitle: {
          op: 'aggregateCall',
          name: 'max',
          expr: { op: 'field', alias: 'object', field: 'title' },
          distinct: false
        },
        anyTitle: {
          op: 'aggregateCall',
          name: 'any',
          expr: { op: 'field', alias: 'object', field: 'title' },
          distinct: false
        },
        noTitle: {
          op: 'aggregateCall',
          name: 'notAny',
          expr: { op: 'field', alias: 'object', field: 'title' },
          distinct: false
        },
        titles: {
          op: 'aggregateCall',
          name: 'setConcat',
          expr: { op: 'field', alias: 'object', field: 'title' },
          distinct: false
        },
        topRanks: {
          op: 'aggregateCall',
          name: 'top',
          expr: { op: 'field', alias: 'object', field: 'rank' },
          distinct: false,
          count: 2
        },
        bottomRanks: {
          op: 'aggregateCall',
          name: 'bottom',
          expr: { op: 'field', alias: 'object', field: 'rank' },
          distinct: false,
          count: 2
        },
        topRows: {
          op: 'aggregateCall',
          name: 'topBy',
          expr: { op: 'field', alias: 'object', field: 'rank' },
          distinct: false,
          count: 2
        },
        bottomRows: {
          op: 'aggregateCall',
          name: 'bottomBy',
          expr: { op: 'field', alias: 'object', field: 'rank' },
          distinct: false,
          count: 2
        }
      }
    });
  });

  it('builds and validates Relic-style aggregate helper options', () => {
    const rank = field<number>('object', 'rank');

    expect(top(0, rank, { distinct: true })).toEqual({
      op: 'aggregateCall',
      name: 'top',
      expr: { op: 'field', alias: 'object', field: 'rank' },
      distinct: true,
      count: 0
    });
    expect(bottom(3, rank, { distinct: true })).toEqual({
      op: 'aggregateCall',
      name: 'bottom',
      expr: { op: 'field', alias: 'object', field: 'rank' },
      distinct: true,
      count: 3
    });
    expect(topBy(1, rank, { distinct: true })).toEqual({
      op: 'aggregateCall',
      name: 'topBy',
      expr: { op: 'field', alias: 'object', field: 'rank' },
      distinct: true,
      count: 1
    });
    expect(bottomBy(1, rank, { distinct: true })).toEqual({
      op: 'aggregateCall',
      name: 'bottomBy',
      expr: { op: 'field', alias: 'object', field: 'rank' },
      distinct: true,
      count: 1
    });

    expect(() => top(-1, rank)).toThrow(RangeError);
    expect(() => bottom(1.5, rank)).toThrow(RangeError);
    expect(() => topBy(Number.NaN, rank)).toThrow(RangeError);
    expect(() => bottomBy(Number.POSITIVE_INFINITY, rank)).toThrow(RangeError);
  });

  it('builds expand nodes for flattening nested row collections', () => {
    const items = field<readonly { readonly product: string; readonly quantity: number }[]>('', 'items');
    const expanded = pipe(
      constRows([{ customerId: 42, items: [{ product: 'sku-a', quantity: 2 }] }]),
      expand(items, { fields: ['product', 'quantity'] as const }),
      without('items')
    );
    const aliased = pipe(
      constRows([{ customerId: 42, items: [{ product: 'sku-a', quantity: 2 }] }]),
      expand(items, { as: 'item' })
    );

    expect(expanded.data).toEqual({
      op: 'without',
      fields: ['items'],
      input: {
        op: 'expand',
        collection: { op: 'field', alias: '', field: 'items' },
        fields: ['product', 'quantity'],
        input: {
          op: 'constRows',
          rows: [{ customerId: 42, items: [{ product: 'sku-a', quantity: 2 }] }]
        }
      }
    });
    expect(aliased.data).toEqual({
      op: 'expand',
      collection: { op: 'field', alias: '', field: 'items' },
      alias: 'item',
      input: {
        op: 'constRows',
        rows: [{ customerId: 42, items: [{ product: 'sku-a', quantity: 2 }] }]
      }
    });
  });

  it('builds Relic-style subquery expression nodes and tracks their dependencies', () => {
    const focusRows = pipe(
      from(presence),
      where(eq(presence.targetObjectId, object.id)),
      project({ peerId: presence.peerId })
    );
    const focusedObjects = pipe(
      from(object),
      project({
        id: object.id,
        focusedPeers: sel(focusRows),
        firstFocus: sel1(focusRows)
      })
    );

    expect(focusedObjects.data).toEqual({
      op: 'select',
      input: { op: 'from', relation: 'objects', alias: 'object' },
      projection: {
        id: { op: 'field', alias: 'object', field: 'id' },
        focusedPeers: {
          op: 'subquery',
          mode: 'many',
          query: {
            op: 'select',
            input: {
              op: 'where',
              input: { op: 'from', relation: 'presence', alias: 'presence' },
              predicate: {
                op: 'eq',
                left: { op: 'field', alias: 'presence', field: 'targetObjectId' },
                right: { op: 'field', alias: 'object', field: 'id' }
              }
            },
            projection: {
              peerId: { op: 'field', alias: 'presence', field: 'peerId' }
            }
          }
        },
        firstFocus: {
          op: 'subquery',
          mode: 'one',
          query: focusRows.data
        }
      }
    });
    expect(Object.keys(focusedObjects.relations).sort()).toEqual(['objects', 'presence']);
    expect(dependencies(focusedObjects)).toEqual(['objects', 'presence']);
    expect(dependencies(focusedObjects.data)).toEqual(['objects', 'presence']);
  });
});
