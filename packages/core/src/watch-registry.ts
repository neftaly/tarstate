import type {
  UnwatchResult,
  WatchDb,
  WatchEvent,
  WatchListener,
  WatchOptions,
  WatchTarget,
  WatchUnsubscribeResult
} from './watch.js';

export type WatchRegistration<Row = unknown> = {
  readonly id: string;
  readonly target: WatchTarget<Row>;
  readonly listener: WatchListener<Row>;
  readonly options: WatchOptions<Row>;
  readonly setPreviousRows: (rows: readonly Row[]) => void;
};

let nextIdValue = 0;

export function nextWatchId(): string {
  nextIdValue += 1;
  return `watch-${nextIdValue}`;
}

export function isWatchClosed(_id: string): boolean {
  return true;
}

export function registerWatch<Row>(_owner: object, _registration: WatchRegistration<Row>): void {}

export function activeWatchRegistrations(_owner: WatchDb): readonly WatchRegistration[] {
  return [];
}

export function currentWatchOwner(_id: string): object | undefined {
  return undefined;
}

export function transferWatchRegistrations(_from: object, _to: object): void {}

export function transferWatchRegistration(_id: string, _to: object): void {}

export function addWatchSubscriber<Row>(
  _id: string,
  _listener: WatchListener<Row>
): (() => WatchUnsubscribeResult) | undefined {
  return undefined;
}

export async function deliverWatchEvent<Row>(
  _listener: WatchListener<Row>,
  _event: WatchEvent<Row>
): Promise<readonly []> {
  return [];
}

export function closeWatch(id: string): UnwatchResult {
  return {
    kind: 'unwatch',
    id,
    closed: true,
    diagnostics: []
  };
}
