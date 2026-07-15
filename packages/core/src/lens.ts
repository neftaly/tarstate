import { canonicalizeJson, isContentHash, normalizeArtifactRef, type ArtifactRef } from './artifacts.js';
import { createIssue, type CapabilityRef, type Issue, type ParseResult } from './issues.js';
import { detachAndFreezeJsonValue } from './internal-owned-json.js';
import { assertValidatedLens, assertValidatedLensSteps, sealValidatedLens } from './internal-semantic-provenance.js';
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
declare const validatedLensBrand: unique symbol;
declare const validatedLensStepsBrand: unique symbol;
/**
 * A detached, immutable lens relation whose steps have passed `validateLens`.
 * Obtain this type through `validateLens`; it is not an authoring input type.
 */
export type ValidatedLensSteps = readonly LensStep[] & { readonly [validatedLensStepsBrand]: true };
export type ValidatedLensRelation = Omit<LensRelation, 'steps'> & { readonly steps: ValidatedLensSteps };
/** A detached, immutable schema lens accepted by projection and edit translation. */
export type ValidatedSchemaLensBody = Omit<SchemaLensBody, 'relations'> & {
  readonly relations: readonly ValidatedLensRelation[];
  readonly [validatedLensBrand]: true;
};
/** Sealed portable schema-lens artifact with its typed body preserved. */
export type SchemaLensArtifact = TypedArtifact<'schema-lens', SchemaLensBody>;
/** A schema-lens artifact whose body has passed `validateLens`. */
export type ValidatedSchemaLensArtifact = Omit<SchemaLensArtifact, 'body'> & { readonly body: ValidatedSchemaLensBody };
/** Seals a typed schema lens without a `JsonValue` assertion at the call site. */
export const sealSchemaLens = (input: TypedArtifactInput<SchemaLensBody>): Promise<SchemaLensArtifact> => sealTypedArtifact('schema-lens', input);
export type LensArtifact = { readonly ref: ArtifactRef; readonly body: ValidatedSchemaLensBody };
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
    assertValidatedLens(candidate.body);
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
    return sameRef(cursor, to) ? resolved(path) : rejected('lens.path_missing', 'plan', { reason: 'selected_path_target' });
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
  return resolved(paths[0] as LensArtifact[]);
};

