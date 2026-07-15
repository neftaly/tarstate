import type { Issue } from './issues.js';
import type { JsonValue } from './value.js';

export type Footprint = JsonValue;
export type FootprintRelation = 'disjoint' | 'equal' | 'contains' | 'contained_by' | 'overlaps' | 'unknown';

export type LogicalEditTarget = {
  readonly relationId: string;
  readonly key: JsonValue;
  readonly locator: JsonValue;
};

type LogicalFieldsEdit = LogicalEditTarget & {
  readonly fields: Readonly<Record<string, JsonValue>>;
};

export type LogicalReplaceFieldsEdit = LogicalFieldsEdit & { readonly kind: 'replace-fields' };
export type LogicalReplaceRowEdit = LogicalFieldsEdit & { readonly kind: 'replace-row' };

export type LogicalSemanticEdit =
  | LogicalReplaceFieldsEdit
  | LogicalReplaceRowEdit
  | {
      readonly kind: 'insert';
      readonly relationId: string;
      readonly key: JsonValue;
      readonly fields: Readonly<Record<string, JsonValue>>;
    }
  | (LogicalEditTarget & { readonly kind: 'delete' })
  | (LogicalEditTarget & { readonly kind: 'counter-increment'; readonly field: string; readonly by: number })
  | (LogicalEditTarget & { readonly kind: 'text-splice'; readonly field: string; readonly index: number; readonly deleteCount: number; readonly value: string })
  | (LogicalEditTarget & { readonly kind: 'list-splice'; readonly field: string; readonly index: number; readonly deleteCount: number; readonly values: readonly JsonValue[] })
  | (LogicalEditTarget & { readonly kind: 'conflict-resolve'; readonly field?: string; readonly observedChangeHashes: readonly string[]; readonly selectedChangeHash: string })
  | (LogicalEditTarget & { readonly kind: 'rekey'; readonly newKey: JsonValue })
  | (LogicalEditTarget & {
      readonly kind: 'move-relocate';
      readonly destination: { readonly relationId: string; readonly key: JsonValue; readonly locator?: JsonValue };
      readonly mode: 'identity-preserving' | 'copy-relocate';
    });

export type LogicalEdit = LogicalSemanticEdit;

/** Storage-independent row shape consumed by generic transaction execution. */
export type WritableLogicalRow = {
  readonly relationId: string;
  readonly key: JsonValue;
  readonly fields: Readonly<Record<string, JsonValue>>;
  readonly locator: JsonValue;
};

export type WritableLogicalState = {
  readonly rows: readonly WritableLogicalRow[];
};

export type ProjectionResult<Row = unknown> = {
  readonly rows: readonly Row[];
  readonly completeness: 'exact' | 'unknown';
  readonly issues: readonly Issue[];
};

const sealedStorageProjections = new WeakSet<object>();

/**
 * Seals binding-owned immutable rows so the transaction shell need not
 * canonicalize every field again after the binding has validated projection.
 */
export const sealStorageProjection = <Row>(projection: ProjectionResult<Row>): ProjectionResult<Row> => {
  if (!Object.isFrozen(projection)
    || !Object.isFrozen(projection.rows)
    || !Object.isFrozen(projection.issues)
    || projection.rows.some((row) => row !== null && typeof row === 'object' && !Object.isFrozen(row))) {
    throw new TypeError('Sealed storage projections must own frozen rows and evidence');
  }
  sealedStorageProjections.add(projection);
  return projection;
};

/** @internal */
export const isSealedStorageProjection = (projection: ProjectionResult): boolean =>
  sealedStorageProjections.has(projection);

export type PlannedEditHandling = {
  readonly editIndex: number;
  /** Cooperative handling permits multiple bindings to contribute intents for one edit. */
  readonly mode: 'exclusive' | 'cooperative';
};
