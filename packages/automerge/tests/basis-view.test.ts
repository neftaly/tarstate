import * as Automerge from '@automerge/automerge';
import { describe, expect, it } from 'vitest';
import { viewAutomergeDocumentAtBasis } from '../src/view/index.js';
import {
  automergeBasis,
  exactAutomergeBasisEqual
} from '../src/source/runtime.js';

const actor = (digit: string): string => digit.repeat(64);

describe('public exact-basis document views', () => {
  it('materializes the valid empty-head initial basis', () => {
    const initial = Automerge.init<{ value?: boolean }>();

    const viewed = viewAutomergeDocumentAtBasis(initial, automergeBasis(initial));

    expect(viewed.success).toBe(true);
    if (!viewed.success) throw new Error('Expected initial view');
    expect(Automerge.getHeads(viewed.value)).toEqual([]);
  });

  it('materializes immutable history after the live document advances', () => {
    const initial = Automerge.from({ title: 'Initial' }, { actor: actor('1') });
    const requestedBasis = automergeBasis(initial);
    const current = Automerge.change(initial, (draft) => { draft.title = 'Current'; });

    const viewed = viewAutomergeDocumentAtBasis(current, requestedBasis);

    expect(viewed).toMatchObject({
      success: true,
      value: { title: 'Initial' }
    });
    if (!viewed.success) throw new Error('Expected historical view');
    expect(exactAutomergeBasisEqual(automergeBasis(viewed.value), requestedBasis)).toBe(true);
    Automerge.change(current, (draft) => { draft.title = 'Later'; });
    expect(viewed.value.title).toBe('Initial');
  });

  it('treats an exact head set as order-insensitive', () => {
    const base = Automerge.from({ left: 0, right: 0 }, { actor: actor('2') });
    const left = Automerge.change(
      Automerge.clone(base, { actor: actor('3') }),
      (draft) => { draft.left = 1; }
    );
    const right = Automerge.change(
      Automerge.clone(base, { actor: actor('4') }),
      (draft) => { draft.right = 1; }
    );
    const current = Automerge.merge(left, right);
    const basis = automergeBasis(current);

    const viewed = viewAutomergeDocumentAtBasis(current, {
      kind: basis.kind,
      heads: [...basis.heads].reverse()
    });

    expect(viewed).toMatchObject({ success: true, value: { left: 1, right: 1 } });
  });

  it.each([
    ['wrong adapter', { kind: 'external-store', revision: 1 }, 'unsupported-basis'],
    ['invalid head', { kind: 'automerge-heads', heads: ['not-a-head'] }, 'invalid-basis'],
    ['missing heads', { kind: 'automerge-heads' }, 'invalid-basis']
  ])('reports an explicit result for a %s basis', (_label, basis, reason) => {
    const current = Automerge.from({ value: true });

    expect(viewAutomergeDocumentAtBasis(current, basis)).toMatchObject({
      success: false,
      reason
    });
  });

  it('rejects duplicate heads and hostile accessors without throwing', () => {
    const current = Automerge.from({ value: true });
    const [head] = automergeBasis(current).heads;
    if (head === undefined) throw new Error('Expected fixture head');
    const hostile = Object.defineProperty({}, 'kind', {
      enumerable: true,
      get: () => { throw new Error('getter must not run'); }
    });

    expect(viewAutomergeDocumentAtBasis(current, {
      kind: 'automerge-heads',
      heads: [head, head]
    })).toEqual({ success: false, reason: 'invalid-basis' });
    expect(() => viewAutomergeDocumentAtBasis(current, hostile)).not.toThrow();
    expect(viewAutomergeDocumentAtBasis(current, hostile)).toMatchObject({
      success: false,
      reason: 'invalid-basis'
    });
  });

  it('distinguishes unavailable documents from unreachable history', () => {
    const source = Automerge.from({ value: 'source' }, { actor: actor('5') });
    const unrelated = Automerge.from({ value: 'unrelated' }, { actor: actor('6') });
    const basis = automergeBasis(source);

    expect(viewAutomergeDocumentAtBasis(undefined, basis)).toMatchObject({
      success: false,
      reason: 'document-unavailable'
    });
    expect(viewAutomergeDocumentAtBasis(unrelated, basis)).toMatchObject({
      success: false,
      reason: 'basis-unavailable'
    });
  });

  it('reports values that are not Automerge documents', () => {
    const document = Automerge.init<{ value?: boolean }>();
    const basis = automergeBasis(document);

    expect(viewAutomergeDocumentAtBasis(
      {} as Automerge.Doc<{ value?: boolean }>,
      basis
    )).toEqual({ success: false, reason: 'invalid-document' });
  });
});
