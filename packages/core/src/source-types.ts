import type { TarstateDiagnostic } from './diagnostics.js';
import type { RelationRef } from './schema.js';

export type RelationLookup = {
  readonly relation: RelationRef;
  readonly field: string;
  readonly value: unknown;
};
export type RelationRangeBound<Value = unknown> = {
  readonly value: Value;
  readonly inclusive: boolean;
};
export type RelationRangeLookup = {
  readonly relation: RelationRef;
  readonly field: string;
  readonly lower?: RelationRangeBound;
  readonly upper?: RelationRangeBound;
};
export type RelationSource = {
  readonly relationNames?: readonly string[];
  readonly rows: (relation: RelationRef) => readonly unknown[];
  readonly lookup?: (lookup: RelationLookup) => readonly unknown[] | undefined;
  readonly rangeLookup?: (lookup: RelationRangeLookup) => readonly unknown[] | undefined;
  readonly version?: () => unknown;
  readonly diagnostics?: () => readonly TarstateDiagnostic[];
};
