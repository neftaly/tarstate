import fc from 'fast-check';
import { expect } from 'vitest';
import { sealArtifact, type Artifact } from '../src/artifacts.js';
import { prepareDatabaseAttachment } from '../src/attachment/preparation.js';
import { createAttachmentTransactionService } from '../src/attachment/transaction-service.js';
import { createIssue } from '../src/issues.js';
import type { WritableLogicalState } from '../src/logical-edit.js';
import { capabilityRefFor, CapabilityRegistry, type CapabilityDeclaration } from '../src/registry.js';
import { sealSchema } from '../src/schema.js';
import { relationLiteral } from '../src/schema-authoring.js';
import type {
  SourceCommitInput,
  SourceCommitResult,
  StagedBasisAtomicSource
} from '../src/source-protocol.js';
import { propertyTest } from './support/property-test.js';
import {
  LogicalMemoryAtomicSource,
  LogicalMemoryStorageBinding,
  type LogicalMemoryCommand,
  type MemoryState
} from './fixtures/logical-memory-adapter.js';

const relationId = 'fuzz.counter';
const replaceDeclaration: CapabilityDeclaration = {
  kind: 'tarstate.capability-contract',
  formatVersion: 1,
  id: 'urn:test:attachment-transaction-fuzz:replace',
  version: '1',
  class: 'edit',
  contract: { operation: 'replace' },
  implies: []
};
const replace = await capabilityRefFor(replaceDeclaration);
const schema = await sealSchema({
  id: 'urn:test:attachment-transaction-fuzz:schema',
  body: { relations: { counters: {
    relationId,
    key: ['id'],
    fields: {
      id: { type: { kind: 'string' } },
      value: { type: { kind: 'number' }, editCapabilities: [replace] }
    }
  } } }
});
const counters = relationLiteral(schema, 'counters');
const mapping = await sealArtifact({
  kind: 'storage-mapping',
  id: 'urn:test:attachment-transaction-fuzz:mapping',
  body: {
    schema: reference(schema),
    model: 'json-tree-v1',
    relations: { [relationId]: {
      collection: { kind: 'object-map', path: ['counters'], absent: 'empty' },
      keys: { id: { kind: 'field', path: ['id'] } },
      fields: { value: { path: ['value'], write: { replace } } }
    } }
  }
});
const registry = new CapabilityRegistry('trust:attachment-transaction-fuzz');
await registry.registerDeclaration(replaceDeclaration);
registry.registerImplementation({ ref: replace, integrity: 'test:replace', implementation: {} });
const artifacts = new Map<string, Artifact>([schema, mapping].map((artifact) => [artifact.id, artifact]));
const preparation = await prepareDatabaseAttachment<WritableLogicalState>({
  sourceId: 'source:attachment-transaction-fuzz',
  bootstrap: { status: 'ready', declaration: {
    formatVersion: 1,
    storageSchema: reference(schema),
    projection: { kind: 'storage-mapping', storageMapping: reference(mapping) }
  } },
  resolveArtifact: (artifact) => artifacts.get(artifact.id),
  registry
});
if (preparation.state !== 'ready') throw new Error('Expected ready fuzz attachment preparation');

type FinalHandoff = 'committed' | 'unknown-before' | 'unknown-after' | 'aborted';

