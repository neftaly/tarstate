import * as Automerge from '@automerge/automerge';
import fc from 'fast-check';
import { describe, expect, vi } from 'vitest';
import {
  AutomergeSourceRuntime,
  exactAutomergeBasisEqual,
  type AutomergeSourceCommitResult
} from '../src/source.js';
import { propertyTest } from './support/property-test.js';

type TestDoc = {
  count: number;
  records: Record<string, number>;
  items: string[];
  counter: Automerge.Counter;
  text: string;
};

type ModelDoc = Omit<TestDoc, 'counter'> & { counter: number };
type TestDraft = Parameters<Automerge.ChangeFn<TestDoc>>[0];

type Edit =
  | { readonly kind: 'set-count'; readonly value: number }
  | { readonly kind: 'put-record'; readonly key: string; readonly value: number }
  | { readonly kind: 'delete-record'; readonly key: string }
  | { readonly kind: 'append-item'; readonly value: string }
  | { readonly kind: 'delete-item'; readonly index: number }
  | { readonly kind: 'increment-counter'; readonly by: number }
  | { readonly kind: 'splice-text'; readonly index: number; readonly deleteCount: number; readonly value: string };

type Action =
  | {
      readonly kind: 'commit';
      readonly epoch: number;
      readonly operation: number;
      readonly hashDigit: number;
      readonly basis: 'current' | 'initial';
      readonly edit: Edit;
    }
  | { readonly kind: 'retire'; readonly epoch: number };

const safeString = fc.string({
  maxLength: 6,
  unit: fc.constantFrom('a', 'b', 'c', 'd', 'e', 'f', '0', '1', '2', '3', '4', '5', '6', '7', '8', '9')
});
const key = fc.string({ minLength: 1, maxLength: 4, unit: fc.constantFrom('a', 'b', 'c', 'd') });
const editArbitrary: fc.Arbitrary<Edit> = fc.oneof(
  fc.record({ kind: fc.constant('set-count'), value: fc.integer({ min: -20, max: 20 }) }),
  fc.record({ kind: fc.constant('put-record'), key, value: fc.integer({ min: -20, max: 20 }) }),
  fc.record({ kind: fc.constant('delete-record'), key }),
  fc.record({ kind: fc.constant('append-item'), value: safeString }),
  fc.record({ kind: fc.constant('delete-item'), index: fc.nat({ max: 12 }) }),
  fc.record({ kind: fc.constant('increment-counter'), by: fc.integer({ min: -5, max: 5 }).filter((by) => by !== 0) }),
  fc.record({
    kind: fc.constant('splice-text'),
    index: fc.nat({ max: 12 }),
    deleteCount: fc.nat({ max: 6 }),
    value: safeString
  })
);
const actionArbitrary: fc.Arbitrary<Action> = fc.oneof(
  { weight: 8, arbitrary: fc.record({
    kind: fc.constant('commit'),
    epoch: fc.nat({ max: 3 }),
    operation: fc.nat({ max: 7 }),
    hashDigit: fc.nat({ max: 15 }),
    basis: fc.constantFrom('current' as const, 'initial' as const),
    edit: editArbitrary
  }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant('retire'), epoch: fc.nat({ max: 3 }) }) }
);

const initialModel = (): ModelDoc => ({ count: 0, records: {}, items: [], counter: 0, text: '' });
const initialDocument = (): Automerge.Doc<TestDoc> => Automerge.from<TestDoc>({
  ...initialModel(), counter: new Automerge.Counter(0)
}, { actor: '1'.repeat(64) });
const hash = (digit: number): `sha256:${string}` => `sha256:${(digit & 15).toString(16).repeat(64)}`;
const ledgerKey = (epoch: number, operation: number): string => epoch + '\u0000' + operation;

