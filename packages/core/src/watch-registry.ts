import type {
  UnwatchResult,
  WatchDb,
  WatchDiagnostic,
  WatchEvent,
  WatchListener,
  WatchOptions,
  WatchTarget
} from './watch.js';

export type WatchRegistration = {
  readonly id: string;
  readonly target: WatchTarget;
  readonly listener: WatchListener;
  readonly options: WatchOptions;
  readonly setPreviousRows: (rows: readonly unknown[]) => void;
};

const closedWatches = new Set<string>();
const watchRegistrations = new WeakMap<object, Map<string, WatchRegistration>>();
const watchOwners = new Map<string, object>();
const watchSubscribers = new Map<string, Map<WatchListener, number>>();
let nextWatchNumber = 1;

export function nextWatchId(): string {
  const id = `watch:${nextWatchNumber}`;
  nextWatchNumber += 1;
  return id;
}

export function isWatchClosed(id: string): boolean {
  return closedWatches.has(id);
}

export function registerWatch(owner: object, registration: WatchRegistration): void {
  const registrations = watchRegistrations.get(owner) ?? new Map<string, WatchRegistration>();

  registrations.set(registration.id, registration);
  watchRegistrations.set(owner, registrations);
  watchOwners.set(registration.id, owner);
}

export function activeWatchRegistrations(owner: WatchDb): readonly WatchRegistration[] {
  return Array.from(watchRegistrations.get(owner)?.values() ?? []).filter(
    (registration) => !closedWatches.has(registration.id)
  );
}

export function currentWatchOwner(id: string): object | undefined {
  return watchOwners.get(id);
}

export function transferWatchRegistrations(from: object, to: object): void {
  if (from === to) {
    return;
  }

  const registrations = watchRegistrations.get(from);

  if (registrations === undefined) {
    return;
  }

  watchRegistrations.delete(from);
  watchRegistrations.set(to, registrations);

  for (const id of registrations.keys()) {
    watchOwners.set(id, to);
  }
}

export function transferWatchRegistration(id: string, to: object): void {
  const from = watchOwners.get(id);

  if (from === undefined || from === to) {
    return;
  }

  const registrations = watchRegistrations.get(from);
  const registration = registrations?.get(id);

  if (registration === undefined) {
    watchOwners.delete(id);
    return;
  }

  registrations?.delete(id);

  if (registrations?.size === 0) {
    watchRegistrations.delete(from);
  }

  const nextRegistrations = watchRegistrations.get(to) ?? new Map<string, WatchRegistration>();
  nextRegistrations.set(id, registration);
  watchRegistrations.set(to, nextRegistrations);
  watchOwners.set(id, to);
}

export function addWatchSubscriber<Row>(
  id: string,
  listener: WatchListener<Row>
): (() => boolean) | undefined {
  if (closedWatches.has(id) || !watchOwners.has(id)) {
    return undefined;
  }

  const subscriber = listener as WatchListener;
  const subscribers = watchSubscribers.get(id) ?? new Map<WatchListener, number>();
  // Delivery de-dupes by function identity; the count keeps duplicate handles alive until all are unsubscribed.
  subscribers.set(subscriber, (subscribers.get(subscriber) ?? 0) + 1);
  watchSubscribers.set(id, subscribers);

  let active = true;

  return () => {
    if (!active) {
      return false;
    }

    active = false;
    const currentSubscribers = watchSubscribers.get(id);
    const currentCount = currentSubscribers?.get(subscriber);

    if (currentSubscribers === undefined || currentCount === undefined) {
      return false;
    }

    if (currentCount <= 1) {
      currentSubscribers.delete(subscriber);
    } else {
      currentSubscribers.set(subscriber, currentCount - 1);
    }

    if (currentSubscribers.size === 0) {
      watchSubscribers.delete(id);
    }

    return true;
  };
}

export async function deliverWatchEvent<Row>(
  listener: WatchListener<Row>,
  event: WatchEvent<Row>
): Promise<readonly WatchDiagnostic[]> {
  const diagnostics: WatchDiagnostic[] = [];

  for (const nextListener of watchEventListeners(listener, event.id)) {
    try {
      await nextListener(event);
    } catch (error) {
      diagnostics.push(watchListenerErrorDiagnostic(event.id, error));
    }
  }

  return diagnostics;
}

export function closeWatch(id: string): UnwatchResult {
  if (closedWatches.has(id)) {
    return {
      kind: 'unwatch',
      id,
      closed: false,
      diagnostics: [
        {
          code: 'watch_already_closed',
          message: `watch ${id} is already closed`,
          surface: 'watch'
        }
      ]
    };
  }

  closedWatches.add(id);
  unregisterWatch(id);
  return {
    kind: 'unwatch',
    id,
    closed: true,
    diagnostics: []
  };
}

function unregisterWatch(id: string): void {
  const owner = watchOwners.get(id);

  if (owner === undefined) {
    watchSubscribers.delete(id);
    return;
  }

  const registrations = watchRegistrations.get(owner);
  registrations?.delete(id);

  if (registrations?.size === 0) {
    watchRegistrations.delete(owner);
  }

  watchOwners.delete(id);
  watchSubscribers.delete(id);
}

function watchEventListeners<Row>(listener: WatchListener<Row>, id: string): readonly WatchListener<Row>[] {
  const listeners = new Set<WatchListener<Row>>();
  listeners.add(listener);

  for (const subscriber of watchSubscribers.get(id)?.keys() ?? []) {
    listeners.add(subscriber as WatchListener<Row>);
  }

  return Array.from(listeners);
}

function watchListenerErrorDiagnostic(id: string, error: unknown): WatchDiagnostic {
  return {
    code: 'watch_listener_error',
    message: `watch ${id} listener failed`,
    surface: 'watch',
    detail: error
  };
}
