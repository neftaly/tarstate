import { describe, expect, it, vi } from 'vitest';
import { checkFinalConstraints, type SourceConstraint } from '../src/constraints.js';
import { InMemoryAtomicSource, type MemoryState } from '../src/memory-source.js';
import { sealTransaction, type Transaction, type TransactionBody, type WriteStatement } from '../src/transaction.js';

const hash = (character: string) => `sha256:${character.repeat(64)}` as const;
const schemaView = { id: 'urn:test:schema', contentHash: hash('a') };
const relation = { relationId: 'items', schemaView };
const literal = (value: null | boolean | number | string) => ({ kind: 'literal' as const, value });
const parameter = (name: string) => ({ kind: 'parameter' as const, name });
const field = (name: string) => ({ kind: 'field' as const, alias: 'item', name });
const lessThan = (name: string, value: number) => ({ kind: 'compare' as const, op: 'lt' as const, left: field(name), right: literal(value) });
const listCapability = { id: 'urn:test:capability:list-splice', version: '1', contractHash: hash('d') };

const transaction = (statements: readonly WriteStatement[], parameters: TransactionBody['parameters'] = {}, guards: TransactionBody['guards'] = []): Promise<Transaction> => sealTransaction({
  body: { schemaView, parameters, statements, guards, requiredCapabilities: [] }
});

const source = (options: { state?: MemoryState; constraints?: readonly SourceConstraint<MemoryState>[] } = {}) => new InMemoryAtomicSource({
  sourceId: 'source:one',
  incarnation: 'incarnation:one',
  operationEpoch: 'epoch:one',
  state: options.state ?? { items: [] },
  relations: [{ relationId: 'items', schemaView, keyFields: ['id'] }],
  attachments: [{ attachmentId: 'attachment:one', fingerprint: hash('b'), authorityViewFingerprint: hash('c'), schemaView, writable: true }],
  ...(options.constraints === undefined ? {} : { constraints: options.constraints })
});

const attempt = (operationId: string, value: Transaction, extra: Partial<{ expectedBasis: { incarnation: string; revision: number }; signal: AbortSignal }> = {}) => ({
  operationEpoch: 'epoch:one', operationId, attachmentId: 'attachment:one', transaction: value, ...extra
});