describe('Automerge shrinking model properties', () => {
  propertyTest('concurrent disjoint player maps survive local commit and merge', fc.asyncProperty(
    fc.dictionary(key, fc.integer({ min: -20, max: 20 }), { minKeys: 1, maxKeys: 8 }),
    fc.dictionary(key, fc.integer({ min: -20, max: 20 }), { minKeys: 1, maxKeys: 8 }),
    async (localRecords, remoteRecords) => {
      const base = initialDocument();
      const runtime = new AutomergeSourceRuntime({ sourceId: 'source:multiplayer-fuzz', doc: base });
      const listener = vi.fn();
      runtime.subscribe(listener);
      const local = Object.fromEntries(Object.entries(localRecords).map(([recordKey, value]) => ['local:' + recordKey, value]));
      const remote = Object.fromEntries(Object.entries(remoteRecords).map(([recordKey, value]) => ['remote:' + recordKey, value]));
      await runtime.commit({
        operationEpoch: 'epoch:multiplayer',
        operationId: 'operation:local',
        intentHash: hash(1),
        expectedBasis: runtime.snapshot().basis,
        commands: [{ apply: (draft) => { Object.assign(draft.records, local); } }]
      });
      const remoteBranch = Automerge.change(
        Automerge.clone(base, { actor: '2'.repeat(64) }),
        (draft) => { Object.assign(draft.records, remote); }
      );

      runtime.merge(remoteBranch);

      expect(runtime.snapshot().storage.records).toEqual({ ...local, ...remote });
      expect(runtime.snapshot().basis.heads).toEqual([...runtime.snapshot().basis.heads].sort());
      expect(listener).toHaveBeenCalledTimes(2);
      runtime.close();
    }
  ));

  propertyTest('commands-replays-stale-bases-and-epoch-retirement-follow-the-model', fc.asyncProperty(
    fc.array(actionArbitrary, { minLength: 1, maxLength: 80 }),
    async (actions) => {
      const runtime = new AutomergeSourceRuntime({ sourceId: 'source:fuzz', doc: initialDocument() });
      const initialBasis = runtime.snapshot().basis;
      const listener = vi.fn();
      runtime.subscribe(listener);
      const model = initialModel();
      const retired = new Set<number>();
      const ledger = new Map<string, { readonly intentHash: `sha256:${string}`; readonly result: AutomergeSourceCommitResult }>();

      for (const action of actions) {
        if (action.kind === 'retire') {
          await runtime.retireOperationEpoch('epoch:' + action.epoch);
          retired.add(action.epoch);
          for (const entryKey of ledger.keys()) if (entryKey.startsWith(action.epoch + '\u0000')) ledger.delete(entryKey);
          expect(runtime.queryOutcome({ operationEpoch: 'epoch:' + action.epoch, operationId: 'unknown', intentHash: hash(0) })).toEqual({ status: 'expired' });
          assertDocument(runtime.snapshot().storage, model);
          continue;
        }

        const operationEpoch = 'epoch:' + action.epoch;
        const operationId = 'operation:' + action.operation;
        const intentHash = hash(action.hashDigit);
        const key = ledgerKey(action.epoch, action.operation);
        const previous = ledger.get(key);
        const expectedBasis = action.basis === 'current' ? runtime.snapshot().basis : initialBasis;
        const basisIsCurrent = exactAutomergeBasisEqual(expectedBasis, runtime.snapshot().basis);
        const beforeBasis = runtime.snapshot().basis;
        const beforeNotifications = listener.mock.calls.length;
        let applications = 0;
        const result = await runtime.commit({
          operationEpoch,
          operationId,
          intentHash,
          expectedBasis,
          commands: [{
            description: action.edit.kind,
            apply: (draft) => {
              applications += 1;
              applyDocumentEdit(draft, action.edit);
            }
          }]
        });

        if (retired.has(action.epoch)) {
          expect(result).toMatchObject({ outcome: 'rejected', issues: [{ code: 'transaction.operation_epoch_expired' }] });
          expect(applications).toBe(0);
        } else if (previous !== undefined) {
          if (previous.intentHash === intentHash) {
            expect(result).toBe(previous.result);
          } else {
            expect(result).toMatchObject({ outcome: 'rejected', issues: [{ code: 'transaction.operation_id_ambiguous' }] });
            expect(runtime.queryOutcome({ operationEpoch, operationId, intentHash: previous.intentHash })).toEqual({ status: 'known', result: previous.result });
          }
          expect(applications).toBe(0);
        } else if (!basisIsCurrent) {
          expect(result).toMatchObject({ outcome: 'rejected', changed: false, issues: [{ code: 'transaction.expected_basis_stale' }] });
          expect(applications).toBe(0);
          expect(runtime.queryOutcome({ operationEpoch, operationId, intentHash })).toEqual({ status: 'not_seen' });
        } else {
          expect(result.outcome).toBe('committed');
          expect(applications).toBe(1);
          applyModelEdit(model, action.edit);
          ledger.set(key, { intentHash, result });
        }

        const changed = !exactAutomergeBasisEqual(beforeBasis, runtime.snapshot().basis);
        expect(listener.mock.calls.length - beforeNotifications).toBe(changed ? 1 : 0);
        if (result.outcome === 'rejected') expect(changed).toBe(false);
        assertDocument(runtime.snapshot().storage, model);
      }
      runtime.close();
    }
  ));

  propertyTest('save-load-preserves-edits-but-starts-a-new-volatile-operation-ledger', fc.asyncProperty(
    fc.array(editArbitrary, { minLength: 1, maxLength: 40 }),
    async (edits) => {
      const runtime = new AutomergeSourceRuntime({ sourceId: 'source:before-save', doc: initialDocument() });
      const model = initialModel();
      for (const [index, edit] of edits.entries()) {
        const result = await runtime.commit({
          operationEpoch: 'epoch:save',
          operationId: 'operation:' + index,
          intentHash: hash(index),
          expectedBasis: runtime.snapshot().basis,
          commands: [{ apply: (draft) => { applyDocumentEdit(draft, edit); } }]
        });
        expect(result.outcome).toBe('committed');
        applyModelEdit(model, edit);
      }
      const loaded = Automerge.load<TestDoc>(Automerge.save(runtime.snapshot().storage), { actor: '2'.repeat(64) });
      runtime.close();
      const recreated = new AutomergeSourceRuntime({ sourceId: 'source:after-load', doc: loaded });
      assertDocument(recreated.snapshot().storage, model);
      expect(recreated.queryOutcome({ operationEpoch: 'epoch:save', operationId: 'operation:0', intentHash: hash(0) })).toEqual({ status: 'not_seen' });
      const afterLoad = await recreated.commit({
        operationEpoch: 'epoch:after-load',
        operationId: 'operation:change',
        intentHash: hash(15),
        expectedBasis: recreated.snapshot().basis,
        commands: [{ apply: (draft) => { draft.count += 1; } }]
      });
      expect(afterLoad).toMatchObject({ outcome: 'committed', changed: true });
      recreated.close();
    }
  ));
});

