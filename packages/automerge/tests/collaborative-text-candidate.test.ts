import * as Automerge from '@automerge/automerge';
import { describe, expect, it } from 'vitest';

type TextDocument = { text: string };

type TextSplice = {
  readonly index: number;
  readonly deleteCount: number;
  readonly insert: string;
};

const actor = (digit: string): string => digit.repeat(64);

const applySplices = (
  document: Automerge.Doc<TextDocument>,
  edits: readonly TextSplice[],
  actorId: string
): Automerge.Doc<TextDocument> => Automerge.change(
  Automerge.clone(document, actorId),
  { time: 0 },
  (draft) => {
    for (const edit of edits) {
      Automerge.splice(draft, ['text'], edit.index, edit.deleteCount, edit.insert);
    }
  }
);

const mergeBothWays = (
  left: Automerge.Doc<TextDocument>,
  right: Automerge.Doc<TextDocument>
): readonly [Automerge.Doc<TextDocument>, Automerge.Doc<TextDocument>] => [
  Automerge.merge(Automerge.clone(left, actor('e')), right),
  Automerge.merge(Automerge.clone(right, actor('f')), left)
];

describe('collaborative text candidate feasibility', () => {
  it('retains causally dependent local splices through concurrent delivery orders', () => {
    const initial = Automerge.from<TextDocument>({ text: 'abcd' }, { actor: actor('1') });
    const firstLocal = applySplices(initial, [
      { index: 2, deleteCount: 0, insert: 'XY' }
    ], actor('2'));
    const localCandidate = Automerge.change(firstLocal, { time: 0 }, (draft) => {
      Automerge.splice(draft, ['text'], 3, 1, 'Z');
    });
    expect(localCandidate.text).toBe('abXZcd');

    const remote = applySplices(initial, [
      { index: 0, deleteCount: 0, insert: 'R' },
      { index: 2, deleteCount: 0, insert: 'Q' }
    ], actor('3'));
    const [localThenRemote, remoteThenLocal] = mergeBothWays(localCandidate, remote);

    expect(localThenRemote.text).toBe(remoteThenLocal.text);
    expect(localThenRemote.text).toContain('XZ');
    expect(localThenRemote.text).toContain('R');
    expect(localThenRemote.text).toContain('Q');
    expect([...Automerge.getHeads(localThenRemote)].sort())
      .toEqual([...Automerge.getHeads(remoteThenLocal)].sort());
  });

  it('continues local intent from a candidate that already integrated remote work', () => {
    const initial = Automerge.from<TextDocument>({ text: 'abcd' }, { actor: actor('9') });
    const firstLocal = applySplices(initial, [
      { index: 2, deleteCount: 0, insert: 'X' }
    ], actor('a'));
    const firstRemote = applySplices(initial, [
      { index: 0, deleteCount: 0, insert: 'R' }
    ], actor('b'));
    const integrated = mergeBothWays(firstLocal, firstRemote)[0];
    const insertedPosition = integrated.text.indexOf('X');
    expect(insertedPosition).toBeGreaterThanOrEqual(0);
    const continuedLocal = Automerge.change(integrated, { time: 0 }, (draft) => {
      Automerge.splice(draft, ['text'], insertedPosition + 1, 0, 'Z');
    });
    const secondRemote = Automerge.change(firstRemote, { time: 0 }, (draft) => {
      Automerge.splice(draft, ['text'], firstRemote.text.length, 0, 'Q');
    });
    const [localThenRemote, remoteThenLocal] = mergeBothWays(continuedLocal, secondRemote);

    expect(localThenRemote.text).toBe(remoteThenLocal.text);
    expect(localThenRemote.text).toContain('XZ');
    expect(localThenRemote.text).toContain('R');
    expect(localThenRemote.text).toContain('Q');
    expect([...Automerge.getHeads(localThenRemote)].sort())
      .toEqual([...Automerge.getHeads(remoteThenLocal)].sort());
  });

  it('resolves deletion-aware relative positions equivalently after convergence', () => {
    const initial = Automerge.from<TextDocument>({ text: 'abcdef' }, { actor: actor('4') });
    const moveBefore = Automerge.getCursor(initial, ['text'], 2, 'before');
    const moveAfter = Automerge.getCursor(initial, ['text'], 2, 'after');
    const local = applySplices(initial, [
      { index: 6, deleteCount: 0, insert: '!' }
    ], actor('5'));
    const remote = applySplices(initial, [
      { index: 1, deleteCount: 3, insert: '' }
    ], actor('6'));
    const [localThenRemote, remoteThenLocal] = mergeBothWays(local, remote);

    expect(localThenRemote.text).toBe(remoteThenLocal.text);
    const beforePosition = Automerge.getCursorPosition(localThenRemote, ['text'], moveBefore);
    const afterPosition = Automerge.getCursorPosition(localThenRemote, ['text'], moveAfter);
    expect(beforePosition).toBe(0);
    expect(afterPosition).toBe(1);
    expect(Automerge.getCursorPosition(remoteThenLocal, ['text'], moveBefore))
      .toBe(beforePosition);
    expect(Automerge.getCursorPosition(remoteThenLocal, ['text'], moveAfter))
      .toBe(afterPosition);
  });

  it('can submit buffered dependent splices as one source-native change', () => {
    const initial = Automerge.from<TextDocument>({ text: 'abcd' }, { actor: actor('7') });
    const candidate = applySplices(initial, [
      { index: 2, deleteCount: 0, insert: 'XY' },
      { index: 3, deleteCount: 1, insert: 'Z' }
    ], actor('8'));

    expect(candidate.text).toBe('abXZcd');
    expect(Automerge.getChanges(initial, candidate)).toHaveLength(1);
  });
});
