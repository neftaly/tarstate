import { describe, expect, it } from 'vitest';
import { evaluate } from '@tarstate/core/evaluate';
import {
  aggregate,
  and,
  any,
  as,
  asc,
  avg,
  bottom,
  bottomBy,
  btree,
  call,
  constRows,
  count,
  countDistinct,
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
  hash,
  intersection,
  leftJoin,
  limit,
  lookup,
  lt,
  lte,
  maybe,
  notAny,
  pipe,
  project,
  rename,
  sel,
  sel1,
  setConcat,
  sort,
  sum,
  top,
  topBy,
  tuple,
  union,
  where,
  without
} from '@tarstate/core/query';
import {
  anchoredPathField,
  defineSchema,
  idField,
  numberField,
  optional,
  refField,
  relation,
  stringField
} from '@tarstate/core/schema';
import {
  composeSources,
  fromIndexedObjectSource,
  fromObjectSource,
  type RelationSource
} from '@tarstate/core/source';

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
const rangeSchema = defineSchema({
  ranks: relation<{
    id: string;
    rank: number;
  }>({
    key: 'id',
    fields: {
      id: idField('rank'),
      rank: numberField()
    }
  })
});
const ranked = as(rangeSchema.ranks, 'ranked');

const focusedObjects = pipe(
  from(object),
  leftJoin(from(presence), eq(object.id, presence.targetObjectId)),
  project({
    id: object.id,
    title: object.title,
    focusedBy: maybe(presence.peerId)
  })
);

