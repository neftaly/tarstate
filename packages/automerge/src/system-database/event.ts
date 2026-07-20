import {
  safeParseJsonValue,
  TarstateParseError,
  type JsonValue
} from '@tarstate/core';
import type {
  AutomergeConflictSystemRow,
  AutomergeSystemEvent,
  AutomergeSyncState
} from '../system-relations.js';

const syncStates = new Set<AutomergeSyncState>([
  'observed',
  'offline',
  'idle',
  'syncing',
  'synced',
  'error'
]);
const eventKeys = Object.freeze({
  peerObserved: ['kind', 'peerId', 'observedAt', 'peerMetadata'],
  peerDisconnected: ['kind', 'peerId', 'observedAt'],
  syncState: [
    'kind',
    'documentId',
    'storageId',
    'state',
    'observedAt',
    'heads',
    'peerId',
    'errorCode'
  ],
  remoteHeads: [
    'kind',
    'documentId',
    'storageId',
    'heads',
    'observedAt',
    'peerId'
  ],
  presenceSet: [
    'kind',
    'peerId',
    'channel',
    'origin',
    'value',
    'observedAt'
  ],
  presenceStop: ['kind', 'peerId', 'observedAt', 'reason'],
  conflictsReplaced: ['kind', 'rows'],
  peerMetadata: ['storageId', 'isEphemeral', 'metadata'],
  conflictRow: [
    'issueId',
    'attachmentId',
    'sourceId',
    'relationId',
    'logicalKey',
    'path',
    'basis',
    'alternatives',
    'alternativeCount',
    'alternativesTruncated'
  ]
} as const);

/** Adopts one typed host observation into bounded, owned portable data. */
export const adoptAutomergeSystemEvent = (
  input: AutomergeSystemEvent
): AutomergeSystemEvent => {
  const parsed = safeParseJsonValue(input);
  if (!parsed.success) throw new TarstateParseError(parsed.issues);
  const event = record(parsed.value, 'event');
  const kind = string(event.kind, 'event.kind');

  if (kind === 'peer-observed') {
    exactKeys(event, eventKeys.peerObserved);
    const peerMetadata = event.peerMetadata === undefined
      ? undefined
      : adoptPeerMetadata(event.peerMetadata);
    return Object.freeze({
      kind,
      peerId: identifier(event.peerId, 'event.peerId'),
      observedAt: eventTime(event.observedAt),
      ...(peerMetadata === undefined ? {} : { peerMetadata })
    });
  }
  if (kind === 'peer-disconnected') {
    exactKeys(event, eventKeys.peerDisconnected);
    return Object.freeze({
      kind,
      peerId: identifier(event.peerId, 'event.peerId'),
      observedAt: eventTime(event.observedAt)
    });
  }
  if (kind === 'sync-state') {
    exactKeys(event, eventKeys.syncState);
    const state = string(event.state, 'event.state');
    if (!syncStates.has(state as AutomergeSyncState)) invalid('event.state');
    return Object.freeze({
      kind,
      documentId: identifier(event.documentId, 'event.documentId'),
      storageId: identifier(event.storageId, 'event.storageId'),
      state: state as AutomergeSyncState,
      observedAt: eventTime(event.observedAt),
      ...(event.heads === undefined ? {} : { heads: headArray(event.heads) }),
      ...(event.peerId === undefined ? {} : {
        peerId: identifier(event.peerId, 'event.peerId')
      }),
      ...(event.errorCode === undefined ? {} : {
        errorCode: identifier(event.errorCode, 'event.errorCode')
      })
    });
  }
  if (kind === 'remote-heads-observed') {
    exactKeys(event, eventKeys.remoteHeads);
    return Object.freeze({
      kind,
      documentId: identifier(event.documentId, 'event.documentId'),
      storageId: identifier(event.storageId, 'event.storageId'),
      heads: headArray(event.heads),
      observedAt: eventTime(event.observedAt),
      ...(event.peerId === undefined ? {} : {
        peerId: identifier(event.peerId, 'event.peerId')
      })
    });
  }
  if (kind === 'presence-set') {
    exactKeys(event, eventKeys.presenceSet);
    const originValue = string(event.origin, 'event.origin');
    const origin = originValue === 'local' || originValue === 'observed'
      ? originValue
      : invalid('event.origin');
    if (!Object.hasOwn(event, 'value')) invalid('event.value');
    return Object.freeze({
      kind,
      peerId: identifier(event.peerId, 'event.peerId'),
      channel: identifier(event.channel, 'event.channel'),
      origin,
      value: event.value as JsonValue,
      observedAt: eventTime(event.observedAt)
    });
  }
  if (kind === 'presence-heartbeat') {
    exactKeys(event, eventKeys.peerDisconnected);
    return Object.freeze({
      kind,
      peerId: identifier(event.peerId, 'event.peerId'),
      observedAt: eventTime(event.observedAt)
    });
  }
  if (kind === 'presence-stop') {
    exactKeys(event, eventKeys.presenceStop);
    const reasonValue = string(event.reason, 'event.reason');
    const reason = reasonValue === 'goodbye' || reasonValue === 'expired'
      ? reasonValue
      : invalid('event.reason');
    return Object.freeze({
      kind,
      peerId: identifier(event.peerId, 'event.peerId'),
      observedAt: eventTime(event.observedAt),
      reason
    });
  }
  if (kind === 'conflicts-replaced') {
    exactKeys(event, eventKeys.conflictsReplaced);
    const rows = array(event.rows, 'event.rows');
    return Object.freeze({
      kind,
      rows: Object.freeze(rows.map((row, index) =>
        adoptConflictRow(row, `event.rows[${index}]`)))
    });
  }
  return invalid('event.kind');
};

