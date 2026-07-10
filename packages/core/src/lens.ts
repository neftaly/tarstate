import { canonicalizeJson, normalizeArtifactRef, type ArtifactRef } from './artifacts.js';
import { createIssue, type CapabilityRef, type Issue, type ParseResult } from './issues.js';
import { sealTypedArtifact, type TypedArtifact, type TypedArtifactInput } from './internal-seal.js';
import type { RelationId, RelationRow } from './schema.js';
import { safeParseJsonValue, type JsonValue, type PortableValue } from './value.js';

export type LensRelationUse = { readonly schemaView: ArtifactRef; readonly relationId: RelationId };
export type LensStep =
  | { readonly kind: 'lens.field'; readonly from: string; readonly to: string; readonly write: 'invertible' | 'read-only' }
  | { readonly kind: 'lens.default'; readonly to: string; readonly value: PortableValue; readonly write: 'preserve' }
  | { readonly kind: 'lens.hide'; readonly from: string; readonly write: 'preserve' }
  | {
      readonly kind: 'lens.value-map';
      readonly from: string;
      readonly to: string;
      readonly cases: readonly { readonly from: PortableValue; readonly to: PortableValue; readonly writeBack: 'to-from' | 'same-only' | 'reject' }[];
      readonly unmapped: 'reject';
    }
  | {
      readonly kind: 'lens.lookup';
      readonly from: string;
      readonly to: string;
      readonly through: LensRelationUse;
      readonly sourceFields: readonly string[];
      readonly resultFields: readonly string[];
      readonly onMissing: 'reject';
      readonly onAmbiguous: 'reject';
      readonly write: 'invertible' | 'read-only';
    }
  | { readonly kind: 'extension'; readonly capability: CapabilityRef; readonly payload: JsonValue };

export type LensRelation = {
  readonly fromRelationId: RelationId;
  readonly toRelationId: RelationId;
  readonly steps: readonly LensStep[];
};
export type SchemaLensBody = {
  readonly from: ArtifactRef;
  readonly to: ArtifactRef;
  readonly relations: readonly LensRelation[];
};
/** Sealed portable schema-lens artifact with its typed body preserved. */
export type SchemaLensArtifact = TypedArtifact<'schema-lens', SchemaLensBody>;
/** Seals a typed schema lens without a `JsonValue` assertion at the call site. */
export const sealSchemaLens = (input: TypedArtifactInput<SchemaLensBody>): Promise<SchemaLensArtifact> => sealTypedArtifact('schema-lens', input);
export type LensArtifact = { readonly ref: ArtifactRef; readonly body: SchemaLensBody };
export type LensRows = Readonly<Record<RelationId, readonly RelationRow[]>>;

export type LensResolution =
  | { readonly outcome: 'resolved'; readonly path: readonly LensArtifact[]; readonly issues: readonly Issue[] }
  | { readonly outcome: 'rejected'; readonly issues: readonly Issue[] };
export type LensProjection = {
  readonly rows: readonly RelationRow[];
  readonly rejected: readonly { readonly rowIndex: number; readonly row: RelationRow }[];
  readonly issues: readonly Issue[];
  readonly completeness: 'exact' | 'unknown';
};
export type LensPathBudget = { readonly maxVisitedNodes?: number; readonly maxDepth?: number };

