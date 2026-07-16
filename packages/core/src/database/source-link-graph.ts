export type DatabaseSourceLink = {
  readonly linkId: string;
  readonly originSourceId: string;
  readonly targetSourceId: string;
  readonly targetAttachmentId?: string;
  /** Defaults to required. */
  readonly expectation?: 'required' | 'optional';
};

export type NormalizedDatabaseDiscoveryReference = {
  readonly edgeId: string;
  readonly originSourceId: string;
  readonly targetSourceId: string;
  readonly targetAttachmentId?: string;
  readonly expectation: 'required' | 'optional';
};

export type DatabaseDiscoveryGraphProblem = {
  readonly kind: 'row-invalid' | 'edge-ambiguous' | 'target-attachment-ambiguous' | 'target-member-ambiguous';
  readonly edgeId?: string;
  readonly sourceId?: string;
  readonly attachmentId?: string;
  readonly rowIndex?: number;
};

export type DatabaseDiscoveryTarget = {
  readonly sourceId: string;
  readonly attachmentId?: string;
  readonly expectation: 'required' | 'optional';
  readonly discoveryEdges: readonly string[];
};

export type DatabaseDiscoveryGraph = {
  readonly targets: readonly DatabaseDiscoveryTarget[];
};

export type DatabaseDiscoveryBudget = {
  readonly maxLinkedSources?: number;
  readonly maxDiscoveryEdges?: number;
  readonly maxDepth?: number;
  readonly maxTraversalSteps?: number;
};

export type DatabaseDiscoveryBudgetExceeded = {
  readonly limit: keyof DatabaseDiscoveryBudget;
  readonly maximum: number;
};

export const parseDatabaseDiscoveryReferences = (
  rows: readonly unknown[]
): { readonly references: readonly NormalizedDatabaseDiscoveryReference[]; readonly problems: readonly DatabaseDiscoveryGraphProblem[] } => {
  const references = new Map<string, NormalizedDatabaseDiscoveryReference>();
  const problems: DatabaseDiscoveryGraphProblem[] = [];
  for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
    const parsed = parseReference(rows[rowIndex]);
    if (parsed === undefined) {
      problems.push({ kind: 'row-invalid', rowIndex });
      continue;
    }
    const existing = references.get(parsed.edgeId);
    if (existing !== undefined && !sameReference(existing, parsed)) {
      problems.push({ kind: 'edge-ambiguous', edgeId: parsed.edgeId, rowIndex });
      continue;
    }
    references.set(parsed.edgeId, parsed);
  }
  return {
    references: Object.freeze([...references.values()].sort(compareEdges)),
    problems: Object.freeze(problems)
  };
};

export const buildDatabaseDiscoveryGraph = (
  rootSourceIds: readonly string[],
  references: readonly NormalizedDatabaseDiscoveryReference[],
  budget: DatabaseDiscoveryBudget = {}
): {
  readonly graph?: DatabaseDiscoveryGraph;
  readonly problems: readonly DatabaseDiscoveryGraphProblem[];
  readonly budgetExceeded?: DatabaseDiscoveryBudgetExceeded;
} => {
  const maxLinkedSources = budget.maxLinkedSources ?? Number.MAX_SAFE_INTEGER;
  const maxDiscoveryEdges = budget.maxDiscoveryEdges ?? Number.MAX_SAFE_INTEGER;
  const maxDepth = budget.maxDepth ?? Number.MAX_SAFE_INTEGER;
  const maxTraversalSteps = budget.maxTraversalSteps ?? Number.MAX_SAFE_INTEGER;
  if (references.length > maxTraversalSteps) {
    return budgetFailure('maxTraversalSteps', maxTraversalSteps);
  }
  const roots = new Set(rootSourceIds);
  const byOrigin = new Map<string, NormalizedDatabaseDiscoveryReference[]>();
  for (const reference of references) {
    const edges = byOrigin.get(reference.originSourceId);
    if (edges === undefined) byOrigin.set(reference.originSourceId, [reference]);
    else edges.push(reference);
  }
  for (const edges of byOrigin.values()) edges.sort(compareEdges);
  const reachable = new Set(roots);
  const queue = [...roots].sort(comparePortableStrings);
  const depths = queue.map(() => 0);
  const reachableEdges: NormalizedDatabaseDiscoveryReference[] = [];
  let linkedSourceCount = 0;
  let traversalSteps = references.length;
  for (let index = 0; index < queue.length; index += 1) {
    traversalSteps += 1;
    if (traversalSteps > maxTraversalSteps) {
      return budgetFailure('maxTraversalSteps', maxTraversalSteps);
    }
    const origin = queue[index] as string;
    const depth = depths[index] as number;
    for (const edge of byOrigin.get(origin) ?? []) {
      traversalSteps += 1;
      if (traversalSteps > maxTraversalSteps) {
        return budgetFailure('maxTraversalSteps', maxTraversalSteps);
      }
      if (reachableEdges.length >= maxDiscoveryEdges) {
        return budgetFailure('maxDiscoveryEdges', maxDiscoveryEdges);
      }
      reachableEdges.push(edge);
      if (reachable.has(edge.targetSourceId)) continue;
      if (depth >= maxDepth) return budgetFailure('maxDepth', maxDepth);
      if (!roots.has(edge.targetSourceId)) {
        if (linkedSourceCount >= maxLinkedSources) {
          return budgetFailure('maxLinkedSources', maxLinkedSources);
        }
        linkedSourceCount += 1;
      }
      reachable.add(edge.targetSourceId);
      queue.push(edge.targetSourceId);
      depths.push(depth + 1);
    }
  }

  const targetInputs = new Map<string, NormalizedDatabaseDiscoveryReference[]>();
  for (const edge of reachableEdges) {
    if (roots.has(edge.targetSourceId)) continue;
    const inputs = targetInputs.get(edge.targetSourceId);
    if (inputs === undefined) targetInputs.set(edge.targetSourceId, [edge]);
    else inputs.push(edge);
  }
  const problems: DatabaseDiscoveryGraphProblem[] = [];
  const targets: DatabaseDiscoveryTarget[] = [];
  const targetSourcesByAttachment = new Map<string, string>();
  for (const [sourceId, inputs] of targetInputs) {
    let attachmentId: string | undefined;
    let attachmentAmbiguous = false;
    let expectation: 'required' | 'optional' = 'optional';
    const discoveryEdges: string[] = [];
    for (const input of inputs) {
      if (input.targetAttachmentId !== undefined) {
        if (attachmentId !== undefined && attachmentId !== input.targetAttachmentId) {
          problems.push({ kind: 'target-attachment-ambiguous', sourceId });
          attachmentAmbiguous = true;
          break;
        }
        attachmentId = input.targetAttachmentId;
      }
      if (input.expectation === 'required') expectation = 'required';
      discoveryEdges.push(input.edgeId);
    }
    if (attachmentAmbiguous) continue;
    const memberAttachmentId = attachmentId ?? sourceId;
    const existingSourceId = targetSourcesByAttachment.get(memberAttachmentId);
    if (existingSourceId !== undefined && existingSourceId !== sourceId) {
      problems.push({
        kind: 'target-member-ambiguous',
        sourceId,
        attachmentId: memberAttachmentId
      });
      continue;
    }
    targetSourcesByAttachment.set(memberAttachmentId, sourceId);
    targets.push(Object.freeze({
      sourceId,
      ...(attachmentId === undefined ? {} : { attachmentId }),
      expectation,
      discoveryEdges: Object.freeze(discoveryEdges.sort(comparePortableStrings))
    }));
  }
  if (problems.length > 0) return { problems: Object.freeze(problems) };
  return {
    graph: Object.freeze({
      targets: Object.freeze(targets.sort((left, right) => comparePortableStrings(left.sourceId, right.sourceId)))
    }),
    problems: Object.freeze([])
  };
};

