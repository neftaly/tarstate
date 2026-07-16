import { createIssue, type Issue, type IssueSeverity } from './issues.js';
import type { SourceBasis } from './source-state.js';
import type { JsonValue } from './value.js';

export type ConstraintScope = {
  readonly relationId?: string;
  readonly key?: JsonValue;
  readonly scopeId: string;
};

export type ConstraintFailure = {
  readonly id: string;
  readonly subject: ConstraintScope;
  readonly code: string;
  readonly details?: JsonValue;
};

export type ConstraintEvaluation =
  | { readonly status: 'satisfied' }
  | { readonly status: 'violated'; readonly violations: readonly ConstraintFailure[] }
  | { readonly status: 'indeterminate'; readonly failures: readonly [ConstraintFailure, ...ConstraintFailure[]]; readonly issues?: readonly Issue[] };

export type SourceConstraint<State> = {
  readonly id: string;
  readonly mode: 'audit' | 'required';
  readonly dependencyRelations: readonly string[];
  readonly evaluate: (state: State, basis: SourceBasis) => ConstraintEvaluation;
};

export type ConstraintCheck = {
  readonly blockingIssues: readonly Issue[];
  readonly auditIssues: readonly Issue[];
};

/** Evaluates current attachment validity without transaction dirty-state tolerance. */
export const checkCurrentConstraints = <State>(input: {
  readonly constraints: readonly SourceConstraint<State>[];
  readonly state: State;
  readonly basis: SourceBasis;
}): ConstraintCheck => {
  const blockingIssues: Issue[] = [];
  const auditIssues: Issue[] = [];
  for (const constraint of input.constraints) {
    const evaluation = evaluateConstraint(constraint, input.state, input.basis);
    const generated = issuesForEvaluation(constraint, evaluation, failuresOf(evaluation, constraint.id));
    if (constraint.mode === 'required') blockingIssues.push(...generated);
    else auditIssues.push(...generated);
  }
  return Object.freeze({
    blockingIssues: Object.freeze(blockingIssues),
    auditIssues: Object.freeze(auditIssues)
  });
};

/**
 * Compares stable failure identities before and after a write. Existing dirty
 * state is tolerated only for writes outside both its subject and dependency
 * scopes; hard checks remain final-state checks.
 */
export const checkFinalConstraints = <State>(input: {
  readonly constraints: readonly SourceConstraint<State>[];
  readonly before: State;
  readonly after: State;
  readonly beforeBasis: SourceBasis;
  readonly afterBasis: SourceBasis;
  readonly touchedRelations: ReadonlySet<string>;
}): ConstraintCheck => {
  const blockingIssues: Issue[] = [];
  const auditIssues: Issue[] = [];
  for (const constraint of input.constraints) {
    const before = evaluateConstraint(constraint, input.before, input.beforeBasis);
    const after = evaluateConstraint(constraint, input.after, input.afterBasis);
    const previous = new Map(failuresOf(before, constraint.id).map((failure) => [failure.id, failure]));
    const current = failuresOf(after, constraint.id);
    const dependencyTouched = constraint.dependencyRelations.some((relationId) => input.touchedRelations.has(relationId));
    const rejected = current.filter((failure) => {
      const wasPresent = previous.has(failure.id);
      if (!wasPresent) return true;
      return dependencyTouched || (failure.subject.relationId !== undefined && input.touchedRelations.has(failure.subject.relationId));
    });
    const generated = issuesForEvaluation(constraint, after, rejected);
    if (constraint.mode === 'required') blockingIssues.push(...generated);
    else auditIssues.push(...generated);
  }
  return Object.freeze({
    blockingIssues: Object.freeze(blockingIssues),
    auditIssues: Object.freeze(auditIssues)
  });
};

const evaluateConstraint = <State>(
  constraint: SourceConstraint<State>,
  state: State,
  basis: SourceBasis
): ConstraintEvaluation => {
  try {
    return constraint.evaluate(state, basis);
  } catch (error) {
    const failureId = constraint.id + ':evaluation';
    return {
      status: 'indeterminate',
      failures: [{ id: failureId, subject: { scopeId: constraint.id }, code: 'constraint.evaluation_failed' }],
      issues: [constraintIssue(
        'constraint.evaluation_failed',
        constraint.id,
        constraint.mode === 'audit' ? 'warning' : 'error',
        { error: error instanceof Error ? error.name : typeof error },
        failureId
      )]
    };
  }
};

const issuesForEvaluation = <State>(
  constraint: SourceConstraint<State>,
  evaluation: ConstraintEvaluation,
  failures: readonly ConstraintFailure[]
): readonly Issue[] => {
  const severity: IssueSeverity = constraint.mode === 'audit' ? 'warning' : 'error';
  return [
    ...(evaluation.status === 'indeterminate' && failures.length > 0
      ? (evaluation.issues ?? []).map((issue) => Object.freeze({ ...issue, severity }))
      : []),
    ...failures.map((failure) => constraintIssue(
      evaluation.status === 'indeterminate' ? 'constraint.indeterminate' : failure.code,
      constraint.id,
      severity,
      {
        failureId: failure.id,
        scopeId: failure.subject.scopeId,
        ...(failure.details === undefined ? {} : { evidence: failure.details })
      },
      failure.id
    ))
  ];
};

const failuresOf = (evaluation: ConstraintEvaluation, constraintId: string): readonly ConstraintFailure[] => {
  if (evaluation.status === 'satisfied') return [];
  if (evaluation.status === 'violated') return evaluation.violations;
  const failures = evaluation.failures as readonly ConstraintFailure[];
  return failures.length > 0 ? failures : [{ id: constraintId + ':indeterminate', subject: { scopeId: constraintId }, code: 'constraint.indeterminate' }];
};

const constraintIssue = (code: string, constraintId: string, severity: IssueSeverity, details: JsonValue, stableFailureId: string): Issue => {
  const issue = createIssue({
    code,
    phase: 'constraint',
    severity,
    retry: code === 'constraint.indeterminate' ? 'after_refresh' : 'after_input',
    details: { constraintId, evidence: details }
  });
  return Object.freeze({ ...issue, id: code + ':' + constraintId + ':' + stableFailureId });
};