export const resolveLensPath = (
  from: ArtifactRef,
  to: ArtifactRef,
  candidates: readonly LensArtifact[],
  selected?: readonly ArtifactRef[],
  budget: LensPathBudget = {}
): LensResolution => {
  const maxVisitedNodes = budget.maxVisitedNodes ?? 10_000;
  const maxDepth = budget.maxDepth ?? 64;
  if (!Number.isSafeInteger(maxVisitedNodes) || maxVisitedNodes <= 0 || !Number.isSafeInteger(maxDepth) || maxDepth <= 0) return rejected('lens.path_budget_exceeded', 'plan', { reason: 'invalid_budget' });
  const hashes = new Map<string, string>();
  const outgoing = new Map<string, LensArtifact[]>();
  for (const candidate of candidates) {
    const hash = hashes.get(candidate.ref.id);
    if (hash !== undefined && hash !== candidate.ref.contentHash) return rejected('lens.metadata_conflict', 'plan', { lensId: candidate.ref.id });
    hashes.set(candidate.ref.id, candidate.ref.contentHash);
    const key = refKey(candidate.body.from);
    const edges = outgoing.get(key);
    if (edges === undefined) outgoing.set(key, [candidate]); else edges.push(candidate);
  }
  if (selected !== undefined) {
    if (selected.length > maxDepth || selected.length > maxVisitedNodes) return rejected('lens.path_budget_exceeded', 'plan', { maxVisitedNodes, maxDepth });
    const path: LensArtifact[] = [];
    let cursor = from;
    for (const ref of selected) {
      const matches = candidates.filter((candidate) => sameRef(candidate.ref, ref));
      if (matches.length !== 1 || !sameRef(matches[0]?.body.from, cursor)) return rejected('lens.path_missing', 'plan', { selected: ref });
      const lens = matches[0] as LensArtifact;
      path.push(lens);
      cursor = lens.body.to;
    }
    return sameRef(cursor, to) ? { outcome: 'resolved', path, issues: [] } : rejected('lens.path_missing', 'plan', { reason: 'selected_path_target' });
  }
  const paths: LensArtifact[][] = [];
  let visitedNodes = 0;
  let exhausted = false;
  const visit = (cursor: ArtifactRef, path: readonly LensArtifact[], visited: ReadonlySet<string>): void => {
    visitedNodes += 1;
    if (visitedNodes > maxVisitedNodes || path.length > maxDepth) { exhausted = true; return; }
    if (paths.length > 1 || exhausted) return;
    if (sameRef(cursor, to)) { paths.push([...path]); return; }
    for (const lens of outgoing.get(refKey(cursor)) ?? []) {
      const nextKey = refKey(lens.body.to);
      if (visited.has(nextKey)) continue;
      visit(lens.body.to, [...path, lens], new Set([...visited, nextKey]));
    }
  };
  visit(from, [], new Set([refKey(from)]));
  if (exhausted) return rejected('lens.path_budget_exceeded', 'plan', { maxVisitedNodes, maxDepth });
  if (paths.length === 0) return rejected('lens.path_missing', 'plan');
  if (paths.length > 1) return rejected('lens.path_ambiguous', 'plan', { candidates: paths.length });
  return { outcome: 'resolved', path: paths[0] as LensArtifact[], issues: [] };
};

export const validateLens = (input: unknown): ParseResult<SchemaLensBody> => {
  if (!isRecord(input) || !isArtifactRef(input.from) || !isArtifactRef(input.to) || !Array.isArray(input.relations)) return lensFailure('lens.invalid', 'parse', [], { reason: 'shape' });
  const body = input as unknown as SchemaLensBody;
  const issues: Issue[] = [];
  body.relations.forEach((relation, relationIndex) => {
    if (!isRecord(relation) || typeof relation.fromRelationId !== 'string' || typeof relation.toRelationId !== 'string' || !Array.isArray(relation.steps)) {
      issues.push(lensIssue('lens.relation_invalid', 'parse', [relationIndex])); return;
    }
    const destinations = new Set<string>();
    relation.steps.forEach((step, stepIndex) => {
      if (!isLensStep(step)) { issues.push(lensIssue('lens.step_invalid', 'parse', [relationIndex, 'steps', stepIndex])); return; }
      if ('to' in step && destinations.has(step.to)) issues.push(lensIssue('lens.field_ambiguous', 'parse', [relationIndex, 'steps', stepIndex], { field: step.to }));
      if ('to' in step) destinations.add(step.to);
      if (step.kind === 'lens.lookup' && (step.sourceFields.length === 0 || step.resultFields.length === 0)) issues.push(lensIssue('lens.lookup_arity', 'parse', [relationIndex, 'steps', stepIndex]));
    });
  });
  return issues.length > 0 ? { success: false, issues } : { success: true, value: body, issues: [] };
};