const budgetFailure = (
  limit: keyof DatabaseDiscoveryBudget,
  maximum: number
): { readonly problems: readonly []; readonly budgetExceeded: DatabaseDiscoveryBudgetExceeded } => ({
  problems: Object.freeze([]),
  budgetExceeded: Object.freeze({ limit, maximum })
});

export const mergeDatabaseDiscoveryReferences = (
  retained: readonly NormalizedDatabaseDiscoveryReference[],
  current: readonly NormalizedDatabaseDiscoveryReference[]
): {
  readonly references: readonly NormalizedDatabaseDiscoveryReference[];
  readonly problem?: DatabaseDiscoveryGraphProblem;
} => {
  const byId = new Map(retained.map((reference) => [reference.edgeId, reference]));
  for (const reference of current) {
    const previous = byId.get(reference.edgeId);
    if (previous !== undefined && !sameReference(previous, reference)) {
      return {
        references: retained,
        problem: { kind: 'edge-ambiguous', edgeId: reference.edgeId }
      };
    }
    byId.set(reference.edgeId, reference);
  }
  return { references: Object.freeze([...byId.values()]) };
};

export const sameDatabaseDiscoveryTarget = (
  left: DatabaseDiscoveryTarget,
  right: DatabaseDiscoveryTarget
): boolean => {
  if (left.sourceId !== right.sourceId
    || left.attachmentId !== right.attachmentId
    || left.expectation !== right.expectation
    || left.discoveryEdges.length !== right.discoveryEdges.length) {
    return false;
  }
  for (let index = 0; index < left.discoveryEdges.length; index += 1) {
    if (left.discoveryEdges[index] !== right.discoveryEdges[index]) return false;
  }
  return true;
};

const parseReference = (
  input: unknown
): NormalizedDatabaseDiscoveryReference | undefined => {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return undefined;
  const row = input as Readonly<Record<string, unknown>>;
  const edgeId = row.linkId;
  const originSourceId = row.originSourceId;
  const targetSourceId = row.targetSourceId;
  const targetAttachmentId = row.targetAttachmentId;
  const expectation = row.expectation ?? 'required';
  if (typeof edgeId !== 'string' || edgeId.length === 0
    || typeof originSourceId !== 'string' || originSourceId.length === 0
    || typeof targetSourceId !== 'string' || targetSourceId.length === 0
    || (targetAttachmentId !== undefined && (typeof targetAttachmentId !== 'string' || targetAttachmentId.length === 0))
    || (expectation !== 'required' && expectation !== 'optional')) {
    return undefined;
  }
  return Object.freeze({
    edgeId,
    originSourceId,
    targetSourceId,
    ...(targetAttachmentId === undefined ? {} : { targetAttachmentId }),
    expectation
  });
};

const sameReference = (
  left: NormalizedDatabaseDiscoveryReference,
  right: NormalizedDatabaseDiscoveryReference
): boolean => left.edgeId === right.edgeId
  && left.originSourceId === right.originSourceId
  && left.targetSourceId === right.targetSourceId
  && left.targetAttachmentId === right.targetAttachmentId
  && left.expectation === right.expectation;

const compareEdges = (
  left: NormalizedDatabaseDiscoveryReference,
  right: NormalizedDatabaseDiscoveryReference
): number => comparePortableStrings(left.edgeId, right.edgeId);
import { comparePortableStrings } from '../portable-order.js';
