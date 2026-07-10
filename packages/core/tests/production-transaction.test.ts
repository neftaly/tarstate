import { describe, expect, it, vi } from 'vitest';
import { checkFinalConstraints, type SourceConstraint } from '../src/constraints.js';
import { InMemoryAtomicSource, type MemoryQueryResult, type MemoryRelation, type MemoryState } from '../src/memory-source.js';
import type { QueryNode } from '../src/query.js';
import { safeParseReceipt } from '../src/receipts.js';
import { executeNonAtomicBatch, sealTransaction, type NonAtomicBatch, type Transaction, type TransactionBody, type WriteStatement } from '../src/transaction.js';

const hash = (character: string) => `sha256:${character.repeat(64)}` as const;
const schemaView = { id: 'urn:test:schema', contentHash: hash('a') };
const relation = { relationId: 'items', schemaView };
const literal = (value: null | boolean | number | string) => ({ kind: 'literal' as const, value });
const parameter = (name: string) => ({ kind: 'parameter' as const, name });
const field = (name: string) => ({ kind: 'field' as const, alias: 'item', name });
const lessThan = (name: string, value: number) => ({ kind: 'compare' as const, op: 'lt' as const, left: field(name), right: literal(value) });
const queryRoot = (alias: string): QueryNode => ({ kind: 'values', alias, rows: [] });
const listCapability = { id: 'urn:test:capability:list-splice', version: '1', contractHash: hash('d') };
const rekeyCapability = { id: 'urn:test:capability:rekey', version: '1', contractHash: hash('e') };

const transaction = (statements: readonly WriteStatement[], parameters: TransactionBody['parameters'] = {}, guards: TransactionBody['guards'] = []): Promise<Transaction> => sealTransaction({
  body: { schemaView, parameters, statements, guards, requiredCapabilities: [] }
});

