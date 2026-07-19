import * as Automerge from '@automerge/automerge';
import { createIssue, type Issue } from '@tarstate/core';
import type {
  RetainedTextPositionResolution,
  RetainedTextPositionResolver
} from '@tarstate/core/attachment/retained-text-adapter';
import {
  isValidUtf16TextSplice,
  type DatabaseTextPositionRequest
} from '@tarstate/core/transactions';
import type { AutomergeMappedStorageBinding } from './mapped-storage.js';

export const createAutomergeTextPositionResolver = <T extends object>(
  binding: AutomergeMappedStorageBinding<T>
): RetainedTextPositionResolver<Automerge.Doc<T>> => ({
  optimistic,
  committed,
  positions
}) => {
  const optimisticTargets = binding.locateTextPositions(optimistic, positions);
  const committedTargets = binding.locateTextPositions(committed, positions);
  const captures = new Map<string, CursorCapture>();
  const resolutions = new Map<string, CursorResolution>();
  return Object.freeze(positions.map((position, positionIndex): RetainedTextPositionResolution => {
    const optimisticTarget = optimisticTargets[positionIndex]!;
    if (optimisticTarget.state !== 'ready') {
      return unresolved(position.name, 'rejected', optimisticTarget.issues);
    }
    if (!isValidUtf16TextSplice(optimisticTarget.text, {
      index: position.index,
      deleteCount: 0,
      insert: ''
    })) {
      return unresolved(position.name, 'rejected', [positionIssue(
        position.relation.relationId,
        position.field,
        'text_position_range_invalid'
      )]);
    }
    const captureKey = JSON.stringify([
      optimisticTarget.path,
      position.index,
      position.affinity
    ]);
    const capture = captures.get(captureKey)
      ?? captureCursor(optimistic, optimisticTarget.path, position, captures, captureKey);
    if (capture.state === 'rejected') {
      return unresolved(position.name, 'rejected', [positionIssue(
        position.relation.relationId,
        position.field,
        'text_position_capture_failed',
        capture.error
      )]);
    }
    const committedTarget = committedTargets[positionIndex]!;
    if (committedTarget.state !== 'ready') {
      return unresolved(
        position.name,
        committedTarget.state === 'missing' ? 'deleted' : 'rejected',
        committedTarget.issues
      );
    }
    const resolutionKey = JSON.stringify([captureKey, committedTarget.path]);
    const resolution = resolutions.get(resolutionKey)
      ?? resolveCursor(committed, committedTarget.path, capture.cursor, resolutions, resolutionKey);
    if (resolution.state === 'deleted') {
      return unresolved(position.name, 'deleted', [positionIssue(
        position.relation.relationId,
        position.field,
        'text_position_deleted',
        resolution.error
      )]);
    }
    if (!isValidUtf16TextSplice(committedTarget.text, {
      index: resolution.index,
      deleteCount: 0,
      insert: ''
    })) {
      return unresolved(position.name, 'rejected', [positionIssue(
        position.relation.relationId,
        position.field,
        'text_position_resolved_range_invalid'
      )]);
    }
    return Object.freeze({
      name: position.name,
      state: 'resolved',
      index: resolution.index,
      issues: Object.freeze([
        ...optimisticTarget.issues,
        ...committedTarget.issues
      ])
    });
  }));
};

type CursorCapture =
  | { readonly state: 'captured'; readonly cursor: Automerge.Cursor }
  | { readonly state: 'rejected'; readonly error: unknown };

const captureCursor = <T extends object>(
  document: Automerge.Doc<T>,
  path: readonly (string | number)[],
  position: DatabaseTextPositionRequest,
  captures: Map<string, CursorCapture>,
  key: string
): CursorCapture => {
  let capture: CursorCapture;
  try {
    capture = {
      state: 'captured',
      cursor: Automerge.getCursor(document, [...path], position.index, position.affinity)
    };
  } catch (error) {
    capture = {
      state: 'rejected',
      error
    };
  }
  captures.set(key, capture);
  return capture;
};

type CursorResolution =
  | { readonly state: 'resolved'; readonly index: number }
  | { readonly state: 'deleted'; readonly error: unknown };

const resolveCursor = <T extends object>(
  document: Automerge.Doc<T>,
  path: readonly (string | number)[],
  cursor: Automerge.Cursor,
  resolutions: Map<string, CursorResolution>,
  key: string
): CursorResolution => {
  let resolution: CursorResolution;
  try {
    resolution = {
      state: 'resolved',
      index: Automerge.getCursorPosition(document, [...path], cursor)
    };
  } catch (error) {
    resolution = {
      state: 'deleted',
      error
    };
  }
  resolutions.set(key, resolution);
  return resolution;
};

const unresolved = (
  name: string,
  state: 'deleted' | 'rejected',
  issues: readonly Issue[]
): RetainedTextPositionResolution => Object.freeze({
  name,
  state,
  issues: Object.freeze([...issues])
});

const positionIssue = (
  relationId: string,
  field: string,
  reason: string,
  error?: unknown
): Issue => createIssue({
  code: 'transaction.delta_invalid',
  relationId,
  path: [field],
  details: {
    reason,
    ...(error === undefined
      ? {}
      : { error: error instanceof Error ? error.name : typeof error })
  }
});
