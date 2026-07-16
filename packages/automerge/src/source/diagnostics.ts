/** A contained Automerge source observer or lifecycle failure. */
export type AutomergeSourceDiagnostic = Readonly<{
  readonly kind: 'listener_error' | 'cleanup_error';
  readonly component: 'source-runtime' | 'atomic-source';
  readonly operation: string;
  readonly error: unknown;
}>;

/** Optional host hook for failures isolated from committed source state. */
export type AutomergeSourceDiagnosticReporter = (diagnostic: AutomergeSourceDiagnostic) => void;

export const reportAutomergeDiagnostic = (
  reporter: AutomergeSourceDiagnosticReporter | undefined,
  diagnostic: AutomergeSourceDiagnostic
): void => {
  if (reporter === undefined) return;
  try {
    reporter(Object.freeze(diagnostic));
  } catch {
    // Diagnostics are observers and cannot affect the transition they report.
  }
};

export const runAutomergeCleanups = (
  cleanups: Iterable<Readonly<{ readonly operation: string; readonly cleanup: () => void }>>,
  component: AutomergeSourceDiagnostic['component'],
  reporter?: AutomergeSourceDiagnosticReporter
): void => {
  for (const { operation, cleanup } of cleanups) {
    try {
      cleanup();
    } catch (error) {
      reportAutomergeDiagnostic(reporter, { kind: 'cleanup_error', component, operation, error });
    }
  }
};