export const projectLensRelation = (lens: SchemaLensBody, relationId: RelationId, rows: LensRows): LensProjection => {
  const relation = lens.relations.find((candidate) => candidate.toRelationId === relationId);
  if (relation === undefined) return { rows: [], rejected: [], issues: [lensIssue('lens.relation_missing', 'query', [], { relationId })], completeness: 'unknown' };
  const projected: RelationRow[] = [];
  const rejectedRows: { rowIndex: number; row: RelationRow }[] = [];
  const issues: Issue[] = [];
  (rows[relation.fromRelationId] ?? []).forEach((row, rowIndex) => {
    const result = projectLensCandidate(relation.steps, row, rows, rowIndex);
    if (result.success) { projected.push(result.value); issues.push(...result.issues); }
    else { rejectedRows.push({ rowIndex, row }); issues.push(...result.issues); }
  });
  return { rows: projected, rejected: rejectedRows, issues, completeness: rejectedRows.length === 0 ? 'exact' : 'unknown' };
};

export const projectLensCandidate = (
  steps: readonly LensStep[],
  row: RelationRow,
  rows: LensRows,
  rowIndex?: number
): ParseResult<RelationRow> => {
  const output: Record<string, PortableValue> = {};
  const issues: Issue[] = [];
  for (const step of steps) {
    if (step.kind === 'extension') return lensFailure('lens.capability_unavailable', 'query', [], { capability: step.capability.id, rowIndex }, [step.capability], 'after_capability');
    if (step.kind === 'lens.hide') continue;
    if (step.kind === 'lens.default') { output[step.to] = step.value; continue; }
    if (step.kind === 'lens.field') {
      if (Object.hasOwn(row, step.from)) output[step.to] = row[step.from] as PortableValue;
      continue;
    }
    if (step.kind === 'lens.value-map') {
      if (!Object.hasOwn(row, step.from)) continue;
      const matched = step.cases.find((candidate) => sameValue(candidate.from, row[step.from] as PortableValue));
      // `unmapped: reject` rejects this entire projected candidate. A partial row is never exact data.
      if (matched === undefined) return lensFailure('lens.unmapped_value', 'query', [step.from], { field: step.from, rowIndex });
      output[step.to] = matched.to;
      if (matched.writeBack === 'reject') issues.push(lensIssue('lens.lossy_value', 'query', [step.to], { field: step.to, rowIndex }, undefined, undefined, 'warning'));
      continue;
    }
    if (!Object.hasOwn(row, step.from)) continue;
    const tuple = exactTuple(row[step.from] as PortableValue, step.sourceFields.length, step.from, rowIndex);
    if (!tuple.success) return tuple;
    const matches = (rows[step.through.relationId] ?? []).filter((candidate) => fieldsMatch(candidate, step.sourceFields, tuple.value));
    if (matches.length !== 1) return lensFailure(matches.length === 0 ? 'lens.lookup_missing' : 'lens.lookup_ambiguous', 'query', [step.from], { field: step.to, rowIndex, matches: matches.length });
    const values = step.resultFields.map((field) => matches[0]?.[field]).filter((value): value is PortableValue => value !== undefined);
    if (values.length !== step.resultFields.length) return lensFailure('lens.lookup_result_missing', 'query', [step.to], { field: step.to, rowIndex });
    output[step.to] = values.length === 1 ? values[0] as PortableValue : values;
  }
  return { success: true, value: output, issues };
};

