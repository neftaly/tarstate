import { Repo, type DocHandle } from '@automerge/automerge-repo';
import { describe, expect, it } from 'vitest';
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
import { write } from '@tarstate/core/write';
import {
  automergePresenceRuntime,
  type AutomergePresenceFieldNames
} from '@tarstate/automerge/presence';
import { choose, mulberry32, randomInt, shuffle } from './fuzz-helpers.js';

type PresenceRow = {
  readonly peer: string;
  readonly topic: string;
  readonly payload?: JsonValue;
  readonly activeAt?: number;
  readonly seenAt?: number;
  readonly isLocal?: boolean;
};
type PresenceChannels = Record<string, JsonValue | undefined>;
type PresenceDoc = {
  readonly presence?: PresenceChannels;
};
type NormalizedRow = {
  readonly peer: string;
  readonly topic: string;
  readonly payload: JsonValue | undefined;
  readonly isLocal: boolean | undefined;
};
type ModelOutcome = {
  readonly status: 'accepted' | 'rejected';
  readonly applied: 0 | 1;
  readonly state: PresenceChannels;
  readonly added: readonly NormalizedRow[];
  readonly removed: readonly NormalizedRow[];
};
type FuzzOperation =
  | { readonly op: 'insertOrReplace'; readonly peer: string; readonly channel: string; readonly payload: JsonValue | undefined }
  | { readonly op: 'updateByKey'; readonly peer: string; readonly channel: string; readonly payload: JsonValue | undefined }
  | { readonly op: 'deleteByKey'; readonly peer: string; readonly channel: string }
  | { readonly op: 'replaceAll'; readonly rows: readonly {
    readonly peer: string;
    readonly channel: string;
    readonly payload: JsonValue | undefined;
  }[] };

const schema = defineSchema({
  presence: relation<PresenceRow>({
    ephemeral: true,
    key: ['peer', 'topic'] as const,
    fields: {
      peer: idField('peer'),
      topic: stringField(),
      payload: optional(jsonField()),
      activeAt: optional(numberField()),
      seenAt: optional(numberField()),
      isLocal: optional(booleanField())
    }
  })
});

const fields = {
  peerId: 'peer',
  channel: 'topic',
  value: 'payload',
  lastActiveAt: 'activeAt',
  lastSeenAt: 'seenAt',
  local: 'isLocal'
} satisfies AutomergePresenceFieldNames;

const localPeer = 'peer-local';
const remotePeer = 'peer-remote';
const seeds = [0x1234, 0x44aa, 0x97c1, 0xd00d] as const;
const channels = ['color', 'cursor', 'selection', 'status'] as const;

describe('automerge presence runtime fuzz', () => {
  it('matches a seeded local-state model for writable presence operations', async () => {
    for (const seed of seeds) {
      const runtime = automergePresenceRuntime({
        handle: realDocHandle(seed),
        relation: schema.presence,
        fields,
        localPeerId: localPeer,
        includeLocalRows: true,
        initialState: { color: 'blue', cursor: objectReferencePayload(seed, 0) } satisfies PresenceChannels,
        heartbeatMs: 60_000
      });
      const random = mulberry32(seed);
      let modelState: PresenceChannels = { color: 'blue', cursor: objectReferencePayload(seed, 0) };

      runtime.start();
      expect(normalizedRows(runtime.source.rows(schema.presence))).toEqual(modelRows(modelState));

      for (let step = 0; step < 40; step += 1) {
        const operation = fuzzOperation(random, seed, step, modelState);
        const outcome = applyModel(modelState, operation);
        const result = await runtime.target.apply([patchForOperation(operation)]);

        modelState = outcome.state;
        expect(result.status, message(seed, step, operation)).toBe(outcome.status);
        expect(result.applied, message(seed, step, operation)).toBe(outcome.applied);
        expect(result.durability, message(seed, step, operation)).toBe('ephemeral');
        expect(normalizedRows(runtime.source.rows(schema.presence)), message(seed, step, operation))
          .toEqual(modelRows(modelState));
        expect(normalizeState(runtime.getLocalState()), message(seed, step, operation))
          .toEqual(modelState);

        if (outcome.status === 'rejected' || (outcome.added.length === 0 && outcome.removed.length === 0)) {
          expect(result.deltas, message(seed, step, operation)).toEqual([]);
        } else {
          expect(result.deltas, message(seed, step, operation)).toHaveLength(1);
          expect(result.deltas[0]?.relation).toBe(schema.presence);
          expect(normalizedRows(result.deltas[0]?.added ?? []), message(seed, step, operation))
            .toEqual(outcome.added);
          expect(normalizedRows(result.deltas[0]?.removed ?? []), message(seed, step, operation))
            .toEqual(outcome.removed);
        }
      }

      runtime.stop();
    }
  });
});

