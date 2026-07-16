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
  return {
    sourceId,
    sourceBasis,
    projectRows: projectRows as OptimisticOverlay<unknown, unknown>['projectRows'],
    ...(appliesToQuery === undefined ? {} : {
      appliesToQuery: appliesToQuery as NonNullable<OptimisticOverlay<unknown, unknown>['appliesToQuery']>
    })
  };
};

const optimisticOverlayError = (
  phase: OptimisticUpdateError['phase'],
  cause: unknown
): OptimisticUpdateError => ({ phase, ...errorDetails(cause) });

export type OptimisticQueryView<Row> = {
  readonly getSnapshot: () => ReactObserverSnapshot<Row>;
  readonly subscribe: (listener: () => void) => () => void;
  readonly overlaysChanged: (overlays: readonly ActiveOptimisticOverlay[]) => void;
  readonly close: () => void;
};

export type OptimisticOverlayStore = {
  readonly onDiagnostic: ObserverDiagnosticReporter | undefined;
  readonly view: <Query, Row>(
    base: QueryStore<Row>,
    request: ObserveRequest<Query>,
    key: string
  ) => OptimisticQueryView<Row>;
  readonly add: (
    mutationId: number,
    attempt: TransactionAttempt,
    definition: OptimisticOverlay<unknown, unknown>
  ) => OptimisticUpdateError | undefined;
  readonly discard: (mutationId: number) => void;
  readonly project: <Query, Row>(
    authoritative: ObserverSnapshot<Row>,
    request: ObserveRequest<Query>
  ) => ReactObserverSnapshot<Row>;
  readonly close: () => void;
};

export const createOptimisticOverlayStore = (
  reportError: (mutationId: number, error: OptimisticUpdateError) => void,
  onDiagnostic?: ObserverDiagnosticReporter
): OptimisticOverlayStore => {
  const overlays = new Map<number, ActiveOptimisticOverlay>();
  const overlaysByTarget = new Map<string, Map<number, ActiveOptimisticOverlay>>();
  const views = new Map<string, OptimisticQueryView<unknown>>();
  const activeViews = new Set<OptimisticQueryView<unknown>>();
  const pendingFailures = new Map<number, {
    readonly overlay: ActiveOptimisticOverlay;
    readonly error: OptimisticUpdateError;
  }>();
  let nextSequence = 0;
  let closed = false;

  const deleteOverlay = (mutationId: number): ActiveOptimisticOverlay | undefined => {
    const overlay = overlays.get(mutationId);
    if (overlay === undefined) return undefined;
    overlays.delete(mutationId);
    const target = overlayTargetKey(overlay.attachmentId, overlay.sourceId);
    const targeted = overlaysByTarget.get(target);
    targeted?.delete(mutationId);
    if (targeted?.size === 0) overlaysByTarget.delete(target);
    return overlay;
  };

  const changed = (changedOverlays: readonly ActiveOptimisticOverlay[]): void => {
    for (const view of activeViews) view.overlaysChanged(changedOverlays);
  };

  const flushFailures = (): void => {
    if (closed) {
      pendingFailures.clear();
      return;
    }
    const changedOverlays: ActiveOptimisticOverlay[] = [];
    for (const [mutationId, { overlay, error }] of pendingFailures) {
      reportError(mutationId, error);
      changedOverlays.push(overlay);
    }
    pendingFailures.clear();
    if (changedOverlays.length > 0) changed(changedOverlays);
  };

  const scheduleFailure = (overlay: ActiveOptimisticOverlay, error: OptimisticUpdateError): void => {
    if (pendingFailures.has(overlay.mutationId)) return;
    // A rejected host projection cannot remain active between render and the
    // deferred mutation-state notification.
    deleteOverlay(overlay.mutationId);
    pendingFailures.set(overlay.mutationId, { overlay, error });
    queueMicrotask(flushFailures);
  };

  const add = (
    mutationId: number,
    attempt: TransactionAttempt,
    definition: OptimisticOverlay<unknown, unknown>
  ): OptimisticUpdateError | undefined => {
    if (closed) return undefined;
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
    const prior = deleteOverlay(mutationId);
    const overlay = {
      mutationId,
      sequence: nextSequence += 1,
      operationEpoch: attempt.operationEpoch,
      operationId: attempt.operationId,
      attachmentId: attempt.attachmentId,
      sourceId: inspectedDefinition.sourceId,
      sourceBasis,
      sourceBasisFingerprint,
      definition: Object.freeze({ ...inspectedDefinition, sourceBasis })
    };
    overlays.set(mutationId, overlay);
    const target = overlayTargetKey(overlay.attachmentId, overlay.sourceId);
    let targeted = overlaysByTarget.get(target);
    if (targeted === undefined) {
      targeted = new Map();
      overlaysByTarget.set(target, targeted);
    }
    targeted.set(mutationId, overlay);
    changed(prior === undefined ? [overlay] : [prior, overlay]);
    return undefined;
  };

  const discard = (mutationId: number): void => {
    const overlay = deleteOverlay(mutationId);
    if (overlay !== undefined) changed([overlay]);
  };

  const project = <Query, Row>(
    authoritative: ObserverSnapshot<Row>,
    request: ObserveRequest<Query>
  ): ReactObserverSnapshot<Row> => {
    if (authoritative.state === 'closed' || authoritative.current.completeness === 'unknown' || overlays.size === 0) return authoritative;
    let rows = authoritative.current.rows;
    let resultKeys = authoritative.current.resultKeys;
    const operations: OptimisticOperationEvidence[] = [];
    let failures: [ActiveOptimisticOverlay, OptimisticUpdateError][] | undefined;
    let observedBases: Map<string, JsonValue> | undefined;
    let candidates: Map<number, ActiveOptimisticOverlay> | undefined;
    for (const attachment of authoritative.current.basis.attachments) {
      const target = overlayTargetKey(attachment.attachmentId, attachment.sourceId);
      const targeted = overlaysByTarget.get(target);
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
      for (const [overlay, error] of failures) scheduleFailure(overlay, error);
    }
    if (operations.length === 0) return authoritative;
    return Object.freeze({
      ...authoritative,
      current: Object.freeze({ ...authoritative.current, rows, resultKeys }),
      optimistic: Object.freeze({ operations: Object.freeze(operations) })
    });
  };

  const view = <Query, Row>(
    base: QueryStore<Row>,
    request: ObserveRequest<Query>,
    key: string
  ): OptimisticQueryView<Row> => {
    const existing = views.get(key);
    if (existing !== undefined) return existing as OptimisticQueryView<Row>;
    const created = createOptimisticQueryView(
      base,
      request,
      project,
      onDiagnostic,
      () => {
        if (closed) return false;
        activeViews.add(created as OptimisticQueryView<unknown>);
        return true;
      },
      () => activeViews.delete(created as OptimisticQueryView<unknown>),
      () => {
        if (views.get(key) === created) views.delete(key);
      }
    );
    views.set(key, created as OptimisticQueryView<unknown>);
    return created;
  };

  const close = (): void => {
    if (closed) return;
    closed = true;
    overlays.clear();
    overlaysByTarget.clear();
    pendingFailures.clear();
    const ownedViews = new Set([...views.values(), ...activeViews]);
    runReactCleanups(
      Array.from(ownedViews, (ownedView) => () => ownedView.close()),
      'react-optimistic',
      'close-overlay-views',
      onDiagnostic
    );
    views.clear();
    activeViews.clear();
  };

  return { onDiagnostic, view, add, discard, project, close };
};

