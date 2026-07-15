import * as Automerge from '@automerge/automerge';
import { describe, expect, it } from 'vitest';
import * as root from '../src/index.js';
import {
  adoptAutomergeJsonValue,
  adoptConflictFreeAutomergeJsonValue
} from '@tarstate/automerge/values';

describe('inert Automerge JSON adoption', () => {
  it('detaches and deeply freezes portable values without retaining live document state', () => {
    let document = Automerge.from({ artifact: { id: 'artifact:one', body: { values: [1, 2] } } });
    const result = adoptAutomergeJsonValue(document.artifact);
    expect(result).toEqual({
      success: true,
      value: { body: { values: [1, 2] }, id: 'artifact:one' },
      issues: []
    });
    if (!result.success) throw new Error('Expected successful adoption');
    expect(Object.isFrozen(result.value)).toBe(true);
    expect(Object.isFrozen((result.value as { readonly body: object }).body)).toBe(true);
    document = Automerge.change(document, (draft) => { draft.artifact.body.values.push(3); });
    expect(result.value).toEqual({ body: { values: [1, 2] }, id: 'artifact:one' });
    expect(adoptAutomergeJsonValue).toBe(root.adoptAutomergeJsonValue);
  });

  it('adopts the deterministic visible winner unless conflict auditing is requested', () => {
    let left = Automerge.from({ artifact: { version: 0 } }, { actor: '1'.repeat(64) });
    let right = Automerge.clone(left, { actor: '2'.repeat(64) });
    left = Automerge.change(left, (draft) => { draft.artifact.version = 1; });
    right = Automerge.change(right, (draft) => { draft.artifact.version = 2; });
    const merged = Automerge.merge(left, right);
    expect(adoptAutomergeJsonValue(merged.artifact)).toMatchObject({
      success: true,
      value: { version: expect.any(Number) }
    });
    expect(adoptConflictFreeAutomergeJsonValue(merged.artifact)).toMatchObject({
      success: false,
      issues: [{ code: 'automerge.value_conflicted', path: ['version'], details: { alternatives: 2 } }]
    });
  });

  it('rejects Automerge-native values and plain host objects instead of normalizing them', () => {
    const document = Automerge.from({ counter: new Automerge.Counter(1), bytes: new Uint8Array([1, 2]) });
    expect(adoptAutomergeJsonValue(document)).toMatchObject({
      success: false,
      issues: [{ code: 'artifact.unsupported_value', path: ['bytes'], details: { type: 'bytes' } }]
    });
    expect(adoptAutomergeJsonValue({ artifact: true })).toMatchObject({
      success: false,
      issues: [{ code: 'automerge.value_invalid', details: { reason: 'not_automerge_object' } }]
    });
  });

  it('enforces traversal budgets before materializing an unbounded graph', () => {
    const document = Automerge.from({ values: [1, 2, 3] });
    expect(adoptAutomergeJsonValue(document, {
      maxDepth: 8,
      maxArrayMembers: 2,
      maxObjectMembers: 8,
      maxTotalMembers: 8
    })).toMatchObject({
      success: false,
      issues: [{ code: 'artifact.budget_exceeded', path: ['values'], details: { budget: 'maxArrayMembers' } }]
    });
  });
});
