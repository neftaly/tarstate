import { canonicalJson, issue, sameJson, type ArtifactRef, type Issue, type JsonValue, type LensStep, type SchemaLensBody } from './wire.js';

export type LensArtifact = { readonly ref: ArtifactRef; readonly body: SchemaLensBody };
export type LensRows = Readonly<Record<string, readonly Readonly<Record<string, JsonValue>>[]>>;

export type LensResolution =
  | { readonly outcome: 'resolved'; readonly lens: LensArtifact; readonly issues: readonly Issue[] }
  | { readonly outcome: 'rejected'; readonly issues: readonly Issue[] };

export type LensProjection = {
  readonly rows: readonly Readonly<Record<string, JsonValue>>[];
  readonly issues: readonly Issue[];
};

export type LensCommitResult =
  | { readonly outcome: 'committed'; readonly rows: LensRows; readonly returning: Readonly<Record<string, JsonValue>>; readonly issues: readonly Issue[] }
  | { readonly outcome: 'rejected'; readonly rows: LensRows; readonly issues: readonly Issue[] };

export const resolveLensPath = (
  from: ArtifactRef,
  to: ArtifactRef,
  candidates: readonly LensArtifact[],
  selected: readonly ArtifactRef[] = []
): LensResolution => {
  const matching = candidates.filter((candidate) => sameRef(candidate.body.from, from) && sameRef(candidate.body.to, to));
  const conflictingId = matching.find((candidate, index) => matching.some((other, otherIndex) => otherIndex !== index && other.ref.id === candidate.ref.id && other.ref.contentHash !== candidate.ref.contentHash));
  if (conflictingId !== undefined) return { outcome: 'rejected', issues: [issue('lens.metadata_conflict', 'plan', { lensId: conflictingId.ref.id })] };
  if (selected.length > 1) return { outcome: 'rejected', issues: [issue('lens.path_ambiguous', 'plan', { selected: selected.length })] };
  if (selected.length === 1) {
    const lens = matching.find((candidate) => sameRef(candidate.ref, selected[0] as ArtifactRef));
    return lens === undefined
      ? { outcome: 'rejected', issues: [issue('lens.path_missing', 'plan', { selected: selected[0] as JsonValue })] }
      : { outcome: 'resolved', lens, issues: [] };
  }
  if (matching.length === 0) return { outcome: 'rejected', issues: [issue('lens.path_missing', 'plan')] };
  if (matching.length > 1) return { outcome: 'rejected', issues: [issue('lens.path_ambiguous', 'plan', { candidates: matching.length })] };
  return { outcome: 'resolved', lens: matching[0] as LensArtifact, issues: [] };
};

export const projectLensRelation = (
  lens: SchemaLensBody,
  relationId: string,
  rows: LensRows
): LensProjection => {
  const relation = lens.relations.find((candidate) => candidate.toRelationId === relationId);
  if (relation === undefined) return { rows: [], issues: [issue('lens.relation_missing', 'query', { relationId })] };
  const issues: Issue[] = [];
  const projected = (rows[relation.fromRelationId] ?? []).map((row, rowIndex) => projectRow(relation.steps, row, rows, issues, rowIndex));
  return { rows: projected, issues };
};

export const commitLensUpdate = (input: {
  readonly lens: SchemaLensBody;
  readonly relationId: string;
  readonly rows: LensRows;
  readonly viewKey: Readonly<Record<string, JsonValue>>;
  readonly edits: Readonly<Record<string, JsonValue>>;
  readonly constraintsReady?: boolean;
  readonly validate?: (rows: LensRows) => readonly Issue[];
}): LensCommitResult => {
  if (input.constraintsReady === false) return { outcome: 'rejected', rows: input.rows, issues: [issue('constraint.capability_unavailable', 'constraint', undefined, { retry: 'after_input' })] };
  const relation = input.lens.relations.find((candidate) => candidate.toRelationId === input.relationId);
  if (relation === undefined) return { outcome: 'rejected', rows: input.rows, issues: [issue('lens.relation_missing', 'plan', { relationId: input.relationId })] };
  const stored = input.rows[relation.fromRelationId] ?? [];
  const candidates = stored.map((row, index) => ({ row, index, projected: projectRow(relation.steps, row, input.rows, [], index) })).filter(({ projected }) => recordContains(projected, input.viewKey));
  if (candidates.length !== 1) return { outcome: 'rejected', rows: input.rows, issues: [issue('lens.target_ambiguous', 'plan', { matches: candidates.length })] };
  const target = candidates[0] as typeof candidates[number];
  const translation = translateEdits(relation.steps, target.row, input.edits, input.rows);
  if (translation.issues.length > 0) return { outcome: 'rejected', rows: input.rows, issues: translation.issues };
  const updated = { ...target.row, ...translation.patch };
  const relationRows = [...stored];
  relationRows[target.index] = updated;
  const nextRows = { ...input.rows, [relation.fromRelationId]: relationRows };
  const constraintIssues = input.validate?.(nextRows) ?? [];
  if (constraintIssues.length > 0) return { outcome: 'rejected', rows: input.rows, issues: constraintIssues };
  const returning = projectRow(relation.steps, updated, nextRows, [], target.index);
  return { outcome: 'committed', rows: nextRows, returning, issues: [] };
};

