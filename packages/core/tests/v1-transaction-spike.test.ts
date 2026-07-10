import { describe, expect, it, vi } from 'vitest';
import {
  InMemorySpikeSource,
  type ArtifactRef,
  type Expr,
  type MemoryBinding,
  type QueryNode,
  type RelationUse,
  type TransactionAttempt
} from '../src/v1-spike.js';

const hash = (character: string) => `sha256:${character.repeat(64)}` as const;
const schema: ArtifactRef = { id: 'urn:test:schema:transaction', contentHash: hash('a') };
const tasks: RelationUse = { schemaView: schema, relationId: 'test.task' };
const foreign: RelationUse = { schemaView: schema, relationId: 'other.account' };
const field = (alias: string, name: string): Expr => ({ kind: 'field', alias, name });
const literal = (value: string | number | boolean | null): Expr => ({ kind: 'literal', value });
const eq = (left: Expr, right: Expr): Expr => ({ kind: 'compare', op: 'eq', left, right });

const declaredBinding = (id: string, overrides: Partial<MemoryBinding> = {}): MemoryBinding => ({
  id,
  relationIds: [tasks.relationId],
  declaredReadFootprint: { relations: [tasks.relationId] },
  declaredWriteFootprint: { relations: [tasks.relationId] },
  ...overrides
});

const invalidTitle: QueryNode = {
  kind: 'where',
  input: { kind: 'from', relation: tasks, alias: 'task' },
  predicate: eq(field('task', 'title'), literal(''))
};

const createSource = (bindings: readonly MemoryBinding[] = [declaredBinding('primary'), declaredBinding('overlap')]) => new InMemorySpikeSource({
  sourceId: 'source:memory', incarnation: 'incarnation:1',
  storage: { [tasks.relationId]: [{ id: 'one', title: 'First', count: 0 }, { id: 'two', title: 'Second', count: 2 }] },
  relations: [{ use: tasks, keyFields: ['id'] }], bindings,
  constraints: [{ constraintId: 'task.title.required', violationQuery: invalidTitle, code: 'task.title_required' }]
});

const baseAttempt = (overrides: Partial<TransactionAttempt> = {}): TransactionAttempt => ({
  operationEpoch: 'epoch:1', operationId: 'operation:1', transactionHash: hash('b'),
  attachmentId: 'attachment:tasks', attachmentFingerprint: hash('c'), authorityViewFingerprint: hash('d'),
  statements: [{
    kind: 'statement.update',
    target: { relation: tasks, alias: 'task', where: eq(field('task', 'id'), literal('one')) },
    edits: { title: { kind: 'edit.replace', value: literal('Updated') } }
  }],
  ...overrides
});

