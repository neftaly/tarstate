/** A contained failure from synchronous observation notification or teardown. */
export type ObserverDiagnostic = Readonly<{
  readonly kind: 'listener_error' | 'cleanup_error';
  readonly component: 'dataset-membership' | 'attachment-catalog' | 'database-view' | 'dataset-capture' | 'query-observer' | 'external-store';
  readonly operation: string;
  readonly error: unknown;
}>;

/** Optional host hook for failures that are isolated to preserve committed state. */
export type ObserverDiagnosticReporter = (diagnostic: ObserverDiagnostic) => void;

type DiagnosticContext = Readonly<Pick<ObserverDiagnostic, 'component' | 'operation'>>;

const report = (
  reporter: ObserverDiagnosticReporter | undefined,
  diagnostic: ObserverDiagnostic
): void => {
  if (reporter === undefined) return;
  try {
    reporter(diagnostic);
  } catch {
    // A diagnostics sink is itself an observer. It must never affect the
    // state transition or cleanup whose failure it is reporting.
  }
};

/** Notify every current listener while preserving state and peer isolation. */
export const notifyObservers = <Listener>(
  listeners: Iterable<Listener>,
  invoke: (listener: Listener) => void,
  context: DiagnosticContext,
  reporter?: ObserverDiagnosticReporter
): void => {
  for (const listener of Array.from(listeners)) {
    try {
      invoke(listener);
    } catch (error) {
      report(reporter, Object.freeze({ kind: 'listener_error', ...context, error }));
    }
  }
};

/** Attempt every cleanup and report failures without retaining lifecycle ownership. */
export const runObserverCleanups = (
  cleanups: Iterable<() => void>,
  context: DiagnosticContext,
  reporter?: ObserverDiagnosticReporter
): void => {
  for (const cleanup of cleanups) {
    try {
      cleanup();
    } catch (error) {
      report(reporter, Object.freeze({ kind: 'cleanup_error', ...context, error }));
    }
  }
};

export const reportObserverFailure = (
  kind: ObserverDiagnostic['kind'],
  context: DiagnosticContext,
  error: unknown,
  reporter?: ObserverDiagnosticReporter
): void => report(reporter, Object.freeze({ kind, ...context, error }));
