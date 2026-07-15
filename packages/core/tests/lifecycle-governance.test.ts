import { describe, expect, it, vi } from 'vitest';
import { createIssue, type CapabilityRef, type Issue } from '../src/issues.js';
import {
  GovernanceCoordinator,
  SourceOperationLedger,
  SourceLifecycleCoordinator,
  governanceCommandHash,
  lifecycleCommandHash,
  type GovernanceCommand,
  type GovernanceConstraintSection,
  type GovernanceStorageSection,
  type LifecycleMutationResult,
  type SourceLifecycleAdapter
} from '../src/lifecycle-governance.js';
import { executeSequence, type SourceLifecycleCommand } from '../src/receipts.js';

const hash = (character: string) => `sha256:${character.repeat(64)}` as const;
const authorityFingerprint = hash('a');
const sourceCapability: CapabilityRef = { id: 'urn:test:source', version: '1', contractHash: hash('b') };
const schema = { id: 'urn:test:schema', contentHash: hash('c') };
const mapping = { id: 'urn:test:mapping', contentHash: hash('d') };
const constraints = { id: 'urn:test:constraints', contentHash: hash('e') };

const lifecycleCommand = (operationId: string, request: SourceLifecycleCommand['request'] = { action: 'create', sourceCapability, input: { title: 'new' } }): SourceLifecycleCommand => ({
  lifecycleCoordinatorId: 'lifecycle:test',
  operationEpoch: 'lifecycle:epoch:one',
  operationId,
  request
});

const storageSection = (storageSchema = schema): GovernanceStorageSection => ({
  kind: 'storage',
  storageSchema,
  projection: { kind: 'storage-mapping', storageMapping: mapping }
});

const constraintSection = (set = constraints, mode: GovernanceConstraintSection['mode'] = 'required'): GovernanceConstraintSection => ({ kind: 'constraints', set, mode });

const governanceCommand = (operationId: string, request: GovernanceCommand['request'] = {
  action: 'initialize_declaration',
  declaration: {
    formatVersion: 1,
    storageSchema: schema,
    projection: { kind: 'storage-mapping', storageMapping: mapping },
    constraints: { set: constraints, mode: 'required' }
  }
}): GovernanceCommand => ({
  operationEpoch: 'governance:epoch:one',
  operationId,
  sourceId: 'source:one',
  expectedBasis: { incarnation: 'one', revision: 0 },
  request
});

const deniedIssue = (): Issue => createIssue({ code: 'test.denied', phase: 'governance', severity: 'error', retry: 'after_authority' });

describe('source operation ledger identity', () => {
  it('keeps delimiter-bearing epoch and operation tuples distinct across retirement', () => {
    const firstEpoch = 'epoch';
    const firstOperationId = 'operation\u0000tail';
    const secondEpoch = 'epoch\u0000operation';
    const secondOperationId = 'tail';
    expect(firstEpoch + '\u0000' + firstOperationId).toBe(secondEpoch + '\u0000' + secondOperationId);

    const ledger = new SourceOperationLedger<string>(firstEpoch);
    const first = ledger.reserve(firstEpoch, firstOperationId, hash('1'));
    if (first.status !== 'reserved') throw new Error('expected first reservation');
    expect(() => ledger.rotateEpoch(secondEpoch)).toThrow(/pending operation/);
    ledger.complete(first.entry, 'first receipt');
    expect(ledger.lookup(firstEpoch, firstOperationId, hash('1'))).toEqual({ status: 'known', receipt: 'first receipt' });

    ledger.rotateEpoch(secondEpoch);
    expect(ledger.lookup(firstEpoch, firstOperationId, hash('1'))).toEqual({ status: 'expired' });
    const second = ledger.reserve(secondEpoch, secondOperationId, hash('2'));
    if (second.status !== 'reserved') throw new Error('expected second reservation');
    ledger.complete(second.entry, 'second receipt');
    expect(ledger.lookup(secondEpoch, secondOperationId, hash('2'))).toEqual({ status: 'known', receipt: 'second receipt' });
  });

  it('bounds exact replay and retired-epoch evidence without evicting it', () => {
    const ledger = new SourceOperationLedger<string>('epoch:one', { maxEntries: 1, maxRetiredEpochs: 1 });
    const first = ledger.reserve('epoch:one', 'operation:one', hash('1'));
    if (first.status !== 'reserved') throw new Error('expected first reservation');
    ledger.complete(first.entry, 'first receipt');
    expect(() => ledger.reserve('epoch:one', 'operation:two', hash('2'))).toThrow(/capacity exhausted/);
    expect(ledger.lookup('epoch:one', 'operation:one', hash('1'))).toEqual({ status: 'known', receipt: 'first receipt' });

    ledger.rotateEpoch('epoch:two');
    const second = ledger.reserve('epoch:two', 'operation:two', hash('2'));
    if (second.status !== 'reserved') throw new Error('expected second reservation');
    ledger.complete(second.entry, 'second receipt');
    expect(() => ledger.rotateEpoch('epoch:three')).toThrow(/retired-epoch capacity exhausted/);
    expect(ledger.lookup('epoch:two', 'operation:two', hash('2'))).toEqual({ status: 'known', receipt: 'second receipt' });
  });
});