export const translateLensEdits = (
  lens: SchemaLensBody,
  relationId: RelationId,
  storedRow: RelationRow,
  edits: Readonly<Record<string, PortableValue>>,
  rows: LensRows
): ParseResult<Readonly<Record<string, PortableValue>>> => {
  const relation = lens.relations.find((candidate) => candidate.toRelationId === relationId);
  if (relation === undefined) return lensFailure('lens.relation_missing', 'plan', [], { relationId });
  const patch: Record<string, PortableValue> = {};
  const issues: Issue[] = [];
  for (const [field, value] of Object.entries(edits)) {
    const matching = relation.steps.filter((step): step is Exclude<LensStep, { readonly kind: 'extension' } | { readonly kind: 'lens.hide' }> => step.kind !== 'extension' && step.kind !== 'lens.hide' && step.to === field);
    if (matching.length !== 1) { issues.push(lensIssue(matching.length === 0 ? 'lens.field_not_writable' : 'lens.inverse_ambiguous', 'plan', [field], { field })); continue; }
    const step = matching[0] as typeof matching[number];
    if (step.kind === 'lens.default' || (step.kind === 'lens.field' && step.write === 'read-only') || (step.kind === 'lens.lookup' && step.write === 'read-only')) {
      issues.push(lensIssue('lens.field_not_writable', 'plan', [field], { field })); continue;
    }
    if (step.kind === 'lens.field') { patch[step.from] = value; continue; }
    if (step.kind === 'lens.value-map') {
      const current = step.cases.find((candidate) => Object.hasOwn(storedRow, step.from) && sameValue(candidate.from, storedRow[step.from] as PortableValue));
      if (current === undefined) { issues.push(lensIssue('lens.unmapped_value', 'plan', [field], { field })); continue; }
      if (current.writeBack === 'reject') { issues.push(lensIssue('lens.lossy_reverse', 'plan', [field], { field })); continue; }
      if (current.writeBack === 'same-only' && sameValue(current.to, value)) continue;
      const inverse = step.cases.filter((candidate) => candidate.writeBack === 'to-from' && sameValue(candidate.to, value));
      if (inverse.length !== 1) issues.push(lensIssue(inverse.length === 0 ? 'lens.lossy_reverse' : 'lens.inverse_ambiguous', 'plan', [field], { field }));
      else patch[step.from] = (inverse[0] as typeof inverse[number]).from;
      continue;
    }
    const tuple = exactTuple(value, step.resultFields.length, field, undefined, 'plan');
    if (!tuple.success) { issues.push(...tuple.issues); continue; }
    const matches = (rows[step.through.relationId] ?? []).filter((candidate) => fieldsMatch(candidate, step.resultFields, tuple.value));
    if (matches.length !== 1) { issues.push(lensIssue(matches.length === 0 ? 'lens.lookup_missing' : 'lens.lookup_ambiguous', 'plan', [field], { field, matches: matches.length })); continue; }
    const sourceValues = step.sourceFields.map((sourceField) => matches[0]?.[sourceField]).filter((candidate): candidate is PortableValue => candidate !== undefined);
    if (sourceValues.length !== step.sourceFields.length) { issues.push(lensIssue('lens.lookup_result_missing', 'plan', [field], { field })); continue; }
    patch[step.from] = sourceValues.length === 1 ? sourceValues[0] as PortableValue : sourceValues;
  }
  return issues.length > 0 ? { success: false, issues } : { success: true, value: patch, issues: [] };
};

