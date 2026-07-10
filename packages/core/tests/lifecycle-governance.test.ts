import { describe, expect, it, vi } from 'vitest';
import { createIssue, type CapabilityRef, type Issue } from '../src/issues.js';
import {
  GovernanceCoordinator,
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

describe('source lifecycle coordination', () => {
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
