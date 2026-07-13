import {
  canonicalizeJson,
  safeParseJsonValue,
  type JsonValue,
  type ObserveRequest,
  type ObserverDiagnosticReporter,
  type ObserverSnapshot,
  type TransactionAttempt
} from '@tarstate/core';
import type {
  OptimisticOperationEvidence,
  OptimisticOverlay,
  OptimisticProjection,
  OptimisticUpdateError,
  ReactObserverSnapshot
} from './contracts.js';
import type { QueryStore } from './query-store.js';
import {
  adoptOptimisticProjection,
  errorDetails,
  freezeOwnedPortable,
  notifyReactListeners,
  runReactCleanups
} from './shared.js';

type ActiveOptimisticOverlay = {
  readonly mutationId: number;
  readonly operationEpoch: string;
  readonly operationId: string;
  readonly attachmentId: string;
  readonly sourceId: string;
  readonly sourceBasis: JsonValue;
  readonly sourceBasisFingerprint: string;
  readonly definition: OptimisticOverlay<unknown, unknown>;
};

type InspectedOptimisticOverlay = {
  readonly sourceId: string;
  readonly sourceBasis: unknown;
  readonly appliesToQuery?: NonNullable<OptimisticOverlay<unknown, unknown>['appliesToQuery']>;
  readonly projectRows: OptimisticOverlay<unknown, unknown>['projectRows'];
};

const inspectOptimisticOverlay = (
  definition: OptimisticOverlay<unknown, unknown>
): InspectedOptimisticOverlay => {
  if (definition === null || typeof definition !== 'object') throw new TypeError('Optimistic overlay must be an object');
  const descriptors = Object.getOwnPropertyDescriptors(definition);
  const required = (name: 'sourceId' | 'sourceBasis' | 'projectRows'): unknown => {
    const descriptor = descriptors[name];
    if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
      throw new TypeError(`Optimistic overlay ${name} must be an enumerable data property`);
    }
    return descriptor.value;
  };
  const sourceId = required('sourceId');
  const sourceBasis = required('sourceBasis');
  const projectRows = required('projectRows');
  const appliesDescriptor = descriptors.appliesToQuery;
  if (typeof sourceId !== 'string' || sourceId.length === 0) throw new TypeError('Optimistic overlay sourceId must be a non-empty string');
  if (typeof projectRows !== 'function') throw new TypeError('Optimistic overlay projectRows must be a function');
  if (appliesDescriptor !== undefined && (!appliesDescriptor.enumerable || !('value' in appliesDescriptor))) {
    throw new TypeError('Optimistic overlay appliesToQuery must be an enumerable data property');
  }
  const appliesToQuery = appliesDescriptor === undefined ? undefined : appliesDescriptor.value;
  if (appliesToQuery !== undefined && typeof appliesToQuery !== 'function') {
    throw new TypeError('Optimistic overlay appliesToQuery must be a function');
  }
  return Object.freeze({
    sourceId,
    sourceBasis,
    projectRows: projectRows as OptimisticOverlay<unknown, unknown>['projectRows'],
    ...(appliesToQuery === undefined ? {} : {
      appliesToQuery: appliesToQuery as NonNullable<OptimisticOverlay<unknown, unknown>['appliesToQuery']>
    })
  });
};

const optimisticOverlayError = (
  phase: OptimisticUpdateError['phase'],
  cause: unknown
): OptimisticUpdateError => ({ phase, ...errorDetails(cause) });

export class OptimisticOverlayStore {
  readonly #overlays = new Map<number, ActiveOptimisticOverlay>();
  readonly #views = new Map<string, OptimisticQueryView<unknown, unknown>>();
  readonly #reportError: (mutationId: number, error: OptimisticUpdateError) => void;
  readonly #pendingFailures = new Map<number, OptimisticUpdateError>();
  readonly #onDiagnostic: ObserverDiagnosticReporter | undefined;
  #revision = 0;
  #closed = false;

  constructor(reportError: (mutationId: number, error: OptimisticUpdateError) => void, onDiagnostic?: ObserverDiagnosticReporter) {
    this.#reportError = reportError;
    this.#onDiagnostic = onDiagnostic;
  }

