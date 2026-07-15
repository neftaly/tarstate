import { createIssue, type Issue } from './issues.js';
import { comparePortableStrings } from './portable-order.js';
import type { SourceSnapshot } from './source-state.js';
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

export type StagedSourceEdits<Storage, Command> = {
  readonly outcome: 'staged';
  readonly snapshot: SourceSnapshot<Storage>;
  readonly plans: readonly PlanResult<Command>[];
  readonly commands: readonly Command[];
  readonly issues: readonly Issue[];
};

export type StageSourceEditsResult<Storage, Command> =
  | StagedSourceEdits<Storage, Command>
  | { readonly outcome: 'rejected'; readonly issues: readonly Issue[] };

/**
 * Pure pre-handoff planning and staging for one ordered logical edit group.
 * Callers may chain the returned snapshot and append command groups before one
 * final source commit; this function never mutates or hands off to the source.
 */
export const stageSourceEdits = <Storage, Command>(input: {
  readonly source: AtomicSource<Storage, Command>;
  readonly bindings: readonly StorageBinding<Storage, Command>[];
  readonly snapshot: SourceSnapshot<Storage>;
  readonly edits: readonly LogicalEdit[];
  readonly validate?: (staged: { readonly snapshot: SourceSnapshot<Storage>; readonly plans: readonly PlanResult<Command>[] }) => readonly Issue[];
}): StageSourceEditsResult<Storage, Command> => {
  const snapshot = input.snapshot;
  if (snapshot.state !== 'ready' || snapshot.storage === undefined) {
    return { outcome: 'rejected', issues: [createIssue({ code: 'source.not_ready', phase: 'load', severity: 'error', retry: 'after_refresh', sourceId: input.source.sourceId, details: { state: snapshot.state } })] };
  }
  if (snapshot.sourceId !== input.source.sourceId) {
    return { outcome: 'rejected', issues: [createIssue({ code: 'source.identity_mismatch', phase: 'plan', severity: 'error', retry: 'after_input', sourceId: input.source.sourceId, details: { snapshotSourceId: snapshot.sourceId } })] };
  }
  const issues: Issue[] = [];
  const plans: PlanResult<Command>[] = [];
  const editHandlers = input.edits.map(() => [] as { readonly bindingId: string; readonly mode: 'exclusive' | 'cooperative' }[]);
  const editedRelations = new Set(input.edits.map(({ relationId }) => relationId));
  for (const binding of sortedBindings(input.bindings)) {
    if (binding.relationIds !== undefined && !binding.relationIds.some((relationId) => editedRelations.has(relationId))) continue;
    let plan: PlanResult<Command>;
    try {
      plan = binding.plan(snapshot, input.edits);
    } catch (error) {
      return { outcome: 'rejected', issues: [createIssue({ code: 'binding.plan_failed', sourceId: input.source.sourceId, details: { bindingId: binding.id, error: error instanceof Error ? error.name : typeof error } })] };
    }
    issues.push(...plan.issues);
    collectEditHandling(binding.id, plan, input.edits, editHandlers, issues);
    requireContained(input.source, binding.id, 'read', plan.readFootprint, binding.declaredReadFootprint, issues);
    requireContained(input.source, binding.id, 'write', plan.writeFootprint, binding.declaredWriteFootprint, issues);
    for (const intent of plan.intents) requireContained(input.source, binding.id, 'intent', intent.footprint, plan.writeFootprint, issues);
    plans.push(plan);
  }
  requireCompleteEditHandling(input.edits, editHandlers, issues);
  if (hasErrors(issues)) return { outcome: 'rejected', issues };
  let merged: ReturnType<AtomicSource<Storage, Command>['mergeIntents']>;
  try {
    merged = input.source.mergeIntents(plans);
  } catch (error) {
    return {
      outcome: 'rejected',
      issues: [...issues, callbackIssue(
        'binding.merge_failed',
        input.source.sourceId,
        error
      )]
    };
  }
  if (merged.outcome !== 'merged') {
    return { outcome: 'rejected', issues: [...issues, ...merged.issues] };
  }
  let staged: ReturnType<AtomicSource<Storage, Command>['stage']>;
  try {
    staged = input.source.stage(snapshot, merged.commands);
  } catch (error) {
    return { outcome: 'rejected', issues: [...issues, createIssue({ code: 'binding.stage_failed', sourceId: input.source.sourceId, details: { error: error instanceof Error ? error.name : typeof error } })] };
  }
  issues.push(...staged.issues);
  const stagedSnapshot = { ...snapshot, storage: staged.storage };
  if (!hasErrors(issues) && input.validate !== undefined) {
    try {
      issues.push(...input.validate({ snapshot: stagedSnapshot, plans }));
    } catch (error) {
      issues.push(callbackIssue(
        'binding.validation_failed',
        input.source.sourceId,
        error
      ));
    }
  }
  return hasErrors(issues)
    ? { outcome: 'rejected', issues }
    : { outcome: 'staged', snapshot: stagedSnapshot, plans, commands: merged.commands, issues };
};

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
  let snapshot: SourceSnapshot<Storage>;
  try {
    snapshot = input.source.snapshot();
  } catch (error) {
    return {
      outcome: 'rejected',
      issues: [callbackIssue('source.snapshot_failed', input.source.sourceId, error)]
    };
  }
  const staged = stageSourceEdits({
    source: input.source,
    bindings: input.bindings,
    snapshot,
    edits: input.edits,
    ...(input.validate === undefined ? {} : { validate: input.validate })
  });
  if (staged.outcome === 'rejected') return staged;
  let result: SourceCommitResult;
  try {
    result = await input.source.commit({ ...input.commit, commands: staged.commands });
  } catch (error) {
    return {
      outcome: 'unknown',
      beforeBasis: input.commit.expectedBasis,
      issues: [
        ...staged.issues,
        createIssue({
          code: 'transaction.outcome_unavailable',
          phase: 'commit',
          severity: 'error',
          retry: 'query_outcome',
          sourceId: input.source.sourceId,
          operationId: input.commit.operationId,
          details: { error: errorName(error) }
        })
      ]
    };
  }
  const combined = staged.issues.length === 0 ? result : { ...result, issues: [...staged.issues, ...result.issues] };
  return combined.outcome === 'rejected' ? { outcome: 'rejected', issues: combined.issues } : combined;
};