describe('source lifecycle coordination', () => {
  it('returns command-invalid receipts for malformed nested lifecycle requests', async () => {
    const authorize = vi.fn(() => ({ allowed: true } as const));
    const allocateSourceId = vi.fn(() => 'source:new');
    const coordinator = new SourceLifecycleCoordinator({
      lifecycleCoordinatorId: 'lifecycle:test', operationEpoch: 'lifecycle:epoch:one', authorityViewFingerprint: authorityFingerprint,
      authorize,
      adapter: { allocateSourceId, create: () => ({ outcome: 'committed', issues: [] }), delete: () => ({ outcome: 'committed', issues: [] }) }
    });
    const malformedRequests: readonly unknown[] = [
      { action: 'create', sourceCapability: null, input: {} },
      { action: 'create', sourceCapability },
      { action: 'delete', sourceId: null },
      { action: 'unknown' }
    ];

    for (const [index, request] of malformedRequests.entries()) {
      const command = { ...lifecycleCommand('malformed:' + index), request } as unknown as SourceLifecycleCommand;
      await expect(coordinator.execute(command)).resolves.toMatchObject({
        kind: 'source-lifecycle', outcome: 'rejected', issues: [{ code: 'lifecycle.command_invalid' }]
      });
    }
    await expect(coordinator.execute({
      ...lifecycleCommand('malformed:unicode'),
      request: { action: 'create', sourceCapability, input: '\ud800' }
    })).resolves.toMatchObject({
      kind: 'source-lifecycle', outcome: 'rejected', issues: [{ code: 'lifecycle.command_invalid' }]
    });
    expect(authorize).not.toHaveBeenCalled();
    expect(allocateSourceId).not.toHaveBeenCalled();
  });

  it('keeps authority, preflight, and cancellation rejection before handoff', async () => {
    const allocateSourceId = vi.fn(() => 'source:new');
    const create = vi.fn((): LifecycleMutationResult => ({ outcome: 'committed', durability: 'memory', issues: [] }));
    const command = lifecycleCommand('denied');
    const denied = new SourceLifecycleCoordinator({
      lifecycleCoordinatorId: 'lifecycle:test', operationEpoch: command.operationEpoch, authorityViewFingerprint: authorityFingerprint,
      authorize: () => ({ allowed: false, issues: [deniedIssue()] }),
      adapter: { allocateSourceId, create, delete: () => ({ outcome: 'committed', issues: [] }) }
    });
    const commandHash = await lifecycleCommandHash(command, authorityFingerprint);
    expect(await denied.execute(command)).toMatchObject({ outcome: 'rejected', issues: [{ code: 'test.denied' }] });
    expect(await denied.queryOutcome({ operationEpoch: command.operationEpoch, operationId: command.operationId, commandHash })).toEqual({ status: 'not_seen' });
    expect(allocateSourceId).not.toHaveBeenCalled();

    const preflight = new SourceLifecycleCoordinator({
      lifecycleCoordinatorId: 'lifecycle:test', operationEpoch: command.operationEpoch, authorityViewFingerprint: authorityFingerprint,
      authorize: () => ({ allowed: true }),
      adapter: { preflight: () => [createIssue({ code: 'test.unavailable', phase: 'lifecycle', severity: 'error', retry: 'after_refresh' })], allocateSourceId, create, delete: () => ({ outcome: 'committed', issues: [] }) }
    });
    expect(await preflight.execute(command)).toMatchObject({ outcome: 'rejected', issues: [{ code: 'test.unavailable' }] });
    expect(await preflight.queryOutcome({ operationEpoch: command.operationEpoch, operationId: command.operationId, commandHash })).toEqual({ status: 'not_seen' });

    const controller = new AbortController();
    controller.abort();
    const cancelled = new SourceLifecycleCoordinator({
      lifecycleCoordinatorId: 'lifecycle:test', operationEpoch: command.operationEpoch, authorityViewFingerprint: authorityFingerprint,
      authorize: () => ({ allowed: true }),
      adapter: { allocateSourceId, create, delete: () => ({ outcome: 'committed', issues: [] }) }
    });
    expect(await cancelled.execute(command, { signal: controller.signal })).toMatchObject({ outcome: 'rejected', issues: [{ code: 'lifecycle.cancelled' }] });
    expect(await cancelled.queryOutcome({ operationEpoch: command.operationEpoch, operationId: command.operationId, commandHash })).toEqual({ status: 'not_seen' });

    const duringPreflight = new AbortController();
    const cancelledDuringPreflight = new SourceLifecycleCoordinator({
      lifecycleCoordinatorId: 'lifecycle:test', operationEpoch: command.operationEpoch, authorityViewFingerprint: authorityFingerprint,
      authorize: () => ({ allowed: true }),
      adapter: {
        preflight: async () => {
          duringPreflight.abort();
          return [];
        },
        allocateSourceId,
        create,
        delete: () => ({ outcome: 'committed', issues: [] })
      }
    });
    expect(await cancelledDuringPreflight.execute(command, {
      signal: duringPreflight.signal
    })).toMatchObject({
      outcome: 'rejected',
      issues: [{ code: 'lifecycle.cancelled' }]
    });
    expect(await cancelledDuringPreflight.queryOutcome({
      operationEpoch: command.operationEpoch,
      operationId: command.operationId,
      commandHash
    })).toEqual({ status: 'not_seen' });
    expect(allocateSourceId).not.toHaveBeenCalled();
  });

  it('allocates after reservation and before mutation, then deduplicates exact retry', async () => {
    const events: string[] = [];
    const created = new Set<string>();
    const adapter: SourceLifecycleAdapter = {
      allocateSourceId: () => { events.push('allocate'); return 'source:new'; },
      create: ({ sourceId, context }) => {
        events.push('create');
        context.markMutationPossible();
        events.push('mutation-possible');
        created.add(sourceId);
        events.push('mutated');
        return { outcome: 'committed', durability: 'memory', issues: [] };
      },
      delete: () => ({ outcome: 'committed', durability: 'memory', issues: [] })
    };
    const coordinator = new SourceLifecycleCoordinator({ lifecycleCoordinatorId: 'lifecycle:test', operationEpoch: 'lifecycle:epoch:one', authorityViewFingerprint: authorityFingerprint, authorize: () => ({ allowed: true }), adapter });
    const command = lifecycleCommand('create');
    const receipt = await coordinator.execute(command);
    expect(receipt).toMatchObject({ action: 'create', sourceId: 'source:new', outcome: 'committed', durability: 'memory' });
    expect(events).toEqual(['allocate', 'create', 'mutation-possible', 'mutated']);
    expect(created).toEqual(new Set(['source:new']));
    expect(await coordinator.execute(command)).toBe(receipt);
    expect(events).toHaveLength(4);

    const different = lifecycleCommand('create', { action: 'create', sourceCapability, input: { title: 'different' } });
    expect(await coordinator.execute(different)).toMatchObject({ outcome: 'rejected', issues: [{ code: 'lifecycle.operation_id_ambiguous' }] });
    const originalHash = await lifecycleCommandHash(command, authorityFingerprint);
    const differentHash = await lifecycleCommandHash(different, authorityFingerprint);
    expect(await lifecycleCommandHash({ ...command, operationId: 'another-caller-id' }, authorityFingerprint)).toBe(originalHash);
    expect(differentHash).not.toBe(originalHash);
    expect(await coordinator.queryOutcome({ operationEpoch: command.operationEpoch, operationId: command.operationId, commandHash: originalHash })).toEqual({ status: 'known', receipt });
    expect(await coordinator.queryOutcome({ operationEpoch: command.operationEpoch, operationId: command.operationId, commandHash: differentHash })).toEqual({ status: 'ambiguous' });
  });

  it('owns queued commands and captures the abort signal without invoking hostile getters', async () => {
    let releaseAuthorization!: () => void;
    const authorizationGate = new Promise<void>((resolve) => { releaseAuthorization = resolve; });
    const allocated: unknown[] = [];
    const created: unknown[] = [];
    const coordinator = new SourceLifecycleCoordinator({
      lifecycleCoordinatorId: 'lifecycle:test', operationEpoch: 'lifecycle:epoch:one', authorityViewFingerprint: authorityFingerprint,
      authorize: (request) => request.action === 'create' && request.input !== null && typeof request.input === 'object' && 'title' in request.input && request.input.title === 'blocker'
        ? authorizationGate.then(() => ({ allowed: true as const }))
        : { allowed: true },
      adapter: {
        allocateSourceId: (input, capability) => { allocated.push({ input, capability }); return 'source:owned'; },
        create: ({ value, capability }) => { created.push({ value, capability }); return { outcome: 'committed', durability: 'memory', issues: [] }; },
        delete: () => ({ outcome: 'committed', issues: [] })
      }
    });
    const blocker = coordinator.execute(lifecycleCommand('queue-blocker', { action: 'create', sourceCapability: { ...sourceCapability }, input: { title: 'blocker' } }));
    const queued = lifecycleCommand('queue-owned', { action: 'create', sourceCapability: { ...sourceCapability }, input: { title: 'owned' } });
    const mutable = queued as unknown as { operationId: string; request: { sourceCapability: { id: string }; input: { title: string } } };
    const controller = new AbortController();
    const replacement = new AbortController();
    replacement.abort();
    const executionOptions = { signal: controller.signal };
    const queuedResult = coordinator.execute(queued, executionOptions);
    mutable.operationId = 'queue-mutated';
    mutable.request.sourceCapability.id = 'urn:test:mutated';
    mutable.request.input.title = 'mutated';
    executionOptions.signal = replacement.signal;
    releaseAuthorization();

    await blocker;
    const receipt = await queuedResult;
    const expected = lifecycleCommand('queue-owned', { action: 'create', sourceCapability: { ...sourceCapability }, input: { title: 'owned' } });
    expect(receipt).toMatchObject({ operationId: 'queue-owned', outcome: 'committed', commandHash: await lifecycleCommandHash(expected, authorityFingerprint) });
    expect(allocated[1]).toEqual({ input: { title: 'owned' }, capability: sourceCapability });
    expect(created[1]).toEqual({ value: { title: 'owned' }, capability: sourceCapability });
    expect(Object.isFrozen((allocated[1] as { input: object }).input)).toBe(true);

    let getterCalls = 0;
    const hostile = Object.defineProperty({
      lifecycleCoordinatorId: 'lifecycle:test', operationEpoch: 'lifecycle:epoch:one', operationId: 'hostile'
    }, 'request', { enumerable: true, get: () => { getterCalls += 1; return { action: 'delete', sourceId: 'source:owned' }; } });
    expect(() => coordinator.execute(hostile as unknown as SourceLifecycleCommand)).toThrow(/descriptor-safe portable data/);
    expect(getterCalls).toBe(0);
  });

  it('stores and returns one deeply owned immutable lifecycle receipt', async () => {
    const adapterIssues: Issue[] = [createIssue({ code: 'test.lifecycle_evidence', phase: 'lifecycle', severity: 'warning', retry: 'never' })];
    const coordinator = new SourceLifecycleCoordinator({
      lifecycleCoordinatorId: 'lifecycle:test', operationEpoch: 'lifecycle:epoch:one', authorityViewFingerprint: authorityFingerprint,
      authorize: () => ({ allowed: true }),
      adapter: {
        allocateSourceId: () => 'source:receipt-owned',
        create: () => ({ outcome: 'committed', durability: 'memory', issues: adapterIssues }),
        delete: () => ({ outcome: 'committed', issues: [] })
      }
    });
    const command = lifecycleCommand('receipt-owned');
    const receipt = await coordinator.execute(command);
    adapterIssues.push(deniedIssue());

    expect(receipt.issues).toHaveLength(1);
    expect(Object.isFrozen(receipt)).toBe(true);
    expect(Object.isFrozen(receipt.issues)).toBe(true);
    expect(() => (receipt.issues as Issue[]).push(deniedIssue())).toThrow();
    expect(await coordinator.execute(command)).toBe(receipt);
    const lookup = await coordinator.queryOutcome({
      operationEpoch: command.operationEpoch,
      operationId: command.operationId,
      commandHash: await lifecycleCommandHash(command, authorityFingerprint)
    });
    expect(Object.isFrozen(lookup)).toBe(true);
    expect(lookup).toEqual({ status: 'known', receipt });
    if (lookup.status !== 'known') throw new Error('expected known lifecycle outcome');
    expect(lookup.receipt).toBe(receipt);
  });

  it('retains source-side stale rejection and committed delete no-op, then expires the epoch', async () => {
    const remove = vi.fn((): LifecycleMutationResult => ({ outcome: 'committed', durability: 'local', issues: [] }));
    const coordinator = new SourceLifecycleCoordinator({
      lifecycleCoordinatorId: 'lifecycle:test', operationEpoch: 'lifecycle:epoch:one', authorityViewFingerprint: authorityFingerprint,
      authorize: () => ({ allowed: true }),
      adapter: { snapshotBasis: () => ({ revision: 2 }), allocateSourceId: () => 'unused', create: () => ({ outcome: 'committed', issues: [] }), delete: remove }
    });
    const stale = lifecycleCommand('stale', { action: 'delete', sourceId: 'source:old', expectedBasis: { revision: 1 } });
    const staleReceipt = await coordinator.execute(stale);
    expect(staleReceipt).toMatchObject({ outcome: 'rejected', sourceId: 'source:old', issues: [{ code: 'lifecycle.expected_basis_stale' }] });
    expect(remove).not.toHaveBeenCalled();
    expect(await coordinator.execute(stale)).toBe(staleReceipt);

    const noOp = lifecycleCommand('noop', { action: 'delete', sourceId: 'source:absent' });
    const noOpReceipt = await coordinator.execute(noOp);
    expect(noOpReceipt).toMatchObject({ outcome: 'committed', sourceId: 'source:absent', durability: 'local' });
    expect(remove).toHaveBeenCalledOnce();
    expect(await coordinator.execute(noOp)).toBe(noOpReceipt);

    const oldHash = await lifecycleCommandHash(noOp, authorityFingerprint);
    await coordinator.rotateOperationEpoch('lifecycle:epoch:two');
    expect(await coordinator.queryOutcome({ operationEpoch: noOp.operationEpoch, operationId: noOp.operationId, commandHash: oldHash })).toEqual({ status: 'expired' });
    expect(await coordinator.execute(lifecycleCommand('after-retire'))).toMatchObject({ outcome: 'rejected', issues: [{ code: 'lifecycle.operation_epoch_expired' }] });
  });

  it('retains allocated identity and unknown outcome after a crash-capable handoff', async () => {
    const created = new Set<string>();
    const create = vi.fn(({ sourceId, context }: Parameters<SourceLifecycleAdapter['create']>[0]) => {
      context.markMutationPossible();
      created.add(sourceId);
      throw new Error('crash after backend accepted create');
    });
    const coordinator = new SourceLifecycleCoordinator({
      lifecycleCoordinatorId: 'lifecycle:test', operationEpoch: 'lifecycle:epoch:one', authorityViewFingerprint: authorityFingerprint,
      authorize: () => ({ allowed: true }),
      adapter: { allocateSourceId: () => 'source:allocated', create, delete: () => ({ outcome: 'committed', issues: [] }) }
    });
    const command = lifecycleCommand('crash');
    const receipt = await coordinator.execute(command);
    expect(receipt).toMatchObject({ outcome: 'unknown', sourceId: 'source:allocated', durability: 'unknown', issues: [{ code: 'lifecycle.outcome_unknown', retry: 'query_outcome' }, { code: 'operation.durable_lookup_unavailable' }] });
    expect(created).toEqual(new Set(['source:allocated']));
    expect(await coordinator.execute(command)).toBe(receipt);
    expect(create).toHaveBeenCalledOnce();
    const commandHash = await lifecycleCommandHash(command, authorityFingerprint);
    expect(await coordinator.queryOutcome({ operationEpoch: command.operationEpoch, operationId: command.operationId, commandHash })).toEqual({ status: 'known', receipt });
  });
});

