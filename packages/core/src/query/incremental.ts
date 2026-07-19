import type { PreparedPlan } from './plan-contract.js';
import { assertPreparedPlan, hasOwnedPreparedQuery } from './internal/prepared-plan.js';
import {
  adoptFunctionRegistry,
  adoptJsonRecord,
  adoptMaintenanceSnapshot,
  adoptQueryMaintenanceUpdate,
  cloneAndFreezeQueryAst
} from './internal/ownership.js';
import { createEvaluationRun, type ScopedRow } from './internal/evaluation-context.js';
import { sameExecutionBudget, sameFunctionRegistry, sameOptionalJson } from './internal/equality.js';
import { selectCanRetainMaterialization } from './internal/dependency.js';
import {
  assertPoolableQuery,
  compileQueryGraph,
  internPooledQueryNode,
  NonPoolableQueryError,
  type InternedPooledNode
} from './internal/graph.js';
import {
  emptyOperatorDiagnostics,
  summarizeOperatorEvents,
  type QueryMaintenanceOperatorEvent
} from './internal/maintenance-diagnostics.js';
import { summarizePooledRootMaintenance } from './internal/pool-publication.js';
import type { MaterializedQueryNode } from './internal/maintenance-model.js';
import {
  diffMaintainedResults,
  emptyIncrementalQueryResultDelta,
  maintainedQueryResult,
  maintenanceState,
  materializeUpdatedQueryNode,
  materializedQueryNodeEqual,
  materializeQueryNode
} from './internal/maintenance-engine.js';
import {
  applyQueryMaintenanceUpdate,
  changedRelationIds,
  validateMaintenanceSnapshot
} from './internal/maintenance-transition.js';
import { diffQueryMaintenanceSnapshots } from './maintenance-diff.js';
import { relationKey } from './internal/relations.js';
import type {
  QueryNode,
  QueryRecord
} from './model.js';
import type {
  IncrementalQueryMaintenanceSession,
  IncrementalQueryResult,
  PooledIncrementalQueryDiagnostics,
  PooledIncrementalQueryEnvironment,
  PooledIncrementalQueryRoot,
  PooledIncrementalQueryRuntime,
  QueryMaintenanceSnapshot,
  QueryMaintenanceUpdate
} from './incremental-model.js';

export type * from './model.js';
export type * from './incremental-model.js';
export { diffQueryMaintenanceSnapshots };

const closedMaintenanceSnapshot: QueryMaintenanceSnapshot = Object.freeze({
  relations: Object.freeze([])
});

/**
 * Opens the production stateful query-maintenance path. The pure
 * `evaluateQuery` function remains an independent semantic oracle; updates here
 * rematerialize only query nodes whose relation dependencies changed.
 */
