import type { StoreSnapshot, StoreViewSnapshot } from '@tarstate/core/store';
import type { TarstateReactDiagnostic } from './types.js';

export function shallow(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;

  if (Array.isArray(left) && Array.isArray(right)) {
    return readonlyArraysEqual(left, right, Object.is);
  }

  if (!isPlainRecord(left) || !isPlainRecord(right)) return false;

  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  if (leftKeys.length !== rightKeys.length) return false;

  for (const key of leftKeys) {
    if (!Object.prototype.hasOwnProperty.call(right, key) || !Object.is(left[key], right[key])) return false;
  }

  return true;
}

export function areStoreSnapshotsEqual(left: StoreSnapshot, right: StoreSnapshot): boolean {
  return left.revision === right.revision
    && Object.is(left.db, right.db)
    && Object.is(left.version, right.version)
    && diagnosticsEqual(left.diagnostics, right.diagnostics);
}

export function areViewSnapshotsEqual<Row>(left: StoreViewSnapshot<Row>, right: StoreViewSnapshot<Row>): boolean {
  return left.revision === right.revision
    && left.queryKey === right.queryKey
    && Object.is(left.version, right.version)
    && readonlyArraysEqual(left.rows, right.rows, Object.is)
    && diagnosticsEqual(left.diagnostics, right.diagnostics);
}

export function diagnosticsEqual(
  left: readonly TarstateReactDiagnostic[],
  right: readonly TarstateReactDiagnostic[]
): boolean {
  return readonlyArraysEqual(left, right, diagnosticEqual);
}

export function readonlyArraysEqual<Item>(
  left: readonly Item[],
  right: readonly Item[],
  itemEqual: (left: Item, right: Item) => boolean
): boolean {
  if (left === right) return true;
  if (left.length !== right.length) return false;

  for (let index = 0; index < left.length; index += 1) {
    if (!itemEqual(left[index] as Item, right[index] as Item)) return false;
  }

  return true;
}

export function isPlainRecord(input: unknown): input is Record<string, unknown> {
  if (typeof input !== 'object' || input === null) return false;
  const prototype = Object.getPrototypeOf(input);
  return prototype === Object.prototype || prototype === null;
}

function diagnosticEqual(left: TarstateReactDiagnostic, right: TarstateReactDiagnostic): boolean {
  return left.code === right.code
    && left.severity === right.severity
    && left.message === right.message
    && left.relation === right.relation
    && left.field === right.field
    && left.surface === right.surface
    && Object.is(left.detail, right.detail);
}