function patchForOperation(operation: FuzzOperation) {
  switch (operation.op) {
    case 'insertOrReplace':
      return write(schema.presence).insertOrReplace(presenceWriteRow(
        operation.peer,
        operation.channel,
        operation.payload
      ));
    case 'updateByKey':
      return write(schema.presence).updateByKey(
        [operation.peer, operation.channel] as const,
        presenceUpdate(operation.payload)
      );
    case 'deleteByKey':
      return write(schema.presence).deleteByKey([operation.peer, operation.channel] as const);
    case 'replaceAll':
      return write(schema.presence).replaceAll(operation.rows.map((row) =>
        presenceWriteRow(row.peer, row.channel, row.payload)
      ));
  }
}

function applyModel(state: PresenceChannels, operation: FuzzOperation): ModelOutcome {
  const before = modelRows(state);

  if (operation.op === 'replaceAll') {
    if (operation.rows.some((row) => row.peer !== localPeer)) {
      return { status: 'rejected', applied: 0, state, added: [], removed: [] };
    }

    const nextState: PresenceChannels = {};
    for (const row of operation.rows) {
      nextState[row.channel] = row.payload === undefined ? state[row.channel] : row.payload;
    }

    const after = modelRows(nextState);
    const changed = !rowsEqual(before, after);
    return {
      status: 'accepted',
      applied: changed ? 1 : 0,
      state: nextState,
      ...diffRows(before, after)
    };
  }

  if (operation.peer !== localPeer) {
    return { status: 'rejected', applied: 0, state, added: [], removed: [] };
  }

  if (operation.op === 'deleteByKey') {
    const nextState = { ...state };
    nextState[operation.channel] = undefined;
    const after = modelRows(nextState);
    return {
      status: 'accepted',
      applied: 1,
      state: nextState,
      ...diffRows(before, after)
    };
  }

  if (operation.op === 'updateByKey' && operation.payload === undefined) {
    return {
      status: 'accepted',
      applied: 0,
      state,
      added: [],
      removed: []
    };
  }

  const nextState = { ...state };
  nextState[operation.channel] = operation.payload;
  const after = modelRows(nextState);
  return {
    status: 'accepted',
    applied: 1,
    state: nextState,
    ...diffRows(before, after)
  };
}

function presenceWriteRow(peer: string, topic: string, payload: JsonValue | undefined): PresenceRow {
  return {
    peer,
    topic,
    ...(payload === undefined ? {} : { payload })
  };
}

function presenceUpdate(payload: JsonValue | undefined): Partial<PresenceRow> {
  return payload === undefined ? {} : { payload };
}