const source = (options: { state?: MemoryState; relations?: readonly MemoryRelation[]; constraints?: readonly SourceConstraint<MemoryState>[]; evaluateQuery?: (root: unknown, state: MemoryState, parameters: TransactionBody['parameters']) => MemoryQueryResult } = {}) => new InMemoryAtomicSource({
  sourceId: 'source:one',
  incarnation: 'incarnation:one',
  operationEpoch: 'epoch:one',
  state: options.state ?? { items: [] },
  relations: options.relations ?? [{ relationId: 'items', schemaView, keyFields: ['id'] }],
  attachments: [{ attachmentId: 'attachment:one', fingerprint: hash('b'), authorityViewFingerprint: hash('c'), schemaView, writable: true }],
  ...(options.constraints === undefined ? {} : { constraints: options.constraints }),
  ...(options.evaluateQuery === undefined ? {} : { evaluateQuery: options.evaluateQuery })
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

  it('inserts exact source-local query rows and rejects incomplete query input atomically', async () => {
    const exact = source({
      state: { items: [{ id: 1 }] },
      evaluateQuery: (_root, state) => ({ rows: state.items?.map((row) => ({ ...row, id: (row.id as number) + 10 })) ?? [], resultKeys: ['derived'], completeness: 'exact', issues: [] })
    });
    const value = await transaction([{ kind: 'statement.insert-from-query', relation, root: queryRoot('derived') }]);
    expect(await exact.commit(attempt('insert-query', value))).toMatchObject({ outcome: 'committed', statementResults: [{ inserted: 1, logicallyChanged: 1 }] });
    expect(exact.snapshot().state.items).toEqual([{ id: 1 }, { id: 11 }]);

    const incomplete = source({
      state: { items: [{ id: 1 }] },
      evaluateQuery: () => ({ rows: [{ id: 2 }], resultKeys: ['lower'], completeness: 'lower-bound', issues: [] })
    });
    expect(await incomplete.commit(attempt('insert-incomplete', value))).toMatchObject({ outcome: 'rejected', issues: [{ code: 'transaction.insert_query_incomplete' }] });
    expect(incomplete.snapshot()).toMatchObject({ basis: { revision: 0 }, state: { items: [{ id: 1 }] } });
  });

  it('upserts by declared relation keys with explicit reject, keep, and replace policies', async () => {
    const memory = source({ state: { items: [{ id: 1, title: 'old' }] } });
    const rows = [{ id: literal(1), title: literal('new') }, { id: literal(2), title: literal('second') }];
    const reject = await transaction([{ kind: 'statement.upsert', relation, rows, onConflict: 'reject' }]);
    expect(await memory.commit(attempt('upsert-reject', reject))).toMatchObject({ outcome: 'rejected', statementResults: [{ matched: 1 }], issues: [{ code: 'transaction.upsert_conflict' }] });
    expect(memory.snapshot().state.items).toEqual([{ id: 1, title: 'old' }]);

    const keep = await transaction([{ kind: 'statement.upsert', relation, rows, onConflict: 'keep-existing' }]);
    expect(await memory.commit(attempt('upsert-keep', keep))).toMatchObject({ outcome: 'committed', statementResults: [{ matched: 1, inserted: 1, logicallyChanged: 1 }] });
    expect(memory.snapshot().state.items).toEqual([{ id: 1, title: 'old' }, { id: 2, title: 'second' }]);

    const replace = await transaction([{ kind: 'statement.upsert', relation, rows, onConflict: 'replace' }]);
    expect(await memory.commit(attempt('upsert-replace', replace))).toMatchObject({ outcome: 'committed', statementResults: [{ matched: 2, inserted: 0, logicallyChanged: 1 }] });
    expect(memory.snapshot().state.items).toEqual([{ id: 1, title: 'new' }, { id: 2, title: 'second' }]);

    const ambiguous = await transaction([{ kind: 'statement.upsert', relation, rows: [{ id: literal(3) }, { id: literal(3) }], onConflict: 'replace' }]);
    expect(await memory.commit(attempt('upsert-ambiguous', ambiguous))).toMatchObject({ outcome: 'rejected', issues: [{ code: 'transaction.upsert_input_ambiguous' }] });
  });

  it('replace-all reports replacement counts and preserves basis for an identical replacement', async () => {
    const memory = source({ state: { items: [{ id: 1 }, { id: 2 }] } });
    const replace = await transaction([{ kind: 'statement.replace-all', relation, rows: [{ id: literal(3) }] }]);
    expect(await memory.commit(attempt('replace-all', replace))).toMatchObject({ outcome: 'committed', statementResults: [{ matched: 2, inserted: 1, deleted: 2, logicallyChanged: 3 }], afterBasis: { revision: 1 } });
    const identical = await transaction([{ kind: 'statement.replace-all', relation, rows: [{ id: literal(3) }] }]);
    expect(await memory.commit(attempt('replace-identical', identical))).toMatchObject({ outcome: 'committed', statementResults: [{ matched: 1, inserted: 0, deleted: 0, logicallyChanged: 0 }], beforeBasis: { revision: 1 }, afterBasis: { revision: 1 } });
  });

  it('evaluates uniquely named returning queries against final staged state and committed basis', async () => {
    const memory = source({
      evaluateQuery: (_root, state) => ({ rows: state.items ?? [], resultKeys: (state.items ?? []).map((row) => JSON.stringify(row.id)), completeness: 'exact', issues: [] })
    });
    const value = await sealTransaction({ body: {
      schemaView, parameters: {}, statements: [{ kind: 'statement.insert', relation, rows: [{ id: literal(1) }] }], guards: [], requiredCapabilities: [],
      returning: [{ name: 'all', root: queryRoot('all') }]
    } });
    expect(await memory.commit(attempt('returning', value))).toMatchObject({
      outcome: 'committed', afterBasis: { revision: 1 },
      returning: [{ name: 'all', rows: [{ id: 1 }], resultKeys: ['1'], sourceId: 'source:one', basis: { revision: 1 } }]
    });

    const duplicate = await sealTransaction({ body: {
      schemaView, parameters: {}, statements: value.body.statements, guards: [], requiredCapabilities: [],
      returning: [{ name: 'same', root: queryRoot('same') }, { name: 'same', root: queryRoot('same') }]
    } });
    expect(await memory.commit(attempt('returning-duplicate', duplicate))).toMatchObject({ outcome: 'rejected', issues: [{ code: 'transaction.returning_name_duplicate' }] });
  });

  it('uses explicit conflict observations and fails stale resolutions without mutation', async () => {
    const memory = source({ state: { items: [{ id: 1, title: 'left' }] } });
    const resolve = (observed: readonly string[], value: string) => transaction([{
      kind: 'statement.update', target: { relation, alias: 'item' },
      edits: { title: { kind: 'edit.conflict-resolve', observed, value: literal(value) } }
    }]);
    expect(await memory.commit(attempt('resolve', await resolve(['left', 'right'], 'chosen')))).toMatchObject({ outcome: 'committed', statementResults: [{ logicallyChanged: 1, editOutcomes: [{ edit: 'custom' }] }] });
    expect(await memory.commit(attempt('resolve-stale', await resolve(['left', 'right'], 'other')))).toMatchObject({ outcome: 'rejected', issues: [{ code: 'transaction.conflict_changed' }] });
    expect(memory.snapshot().state.items).toEqual([{ id: 1, title: 'chosen' }]);
  });

  it('retains the full portable move intent when a source cannot supply relocation semantics', async () => {
    const memory = source({ state: { items: [{ id: 1, parentId: null }] } });
    const moveCapability = { id: 'urn:test:capability:move', version: '1', contractHash: hash('e') };
    const value = await transaction([{
      kind: 'statement.move', target: { relation, alias: 'item' }, parent: literal('archive'), position: { kind: 'end' }, missingAnchor: 'reject', requires: moveCapability
    }]);
    expect(await memory.commit(attempt('move-unsupported', value))).toMatchObject({ outcome: 'rejected', statementResults: [{ matched: 1 }], issues: [{ code: 'transaction.capability_unavailable' }] });
    expect(memory.snapshot().basis.revision).toBe(0);
  });

  it('rekeys an exact target and reports exact affected counts', async () => {
    const one = source({ state: { items: [{ id: 1, name: 'one' }] } });
    const rekey = await transaction([{
      kind: 'statement.rekey', target: { relation, alias: 'item', where: { kind: 'compare', op: 'eq', left: field('id'), right: literal(1) } },
      key: { id: literal(7) }, references: 'source-local-declared', requires: rekeyCapability
    }], {}, [{ kind: 'guard.affected-count', statementIndex: 0, count: 'logicallyChanged', op: 'eq', value: 1 }]);
    expect(await one.commit(attempt('rekey-success', rekey))).toMatchObject({
      outcome: 'committed', statementResults: [{ matched: 1, logicallyChanged: 1, editOutcomes: [{ edit: 'rekey', mechanism: rekeyCapability, preservationLosses: [] }] }]
    });
    expect(one.snapshot().state.items).toEqual([{ id: 7, name: 'one' }]);
  });

  it('rejects rekey collisions and ambiguous target identities without partial mutation', async () => {
    const collisionSource = source({ state: { items: [{ id: 1 }, { id: 2 }] } });
    const collision = await transaction([{
      kind: 'statement.rekey', target: { relation, alias: 'item', where: { kind: 'compare', op: 'eq', left: field('id'), right: literal(1) } },
      key: { id: literal(2) }, references: 'source-local-declared', requires: rekeyCapability
    }]);
    expect(await collisionSource.commit(attempt('rekey-collision', collision))).toMatchObject({ outcome: 'rejected', statementResults: [{ matched: 1 }], issues: [{ code: 'transaction.rekey_collision' }] });
    expect(collisionSource.snapshot()).toMatchObject({ basis: { revision: 0 }, state: { items: [{ id: 1 }, { id: 2 }] } });

    const ambiguousSource = source({ state: { items: [{ id: 1, copy: 'a' }, { id: 1, copy: 'b' }] } });
    const ambiguous = await transaction([{
      kind: 'statement.rekey', target: { relation, alias: 'item', where: { kind: 'compare', op: 'eq', left: field('id'), right: literal(1) } },
      key: { id: literal(3) }, references: 'source-local-declared', requires: rekeyCapability
    }]);
    expect(await ambiguousSource.commit(attempt('rekey-ambiguous', ambiguous))).toMatchObject({ outcome: 'rejected', statementResults: [{ matched: 2 }], issues: [{ code: 'transaction.rekey_target_ambiguous' }] });
    expect(ambiguousSource.snapshot()).toMatchObject({ basis: { revision: 0 }, state: { items: [{ id: 1 }, { id: 1 }] } });
  });

  it('rejects referenced rekeys and rewrites only declared same-source tuple refs atomically', async () => {
    const parentRelation = { relationId: 'parents', schemaView };
    const relations: readonly MemoryRelation[] = [
      { relationId: 'parents', schemaView, keyFields: ['tenantId', 'id'] },
      { relationId: 'children', schemaView, keyFields: ['id'], referenceFields: [{ field: 'parentRef', targetRelationId: 'parents' }] }
    ];
    const initial: MemoryState = {
      parents: [{ tenantId: 'a', id: 1, name: 'parent' }],
      children: [
        { id: 'c1', parentRef: ['a', 1], looksLikeARef: ['a', 1] },
        { id: 'c2', parentRef: ['a', 1], looksLikeARef: ['a', 1] }
      ]
    };
    const target = { relation: parentRelation, alias: 'parent', where: { kind: 'compare' as const, op: 'eq' as const, left: { kind: 'field' as const, alias: 'parent', name: 'id' }, right: literal(1) } };
    const reject = await transaction([{
      kind: 'statement.rekey', target, key: { tenantId: literal('b'), id: literal(2) }, references: 'reject-if-referenced', requires: rekeyCapability
    }]);
    const blocked = source({ state: initial, relations });
    expect(await blocked.commit(attempt('rekey-referenced', reject))).toMatchObject({ outcome: 'rejected', statementResults: [{ matched: 1 }], issues: [{ code: 'transaction.rekey_referenced' }] });
    expect(blocked.snapshot()).toMatchObject({ basis: { revision: 0 }, state: initial });

    const rewrite = await transaction([{
      kind: 'statement.rekey', target, key: { tenantId: literal('b'), id: literal(2) }, references: 'source-local-declared', requires: rekeyCapability
    }], {}, [{ kind: 'guard.affected-count', statementIndex: 0, count: 'logicallyChanged', op: 'eq', value: 3 }]);
    const rewritten = source({ state: initial, relations });
    expect(await rewritten.commit(attempt('rekey-rewrite', rewrite))).toMatchObject({ outcome: 'committed', statementResults: [{ matched: 1, logicallyChanged: 3 }] });
    expect(rewritten.snapshot().state).toEqual({
      parents: [{ tenantId: 'b', id: 2, name: 'parent' }],
      children: [
        { id: 'c1', parentRef: ['b', 2], looksLikeARef: ['a', 1] },
        { id: 'c2', parentRef: ['b', 2], looksLikeARef: ['a', 1] }
      ]
    });
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
    expect(memory.queryOutcome({ operationEpoch: 'epoch:one', operationId: 'stale', intentHash: stale.intentHash })).toMatchObject({ status: 'known', receipt: stale });
    expect(await memory.commit(attempt('stale', noMatch, { expectedBasis: { incarnation: 'incarnation:one', revision: 99 } }))).toBe(stale);
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

describe('non-atomic batch execution', () => {
  it('returns a structured failed receipt for duplicate step IDs', async () => {
    const value = await transaction([]);
    const receipt = await executeNonAtomicBatch({
      batchId: 'batch:duplicate', failurePolicy: 'stop',
      steps: [{ stepId: 'same', attempt: attempt('duplicate:one', value) }, { stepId: 'same', attempt: attempt('duplicate:two', value) }]
    }, { sourceIdFor: () => 'source:one', commit: () => Promise.reject(new Error('must not execute')) });
    expect(receipt).toMatchObject({ outcome: 'failed', steps: [{ outcome: 'unattempted' }, { outcome: 'unattempted' }], issues: [{ code: 'transaction.batch_step_id_duplicate' }] });
    expect(safeParseReceipt(receipt)).toMatchObject({ success: true, value: receipt });
  });

  it('aggregates all-applied as complete and no-applied known rejection as failed', async () => {
    const completeSource = source();
    const applied = await transaction([{ kind: 'statement.insert', relation, rows: [{ id: literal(1) }] }]);
    const complete = await executeNonAtomicBatch({
      batchId: 'batch:complete', failurePolicy: 'stop', steps: [{ stepId: 'one', attempt: attempt('complete:one', applied) }]
    }, { sourceIdFor: () => 'source:one', commit: (candidate) => completeSource.commit(candidate) });
    expect(complete).toMatchObject({ outcome: 'complete', steps: [{ outcome: 'applied', receipt: { outcome: 'committed' } }] });

    const failedSource = source();
    const rejected = await transaction([{ kind: 'statement.insert', relation, rows: [{ id: parameter('missing') }] }]);
    const failed = await executeNonAtomicBatch({
      batchId: 'batch:failed', failurePolicy: 'stop',
      steps: [{ stepId: 'one', attempt: attempt('failed:one', rejected) }, { stepId: 'two', attempt: attempt('failed:two', applied) }]
    }, { sourceIdFor: () => 'source:one', commit: (candidate) => failedSource.commit(candidate) });
    expect(failed).toMatchObject({ outcome: 'failed', steps: [{ outcome: 'failed', receipt: { outcome: 'rejected' } }, { outcome: 'unattempted' }] });
  });

  it('stops after a known failure, retains nested receipts, and reports partial progress', async () => {
    const memory = source();
    const applied = await transaction([{ kind: 'statement.insert', relation, rows: [{ id: literal(1) }] }]);
    const rejected = await transaction([{ kind: 'statement.insert', relation, rows: [{ id: parameter('missing') }] }]);
    const batch: NonAtomicBatch = {
      batchId: 'batch:stop', failurePolicy: 'stop',
      steps: [
        { stepId: 'one', attempt: attempt('batch:one', applied, { expectedBasis: { incarnation: 'incarnation:one', revision: 0 } }) },
        { stepId: 'two', attempt: attempt('batch:two', rejected) },
        { stepId: 'three', attempt: attempt('batch:three', applied) }
      ]
    };
    const receipt = await executeNonAtomicBatch(batch, { sourceIdFor: () => 'source:one', commit: (candidate) => memory.commit(candidate) });
    expect(receipt).toMatchObject({
      kind: 'non-atomic-batch', outcome: 'partial',
      steps: [
        { stepId: 'one', outcome: 'applied', capturedBasis: { revision: 0 }, receipt: { outcome: 'committed' } },
        { stepId: 'two', outcome: 'failed', receipt: { outcome: 'rejected' } },
        { stepId: 'three', outcome: 'unattempted' }
      ]
    });
    expect(receipt.steps[2]).not.toHaveProperty('receipt');
  });

  it('continues explicitly after failure and fails closed on a lost step result', async () => {
    const memory = source();
    const applied = await transaction([{ kind: 'statement.insert', relation, rows: [{ id: literal(1) }] }]);
    const rejected = await transaction([{ kind: 'statement.insert', relation, rows: [{ id: parameter('missing') }] }]);
    const continued = await executeNonAtomicBatch({
      batchId: 'batch:continue', failurePolicy: 'continue',
      steps: [{ stepId: 'fail', attempt: attempt('continue:fail', rejected) }, { stepId: 'apply', attempt: attempt('continue:apply', applied) }]
    }, { sourceIdFor: () => 'source:one', commit: (candidate) => memory.commit(candidate) });
    expect(continued).toMatchObject({ outcome: 'partial', steps: [{ outcome: 'failed' }, { outcome: 'applied' }] });

    const lost = await executeNonAtomicBatch({
      batchId: 'batch:unknown', failurePolicy: 'stop',
      steps: [{ stepId: 'lost', attempt: attempt('lost', applied) }, { stepId: 'later', attempt: attempt('later', applied) }]
    }, { sourceIdFor: () => 'source:one', commit: () => Promise.reject(new Error('lost result')) });
    expect(lost).toMatchObject({ outcome: 'unknown', steps: [{ outcome: 'unknown' }, { outcome: 'unattempted' }], issues: [{ code: 'transaction.batch_step_outcome_unknown', retry: 'query_outcome' }] });
    expect(lost.steps[0]).not.toHaveProperty('receipt');
  });

  it('retains an unknown receipt when shell membership resolution throws', async () => {
    const value = await transaction([]);
    const receipt = await executeNonAtomicBatch({
      batchId: 'batch:source-resolution', failurePolicy: 'stop',
      steps: [{ stepId: 'lost-source', attempt: attempt('lost-source', value) }]
    }, { sourceIdFor: () => { throw new Error('membership unavailable'); }, commit: () => Promise.reject(new Error('must not execute')) });
    expect(receipt).toMatchObject({ outcome: 'unknown', steps: [{ outcome: 'unknown' }], issues: [{ code: 'transaction.batch_step_outcome_unknown', details: { reason: 'source_resolution_failed' } }] });
    expect(receipt.steps[0]).not.toHaveProperty('sourceId');
    expect(safeParseReceipt(receipt)).toMatchObject({ success: true, value: receipt });
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
