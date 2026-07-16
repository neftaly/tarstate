import type { DatasetMembership } from '../database.js';
import type { ObservedQueryResult, QueryObserver } from '../observer.js';

type SettlementWaitOptions = {
  readonly signal?: AbortSignal;
};

/** Promise lifecycle over a synchronous, reopenable settlement signal. */
export const createDatabaseQuerySettlement = <Row>(
  membership: DatasetMembership,
  observer: QueryObserver<Row>
): {
  readonly whenSettled: (options?: SettlementWaitOptions) => Promise<ObservedQueryResult<Row>>;
  readonly close: () => void;
} => {
  const cancelPending = new Set<(reason: Error) => void>();
  let closed = false;

  const currentResult = (): ObservedQueryResult<Row> | undefined => {
    if (membership.snapshot().state !== 'settled') return undefined;
    const snapshot = observer.getSnapshot();
    return snapshot.state === 'open' ? snapshot.current : undefined;
  };

  const whenSettled = (waitOptions: SettlementWaitOptions = {}): Promise<ObservedQueryResult<Row>> => {
    const signal = waitOptions.signal;
    if (signal?.aborted === true) return Promise.reject(abortError());
    const current = closed ? undefined : currentResult();
    if (current !== undefined) return Promise.resolve(current);
    if (closed) return Promise.reject(closedError());
    return new Promise((complete, fail) => {
      let unsubscribe = (): void => undefined;
      const cleanup = (): void => {
        unsubscribe();
        signal?.removeEventListener('abort', onAbort);
        cancelPending.delete(cancel);
      };
      const settle = (): void => {
        const result = closed ? undefined : currentResult();
        if (result === undefined) return;
        cleanup();
        complete(result);
      };
      const cancel = (reason: Error): void => {
        cleanup();
        fail(reason);
      };
      const onAbort = (): void => { cancel(abortError()); };
      unsubscribe = observer.subscribe(settle);
      cancelPending.add(cancel);
      signal?.addEventListener('abort', onAbort, { once: true });
      settle();
    });
  };

  return {
    whenSettled,
    close: (): void => {
      if (closed) return;
      closed = true;
      const error = closedError();
      for (const cancel of cancelPending) cancel(error);
    }
  };
};

const abortError = (): Error => {
  const error = new Error('Database query settlement was aborted');
  error.name = 'AbortError';
  return error;
};

const closedError = (): Error => new Error('Database query session is closed');