const hasErrors = (issues: readonly Issue[]): boolean => issues.some(({ severity }) => severity === 'error');

const sortedBindings = <Storage, Command>(
  bindings: readonly StorageBinding<Storage, Command>[]
): readonly StorageBinding<Storage, Command>[] => {
  for (let index = 1; index < bindings.length; index += 1) {
    if (comparePortableStrings((bindings[index - 1] as StorageBinding<Storage, Command>).id, (bindings[index] as StorageBinding<Storage, Command>).id) > 0) {
      return [...bindings].sort((left, right) => comparePortableStrings(left.id, right.id));
    }
  }
  return bindings;
};

const collectEditHandling = <Command>(
  bindingId: string,
  plan: PlanResult<Command>,
  edits: readonly LogicalEdit[],
  handlers: { readonly bindingId: string; readonly mode: 'exclusive' | 'cooperative' }[][],
  issues: Issue[]
): void => {
  if (!Array.isArray(plan.handledEdits)) {
    issues.push(editHandlingIssue('binding.edit_handling_invalid', { bindingId, reason: 'handled_edits_array_required' }));
    return;
  }
  const claimed = new Set<number>();
  for (const handling of plan.handledEdits) {
    if (typeof handling !== 'object'
      || handling === null
      || !Number.isSafeInteger(handling.editIndex)
      || handling.editIndex < 0
      || handling.editIndex >= edits.length
      || (handling.mode !== 'exclusive' && handling.mode !== 'cooperative')
      || claimed.has(handling.editIndex)) {
      issues.push(editHandlingIssue('binding.edit_handling_invalid', { bindingId, reason: 'invalid_or_duplicate_claim' }));
      continue;
    }
    claimed.add(handling.editIndex);
    handlers[handling.editIndex]?.push({ bindingId, mode: handling.mode });
  }
};

const requireCompleteEditHandling = (
  edits: readonly LogicalEdit[],
  handlers: readonly (readonly { readonly bindingId: string; readonly mode: 'exclusive' | 'cooperative' }[])[],
  issues: Issue[]
): void => {
  handlers.forEach((claims, editIndex) => {
    const edit = edits[editIndex] as LogicalEdit;
    if (claims.length === 0) {
      issues.push(editHandlingIssue('binding.edit_unhandled', { editIndex, relationId: edit.relationId }));
      return;
    }
    if (claims.length > 1 && claims.some(({ mode }) => mode !== 'cooperative')) {
      issues.push(editHandlingIssue('binding.edit_handling_conflict', {
        editIndex,
        relationId: edit.relationId,
        bindingIds: claims.map(({ bindingId }) => bindingId)
      }));
    }
  });
};

const editHandlingIssue = (code: string, details: import('./value.js').JsonValue): Issue => createIssue({
  code,
  phase: 'plan',
  severity: 'error',
  retry: 'after_input',
  details
});

const requireContained = <Storage, Command>(
  source: AtomicSource<Storage, Command>,
  bindingId: string,
  kind: 'read' | 'write' | 'intent',
  actual: import('./source-protocol.js').Footprint,
  bound: import('./source-protocol.js').Footprint,
  issues: Issue[]
): void => {
  let relation: ReturnType<AtomicSource<Storage, Command>['relateFootprints']>;
  try {
    relation = source.relateFootprints(actual, bound);
  } catch (error) {
    issues.push(createIssue({
      code: 'binding.footprint_relation_failed',
      phase: 'plan',
      severity: 'error',
      retry: 'after_input',
      sourceId: source.sourceId,
      details: { bindingId, kind, error: errorName(error) }
    }));
    return;
  }
  if (relation === 'equal' || relation === 'contained_by') return;
  issues.push(createIssue({ code: 'binding.footprint_out_of_bounds', phase: 'plan', severity: 'error', retry: 'after_input', sourceId: source.sourceId, details: { bindingId, kind, relation } }));
};

const callbackIssue = (
  code: string,
  sourceId: string,
  error: unknown
): Issue => createIssue({
  code,
  phase: 'plan',
  severity: 'error',
  retry: 'after_refresh',
  sourceId,
  details: { error: errorName(error) }
});

const errorName = (error: unknown): string => error instanceof Error ? error.name : typeof error;
