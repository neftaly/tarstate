import type { ArtifactRef } from './artifacts.js';
import { canonicalizeJson } from './canonical-json.js';
import { sealTypedArtifact, type TypedArtifact, type TypedArtifactInput } from './internal-seal.js';
import { createIssue, type CapabilityRef, type Issue } from './issues.js';
import type { JsonValue } from './value.js';
import type { ConstraintEvaluation, ConstraintFailure, SourceConstraint } from './constraints.js';
import type { SourceBasis } from './source-state.js';
import type { QueryNode } from './query/model.js';
import { visitFullQuerySyntax } from './query/internal/syntax-walk.js';
import { comparePortableStrings } from './portable-order.js';

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

export type PortableConstraintInput = Omit<PortableConstraint, 'dependencyRelations' | 'violationQuery'> & {
  /**
   * Defaults to every relation referenced by the query. Explicit supersets
   * may declare dependencies hidden behind host capability calls.
   */
  readonly dependencyRelations?: readonly string[];
  readonly violationQuery: QueryNode;
};

export type ConstraintSetInputBody = Omit<ConstraintSetBody, 'constraints'> & {
  readonly constraints: readonly PortableConstraintInput[];
};

export const sealConstraintSet = (input: TypedArtifactInput<ConstraintSetInputBody>): Promise<ConstraintSetArtifact> => {
  const ids = input.body.constraints.map(({ id }) => id);
  if (new Set(ids).size !== ids.length) throw new TypeError('Constraint IDs must be unique within a set');
  const constraints = input.body.constraints.map((constraint): PortableConstraint => {
    const referencedRelations = queryDependencyRelations(constraint.violationQuery);
    const declaredRelations = constraint.dependencyRelations === undefined
      ? referencedRelations
      : uniqueSortedStrings(constraint.dependencyRelations);
    const declared = new Set(declaredRelations);
    const missing = referencedRelations.filter((relationId) => !declared.has(relationId));
    if (missing.length > 0) {
      throw new TypeError(`Constraint ${JSON.stringify(constraint.id)} omits query relation dependencies: ${missing.join(', ')}`);
    }
    return {
      id: constraint.id,
      code: constraint.code,
      dependencyRelations: declaredRelations,
      violationQuery: constraint.violationQuery as unknown as JsonValue
    };
  });
  return sealTypedArtifact('constraint-set', {
    ...(input.id === undefined ? {} : { id: input.id }),
    ...(input.dependencies === undefined ? {} : { dependencies: input.dependencies }),
    body: {
      schemaView: input.body.schemaView,
      constraints,
      requiredCapabilities: input.body.requiredCapabilities
    }
  });
};

const queryDependencyRelations = (query: QueryNode): readonly string[] => {
  const relationIds = new Set<string>();
  visitFullQuerySyntax(query, (node) => {
    if (node.kind === 'from') relationIds.add(node.relation.relationId);
  });
  return Object.freeze([...relationIds].sort(comparePortableStrings));
};

const uniqueSortedStrings = (values: readonly string[]): readonly string[] =>
  Object.freeze([...new Set(values)].sort(comparePortableStrings));

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
  const actionsByParent = groupByRelation(input.actions, ({ parentRelationId }) => parentRelationId);
  const rowsByRelation = groupByRelation(input.rows, ({ relationId }) => relationId);
  for (let queueIndex = 0; queueIndex < queue.length; queueIndex += 1) {
    const parent = queue[queueIndex] as ReferentialRow;
    for (const action of actionsByParent.get(parent.relationId) ?? []) {
      if (action.childFields.length === 0) {
        issues.push(createIssue({ code: 'constraint.referential_action_invalid', relationId: action.childRelationId, details: { actionId: action.id, reason: 'child_fields_empty' } }));
        continue;
      }
      const parentKey = canonicalizeJson(parent.key);
      const candidates = rowsByRelation.get(action.childRelationId) ?? [];
      if (action.policy === 'restrict'
        && candidates.some((row) => referencesParent(row, action.childFields, parentKey))) {
        issues.push(createIssue({ code: 'constraint.delete_restricted', phase: 'constraint', severity: 'error', retry: 'after_input', relationId: parent.relationId, key: parent.key, details: { actionId: action.id } }));
        continue;
      }
      for (const child of candidates) {
        if (!referencesParent(child, action.childFields, parentKey)) continue;
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

const groupByRelation = <Value>(
  values: readonly Value[],
  relationId: (value: Value) => string
): ReadonlyMap<string, readonly Value[]> => {
  const grouped = new Map<string, Value[]>();
  for (const value of values) {
    const key = relationId(value);
    const group = grouped.get(key);
    if (group === undefined) grouped.set(key, [value]);
    else group.push(value);
  }
  return grouped;
};

const referencesParent = (
  row: ReferentialRow,
  childFields: readonly string[],
  parentKey: string
): boolean => {
  const childKey = childFields.length === 1
    ? row.fields[childFields[0] as string] ?? null
    : childFields.map((field) => row.fields[field] ?? null);
  return canonicalizeJson(childKey) === parentKey;
};

const stableFailureId = (setId: string, constraintId: string, subject: JsonValue, code: string): string => [setId, constraintId, code, canonicalizeJson(subject)].join(':');
const isRowSubject = (value: JsonValue): value is { readonly relationId: string; readonly key?: JsonValue } => value !== null && typeof value === 'object' && !Array.isArray(value) && typeof (value as Readonly<Record<string, JsonValue>>).relationId === 'string';