export const openIncrementalQueryMaintenance = (
  plan: PreparedPlan<QueryNode>,
  initialSnapshot: QueryMaintenanceSnapshot
): IncrementalQueryMaintenanceSession => {
  assertPreparedPlan(plan);
  const queryRoot = hasOwnedPreparedQuery(plan) ? plan.query : cloneAndFreezeQueryAst(plan.query);
  const graph = compileQueryGraph(queryRoot);
  const materialized = new Map<QueryNode, MaterializedQueryNode>();
  const ownedInitialSnapshot = adoptMaintenanceSnapshot(initialSnapshot);
  const initialRun = createEvaluationRun(ownedInitialSnapshot.executionBudget);
  let acceptedSnapshot: QueryMaintenanceSnapshot = ownedInitialSnapshot;
  let closed = false;
  let revision = 0;
  let rejectedUpdateCount = 0;
  const publicRows = new WeakMap<ScopedRow, QueryRecord>();
  let executionPhase: 'idle' | 'updating' = 'idle';
  let closeRequested = false;

  const initialIssues = validateMaintenanceSnapshot(ownedInitialSnapshot);
  if (initialIssues.length === 0) {
    for (const node of graph.nodes) materialized.set(node, materializeQueryNode(node, ownedInitialSnapshot, materialized, initialRun));
  }
  let current = maintainedQueryResult(
    initialIssues.length === 0 ? materialized.get(queryRoot) : undefined,
    initialIssues,
    maintenanceState(graph.nodes.length, graph.nodes.length, graph.nodes.length, [], emptyIncrementalQueryResultDelta, revision, rejectedUpdateCount),
    publicRows
  );
  let assertedRoot = initialIssues.length === 0 ? materialized.get(queryRoot) : undefined;

  const closeNow = (): void => {
    if (closed) return;
    closed = true;
    materialized.clear();
    acceptedSnapshot = closedMaintenanceSnapshot;
    assertedRoot = undefined;
  };

  return {
    getCurrentResult: () => current,
    applyUpdate: (update) => {
      if (closed) throw new Error('Incremental query maintenance session is closed');
      if (executionPhase === 'updating') throw new Error('Recursive incremental query updates are not supported');
      const checkpoint = { acceptedSnapshot, revision, rejectedUpdateCount, current, assertedRoot };
      const journal = new Map<QueryNode, MaterializedQueryNode | undefined>();
      executionPhase = 'updating';
      try {
        const ownedUpdate = adoptQueryMaintenanceUpdate(update);
        revision += 1;
        const applied = applyQueryMaintenanceUpdate(acceptedSnapshot, ownedUpdate);
        if (!applied.success) {
          rejectedUpdateCount += 1;
          current = maintainedQueryResult(
            undefined,
            applied.issues,
            maintenanceState(graph.nodes.length, 0, 0, [], emptyIncrementalQueryResultDelta, revision, rejectedUpdateCount),
            publicRows
          );
          assertedRoot = undefined;
          return current;
        }

        const nextSnapshot = applied.value;
        const run = createEvaluationRun(nextSnapshot.executionBudget);
        const changedRelations = new Set<string>();
        for (const { relation } of ownedUpdate.relations) changedRelations.add(relationKey(relation));
        const sessionEvidenceChanged = !sameOptionalJson(acceptedSnapshot.basis, nextSnapshot.basis)
          || acceptedSnapshot.membershipRevision !== nextSnapshot.membershipRevision;
        let updatedNodeCount = 0;
        const changedNodes = new Set<QueryNode>();
        const operatorEvents = new Map<QueryNode, QueryMaintenanceOperatorEvent>();
        for (const node of graph.nodes) {
          const children = graph.children.get(node) as readonly QueryNode[];
          const externalDependencies = graph.externalDependencies.get(node) as ReadonlySet<string>;
          const childChanged = children.some((child) => changedNodes.has(child));
          let externalInputChanged = false;
          for (const key of externalDependencies) {
            if (!changedRelations.has(key)) continue;
            externalInputChanged = true;
            break;
          }
          const evidenceInputChanged = sessionEvidenceChanged && graph.sessionEvidenceDependencies.get(node) === true;
          if (!evidenceInputChanged && !childChanged && !externalInputChanged) continue;
          if (!evidenceInputChanged && !externalInputChanged && node.kind === 'select') {
            const child = materialized.get(node.input);
            if (child !== undefined && selectCanRetainMaterialization(node, materialized.get(node), child)) continue;
          }
          const previousNode = materialized.get(node);
          const updated = materializeUpdatedQueryNode({
            node,
            snapshot: nextSnapshot,
            update: ownedUpdate,
            materializedNodes: materialized,
            previous: previousNode,
            run
          });
          const nextNode = updated.materialized;
          const operatorEvent = updated.operatorEvent;
          if (operatorEvent !== undefined) operatorEvents.set(node, operatorEvent);
          journal.set(node, previousNode);
          materialized.set(node, nextNode);
          updatedNodeCount += 1;
          if (previousNode === undefined || !materializedQueryNodeEqual(previousNode, nextNode)) changedNodes.add(node);
        }
        acceptedSnapshot = nextSnapshot;
        const root = materialized.get(queryRoot);
        current = maintainedQueryResult(
          root,
          [],
          maintenanceState(
            graph.nodes.length,
            updatedNodeCount,
            changedNodes.size,
            changedRelationIds(ownedUpdate.relations),
            diffMaintainedResults(assertedRoot, root),
            revision,
            rejectedUpdateCount,
            summarizeOperatorEvents(operatorEvents.values())
          ),
          publicRows,
          current,
          assertedRoot !== undefined && !changedNodes.has(queryRoot)
        );
        assertedRoot = root;
        return current;
      } catch (error) {
        acceptedSnapshot = checkpoint.acceptedSnapshot;
        revision = checkpoint.revision;
        rejectedUpdateCount = checkpoint.rejectedUpdateCount;
        current = checkpoint.current;
        assertedRoot = checkpoint.assertedRoot;
        for (const [node, previous] of journal) {
          if (previous === undefined) materialized.delete(node);
          else materialized.set(node, previous);
        }
        throw error;
      } finally {
        executionPhase = 'idle';
        if (closeRequested) closeNow();
      }
    },
    close: () => {
      if (closed) return;
      if (executionPhase !== 'idle') {
        closeRequested = true;
        return;
      }
      closeNow();
    }
  };
};

