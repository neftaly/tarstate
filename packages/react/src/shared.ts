import type {
  ObserverDiagnostic,
  ObserverDiagnosticReporter
} from '@tarstate/core';
import type { OptimisticProjection } from './contracts.js';

export const errorDetails = (error: unknown): { readonly name: string; readonly message: string } =>
  error instanceof Error ? { name: error.name, message: error.message } : { name: typeof error, message: String(error) };

type ReactDiagnosticComponent = Extract<ObserverDiagnostic['component'], `react-${string}`>;

const reportReactDiagnostic = (
  reporter: ObserverDiagnosticReporter | undefined,
  diagnostic: ObserverDiagnostic
): void => {
  if (reporter === undefined) return;
  try { reporter(diagnostic); } catch { /* diagnostics cannot affect adapter state */ }
};

export const notifyReactListeners = (
  listeners: Iterable<() => void>,
  component: ReactDiagnosticComponent,
  operation: string,
  reporter?: ObserverDiagnosticReporter
): void => {
  for (const listener of Array.from(listeners)) {
    try { listener(); } catch (error) {
      reportReactDiagnostic(reporter, Object.freeze({ kind: 'listener_error', component, operation, error }));
    }
  }
};

export const runReactCleanups = (
  cleanups: Iterable<() => void>,
  component: ReactDiagnosticComponent,
  operation: string,
  reporter?: ObserverDiagnosticReporter
): void => {
  for (const cleanup of cleanups) {
    try { cleanup(); } catch (error) {
      reportReactDiagnostic(reporter, Object.freeze({ kind: 'cleanup_error', component, operation, error }));
    }
  }
};

export const adoptOptimisticProjection = <Row>(candidate: OptimisticProjection<Row>): OptimisticProjection<Row> => {
  const projection = deepFreezeClone(candidate);
  if (
    projection === null
    || typeof projection !== 'object'
    || !Array.isArray(projection.rows)
    || !Array.isArray(projection.resultKeys)
    || projection.rows.length !== projection.resultKeys.length
    || projection.resultKeys.some((key) => typeof key !== 'string')
    || new Set(projection.resultKeys).size !== projection.resultKeys.length
  ) {
    throw new TypeError('rows and unique string resultKeys must have equal lengths');
  }
  return projection;
};

export const deepFreezeClone = <Value>(value: Value, seen = new WeakMap<object, object>()): Value => {
  if (value === null || typeof value !== 'object') return value;
  const prior = seen.get(value);
  if (prior !== undefined) return prior as Value;
  if (Array.isArray(value)) {
    const output: unknown[] = [];
    seen.set(value, output);
    for (const item of value) output.push(deepFreezeClone(item, seen));
    return Object.freeze(output) as Value;
  }
  const output: Record<string, unknown> = {};
  seen.set(value, output);
  for (const [key, item] of Object.entries(value)) output[key] = deepFreezeClone(item, seen);
  return Object.freeze(output) as Value;
};