const createOptimisticQueryView = <Query, Row>(
  base: QueryStore<Row>,
  request: ObserveRequest<Query>,
  project: (
    authoritative: ObserverSnapshot<Row>,
    request: ObserveRequest<Query>
  ) => ReactObserverSnapshot<Row>,
  onDiagnostic: ObserverDiagnosticReporter | undefined,
  activate: () => boolean,
  deactivate: () => void,
  collect: () => void
): OptimisticQueryView<Row> => {
  const listeners = new Set<() => void>();
  let unsubscribeBase: (() => void) | undefined;
  let baseSnapshot: ObserverSnapshot<Row> | undefined;
  let overlayRevision = 0;
  let projectedOverlayRevision = -1;
  let snapshot: ReactObserverSnapshot<Row> | undefined;
  let closeGeneration = 0;
  let closed = false;

  const releaseBase = (): void => {
    const cleanups = [unsubscribeBase, collect]
      .filter((cleanup): cleanup is () => void => cleanup !== undefined);
    unsubscribeBase = undefined;
    snapshot = undefined;
    baseSnapshot = undefined;
    runReactCleanups(cleanups, 'react-optimistic', 'close-query-view', onDiagnostic);
  };

  const scheduleDispose = (): void => {
    const generation = ++closeGeneration;
    queueMicrotask(() => {
      if (closed || generation !== closeGeneration || listeners.size !== 0) return;
      releaseBase();
    });
  };

  const recompute = (): ReactObserverSnapshot<Row> => {
    const nextBaseSnapshot = base.getSnapshot();
    if (snapshot !== undefined
      && baseSnapshot === nextBaseSnapshot
      && projectedOverlayRevision === overlayRevision) {
      return snapshot;
    }
    baseSnapshot = nextBaseSnapshot;
    projectedOverlayRevision = overlayRevision;
    snapshot = project(nextBaseSnapshot, request);
    return snapshot;
  };

  const refresh = (): void => {
    if (closed) return;
    const previous = snapshot;
    const next = recompute();
    if (previous === next) return;
    notifyReactListeners(listeners, 'react-optimistic', 'publish-query-view', onDiagnostic);
  };

  const subscribe = (listener: () => void): (() => void) => {
    if (closed) return () => undefined;
    if (listeners.size === 0) {
      if (!activate()) return () => undefined;
      snapshot = undefined;
      baseSnapshot = undefined;
    }
    listeners.add(listener);
    closeGeneration += 1;
    if (unsubscribeBase === undefined) {
      unsubscribeBase = base.subscribe(refresh, onDiagnostic);
    }
    return () => {
      if (!listeners.delete(listener)) return;
      if (listeners.size === 0) {
        deactivate();
        scheduleDispose();
      }
    };
  };

  const close = (): void => {
    if (closed) return;
    closed = true;
    deactivate();
    listeners.clear();
    releaseBase();
  };

  const queryView: OptimisticQueryView<Row> = {
    getSnapshot: recompute,
    subscribe,
    overlaysChanged: (changedOverlays: readonly ActiveOptimisticOverlay[]): void => {
      const currentBase = base.getSnapshot();
      if (!changedOverlays.some((overlay) => overlayTargetsSnapshot(overlay, currentBase))) return;
      overlayRevision += 1;
      refresh();
    },
    close
  };
  scheduleDispose();
  return queryView;
};

const overlayTargetsSnapshot = (overlay: ActiveOptimisticOverlay, snapshot: ObserverSnapshot<unknown>): boolean =>
  snapshot.state === 'open'
  && snapshot.current.completeness !== 'unknown'
  && snapshot.current.basis.attachments.some(({ attachmentId, sourceId }) =>
    attachmentId === overlay.attachmentId && sourceId === overlay.sourceId
  );