  get revision(): number { return this.#revision; }
  get onDiagnostic(): ObserverDiagnosticReporter | undefined { return this.#onDiagnostic; }

  view<Query, Row>(base: QueryStore<Row>, request: ObserveRequest<Query>, key: string): OptimisticQueryView<Query, Row> {
    const existing = this.#views.get(key);
    if (existing !== undefined) return existing as OptimisticQueryView<Query, Row>;
    const view = new OptimisticQueryView(this, base, request, () => {
      if (this.#views.get(key) === view) this.#views.delete(key);
    });
    this.#views.set(key, view as OptimisticQueryView<unknown, unknown>);
    return view;
  }

  add(mutationId: number, attempt: TransactionAttempt, definition: OptimisticOverlay<unknown, unknown>): OptimisticUpdateError | undefined {
    if (this.#closed) return undefined;
    let inspectedDefinition: InspectedOptimisticOverlay;
    try {
      inspectedDefinition = inspectOptimisticOverlay(definition);
    } catch (error) {
      return { phase: 'create-overlay', ...errorDetails(error) };
    }
    // Validate the opaque basis now so projection callbacks never receive a
    // host-only or non-canonical value disguised as source evidence.
    let sourceBasis: JsonValue;
    let sourceBasisFingerprint: string;
    try {
      const parsed = safeParseJsonValue(inspectedDefinition.sourceBasis);
      if (!parsed.success) throw new TypeError('sourceBasis must be descriptor-safe portable data');
      sourceBasis = freezeOwnedPortable(parsed.value);
      sourceBasisFingerprint = canonicalizeJson(sourceBasis);
    } catch (error) {
      return { phase: 'source-basis', ...errorDetails(error) };
    }
    this.#overlays.set(mutationId, {
      mutationId,
      operationEpoch: attempt.operationEpoch,
      operationId: attempt.operationId,
      attachmentId: attempt.attachmentId,
      sourceId: inspectedDefinition.sourceId,
      sourceBasis,
      sourceBasisFingerprint,
      definition: Object.freeze({ ...inspectedDefinition, sourceBasis })
    });
    this.#changed();
    return undefined;
  }

  discard(mutationId: number): void {
    if (!this.#overlays.delete(mutationId)) return;
    this.#changed();
  }

  project<Query, Row>(authoritative: ObserverSnapshot<Row>, request: ObserveRequest<Query>): ReactObserverSnapshot<Row> {
    if (authoritative.state === 'closed' || authoritative.current.completeness === 'unknown' || this.#overlays.size === 0) return authoritative;
    let rows = authoritative.current.rows;
    let resultKeys = authoritative.current.resultKeys;
    const operations: OptimisticOperationEvidence[] = [];
    const failures: [ActiveOptimisticOverlay, OptimisticUpdateError][] = [];
    const attachments = new Map<string, Map<string, JsonValue>>();
    for (const attachment of authoritative.current.basis.attachments) {
      let sources = attachments.get(attachment.attachmentId);
      if (sources === undefined) {
        sources = new Map();
        attachments.set(attachment.attachmentId, sources);
      }
      sources.set(attachment.sourceId, attachment.basis);
    }
    const observedBasisFingerprints = new Map<JsonValue, string>();
    for (const overlay of this.#overlays.values()) {
      const definition = overlay.definition as OptimisticOverlay<Query, Row>;
      if (definition.appliesToQuery !== undefined) {
        let applies: boolean;
        try {
          applies = definition.appliesToQuery(request);
        } catch (error) {
          failures.push([overlay, optimisticOverlayError('applies-to-query', error)]);
          continue;
        }
        if (!applies) continue;
      }
      const observedBasis = attachments.get(overlay.attachmentId)?.get(overlay.sourceId);
      if (observedBasis === undefined) continue;
      let observedBasisFingerprint = observedBasisFingerprints.get(observedBasis);
      if (observedBasisFingerprint === undefined) {
        observedBasisFingerprint = canonicalizeJson(observedBasis);
        observedBasisFingerprints.set(observedBasis, observedBasisFingerprint);
      }
      const rebased = observedBasisFingerprint !== overlay.sourceBasisFingerprint;
      let candidate: OptimisticProjection<Row>;
      try {
        candidate = definition.projectRows({ request, authoritativeSnapshot: authoritative, currentRows: rows, currentResultKeys: resultKeys, sourceBasis: overlay.sourceBasis, observedBasis, rebased });
      } catch (error) {
        failures.push([overlay, optimisticOverlayError('project-rows', error)]);
        continue;
      }
      let projection: OptimisticProjection<Row>;
      try {
        projection = adoptOptimisticProjection(candidate);
      } catch (error) {
        failures.push([overlay, optimisticOverlayError('projection-result', error)]);
        continue;
      }
      rows = projection.rows;
      resultKeys = projection.resultKeys;
      operations.push({
        operationEpoch: overlay.operationEpoch,
        operationId: overlay.operationId,
        attachmentId: overlay.attachmentId,
        sourceId: overlay.sourceId,
        sourceBasis: overlay.sourceBasis,
        observedBasis,
        rebased
      });
    }
    for (const [overlay, error] of failures) this.#scheduleFailure(overlay, error);
    if (operations.length === 0) return authoritative;
    const ownedOperations = Object.freeze(operations.map((operation) => Object.freeze(operation)));
    return Object.freeze({
      ...authoritative,
      current: Object.freeze({ ...authoritative.current, rows, resultKeys }),
      optimistic: Object.freeze({ operations: ownedOperations })
    });
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#overlays.clear();
    this.#pendingFailures.clear();
    runReactCleanups(Array.from(this.#views.values(), (view) => () => view.close()), 'react-optimistic', 'close-overlay-views', this.#onDiagnostic);
    this.#views.clear();
  }

  #changed(): void {
    this.#revision += 1;
    for (const view of this.#views.values()) view.overlayChanged();
  }

  #scheduleFailure(overlay: ActiveOptimisticOverlay, error: OptimisticUpdateError): void {
    if (this.#pendingFailures.has(overlay.mutationId)) return;
    // A rejected host projection cannot remain active between render and the
    // deferred mutation-state notification.
    this.#overlays.delete(overlay.mutationId);
    this.#pendingFailures.set(overlay.mutationId, error);
    queueMicrotask(() => this.#flushFailures());
  }

  #flushFailures(): void {
    if (this.#closed) { this.#pendingFailures.clear(); return; }
    let changed = false;
    for (const [mutationId, error] of this.#pendingFailures) {
      this.#reportError(mutationId, error);
      changed = true;
    }
    this.#pendingFailures.clear();
    if (changed) this.#changed();
  }
}

class OptimisticQueryView<Query, Row> {
  readonly #overlays: OptimisticOverlayStore;
  readonly #base: QueryStore<Row>;
  readonly #request: ObserveRequest<Query>;
  readonly #collect: () => void;
  readonly #listeners = new Set<() => void>();
  #unsubscribeBase: (() => void) | undefined;
  #baseSnapshot: ObserverSnapshot<Row> | undefined;
  #overlayRevision = -1;
  #snapshot: ReactObserverSnapshot<Row> | undefined;
  #closeGeneration = 0;
  #closed = false;

  constructor(overlays: OptimisticOverlayStore, base: QueryStore<Row>, request: ObserveRequest<Query>, collect: () => void) {
    this.#overlays = overlays;
    this.#base = base;
    this.#request = request;
    this.#collect = collect;
    this.#scheduleClose();
  }

  readonly getSnapshot = (): ReactObserverSnapshot<Row> => this.#recompute();

  readonly subscribe = (listener: () => void): (() => void) => {
    if (this.#closed) return () => undefined;
    this.#listeners.add(listener);
    this.#closeGeneration += 1;
    if (this.#unsubscribeBase === undefined) this.#unsubscribeBase = this.#base.subscribe(() => this.#refresh());
    return () => {
      if (!this.#listeners.delete(listener)) return;
      if (this.#listeners.size === 0) this.#scheduleClose();
    };
  };

  overlayChanged(): void { this.#refresh(); }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    const cleanups = [this.#unsubscribeBase, this.#collect].filter((cleanup): cleanup is () => void => cleanup !== undefined);
    this.#unsubscribeBase = undefined;
    this.#listeners.clear();
    this.#snapshot = undefined;
    this.#baseSnapshot = undefined;
    runReactCleanups(cleanups, 'react-optimistic', 'close-query-view', this.#overlays.onDiagnostic);
  }

  #refresh(): void {
    if (this.#closed) return;
    const previous = this.#snapshot;
    const next = this.#recompute();
    if (previous === next) return;
    notifyReactListeners(this.#listeners, 'react-optimistic', 'publish-query-view', this.#overlays.onDiagnostic);
  }

  #recompute(): ReactObserverSnapshot<Row> {
    const baseSnapshot = this.#base.getSnapshot();
    if (this.#snapshot !== undefined && this.#baseSnapshot === baseSnapshot && this.#overlayRevision === this.#overlays.revision) return this.#snapshot;
    this.#baseSnapshot = baseSnapshot;
    this.#overlayRevision = this.#overlays.revision;
    this.#snapshot = this.#overlays.project(baseSnapshot, this.#request);
    return this.#snapshot;
  }

  #scheduleClose(): void {
    const generation = ++this.#closeGeneration;
    queueMicrotask(() => {
      if (this.#closed || generation !== this.#closeGeneration || this.#listeners.size !== 0) return;
      this.close();
    });
  }
}