export const validateLens = (input: unknown): ParseResult<ValidatedSchemaLensBody> => {
  const owned = detachAndFreezeJsonValue(input);
  if (!owned.success) return owned;
  if (!isRecord(owned.value) || !hasOnlyKeys(owned.value, ['from', 'to', 'relations']) || !isArtifactRef(owned.value.from) || !isArtifactRef(owned.value.to) || !Array.isArray(owned.value.relations)) return lensFailure('lens.invalid', 'parse', [], { reason: 'shape' });
  const body = owned.value as unknown as SchemaLensBody;
  const issues: Issue[] = [];
  body.relations.forEach((relation, relationIndex) => {
    if (!isRecord(relation) || !hasOnlyKeys(relation, ['fromRelationId', 'toRelationId', 'steps']) || typeof relation.fromRelationId !== 'string' || relation.fromRelationId.length === 0 || typeof relation.toRelationId !== 'string' || relation.toRelationId.length === 0 || !Array.isArray(relation.steps)) {
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
  return issues.length > 0
    ? { success: false, issues }
    : { success: true, value: sealValidatedLens<ValidatedSchemaLensBody>(body as unknown as Omit<ValidatedSchemaLensBody, symbol>), issues: [] };
};

export const projectLensRelation = (lens: ValidatedSchemaLensBody, relationId: RelationId, rows: LensRows): LensProjection => {
  assertValidatedLens(lens);
  const ownedRows = detachAndFreezeJsonValue(rows);
  if (!ownedRows.success) return Object.freeze({ rows: Object.freeze([]), rejected: Object.freeze([]), issues: Object.freeze([lensIssue('lens.input_invalid', 'query', [], { reason: 'rows' })]), completeness: 'unknown' });
  const safeRows = ownedRows.value as LensRows;
  const relation = lens.relations.find((candidate) => candidate.toRelationId === relationId);
  if (relation === undefined) return Object.freeze({ rows: Object.freeze([]), rejected: Object.freeze([]), issues: Object.freeze([lensIssue('lens.relation_missing', 'query', [], { relationId })]), completeness: 'unknown' });
  const projected: RelationRow[] = [];
  const rejectedRows: { rowIndex: number; row: RelationRow }[] = [];
  const issues: Issue[] = [];
  const lookupIndexes = createLookupIndexes(relation.steps, safeRows, 'source');
  (safeRows[relation.fromRelationId] ?? []).forEach((row, rowIndex) => {
    const result = projectOwnedLensCandidate(relation.steps, row, safeRows, rowIndex, lookupIndexes);
    if (result.success) { projected.push(result.value); issues.push(...result.issues); }
    else {
      rejectedRows.push(Object.freeze({ rowIndex, row }));
      issues.push(...result.issues);
    }
  });
  return Object.freeze({ rows: Object.freeze(projected), rejected: Object.freeze(rejectedRows), issues: Object.freeze(issues), completeness: rejectedRows.length === 0 ? 'exact' : 'unknown' });
};

export const projectLensCandidate = (
  steps: ValidatedLensSteps,
  row: RelationRow,
  rows: LensRows,
  rowIndex?: number
): ParseResult<RelationRow> => {
  assertValidatedLensSteps(steps);
  const ownedRow = detachAndFreezeJsonValue(row);
  const ownedRows = detachAndFreezeJsonValue(rows);
  if (!ownedRow.success || !ownedRows.success) return lensFailure('lens.input_invalid', 'query', [], { reason: !ownedRow.success ? 'row' : 'rows' });
  const safeRows = ownedRows.value as LensRows;
  return projectOwnedLensCandidate(steps, ownedRow.value as RelationRow, safeRows, rowIndex, createLookupIndexes(steps, safeRows, 'source'));
};

const projectOwnedLensCandidate = (
  steps: ValidatedLensSteps,
  row: RelationRow,
  rows: LensRows,
  rowIndex?: number,
  lookupIndexes?: LookupIndexes
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
    const matches = lookupMatches(step, tuple.value, rows, step.sourceFields, lookupIndexes);
    if (matches.length !== 1) return lensFailure(matches.length === 0 ? 'lens.lookup_missing' : 'lens.lookup_ambiguous', 'query', [step.from], { field: step.to, rowIndex, matches: matches.length });
    const values = step.resultFields.map((field) => matches[0]?.[field]).filter((value): value is PortableValue => value !== undefined);
    if (values.length !== step.resultFields.length) return lensFailure('lens.lookup_result_missing', 'query', [step.to], { field: step.to, rowIndex });
    output[step.to] = values.length === 1 ? values[0] as PortableValue : Object.freeze(values);
  }
  return { success: true, value: Object.freeze(output) as RelationRow, issues: Object.freeze(issues) };
};

export const translateLensEdits = (
  lens: ValidatedSchemaLensBody,
  relationId: RelationId,
  storedRow: RelationRow,
  edits: Readonly<Record<string, PortableValue>>,
  rows: LensRows
): ParseResult<Readonly<Record<string, PortableValue>>> => {
  assertValidatedLens(lens);
  const ownedStoredRow = detachAndFreezeJsonValue(storedRow);
  const ownedEdits = detachAndFreezeJsonValue(edits);
  const ownedRows = detachAndFreezeJsonValue(rows);
  if (!ownedStoredRow.success || !ownedEdits.success || !ownedRows.success) return lensFailure('lens.input_invalid', 'plan', [], { reason: !ownedStoredRow.success ? 'stored_row' : !ownedEdits.success ? 'edits' : 'rows' });
  const safeStoredRow = ownedStoredRow.value as RelationRow;
  const safeEdits = ownedEdits.value as Readonly<Record<string, PortableValue>>;
  const safeRows = ownedRows.value as LensRows;
  const relation = lens.relations.find((candidate) => candidate.toRelationId === relationId);
  if (relation === undefined) return lensFailure('lens.relation_missing', 'plan', [], { relationId });
  const patch: Record<string, PortableValue> = {};
  const issues: Issue[] = [];
  const lookupIndexes = createLookupIndexes(relation.steps, safeRows, 'result');
  for (const [field, value] of Object.entries(safeEdits)) {
    const matching = relation.steps.filter((step): step is Exclude<LensStep, { readonly kind: 'extension' } | { readonly kind: 'lens.hide' }> => step.kind !== 'extension' && step.kind !== 'lens.hide' && step.to === field);
    if (matching.length !== 1) { issues.push(lensIssue(matching.length === 0 ? 'lens.field_not_writable' : 'lens.inverse_ambiguous', 'plan', [field], { field })); continue; }
    const step = matching[0] as typeof matching[number];
    if (step.kind === 'lens.default' || (step.kind === 'lens.field' && step.write === 'read-only') || (step.kind === 'lens.lookup' && step.write === 'read-only')) {
      issues.push(lensIssue('lens.field_not_writable', 'plan', [field], { field })); continue;
    }
    if (step.kind === 'lens.field') { patch[step.from] = value; continue; }
    if (step.kind === 'lens.value-map') {
      const current = step.cases.find((candidate) => Object.hasOwn(safeStoredRow, step.from) && sameValue(candidate.from, safeStoredRow[step.from] as PortableValue));
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
    const matches = lookupMatches(step, tuple.value, safeRows, step.resultFields, lookupIndexes);
    if (matches.length !== 1) { issues.push(lensIssue(matches.length === 0 ? 'lens.lookup_missing' : 'lens.lookup_ambiguous', 'plan', [field], { field, matches: matches.length })); continue; }
    const sourceValues = step.sourceFields.map((sourceField) => matches[0]?.[sourceField]).filter((candidate): candidate is PortableValue => candidate !== undefined);
    if (sourceValues.length !== step.sourceFields.length) { issues.push(lensIssue('lens.lookup_result_missing', 'plan', [field], { field })); continue; }
    patch[step.from] = sourceValues.length === 1 ? sourceValues[0] as PortableValue : Object.freeze(sourceValues);
  }
  if (issues.length > 0) return { success: false, issues };
  return { success: true, value: Object.freeze(patch), issues: [] };
};

type LookupStep = Extract<LensStep, { readonly kind: 'lens.lookup' }>;
type LookupIndexes = ReadonlyMap<LookupStep, ReadonlyMap<string, readonly RelationRow[]>>;

const createLookupIndexes = (
  steps: ValidatedLensSteps,
  rows: LensRows,
  fields: 'source' | 'result'
): LookupIndexes => {
  const indexes = new Map<LookupStep, ReadonlyMap<string, readonly RelationRow[]>>();
  for (const step of steps) {
    if (step.kind !== 'lens.lookup') continue;
    const keyFields = fields === 'source' ? step.sourceFields : step.resultFields;
    const buckets = new Map<string, RelationRow[]>();
    for (const row of rows[step.through.relationId] ?? []) {
      if (!keyFields.every((field) => Object.hasOwn(row, field))) continue;
      const key = canonicalizeJson(keyFields.map((field) => row[field] as JsonValue));
      const bucket = buckets.get(key);
      if (bucket === undefined) buckets.set(key, [row]);
      else bucket.push(row);
    }
    indexes.set(step, buckets);
  }
  return indexes;
};

const lookupMatches = (
  step: LookupStep,
  tuple: readonly PortableValue[],
  rows: LensRows,
  fields: readonly string[],
  indexes?: LookupIndexes
): readonly RelationRow[] => indexes?.get(step)?.get(canonicalizeJson(tuple as JsonValue))
  ?? (rows[step.through.relationId] ?? []).filter((candidate) => fieldsMatch(candidate, fields, tuple));

const exactTuple = (value: PortableValue, length: number, field: string, rowIndex?: number, phase: 'query' | 'plan' = 'query'): ParseResult<readonly PortableValue[]> => {
  if (length === 1) return { success: true, value: [value], issues: [] };
  if (!Array.isArray(value) || value.length !== length) return lensFailure('lens.lookup_arity', phase, [field], { field, rowIndex, expected: length, actual: Array.isArray(value) ? value.length : 'non_tuple' });
  return { success: true, value, issues: [] };
};
const fieldsMatch = (row: RelationRow, fields: readonly string[], tuple: readonly PortableValue[]): boolean => fields.every((field, index) => Object.hasOwn(row, field) && sameValue(row[field] as PortableValue, tuple[index] as PortableValue));
const sameValue = (left: PortableValue, right: PortableValue): boolean => left === right
  || canonicalizeJson(left as JsonValue) === canonicalizeJson(right as JsonValue);
const sameRef = (left: ArtifactRef | undefined, right: ArtifactRef): boolean => left !== undefined && refKey(left) === refKey(right);
const refKey = (ref: ArtifactRef): string => JSON.stringify(normalizeArtifactRef(ref));
const isArtifactRef = (value: unknown): value is ArtifactRef => isRecord(value) && hasOnlyKeys(value, ['id', 'contentHash', 'locations']) && typeof value.id === 'string' && value.id.length > 0 && isContentHash(value.contentHash) && (value.locations === undefined || (Array.isArray(value.locations) && value.locations.every((location) => typeof location === 'string' && location.length > 0)));
const isLensStep = (value: unknown): value is LensStep => {
  if (!isRecord(value) || typeof value.kind !== 'string') return false;
  if (value.kind === 'lens.field') return hasOnlyKeys(value, ['kind', 'from', 'to', 'write']) && nonempty(value.from) && nonempty(value.to) && (value.write === 'invertible' || value.write === 'read-only');
  if (value.kind === 'lens.default') return hasOnlyKeys(value, ['kind', 'to', 'value', 'write']) && nonempty(value.to) && Object.hasOwn(value, 'value') && isPortable(value.value) && value.write === 'preserve';
  if (value.kind === 'lens.hide') return hasOnlyKeys(value, ['kind', 'from', 'write']) && nonempty(value.from) && value.write === 'preserve';
  if (value.kind === 'lens.value-map') return hasOnlyKeys(value, ['kind', 'from', 'to', 'cases', 'unmapped']) && nonempty(value.from) && nonempty(value.to) && Array.isArray(value.cases) && value.cases.every((candidate) => isRecord(candidate) && hasOnlyKeys(candidate, ['from', 'to', 'writeBack']) && Object.hasOwn(candidate, 'from') && Object.hasOwn(candidate, 'to') && isPortable(candidate.from) && isPortable(candidate.to) && (candidate.writeBack === 'to-from' || candidate.writeBack === 'same-only' || candidate.writeBack === 'reject')) && value.unmapped === 'reject';
  if (value.kind === 'lens.lookup') return hasOnlyKeys(value, ['kind', 'from', 'to', 'through', 'sourceFields', 'resultFields', 'onMissing', 'onAmbiguous', 'write']) && nonempty(value.from) && nonempty(value.to) && isRecord(value.through) && hasOnlyKeys(value.through, ['schemaView', 'relationId']) && nonempty(value.through.relationId) && isArtifactRef(value.through.schemaView) && stringArray(value.sourceFields) && stringArray(value.resultFields) && value.onMissing === 'reject' && value.onAmbiguous === 'reject' && (value.write === 'invertible' || value.write === 'read-only');
  return value.kind === 'extension' && hasOnlyKeys(value, ['kind', 'capability', 'payload']) && isCapabilityRef(value.capability) && Object.hasOwn(value, 'payload') && isPortable(value.payload);
};
const isPortable = (value: unknown): value is PortableValue => safeParseJsonValue(value).success;
const isCapabilityRef = (value: unknown): value is CapabilityRef => isRecord(value) && hasOnlyKeys(value, ['id', 'version', 'contractHash']) && nonempty(value.id) && nonempty(value.version) && isContentHash(value.contractHash);
const stringArray = (value: unknown): value is readonly string[] => Array.isArray(value) && value.every(nonempty);
const nonempty = (value: unknown): value is string => typeof value === 'string' && value.length > 0;
const hasOnlyKeys = (value: Readonly<Record<string, unknown>>, allowed: readonly string[]): boolean => Object.keys(value).every((key) => allowed.includes(key));
const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> => value !== null && typeof value === 'object' && !Array.isArray(value);

const lensIssue = (code: string, phase: 'parse' | 'query' | 'plan', path: readonly unknown[], details?: unknown, requiredCapabilities?: readonly CapabilityRef[], retry: 'after_input' | 'after_capability' = requiredCapabilities === undefined ? 'after_input' : 'after_capability', severity: 'warning' | 'error' = 'error'): Issue => createIssue({ code, phase, severity, retry, path, ...(details === undefined ? {} : { details }), ...(requiredCapabilities === undefined ? {} : { requiredCapabilities }) });
const lensFailure = (code: string, phase: 'parse' | 'query' | 'plan', path: readonly unknown[], details?: unknown, requiredCapabilities?: readonly CapabilityRef[], retry?: 'after_input' | 'after_capability'): ParseResult<never> => ({ success: false, issues: [lensIssue(code, phase, path, details, requiredCapabilities, retry)] });
const rejected = (code: string, phase: 'query' | 'plan', details?: unknown): LensResolution => Object.freeze({ outcome: 'rejected', issues: Object.freeze([lensIssue(code, phase, [], details)]) });
const resolved = (path: readonly LensArtifact[]): LensResolution => Object.freeze({
  outcome: 'resolved',
  path: Object.freeze(path.map((artifact) => Object.freeze({ ref: Object.freeze({ ...normalizeArtifactRef(artifact.ref) }), body: artifact.body }))),
  issues: Object.freeze([])
});
