import type { Issue } from './issues.js';
import type { JsonValue } from './value.js';

/** Immutable evidence identifying one exact source state. */
export type SourceBasis = JsonValue;

export type SourceLifecycleState = 'loading' | 'ready' | 'failed' | 'denied' | 'deleted' | 'closed';
export type SourceFreshness = 'current' | 'stale' | 'none';

/** Source-owned state captured at one basis. */
export type SourceSnapshot<Storage> = {
  readonly sourceId: string;
  readonly operationEpoch: string;
  readonly basis: SourceBasis;
  readonly state: SourceLifecycleState;
  readonly freshness: SourceFreshness;
  readonly storage?: Storage;
  readonly issues: readonly Issue[];
};

export type ObservableSource<Storage> = {
  readonly sourceId: string;
  readonly snapshot: () => SourceSnapshot<Storage>;
  readonly subscribe: (listener: () => void) => () => void;
};
