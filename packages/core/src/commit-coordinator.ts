import { createIssue, type Issue } from './issues.js';
import { comparePortableStrings } from './portable-order.js';
import type { SourceSnapshot } from './database.js';
import type {
  AtomicSource,
  LogicalEdit,
  PlanResult,
  SourceCommitInput,
  SourceCommitResult,
  StorageBinding
} from './source-protocol.js';

export type CoordinatedCommitResult =
  | { readonly outcome: 'rejected'; readonly issues: readonly Issue[] }
  | ({ readonly outcome: 'committed' | 'unknown' } & SourceCommitResult);

/**
 * Generic one-source coordinator. Bindings remain pure planners; the source is
 * the only component allowed to compare-and-apply commands atomically.
 */
export const coordinateSourceCommit = async <Storage, Command>(input: {
  readonly source: AtomicSource<Storage, Command>;
  readonly bindings: readonly StorageBinding<Storage, Command>[];
  readonly edits: readonly LogicalEdit[];
  readonly commit: Omit<SourceCommitInput<Command>, 'commands'>;
  readonly validate?: (staged: { readonly snapshot: SourceSnapshot<Storage>; readonly plans: readonly PlanResult<Command>[] }) => readonly Issue[];
}): Promise<CoordinatedCommitResult> => {
  const snapshot = input.source.snapshot();
  if (snapshot.state !== 'ready' || snapshot.storage === undefined) {
    return { outcome: 'rejected', issues: [createIssue({ code: 'source.not_ready', phase: 'load', severity: 'error', retry: 'after_refresh', sourceId: input.source.sourceId, details: { state: snapshot.state } })] };
  }
  const issues: Issue[] = [];
  const plans: PlanResult<Command>[] = [];
  for (const binding of [...input.bindings].sort((left, right) => comparePortableStrings(left.id, right.id))) {
    let plan: PlanResult<Command>;
    try {
      plan = binding.plan(snapshot, input.edits);
    } catch (error) {
      return { outcome: 'rejected', issues: [createIssue({ code: 'binding.plan_failed', sourceId: input.source.sourceId, details: { bindingId: binding.id, error: error instanceof Error ? error.name : typeof error } })] };
    }
    issues.push(...plan.issues);
    requireContained(input.source, binding.id, 'read', plan.readFootprint, binding.declaredReadFootprint, issues);
    requireContained(input.source, binding.id, 'write', plan.writeFootprint, binding.declaredWriteFootprint, issues);
    for (const intent of plan.intents) requireContained(input.source, binding.id, 'intent', intent.footprint, plan.writeFootprint, issues);
    plans.push(plan);
  }
  if (hasErrors(issues)) return { outcome: 'rejected', issues };
  const merged = input.source.mergeIntents(plans);
  if (merged.outcome !== 'merged') return { outcome: 'rejected', issues: merged.issues };
  let staged: ReturnType<AtomicSource<Storage, Command>['stage']>;
  try {
    staged = input.source.stage(snapshot, merged.commands);
  } catch (error) {
    return { outcome: 'rejected', issues: [...issues, createIssue({ code: 'binding.stage_failed', sourceId: input.source.sourceId, details: { error: error instanceof Error ? error.name : typeof error } })] };
  }
  issues.push(...staged.issues);
  if (!hasErrors(issues) && input.validate !== undefined) {
    issues.push(...input.validate({ snapshot: { ...snapshot, storage: staged.storage }, plans }));
  }
  if (hasErrors(issues)) return { outcome: 'rejected', issues };
  const result = await input.source.commit({ ...input.commit, commands: merged.commands });
  const combined = issues.length === 0 ? result : { ...result, issues: [...issues, ...result.issues] };
  return combined.outcome === 'rejected' ? { outcome: 'rejected', issues: combined.issues } : combined;
};

const hasErrors = (issues: readonly Issue[]): boolean => issues.some(({ severity }) => severity === 'error');

const requireContained = <Storage, Command>(
  source: AtomicSource<Storage, Command>,
  bindingId: string,
  kind: 'read' | 'write' | 'intent',
  actual: import('./source-protocol.js').Footprint,
  bound: import('./source-protocol.js').Footprint,
  issues: Issue[]
): void => {
  const relation = source.relateFootprints(actual, bound);
  if (relation === 'equal' || relation === 'contained_by') return;
  issues.push(createIssue({ code: 'binding.footprint_out_of_bounds', phase: 'plan', severity: 'error', retry: 'after_input', sourceId: source.sourceId, details: { bindingId, kind, relation } }));
};
