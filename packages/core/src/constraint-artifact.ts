import { canonicalizeJson, type ArtifactRef } from './artifacts.js';
import { sealTypedArtifact, type TypedArtifact, type TypedArtifactInput } from './internal-seal.js';
import { createIssue, type CapabilityRef, type Issue } from './issues.js';
import type { JsonValue } from './value.js';
import type { ConstraintEvaluation, ConstraintFailure, SourceConstraint } from './constraints.js';
import type { SourceBasis } from './maintenance.js';

export type PortableConstraint = {
  readonly id: string;
  readonly code: string;
  readonly dependencyRelations: readonly string[];
  readonly violationQuery: JsonValue;
};

export type ConstraintSetBody = {
  readonly schemaView: ArtifactRef;
  readonly constraints: readonly PortableConstraint[];
  readonly requiredCapabilities: readonly CapabilityRef[];
};

export type ConstraintSetArtifact = TypedArtifact<'constraint-set', ConstraintSetBody>;

export const sealConstraintSet = (input: TypedArtifactInput<ConstraintSetBody>): Promise<ConstraintSetArtifact> => {
  const ids = input.body.constraints.map(({ id }) => id);
  if (new Set(ids).size !== ids.length) throw new Error('Constraint IDs must be unique within a set');
  return sealTypedArtifact('constraint-set', input);
};

export type ConstraintQueryOutcome = {
  readonly rows: readonly { readonly subject: JsonValue; readonly evidence?: JsonValue; readonly details?: JsonValue }[];
  readonly completeness: 'exact' | 'lower-bound' | 'unknown';
  readonly issues: readonly Issue[];
};

export const compileSourceConstraints = <State>(input: {
  readonly set: ConstraintSetArtifact;
  readonly mode: 'audit' | 'required';
  readonly evaluateQuery: (query: JsonValue, state: State, basis: SourceBasis) => ConstraintQueryOutcome;
}): readonly SourceConstraint<State>[] => input.set.body.constraints.map((constraint) => ({
  id: constraint.id,
  mode: input.mode,
  dependencyRelations: constraint.dependencyRelations,
  evaluate: (state, basis) => evaluatePortableConstraint(input.set, constraint, input.evaluateQuery(constraint.violationQuery, state, basis), basis)
}));

const evaluatePortableConstraint = (set: ConstraintSetArtifact, constraint: PortableConstraint, outcome: ConstraintQueryOutcome, basis: SourceBasis): ConstraintEvaluation => {
  if (outcome.completeness !== 'exact') {
    const failure: ConstraintFailure = { id: stableFailureId(set.id, constraint.id, { scope: constraint.dependencyRelations }, 'constraint.query_indeterminate'), subject: { scopeId: constraint.id }, code: 'constraint.query_indeterminate', details: { basis, completeness: outcome.completeness } as JsonValue };
    return { status: 'indeterminate', failures: [failure], issues: outcome.issues };
  }
  const violations = outcome.rows.map((row): ConstraintFailure => ({
    id: stableFailureId(set.id, constraint.id, row.subject, constraint.code),
    subject: { scopeId: canonicalizeJson(row.subject), ...(isRowSubject(row.subject) ? { relationId: row.subject.relationId, ...(row.subject.key === undefined ? {} : { key: row.subject.key }) } : {}) },
    code: constraint.code,
    ...(row.details === undefined && row.evidence === undefined ? {} : { details: { ...(row.details === undefined ? {} : { details: row.details }), ...(row.evidence === undefined ? {} : { evidence: row.evidence }) } })
  }));
  return violations.length === 0 ? { status: 'satisfied' } : { status: 'violated', violations };
};

export type ReferentialAction = {
  readonly id: string;
  readonly parentRelationId: string;
  readonly childRelationId: string;
  readonly policy: 'restrict' | 'cascade' | 'set-null';
  readonly childFields: readonly string[];
};

export type ReferentialRow = { readonly handle: string; readonly relationId: string; readonly key: JsonValue; readonly fields: Readonly<Record<string, JsonValue>> };
export type GeneratedReferentialEdit = { readonly actionId: string; readonly handle: string; readonly relationId: string; readonly kind: 'delete' | 'set-null'; readonly fields?: readonly string[] };

/** Expands same-source delete actions to a visited-handle fixed point. */
export const expandReferentialDeletes = (input: {
  readonly deleted: readonly ReferentialRow[];
  readonly rows: readonly ReferentialRow[];
  readonly actions: readonly ReferentialAction[];
  readonly maxGenerated?: number;
}): { readonly edits: readonly GeneratedReferentialEdit[]; readonly issues: readonly Issue[] } => {
  const maxGenerated = input.maxGenerated ?? 100_000;
  const queue = [...input.deleted];
  const visited = new Set(queue.map(({ handle }) => handle));
  const edits: GeneratedReferentialEdit[] = [];
  const issues: Issue[] = [];
  while (queue.length > 0) {
    const parent = queue.shift() as ReferentialRow;
    for (const action of input.actions.filter(({ parentRelationId }) => parentRelationId === parent.relationId)) {
      if (action.childFields.length === 0) {
        issues.push(createIssue({ code: 'constraint.referential_action_invalid', relationId: action.childRelationId, details: { actionId: action.id, reason: 'child_fields_empty' } }));
        continue;
      }
      const children = input.rows.filter((row) => {
        if (row.relationId !== action.childRelationId) return false;
        const childKey = action.childFields.length === 1
          ? row.fields[action.childFields[0] as string] ?? null
          : action.childFields.map((field) => row.fields[field] ?? null);
        return canonicalizeJson(childKey) === canonicalizeJson(parent.key);
      });
      if (children.length > 0 && action.policy === 'restrict') {
        issues.push(createIssue({ code: 'constraint.delete_restricted', phase: 'constraint', severity: 'error', retry: 'after_input', relationId: parent.relationId, key: parent.key, details: { actionId: action.id } }));
        continue;
      }
      for (const child of children) {
        if (action.policy === 'set-null') edits.push({ actionId: action.id, handle: child.handle, relationId: child.relationId, kind: 'set-null', fields: action.childFields });
        if (action.policy === 'cascade' && !visited.has(child.handle)) {
          visited.add(child.handle);
          edits.push({ actionId: action.id, handle: child.handle, relationId: child.relationId, kind: 'delete' });
          queue.push(child);
        }
        if (edits.length > maxGenerated) return { edits: [], issues: [createIssue({ code: 'constraint.referential_budget_exceeded', phase: 'constraint', severity: 'error', retry: 'after_input', details: { limit: maxGenerated } })] };
      }
    }
  }
  return { edits: issues.length === 0 ? edits : [], issues };
};

const stableFailureId = (setId: string, constraintId: string, subject: JsonValue, code: string): string => [setId, constraintId, code, canonicalizeJson(subject)].join(':');
const isRowSubject = (value: JsonValue): value is { readonly relationId: string; readonly key?: JsonValue } => value !== null && typeof value === 'object' && !Array.isArray(value) && typeof (value as Readonly<Record<string, JsonValue>>).relationId === 'string';
