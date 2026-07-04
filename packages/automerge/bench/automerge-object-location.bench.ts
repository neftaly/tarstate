import * as Automerge from '@automerge/automerge';
import { bench, describe } from 'vitest';
import { runtimeSystemRelations, type RelationApplyResult } from '@tarstate/core/adapter';
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
import { write, type WritePatch } from '@tarstate/core/write';
import {
  automergeMapAdapter,
  automergeObjectLocations,
  automergePathForObjectId,
  defineAutomergeMapRelations
} from '@tarstate/automerge';
import { colorAt, createSeededRandom, randomInt, stableSize, valueAt } from './bench-helpers.js';

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

type RelationName = 'tasks' | 'labels';
type KeyRef = {
  readonly relation: RelationName;
  readonly key: string;
};
type WriteRef = KeyRef & {
  readonly patch: WritePatch;
};

const ROW_COUNT = 600;
const LABEL_COUNT = 192;
const PROJECT_COUNT = 80;
const BOARD_COUNT = 8;
const SAMPLE_KEY_COUNT = 128;
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
const objectLocationRelation = runtimeSystemRelations.objectLocations;
const seeds = [16_777_619, 2_654_435_761] as const;

let sink = 0;

describe('Automerge object location public APIs', () => {
  for (const seed of seeds) {
    describe(`seed ${seed}`, () => {
      bench('all object locations', objectLocationTraversalProbe(seed), BENCH_OPTIONS);
      bench('current path by object id', pathForObjectIdProbe(seed), BENCH_OPTIONS);
      bench('mapped object id by relation key', objectIdForProbe(seed), BENCH_OPTIONS);
      bench('mapped object reference by relation key', objectReferenceForProbe(seed), BENCH_OPTIONS);
      bench('runtime object location rows', runtimeObjectRowsProbe(seed), BENCH_OPTIONS);
      bench('write then current object reference', writeThenReferenceProbe(seed), BENCH_OPTIONS);
    });
  }
});

function objectLocationTraversalProbe(seed: number): () => void {
  const adapter = automergeMapAdapter({
    doc: makeDoc(),
    relations: mappings,
    runtimeId: `location-bench-${seed}`
  });

  return () => {
    consume(automergeObjectLocations(adapter.getDoc(), { relations: mappings }));
  };
}

function pathForObjectIdProbe(seed: number): () => void {
  const adapter = automergeMapAdapter({
    doc: makeDoc(),
    relations: mappings,
    runtimeId: `location-path-bench-${seed}`
  });
  const objectIds = seededObjectIds(seed, adapter.getDoc());
  let cursor = seed % objectIds.length;

  return () => {
    consumeValue(automergePathForObjectId(adapter.getDoc(), valueAt(objectIds, cursor)));
    cursor += 1;
  };
}

function objectIdForProbe(seed: number): () => void {
  const adapter = automergeMapAdapter({
    doc: makeDoc(),
    relations: mappings,
    runtimeId: `location-object-id-bench-${seed}`
  });
  const keys = makeKeyRefs(seed);
  let cursor = seed % keys.length;

  return () => {
    const ref = valueAt(keys, cursor);
    cursor += 1;
    consumeValue(adapter.objectIdFor(relationFor(ref.relation), ref.key));
  };
}

function objectReferenceForProbe(seed: number): () => void {
  const adapter = automergeMapAdapter({
    doc: makeDoc(),
    relations: mappings,
    runtimeId: `location-reference-bench-${seed}`
  });
  const keys = makeKeyRefs(seed);
  let cursor = seed % keys.length;

  return () => {
    const ref = valueAt(keys, cursor);
    cursor += 1;
    consumeValue(adapter.objectReferenceFor(relationFor(ref.relation), ref.key));
  };
}

function runtimeObjectRowsProbe(seed: number): () => void {
  const adapter = automergeMapAdapter({
    doc: makeDoc(),
    relations: mappings,
    runtimeId: `location-rows-bench-${seed}`
  });

  return () => {
    consume(adapter.source.rows(objectLocationRelation));
  };
}

function writeThenReferenceProbe(seed: number): () => void {
  const adapter = automergeMapAdapter({
    doc: makeDoc(),
    relations: mappings,
    runtimeId: `location-write-bench-${seed}`
  });
  const writes = makeWriteRefs(seed);
  let cursor = seed % writes.length;

  return () => {
    const ref = valueAt(writes, cursor);
    cursor += 1;
    consumeApply(adapter.target.apply([ref.patch]));
    consumeValue(adapter.objectReferenceFor(relationFor(ref.relation), ref.key));
  };
}

