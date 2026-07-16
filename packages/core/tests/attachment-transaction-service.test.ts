import { describe, expect, it, vi } from 'vitest';
import { sealArtifact, type Artifact } from '../src/artifacts.js';
import { prepareDatabaseAttachment } from '../src/attachment/preparation.js';
import {
  createAttachmentTransactionService
} from '../src/attachment/transaction-service.js';
import type { DatabaseTransactionSnapshot } from '../src/database/transaction.js';
import { capabilityRefFor, CapabilityRegistry, type CapabilityDeclaration } from '../src/registry.js';
import { sealSchema } from '../src/schema.js';
import { relationLiteral } from '../src/schema-authoring.js';
import type { WritableLogicalState } from '../src/logical-edit.js';
import {
  LogicalMemoryAtomicSource,
  LogicalMemoryStorageBinding
} from './fixtures/logical-memory-adapter.js';

const replaceDeclaration: CapabilityDeclaration = {
  kind: 'tarstate.capability-contract',
  formatVersion: 1,
  id: 'urn:test:attachment-transactions:replace',
  version: '1',
  class: 'edit',
  contract: { operation: 'replace' },
  implies: []
};

describe('attachment transaction service', () => {
  it('derives exact deltas and replays the pure transform after a concurrent change', async () => {
    const replace = await capabilityRefFor(replaceDeclaration);
    const schema = await sealSchema({
      id: 'urn:test:attachment-transactions:schema',
      body: { relations: { items: {
        relationId: 'test.item',
        key: ['id'],
        fields: {
          id: { type: { kind: 'string' } },
          title: { type: { kind: 'string' }, editCapabilities: [replace] },
          count: { type: { kind: 'number' } }
        }
      } } }
    });
    const items = relationLiteral(schema, 'items');
    const mapping = await sealArtifact({
      kind: 'storage-mapping',
      id: 'urn:test:attachment-transactions:mapping',
      body: {
        schema: reference(schema),
        model: 'json-tree-v1',
        relations: { 'test.item': {
          collection: { kind: 'object-map', path: ['items'], absent: 'empty' },
          keys: { id: { kind: 'field', path: ['id'] } },
          fields: {
            title: { path: ['title'], write: { kind: 'replace', capability: replace } },
            count: { path: ['count'], write: { kind: 'read-only' } }
          }
        } }
      }
    });
    const registry = new CapabilityRegistry('trust:attachment-transactions');
    await registry.registerDeclaration(replaceDeclaration);
    registry.registerImplementation({ ref: replace, integrity: 'test:replace', implementation: {} });
    const artifacts = new Map<string, Artifact>([schema, mapping].map((artifact) => [artifact.id, artifact]));
    const preparation = await prepareDatabaseAttachment<WritableLogicalState>({
      sourceId: 'source:attachment-transactions',
      bootstrap: { status: 'ready', declaration: {
        formatVersion: 1,
        storageSchema: reference(schema),
        projection: { kind: 'storage-mapping', storageMapping: reference(mapping) }
      } },
      resolveArtifact: (artifact) => artifacts.get(artifact.id),
      registry
    });
    if (preparation.state !== 'ready') throw new Error('Expected a ready attachment');
    expect(preparation.relations.get('test.item')).toEqual({
      relationId: 'test.item',
      keyFields: ['id'],
      replaceableFields: ['title']
    });
    const source = new LogicalMemoryAtomicSource({
      sourceId: 'source:attachment-transactions',
      incarnation: 'source-incarnation:attachment-transactions',
      operationEpoch: 'epoch:attachment-transactions',
      state: { 'test.item': [{ id: 'one', title: 'Old', count: 1 }] }
    });
    const binding = new LogicalMemoryStorageBinding({ relations: [{ relationId: 'test.item', keyFields: ['id'] }] });
    const service = await createAttachmentTransactionService({
      attachmentId: 'attachment:transactions',
      attachmentIncarnation: 'attachment-incarnation:transactions',
      authorityScope: 'scope:transactions',
      preparation,
      source,
      bindings: [binding],
      registry,
      durability: 'memory'
    });
    await expect(service.simulate(
      { kind: 'preview-title' },
      (snapshot) => snapshot.withRows(
        items,
        snapshot.rows(items).map((row) => ({ ...row, title: 'Preview' }))
      )
    )).resolves.toMatchObject({ outcome: 'would-commit', statementResults: [{ logicallyChanged: 1 }] });
    await expect(service.simulate(
      { kind: 'preview-no-op' },
      (snapshot) => snapshot
    )).resolves.toMatchObject({ outcome: 'would-commit', statementResults: [] });
    expect(source.snapshot()).toMatchObject({ storage: { 'test.item': [{ title: 'Old', count: 1 }] } });
    const commitDirect = source.commit;
    vi.spyOn(source, 'commit').mockImplementationOnce(async (input) => {
      await commitDirect({
        operationEpoch: input.operationEpoch,
        operationId: 'operation:concurrent',
        intentHash: `sha256:${'9'.repeat(64)}`,
        expectedBasis: input.expectedBasis,
        commands: [{
          description: 'concurrent count',
          apply: (state) => Object.freeze({
            ...state,
            'test.item': Object.freeze([Object.freeze({ id: 'one', title: 'Old', count: 2 })])
          })
        }]
      });
      return commitDirect(input);
    });
    const transform = vi.fn((snapshot: DatabaseTransactionSnapshot) => snapshot.withRows(
      items,
      snapshot.rows(items).map((row) => ({ ...row, title: `Count:${row.count}` }))
    ));

    const receipt = await service.transact(
      { kind: 'set-title-from-count' },
      transform
    );

    expect(receipt).toMatchObject({ outcome: 'committed', statementResults: [{ logicallyChanged: 1 }] });
    expect(source.snapshot()).toMatchObject({
      storage: { 'test.item': [{ id: 'one', title: 'Count:2', count: 2 }] }
    });
    expect(transform).toHaveBeenCalledTimes(2);

    vi.spyOn(source, 'commit').mockImplementationOnce(async (input) => {
      await commitDirect({
        operationEpoch: input.operationEpoch,
        operationId: 'operation:concurrent-again',
        intentHash: `sha256:${'8'.repeat(64)}`,
        expectedBasis: input.expectedBasis,
        commands: [{
          description: 'second concurrent count',
          apply: (state) => Object.freeze({
            ...state,
            'test.item': Object.freeze([Object.freeze({ id: 'one', title: 'Count:2', count: 3 })])
          })
        }]
      });
      return commitDirect(input);
    });
    let replayCount = 0;
    const replayFailure = await service.transact(
      { kind: 'fail-on-replay' },
      (snapshot) => {
        replayCount += 1;
        if (replayCount > 1) throw new Error('impure replay');
        return snapshot.withRows(
          items,
          snapshot.rows(items).map((row) => ({ ...row, title: 'Never committed' }))
        );
      }
    );
    expect(replayFailure).toMatchObject({
      outcome: 'rejected',
      issues: [{ code: 'transaction.unexpected_failure', details: { timing: 'reconciliation', error: 'Error' } }]
    });

    await expect(service.transact(
      { kind: 'initial-author-failure' },
      () => { throw new Error('initial author failure'); }
    )).rejects.toThrow('initial author failure');
    await expect(service.simulate(
      { kind: 'invalid-transform-output' },
      () => null as unknown as DatabaseTransactionSnapshot
    )).rejects.toThrow('must return a snapshot');
    await expect(service.simulate(
      { kind: 'invalid-replacement-row' },
      (snapshot) => snapshot.withRows(items, [{ id: 'one', title: 4, count: 3 } as never])
    )).rejects.toMatchObject({ name: 'TarstateParseError' });
    expect(source.snapshot()).toMatchObject({
      storage: { 'test.item': [{ id: 'one', title: 'Count:2', count: 3 }] }
    });
  });
});

const reference = (artifact: Artifact) => ({ id: artifact.id, contentHash: artifact.contentHash });