type PooledPhysicalNode = {
  readonly children: readonly QueryNode[];
  readonly parents: Set<QueryNode>;
  readonly externalDependencies: ReadonlySet<string>;
  readonly sessionEvidenceDependency: boolean;
  orderIndex: number;
  readonly owners: Set<PooledRootState>;
  readonly rootOwners: Set<PooledRootState>;
};

type PooledRootState = {
  readonly root: QueryNode;
  readonly reachable: Set<QueryNode>;
  current: IncrementalQueryResult;
  currentIsAssertion: boolean;
  publishedRevision: number;
  closed: boolean;
};

type PooledUpdateJournal = {
  materialized?: Map<QueryNode, MaterializedQueryNode | undefined>;
  roots?: Map<PooledRootState, {
    readonly current: IncrementalQueryResult;
    readonly currentIsAssertion: boolean;
    readonly publishedRevision: number;
  }>;
};

type PooledTransitionEvidence = {
  readonly rejected: boolean;
  readonly assertionWasInvalidated: boolean;
  readonly changedRelationIds: readonly string[];
  readonly updatedNodes: ReadonlySet<QueryNode>;
  readonly changedNodes: ReadonlySet<QueryNode>;
  readonly previousRootNodes: ReadonlyMap<QueryNode, MaterializedQueryNode | undefined>;
  readonly operatorEvents: ReadonlyMap<QueryNode, QueryMaintenanceOperatorEvent>;
};

const emptyPooledTransitionEvidence = (rejected: boolean): PooledTransitionEvidence => ({
  rejected,
  assertionWasInvalidated: false,
  changedRelationIds: Object.freeze([]),
  updatedNodes: new Set(),
  changedNodes: new Set(),
  previousRootNodes: new Map(),
  operatorEvents: new Map()
});