const exactTuple = (value: PortableValue, length: number, field: string, rowIndex?: number, phase: 'query' | 'plan' = 'query'): ParseResult<readonly PortableValue[]> => {
  if (length === 1) return { success: true, value: [value], issues: [] };
  if (!Array.isArray(value) || value.length !== length) return lensFailure('lens.lookup_arity', phase, [field], { field, rowIndex, expected: length, actual: Array.isArray(value) ? value.length : 'non_tuple' });
  return { success: true, value, issues: [] };
};
const fieldsMatch = (row: RelationRow, fields: readonly string[], tuple: readonly PortableValue[]): boolean => fields.every((field, index) => Object.hasOwn(row, field) && sameValue(row[field] as PortableValue, tuple[index] as PortableValue));
const sameValue = (left: PortableValue, right: PortableValue): boolean => canonicalizeJson(left as JsonValue) === canonicalizeJson(right as JsonValue);
const sameRef = (left: ArtifactRef | undefined, right: ArtifactRef): boolean => left !== undefined && refKey(left) === refKey(right);
const refKey = (ref: ArtifactRef): string => JSON.stringify(normalizeArtifactRef(ref));
const isArtifactRef = (value: unknown): value is ArtifactRef => isRecord(value) && typeof value.id === 'string' && typeof value.contentHash === 'string';
const isLensStep = (value: unknown): value is LensStep => {
  if (!isRecord(value) || typeof value.kind !== 'string') return false;
  if (value.kind === 'lens.field') return typeof value.from === 'string' && typeof value.to === 'string' && (value.write === 'invertible' || value.write === 'read-only');
  if (value.kind === 'lens.default') return typeof value.to === 'string' && Object.hasOwn(value, 'value') && isPortable(value.value) && value.write === 'preserve';
  if (value.kind === 'lens.hide') return typeof value.from === 'string' && value.write === 'preserve';
  if (value.kind === 'lens.value-map') return typeof value.from === 'string' && typeof value.to === 'string' && Array.isArray(value.cases) && value.cases.every((candidate) => isRecord(candidate) && Object.hasOwn(candidate, 'from') && Object.hasOwn(candidate, 'to') && isPortable(candidate.from) && isPortable(candidate.to) && (candidate.writeBack === 'to-from' || candidate.writeBack === 'same-only' || candidate.writeBack === 'reject')) && value.unmapped === 'reject';
  if (value.kind === 'lens.lookup') return typeof value.from === 'string' && typeof value.to === 'string' && isRecord(value.through) && typeof value.through.relationId === 'string' && isArtifactRef(value.through.schemaView) && stringArray(value.sourceFields) && stringArray(value.resultFields) && value.onMissing === 'reject' && value.onAmbiguous === 'reject' && (value.write === 'invertible' || value.write === 'read-only');
  return value.kind === 'extension' && isCapabilityRef(value.capability) && Object.hasOwn(value, 'payload') && isPortable(value.payload);
};
const isPortable = (value: unknown): value is PortableValue => safeParseJsonValue(value).success;
const isCapabilityRef = (value: unknown): value is CapabilityRef => isRecord(value) && typeof value.id === 'string' && typeof value.version === 'string' && typeof value.contractHash === 'string' && /^sha256:[0-9a-f]{64}$/.test(value.contractHash);
const stringArray = (value: unknown): value is readonly string[] => Array.isArray(value) && value.every((member) => typeof member === 'string');
const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> => value !== null && typeof value === 'object' && !Array.isArray(value);

const lensIssue = (code: string, phase: 'parse' | 'query' | 'plan', path: readonly unknown[], details?: unknown, requiredCapabilities?: readonly CapabilityRef[], retry: 'after_input' | 'after_capability' = requiredCapabilities === undefined ? 'after_input' : 'after_capability', severity: 'warning' | 'error' = 'error'): Issue => createIssue({ code, phase, severity, retry, path, ...(details === undefined ? {} : { details }), ...(requiredCapabilities === undefined ? {} : { requiredCapabilities }) });
const lensFailure = (code: string, phase: 'parse' | 'query' | 'plan', path: readonly unknown[], details?: unknown, requiredCapabilities?: readonly CapabilityRef[], retry?: 'after_input' | 'after_capability'): ParseResult<never> => ({ success: false, issues: [lensIssue(code, phase, path, details, requiredCapabilities, retry)] });
const rejected = (code: string, phase: 'query' | 'plan', details?: unknown): LensResolution => ({ outcome: 'rejected', issues: [lensIssue(code, phase, [], details)] });