describe('governance coordination', () => {
  it('returns command-invalid receipts for malformed nested governance requests', async () => {
    const authorize = vi.fn(() => ({ allowed: true } as const));
    const coordinator = new GovernanceCoordinator({ authorityViewFingerprint: authorityFingerprint, authorize });
    const malformedRequests: readonly unknown[] = [
      { action: 'initialize_declaration', declaration: null },
      { action: 'initialize_declaration', declaration: { formatVersion: 1, storageSchema: schema, projection: null } },
      { action: 'activate_constraints', activation: null },
      { action: 'repair_declaration', section: 'storage', alternatives: null, selected: storageSection() },
      { action: 'repair_declaration', section: 'storage', alternatives: [storageSection(), null], selected: storageSection() },
      { action: 'unknown' }
    ];

    const missingBasis = governanceCommand('malformed:basis') as unknown as Record<string, unknown>;
    delete missingBasis.expectedBasis;
    await expect(coordinator.execute(missingBasis as unknown as GovernanceCommand)).resolves.toMatchObject({
      kind: 'governance', outcome: 'rejected', issues: [{ code: 'governance.command_invalid' }]
    });

    for (const [index, request] of malformedRequests.entries()) {
      const command = { ...governanceCommand('malformed:' + index), request } as unknown as GovernanceCommand;
      await expect(coordinator.execute(command)).resolves.toMatchObject({
        kind: 'governance', outcome: 'rejected', issues: [{ code: 'governance.command_invalid' }]
      });
    }
    await expect(coordinator.execute({
      ...governanceCommand('malformed:unicode'),
      sourceId: '\ud800'
    })).resolves.toMatchObject({
      kind: 'governance', sourceId: '<invalid>', outcome: 'rejected', issues: [{ code: 'governance.command_invalid' }]
    });
    expect(authorize).not.toHaveBeenCalled();
  });

  it('commits initialization at an exact basis and retains auditable selected hashes', async () => {
    let basis = { incarnation: 'one', revision: 0 };
    let declaration: unknown;
    const apply = vi.fn(({ command, context }: Parameters<Parameters<GovernanceCoordinator['registerSource']>[2]['apply']>[0]) => {
      context.markMutationPossible();
      declaration = command.request;
      const beforeBasis = basis;
      basis = { ...basis, revision: basis.revision + 1 };
      return { outcome: 'committed' as const, beforeBasis, afterBasis: basis, durability: 'local' as const, issues: [] };
    });
    const coordinator = new GovernanceCoordinator({ authorityViewFingerprint: authorityFingerprint, authorize: () => ({ allowed: true }) });
    coordinator.registerSource('source:one', 'governance:epoch:one', { snapshotBasis: () => basis, apply });
    const command = governanceCommand('initialize');
    const withLocations = governanceCommand('different-id', {
      action: 'initialize_declaration',
      declaration: {
        formatVersion: 1,
        storageSchema: { ...schema, locations: ['https://resolution-hint.example/schema'] },
        projection: { kind: 'storage-mapping', storageMapping: { ...mapping, locations: ['https://resolution-hint.example/mapping'] } },
        constraints: { set: constraints, mode: 'required' }
      }
    });
    expect(await governanceCommandHash(withLocations, authorityFingerprint)).toBe(await governanceCommandHash(command, authorityFingerprint));
    const receipt = await coordinator.execute(command);
    expect(receipt).toMatchObject({
      action: 'initialize_declaration', outcome: 'committed',
      beforeBasis: { revision: 0 }, afterBasis: { revision: 1 }, durability: 'local',
      selectedArtifactHashes: [schema.contentHash, mapping.contentHash, constraints.contentHash].sort()
    });
    expect(declaration).toEqual(command.request);
    expect(await coordinator.execute(command)).toBe(receipt);
    expect(apply).toHaveBeenCalledOnce();
  });

  it('owns queued commands before selecting the source queue and rejects hostile getters', async () => {
    let releaseAuthorization!: () => void;
    const authorizationGate = new Promise<void>((resolve) => { releaseAuthorization = resolve; });
    let basis = { incarnation: 'one', revision: 0 };
    const applied: GovernanceCommand[] = [];
    const coordinator = new GovernanceCoordinator({
      authorityViewFingerprint: authorityFingerprint,
      authorize: (command) => command.operationId === 'queue-blocker'
        ? authorizationGate.then(() => ({ allowed: true as const }))
        : { allowed: true }
    });
    coordinator.registerSource('source:one', 'governance:epoch:one', {
      snapshotBasis: () => basis,
      apply: ({ command }) => {
        applied.push(command);
        const beforeBasis = basis;
        basis = { ...basis, revision: basis.revision + 1 };
        return { outcome: 'committed', beforeBasis, afterBasis: basis, durability: 'memory', issues: [] };
      }
    });
    const blocker = coordinator.execute(governanceCommand('queue-blocker'));
    const queued: GovernanceCommand = {
      ...governanceCommand('queue-owned', { action: 'activate_constraints', activation: constraintSection({ ...constraints }) }),
      expectedBasis: { incarnation: 'one', revision: 1 }
    };
    const mutable = queued as unknown as { operationId: string; sourceId: string; expectedBasis: { revision: number }; request: { activation: { set: { id: string } } } };
    const queuedResult = coordinator.execute(queued);
    mutable.operationId = 'queue-mutated';
    mutable.sourceId = 'source:mutated';
    mutable.expectedBasis.revision = 99;
    mutable.request.activation.set.id = 'urn:test:mutated';
    releaseAuthorization();

    await blocker;
    const receipt = await queuedResult;
    const expected: GovernanceCommand = {
      ...governanceCommand('queue-owned', { action: 'activate_constraints', activation: constraintSection({ ...constraints }) }),
      expectedBasis: { incarnation: 'one', revision: 1 }
    };
    expect(receipt).toMatchObject({ operationId: 'queue-owned', sourceId: 'source:one', outcome: 'committed', commandHash: await governanceCommandHash(expected, authorityFingerprint), selectedArtifactHashes: [constraints.contentHash] });
    expect(applied[1]).toEqual(expected);
    expect(Object.isFrozen(applied[1]?.request)).toBe(true);

    let getterCalls = 0;
    const hostile = Object.defineProperty({
      operationEpoch: 'governance:epoch:one', operationId: 'hostile', expectedBasis: { revision: 2 }, request: { action: 'activate_constraints', activation: constraintSection() }
    }, 'sourceId', { enumerable: true, get: () => { getterCalls += 1; return 'source:one'; } });
    expect(() => coordinator.execute(hostile as unknown as GovernanceCommand)).toThrow(/descriptor-safe portable data/);
    expect(getterCalls).toBe(0);
  });

  it('detaches governance receipt evidence before storing and returning it', async () => {
    const snapshotBasis = { incarnation: 'one', revision: 0 };
    const reportedBefore = { incarnation: 'one', revision: 0 };
    const reportedAfter = { incarnation: 'one', revision: 1 };
    const adapterIssues: Issue[] = [createIssue({ code: 'test.governance_evidence', phase: 'governance', severity: 'warning', retry: 'never' })];
    const coordinator = new GovernanceCoordinator({ authorityViewFingerprint: authorityFingerprint, authorize: () => ({ allowed: true }) });
    coordinator.registerSource('source:one', 'governance:epoch:one', {
      snapshotBasis: () => snapshotBasis,
      apply: () => ({ outcome: 'committed', beforeBasis: reportedBefore, afterBasis: reportedAfter, durability: 'local', issues: adapterIssues })
    });
    const command = governanceCommand('receipt-owned');
    const receipt = await coordinator.execute(command);
    reportedBefore.revision = 10;
    reportedAfter.revision = 11;
    adapterIssues.push(deniedIssue());

    expect(receipt).toMatchObject({ beforeBasis: { revision: 0 }, afterBasis: { revision: 1 }, issues: [{ code: 'test.governance_evidence' }] });
    expect(Object.isFrozen(receipt)).toBe(true);
    expect(Object.isFrozen(receipt.beforeBasis)).toBe(true);
    expect(Object.isFrozen(receipt.afterBasis)).toBe(true);
    expect(Object.isFrozen(receipt.selectedArtifactHashes)).toBe(true);
    expect(Object.isFrozen(receipt.issues)).toBe(true);
    expect(await coordinator.execute(command)).toBe(receipt);
    const lookup = await coordinator.queryOutcome({
      sourceId: command.sourceId,
      operationEpoch: command.operationEpoch,
      operationId: command.operationId,
      commandHash: await governanceCommandHash(command, authorityFingerprint)
    });
    expect(Object.isFrozen(lookup)).toBe(true);
    expect(lookup).toEqual({ status: 'known', receipt });
    if (lookup.status !== 'known') throw new Error('expected known governance outcome');
    expect(lookup.receipt).toBe(receipt);
  });

  it('keeps invalid repair and authority denial pre-handoff, but retains stale handed-off rejection', async () => {
    const apply = vi.fn(() => ({ outcome: 'committed' as const, beforeBasis: { revision: 0 }, afterBasis: { revision: 1 }, issues: [] }));
    const denied = new GovernanceCoordinator({ authorityViewFingerprint: authorityFingerprint, authorize: () => ({ allowed: false, issues: [deniedIssue()] }) });
    denied.registerSource('source:one', 'governance:epoch:one', { snapshotBasis: () => ({ incarnation: 'one', revision: 0 }), apply });
    const initialize = governanceCommand('denied');
    const initializeHash = await governanceCommandHash(initialize, authorityFingerprint);
    expect(await denied.execute(initialize)).toMatchObject({ outcome: 'rejected', issues: [{ code: 'test.denied' }] });
    expect(await denied.queryOutcome({ sourceId: initialize.sourceId, operationEpoch: initialize.operationEpoch, operationId: initialize.operationId, commandHash: initializeHash })).toEqual({ status: 'not_seen' });

    const first = storageSection();
    const second = storageSection({ id: 'urn:test:schema:other', contentHash: hash('f') });
    const invalidRepair = governanceCommand('bad-repair', { action: 'repair_declaration', section: 'storage', alternatives: [first, second], selected: storageSection({ id: 'urn:test:unobserved', contentHash: hash('1') }) });
    const allowed = new GovernanceCoordinator({ authorityViewFingerprint: authorityFingerprint, authorize: () => ({ allowed: true }) });
    allowed.registerSource('source:one', 'governance:epoch:one', { snapshotBasis: () => ({ incarnation: 'one', revision: 2 }), apply });
    const invalidHash = await governanceCommandHash(invalidRepair, authorityFingerprint);
    expect(await allowed.execute(invalidRepair)).toMatchObject({ outcome: 'rejected', issues: [{ code: 'governance.repair_selection_invalid' }] });
    expect(await allowed.queryOutcome({ sourceId: invalidRepair.sourceId, operationEpoch: invalidRepair.operationEpoch, operationId: invalidRepair.operationId, commandHash: invalidHash })).toEqual({ status: 'not_seen' });

    const stale = governanceCommand('stale');
    const staleReceipt = await allowed.execute(stale);
    expect(staleReceipt).toMatchObject({ outcome: 'rejected', beforeBasis: { revision: 2 }, issues: [{ code: 'governance.expected_basis_stale' }] });
    expect(await allowed.execute(stale)).toBe(staleReceipt);
    expect(apply).not.toHaveBeenCalled();
  });

  it('does not reserve or invoke a governance adapter after cancellation during preflight', async () => {
    const controller = new AbortController();
    const snapshotBasis = vi.fn(() => ({ incarnation: 'one', revision: 0 }));
    const apply = vi.fn(() => ({
      outcome: 'committed' as const,
      beforeBasis: { incarnation: 'one', revision: 0 },
      afterBasis: { incarnation: 'one', revision: 1 },
      issues: []
    }));
    const coordinator = new GovernanceCoordinator({
      authorityViewFingerprint: authorityFingerprint,
      authorize: () => ({ allowed: true })
    });
    coordinator.registerSource('source:one', 'governance:epoch:one', {
      preflight: async () => {
        controller.abort();
        return [];
      },
      snapshotBasis,
      apply
    });
    const command = governanceCommand('cancel-during-preflight');
    const commandHash = await governanceCommandHash(command, authorityFingerprint);

    expect(await coordinator.execute(command, { signal: controller.signal })).toMatchObject({
      outcome: 'rejected',
      issues: [{ code: 'governance.cancelled' }]
    });
    expect(snapshotBasis).not.toHaveBeenCalled();
    expect(apply).not.toHaveBeenCalled();
    expect(await coordinator.queryOutcome({
      sourceId: command.sourceId,
      operationEpoch: command.operationEpoch,
      operationId: command.operationId,
      commandHash
    })).toEqual({ status: 'not_seen' });
  });

  it('classifies invalid post-handoff governance evidence as unknown with lookup limits', async () => {
    const coordinator = new GovernanceCoordinator({
      authorityViewFingerprint: authorityFingerprint,
      authorize: () => ({ allowed: true })
    });
    coordinator.registerSource('source:one', 'governance:epoch:one', {
      snapshotBasis: () => ({ incarnation: 'one', revision: 0 }),
      apply: ({ context }) => {
        context.markMutationPossible();
        return {
          outcome: 'committed',
          beforeBasis: { incarnation: 'one', revision: 0 },
          issues: []
        };
      }
    });

    expect(await coordinator.execute(governanceCommand('invalid-evidence'))).toMatchObject({
      outcome: 'unknown',
      durability: 'unknown',
      issues: [
        { code: 'governance.adapter_evidence_invalid' },
        { code: 'operation.durable_lookup_unavailable' }
      ]
    });
  });

  it('repairs only an exact observed bootstrap alternative and receipts selected artifact hashes', async () => {
    const first = storageSection();
    const second = storageSection({ id: 'urn:test:schema:replacement', contentHash: hash('f') });
    let selected: GovernanceStorageSection | undefined;
    const coordinator = new GovernanceCoordinator({ authorityViewFingerprint: authorityFingerprint, authorize: () => ({ allowed: true }) });
    coordinator.registerSource('source:one', 'governance:epoch:one', {
      snapshotBasis: () => ({ incarnation: 'one', revision: 0 }),
      apply: ({ command, context }) => {
        if (command.request.action !== 'repair_declaration' || command.request.selected.kind !== 'storage') throw new Error('unexpected command');
        context.markMutationPossible();
        selected = command.request.selected;
        return { outcome: 'committed', beforeBasis: command.expectedBasis, afterBasis: { incarnation: 'one', revision: 1 }, durability: 'local', issues: [] };
      }
    });
    const repair = governanceCommand('repair', { action: 'repair_declaration', section: 'storage', alternatives: [first, second], selected: second });
    const receipt = await coordinator.execute(repair);
    expect(receipt).toMatchObject({
      action: 'repair_declaration', outcome: 'committed',
      selectedArtifactHashes: [mapping.contentHash, second.storageSchema.contentHash].sort(),
      beforeBasis: { revision: 0 }, afterBasis: { revision: 1 }
    });
    expect(selected).toEqual(second);
  });

  it('retains activation no-op, ambiguity, crash-after-handoff unknown, and epoch expiry', async () => {
    let basis = { incarnation: 'one', revision: 0 };
    const coordinator = new GovernanceCoordinator({ authorityViewFingerprint: authorityFingerprint, authorize: () => ({ allowed: true }) });
    const apply = vi.fn(({ command, context }: Parameters<Parameters<GovernanceCoordinator['registerSource']>[2]['apply']>[0]) => {
      if (command.operationId === 'crash') {
        context.markMutationPossible();
        basis = { ...basis, revision: 1 };
        throw new Error('lost result');
      }
      return { outcome: 'committed' as const, beforeBasis: basis, afterBasis: basis, durability: 'memory' as const, issues: [] };
    });
    coordinator.registerSource('source:one', 'governance:epoch:one', { snapshotBasis: () => basis, apply });

    const activation = governanceCommand('activate', { action: 'activate_constraints', activation: constraintSection() });
    const receipt = await coordinator.execute(activation);
    expect(receipt).toMatchObject({ outcome: 'committed', beforeBasis: { revision: 0 }, afterBasis: { revision: 0 }, selectedArtifactHashes: [constraints.contentHash] });
    expect(await coordinator.execute(activation)).toBe(receipt);
    const different = { ...activation, request: { action: 'activate_constraints' as const, activation: constraintSection({ id: 'urn:test:other', contentHash: hash('2') }) } };
    expect(await coordinator.execute(different)).toMatchObject({ outcome: 'rejected', issues: [{ code: 'governance.operation_id_ambiguous' }] });

    const crash = governanceCommand('crash', { action: 'activate_constraints', activation: constraintSection() });
    const unknown = await coordinator.execute(crash);
    expect(unknown).toMatchObject({ outcome: 'unknown', beforeBasis: { revision: 0 }, durability: 'unknown', issues: [{ code: 'governance.outcome_unknown' }, { code: 'operation.durable_lookup_unavailable' }] });
    expect(await coordinator.execute(crash)).toBe(unknown);
    const crashHash = await governanceCommandHash(crash, authorityFingerprint);
    expect(await coordinator.queryOutcome({ sourceId: crash.sourceId, operationEpoch: crash.operationEpoch, operationId: crash.operationId, commandHash: crashHash })).toEqual({ status: 'known', receipt: unknown });

    await coordinator.rotateOperationEpoch('source:one', 'governance:epoch:two');
    expect(await coordinator.queryOutcome({ sourceId: crash.sourceId, operationEpoch: crash.operationEpoch, operationId: crash.operationId, commandHash: crashHash })).toEqual({ status: 'expired' });
  });

  it('integrates with shell sequences and preserves an orphaned created source', async () => {
    const lifecycle = new SourceLifecycleCoordinator({
      lifecycleCoordinatorId: 'lifecycle:test', operationEpoch: 'lifecycle:epoch:one', authorityViewFingerprint: authorityFingerprint,
      authorize: () => ({ allowed: true }),
      adapter: {
        allocateSourceId: () => 'source:orphan',
        create: ({ context }) => { context.markMutationPossible(); return { outcome: 'committed', durability: 'memory', issues: [] }; },
        delete: () => ({ outcome: 'committed', issues: [] })
      }
    });
    const governance = new GovernanceCoordinator({ authorityViewFingerprint: authorityFingerprint, authorize: () => ({ allowed: true }) });
    governance.registerSource('source:one', 'governance:epoch:one', {
      snapshotBasis: () => ({ incarnation: 'one', revision: 0 }),
      apply: () => ({ outcome: 'rejected', beforeBasis: { incarnation: 'one', revision: 0 }, issues: [createIssue({ code: 'test.link_failed', phase: 'governance', severity: 'error', retry: 'after_refresh' })] })
    });
    const sequence = await executeSequence({
      sequenceId: 'create-then-link',
      steps: [
        { stepId: 'create', run: () => lifecycle.execute(lifecycleCommand('orphan')) },
        { stepId: 'link', run: () => governance.execute(governanceCommand('link')) },
        { stepId: 'later', run: () => lifecycle.execute(lifecycleCommand('never')) }
      ]
    });
    expect(sequence).toMatchObject({
      outcome: 'partial',
      orphanedSourceIds: ['source:orphan'],
      steps: [{ outcome: 'applied' }, { outcome: 'failed', receipt: { issues: [{ code: 'test.link_failed' }] } }, { outcome: 'unattempted' }]
    });
  });
});