function makeDoc(): Automerge.Doc<WorkspaceDoc> {
  return Automerge.from({
    workspace: {
      tasks: makeTasks(),
      labelsById: Object.fromEntries(makeLabels().map((row) => [row.id, row])),
      boards: Array.from({ length: BOARD_COUNT }, (_, boardIndex) => ({
        id: `board-${boardIndex}`,
        columns: Array.from({ length: 8 }, (_, columnIndex) => ({
          id: `board-${boardIndex}-column-${columnIndex}`,
          cardIds: Array.from({ length: 16 }, (_, cardIndex) =>
            `task-${(boardIndex * 127 + columnIndex * 31 + cardIndex * 7) % ROW_COUNT}`)
        }))
      }))
    }
  });
}

function makeTasks(): readonly TaskRow[] {
  return Array.from({ length: ROW_COUNT }, (_, index) => ({
    id: `task-${index}`,
    title: `Task ${index}`,
    effort: (index * 17) % 10_000,
    done: index % 5 === 0,
    projectId: `project-${index % PROJECT_COUNT}`,
    meta: {
      rank: index,
      tags: [`tag-${index % 11}`, `tag-${index % 17}`],
      checklist: Array.from({ length: index % 4 }, (_, itemIndex) => ({
        id: `task-${index}-check-${itemIndex}`,
        done: (index + itemIndex) % 2 === 0
      }))
    }
  }));
}

function makeLabels(): readonly LabelRow[] {
  return Array.from({ length: LABEL_COUNT }, (_, index) => ({
    id: `label-${index}`,
    name: `Label ${index}`,
    color: colorAt(index)
  }));
}

function locationObjectIds(doc: Automerge.Doc<WorkspaceDoc>): readonly Automerge.ObjID[] {
  const objectIds = automergeObjectLocations(doc, { relations: mappings }).map((row) => row.objectId);
  if (objectIds.length === 0) throw new Error('expected object locations');
  return objectIds;
}

function seededObjectIds(seed: number, doc: Automerge.Doc<WorkspaceDoc>): readonly Automerge.ObjID[] {
  const next = createSeededRandom(seed);
  const objectIds = locationObjectIds(doc);
  return Array.from({ length: SAMPLE_KEY_COUNT }, () => valueAt(objectIds, randomInt(next, objectIds.length)));
}

function makeKeyRefs(seed: number): readonly KeyRef[] {
  const next = createSeededRandom(seed);

  return Array.from({ length: SAMPLE_KEY_COUNT }, () => {
    const relation = next() < 0.72 ? 'tasks' : 'labels';
    return {
      relation,
      key: relation === 'tasks'
        ? `task-${randomInt(next, ROW_COUNT)}`
        : `label-${randomInt(next, LABEL_COUNT)}`
    };
  });
}

function makeWriteRefs(seed: number): readonly WriteRef[] {
  return makeKeyRefs(seed).map((ref, index) => ({
    ...ref,
    patch: ref.relation === 'tasks'
      ? write(schema.tasks).updateByKey(ref.key, {
        title: `Task ${ref.key}.${index}`,
        effort: (seed + index * 37) % 10_000,
        done: index % 3 === 0
      })
      : write(schema.labels).updateByKey(ref.key, {
        name: `Label ${ref.key}.${index}`,
        color: colorAt(seed + index)
      })
  }));
}

function relationFor(name: RelationName) {
  return name === 'tasks' ? schema.tasks : schema.labels;
}

function consume(rows: readonly unknown[]): void {
  sink = (sink + rows.length) % Number.MAX_SAFE_INTEGER;
  if (sink < 0) throw new Error('unreachable benchmark sink');
}

function consumeValue(valueValue: unknown): void {
  sink = (sink + stableSize(valueValue)) % Number.MAX_SAFE_INTEGER;
  if (sink < 0) throw new Error('unreachable benchmark sink');
}

function consumeApply(result: RelationApplyResult | PromiseLike<RelationApplyResult>): void {
  if (isPromiseLike(result)) throw new Error('benchmark target unexpectedly returned a Promise');
  sink = (
    sink
    + result.applied
    + result.patches
    + result.deltas.length
    + result.diagnostics.length
  ) % Number.MAX_SAFE_INTEGER;
  if (result.status !== 'accepted') {
    throw new Error(result.diagnostics.map((diagnostic) => diagnostic.message).join('; '));
  }
}

function isPromiseLike(input: unknown): input is PromiseLike<unknown> {
  return typeof input === 'object'
    && input !== null
    && 'then' in input
    && typeof (input as { readonly then?: unknown }).then === 'function';
}