const adoptPeerMetadata = (
  input: JsonValue
): NonNullable<Extract<AutomergeSystemEvent, {
  readonly kind: 'peer-observed';
}>['peerMetadata']> => {
  const metadata = record(input, 'event.peerMetadata');
  exactKeys(metadata, eventKeys.peerMetadata);
  const isEphemeral = metadata.isEphemeral === undefined
    ? undefined
    : boolean(metadata.isEphemeral, 'event.peerMetadata.isEphemeral');
  return Object.freeze({
    ...(metadata.storageId === undefined ? {} : {
      storageId: identifier(metadata.storageId, 'event.peerMetadata.storageId')
    }),
    ...(isEphemeral === undefined ? {} : {
      isEphemeral
    }),
    ...(metadata.metadata === undefined ? {} : { metadata: metadata.metadata })
  });
};

const adoptConflictRow = (
  input: JsonValue,
  path: string
): AutomergeConflictSystemRow => {
  const row = record(input, path);
  exactKeys(row, eventKeys.conflictRow);
  if (!Object.hasOwn(row, 'path')) invalid(path + '.path');
  if (!Object.hasOwn(row, 'basis')) invalid(path + '.basis');
  if (!Object.hasOwn(row, 'alternatives')) invalid(path + '.alternatives');
  if (!Number.isSafeInteger(row.alternativeCount)
    || (row.alternativeCount as number) < 0) {
    invalid(path + '.alternativeCount');
  }
  const alternativesTruncated = boolean(
    row.alternativesTruncated,
    path + '.alternativesTruncated'
  );
  return Object.freeze({
    issueId: identifier(row.issueId, path + '.issueId'),
    attachmentId: identifier(row.attachmentId, path + '.attachmentId'),
    sourceId: identifier(row.sourceId, path + '.sourceId'),
    ...(row.relationId === undefined ? {} : {
      relationId: identifier(row.relationId, path + '.relationId')
    }),
    ...(row.logicalKey === undefined ? {} : { logicalKey: row.logicalKey }),
    path: row.path as JsonValue,
    basis: row.basis as JsonValue,
    alternatives: row.alternatives as JsonValue,
    alternativeCount: row.alternativeCount as number,
    alternativesTruncated
  });
};

const record = (
  input: JsonValue,
  path: string
): Readonly<Record<string, JsonValue | undefined>> => {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    return invalid(path);
  }
  return input as Readonly<Record<string, JsonValue>>;
};

const exactKeys = (
  input: Readonly<Record<string, JsonValue | undefined>>,
  allowed: readonly string[]
): void => {
  for (const key in input) {
    if (Object.hasOwn(input, key) && !allowed.includes(key)) invalid('event');
  }
};

const identifier = (input: JsonValue | undefined, path: string): string => {
  const value = string(input, path);
  if (value.length === 0) invalid(path);
  return value;
};

const string = (input: JsonValue | undefined, path: string): string => {
  if (typeof input !== 'string') return invalid(path);
  return input;
};

const eventTime = (input: JsonValue | undefined): number => {
  if (!Number.isSafeInteger(input) || (input as number) < 0) {
    return invalid('event.observedAt');
  }
  return input as number;
};

const boolean = (input: JsonValue | undefined, path: string): boolean => {
  if (typeof input !== 'boolean') return invalid(path);
  return input;
};

const array = (
  input: JsonValue | undefined,
  path: string
): readonly JsonValue[] => {
  if (!Array.isArray(input)) return invalid(path);
  return input;
};

const headArray = (input: JsonValue | undefined): readonly string[] => {
  const values = array(input, 'event.heads');
  for (const [index, head] of values.entries()) {
    identifier(head, `event.heads[${index}]`);
  }
  return values as readonly string[];
};

const invalid = (path: string): never => {
  throw new TypeError(`Invalid Automerge system observation at ${path}`);
};