describe('production in-memory transaction coordinator', () => {
  it('binds parameters inside the transaction hash and returns missing parameters as retained rejected receipts', async () => {
    const insert = [{ kind: 'statement.insert' as const, relation, rows: [{ id: parameter('id') }] }];
    const withOne = await transaction(insert, { id: 1 });
    const withTwo = await transaction(insert, { id: 2 });
    expect(withOne.contentHash).not.toBe(withTwo.contentHash);

    const missing = await transaction(insert);
    const memory = source();
    const rejected = await memory.commit(attempt('missing', missing));
    expect(rejected).toMatchObject({ outcome: 'rejected', issues: [{ code: 'transaction.parameter_missing' }] });
    expect(memory.queryOutcome({ operationEpoch: 'epoch:one', operationId: 'missing', intentHash: rejected.intentHash })).toMatchObject({ status: 'known', receipt: rejected });

    const ambiguous = await memory.commit(attempt('missing', withOne));
    expect(ambiguous).toMatchObject({ outcome: 'rejected', issues: [{ code: 'transaction.operation_id_ambiguous' }] });
    const retry = await memory.commit(attempt('missing', missing));
    expect(retry).toBe(rejected);
  });

  it('executes statements in order while fixing each statement target and expression snapshot', async () => {
    const memory = source({ state: { items: [{ id: 1, n: 1 }, { id: 2, n: 2 }, { id: 3, n: 3 }] } });
    const value = await transaction([
      { kind: 'statement.insert', relation, rows: [{ id: literal(4), n: literal(0) }] },
      {
        kind: 'statement.update', target: { relation, alias: 'item', where: lessThan('n', 3) },
        edits: { n: { kind: 'edit.counter-increment', amount: literal(1) } }
      }
    ]);
    const receipt = await memory.commit(attempt('ordered', value));
    expect(receipt).toMatchObject({
      outcome: 'committed',
      statementResults: [
        { inserted: 1, logicallyChanged: 1 },
        { matched: 3, logicallyChanged: 3, editOutcomes: [{ edit: 'counter' }] }
      ]
    });
    expect(memory.snapshot().state.items).toEqual([{ id: 1, n: 2 }, { id: 2, n: 3 }, { id: 3, n: 3 }, { id: 4, n: 1 }]);
  });

  it('checks constraints only on final state and rejects violated or indeterminate outcomes atomically', async () => {
    const parentConstraint: SourceConstraint<MemoryState> = {
      id: 'constraint:parent', mode: 'required', dependencyRelations: ['items'],
      evaluate: (state) => {
        const rows = state.items ?? [];
        const parentIds = new Set(rows.filter((row) => row.kind === 'parent').map((row) => row.id));
        const failures = rows.filter((row) => row.kind === 'child' && !parentIds.has(row.parentId)).map((row) => ({
          id: 'missing-parent:' + JSON.stringify(row.id),
          subject: { relationId: 'items', key: row.id ?? null, scopeId: 'item:' + JSON.stringify(row.id) },
          code: 'constraint.foreign_key'
        }));
        return failures.length === 0 ? { status: 'satisfied' as const } : { status: 'violated' as const, violations: failures };
      }
    };
    const memory = source({ constraints: [parentConstraint] });
    const valid = await transaction([
      { kind: 'statement.insert', relation, rows: [{ id: literal(2), kind: literal('child'), parentId: literal(1) }] },
      { kind: 'statement.insert', relation, rows: [{ id: literal(1), kind: literal('parent') }] }
    ]);
    expect(await memory.commit(attempt('valid-final', valid))).toMatchObject({ outcome: 'committed', afterBasis: { revision: 1 } });

    const invalid = await transaction([{ kind: 'statement.insert', relation, rows: [{ id: literal(3), kind: literal('child'), parentId: literal(99) }] }]);
    expect(await memory.commit(attempt('invalid-final', invalid))).toMatchObject({ outcome: 'rejected', issues: [{ code: 'constraint.foreign_key' }] });
    expect(memory.snapshot()).toMatchObject({ basis: { revision: 1 }, state: { items: [{ id: 2 }, { id: 1 }] } });

    const indeterminate: SourceConstraint<MemoryState> = {
      id: 'constraint:unknown', mode: 'required', dependencyRelations: ['items'],
      evaluate: () => ({ status: 'indeterminate', failures: [{ id: 'unknown:items', subject: { relationId: 'items', scopeId: 'items' }, code: 'parse.failed' }] })
    };
    const blocked = source({ constraints: [indeterminate] });
    expect(await blocked.commit(attempt('unknown', valid))).toMatchObject({ outcome: 'rejected', issues: [{ code: 'constraint.indeterminate' }] });
  });

  it('enforces exact bases, commits no-ops without advancing or notifying, and keeps handed-off stale outcomes', async () => {
    const memory = source({ state: { items: [{ id: 1, n: 1 }] } });
    const notifications = vi.fn();
    memory.subscribe(notifications);
    const noMatch = await transaction([{ kind: 'statement.delete', target: { relation, alias: 'item', where: lessThan('n', 0) } }]);
    const noOp = await memory.commit(attempt('noop', noMatch));
    expect(noOp).toMatchObject({ outcome: 'committed', beforeBasis: { revision: 0 }, afterBasis: { revision: 0 } });
    expect(notifications).not.toHaveBeenCalled();

    const stale = await memory.commit(attempt('stale', noMatch, { expectedBasis: { incarnation: 'incarnation:one', revision: 99 } }));
    expect(stale).toMatchObject({ outcome: 'rejected', issues: [{ code: 'transaction.expected_basis_stale' }] });
    expect(memory.queryOutcome({ operationEpoch: 'epoch:one', operationId: 'stale', intentHash: stale.intentHash })).toMatchObject({ status: 'known' });
  });

  it('serializes concurrent and reentrant commits and reports semantic list edits', async () => {
    const memory = source({ state: { items: [{ id: 1, n: 0, tags: ['a'] }] } });
    const increment = await transaction([{
      kind: 'statement.update', target: { relation, alias: 'item' },
      edits: { n: { kind: 'edit.counter-increment', amount: literal(1) } }
    }]);
    await Promise.all([memory.commit(attempt('concurrent:1', increment)), memory.commit(attempt('concurrent:2', increment))]);
    expect(memory.snapshot()).toMatchObject({ basis: { revision: 2 }, state: { items: [{ n: 2 }] } });

    let reentrant: Promise<unknown> | undefined;
    const unsubscribe = memory.subscribe(() => { if (reentrant === undefined) reentrant = memory.commit(attempt('reentrant', increment)); });
    await memory.commit(attempt('outer', increment));
    await reentrant;
    unsubscribe();
    expect(memory.snapshot()).toMatchObject({ basis: { revision: 4 }, state: { items: [{ n: 4 }] } });

    const list = await transaction([{
      kind: 'statement.update', target: { relation, alias: 'item' },
      edits: { tags: { kind: 'edit.list-splice', index: literal(1), deleteCount: literal(0), values: [literal('b')], requires: listCapability } }
    }]);
    expect(await memory.commit(attempt('list', list))).toMatchObject({ outcome: 'committed', statementResults: [{ editOutcomes: [{ edit: 'list' }] }] });
    expect(memory.snapshot().state.items?.[0]?.tags).toEqual(['a', 'b']);
  });

  it('keeps simulation and pre-handoff cancellation outside the operation ledger', async () => {
    const memory = source();
    const first = await transaction([{ kind: 'statement.insert', relation, rows: [{ id: literal(1) }] }]);
    const second = await transaction([{ kind: 'statement.insert', relation, rows: [{ id: literal(2) }] }]);
    const simulated = await memory.simulate(attempt('advisory', first));
    expect(simulated).toMatchObject({ outcome: 'would-commit', beforeBasis: { revision: 0 } });
    expect(memory.snapshot().state.items).toEqual([]);
    expect(await memory.commit(attempt('advisory', second))).toMatchObject({ outcome: 'committed' });

    const controller = new AbortController();
    controller.abort();
    expect(await memory.commit(attempt('cancelled', first, { signal: controller.signal }))).toMatchObject({ outcome: 'rejected', issues: [{ code: 'transaction.cancelled' }] });
    expect(await memory.commit(attempt('cancelled', first))).toMatchObject({ outcome: 'committed' });
  });

  it('retires epochs explicitly without rebinding old operation identities', async () => {
    const memory = source();
    const value = await transaction([{ kind: 'statement.insert', relation, rows: [{ id: literal(1) }] }]);
    const receipt = await memory.commit(attempt('old', value));
    memory.rotateOperationEpoch('epoch:two');
    expect(memory.queryOutcome({ operationEpoch: 'epoch:one', operationId: 'old', intentHash: receipt.intentHash })).toEqual({ status: 'expired' });
    expect(await memory.commit(attempt('after-retire', value))).toMatchObject({ outcome: 'rejected', issues: [{ code: 'transaction.operation_epoch_expired' }] });
  });
});

