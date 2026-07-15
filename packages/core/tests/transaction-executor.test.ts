import { describe, expect, it, vi } from 'vitest';
import {
  LogicalMemoryAtomicSource,
  LogicalMemoryStorageBinding,
  compileSourceConstraints,
  executePreparedTransaction,
  prepareWritableExecutionContext,
  sealConstraintSet,
  sealTransaction,
  simulatePreparedTransaction,
  type ArtifactRef,
  type CapabilityRef,
  type MemoryState,
  type PreparedWritableExecutionContext,
  type TransactionAttempt,
  type WritableLogicalState
} from '../src/index.js';

const hash = (character: string): `sha256:${string}` => `sha256:${character.repeat(64)}`;
const schemaView: ArtifactRef = { id: 'urn:test:executor-schema', contentHash: hash('a') };
const relation = { relationId: 'items', schemaView };
const literal = (value: string) => ({ kind: 'literal' as const, value });
const field = (name: string) => ({ kind: 'field' as const, alias: 'item', name });
const queryRoot = { kind: 'values' as const, alias: 'result', rows: [] };

const makeContext = async (satisfiesCapability: (capability: CapabilityRef) => boolean = () => true) => {
  const source = new LogicalMemoryAtomicSource({
    sourceId: 'source:executor-memory',
    incarnation: 'incarnation:executor-memory',
    operationEpoch: 'epoch:executor',
    state: { items: [{ id: 'a', title: 'Old', count: 1 }] }
  });
  const binding = new LogicalMemoryStorageBinding({ relations: [{ relationId: 'items', keyFields: ['id'] }] });
  const constraintSet = await sealConstraintSet({ body: {
    schemaView,
    constraints: [{ id: 'title-allowed', code: 'test.title_forbidden', dependencyRelations: ['items'], violationQuery: queryRoot }],
    requiredCapabilities: []
  } });
  const constraints = compileSourceConstraints<WritableLogicalState>({
    set: constraintSet,
    mode: 'required',
    evaluateQuery: (_query, state) => ({
      rows: state.rows.filter(({ fields }) => fields.title === 'Forbidden').map(({ relationId, key }) => ({ subject: { relationId, key } })),
      completeness: 'exact',
      issues: []
    })
  });
  const context: PreparedWritableExecutionContext<MemoryState, import('../src/index.js').LogicalMemoryCommand> = prepareWritableExecutionContext({
    attachmentId: 'attachment:executor',
    attachmentIncarnation: 'attachment-incarnation:executor',
    attachmentFingerprint: hash('b'),
    authorityViewFingerprint: hash('c'),
    writable: true,
    schemaView,
    source,
    operationEpoch: 'epoch:executor',
    bindings: [binding],
    relationKeys: new Map([['items', ['id']]]),
    satisfiesCapability,
    query: {
      evaluate: (_root, state) => ({
        rows: state.rows.map(({ fields }) => fields),
        resultKeys: state.rows.map(({ key }) => JSON.stringify(key)),
        completeness: 'exact',
        issues: []
      })
    },
    constraints,
    durability: 'memory'
  });
  return { source, context };
};

const transaction = () => sealTransaction({ body: {
  schemaView,
  parameters: {},
  statements: [
    {
      kind: 'statement.update' as const,
      target: { relation, alias: 'item', where: { kind: 'compare' as const, op: 'eq' as const, left: field('id'), right: literal('a') } },
      edits: { title: { kind: 'edit.replace' as const, value: literal('First') } }
    },
    {
      kind: 'statement.update' as const,
      target: { relation, alias: 'item', where: { kind: 'compare' as const, op: 'eq' as const, left: field('id'), right: literal('a') } },
      edits: { title: { kind: 'edit.replace' as const, value: literal('Final') } }
    }
  ],
  guards: [{ kind: 'guard.affected-count' as const, statementIndex: 1, count: 'logicallyChanged' as const, op: 'eq' as const, value: 1 }],
  returning: [{ name: 'items', root: queryRoot }],
  requiredCapabilities: []
} });