function fuzzOperation(
  random: () => number,
  seed: number,
  step: number,
  state: PresenceChannels
): FuzzOperation {
  const opRoll = random();
  const peer = random() < 0.86 ? localPeer : remotePeer;
  const channel = choose(random, channels);

  if (opRoll < 0.3) {
    return { op: 'insertOrReplace', peer, channel, payload: fuzzPayload(random, seed, step, channel) };
  }
  if (opRoll < 0.6) {
    return { op: 'updateByKey', peer, channel, payload: fuzzPayload(random, seed, step, channel) };
  }
  if (opRoll < 0.78) {
    return { op: 'deleteByKey', peer, channel };
  }

  const rowCount = 1 + randomInt(random, 4);
  const replaceChannels = shuffle(random, channels).slice(0, rowCount);
  const rows = replaceChannels.map((replaceChannel, index) => ({
    peer: index === rowCount - 1 && random() < 0.16 ? remotePeer : localPeer,
    channel: replaceChannel,
    payload: random() < 0.18
      ? undefined
      : fuzzPayload(random, seed, step, replaceChannel)
  }));
  if (random() < 0.2 && Object.keys(state).length > 0) {
    return {
      op: 'replaceAll',
      rows: rows.filter((row) => row.channel !== choose(random, Object.keys(state)))
    };
  }
  return { op: 'replaceAll', rows };
}

function fuzzPayload(
  random: () => number,
  seed: number,
  step: number,
  channel: string
): JsonValue | undefined {
  if (random() < 0.08) return undefined;
  if (channel === 'cursor' || channel === 'selection') {
    return objectReferencePayload(seed, step);
  }

  switch (randomInt(random, 4)) {
    case 0:
      return `value-${seed.toString(16)}-${step}`;
    case 1:
      return randomInt(random, 10);
    case 2:
      return random() < 0.5;
    default:
      return { state: `step-${step}`, nested: { channel } };
  }
}

function objectReferencePayload(seed: number, step: number): JsonValue {
  return {
    objectId: `${seed.toString(16)}:${step}@actor`,
    path: ['tasks', step % 3, step % 2 === 0 ? 'title' : 'body'],
    heads: [`${step}@actor`, `${step + 1}@actor`],
    relation: 'tasks',
    key: `task-${step % 5}`
  };
}

function modelRows(state: PresenceChannels): readonly NormalizedRow[] {
  return Object.entries(state)
    .filter(([, payload]) => payload !== undefined)
    .map(([topic, payload]) => ({ peer: localPeer, topic, payload, isLocal: true }))
    .sort(compareRows);
}

function normalizedRows(rows: readonly unknown[]): readonly NormalizedRow[] {
  return rows.map((row) => {
    expect(row).toEqual(expect.objectContaining({ peer: expect.any(String), topic: expect.any(String) }));
    const presenceRow = row as PresenceRow;
    return {
      peer: presenceRow.peer,
      topic: presenceRow.topic,
      payload: presenceRow.payload,
      isLocal: presenceRow.isLocal
    };
  }).sort(compareRows);
}

function normalizeState(state: PresenceChannels): PresenceChannels {
  return Object.fromEntries(Object.entries(state));
}

function diffRows(before: readonly NormalizedRow[], after: readonly NormalizedRow[]) {
  const afterByKey = new Map(after.map((row) => [rowKey(row), row]));
  const beforeByKey = new Map(before.map((row) => [rowKey(row), row]));
  const removed = before.filter((row) => {
    const next = afterByKey.get(rowKey(row));
    return next === undefined || !jsonEqual(row, next);
  });
  const added = after.filter((row) => {
    const previous = beforeByKey.get(rowKey(row));
    return previous === undefined || !jsonEqual(previous, row);
  });
  return { added, removed };
}

function rowKey(row: NormalizedRow): string {
  return JSON.stringify([row.peer, row.topic]);
}

function compareRows(left: NormalizedRow, right: NormalizedRow): number {
  return rowKey(left).localeCompare(rowKey(right));
}

function rowsEqual(left: readonly NormalizedRow[], right: readonly NormalizedRow[]): boolean {
  return jsonEqual(left, right);
}

function jsonEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function message(seed: number, step: number, operation: FuzzOperation): string {
  return `seed=${seed.toString(16)} step=${step} op=${JSON.stringify(operation)}`;
}

function realDocHandle(seed: number): DocHandle<PresenceDoc> {
  const repo = new Repo({ peerId: `${localPeer}-${seed}` as never });
  return repo.create<PresenceDoc>({ presence: {} });
}
