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
  const plans = [...input.bindings].sort((left, right) => comparePortableStrings(left.id, right.id)).map((binding) => {
    const plan = binding.plan(snapshot, input.edits);
    issues.push(...plan.issues);
    requireContained(input.source, binding.id, 'read', plan.readFootprint, binding.declaredReadFootprint, issues);
    requireContained(input.source, binding.id, 'write', plan.writeFootprint, binding.declaredWriteFootprint, issues);
    for (const intent of plan.intents) requireContained(input.source, binding.id, 'intent', intent.footprint, plan.writeFootprint, issues);
    return plan;
  });
  if (issues.length > 0) return { outcome: 'rejected', issues };
  const merged = input.source.mergeIntents(plans);
  if (merged.outcome !== 'merged') return { outcome: 'rejected', issues: merged.issues };
  const staged = input.source.stage(snapshot, merged.commands);
  issues.push(...staged.issues);
  if (issues.length === 0 && input.validate !== undefined) {
    issues.push(...input.validate({ snapshot: { ...snapshot, storage: staged.storage }, plans }));
  }
  if (issues.length > 0) return { outcome: 'rejected', issues };
  const result = await input.source.commit({ ...input.commit, commands: merged.commands });
  return result.outcome === 'rejected' ? { outcome: 'rejected', issues: result.issues } : result;
};

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