propertyTest('replayable attachment transactions preserve state and honest outcomes across source schedules', fc.asyncProperty(
  fc.integer({ min: -100, max: 100 }),
  fc.integer({ min: -10, max: 10 }).filter((value) => value !== 0),
  fc.array(fc.integer({ min: -10, max: 10 }).filter((value) => value !== 0), { maxLength: 5 }),
  fc.constantFrom<FinalHandoff>('committed', 'unknown-before', 'unknown-after', 'aborted'),
  async (initialValue, operationDelta, concurrentDeltas, finalHandoff) => {
    const base = new LogicalMemoryAtomicSource({
      sourceId: 'source:attachment-transaction-fuzz',
      incarnation: 'incarnation:attachment-transaction-fuzz',
      operationEpoch: 'epoch:attachment-transaction-fuzz',
      state: stateWithValue(initialValue)
    });
    let nextConcurrent = 0;
    const source = scheduledSource(base, async (input) => {
      const concurrentDelta = concurrentDeltas[nextConcurrent];
      if (concurrentDelta !== undefined) {
        nextConcurrent += 1;
        const concurrent = await base.commit({
          operationEpoch: input.operationEpoch,
          operationId: 'concurrent:' + nextConcurrent,
          intentHash: hash(nextConcurrent),
          expectedBasis: input.expectedBasis,
          commands: [{
            description: 'concurrent increment',
            apply: (state) => stateWithValue(readValue(state) + concurrentDelta)
          }]
        });
        expect(concurrent.outcome).toBe('committed');
        return base.commit(input);
      }
      if (finalHandoff === 'unknown-before') return unknownResult();
      const committed = await base.commit(input);
      if (finalHandoff === 'unknown-after') return unknownResult();
      return committed;
    });
    const binding = new LogicalMemoryStorageBinding({
      relations: [{ relationId, keyFields: ['id'], replaceFields: ['value'] }]
    });
    const service = await createAttachmentTransactionService({
      attachmentId: 'attachment:transaction-fuzz',
      attachmentIncarnation: 'attachment-incarnation:transaction-fuzz',
      authorityScope: 'scope:transaction-fuzz',
      preparation,
      source,
      bindings: [binding],
      registry,
      durability: 'memory'
    });
    const abort = new AbortController();
    if (finalHandoff === 'aborted') abort.abort();
    let authorCalls = 0;
    const receipt = await service.transact(
      { kind: 'increment', amount: operationDelta },
      (snapshot) => {
        authorCalls += 1;
        const rows = snapshot.rows(counters);
        return snapshot.withRows(counters, rows.map((row) => ({
          ...row,
          value: row.value + operationDelta
        })));
      },
      { signal: abort.signal }
    );
    const concurrentTotal = concurrentDeltas.reduce((total, value) => total + value, 0);

    if (finalHandoff === 'aborted') {
      expect(receipt).toMatchObject({
        outcome: 'rejected',
        issues: [{ code: 'transaction.cancelled' }]
      });
      expect(authorCalls).toBe(1);
      expect(readValue(readyMemoryState(base))).toBe(initialValue);
      return;
    }

    expect(authorCalls).toBe(concurrentDeltas.length + 1);
    if (finalHandoff === 'committed') {
      expect(receipt.outcome).toBe('committed');
      expect(readValue(readyMemoryState(base))).toBe(
        initialValue + concurrentTotal + operationDelta
      );
      return;
    }

    expect(receipt.outcome).toBe('unknown');
    expect(readValue(readyMemoryState(base))).toBe(
      initialValue + concurrentTotal + (finalHandoff === 'unknown-after' ? operationDelta : 0)
    );
  }
));

const scheduledSource = (
  source: LogicalMemoryAtomicSource,
  commit: (input: SourceCommitInput<LogicalMemoryCommand>) => Promise<SourceCommitResult>
): StagedBasisAtomicSource<MemoryState, LogicalMemoryCommand> => ({
  sourceId: source.sourceId,
  snapshot: source.snapshot,
  subscribe: source.subscribe,
  commit,
  relateFootprints: source.relateFootprints,
  mergeIntents: source.mergeIntents,
  stage: source.stage,
  basisForStagedStorage: source.basisForStagedStorage,
  queryOutcome: source.queryOutcome
});

const stateWithValue = (value: number): MemoryState => Object.freeze({
  [relationId]: Object.freeze([Object.freeze({ id: 'counter', value })])
});

const readValue = (state: MemoryState): number =>
  state[relationId]?.[0]?.value as number;

const readyMemoryState = (source: LogicalMemoryAtomicSource): MemoryState => {
  const snapshot = source.snapshot();
  if (snapshot.state !== 'ready') throw new Error('Expected ready logical memory source');
  return snapshot.storage;
};

const unknownResult = (): SourceCommitResult => ({
  outcome: 'unknown',
  issues: [createIssue({
    code: 'transaction.outcome_unavailable',
    phase: 'commit',
    severity: 'error',
    retry: 'query_outcome'
  })]
});

function hash(value: number): `sha256:${string}` {
  return `sha256:${(value & 15).toString(16).repeat(64)}`;
}

function reference(artifact: Artifact) {
  return { id: artifact.id, contentHash: artifact.contentHash };
}
