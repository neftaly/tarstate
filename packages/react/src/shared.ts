import type { JsonValue } from '@tarstate/core/foundation';
import type {
  ObserverDiagnostic,
  ObserverDiagnosticReporter
} from '@tarstate/core/database/observer';
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
  if (candidate === null || typeof candidate !== 'object') {
    throw new TypeError('rows and unique string resultKeys must have equal lengths');
  }
  const descriptors = Object.getOwnPropertyDescriptors(candidate);
  const rows = inspectDenseDataArray<Row>(ownedDataValue(descriptors, 'rows'));
  const resultKeys = inspectDenseDataArray<unknown>(ownedDataValue(descriptors, 'resultKeys'));
  if (
    rows.length !== resultKeys.length
    || resultKeys.some((key) => typeof key !== 'string')
    || new Set(resultKeys).size !== resultKeys.length
  ) {
    throw new TypeError('rows and unique string resultKeys must have equal lengths');
  }
  const ownedResultKeys = resultKeys as string[];
  return Object.freeze({
    rows: Object.freeze(rows),
    resultKeys: Object.freeze(ownedResultKeys)
  });
};

const ownedDataValue = (descriptors: PropertyDescriptorMap, name: string): unknown => {
  const descriptor = descriptors[name];
  if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
    throw new TypeError(`Optimistic projection ${name} must be an enumerable data property`);
  }
  return descriptor.value;
};

const inspectDenseDataArray = <Value>(value: unknown): Value[] => {
  if (!Array.isArray(value)) throw new TypeError('Optimistic projection rows and resultKeys must be arrays');
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
  const length = lengthDescriptor !== undefined && 'value' in lengthDescriptor ? lengthDescriptor.value : undefined;
  if (!Number.isSafeInteger(length) || length < 0) throw new TypeError('Optimistic projection array length is invalid');
  const output: Value[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
      throw new TypeError('Optimistic projection arrays must contain dense data properties');
    }
    output.push(descriptor.value as Value);
  }
  return output;
};

/** Freezes a parser-owned portable graph without allocating another copy. */
export const freezeOwnedPortable = (value: JsonValue): JsonValue => {
  if (value === null || typeof value !== 'object') return value;
  for (const member of Array.isArray(value) ? value : Object.values(value)) freezeOwnedPortable(member);
  return Object.freeze(value);
};

/** Deeply owns data whose public contract already restricts it to data values. */
export const deepFreezeDataClone = <Value>(value: Value, seen = new WeakMap<object, object>()): Value => {
  if (value === null || typeof value !== 'object') return value;
  const prior = seen.get(value);
  if (prior !== undefined) return prior as Value;
  if (Array.isArray(value)) {
    const output: unknown[] = [];
    seen.set(value, output);
    for (const item of value) output.push(deepFreezeDataClone(item, seen));
    return Object.freeze(output) as Value;
  }
  const output: Record<string, unknown> = {};
  seen.set(value, output);
  for (const [key, item] of Object.entries(value)) output[key] = deepFreezeDataClone(item, seen);
  return Object.freeze(output) as Value;
};
