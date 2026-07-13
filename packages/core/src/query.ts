import type { PreparedPlan } from './maintenance.js';
export { capabilityRefKey } from './issues.js';
import { assertPreparedPlan, hasOwnedPreparedQuery } from './internal-prepared-plan.js';
import {
  adoptFunctionRegistry,
  adoptJsonRecord,
  adoptMaintenanceSnapshot,
  adoptQueryMaintenanceUpdate,
  cloneAndFreezeQueryAst
} from './internal-query-ownership.js';
import {
  evaluateExpression,
  evaluatePreparedExpression,
  prepareExpression
} from './internal-query-expression.js';
import { createEvaluationRun, type ScopedRow } from './internal-query-evaluation-context.js';
import {
  evaluatePreparedQuery,
  evaluateQuery,
  prepareQuery,
} from './internal-query-evaluator.js';
import { sameExecutionBudget, sameFunctionRegistry, sameOptionalJson } from './internal-query-equality.js';
import {
  assertPoolableQuery,
  compileQueryGraph,
  internPooledQueryNode,
  NonPoolableQueryError,
  type InternedPooledNode
} from './internal-query-graph.js';
import {
  emptyOperatorDiagnostics,
  summarizeOperatorEvents,
  type QueryMaintenanceOperatorEvent
} from './internal-query-maintenance-diagnostics.js';
import type { MaterializedQueryNode } from './internal-query-maintenance-model.js';
import {
  diffMaintainedResults,
  emptyIncrementalQueryResultDelta,
  maintainedQueryResult,
  maintenanceState,
  materializeUpdatedQueryNode,
  materializedQueryNodeEqual,
  materializeQueryNode
} from './internal-query-maintenance-engine.js';
import {
  applyQueryMaintenanceUpdate,
  changedRelationIds,
  validateMaintenanceSnapshot
} from './internal-query-maintenance-transition.js';
import { diffQueryMaintenanceSnapshots } from './query-maintenance-diff.js';
import { relationKey } from './internal-query-relations.js';
import type {
  IncrementalQueryMaintenanceSession,
  IncrementalQueryResult,
  PooledIncrementalQueryDiagnostics,
  PooledIncrementalQueryEnvironment,
  PooledIncrementalQueryRoot,
  PooledIncrementalQueryRuntime,
  QueryMaintenanceSnapshot,
  QueryMaintenanceUpdate,
  QueryNode,
  QueryRecord
} from './query-model.js';

export type * from './query-model.js';
export {
  diffQueryMaintenanceSnapshots,
  evaluateExpression,
  evaluatePreparedExpression,
  evaluatePreparedQuery,
  evaluateQuery,
  prepareExpression,
  prepareQuery
};

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
  let acceptedSnapshot = ownedInitialSnapshot;
  let closed = false;
  let revision = 0;
  let rejectedUpdateCount = 0;
  let valueIdentities = new WeakMap<ScopedRow, string>();
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
        const changedRelations = new Set(ownedUpdate.relations.map(({ relation }) => relationKey(relation)));
        const sessionEvidenceChanged = !sameOptionalJson(acceptedSnapshot.basis, nextSnapshot.basis)
          || acceptedSnapshot.membershipRevision !== nextSnapshot.membershipRevision;
        let updatedNodeCount = 0;
        const changedNodes = new Set<QueryNode>();
        const operatorEvents = new Map<QueryNode, QueryMaintenanceOperatorEvent>();
        for (const node of graph.nodes) {
          const children = graph.children.get(node) as readonly QueryNode[];
          const externalDependencies = graph.externalDependencies.get(node) as ReadonlySet<string>;
          const childChanged = children.some((child) => changedNodes.has(child));
          const externalInputChanged = [...externalDependencies].some((key) => changedRelations.has(key));
          const evidenceInputChanged = sessionEvidenceChanged && graph.sessionEvidenceDependencies.get(node) === true;
          if (!evidenceInputChanged && !childChanged && !externalInputChanged) continue;
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
          if (previousNode === undefined || !materializedQueryNodeEqual(previousNode, nextNode, valueIdentities)) changedNodes.add(node);
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
            changedRelationIds(ownedUpdate.relations.map(({ relation }) => relation)),
            diffMaintainedResults(assertedRoot, root, valueIdentities),
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
        valueIdentities = new WeakMap();
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
};


type PooledRootState = {
  readonly root: QueryNode;
  readonly reachable: ReadonlySet<QueryNode>;
  current: IncrementalQueryResult;
  asserted: MaterializedQueryNode | undefined;
  closed: boolean;
};