describe('v1 in-memory source transaction spike', () => {
  it('merges two compatible overlapping binding plans into one atomic notification', async () => {
    const source = createSource();
    const listener = vi.fn();
    source.subscribe(listener);
    const receipt = await source.commit(baseAttempt({ expectedBasis: source.snapshot().basis }));
    expect(receipt).toMatchObject({ outcome: 'committed', beforeBasis: { revision: 0 }, afterBasis: { revision: 1 }, statementResults: [{ matched: 1, logicallyChanged: 1 }] });
    expect(source.snapshot().storage[tasks.relationId]?.[0]).toEqual({ id: 'one', title: 'Updated', count: 0 });
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('simulates the staged final state without mutation or operation deduplication', async () => {
    const source = createSource();
    const simulation = await source.simulate(baseAttempt());
    expect(simulation).toMatchObject({ kind: 'simulation', outcome: 'would-commit' });
    expect(simulation.stagedStorage?.[tasks.relationId]?.[0]).toMatchObject({ title: 'Updated' });
    expect(source.snapshot().basis.revision).toBe(0);
    expect(source.snapshot().storage[tasks.relationId]?.[0]).toMatchObject({ title: 'First' });
    expect(await source.commit(baseAttempt())).toMatchObject({ outcome: 'committed', afterBasis: { revision: 1 } });
  });

  it('evaluates statements in order but hard constraints only on the final staged state', async () => {
    const source = createSource();
    const receipt = await source.commit(baseAttempt({ statements: [
      { kind: 'statement.update', target: { relation: tasks, alias: 'task', where: eq(field('task', 'id'), literal('one')) }, edits: { title: { kind: 'edit.replace', value: literal('') } } },
      { kind: 'statement.update', target: { relation: tasks, alias: 'task', where: eq(field('task', 'id'), literal('one')) }, edits: { title: { kind: 'edit.replace', value: literal('Repaired') } } }
    ] }));
    expect(receipt.outcome).toBe('committed');
    expect(source.snapshot().storage[tasks.relationId]?.[0]?.title).toBe('Repaired');

    const rejected = await source.commit(baseAttempt({ operationId: 'operation:invalid', statements: [
      { kind: 'statement.update', target: { relation: tasks, alias: 'task', where: eq(field('task', 'id'), literal('two')) }, edits: { title: { kind: 'edit.replace', value: literal('') } } }
    ] }));
    expect(rejected).toMatchObject({ outcome: 'rejected', issues: [{ code: 'task.title_required' }] });
    expect(source.snapshot().storage[tasks.relationId]?.[1]?.title).toBe('Second');
  });

  it('rejects stale exact bases without planning or mutation', async () => {
    const source = createSource();
    await source.commit(baseAttempt());
    const stale = await source.commit(baseAttempt({ operationId: 'operation:stale', expectedBasis: { incarnation: 'incarnation:1', revision: 0 } }));
    expect(stale).toMatchObject({ outcome: 'rejected', issues: [{ code: 'transaction.expected_basis_stale' }] });
    expect(source.snapshot().basis.revision).toBe(1);
  });

  it('deduplicates an operation epoch/ID and rejects its reuse for a different intent', async () => {
    const source = createSource();
    const first = await source.commit(baseAttempt());
    const repeated = await source.commit(baseAttempt());
    expect(repeated).toBe(first);
    const ambiguous = await source.commit(baseAttempt({ transactionHash: hash('e') }));
    expect(ambiguous).toMatchObject({ outcome: 'rejected', issues: [{ code: 'transaction.operation_id_ambiguous', retry: 'never' }] });
    expect(source.snapshot().basis.revision).toBe(1);
  });

  it('rejects unknown/out-of-bounds footprints and incompatible overlapping intents', async () => {
    const unknownSource = createSource([declaredBinding('unknown', { planFootprint: () => ({ relations: [tasks.relationId], certainty: 'unknown' }) })]);
    expect(await unknownSource.commit(baseAttempt())).toMatchObject({ outcome: 'rejected', issues: [{ code: 'binding.footprint_out_of_bounds', details: { relation: 'unknown' } }] });

    const conflictSource = createSource([
      declaredBinding('primary'),
      declaredBinding('conflicting', { mapCommand: (command) => ({ ...command, rows: command.rows.map((row) => ({ ...row, title: 'Binding override' })) }) })
    ]);
    expect(await conflictSource.commit(baseAttempt())).toMatchObject({ outcome: 'rejected', issues: [{ code: 'transaction.intent_merge_conflict' }] });
    expect(conflictSource.snapshot().basis.revision).toBe(0);
  });

  it('rejects cross-source guards before mutation', async () => {
    const source = createSource();
    const receipt = await source.commit(baseAttempt({ guards: [{
      kind: 'guard.query', expect: 'empty', root: { kind: 'from', relation: foreign, alias: 'account' }
    }] }));
    expect(receipt).toMatchObject({ outcome: 'rejected', issues: [{ code: 'transaction.cross_source_guard' }] });
    expect(source.snapshot().basis.revision).toBe(0);
  });

  it('preserves a basis and emits nothing for a logical no-op', async () => {
    const source = createSource();
    const listener = vi.fn();
    source.subscribe(listener);
    const receipt = await source.commit(baseAttempt({ statements: [{
      kind: 'statement.update', target: { relation: tasks, alias: 'task', where: eq(field('task', 'id'), literal('one')) }, edits: { title: { kind: 'edit.replace', value: literal('First') } }
    }] }));
    expect(receipt).toMatchObject({ outcome: 'committed', beforeBasis: { revision: 0 }, afterBasis: { revision: 0 }, statementResults: [{ matched: 1, logicallyChanged: 0 }] });
    expect(listener).not.toHaveBeenCalled();
  });
});