const projectRow = (
  steps: readonly LensStep[],
  row: Readonly<Record<string, JsonValue>>,
  rows: LensRows,
  issues: Issue[],
  rowIndex: number
): Readonly<Record<string, JsonValue>> => {
  const output: Record<string, JsonValue> = {};
  for (const step of steps) {
    if (step.kind === 'extension') { issues.push(issue('lens.capability_unavailable', 'query', { capability: step.capability.id })); continue; }
    if (step.kind === 'lens.hide') continue;
    if (step.kind === 'lens.default') { output[step.to] = step.value; continue; }
    if (step.kind === 'lens.field') {
      if (Object.hasOwn(row, step.from)) output[step.to] = row[step.from] as JsonValue;
      continue;
    }
    if (step.kind === 'lens.value-map') {
      if (!Object.hasOwn(row, step.from)) continue;
      const source = row[step.from] as JsonValue;
      const matched = step.cases.find((candidate) => sameJson(candidate.from, source));
      if (matched === undefined) issues.push(issue('lens.unmapped_value', 'query', { field: step.from, rowIndex }));
      else {
        output[step.to] = matched.to;
        if (matched.writeBack === 'reject') issues.push({ ...issue('lens.lossy_value', 'query', { field: step.to, rowIndex }), severity: 'warning' });
      }
      continue;
    }
    if (!Object.hasOwn(row, step.from)) continue;
    const sourceTuple = tupleFor(row[step.from] as JsonValue, step.sourceFields.length);
    const matches = (rows[step.through.relationId] ?? []).filter((candidate) => step.sourceFields.every((field, index) => sameJson(candidate[field] as JsonValue, sourceTuple[index] as JsonValue)));
    if (matches.length !== 1) {
      issues.push(issue(matches.length === 0 ? 'lens.lookup_missing' : 'lens.lookup_ambiguous', 'query', { field: step.to, rowIndex, matches: matches.length }));
      continue;
    }
    const values = step.resultFields.map((field) => matches[0]?.[field] as JsonValue);
    output[step.to] = values.length === 1 ? values[0] as JsonValue : values;
  }
  return output;
};

const translateEdits = (
  steps: readonly LensStep[],
  row: Readonly<Record<string, JsonValue>>,
  edits: Readonly<Record<string, JsonValue>>,
  rows: LensRows
): { readonly patch: Readonly<Record<string, JsonValue>>; readonly issues: readonly Issue[] } => {
  const patch: Record<string, JsonValue> = {};
  const issues: Issue[] = [];
  for (const [field, value] of Object.entries(edits)) {
    const matching = steps.filter((step) => step.kind !== 'extension' && step.kind !== 'lens.hide' && 'to' in step && step.to === field);
    if (matching.length !== 1) { issues.push(issue(matching.length === 0 ? 'lens.field_not_writable' : 'lens.inverse_ambiguous', 'plan', { field })); continue; }
    const step = matching[0] as Exclude<LensStep, { readonly kind: 'extension' } | { readonly kind: 'lens.hide' }>;
    if (step.kind === 'lens.default' || (step.kind === 'lens.field' && step.write === 'read-only') || (step.kind === 'lens.lookup' && step.write === 'read-only')) {
      issues.push(issue('lens.field_not_writable', 'plan', { field }));
      continue;
    }
    if (step.kind === 'lens.field') { patch[step.from] = value; continue; }
    if (step.kind === 'lens.value-map') {
      const current = step.cases.find((candidate) => Object.hasOwn(row, step.from) && sameJson(candidate.from, row[step.from] as JsonValue));
      if (current?.writeBack === 'reject') { issues.push(issue('lens.lossy_reverse', 'plan', { field })); continue; }
      if (current?.writeBack === 'same-only' && sameJson(current.to, value)) continue;
      const candidates = step.cases.filter((candidate) => candidate.writeBack === 'to-from' && sameJson(candidate.to, value));
      if (candidates.length !== 1) issues.push(issue(candidates.length === 0 ? 'lens.lossy_reverse' : 'lens.inverse_ambiguous', 'plan', { field }));
      else patch[step.from] = (candidates[0] as typeof candidates[number]).from;
      continue;
    }
    const desired = tupleFor(value, step.resultFields.length);
    const matches = (rows[step.through.relationId] ?? []).filter((candidate) => step.resultFields.every((resultField, index) => sameJson(candidate[resultField] as JsonValue, desired[index] as JsonValue)));
    if (matches.length !== 1) { issues.push(issue(matches.length === 0 ? 'lens.lookup_missing' : 'lens.lookup_ambiguous', 'plan', { field, matches: matches.length })); continue; }
    const values = step.sourceFields.map((sourceField) => matches[0]?.[sourceField] as JsonValue);
    patch[step.from] = values.length === 1 ? values[0] as JsonValue : values;
  }
  return { patch, issues };
};

const tupleFor = (value: JsonValue, length: number): readonly JsonValue[] => length === 1 ? [value] : Array.isArray(value) ? value : [value];
const recordContains = (row: Readonly<Record<string, JsonValue>>, expected: Readonly<Record<string, JsonValue>>): boolean => Object.entries(expected).every(([field, value]) => Object.hasOwn(row, field) && sameJson(row[field] as JsonValue, value));
const sameRef = (left: ArtifactRef, right: ArtifactRef): boolean => canonicalJson(left) === canonicalJson(right);
