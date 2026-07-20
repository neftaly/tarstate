import fc from 'fast-check';
import { TarstateParseError } from '@tarstate/core';
import { describe, expect } from 'vitest';
import { propertyTest } from '../../core/tests/support/property-test.js';
import { adoptAutomergeSystemEvent } from '../src/system-database/event.js';
import {
  AutomergeSystemRelationState,
  type AutomergeSystemEvent,
  type AutomergeSystemRelationSnapshot
} from '../src/system-relations.js';

const id = fc.constantFrom('one', 'two', 'three');
const observedAt = fc.nat({ max: 8 });
const syncState = fc.constantFrom(
  'observed' as const,
  'offline' as const,
  'idle' as const,
  'syncing' as const,
  'synced' as const,
  'error' as const
);

const event: fc.Arbitrary<AutomergeSystemEvent> = fc.oneof(
  fc.record({
    kind: fc.constant('peer-observed' as const),
    peerId: id,
    observedAt,
    peerMetadata: fc.option(fc.record({
      storageId: id,
      isEphemeral: fc.boolean(),
      metadata: fc.record({ transport: id })
    }), { nil: undefined })
  }).map(({ peerMetadata, ...observation }) => peerMetadata === undefined
    ? observation
    : { ...observation, peerMetadata }),
  fc.record({
    kind: fc.constant('peer-disconnected' as const),
    peerId: id,
    observedAt
  }),
  fc.record({
    kind: fc.constant('sync-state' as const),
    documentId: id,
    storageId: id,
    state: syncState,
    observedAt,
    heads: fc.array(id, { maxLength: 3 }),
    peerId: fc.option(id, { nil: undefined }),
    errorCode: fc.option(id, { nil: undefined })
  }).map(({ heads, peerId, errorCode, ...observation }) => ({
    ...observation,
    heads,
    ...(peerId === undefined ? {} : { peerId }),
    ...(errorCode === undefined ? {} : { errorCode })
  })),
  fc.record({
    kind: fc.constant('remote-heads-observed' as const),
    documentId: id,
    storageId: id,
    heads: fc.array(id, { maxLength: 3 }),
    observedAt,
    peerId: fc.option(id, { nil: undefined })
  }).map(({ peerId, ...observation }) => peerId === undefined
    ? observation
    : { ...observation, peerId }),
  fc.record({
    kind: fc.constant('presence-set' as const),
    peerId: id,
    channel: id,
    origin: fc.constantFrom('local' as const, 'observed' as const),
    value: fc.integer({ min: -3, max: 3 }),
    observedAt
  }),
  fc.record({
    kind: fc.constant('presence-heartbeat' as const),
    peerId: id,
    observedAt
  }),
  fc.record({
    kind: fc.constant('presence-stop' as const),
    peerId: id,
    observedAt,
    reason: fc.constantFrom('goodbye' as const, 'expired' as const)
  })
);

describe('Automerge system observation properties', () => {
  propertyTest('fact observations normalize independently of delivery order', fc.property(
    fc.array(event, { maxLength: 32 }),
    (events) => {
      const forward = apply(events);
      const reversed = apply([...events].reverse());
      expect(withoutRevision(reversed)).toEqual(withoutRevision(forward));
    }
  ));

  propertyTest('host event adoption either owns a valid event or rejects it explicitly', fc.property(
    fc.jsonValue({ maxDepth: 5 }),
    (input) => {
      try {
        const adopted = adoptAutomergeSystemEvent(input as never);
        expect(Object.isFrozen(adopted)).toBe(true);
        const state = new AutomergeSystemRelationState('attachment:fuzz-adoption');
        expect(() => state.apply(adopted)).not.toThrow();
      } catch (error) {
        expect(error instanceof TypeError || error instanceof TarstateParseError).toBe(true);
      }
    }
  ));
});

const apply = (
  events: readonly AutomergeSystemEvent[]
): AutomergeSystemRelationSnapshot => {
  const state = new AutomergeSystemRelationState('attachment:fuzz');
  for (const observation of events) state.apply(observation);
  return state.getSnapshot();
};

const withoutRevision = ({
  peers,
  connections,
  sync,
  conflicts,
  presence
}: AutomergeSystemRelationSnapshot) => ({
  peers,
  connections,
  sync,
  conflicts,
  presence
});
