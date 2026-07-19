import * as Automerge from '@automerge/automerge';
import fc from 'fast-check';
import { describe, expect, vi } from 'vitest';
import { isValidUtf16TextSplice } from '@tarstate/core/transactions';
import {
  AutomergeAtomicSource,
} from '../src/adapter/atomic-source.js';
import {
  AutomergeSourceRuntime,
  exactAutomergeBasisEqual,
  type AutomergeSourceCommitResult
} from '../src/source/runtime.js';
import { propertyTest } from '../../core/tests/support/property-test.js';

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
const unicodeText = fc.array(
  fc.constantFrom('a', 'b', '😀', '🙂', 'e\u0301', '\n', '\r\n'),
  { maxLength: 12 }
).map((parts) => parts.join(''));
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
  propertyTest('valid UTF-16 splices match JavaScript and concurrent delivery converges', fc.property(
    unicodeText,
    unicodeText,
    fc.nat(),
    fc.nat(),
    unicodeText,
    fc.nat(),
    fc.nat(),
    (initial, leftInsert, leftStart, leftEnd, rightInsert, rightStart, rightEnd) => {
      const boundaries = codePointBoundaries(initial);
      const left = normalizedSplice(boundaries, leftStart, leftEnd, leftInsert);
      const right = normalizedSplice(boundaries, rightStart, rightEnd, rightInsert);
      expect(isValidUtf16TextSplice(initial, left)).toBe(true);
      expect(isValidUtf16TextSplice(initial, right)).toBe(true);
      const base = Automerge.from({ text: initial }, { actor: '4'.repeat(64) });
      const leftDoc = Automerge.change(
        Automerge.clone(base, { actor: '5'.repeat(64) }),
        (draft) => { Automerge.splice(draft, ['text'], left.index, left.deleteCount, left.insert); }
      );
      const rightDoc = Automerge.change(
        Automerge.clone(base, { actor: '6'.repeat(64) }),
        (draft) => { Automerge.splice(draft, ['text'], right.index, right.deleteCount, right.insert); }
      );
      expect(leftDoc.text).toBe(applyStringSplice(initial, left));
      expect(rightDoc.text).toBe(applyStringSplice(initial, right));
      // Automerge's WASM handles are stateful even though Doc values are
      // immutable at the API. Independent clones keep the delivery-order
      // comparison from sharing merge internals.
      const leftThenRight = Automerge.merge(Automerge.clone(leftDoc), Automerge.clone(rightDoc));
      const rightThenLeft = Automerge.merge(Automerge.clone(rightDoc), Automerge.clone(leftDoc));
      expect(leftThenRight.text).toBe(rightThenLeft.text);
      expect(Automerge.getHeads(leftThenRight).sort()).toEqual(Automerge.getHeads(rightThenLeft).sort());
    }
  ));

  propertyTest('captured text reconciliation retains one local change across integration races', fc.property(
    unicodeText,
    unicodeText,
    fc.nat(),
    fc.nat(),
    unicodeText,
    fc.nat(),
    fc.nat(),
    (initial, localInsert, localStart, localEnd, remoteInsert, remoteStart, remoteEnd) => {
      type TextDocument = { text: string };
      const boundaries = codePointBoundaries(initial);
      const local = normalizedSplice(boundaries, localStart, localEnd, 'L' + localInsert);
      const remote = normalizedSplice(boundaries, remoteStart, remoteEnd, 'R' + remoteInsert);
      const base = Automerge.from<TextDocument>({ text: initial }, { actor: '7'.repeat(64) });
      const historyBase = Automerge.load<TextDocument>(Automerge.save(base), { actor: '8'.repeat(64) });
      const runtime = new AutomergeSourceRuntime({ sourceId: 'source:text-reconcile-fuzz', doc: base });
      const source = new AutomergeAtomicSource({ runtime, operationEpoch: 'epoch:text-reconcile' });
      const observed = source.snapshot();
      const firstRemote = Automerge.change(
        Automerge.clone(base, { actor: '9'.repeat(64) }),
        (draft) => { Automerge.splice(draft, ['text'], remote.index, remote.deleteCount, remote.insert); }
      );
      runtime.merge(firstRemote);
      const firstIntegration = source.snapshot();
      const commands = [{
        apply: (draft: Parameters<Automerge.ChangeFn<TextDocument>>[0]) => {
          Automerge.splice(draft, ['text'], local.index, local.deleteCount, local.insert);
        }
      }];
      const firstCandidate = source.reconcile!(firstIntegration, observed.basis, commands);
      expect(firstCandidate.issues).toEqual([]);
      expect(Automerge.getChanges(historyBase, firstCandidate.storage)).toHaveLength(2);

      const secondRemote = Automerge.change(
        Automerge.clone(runtime.snapshot().storage, { actor: 'a'.repeat(64) }),
        (draft) => { Automerge.splice(draft, ['text'], draft.text.length, 0, 'S'); }
      );
      runtime.merge(secondRemote);
      const secondIntegration = source.snapshot();
      const secondCandidate = source.reconcile!(
        secondIntegration,
        observed.basis,
        commands,
        firstCandidate.storage
      );
      expect(secondCandidate.issues).toEqual([]);
      expect(Automerge.getChanges(historyBase, secondCandidate.storage)).toHaveLength(3);
      expect(Automerge.hasHeads(
        secondCandidate.storage,
        Automerge.getHeads(firstCandidate.storage)
      )).toBe(true);
      expect(isValidUtf16TextSplice(secondCandidate.storage.text, {
        index: secondCandidate.storage.text.length,
        deleteCount: 0,
        insert: ''
      })).toBe(true);
      source.close();
    }
  ));

  propertyTest('dependent local text changes survive concurrent delivery orders', fc.property(
    unicodeText,
    safeString,
    fc.nat(),
    fc.nat(),
    unicodeText,
    fc.nat(),
    fc.nat(),
    (initial, localText, localStart, localEnd, remoteText, remoteStart, remoteEnd) => {
      const boundaries = codePointBoundaries(initial);
      const localInsert = 'L' + localText + 'M';
      const firstLocal = normalizedSplice(boundaries, localStart, localEnd, localInsert);
      const remote = normalizedSplice(boundaries, remoteStart, remoteEnd, 'R' + remoteText);
      const base = Automerge.from({ text: initial }, { actor: 'b'.repeat(64) });
      const localFirst = Automerge.change(
        Automerge.clone(base, { actor: 'c'.repeat(64) }),
        (draft) => {
          Automerge.splice(
            draft,
            ['text'],
            firstLocal.index,
            firstLocal.deleteCount,
            firstLocal.insert
          );
        }
      );
      const localCandidate = Automerge.change(localFirst, (draft) => {
        Automerge.splice(draft, ['text'], firstLocal.index + 1, 0, 'Z');
      });
      const remoteCandidate = Automerge.change(
        Automerge.clone(base, { actor: 'd'.repeat(64) }),
        (draft) => {
          Automerge.splice(draft, ['text'], remote.index, remote.deleteCount, remote.insert);
        }
      );
      const localThenRemote = Automerge.merge(
        Automerge.clone(localCandidate),
        Automerge.clone(remoteCandidate)
      );
      const remoteThenLocal = Automerge.merge(
        Automerge.clone(remoteCandidate),
        Automerge.clone(localCandidate)
      );

      expect(Automerge.getChanges(base, localCandidate)).toHaveLength(2);
      expect(localThenRemote.text).toBe(remoteThenLocal.text);
      expect(localThenRemote.text).toContain('LZ' + localText + 'M');
      expect(Automerge.getHeads(localThenRemote).sort())
        .toEqual(Automerge.getHeads(remoteThenLocal).sort());
    }
  ));

  propertyTest('buffered dependent splices reconcile as one change after remote edits', fc.property(
    unicodeText,
    safeString,
    fc.nat(),
    unicodeText,
    fc.nat(),
    fc.nat(),
    (initial, localText, localPosition, remoteText, remoteStart, remoteEnd) => {
      type TextDocument = { text: string };
      const boundaries = codePointBoundaries(initial);
      const insertionBoundary = boundaries[localPosition % boundaries.length] ?? 0;
      const localInsert = 'L' + localText + 'M';
      const remote = normalizedSplice(boundaries, remoteStart, remoteEnd, 'R' + remoteText);
      const base = Automerge.from<TextDocument>({ text: initial }, { actor: 'c'.repeat(64) });
      const runtime = new AutomergeSourceRuntime({ sourceId: 'source:buffered-text-fuzz', doc: base });
      const source = new AutomergeAtomicSource({ runtime, operationEpoch: 'epoch:buffered-text-fuzz' });
      const observed = source.snapshot();
      runtime.merge(Automerge.change(
        Automerge.clone(base, { actor: 'd'.repeat(64) }),
        (draft) => {
          Automerge.splice(draft, ['text'], remote.index, remote.deleteCount, remote.insert);
        }
      ));

      const candidate = source.reconcile!(source.snapshot(), observed.basis, [{
        apply: (draft: Parameters<Automerge.ChangeFn<TextDocument>>[0]) => {
          Automerge.splice(draft, ['text'], insertionBoundary, 0, localInsert);
          Automerge.splice(draft, ['text'], insertionBoundary + 1, 0, 'Z');
        }
      }]);

      expect(candidate.issues).toEqual([]);
      expect(candidate.storage.text).toContain('LZ' + localText + 'M');
      expect(candidate.storage.text).toContain('R' + remoteText);
      expect(Automerge.getChanges(base, candidate.storage)).toHaveLength(2);
      source.close();
    }
  ));

  propertyTest('retained text branches preserve dependent splices across publications', fc.asyncProperty(
    unicodeText,
    safeString,
    fc.nat(),
    unicodeText,
    async (initial, localText, localPosition, remoteText) => {
      type TextDocument = { text: string };
      const boundaries = codePointBoundaries(initial);
      const insertionBoundary = boundaries[localPosition % boundaries.length] ?? 0;
      const localInsert = 'L' + localText + 'M';
      const base = Automerge.from<TextDocument>({ text: initial }, { actor: 'e'.repeat(64) });
      const runtime = new AutomergeSourceRuntime({
        sourceId: 'source:retained-text-fuzz',
        doc: base
      });
      const source = new AutomergeAtomicSource({
        runtime,
        operationEpoch: 'epoch:retained-text-fuzz'
      });
      const observed = source.snapshot();
      const privateBase = {
        ...observed,
        storage: source.createPrivateBranch!(observed)
      };
      const prefixCommand = {
        apply: (draft: Parameters<Automerge.ChangeFn<TextDocument>>[0]) => {
          Automerge.splice(draft, ['text'], insertionBoundary, 0, localInsert);
        }
      };
      const prefix = source.stage(privateBase, [prefixCommand]);
      const prefixBasis = source.basisForStagedStorage!(privateBase, prefix.storage);
      runtime.merge(Automerge.change(
        Automerge.clone(base, { actor: 'f'.repeat(64) }),
        (draft) => {
          Automerge.splice(draft, ['text'], 0, 0, 'R' + remoteText);
        }
      ));
      const firstIntegration = source.snapshot();
      const firstCandidate = source.reconcile!(
        firstIntegration,
        observed.basis,
        [prefixCommand],
        prefix.storage
      );
      expect(firstCandidate.issues).toEqual([]);
      await expect(source.commitReconciled!({
        operationEpoch: source.operationEpoch,
        operationId: 'operation:retained-prefix',
        intentHash: hash(8),
        expectedBasis: firstIntegration.basis,
        candidate: firstCandidate.storage
      })).resolves.toMatchObject({ outcome: 'committed' });

      const prefixBranch = { ...privateBase, basis: prefixBasis, storage: prefix.storage };
      const suffixCommand = {
        apply: (draft: Parameters<Automerge.ChangeFn<TextDocument>>[0]) => {
          Automerge.splice(draft, ['text'], insertionBoundary + 1, 0, 'Z');
        }
      };
      const suffix = source.stage(prefixBranch, [suffixCommand]);
      const suffixCandidate = source.reconcile!(
        source.snapshot(),
        prefixBasis,
        [suffixCommand],
        suffix.storage
      );
      expect(suffixCandidate.issues).toEqual([]);
      await expect(source.commitReconciled!({
        operationEpoch: source.operationEpoch,
        operationId: 'operation:retained-suffix',
        intentHash: hash(9),
        expectedBasis: source.snapshot().basis,
        candidate: suffixCandidate.storage
      })).resolves.toMatchObject({ outcome: 'committed' });
      expect(runtime.snapshot().storage.text).toContain('LZ' + localText + 'M');
      expect(runtime.snapshot().storage.text).toContain('R' + remoteText);
      source.close();
    }
  ));

  propertyTest('staged generated identities equal committed and replayed evidence', fc.asyncProperty(
    fc.array(safeString, { minLength: 1, maxLength: 8 }),
    async (values) => {
      type IdentityDocument = { readonly items: { value: string }[] };
      const runtime = new AutomergeSourceRuntime<IdentityDocument>({
        sourceId: 'source:generated-identity-fuzz',
        doc: Automerge.from<IdentityDocument>({ items: [] }, { actor: '3'.repeat(64) })
      });
      const source = new AutomergeAtomicSource({ runtime, operationEpoch: 'epoch:generated' });
      const before = source.snapshot();
      const command = {
        generatesKeys: true as const,
        apply: (
          draft: Parameters<Automerge.ChangeFn<IdentityDocument>>[0],
          context: Parameters<import('../src/source/runtime.js').AutomergeSourceCommand<IdentityDocument>['apply']>[1]
        ) => {
          values.forEach((value, index) => {
            draft.items.push({ value });
            const objectId = Automerge.getObjectId(draft.items[draft.items.length - 1]!);
            if (objectId === null) throw new Error('missing generated object identity');
            context.recordGeneratedKey('items', String(index), [objectId]);
          });
        }
      };
      const staged = source.stage(before, [command]);
      const stagedKeys = staged.storage.items.map((item) => [Automerge.getObjectId(item)]);
      const input = {
        operationEpoch: 'epoch:generated',
        operationId: 'operation:generated',
        intentHash: hash(7),
        expectedBasis: before.basis,
        commands: [command]
      };

      const committed = await source.commit(input);
      expect(committed).toMatchObject({ outcome: 'committed' });
      expect(committed.generatedKeys?.map(({ key }) => key)).toEqual(stagedKeys);
      expect(runtime.snapshot().storage.items.map((item) => [Automerge.getObjectId(item)])).toEqual(stagedKeys);

      const replayed = await source.commit(input);
      expect(replayed).toEqual(committed);
      expect(runtime.snapshot().storage.items).toHaveLength(values.length);
      source.close();
    }
  ));

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

type NormalizedSplice = {
  readonly index: number;
  readonly deleteCount: number;
  readonly insert: string;
};

const codePointBoundaries = (value: string): readonly number[] => {
  const boundaries = [0];
  let offset = 0;
  for (const point of value) {
    offset += point.length;
    boundaries.push(offset);
  }
  return boundaries;
};

const normalizedSplice = (
  boundaries: readonly number[],
  first: number,
  second: number,
  insert: string
): NormalizedSplice => {
  const left = boundaries[first % boundaries.length] as number;
  const right = boundaries[second % boundaries.length] as number;
  const index = Math.min(left, right);
  return { index, deleteCount: Math.max(left, right) - index, insert };
};

const applyStringSplice = (value: string, edit: NormalizedSplice): string =>
  value.slice(0, edit.index) + edit.insert + value.slice(edit.index + edit.deleteCount);

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