type PooledUpdateJournal = {
  readonly materialized: Map<QueryNode, MaterializedQueryNode | undefined>;
  readonly roots: Map<PooledRootState, { readonly current: IncrementalQueryResult; readonly asserted: MaterializedQueryNode | undefined }>;
};

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
  let valueIdentities = new WeakMap<ScopedRow, string>();
  const publicRows = new WeakMap<ScopedRow, QueryRecord>();
  let acceptedSnapshot = ownedInitialSnapshot;
  let runtimeIssues = validateMaintenanceSnapshot(ownedInitialSnapshot);
  let revision = 0;
  let rejectedUpdateCount = 0;
  let closed = false;
  let executionPhase: 'idle' | 'attaching' | 'updating' = 'idle';
  let closeRequested = false;
  const deferredReleases = new Set<PooledRootState>();
  let diagnostics = pooledDiagnostics(environment.runtimeIdentity, 0, 0, 0, 0, 0, 0, 0, 0);

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
      if (ownerCount === 2) sharedPhysicalNodeCount -= 1;
      if (record.owners.size !== 0) continue;
      removePhysicalNode(node, record);
      collected += 1;
    }
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
        asserted: rootMaterialized,
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
          owners: new Set([state])
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
        for (const child of graph.children.get(node) as readonly QueryNode[]) (physical.get(child) as PooledPhysicalNode).parents.add(node);
      }
      const registeredState = state;
      roots.add(registeredState);
      refreshDiagnostics(newNodes.length, newNodes.length, 0);
      return {
        getCurrentResult: () => registeredState.current,
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
      for (const root of roots) {
        if (!journal.roots.has(root)) journal.roots.set(root, { current: root.current, asserted: root.asserted });
        root.current = maintainedQueryResult(
          undefined,
          runtimeIssues,
          maintenanceState(root.reachable.size, 0, 0, [], emptyIncrementalQueryResultDelta, revision, rejectedUpdateCount),
          publicRows
        );
        root.asserted = undefined;
      }
      refreshDiagnostics(0, 0, 0);
      return;
    }

    const nextSnapshot = applied.value;
    const run = createEvaluationRun(nextSnapshot.executionBudget);
    runtimeIssues = [];
    const changedRelations = new Set(update.relations.map(({ relation }) => relationKey(relation)));
    const sessionEvidenceChanged = !sameOptionalJson(acceptedSnapshot.basis, nextSnapshot.basis)
      || acceptedSnapshot.membershipRevision !== nextSnapshot.membershipRevision;
    const updatedNodes = new Set<QueryNode>();
    const changedNodes = new Set<QueryNode>();
    const rootUpdatedCounts = new Map<PooledRootState, number>();
    const rootChangedCounts = new Map<PooledRootState, number>();
    const operatorEvents: QueryMaintenanceOperatorEvent[] = [];
    const rootOperatorEvents = new Map<PooledRootState, QueryMaintenanceOperatorEvent[]>();
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
    for (const relation of changedRelations) for (const node of relationConsumers.get(relation) ?? []) enqueue(node);
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
      if (operatorEvent !== undefined) {
        operatorEvents.push(operatorEvent);
        for (const owner of record.owners) {
          const ownedEvents = rootOperatorEvents.get(owner);
          if (ownedEvents === undefined) rootOperatorEvents.set(owner, [operatorEvent]);
          else ownedEvents.push(operatorEvent);
        }
      }
      if (!journal.materialized.has(node)) journal.materialized.set(node, previousNode);
      materialized.set(node, nextNode);
      unmaterializedNodes.delete(node);
      updatedNodes.add(node);
      for (const owner of record.owners) rootUpdatedCounts.set(owner, (rootUpdatedCounts.get(owner) ?? 0) + 1);
      if (previousNode === undefined || !materializedQueryNodeEqual(previousNode, nextNode, valueIdentities)) {
        changedNodes.add(node);
        for (const owner of record.owners) rootChangedCounts.set(owner, (rootChangedCounts.get(owner) ?? 0) + 1);
        for (const parent of record.parents) enqueue(parent);
      }
    }
    acceptedSnapshot = nextSnapshot;
    const changedIds = changedRelationIds(update.relations.map(({ relation }) => relation));
    for (const root of roots) {
      const nextRoot = materialized.get(root.root);
      const rootChangedNodeCount = rootChangedCounts.get(root) ?? 0;
      // A rejected update clears `asserted` while retaining the last physical
      // graph. The first accepted transition must therefore republish that
      // graph even when no node needed evaluation.
      const reusePublicViews = root.asserted !== undefined && rootChangedNodeCount === 0;
      const nextCurrent = maintainedQueryResult(
        nextRoot,
        [],
        maintenanceState(
          root.reachable.size,
          rootUpdatedCounts.get(root) ?? 0,
          rootChangedNodeCount,
          changedIds,
          reusePublicViews
            ? emptyIncrementalQueryResultDelta
            : diffMaintainedResults(root.asserted, nextRoot, valueIdentities),
          revision,
          rejectedUpdateCount,
          summarizeOperatorEvents(rootOperatorEvents.get(root) ?? [])
        ),
        publicRows,
        root.current,
        reusePublicViews
      );
      if (!journal.roots.has(root)) journal.roots.set(root, { current: root.current, asserted: root.asserted });
      root.current = nextCurrent;
      root.asserted = nextRoot;
    }
    refreshDiagnostics(updatedNodes.size, changedNodes.size, 0, summarizeOperatorEvents(operatorEvents));
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
      diagnostics
    };
    const journal: PooledUpdateJournal = { materialized: new Map(), roots: new Map() };
    executionPhase = 'updating';
    try {
      applyUpdateNow(adoptQueryMaintenanceUpdate(update), journal);
    } catch (error) {
      acceptedSnapshot = checkpoint.acceptedSnapshot;
      runtimeIssues = checkpoint.runtimeIssues;
      revision = checkpoint.revision;
      rejectedUpdateCount = checkpoint.rejectedUpdateCount;
      diagnostics = checkpoint.diagnostics;
      for (const [node, value] of journal.materialized) {
        if (value === undefined) {
          materialized.delete(node);
          if (physical.has(node)) unmaterializedNodes.add(node);
        } else {
          materialized.set(node, value);
          unmaterializedNodes.delete(node);
        }
      }
      for (const [root, state] of journal.roots) {
        root.current = state.current;
        root.asserted = state.asserted;
      }
      // Identity entries computed from an aborted graph may refer to values
      // that were never accepted. Rebuild them lazily from restored nodes.
      valueIdentities = new WeakMap();
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