/** Creates an explicitly scoped multi-root physical runtime. */
export const createPooledIncrementalQueryRuntime = (input: {
  readonly environment: PooledIncrementalQueryEnvironment;
  readonly initialSnapshot: QueryMaintenanceSnapshot;
}): PooledIncrementalQueryRuntime => {
  const environment = Object.freeze({
    ...input.environment,
    ...(input.environment.parameters === undefined ? {} : { parameters: adoptJsonRecord(input.environment.parameters, 'Pooled query parameters') }),
    ...(input.environment.functions === undefined ? {} : { functions: adoptFunctionRegistry(input.environment.functions) }),
    ...(input.environment.executionBudget === undefined ? {} : { executionBudget: adoptMaintenanceSnapshot({ relations: [], executionBudget: input.environment.executionBudget }).executionBudget })
  });
  const ownedInitialSnapshot = adoptMaintenanceSnapshot(input.initialSnapshot);
  if (!sameOptionalJson(environment.parameters, ownedInitialSnapshot.parameters)) {
    throw new TypeError('Pooled query environment parameters do not match the initial snapshot');
  }
  if (!sameFunctionRegistry(environment.functions, ownedInitialSnapshot.functions)) {
    throw new TypeError('Pooled query environment functions do not match the initial snapshot');
  }
  if (!sameExecutionBudget(environment.executionBudget, ownedInitialSnapshot.executionBudget)) throw new TypeError('Pooled query environment execution budget does not match the initial snapshot');

  const interned = new Map<string, InternedPooledNode>();
  const internedByNode = new Map<QueryNode, InternedPooledNode>();
  let nextInternedNodeId = 0;
  const physical = new Map<QueryNode, PooledPhysicalNode>();
  let physicalOrder: (QueryNode | undefined)[] = [];
  let physicalOrderTombstones = 0;
  const relationConsumers = new Map<string, Set<QueryNode>>();
  const evidenceConsumers = new Set<QueryNode>();
  const unmaterializedNodes = new Set<QueryNode>();
  let sharedPhysicalNodeCount = 0;
  const materialized = new Map<QueryNode, MaterializedQueryNode>();
  const roots = new Set<PooledRootState>();
  const publicRows = new WeakMap<ScopedRow, QueryRecord>();
  let acceptedSnapshot: QueryMaintenanceSnapshot = ownedInitialSnapshot;
  let runtimeIssues = validateMaintenanceSnapshot(ownedInitialSnapshot);
  let revision = 0;
  let rejectedUpdateCount = 0;
  let closed = false;
  let executionPhase: 'idle' | 'attaching' | 'updating' = 'idle';
  let closeRequested = false;
  const deferredReleases = new Set<PooledRootState>();
  let diagnostics = pooledDiagnostics(environment.runtimeIdentity, 0, 0, 0, 0, 0, 0, 0, 0);
  let assertionInvalidated = runtimeIssues.length > 0;
  let transitionEvidence = emptyPooledTransitionEvidence(runtimeIssues.length > 0);

  const refreshDiagnostics = (updated: number, changed: number, collected: number, operatorDiagnostics = emptyOperatorDiagnostics()): void => {
    diagnostics = pooledDiagnostics(
      environment.runtimeIdentity,
      revision,
      roots.size,
      physical.size,
      sharedPhysicalNodeCount,
      updated,
      changed,
      collected,
      rejectedUpdateCount,
      operatorDiagnostics
    );
  };

  const compactPhysicalOrderIfNeeded = (): void => {
    if (physicalOrderTombstones < 64 || physicalOrderTombstones * 3 < physicalOrder.length) return;
    const compacted: QueryNode[] = [];
    for (const node of physicalOrder) {
      if (node === undefined || !physical.has(node)) continue;
      (physical.get(node) as PooledPhysicalNode).orderIndex = compacted.length;
      compacted.push(node);
    }
    physicalOrder = compacted;
    physicalOrderTombstones = 0;
  };

  const removePhysicalNode = (node: QueryNode, record: PooledPhysicalNode): void => {
    physical.delete(node);
    materialized.delete(node);
    unmaterializedNodes.delete(node);
    for (const child of record.children) physical.get(child)?.parents.delete(node);
    for (const dependency of record.externalDependencies) {
      const consumers = relationConsumers.get(dependency);
      consumers?.delete(node);
      if (consumers?.size === 0) relationConsumers.delete(dependency);
    }
    if (record.sessionEvidenceDependency) evidenceConsumers.delete(node);
    const identity = internedByNode.get(node);
    if (identity !== undefined && interned.get(identity.key) === identity) interned.delete(identity.key);
    internedByNode.delete(node);
    if (physicalOrder[record.orderIndex] === node) {
      physicalOrder[record.orderIndex] = undefined;
      physicalOrderTombstones += 1;
    }
  };

  const releaseNow = (root: PooledRootState): void => {
    if (root.closed) return;
    root.closed = true;
    roots.delete(root);
    let collected = 0;
    for (const node of [...root.reachable].reverse()) {
      const record = physical.get(node);
      if (record === undefined) continue;
      const ownerCount = record.owners.size;
      if (!record.owners.delete(root)) continue;
      record.rootOwners.delete(root);
      if (ownerCount === 2) sharedPhysicalNodeCount -= 1;
      if (record.owners.size !== 0) continue;
      removePhysicalNode(node, record);
      collected += 1;
    }
    root.reachable.clear();
    root.currentIsAssertion = false;
    if (roots.size === 0) transitionEvidence = emptyPooledTransitionEvidence(runtimeIssues.length > 0);
    if (!closed) compactPhysicalOrderIfNeeded();
    refreshDiagnostics(0, 0, collected);
  };

  const release = (root: PooledRootState): void => {
    if (root.closed || deferredReleases.has(root)) return;
    if (executionPhase !== 'idle') {
      deferredReleases.add(root);
      return;
    }
    releaseNow(root);
  };

  const closeNow = (): void => {
    if (closed) return;
    closed = true;
    const collected = physical.size;
    for (const root of Array.from(roots)) releaseNow(root);
    deferredReleases.clear();
    interned.clear();
    internedByNode.clear();
    physical.clear();
    physicalOrder = [];
    physicalOrderTombstones = 0;
    relationConsumers.clear();
    evidenceConsumers.clear();
    unmaterializedNodes.clear();
    sharedPhysicalNodeCount = 0;
    materialized.clear();
    acceptedSnapshot = closedMaintenanceSnapshot;
    runtimeIssues = [];
    transitionEvidence = emptyPooledTransitionEvidence(false);
    assertionInvalidated = false;
    refreshDiagnostics(0, 0, collected);
  };

  const flushDeferredLifecycle = (): void => {
    if (closeRequested) {
      closeNow();
      return;
    }
    for (const root of Array.from(deferredReleases)) releaseNow(root);
    deferredReleases.clear();
  };

  const rememberRootPublication = (root: PooledRootState, journal?: PooledUpdateJournal): void => {
    if (journal === undefined) return;
    const roots = journal.roots ??= new Map();
    if (roots.has(root)) return;
    roots.set(root, {
      current: root.current,
      currentIsAssertion: root.currentIsAssertion,
      publishedRevision: root.publishedRevision
    });
  };

  const publishRoot = (root: PooledRootState, journal?: PooledUpdateJournal): IncrementalQueryResult => {
    if (root.closed) return root.current;
    if (root.publishedRevision === revision) return root.current;
    rememberRootPublication(root, journal);
    if (transitionEvidence.rejected) {
      root.current = maintainedQueryResult(
        undefined,
        runtimeIssues,
        maintenanceState(root.reachable.size, 0, 0, [], emptyIncrementalQueryResultDelta, revision, rejectedUpdateCount),
        publicRows
      );
      root.currentIsAssertion = false;
      root.publishedRevision = revision;
      return root.current;
    }

    const nextRoot = materialized.get(root.root);
    const rootChanged = transitionEvidence.changedNodes.has(root.root);
    const summary = summarizePooledRootMaintenance(
      root.reachable,
      transitionEvidence.updatedNodes,
      transitionEvidence.changedNodes,
      transitionEvidence.operatorEvents
    );
    const previousRoot = transitionEvidence.assertionWasInvalidated
      ? undefined
      : rootChanged ? transitionEvidence.previousRootNodes.get(root.root) : nextRoot;
    root.current = maintainedQueryResult(
      nextRoot,
      [],
      maintenanceState(
        root.reachable.size,
        summary.updatedNodeCount,
        summary.changedNodeCount,
        transitionEvidence.changedRelationIds,
        rootChanged || transitionEvidence.assertionWasInvalidated
          ? diffMaintainedResults(previousRoot, nextRoot)
          : emptyIncrementalQueryResultDelta,
        revision,
        rejectedUpdateCount,
        summary.operatorDiagnostics
      ),
      publicRows,
      root.current,
      root.currentIsAssertion && !rootChanged
    );
    root.currentIsAssertion = true;
    root.publishedRevision = revision;
    return root.current;
  };

  const attachNow = (plan: PreparedPlan<QueryNode>): PooledIncrementalQueryRoot => {
    assertPreparedPlan(plan);
    const run = createEvaluationRun(acceptedSnapshot.executionBudget);
    if (plan.registryFingerprint !== environment.registryFingerprint) throw new TypeError('Prepared plan registry fingerprint does not match pooled query environment');
    if (plan.authorityFingerprint !== environment.authorityFingerprint) throw new TypeError('Prepared plan authority fingerprint does not match pooled query environment');
    if (plan.datasetId !== environment.datasetId) throw new TypeError('Prepared plan dataset does not match pooled query environment');
    assertPoolableQuery(plan.query);
    const detachedRoot = hasOwnedPreparedQuery(plan) ? plan.query : cloneAndFreezeQueryAst(plan.query);
    const createdInterned: InternedPooledNode[] = [];
    const stagedMaterialized: QueryNode[] = [];
    let state: PooledRootState | undefined;
    try {
      const canonicalRoot = internPooledQueryNode(detachedRoot, interned, internedByNode, createdInterned, () => nextInternedNodeId += 1);
      const graph = compileQueryGraph(canonicalRoot);
      const reachable = new Set(graph.nodes);
      const newNodes = graph.nodes.filter((node) => !physical.has(node));
      if (runtimeIssues.length === 0) {
        for (const node of newNodes) {
          materialized.set(node, materializeQueryNode(node, acceptedSnapshot, materialized, run));
          stagedMaterialized.push(node);
        }
      }
      const rootMaterialized = runtimeIssues.length === 0 ? materialized.get(canonicalRoot) : undefined;
      state = {
        root: canonicalRoot,
        reachable,
        current: maintainedQueryResult(
          rootMaterialized,
          runtimeIssues,
          maintenanceState(reachable.size, reachable.size, reachable.size, [], emptyIncrementalQueryResultDelta, revision, rejectedUpdateCount),
          publicRows
        ),
        currentIsAssertion: rootMaterialized !== undefined,
        publishedRevision: revision,
        closed: false
      };
      for (const node of graph.nodes) {
        const existing = physical.get(node);
        if (existing !== undefined) {
          if (existing.owners.size === 1) sharedPhysicalNodeCount += 1;
          existing.owners.add(state);
          continue;
        }
        const orderIndex = physicalOrder.length;
        physical.set(node, {
          children: graph.children.get(node) as readonly QueryNode[],
          parents: new Set(),
          externalDependencies: graph.externalDependencies.get(node) as ReadonlySet<string>,
          sessionEvidenceDependency: graph.sessionEvidenceDependencies.get(node) === true,
          orderIndex,
          owners: new Set([state]),
          rootOwners: new Set()
        });
        physicalOrder.push(node);
        if (!materialized.has(node)) unmaterializedNodes.add(node);
        for (const dependency of graph.externalDependencies.get(node) as ReadonlySet<string>) {
          let consumers = relationConsumers.get(dependency);
          if (consumers === undefined) {
            consumers = new Set();
            relationConsumers.set(dependency, consumers);
          }
          consumers.add(node);
        }
        if (graph.sessionEvidenceDependencies.get(node) === true) evidenceConsumers.add(node);
      }
      for (const node of graph.nodes) {
        const record = physical.get(node) as PooledPhysicalNode;
        if (node === canonicalRoot) record.rootOwners.add(state);
        for (const child of graph.children.get(node) as readonly QueryNode[]) (physical.get(child) as PooledPhysicalNode).parents.add(node);
      }
      const registeredState = state;
      roots.add(registeredState);
      refreshDiagnostics(newNodes.length, newNodes.length, 0);
      return {
        // Query functions may synchronously inspect an existing root while a
        // pooled update is evaluating. Preserve atomic publication by exposing
        // the last committed result until the transition has finished.
        getCurrentResult: () => executionPhase === 'idle'
          ? publishRoot(registeredState)
          : registeredState.current,
        close: () => release(registeredState)
      };
    } catch (error) {
      if (state !== undefined) {
        roots.delete(state);
        for (const node of [...state.reachable].reverse()) {
          const record = physical.get(node);
          if (record === undefined) continue;
          const ownerCount = record.owners.size;
          if (!record.owners.delete(state)) continue;
          record.rootOwners.delete(state);
          if (ownerCount === 2) sharedPhysicalNodeCount -= 1;
          if (record.owners.size === 0) removePhysicalNode(node, record);
        }
      }
      for (const node of stagedMaterialized) materialized.delete(node);
      for (const identity of createdInterned.reverse()) {
        if (physical.has(identity.node)) continue;
        if (interned.get(identity.key) === identity) interned.delete(identity.key);
        internedByNode.delete(identity.node);
      }
      throw error;
    }
  };

  const attach = (plan: PreparedPlan<QueryNode>): PooledIncrementalQueryRoot => {
    if (closed) throw new Error('Pooled incremental query runtime is closed');
    if (executionPhase !== 'idle') throw new PooledQueryRuntimeBusyError(
      executionPhase === 'updating'
        ? 'Cannot attach a pooled query root during an update'
        : 'Cannot attach a pooled query root during another attachment'
    );
    executionPhase = 'attaching';
    try {
      return attachNow(plan);
    } finally {
      executionPhase = 'idle';
      flushDeferredLifecycle();
    }
  };

  const applyUpdateNow = (update: QueryMaintenanceUpdate, journal: PooledUpdateJournal): void => {
    if (closed) throw new Error('Pooled incremental query runtime is closed');
    revision += 1;
    const applied = applyQueryMaintenanceUpdate(acceptedSnapshot, update);
    if (!applied.success) {
      rejectedUpdateCount += 1;
      runtimeIssues = applied.issues;
      assertionInvalidated = true;
      transitionEvidence = emptyPooledTransitionEvidence(true);
      refreshDiagnostics(0, 0, 0);
      return;
    }

    const nextSnapshot = applied.value;
    const run = createEvaluationRun(nextSnapshot.executionBudget);
    runtimeIssues = [];
    const sessionEvidenceChanged = !sameOptionalJson(acceptedSnapshot.basis, nextSnapshot.basis)
      || acceptedSnapshot.membershipRevision !== nextSnapshot.membershipRevision;
    const updatedNodes = new Set<QueryNode>();
    const changedNodes = new Set<QueryNode>();
    const operatorEventsByNode = new Map<QueryNode, QueryMaintenanceOperatorEvent>();
    const previousRootNodes = new Map<QueryNode, MaterializedQueryNode | undefined>();
    const changedRoots = new Set<PooledRootState>();
    const candidates: QueryNode[] = [];
    const enqueued = new Set<QueryNode>();
    const evaluated = new Set<QueryNode>();
    const candidateOrder = (node: QueryNode): number => (physical.get(node) as PooledPhysicalNode).orderIndex;
    const enqueue = (node: QueryNode): void => {
      if (enqueued.has(node) || evaluated.has(node) || !physical.has(node)) return;
      enqueued.add(node);
      candidates.push(node);
      let index = candidates.length - 1;
      while (index > 0) {
        const parent = Math.floor((index - 1) / 2);
        if (candidateOrder(candidates[parent] as QueryNode) <= candidateOrder(node)) break;
        candidates[index] = candidates[parent] as QueryNode;
        index = parent;
      }
      candidates[index] = node;
    };
    const dequeue = (): QueryNode | undefined => {
      const first = candidates[0];
      const last = candidates.pop();
      if (first === undefined) return undefined;
      enqueued.delete(first);
      if (candidates.length !== 0 && last !== undefined) {
        let index = 0;
        while (true) {
          const left = index * 2 + 1;
          if (left >= candidates.length) break;
          const right = left + 1;
          const child = right < candidates.length
            && candidateOrder(candidates[right] as QueryNode) < candidateOrder(candidates[left] as QueryNode)
            ? right
            : left;
          if (candidateOrder(last) <= candidateOrder(candidates[child] as QueryNode)) break;
          candidates[index] = candidates[child] as QueryNode;
          index = child;
        }
        candidates[index] = last;
      }
      return first;
    };
    for (const { relation } of update.relations) for (const node of relationConsumers.get(relationKey(relation)) ?? []) enqueue(node);
    if (sessionEvidenceChanged) for (const node of evidenceConsumers) enqueue(node);
    for (const node of unmaterializedNodes) enqueue(node);

    for (let node = dequeue(); node !== undefined; node = dequeue()) {
      evaluated.add(node);
      const record = physical.get(node) as PooledPhysicalNode;
      const previousNode = materialized.get(node);
      const updated = materializeUpdatedQueryNode({
        node,
        snapshot: nextSnapshot,
        update,
        materializedNodes: materialized,
        previous: previousNode,
        run
      });
      const nextNode = updated.materialized;
      const operatorEvent = updated.operatorEvent;
      if (operatorEvent !== undefined) operatorEventsByNode.set(node, operatorEvent);
      const materializedJournal = journal.materialized ??= new Map();
      if (!materializedJournal.has(node)) materializedJournal.set(node, previousNode);
      materialized.set(node, nextNode);
      unmaterializedNodes.delete(node);
      updatedNodes.add(node);
      if (previousNode === undefined || !materializedQueryNodeEqual(previousNode, nextNode)) {
        changedNodes.add(node);
        if (record.rootOwners.size > 0) {
          previousRootNodes.set(node, previousNode);
          for (const root of record.rootOwners) changedRoots.add(root);
        }
        for (const parent of record.parents) {
          const parentNode = materialized.get(parent);
          if (parent.kind === 'select' && selectCanRetainMaterialization(parent, parentNode, nextNode)) continue;
          enqueue(parent);
        }
      }
    }
    acceptedSnapshot = nextSnapshot;
    transitionEvidence = {
      rejected: false,
      assertionWasInvalidated: assertionInvalidated,
      changedRelationIds: changedRelationIds(update.relations),
      updatedNodes,
      changedNodes,
      previousRootNodes,
      operatorEvents: operatorEventsByNode
    };
    assertionInvalidated = false;
    // Changed roots must consume sparse positional evidence before a later
    // transition replaces it. Unchanged roots publish telemetry lazily.
    for (const root of changedRoots) publishRoot(root, journal);
    refreshDiagnostics(updatedNodes.size, changedNodes.size, 0, summarizeOperatorEvents(operatorEventsByNode.values()));
  };

  const applyUpdate = (update: QueryMaintenanceUpdate): void => {
    if (closed) throw new Error('Pooled incremental query runtime is closed');
    if (executionPhase === 'updating') throw new Error('Recursive pooled query updates are not supported');
    if (executionPhase === 'attaching') throw new Error('Cannot update a pooled query runtime during root attachment');
    const checkpoint = {
      acceptedSnapshot,
      runtimeIssues,
      revision,
      rejectedUpdateCount,
      diagnostics,
      assertionInvalidated,
      transitionEvidence
    };
    const journal: PooledUpdateJournal = {};
    executionPhase = 'updating';
    try {
      applyUpdateNow(adoptQueryMaintenanceUpdate(update), journal);
    } catch (error) {
      acceptedSnapshot = checkpoint.acceptedSnapshot;
      runtimeIssues = checkpoint.runtimeIssues;
      revision = checkpoint.revision;
      rejectedUpdateCount = checkpoint.rejectedUpdateCount;
      diagnostics = checkpoint.diagnostics;
      assertionInvalidated = checkpoint.assertionInvalidated;
      transitionEvidence = checkpoint.transitionEvidence;
      for (const [node, value] of journal.materialized ?? []) {
        if (value === undefined) {
          materialized.delete(node);
          if (physical.has(node)) unmaterializedNodes.add(node);
        } else {
          materialized.set(node, value);
          unmaterializedNodes.delete(node);
        }
      }
      for (const [root, state] of journal.roots ?? []) {
        root.current = state.current;
        root.currentIsAssertion = state.currentIsAssertion;
        root.publishedRevision = state.publishedRevision;
      }
      throw error;
    } finally {
      executionPhase = 'idle';
      flushDeferredLifecycle();
    }
  };

  return {
    attach,
    applyUpdate,
    getDiagnostics: () => diagnostics,
    close: () => {
      if (closed) return;
      if (executionPhase !== 'idle') {
        closeRequested = true;
        return;
      }
      closeNow();
    }
  };
};

const pooledDiagnostics = (
  runtimeIdentity: string,
  revision: number,
  activeRootCount: number,
  physicalNodeCount: number,
  sharedPhysicalNodeCount: number,
  lastUpdatedPhysicalNodeCount: number,
  lastChangedPhysicalNodeCount: number,
  lastCollectedPhysicalNodeCount: number,
  rejectedUpdateCount: number,
  operatorDiagnostics = emptyOperatorDiagnostics()
): PooledIncrementalQueryDiagnostics => Object.freeze({
  strategy: 'pooled-differential-operator-dag',
  runtimeIdentity,
  revision,
  activeRootCount,
  physicalNodeCount,
  sharedPhysicalNodeCount,
  lastUpdatedPhysicalNodeCount,
  lastChangedPhysicalNodeCount,
  lastCollectedPhysicalNodeCount,
  rejectedUpdateCount,
  operatorDiagnostics
});

class PooledQueryRuntimeBusyError extends Error {
  readonly code = 'query.pool.busy';
}

export const isNonPoolableQueryError = (error: unknown): boolean => error instanceof NonPoolableQueryError;
export const isPooledQueryRuntimeBusyError = (error: unknown): boolean => error instanceof PooledQueryRuntimeBusyError;
