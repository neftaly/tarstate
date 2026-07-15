import type { CapabilityRef } from './issues.js';
import type { JsonValue } from './value.js';

export type CapabilityClass = 'edit' | 'executor' | 'source' | 'function' | 'codec' | 'collation';

export type CapabilityDeclaration = {
  readonly kind: 'tarstate.capability-contract';
  readonly formatVersion: 1;
  readonly id: string;
  readonly version: string;
  readonly class: CapabilityClass;
  readonly contract: JsonValue;
  readonly implies: readonly CapabilityRef[];
};