describe('production constraint dirty-state rules', () => {
  const dirtyConstraint: SourceConstraint<{ readonly dirty: boolean }> = {
    id: 'constraint:dirty', mode: 'required', dependencyRelations: ['items'],
    evaluate: (state) => state.dirty
      ? { status: 'violated', violations: [{ id: 'dirty:item:1', subject: { relationId: 'items', scopeId: 'item:1' }, code: 'constraint.dirty' }] }
      : { status: 'satisfied' }
  };
  const basis = { incarnation: 'one', revision: 1 };

  it('allows unrelated writes, requires touched dirty scopes to repair, and accepts a repair', () => {
    expect(checkFinalConstraints({ constraints: [dirtyConstraint], before: { dirty: true }, after: { dirty: true }, beforeBasis: basis, afterBasis: basis, touchedRelations: new Set(['notes']) }).blockingIssues).toEqual([]);
    expect(checkFinalConstraints({ constraints: [dirtyConstraint], before: { dirty: true }, after: { dirty: true }, beforeBasis: basis, afterBasis: basis, touchedRelations: new Set(['items']) }).blockingIssues).toMatchObject([{ code: 'constraint.dirty' }]);
    expect(checkFinalConstraints({ constraints: [dirtyConstraint], before: { dirty: true }, after: { dirty: false }, beforeBasis: basis, afterBasis: basis, touchedRelations: new Set(['items']) }).blockingIssues).toEqual([]);
  });

  it('reports audit failures without turning them into hard rejection', () => {
    const audit = { ...dirtyConstraint, mode: 'audit' as const };
    const checked = checkFinalConstraints({ constraints: [audit], before: { dirty: false }, after: { dirty: true }, beforeBasis: basis, afterBasis: basis, touchedRelations: new Set(['items']) });
    expect(checked.blockingIssues).toEqual([]);
    expect(checked.auditIssues).toMatchObject([{ code: 'constraint.dirty', severity: 'warning' }]);
  });
});