const attempt = (value: Awaited<ReturnType<typeof transaction>>, operationId = 'operation:executor'): TransactionAttempt => ({
  operationEpoch: 'epoch:executor',
  operationId,
  attachmentId: 'attachment:executor',
  transaction: value
});

describe('prepared source-local transaction executor', () => {
  it('stages ordered overlapping statements and commits once with final-state query and constraint evidence', async () => {
    const { source, context } = await makeContext();
    const notify = vi.fn();
    source.subscribe(notify);
    const value = await transaction();
    const receipt = await executePreparedTransaction(context, attempt(value));
    expect(receipt).toMatchObject({
      outcome: 'committed',
      beforeBasis: { revision: 0 },
      afterBasis: { revision: 1 },
      statementResults: [
        { matched: 1, logicallyChanged: 1 },
        { matched: 1, logicallyChanged: 1 }
      ],
      returning: [{ name: 'items', rows: [{ id: 'a', title: 'Final', count: 1 }], basis: { revision: 1 } }]
    });
    expect(source.snapshot()).toMatchObject({ storage: { items: [{ id: 'a', title: 'Final', count: 1 }] } });
    expect(notify).toHaveBeenCalledOnce();
  });

  it('simulates without mutation or operation reservation and allows the exact attempt to commit later', async () => {
    const { source, context } = await makeContext();
    const value = await transaction();
    const exactAttempt = attempt(value, 'operation:simulation');
    await expect(simulatePreparedTransaction(context, exactAttempt)).resolves.toMatchObject({ outcome: 'would-commit', stagedState: { rows: [{ fields: { title: 'Final' } }] } });
    expect(source.snapshot()).toMatchObject({ basis: { revision: 0 }, storage: { items: [{ title: 'Old' }] } });
    await expect(executePreparedTransaction(context, exactAttempt)).resolves.toMatchObject({ outcome: 'committed', afterBasis: { revision: 1 } });
  });

  it('rejects a required final-state constraint before source handoff', async () => {
    const { source, context } = await makeContext();
    const value = await sealTransaction({ body: {
      schemaView,
      parameters: {},
      statements: [{ kind: 'statement.update', target: { relation, alias: 'item' }, edits: { title: { kind: 'edit.replace', value: literal('Forbidden') } } }],
      guards: [],
      requiredCapabilities: []
    } });
    const commit = vi.spyOn(source, 'commit');
    const receipt = await executePreparedTransaction(context, attempt(value, 'operation:constraint'));
    expect(receipt).toMatchObject({ outcome: 'rejected', issues: [{ code: 'test.title_forbidden', phase: 'constraint' }] });
    expect(commit).not.toHaveBeenCalled();
    expect(source.snapshot()).toMatchObject({ basis: { revision: 0 }, storage: { items: [{ title: 'Old' }] } });
  });

  it('combines disjoint field mechanisms for one row inside a statement', async () => {
    const { source, context } = await makeContext();
    const value = await sealTransaction({ body: {
      schemaView,
      parameters: {},
      statements: [{
        kind: 'statement.update',
        target: { relation, alias: 'item' },
        edits: {
          title: { kind: 'edit.replace', value: literal('Changed') },
          count: { kind: 'edit.counter-increment', amount: { kind: 'literal', value: 2 } }
        }
      }],
      guards: [],
      requiredCapabilities: []
    } });
    await expect(executePreparedTransaction(context, attempt(value, 'operation:mixed-edits'))).resolves.toMatchObject({
      outcome: 'committed',
      statementResults: [{ logicallyChanged: 1, editOutcomes: [{ edit: 'counter' }] }]
    });
    expect(source.snapshot()).toMatchObject({ storage: { items: [{ title: 'Changed', count: 3 }] } });
  });

  it('commits a no-op at the same basis without notifying', async () => {
    const { source, context } = await makeContext();
    const notify = vi.fn();
    source.subscribe(notify);
    const value = await sealTransaction({ body: {
      schemaView,
      parameters: {},
      statements: [{ kind: 'statement.update', target: { relation, alias: 'item' }, edits: { title: { kind: 'edit.replace', value: literal('Old') } } }],
      guards: [],
      requiredCapabilities: []
    } });
    await expect(executePreparedTransaction(context, attempt(value, 'operation:no-op'))).resolves.toMatchObject({
      outcome: 'committed',
      beforeBasis: { revision: 0 },
      afterBasis: { revision: 0 },
      statementResults: [{ matched: 1, logicallyChanged: 0 }]
    });
    expect(notify).not.toHaveBeenCalled();
  });

  it('rejects a stale expected basis before source handoff', async () => {
    const { source, context } = await makeContext();
    const sourceCommit = vi.spyOn(source, 'commit');
    const value = await transaction();
    const receipt = await executePreparedTransaction(context, {
      ...attempt(value, 'operation:stale'),
      expectedBasis: { incarnation: 'incarnation:executor-memory', revision: 99 }
    });
    expect(receipt).toMatchObject({ outcome: 'rejected', issues: [{ code: 'transaction.expected_basis_stale' }] });
    expect(sourceCommit).not.toHaveBeenCalled();
  });

  it('preserves an unknown source outcome and never retries it', async () => {
    const { source, context } = await makeContext();
    const sourceCommit = vi.spyOn(source, 'commit').mockResolvedValueOnce({
      outcome: 'unknown',
      beforeBasis: { incarnation: 'incarnation:executor-memory', revision: 0 },
      issues: []
    });
    const value = await transaction();
    await expect(executePreparedTransaction(context, attempt(value, 'operation:unknown'))).resolves.toMatchObject({
      outcome: 'unknown',
      durability: 'unknown'
    });
    expect(sourceCommit).toHaveBeenCalledOnce();
  });

  it('replaces a relation through ordered delete and insert phases and preserves identical replacement as a no-op', async () => {
    const { source, context } = await makeContext();
    const replace = await sealTransaction({ body: {
      schemaView,
      parameters: {},
      statements: [{ kind: 'statement.replace-all', relation, rows: [{ id: literal('a'), title: literal('New'), count: { kind: 'literal', value: 2 } }] }],
      guards: [],
      requiredCapabilities: []
    } });
    await expect(executePreparedTransaction(context, attempt(replace, 'operation:replace-all'))).resolves.toMatchObject({
      outcome: 'committed',
      statementResults: [{ matched: 1, inserted: 1, deleted: 1, logicallyChanged: 2 }]
    });
    expect(source.snapshot()).toMatchObject({ storage: { items: [{ id: 'a', title: 'New', count: 2 }] } });

    const identical = await sealTransaction({ body: { ...replace.body } });
    await expect(executePreparedTransaction(context, attempt(identical, 'operation:replace-all-identical'))).resolves.toMatchObject({
      outcome: 'committed',
      beforeBasis: { revision: 1 },
      afterBasis: { revision: 1 },
      statementResults: [{ matched: 1, inserted: 0, deleted: 0, logicallyChanged: 0 }]
    });
  });

  it('retains evaluated rejection identities before source handoff', async () => {
    const { context } = await makeContext();
    const rejected = await sealTransaction({ body: {
      schemaView,
      parameters: {},
      statements: [{ kind: 'statement.update', target: { relation, alias: 'item' }, edits: { title: { kind: 'edit.replace', value: literal('Old') } } }],
      guards: [{ kind: 'guard.affected-count', statementIndex: 0, count: 'matched', op: 'eq', value: 2 }],
      requiredCapabilities: []
    } });
    await expect(executePreparedTransaction(context, attempt(rejected, 'operation:reserved-rejection'))).resolves.toMatchObject({ outcome: 'rejected' });
    const different = await transaction();
    await expect(executePreparedTransaction(context, attempt(different, 'operation:reserved-rejection'))).resolves.toMatchObject({
      outcome: 'rejected',
      issues: [{ code: 'transaction.operation_id_ambiguous' }]
    });
  });

  it('uses exact staged basis evidence for final constraints', async () => {
    const { source } = await makeContext();
    const observed: unknown[] = [];
    const context = prepareWritableExecutionContext({
      attachmentId: 'attachment:executor', attachmentIncarnation: 'attachment-incarnation:executor',
      attachmentFingerprint: hash('b'), authorityViewFingerprint: hash('c'), writable: true,
      schemaView, source, operationEpoch: 'epoch:executor',
      bindings: [new LogicalMemoryStorageBinding({ relations: [{ relationId: 'items', keyFields: ['id'] }] })],
      relationKeys: new Map([['items', ['id']]]),
      satisfiesCapability: () => true,
      query: { evaluate: () => ({ rows: [], resultKeys: [], completeness: 'exact', issues: [] }) },
      constraints: [{ id: 'basis', mode: 'required', dependencyRelations: ['items'], evaluate: (_state, basis) => { observed.push(basis); return { status: 'satisfied' }; } }],
      durability: 'memory'
    });
    const value = await transaction();
    await expect(executePreparedTransaction(context, attempt(value, 'operation:constraint-basis'))).resolves.toMatchObject({ outcome: 'committed' });
    expect(observed).toEqual([
      { incarnation: 'incarnation:executor-memory', revision: 0 },
      { incarnation: 'incarnation:executor-memory', revision: 1 }
    ]);
  });

  it('uses staged basis evidence for later statement, guard, and returning queries', async () => {
    const { source } = await makeContext();
    const observed: unknown[] = [];
    const context = prepareWritableExecutionContext({
      attachmentId: 'attachment:executor', attachmentIncarnation: 'attachment-incarnation:executor',
      attachmentFingerprint: hash('b'), authorityViewFingerprint: hash('c'), writable: true,
      schemaView, source, operationEpoch: 'epoch:executor',
      bindings: [new LogicalMemoryStorageBinding({ relations: [{ relationId: 'items', keyFields: ['id'] }] })],
      relationKeys: new Map([['items', ['id']]]),
      satisfiesCapability: () => true,
      query: { evaluate: (_root, _state, _parameters, basis) => {
        observed.push(basis);
        return { rows: [], resultKeys: [], completeness: 'exact', issues: [] };
      } },
      durability: 'memory'
    });
    const value = await sealTransaction({ body: {
      schemaView,
      parameters: {},
      statements: [
        { kind: 'statement.update', target: { relation, alias: 'item' }, edits: { title: { kind: 'edit.replace', value: literal('Staged') } } },
        { kind: 'statement.insert-from-query', relation, root: queryRoot }
      ],
      guards: [{ kind: 'guard.query', root: queryRoot, expect: 'empty' }],
      returning: [{ name: 'items', root: queryRoot }],
      requiredCapabilities: []
    } });
    await expect(executePreparedTransaction(context, attempt(value, 'operation:query-basis'))).resolves.toMatchObject({
      outcome: 'committed',
      returning: [{ basis: { revision: 1 } }]
    });
    expect(observed).toEqual([
      { incarnation: 'incarnation:executor-memory', revision: 1 },
      { incarnation: 'incarnation:executor-memory', revision: 1 },
      { incarnation: 'incarnation:executor-memory', revision: 1 }
    ]);
  });

  it('requires an explicit authority decision for artifact capabilities', async () => {
    const required: CapabilityRef = { id: 'urn:test:capability:write', version: '1', contractHash: hash('d') };
    const { context } = await makeContext(() => false);
    const value = await sealTransaction({ body: {
      schemaView,
      parameters: {},
      statements: [],
      guards: [],
      requiredCapabilities: [required]
    } });
    await expect(executePreparedTransaction(context, attempt(value, 'operation:capability-denied'))).resolves.toMatchObject({
      outcome: 'rejected',
      issues: [{ code: 'transaction.capability_unavailable', requiredCapabilities: [required] }]
    });
  });

  it('contains authority and snapshot callback failures at the execution shell', async () => {
    const required: CapabilityRef = { id: 'urn:test:capability:write', version: '1', contractHash: hash('d') };
    const authorityContext = (await makeContext(() => {
      throw new Error('authority unavailable');
    })).context;
    const requiringCapability = await sealTransaction({ body: {
      schemaView,
      parameters: {},
      statements: [],
      guards: [],
      requiredCapabilities: [required]
    } });
    await expect(executePreparedTransaction(
      authorityContext,
      attempt(requiringCapability, 'operation:authority-failure')
    )).resolves.toMatchObject({
      outcome: 'rejected',
      issues: [{ code: 'transaction.capability_unavailable', details: { reason: 'authority_check_failed' } }]
    });

    const { context, source } = await makeContext();
    const sourceWithFailingSnapshot = new Proxy(source, {
      get: (target, property) => {
        if (property === 'snapshot') return () => { throw new Error('snapshot unavailable'); };
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      }
    });
    const snapshotContext = prepareWritableExecutionContext({
      ...context,
      source: sourceWithFailingSnapshot
    });
    const value = await transaction();
    await expect(simulatePreparedTransaction(
      snapshotContext,
      attempt(value, 'operation:snapshot-simulation')
    )).resolves.toMatchObject({ outcome: 'rejected', issues: [{ code: 'source.snapshot_failed' }] });
    await expect(executePreparedTransaction(
      snapshotContext,
      attempt(value, 'operation:snapshot-commit')
    )).resolves.toMatchObject({ outcome: 'rejected', issues: [{ code: 'source.snapshot_failed' }] });
  });

  it('requires staged basis derivation when adopting a prepared writable source', async () => {
    const { context, source } = await makeContext();
    const sourceWithoutStagedBasis = new Proxy(source, {
      get: (target, property, receiver) => property === 'basisForStagedStorage'
        ? undefined
        : Reflect.get(target, property, receiver)
    });
    expect(() => prepareWritableExecutionContext({
      ...context,
      source: sourceWithoutStagedBasis
    } as never)).toThrow('Prepared writable execution source must derive staged basis');
  });

  it('reconciles semantic no-ops before affected-count guards', async () => {
    const { source, context } = await makeContext();
    const value = await sealTransaction({ body: {
      schemaView,
      parameters: {},
      statements: [{ kind: 'statement.update', target: { relation, alias: 'item' }, edits: {
        title: { kind: 'edit.text-splice', index: { kind: 'literal', value: 0 }, deleteCount: { kind: 'literal', value: 3 }, insert: literal('Old') }
      } }],
      guards: [{ kind: 'guard.affected-count', statementIndex: 0, count: 'logicallyChanged', op: 'eq', value: 0 }],
      requiredCapabilities: []
    } });
    await expect(executePreparedTransaction(context, attempt(value, 'operation:semantic-no-op'))).resolves.toMatchObject({
      outcome: 'committed', statementResults: [{ logicallyChanged: 0 }], beforeBasis: { revision: 0 }, afterBasis: { revision: 0 }
    });
    expect(source.snapshot()).toMatchObject({ storage: { items: [{ title: 'Old' }] } });
  });

  it('applies upsert replace as complete logical row replacement', async () => {
    const { source, context } = await makeContext();
    const value = await sealTransaction({ body: {
      schemaView,
      parameters: {},
      statements: [{ kind: 'statement.upsert', relation, rows: [{ id: literal('a'), title: literal('Only') }], onConflict: 'replace' }],
      guards: [],
      requiredCapabilities: []
    } });
    await expect(executePreparedTransaction(context, attempt(value, 'operation:upsert-replace-row'))).resolves.toMatchObject({ outcome: 'committed' });
    expect(source.snapshot()).toMatchObject({ storage: { items: [{ id: 'a', title: 'Only' }] } });
  });
});
