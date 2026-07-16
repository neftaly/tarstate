import {
  type ObserveRequest,
  type ObserverDiagnosticReporter,
  type ObserverSnapshot
} from '@tarstate/core/database/observer';
import { canonicalizeJson, safeParseJsonValue, type JsonValue } from '@tarstate/core';
import type { TransactionAttempt } from '@tarstate/core/transactions';
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
  readonly sequence: number;
  readonly operationEpoch: string;
  readonly operationId: string;
  readonly attachmentId: string;
  readonly sourceId: string;
  readonly sourceBasis: JsonValue;
  readonly sourceBasisFingerprint: string;
  readonly definition: OptimisticOverlay<unknown, unknown>;
};

const overlayTargetKey = (attachmentId: string, sourceId: string): string =>
  attachmentId.length + ':' + attachmentId + sourceId.length + ':' + sourceId;

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
  readonly #overlaysByTarget = new Map<string, Map<number, ActiveOptimisticOverlay>>();
  readonly #views = new Map<string, OptimisticQueryView<unknown, unknown>>();
  readonly #reportError: (mutationId: number, error: OptimisticUpdateError) => void;
  readonly #pendingFailures = new Map<number, { readonly overlay: ActiveOptimisticOverlay; readonly error: OptimisticUpdateError }>();
  readonly #onDiagnostic: ObserverDiagnosticReporter | undefined;
  #nextSequence = 0;
  #closed = false;

  constructor(reportError: (mutationId: number, error: OptimisticUpdateError) => void, onDiagnostic?: ObserverDiagnosticReporter) {
    this.#reportError = reportError;
    this.#onDiagnostic = onDiagnostic;
  }

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
    const prior = this.#deleteOverlay(mutationId);
    const overlay = {
      mutationId,
      sequence: this.#nextSequence += 1,
      operationEpoch: attempt.operationEpoch,
      operationId: attempt.operationId,
      attachmentId: attempt.attachmentId,
      sourceId: inspectedDefinition.sourceId,
      sourceBasis,
      sourceBasisFingerprint,
      definition: Object.freeze({ ...inspectedDefinition, sourceBasis })
    };
    this.#overlays.set(mutationId, overlay);
    const target = overlayTargetKey(overlay.attachmentId, overlay.sourceId);
    let targeted = this.#overlaysByTarget.get(target);
    if (targeted === undefined) {
      targeted = new Map();
      this.#overlaysByTarget.set(target, targeted);
    }
    targeted.set(mutationId, overlay);
    this.#changed(prior === undefined ? [overlay] : [prior, overlay]);
    return undefined;
  }

  discard(mutationId: number): void {
    const overlay = this.#deleteOverlay(mutationId);
    if (overlay !== undefined) this.#changed([overlay]);
  }

  project<Query, Row>(authoritative: ObserverSnapshot<Row>, request: ObserveRequest<Query>): ReactObserverSnapshot<Row> {
    if (authoritative.state === 'closed' || authoritative.current.completeness === 'unknown' || this.#overlays.size === 0) return authoritative;
    let rows = authoritative.current.rows;
    let resultKeys = authoritative.current.resultKeys;
    const operations: OptimisticOperationEvidence[] = [];
    let failures: [ActiveOptimisticOverlay, OptimisticUpdateError][] | undefined;
    let observedBases: Map<string, JsonValue> | undefined;
    let candidates: Map<number, ActiveOptimisticOverlay> | undefined;
    for (const attachment of authoritative.current.basis.attachments) {
      const target = overlayTargetKey(attachment.attachmentId, attachment.sourceId);
      const targeted = this.#overlaysByTarget.get(target);
      if (targeted === undefined) continue;
      (observedBases ??= new Map()).set(target, attachment.basis);
      const indexed = candidates ??= new Map();
      for (const overlay of targeted.values()) indexed.set(overlay.mutationId, overlay);
    }
    if (candidates === undefined || observedBases === undefined) return authoritative;
    const observedBasisFingerprints = candidates.size > 1 ? new Map<JsonValue, string>() : undefined;
    const orderedCandidates: Iterable<ActiveOptimisticOverlay> = candidates.size === 1
      ? candidates.values()
      : [...candidates.values()].sort((left, right) => left.sequence - right.sequence);
    for (const overlay of orderedCandidates) {
      const definition = overlay.definition as OptimisticOverlay<Query, Row>;
      if (definition.appliesToQuery !== undefined) {
        let applies: boolean;
        try {
          applies = definition.appliesToQuery(request);
        } catch (error) {
          (failures ??= []).push([overlay, optimisticOverlayError('applies-to-query', error)]);
          continue;
        }
        if (!applies) continue;
      }
      const observedBasis = observedBases.get(overlayTargetKey(overlay.attachmentId, overlay.sourceId));
      if (observedBasis === undefined) continue;
      let observedBasisFingerprint = observedBasisFingerprints?.get(observedBasis);
      if (observedBasisFingerprint === undefined) {
        observedBasisFingerprint = canonicalizeJson(observedBasis);
        observedBasisFingerprints?.set(observedBasis, observedBasisFingerprint);
      }
      const rebased = observedBasisFingerprint !== overlay.sourceBasisFingerprint;
      let candidate: OptimisticProjection<Row>;
      try {
        candidate = definition.projectRows({ request, authoritativeSnapshot: authoritative, currentRows: rows, currentResultKeys: resultKeys, sourceBasis: overlay.sourceBasis, observedBasis, rebased });
      } catch (error) {
        (failures ??= []).push([overlay, optimisticOverlayError('project-rows', error)]);
        continue;
      }
      let projection: OptimisticProjection<Row>;
      try {
        projection = adoptOptimisticProjection(candidate);
      } catch (error) {
        (failures ??= []).push([overlay, optimisticOverlayError('projection-result', error)]);
        continue;
      }
      rows = projection.rows;
      resultKeys = projection.resultKeys;
      operations.push(Object.freeze({
        operationEpoch: overlay.operationEpoch,
        operationId: overlay.operationId,
        attachmentId: overlay.attachmentId,
        sourceId: overlay.sourceId,
        sourceBasis: overlay.sourceBasis,
        observedBasis,
        rebased
      }));
    }
    if (failures !== undefined) {
      for (const [overlay, error] of failures) this.#scheduleFailure(overlay, error);
    }
    if (operations.length === 0) return authoritative;
    return Object.freeze({
      ...authoritative,
      current: Object.freeze({ ...authoritative.current, rows, resultKeys }),
      optimistic: Object.freeze({ operations: Object.freeze(operations) })
    });
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#overlays.clear();
    this.#overlaysByTarget.clear();
    this.#pendingFailures.clear();
    runReactCleanups(Array.from(this.#views.values(), (view) => () => view.close()), 'react-optimistic', 'close-overlay-views', this.#onDiagnostic);
    this.#views.clear();
  }

  #changed(overlays: readonly ActiveOptimisticOverlay[]): void {
    for (const view of this.#views.values()) view.overlaysChanged(overlays);
  }

  #scheduleFailure(overlay: ActiveOptimisticOverlay, error: OptimisticUpdateError): void {
    if (this.#pendingFailures.has(overlay.mutationId)) return;
    // A rejected host projection cannot remain active between render and the
    // deferred mutation-state notification.
    this.#deleteOverlay(overlay.mutationId);
    this.#pendingFailures.set(overlay.mutationId, { overlay, error });
    queueMicrotask(() => this.#flushFailures());
  }

  #flushFailures(): void {
    if (this.#closed) { this.#pendingFailures.clear(); return; }
    const changed: ActiveOptimisticOverlay[] = [];
    for (const [mutationId, { overlay, error }] of this.#pendingFailures) {
      this.#reportError(mutationId, error);
      changed.push(overlay);
    }
    this.#pendingFailures.clear();
    if (changed.length > 0) this.#changed(changed);
  }

  #deleteOverlay(mutationId: number): ActiveOptimisticOverlay | undefined {
    const overlay = this.#overlays.get(mutationId);
    if (overlay === undefined) return undefined;
    this.#overlays.delete(mutationId);
    const target = overlayTargetKey(overlay.attachmentId, overlay.sourceId);
    const targeted = this.#overlaysByTarget.get(target);
    targeted?.delete(mutationId);
    if (targeted?.size === 0) this.#overlaysByTarget.delete(target);
    return overlay;
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
  #overlayRevision = 0;
  #projectedOverlayRevision = -1;
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

  overlaysChanged(overlays: readonly ActiveOptimisticOverlay[]): void {
    const base = this.#base.getSnapshot();
    if (!overlays.some((overlay) => overlayTargetsSnapshot(overlay, base))) return;
    this.#overlayRevision += 1;
    this.#refresh();
  }

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
    if (this.#snapshot !== undefined && this.#baseSnapshot === baseSnapshot && this.#projectedOverlayRevision === this.#overlayRevision) return this.#snapshot;
    this.#baseSnapshot = baseSnapshot;
    this.#projectedOverlayRevision = this.#overlayRevision;
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

const overlayTargetsSnapshot = (overlay: ActiveOptimisticOverlay, snapshot: ObserverSnapshot<unknown>): boolean =>
  snapshot.state === 'open'
  && snapshot.current.completeness !== 'unknown'
  && snapshot.current.basis.attachments.some(({ attachmentId, sourceId }) =>
    attachmentId === overlay.attachmentId && sourceId === overlay.sourceId
  );