describe('tarstate evaluator', () => {
  it('keeps durable rows when ephemeral presence is absent', async () => {
    const result = await evaluate(
      fromObjectSource({
        objects: [
          { id: 'object-a', kind: 'file', title: 'Alpha' },
          { id: 'object-b', kind: 'file', title: 'Beta' }
        ],
        presence: []
      }),
      focusedObjects
    );

    expect(result.rows).toEqual([
      { id: 'object-a', title: 'Alpha', focusedBy: undefined },
      { id: 'object-b', title: 'Beta', focusedBy: undefined }
    ]);
    expect(result.diagnostics).toEqual([]);
  });

  it('joins multiple peer presence rows to one durable object', async () => {
    const result = await evaluate(
      fromObjectSource({
        objects: [{ id: 'object-a', kind: 'file', title: 'Alpha' }],
        presence: [
          { workspaceId: 'workspace-a', peerId: 'peer-a', clientId: 'client-a', targetObjectId: 'object-a' },
          { workspaceId: 'workspace-a', peerId: 'peer-b', clientId: 'client-b', targetObjectId: 'object-a' }
        ]
      }),
      focusedObjects
    );

    expect(result.rows).toEqual([
      { id: 'object-a', title: 'Alpha', focusedBy: 'peer-a' },
      { id: 'object-a', title: 'Alpha', focusedBy: 'peer-b' }
    ]);
  });

  it('reports invalid rows and duplicate durable keys without crashing queries', async () => {
    const result = await evaluate(
      fromObjectSource({
        objects: [
          { id: 'object-a', kind: 'file', title: 'Alpha' },
          { id: 'object-a', kind: 'file', title: 'Duplicate' },
          { id: 'object-c', kind: 'file' }
        ],
        presence: [{ workspaceId: 'workspace-a', peerId: 123, clientId: 'client-a', targetObjectId: 'object-a' }]
      }),
      focusedObjects
    );

    expect(result.rows).toEqual([
      { id: 'object-a', title: 'Alpha', focusedBy: undefined },
      { id: 'object-a', title: 'Duplicate', focusedBy: undefined },
      { id: 'object-c', title: undefined, focusedBy: undefined }
    ]);
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      'duplicate_key',
      'invalid_row',
      'invalid_row'
    ]);
  });

  it('uses lookup when available and falls back to scan when lookup is unsupported', async () => {
    const filesByKind = pipe(
      from(object),
      where(eq(object.kind, 'file')),
      project({ id: object.id })
    );

    const data = {
      objects: [
        { id: 'object-a', kind: 'file', title: 'Alpha' },
        { id: 'object-b', kind: 'folder', title: 'Beta' }
      ]
    };

    await expect(evaluate(fromIndexedObjectSource(data), filesByKind)).resolves.toEqual({
      rows: [{ id: 'object-a' }],
      diagnostics: []
    });

    await expect(evaluate(fromObjectSource(data), filesByKind)).resolves.toEqual({
      rows: [{ id: 'object-a' }],
      diagnostics: []
    });
  });

  it('evaluates explicit lookup query nodes with scan fallback', async () => {
    const objectById = pipe(
      lookup(object, 'id', 'object-a'),
      project({
        id: object.id,
        title: object.title
      })
    );
    const data = {
      objects: [
        { id: 'object-a', kind: 'file', title: 'Alpha' },
        { id: 'object-b', kind: 'folder', title: 'Beta' }
      ]
    };

    await expect(evaluate(fromObjectSource(data), objectById)).resolves.toEqual({
      rows: [{ id: 'object-a', title: 'Alpha' }],
      diagnostics: []
    });
  });

  it('evaluates env expressions from evaluator options', async () => {
    const workspaceTodos = pipe(
      constRows([
        { id: 'todo-a', workspaceId: 'workspace-a' },
        { id: 'todo-b', workspaceId: 'workspace-b' }
      ]),
      where(eq(field('', 'workspaceId'), env('workspaceId'))),
      project({
        id: field('', 'id'),
        workspaceId: env('workspaceId'),
        tuple: tuple(field('', 'id'), env('workspaceId'))
      })
    );

    await expect(
      evaluate(fromObjectSource({}), workspaceTodos, {
        env: { workspaceId: 'workspace-a' }
      })
    ).resolves.toEqual({
      rows: [{ id: 'todo-a', workspaceId: 'workspace-a', tuple: ['todo-a', 'workspace-a'] }],
      diagnostics: []
    });
  });

  it('passes through hash and btree index declarations during evaluation', async () => {
    const indexedFiles = pipe(
      from(object),
      hash(object.kind),
      btree(object.title),
      where(eq(object.kind, 'file')),
      project({
        id: object.id,
        title: object.title
      })
    );

    await expect(
      evaluate(
        fromObjectSource({
          objects: [
            { id: 'object-a', kind: 'file', title: 'Alpha' },
            { id: 'object-b', kind: 'folder', title: 'Beta' }
          ]
        }),
        indexedFiles
      )
    ).resolves.toEqual({
      rows: [{ id: 'object-a', title: 'Alpha' }],
      diagnostics: []
    });
  });

  it('uses hash equality declarations for where lookups', async () => {
    const indexedFiles = pipe(
      from(object),
      hash(object.kind),
      where(eq(object.kind, 'file')),
      project({
        id: object.id,
        title: object.title
      })
    );
    const lookups: { readonly relation: string; readonly field: string; readonly value: unknown }[] = [];
    const source: RelationSource = {
      rows: () => {
        throw new Error('hash where should use lookup');
      },
      lookup: ({ relation: relationRef, field, value }) => {
        lookups.push({ relation: relationRef.name, field, value });
        return [{ id: 'object-a', kind: 'file', title: 'Alpha' }];
      }
    };

    const result = await evaluate(source, indexedFiles);

    expect(result.rows).toEqual([{ id: 'object-a', title: 'Alpha' }]);
    expect(result.diagnostics).toEqual([]);
    expect(lookups).toEqual([{ relation: 'objects', field: 'kind', value: 'file' }]);
  });

  it('keeps hash equality lookup planning through outer btree declarations', async () => {
    const indexedFiles = pipe(
      from(object),
      hash(object.kind),
      btree(object.title),
      where(eq(object.kind, 'file')),
      project({
        id: object.id,
        title: object.title
      })
    );
    const lookups: { readonly relation: string; readonly field: string; readonly value: unknown }[] = [];
    const source: RelationSource = {
      rows: () => {
        throw new Error('outer btree declaration should not hide hash lookup');
      },
      lookup: ({ relation: relationRef, field, value }) => {
        lookups.push({ relation: relationRef.name, field, value });
        return [{ id: 'object-a', kind: 'file', title: 'Alpha' }];
      }
    };

    const result = await evaluate(source, indexedFiles);

    expect(result.rows).toEqual([{ id: 'object-a', title: 'Alpha' }]);
    expect(result.diagnostics).toEqual([]);
    expect(lookups).toEqual([{ relation: 'objects', field: 'kind', value: 'file' }]);
  });

  it('scans hash-wrapped filters when the equality field is not declared', async () => {
    const indexedFiles = pipe(
      from(object),
      hash(object.title),
      where(eq(object.kind, 'file')),
      project({
        id: object.id,
        title: object.title
      })
    );
    let lookupCalls = 0;
    const source: RelationSource = {
      rows: () => [
        { id: 'object-a', kind: 'file', title: 'Alpha' },
        { id: 'object-b', kind: 'folder', title: 'Beta' }
      ],
      lookup: () => {
        lookupCalls += 1;
        throw new Error('hash where should not use a mismatched lookup');
      }
    };

    const result = await evaluate(source, indexedFiles);

    expect(result.rows).toEqual([{ id: 'object-a', title: 'Alpha' }]);
    expect(result.diagnostics).toEqual([]);
    expect(lookupCalls).toBe(0);
  });

  it('uses btree range declarations for where range lookups', async () => {
    const titleRange = pipe(
      from(object),
      hash(object.kind),
      btree(object.title),
      where(and(gte(object.title, 'Beta'), lt(object.title, 'Gamma'))),
      project({
        id: object.id,
        title: object.title
      })
    );
    const rangeLookups: {
      readonly relation: string;
      readonly field: string;
      readonly lower?: { readonly value: unknown; readonly inclusive: boolean };
      readonly upper?: { readonly value: unknown; readonly inclusive: boolean };
    }[] = [];
    const source: RelationSource = {
      rows: () => {
        throw new Error('btree where should use range lookup');
      },
      rangeLookup: ({ relation: relationRef, field, lower, upper }) => {
        rangeLookups.push({
          relation: relationRef.name,
          field,
          ...(lower === undefined ? {} : { lower }),
          ...(upper === undefined ? {} : { upper })
        });
        return [{ id: 'object-b', kind: 'file', title: 'Beta' }];
      }
    };

    const result = await evaluate(source, titleRange);

    expect(result.rows).toEqual([{ id: 'object-b', title: 'Beta' }]);
    expect(result.diagnostics).toEqual([]);
    expect(rangeLookups).toEqual([
      {
        relation: 'objects',
        field: 'title',
        lower: { value: 'Beta', inclusive: true },
        upper: { value: 'Gamma', inclusive: false }
      }
    ]);
  });

  it('tightens merged btree lower bounds for range lookup requests', async () => {
    const rankRange = pipe(
      from(ranked),
      btree(ranked.rank),
      where(and(gte(ranked.rank, 100), gt(ranked.rank, 200))),
      project({
        id: ranked.id,
        rank: ranked.rank
      })
    );
    const rangeLookups: {
      readonly relation: string;
      readonly field: string;
      readonly lower?: { readonly value: unknown; readonly inclusive: boolean };
      readonly upper?: { readonly value: unknown; readonly inclusive: boolean };
    }[] = [];
    const source: RelationSource = {
      rows: () => {
        throw new Error('btree where should use range lookup');
      },
      rangeLookup: ({ relation: relationRef, field, lower, upper }) => {
        rangeLookups.push({
          relation: relationRef.name,
          field,
          ...(lower === undefined ? {} : { lower }),
          ...(upper === undefined ? {} : { upper })
        });
        return [
          { id: 'rank-200', rank: 200 },
          { id: 'rank-250', rank: 250 }
        ];
      }
    };

    const result = await evaluate(source, rankRange);

    expect(result.rows).toEqual([{ id: 'rank-250', rank: 250 }]);
    expect(result.diagnostics).toEqual([]);
    expect(rangeLookups).toEqual([
      {
        relation: 'ranks',
        field: 'rank',
        lower: { value: 200, inclusive: false }
      }
    ]);
  });

  it('tightens merged btree upper bounds for range lookup requests', async () => {
    const rankRange = pipe(
      from(ranked),
      btree(ranked.rank),
      where(and(lt(ranked.rank, 900), lte(ranked.rank, 800))),
      project({
        id: ranked.id,
        rank: ranked.rank
      })
    );
    const rangeLookups: {
      readonly relation: string;
      readonly field: string;
      readonly lower?: { readonly value: unknown; readonly inclusive: boolean };
      readonly upper?: { readonly value: unknown; readonly inclusive: boolean };
    }[] = [];
    const source: RelationSource = {
      rows: () => {
        throw new Error('btree where should use range lookup');
      },
      rangeLookup: ({ relation: relationRef, field, lower, upper }) => {
        rangeLookups.push({
          relation: relationRef.name,
          field,
          ...(lower === undefined ? {} : { lower }),
          ...(upper === undefined ? {} : { upper })
        });
        return [
          { id: 'rank-800', rank: 800 },
          { id: 'rank-900', rank: 900 }
        ];
      }
    };

    const result = await evaluate(source, rankRange);

    expect(result.rows).toEqual([{ id: 'rank-800', rank: 800 }]);
    expect(result.diagnostics).toEqual([]);
    expect(rangeLookups).toEqual([
      {
        relation: 'ranks',
        field: 'rank',
        upper: { value: 800, inclusive: true }
      }
    ]);
  });

  it('uses exclusive btree bounds when equal merged bounds are stricter', async () => {
    const rankRange = pipe(
      from(ranked),
      btree(ranked.rank),
      where(and(
        gte(ranked.rank, 100),
        gt(ranked.rank, 100),
        lte(ranked.rank, 200),
        lt(ranked.rank, 200)
      )),
      project({
        id: ranked.id,
        rank: ranked.rank
      })
    );
    const rangeLookups: {
      readonly relation: string;
      readonly field: string;
      readonly lower?: { readonly value: unknown; readonly inclusive: boolean };
      readonly upper?: { readonly value: unknown; readonly inclusive: boolean };
    }[] = [];
    const source: RelationSource = {
      rows: () => {
        throw new Error('btree where should use range lookup');
      },
      rangeLookup: ({ relation: relationRef, field, lower, upper }) => {
        rangeLookups.push({
          relation: relationRef.name,
          field,
          ...(lower === undefined ? {} : { lower }),
          ...(upper === undefined ? {} : { upper })
        });
        return [
          { id: 'rank-100', rank: 100 },
          { id: 'rank-150', rank: 150 },
          { id: 'rank-200', rank: 200 }
        ];
      }
    };

    const result = await evaluate(source, rankRange);

    expect(result.rows).toEqual([{ id: 'rank-150', rank: 150 }]);
    expect(result.diagnostics).toEqual([]);
    expect(rangeLookups).toEqual([
      {
        relation: 'ranks',
        field: 'rank',
        lower: { value: 100, inclusive: false },
        upper: { value: 200, inclusive: false }
      }
    ]);
  });

  it('falls back to scan when btree range lookup is unsupported', async () => {
    const titleRange = pipe(
      from(object),
      btree(object.title),
      where(lt(object.title, 'Gamma')),
      project({
        id: object.id,
        title: object.title
      })
    );

    const result = await evaluate(
      fromObjectSource({
        objects: [
          { id: 'object-a', kind: 'file', title: 'Alpha' },
          { id: 'object-b', kind: 'file', title: 'Beta' },
          { id: 'object-c', kind: 'file', title: 'Gamma' }
        ]
      }),
      titleRange
    );

    expect(result.rows).toEqual([
      { id: 'object-a', title: 'Alpha' },
      { id: 'object-b', title: 'Beta' }
    ]);
    expect(result.diagnostics).toEqual([]);
  });

  it('falls back to scan with tightened btree range predicates when range lookup is unsupported', async () => {
    const rankRange = pipe(
      from(ranked),
      btree(ranked.rank),
      where(and(
        gte(ranked.rank, 100),
        gt(ranked.rank, 200),
        lt(ranked.rank, 900),
        lte(ranked.rank, 800)
      )),
      project({
        id: ranked.id,
        rank: ranked.rank
      })
    );

    const result = await evaluate(
      fromObjectSource({
        ranks: [
          { id: 'rank-100', rank: 100 },
          { id: 'rank-200', rank: 200 },
          { id: 'rank-201', rank: 201 },
          { id: 'rank-800', rank: 800 },
          { id: 'rank-900', rank: 900 }
        ]
      }),
      rankRange
    );

    expect(result.rows).toEqual([
      { id: 'rank-201', rank: 201 },
      { id: 'rank-800', rank: 800 }
    ]);
    expect(result.diagnostics).toEqual([]);
  });

  it('scans btree-wrapped filters when the range field is not declared', async () => {
    const titleRange = pipe(
      from(object),
      btree(object.kind),
      where(gt(object.title, 'Alpha')),
      project({
        id: object.id,
        title: object.title
      })
    );
    let rangeLookupCalls = 0;
    const source: RelationSource = {
      rows: () => [
        { id: 'object-a', kind: 'file', title: 'Alpha' },
        { id: 'object-b', kind: 'file', title: 'Beta' }
      ],
      rangeLookup: () => {
        rangeLookupCalls += 1;
        throw new Error('btree where should not use a mismatched range lookup');
      }
    };

    const result = await evaluate(source, titleRange);

    expect(result.rows).toEqual([{ id: 'object-b', title: 'Beta' }]);
    expect(result.diagnostics).toEqual([]);
    expect(rangeLookupCalls).toBe(0);
  });

  it('surfaces range lookup errors as diagnostics and falls back to scanning', async () => {
    const titleRange = pipe(
      from(object),
      btree(object.title),
      where(gt(object.title, 'Alpha')),
      project({ id: object.id })
    );

    const source: RelationSource = {
      rows: () => [
        { id: 'object-a', kind: 'file', title: 'Alpha' },
        { id: 'object-b', kind: 'file', title: 'Beta' }
      ],
      rangeLookup: () => {
        throw new Error('range unavailable');
      }
    };

    const result = await evaluate(source, titleRange);

    expect(result.rows).toEqual([{ id: 'object-b' }]);
    expect(result.diagnostics).toMatchObject([
      {
        code: 'source_error',
        relation: 'objects',
        field: 'title'
      }
    ]);
  });

  it('uses hash equality declarations for matching join lookups', async () => {
    const hashedFocusedObjects = pipe(
      from(object),
      leftJoin(pipe(from(presence), hash(presence.targetObjectId)), eq(object.id, presence.targetObjectId)),
      project({
        id: object.id,
        title: object.title,
        focusedBy: maybe(presence.peerId)
      })
    );
    const lookups: { readonly relation: string; readonly field: string; readonly value: unknown }[] = [];
    const source: RelationSource = {
      rows: (relationRef) => {
        if (relationRef.name === 'presence') {
          throw new Error('hash join should use lookup for presence');
        }

        return [{ id: 'object-a', kind: 'file', title: 'Alpha' }];
      },
      lookup: ({ relation: relationRef, field, value }) => {
        lookups.push({ relation: relationRef.name, field, value });
        return [{ workspaceId: 'workspace-a', peerId: 'peer-a', clientId: 'client-a', targetObjectId: 'object-a' }];
      }
    };

    const result = await evaluate(source, hashedFocusedObjects);

    expect(result.rows).toEqual([{ id: 'object-a', title: 'Alpha', focusedBy: 'peer-a' }]);
    expect(result.diagnostics).toEqual([]);
    expect(lookups).toEqual([{ relation: 'presence', field: 'targetObjectId', value: 'object-a' }]);
  });

  it('scans hash-wrapped joins when the join field is not declared', async () => {
    const hashedFocusedObjects = pipe(
      from(object),
      leftJoin(pipe(from(presence), hash(presence.peerId)), eq(object.id, presence.targetObjectId)),
      project({
        id: object.id,
        title: object.title,
        focusedBy: maybe(presence.peerId)
      })
    );
    let lookupCalls = 0;
    const source: RelationSource = {
      rows: (relationRef) =>
        relationRef.name === 'objects'
          ? [{ id: 'object-a', kind: 'file', title: 'Alpha' }]
          : [{ workspaceId: 'workspace-a', peerId: 'peer-a', clientId: 'client-a', targetObjectId: 'object-a' }],
      lookup: () => {
        lookupCalls += 1;
        throw new Error('hash join should not use a mismatched lookup');
      }
    };

    const result = await evaluate(source, hashedFocusedObjects);

    expect(result.rows).toEqual([{ id: 'object-a', title: 'Alpha', focusedBy: 'peer-a' }]);
    expect(result.diagnostics).toEqual([]);
    expect(lookupCalls).toBe(0);
  });

  it('uses adapter lookup for explicit lookup query nodes when available', async () => {
    const objectById = pipe(
      lookup(object, 'id', 'object-a'),
      project({
        id: object.id,
        title: object.title
      })
    );
    const source: RelationSource = {
      rows: () => {
        throw new Error('explicit lookup should not scan');
      },
      lookup: ({ relation: relationRef, field, value }) => {
        if (relationRef.name !== 'objects' || field !== 'id' || value !== 'object-a') {
          return undefined;
        }

        return [{ id: 'object-a', kind: 'file', title: 'Alpha' }];
      }
    };

    await expect(evaluate(source, objectById)).resolves.toEqual({
      rows: [{ id: 'object-a', title: 'Alpha' }],
      diagnostics: []
    });
  });

  it('uses lookup for simple equality joins when available', async () => {
    const source: RelationSource = {
      rows: (relationRef) => {
        if (relationRef.name === 'presence') {
          throw new Error('join should use lookup for presence');
        }

        return [{ id: 'object-a', kind: 'file', title: 'Alpha' }];
      },
      lookup: ({ relation: relationRef, field, value }) => {
        if (relationRef.name !== 'presence' || field !== 'targetObjectId' || value !== 'object-a') {
          return undefined;
        }

        return [{ workspaceId: 'workspace-a', peerId: 'peer-a', clientId: 'client-a', targetObjectId: 'object-a' }];
      }
    };

    const result = await evaluate(source, focusedObjects);

    expect(result.rows).toEqual([{ id: 'object-a', title: 'Alpha', focusedBy: 'peer-a' }]);
    expect(result.diagnostics).toEqual([]);
  });

  it('falls back to scan when a composed lookup would be incomplete', async () => {
    const result = await evaluate(
      composeSources(
        fromObjectSource({
          objects: [{ id: 'object-a', kind: 'file', title: 'Alpha' }]
        }),
        fromIndexedObjectSource({
          presence: [{ workspaceId: 'workspace-a', peerId: 'peer-a', clientId: 'client-a', targetObjectId: 'object-a' }]
        }),
        fromObjectSource({
          presence: [{ workspaceId: 'workspace-a', peerId: 'peer-b', clientId: 'client-b', targetObjectId: 'object-a' }]
        })
      ),
      focusedObjects
    );

    expect(result.rows).toEqual([
      { id: 'object-a', title: 'Alpha', focusedBy: 'peer-a' },
      { id: 'object-a', title: 'Alpha', focusedBy: 'peer-b' }
    ]);
    expect(result.diagnostics).toEqual([]);
  });

  it('does not duplicate left diagnostics when a join lookup falls back', async () => {
    const source: RelationSource = {
      rows: (relationRef) =>
        relationRef.name === 'objects'
          ? [
              { id: 'object-a', kind: 'file' },
              { id: 'object-b', kind: 'file', title: 'Beta' }
            ]
          : [],
      lookup: ({ value }) => (value === 'object-a' ? [] : undefined)
    };

    const result = await evaluate(source, focusedObjects);

    expect(result.rows).toEqual([
      { id: 'object-a', title: undefined, focusedBy: undefined },
      { id: 'object-b', title: 'Beta', focusedBy: undefined }
    ]);
    expect(result.diagnostics).toEqual([
      {
        code: 'invalid_row',
        message: 'missing required field title in relation objects',
        relation: 'objects',
        field: 'title'
      }
    ]);
  });

  it('drops invalid ephemeral lookup rows before projection', async () => {
    const peerPresence = pipe(
      from(presence),
      where(eq(presence.peerId, 'peer-a')),
      project({ peerId: presence.peerId })
    );
    const data = {
      presence: [
        { workspaceId: 'workspace-a', peerId: 'peer-a', clientId: 'client-a' },
        { peerId: 'peer-a', clientId: 'client-b' }
      ]
    };

    await expect(evaluate(fromIndexedObjectSource(data), peerPresence)).resolves.toEqual({
      rows: [{ peerId: 'peer-a' }],
      diagnostics: [
        {
          code: 'invalid_row',
          message: 'missing required field workspaceId in relation presence',
          relation: 'presence',
          field: 'workspaceId'
        }
      ]
    });

    await expect(evaluate(fromObjectSource(data), peerPresence)).resolves.toEqual({
      rows: [{ peerId: 'peer-a' }],
      diagnostics: [
        {
          code: 'invalid_row',
          message: 'missing required field workspaceId in relation presence',
          relation: 'presence',
          field: 'workspaceId'
        }
      ]
    });
  });

  it('surfaces lookup errors as diagnostics and falls back to scanning', async () => {
    const filesByKind = pipe(
      from(object),
      where(eq(object.kind, 'file')),
      project({ id: object.id })
    );

    const source: RelationSource = {
      rows: () => [
        { id: 'object-a', kind: 'file', title: 'Alpha' },
        { id: 'object-b', kind: 'folder', title: 'Beta' }
      ],
      lookup: () => {
        throw new Error('index unavailable');
      }
    };

    const result = await evaluate(source, filesByKind);

    expect(result.rows).toEqual([{ id: 'object-a' }]);
    expect(result.diagnostics).toMatchObject([
      {
        code: 'source_error',
        relation: 'objects',
        field: 'kind'
      }
    ]);
  });

  it('evaluates literal rows, comparisons, calls, sorting, limits, and row transforms', async () => {
    const id = field<string>('', 'id');
    const title = field<string>('', 'title');
    const rank = field<number>('', 'rank');
    const lowerTitle = field<string>('', 'lowerTitle');
    const label = field<string>('', 'label');
    const ranked = pipe(
      constRows([
        { id: 'object-b', title: 'Beta', rank: 2 },
        { id: 'object-a', title: 'Alpha', rank: 1 },
        { id: 'object-c', title: 'Cube', rank: 3 }
      ]),
      where(gt(rank, 1)),
      extend({
        lowerTitle: call('lower', title),
        label: call('concat', id, ':', title)
      }),
      sort(desc(rank)),
      limit(2),
      project({
        id,
        lowerTitle,
        label
      }),
      rename({ lowerTitle: 'slug' }),
      without('label')
    );

    await expect(evaluate(fromObjectSource({}), ranked)).resolves.toEqual({
      rows: [
        { id: 'object-c', slug: 'cube' },
        { id: 'object-b', slug: 'beta' }
      ],
      diagnostics: []
    });
  });

  it('reports unsupported expression calls as diagnostics', async () => {
    const result = await evaluate(
      fromObjectSource({}),
      pipe(
        constRows([{ id: 'object-a', title: 'Alpha' }]),
        project({
          id: field<string>('', 'id'),
          invalid: call('missingRuntimeFunction', field<string>('', 'title'))
        })
      )
    );

    expect(result.rows).toEqual([{ id: 'object-a', invalid: undefined }]);
    expect(result.diagnostics).toEqual([
      {
        code: 'unsupported_expression',
        message: 'unsupported expression call missingRuntimeFunction',
        detail: { name: 'missingRuntimeFunction', args: ['Alpha'] }
      }
    ]);
  });

  it('reports unsupported expression calls used as lookup values', async () => {
    const result = await evaluate(
      fromObjectSource({
        objects: [{ id: 'object-a', kind: 'file', title: 'Alpha' }]
      }),
      pipe(
        lookup(object, 'id', call('missingLookupValue', 'object-a')),
        project({
          id: object.id
        })
      )
    );

    expect(result.rows).toEqual([]);
    expect(result.diagnostics).toEqual([
      {
        code: 'unsupported_expression',
        message: 'unsupported expression call missingLookupValue',
        detail: { name: 'missingLookupValue', args: ['object-a'] }
      }
    ]);
  });

  it('reports unsupported expression calls used as aggregate inputs', async () => {
    const kind = field<string>('', 'kind');
    const quantity = field<number>('', 'quantity');
    const result = await evaluate(
      fromObjectSource({}),
      pipe(
        constRows([
          { kind: 'file', quantity: 2 },
          { kind: 'file', quantity: 4 }
        ]),
        aggregate({
          groupBy: { kind },
          aggregates: {
            total: sum(call('missingAggregateValue', quantity))
          }
        })
      )
    );

    expect(result.rows).toEqual([{ kind: 'file', total: 0 }]);
    expect(result.diagnostics).toEqual([
      {
        code: 'unsupported_expression',
        message: 'unsupported expression call missingAggregateValue',
        detail: { name: 'missingAggregateValue', args: [2] }
      },
      {
        code: 'unsupported_expression',
        message: 'unsupported expression call missingAggregateValue',
        detail: { name: 'missingAggregateValue', args: [4] }
      }
    ]);
  });

  it('reports unsupported expression calls used as sort keys', async () => {
    const title = field<string>('', 'title');
    const result = await evaluate(
      fromObjectSource({}),
      pipe(
        constRows([
          { id: 'object-b', title: 'Beta' },
          { id: 'object-a', title: 'Alpha' }
        ]),
        sort(asc(call('missingSortKey', title)))
      )
    );

    expect(result.rows).toEqual([
      { id: 'object-b', title: 'Beta' },
      { id: 'object-a', title: 'Alpha' }
    ]);
    expect(result.diagnostics.length).toBeGreaterThan(0);
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        {
          code: 'unsupported_expression',
          message: 'unsupported expression call missingSortKey',
          detail: { name: 'missingSortKey', args: ['Alpha'] }
        },
        {
          code: 'unsupported_expression',
          message: 'unsupported expression call missingSortKey',
          detail: { name: 'missingSortKey', args: ['Beta'] }
        }
      ])
    );
  });

  it('evaluates correlated sel subqueries inside project expressions', async () => {
    const focusRows = pipe(
      from(presence),
      where(eq(presence.targetObjectId, object.id)),
      project({ peerId: presence.peerId })
    );
    const peerAFocus = pipe(
      from(presence),
      where(and(eq(presence.targetObjectId, object.id), eq(presence.peerId, 'peer-a'))),
      project({ peerId: presence.peerId })
    );
    const focused = pipe(
      from(object),
      project({
        id: object.id,
        focusedPeers: sel(focusRows),
        peerA: sel1(peerAFocus)
      })
    );

    const result = await evaluate(
      fromObjectSource({
        objects: [
          { id: 'object-a', kind: 'file', title: 'Alpha' },
          { id: 'object-b', kind: 'file', title: 'Beta' }
        ],
        presence: [
          { workspaceId: 'workspace-a', peerId: 'peer-a', clientId: 'client-a', targetObjectId: 'object-a' },
          { workspaceId: 'workspace-a', peerId: 'peer-b', clientId: 'client-b', targetObjectId: 'object-a' }
        ]
      }),
      focused
    );

    expect(result.rows).toEqual([
      {
        id: 'object-a',
        focusedPeers: [{ peerId: 'peer-a' }, { peerId: 'peer-b' }],
        peerA: { peerId: 'peer-a' }
      },
      {
        id: 'object-b',
        focusedPeers: [],
        peerA: undefined
      }
    ]);
    expect(result.diagnostics).toEqual([]);
  });

  it('evaluates correlated sel subqueries inside where expressions', async () => {
    const focusRows = pipe(
      from(presence),
      where(eq(presence.targetObjectId, object.id)),
      project({ peerId: presence.peerId })
    );
    const focusedObjects = pipe(
      from(object),
      where(gt(call('length', sel(focusRows)), 0)),
      project({ id: object.id })
    );

    const result = await evaluate(
      fromObjectSource({
        objects: [
          { id: 'object-a', kind: 'file', title: 'Alpha' },
          { id: 'object-b', kind: 'file', title: 'Beta' }
        ],
        presence: [
          { workspaceId: 'workspace-a', peerId: 'peer-a', clientId: 'client-a', targetObjectId: 'object-a' }
        ]
      }),
      focusedObjects
    );

    expect(result.rows).toEqual([{ id: 'object-a' }]);
    expect(result.diagnostics).toEqual([]);
  });

  it('reports unsupported sel1 subqueries that return multiple rows', async () => {
    const focusRows = pipe(
      from(presence),
      where(eq(presence.targetObjectId, object.id)),
      project({ peerId: presence.peerId })
    );
    const focused = pipe(
      from(object),
      project({
        id: object.id,
        onlyFocus: sel1(focusRows)
      })
    );

    const result = await evaluate(
      fromObjectSource({
        objects: [{ id: 'object-a', kind: 'file', title: 'Alpha' }],
        presence: [
          { workspaceId: 'workspace-a', peerId: 'peer-a', clientId: 'client-a', targetObjectId: 'object-a' },
          { workspaceId: 'workspace-a', peerId: 'peer-b', clientId: 'client-b', targetObjectId: 'object-a' }
        ]
      }),
      focused
    );

    expect(result.rows).toEqual([{ id: 'object-a', onlyFocus: undefined }]);
    expect(result.diagnostics).toMatchObject([
      {
        code: 'unsupported_expression',
        message: 'sel1 subquery returned more than one row',
        detail: { rows: 2 }
      }
    ]);
  });

  it('accepts evaluator-level runtime functions for named expression calls', async () => {
    const result = await evaluate(
      fromObjectSource({}),
      pipe(
        constRows([{ id: 'object-a', title: 'Alpha' }]),
        project({
          id: field<string>('', 'id'),
          slug: call('slug', field<string>('', 'title')),
          label: call('concat', field<string>('', 'id'), ':', field<string>('', 'title'))
        })
      ),
      {
        functions: {
          slug: (value) => typeof value === 'string' ? value.toLowerCase() : undefined,
          concat: (...parts) => `custom:${parts.join('|')}`
        }
      }
    );

    expect(result).toEqual({
      rows: [{ id: 'object-a', slug: 'alpha', label: 'custom:object-a|:|Alpha' }],
      diagnostics: []
    });
  });

  it('evaluates set operations over literal rows', async () => {
    const left = constRows([{ id: 'object-a' }, { id: 'object-b' }]);
    const right = constRows([{ id: 'object-b' }, { id: 'object-c' }]);

    await expect(evaluate(fromObjectSource({}), union(left, right))).resolves.toEqual({
      rows: [{ id: 'object-a' }, { id: 'object-b' }, { id: 'object-c' }],
      diagnostics: []
    });
    await expect(evaluate(fromObjectSource({}), pipe(left, intersection(right)))).resolves.toEqual({
      rows: [{ id: 'object-b' }],
      diagnostics: []
    });
    await expect(evaluate(fromObjectSource({}), pipe(left, difference(right)))).resolves.toEqual({
      rows: [{ id: 'object-a' }],
      diagnostics: []
    });
  });

  it('evaluates grouped aggregate queries', async () => {
    const kind = field<string>('', 'kind');
    const quantity = field<number>('', 'quantity');
    const archived = field<boolean>('', 'archived');
    const name = field<string>('', 'name');
    const totals = pipe(
      constRows([
        { kind: 'file', name: 'alpha', quantity: 2, archived: false },
        { kind: 'file', name: 'beta', quantity: 7, archived: true },
        { kind: 'file', name: 'gamma', quantity: 4, archived: false },
        { kind: 'folder', name: 'delta', quantity: 1, archived: false }
      ]),
      aggregate({
        groupBy: { kind },
        aggregates: {
          total: count(),
          distinctQuantities: countDistinct(quantity),
          quantity: sum(quantity),
          average: avg(quantity),
          hasArchived: any(archived),
          noneArchived: notAny(archived),
          names: setConcat(name),
          topQuantities: top(2, quantity),
          bottomQuantities: bottom(2, quantity),
          topRows: topBy(2, quantity),
          bottomRows: bottomBy(2, quantity)
        }
      }),
      sort(asc(kind))
    );

    await expect(evaluate(fromObjectSource({}), totals)).resolves.toEqual({
      rows: [
        {
          kind: 'file',
          total: 3,
          distinctQuantities: 3,
          quantity: 13,
          average: 13 / 3,
          hasArchived: true,
          noneArchived: false,
          names: new Set(['alpha', 'beta', 'gamma']),
          topQuantities: [7, 4],
          bottomQuantities: [2, 4],
          topRows: [
            { kind: 'file', name: 'beta', quantity: 7, archived: true },
            { kind: 'file', name: 'gamma', quantity: 4, archived: false }
          ],
          bottomRows: [
            { kind: 'file', name: 'alpha', quantity: 2, archived: false },
            { kind: 'file', name: 'gamma', quantity: 4, archived: false }
          ]
        },
        {
          kind: 'folder',
          total: 1,
          distinctQuantities: 1,
          quantity: 1,
          average: 1,
          hasArchived: false,
          noneArchived: true,
          names: new Set(['delta']),
          topQuantities: [1],
          bottomQuantities: [1],
          topRows: [{ kind: 'folder', name: 'delta', quantity: 1, archived: false }],
          bottomRows: [{ kind: 'folder', name: 'delta', quantity: 1, archived: false }]
        }
      ],
      diagnostics: []
    });
  });

  it('evaluates Relic-style aggregate helper edge cases', async () => {
    const category = field<string>('', 'category');
    const id = field<string>('', 'id');
    const score = field<number | undefined>('', 'score');
    const tagSet = field<ReadonlySet<string>>('', 'tagSet');
    const tagList = field<readonly string[]>('', 'tagList');
    const aggregateHelpers = pipe(
      constRows([
        {
          category: 'item',
          id: 'b',
          score: 10,
          tagSet: new Set(['red', 'blue']),
          tagList: ['round', 'blue']
        },
        {
          category: 'item',
          id: 'a',
          score: 10,
          tagSet: new Set(['blue', 'green']),
          tagList: ['round', 'square']
        },
        {
          category: 'item',
          id: 'c',
          score: 5,
          tagSet: new Set(['green']),
          tagList: ['triangle']
        },
        {
          category: 'item',
          id: 'c',
          score: 5,
          tagSet: new Set(['green']),
          tagList: ['triangle']
        },
        {
          category: 'item',
          id: 'd',
          score: undefined,
          tagSet: new Set(['late']),
          tagList: []
        }
      ]),
      aggregate({
        groupBy: { category },
        aggregates: {
          tagSet: setConcat(tagSet),
          tagList: setConcat(tagList),
          ids: setConcat(id),
          topScores: top(3, score),
          distinctTopScores: top(3, score, { distinct: true }),
          bottomScores: bottom(2, score),
          distinctBottomScores: bottom(3, score, { distinct: true }),
          emptyTopScores: top(0, score),
          topRows: topBy(3, score),
          bottomRows: bottomBy(3, score),
          distinctRows: topBy(10, score, { distinct: true })
        }
      })
    );

    await expect(evaluate(fromObjectSource({}), aggregateHelpers)).resolves.toEqual({
      rows: [
        {
          category: 'item',
          tagSet: new Set(['red', 'blue', 'green', 'late']),
          tagList: new Set(['round', 'blue', 'square', 'triangle']),
          ids: new Set(['b', 'a', 'c', 'd']),
          topScores: [10, 10, 5],
          distinctTopScores: [10, 5],
          bottomScores: [5, 5],
          distinctBottomScores: [5, 10],
          emptyTopScores: [],
          topRows: [
            {
              category: 'item',
              id: 'a',
              score: 10,
              tagSet: new Set(['blue', 'green']),
              tagList: ['round', 'square']
            },
            {
              category: 'item',
              id: 'b',
              score: 10,
              tagSet: new Set(['red', 'blue']),
              tagList: ['round', 'blue']
            },
            {
              category: 'item',
              id: 'c',
              score: 5,
              tagSet: new Set(['green']),
              tagList: ['triangle']
            }
          ],
          bottomRows: [
            {
              category: 'item',
              id: 'c',
              score: 5,
              tagSet: new Set(['green']),
              tagList: ['triangle']
            },
            {
              category: 'item',
              id: 'c',
              score: 5,
              tagSet: new Set(['green']),
              tagList: ['triangle']
            },
            {
              category: 'item',
              id: 'a',
              score: 10,
              tagSet: new Set(['blue', 'green']),
              tagList: ['round', 'square']
            }
          ],
          distinctRows: [
            {
              category: 'item',
              id: 'a',
              score: 10,
              tagSet: new Set(['blue', 'green']),
              tagList: ['round', 'square']
            },
            {
              category: 'item',
              id: 'b',
              score: 10,
              tagSet: new Set(['red', 'blue']),
              tagList: ['round', 'blue']
            },
            {
              category: 'item',
              id: 'c',
              score: 5,
              tagSet: new Set(['green']),
              tagList: ['triangle']
            }
          ]
        }
      ],
      diagnostics: []
    });
  });

  it('expands nested row collections into relational rows', async () => {
    const items = field<readonly { readonly product: string; readonly quantity: number }[]>('', 'items');
    const product = field<string>('', 'product');
    const quantity = field<number>('', 'quantity');
    const orderItems = pipe(
      constRows([
        {
          customerId: 42,
          items: [
            { product: 'sku-a', quantity: 2 },
            { product: 'sku-b', quantity: 1 }
          ]
        },
        { customerId: 99, items: [] },
        { customerId: 100, items: [{ product: 'sku-c', quantity: 4 }] }
      ]),
      expand(items, { fields: ['product', 'quantity'] as const }),
      project({
        customerId: field<number>('', 'customerId'),
        product,
        quantity
      })
    );

    await expect(evaluate(fromObjectSource({}), orderItems)).resolves.toEqual({
      rows: [
        { customerId: 42, product: 'sku-a', quantity: 2 },
        { customerId: 42, product: 'sku-b', quantity: 1 },
        { customerId: 100, product: 'sku-c', quantity: 4 }
      ],
      diagnostics: []
    });
  });

  it('can expand nested values under an alias', async () => {
    const items = field<readonly { readonly product: string; readonly quantity: number }[]>('', 'items');
    const orderItems = pipe(
      constRows([
        {
          customerId: 42,
          items: [{ product: 'sku-a', quantity: 2 }]
        }
      ]),
      expand(items, { as: 'item' }),
      project({
        customerId: field<number>('', 'customerId'),
        product: field<string>('item', 'product'),
        quantity: field<number>('item', 'quantity')
      })
    );

    await expect(evaluate(fromObjectSource({}), orderItems)).resolves.toEqual({
      rows: [{ customerId: 42, product: 'sku-a', quantity: 2 }],
      diagnostics: []
    });
  });

  it('reports invalid expand inputs without crashing', async () => {
    const values = field<unknown>('', 'values');
    const expanded = pipe(
      constRows([{ id: 'row-a', values: 42 }, { id: 'row-b', values: ['ok'] }]),
      expand(values)
    );

    const result = await evaluate(fromObjectSource({}), expanded);

    expect(result.rows).toEqual([]);
    expect(result.diagnostics).toMatchObject([
      {
        code: 'invalid_row',
        message: 'expand expression did not return an iterable collection'
      },
      {
        code: 'invalid_row',
        message: 'expand item must be an object when no alias is provided'
      }
    ]);
  });
});