const applyDocumentEdit = (draft: TestDraft, edit: Edit): void => {
  switch (edit.kind) {
    case 'set-count': draft.count = edit.value; break;
    case 'put-record': draft.records[edit.key] = edit.value; break;
    case 'delete-record': delete draft.records[edit.key]; break;
    case 'append-item': draft.items.push(edit.value); break;
    case 'delete-item': if (edit.index < draft.items.length) draft.items.splice(edit.index, 1); break;
    case 'increment-counter': draft.counter.increment(edit.by); break;
    case 'splice-text': {
      const index = Math.min(edit.index, draft.text.length);
      Automerge.splice(draft, ['text'], index, Math.min(edit.deleteCount, draft.text.length - index), edit.value);
      break;
    }
  }
};

const applyModelEdit = (model: ModelDoc, edit: Edit): void => {
  switch (edit.kind) {
    case 'set-count': model.count = edit.value; break;
    case 'put-record': model.records[edit.key] = edit.value; break;
    case 'delete-record': delete model.records[edit.key]; break;
    case 'append-item': model.items.push(edit.value); break;
    case 'delete-item': if (edit.index < model.items.length) model.items.splice(edit.index, 1); break;
    case 'increment-counter': model.counter += edit.by; break;
    case 'splice-text': {
      const index = Math.min(edit.index, model.text.length);
      model.text = model.text.slice(0, index) + edit.value + model.text.slice(index + edit.deleteCount);
      break;
    }
  }
};

const assertDocument = (document: Automerge.Doc<TestDoc>, model: ModelDoc): void => {
  expect(document.count).toBe(model.count);
  expect({ ...document.records }).toEqual(model.records);
  expect([...document.items]).toEqual(model.items);
  expect(Number(document.counter)).toBe(model.counter);
  expect(document.text).toBe(model.text);
};
