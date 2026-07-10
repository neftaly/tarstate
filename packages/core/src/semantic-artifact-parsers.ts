import {
  defaultArtifactParseBudget,
  safeParseArtifactText,
  safeParseArtifactValue,
  type Artifact,
  type ArtifactParseBudget,
  type ArtifactRef
} from './artifacts.js';
import { compileSourceConstraints, type ConstraintSetArtifact } from './constraint-artifact.js';
import type { SourceConstraint } from './constraints.js';
import { createIssue, TarstateParseError, type CapabilityRef, type Issue, type ParseResult } from './issues.js';
import { validateLens, type SchemaLensBody } from './lens.js';
import { compileStorageMapping, type CompiledStorageMapping, type StorageMappingBody } from './mapping.js';
import type { SourceBasis } from './maintenance.js';
import { evaluateQuery, prepareQuery, type FunctionRegistry, type QueryResult, type RelationInput } from './query.js';
import { safeParseQueryParameters, type QueryArtifact } from './query-builder.js';
import type { CapabilityRegistry } from './registry.js';
import type { PreparedSchema } from './schema.js';
import type { Transaction } from './transaction.js';
import type { JsonValue } from './value.js';

export type SemanticArtifactParseBudget = ArtifactParseBudget & {
  readonly maxSemanticDepth: number;
  readonly maxSemanticNodes: number;
  readonly maxIssues: number;
  readonly maxNames: number;
};

export const defaultSemanticArtifactParseBudget: SemanticArtifactParseBudget = {
  ...defaultArtifactParseBudget,
  maxSemanticDepth: 128,
  maxSemanticNodes: 100_000,
  maxIssues: 256,
  maxNames: 10_000
};

export type StorageMappingArtifact = Artifact & { readonly kind: 'storage-mapping'; readonly body: StorageMappingBody };
export type SchemaLensArtifact = Artifact & { readonly kind: 'schema-lens'; readonly body: SchemaLensBody };

type SemanticKind = 'query' | 'transaction' | 'constraint-set' | 'storage-mapping' | 'schema-lens';
type RecordValue = Readonly<Record<string, JsonValue>>;
type ValidationContext = {
  readonly family: SemanticKind;
  readonly budget: SemanticArtifactParseBudget;
  readonly issues: Issue[];
  nodes: number;
  budgetIssue: boolean;
};

export const safeParseQueryArtifact = (input: unknown, budget = defaultSemanticArtifactParseBudget): Promise<ParseResult<QueryArtifact>> =>
  safeParseTyped(input, 'query', validateQueryBody, budget);
export const safeParseTransactionArtifact = (input: unknown, budget = defaultSemanticArtifactParseBudget): Promise<ParseResult<Transaction>> =>
  safeParseTyped(input, 'transaction', validateTransactionBody, budget);
export const safeParseConstraintSetArtifact = (input: unknown, budget = defaultSemanticArtifactParseBudget): Promise<ParseResult<ConstraintSetArtifact>> =>
  safeParseTyped(input, 'constraint-set', validateConstraintSetBody, budget);
export const safeParseStorageMappingArtifact = (input: unknown, budget = defaultSemanticArtifactParseBudget): Promise<ParseResult<StorageMappingArtifact>> =>
  safeParseTyped(input, 'storage-mapping', validateStorageMappingBody, budget);
export const safeParseSchemaLensArtifact = (input: unknown, budget = defaultSemanticArtifactParseBudget): Promise<ParseResult<SchemaLensArtifact>> =>
  safeParseTyped(input, 'schema-lens', validateSchemaLensBody, budget);

export const parseQueryArtifact = async (input: unknown, budget?: SemanticArtifactParseBudget): Promise<QueryArtifact> => unwrap(await safeParseQueryArtifact(input, budget));
export const parseTransactionArtifact = async (input: unknown, budget?: SemanticArtifactParseBudget): Promise<Transaction> => unwrap(await safeParseTransactionArtifact(input, budget));
export const parseConstraintSetArtifact = async (input: unknown, budget?: SemanticArtifactParseBudget): Promise<ConstraintSetArtifact> => unwrap(await safeParseConstraintSetArtifact(input, budget));
export const parseStorageMappingArtifact = async (input: unknown, budget?: SemanticArtifactParseBudget): Promise<StorageMappingArtifact> => unwrap(await safeParseStorageMappingArtifact(input, budget));
export const parseSchemaLensArtifact = async (input: unknown, budget?: SemanticArtifactParseBudget): Promise<SchemaLensArtifact> => unwrap(await safeParseSchemaLensArtifact(input, budget));

export const safePrepareQueryArtifact = async (input: unknown, options: {
  readonly registryFingerprint: string;
  readonly authorityFingerprint: string;
  readonly datasetId: string;
  readonly budget?: SemanticArtifactParseBudget;
}): Promise<ParseResult<{ readonly artifact: QueryArtifact; readonly plan: Awaited<ReturnType<typeof prepareQuery>> }>> => {
  const parsed = await safeParseQueryArtifact(input, options.budget);
  if (!parsed.success) return parsed;
  try {
    const plan = await prepareQuery({ root: parsed.value.body.root, registryFingerprint: options.registryFingerprint, authorityFingerprint: options.authorityFingerprint, datasetId: options.datasetId });
    return { success: true, value: { artifact: parsed.value, plan }, issues: [] };
  } catch (error) {
    return semanticFailure('query', [], 'preparation_failed', { error: errorName(error) });
  }
};

/** Transaction execution remains source/coordinator-owned; preparation is total parsing and semantic validation. */
export const safePrepareTransactionArtifact = (input: unknown, budget?: SemanticArtifactParseBudget): Promise<ParseResult<Transaction>> =>
  safeParseTransactionArtifact(input, budget);

export const safeEvaluateQueryArtifact = async (input: unknown, request: {
  readonly relations: readonly RelationInput[];
  readonly parameters: unknown;
  readonly registry?: CapabilityRegistry;
  readonly functions?: FunctionRegistry;
  readonly basis?: JsonValue;
  readonly membershipRevision?: number;
  readonly budget?: SemanticArtifactParseBudget;
}): Promise<ParseResult<QueryResult>> => {
  const parsed = await safeParseQueryArtifact(input, request.budget);
  if (!parsed.success) return parsed;
  const parameters = safeParseQueryParameters(parsed.value.body.parameters, request.parameters, request.registry === undefined ? {} : { registry: request.registry });
  if (!parameters.success) return parameters;
  try {
    return {
      success: true,
      value: evaluateQuery({
        root: parsed.value.body.root,
        relations: request.relations,
        parameters: parameters.value as Readonly<Record<string, JsonValue>>,
        ...(request.functions === undefined ? {} : { functions: request.functions }),
        ...(request.basis === undefined ? {} : { basis: request.basis }),
        ...(request.membershipRevision === undefined ? {} : { membershipRevision: request.membershipRevision })
      }),
      issues: []
    };
  } catch (error) {
    return semanticFailure('query', [], 'execution_failed', { error: errorName(error) });
  }
};

export const safePrepareStorageMappingArtifact = async (input: unknown, options: {
  readonly schemaRef: ArtifactRef;
  readonly schema: PreparedSchema;
  readonly registry?: CapabilityRegistry;
  readonly budget?: SemanticArtifactParseBudget;
}): Promise<ParseResult<{ readonly artifact: StorageMappingArtifact; readonly compiled: CompiledStorageMapping }>> => {
  const parsed = await safeParseStorageMappingArtifact(input, options.budget);
  if (!parsed.success) return parsed;
  const compiled = compileStorageMapping(parsed.value.body, options.schemaRef, options.schema, options.registry);
  return compiled.success ? { success: true, value: { artifact: parsed.value, compiled: compiled.value }, issues: [] } : compiled;
};

export const safePrepareSchemaLensArtifact = async (input: unknown, budget?: SemanticArtifactParseBudget): Promise<ParseResult<SchemaLensArtifact>> => {
  const parsed = await safeParseSchemaLensArtifact(input, budget);
  if (!parsed.success) return parsed;
  const validated = validateLens(parsed.value.body);
  return validated.success ? parsed : validated;
};

export const safePrepareConstraintSetArtifact = async <State>(input: unknown, options: {
  readonly mode: 'audit' | 'required';
  /** Required executor capabilities must be present before a set can become active. */
  readonly registry?: CapabilityRegistry;
  readonly evaluateQuery: (query: JsonValue, state: State, basis: SourceBasis) => {
    readonly rows: readonly { readonly subject: JsonValue; readonly evidence?: JsonValue; readonly details?: JsonValue }[];
    readonly completeness: 'exact' | 'lower-bound' | 'unknown';
    readonly issues: readonly Issue[];
  };
  readonly budget?: SemanticArtifactParseBudget;
}): Promise<ParseResult<{ readonly artifact: ConstraintSetArtifact; readonly constraints: readonly SourceConstraint<State>[] }>> => {
  const parsed = await safeParseConstraintSetArtifact(input, options.budget);
  if (!parsed.success) return parsed;
  const missing = options.registry === undefined
    ? parsed.value.body.requiredCapabilities.map((required) => createIssue({ code: 'capability.missing', retry: 'after_capability', requiredCapabilities: [required] }))
    : options.registry.missing(parsed.value.body.requiredCapabilities);
  if (missing.length > 0) return { success: false, issues: missing };
  return { success: true, value: { artifact: parsed.value, constraints: compileSourceConstraints({ set: parsed.value, mode: options.mode, evaluateQuery: options.evaluateQuery }) }, issues: [] };
};

const safeParseTyped = async <Value extends Artifact>(
  input: unknown,
  kind: SemanticKind,
  validateBody: (context: ValidationContext, body: JsonValue, artifact: Artifact) => boolean,
  budget: SemanticArtifactParseBudget
): Promise<ParseResult<Value>> => {
  let parsed: ParseResult<Artifact>;
  try {
    parsed = typeof input === 'string' ? await safeParseArtifactText(input, budget) : await safeParseArtifactValue(input, budget);
  } catch (error) {
    return semanticFailure(kind, [], 'envelope_parser_failed', { error: errorName(error) });
  }
  if (!parsed.success) return parsed;
  if (parsed.value.kind !== kind) return semanticFailure(kind, ['kind'], 'kind_mismatch', { expected: kind, actual: parsed.value.kind });
  const context: ValidationContext = { family: kind, budget, issues: [], nodes: 0, budgetIssue: false };
  try {
    validateBody(context, parsed.value.body, parsed.value);
  } catch (error) {
    context.issues.push(semanticIssue(kind, [], 'validator_failed', { error: errorName(error) }));
  }
  return context.issues.length === 0 ? { success: true, value: parsed.value as Value, issues: [] } : { success: false, issues: context.issues };
};

const validateQueryBody = (context: ValidationContext, body: JsonValue): boolean => {
  if (!shape(context, body, ['schemaViews', 'parameters', 'root', 'requiredCapabilities'], [], ['body'])) return false;
  const value = body as RecordValue;
  const schemaViews = validateUniqueRefs(context, value.schemaViews, ['body', 'schemaViews']);
  const capabilities = validateUniqueCapabilities(context, value.requiredCapabilities, ['body', 'requiredCapabilities']);
  const parameterCapabilities = new Map<string, CapabilityUse>();
  const parameters = validateParameterDeclarations(context, value.parameters, ['body', 'parameters'], parameterCapabilities);
  const state: QueryValidationState = { parameters, schemaViews, requiredCapabilities: capabilities, usedCapabilities: new Map(), recursions: new Map() };
  validateQueryNode(context, value.root, ['body', 'root'], new Set(), state, 0);
  for (const [key, use] of parameterCapabilities) state.usedCapabilities.set(key, use);
  for (const [key, use] of state.usedCapabilities) if (!capabilities.has(key)) invalid(context, use.path, 'undeclared_capability', { capability: use.ref });
  return context.issues.length === 0;
};

type CapabilityUse = { readonly ref: CapabilityRef; readonly path: readonly unknown[] };
type QueryValidationState = {
  readonly parameters: ReadonlySet<string>;
  readonly schemaViews: ReadonlyMap<string, ArtifactRef>;
  readonly requiredCapabilities: ReadonlyMap<string, CapabilityRef>;
  readonly usedCapabilities: Map<string, CapabilityUse>;
  readonly recursions: Map<string, ReadonlySet<string>>;
};

const validateQueryNode = (
  context: ValidationContext,
  input: JsonValue | undefined,
  path: readonly unknown[],
  outer: ReadonlySet<string>,
  state: QueryValidationState,
  depth: number
): ReadonlySet<string> => {
  if (!enter(context, path, depth)) return new Set();
  if (!isRecord(input) || typeof input.kind !== 'string') { invalid(context, path, 'query_node_shape'); return new Set(); }
  const node = input;
  if (node.kind === 'from') {
    shape(context, node, ['kind', 'relation', 'alias'], [], path);
    const relation = validateRelationUse(context, node.relation, [...path, 'relation']);
    const alias = nonEmptyString(context, node.alias, [...path, 'alias']);
    if (relation !== undefined && state.schemaViews.get(refKey(relation.schemaView)) === undefined) invalid(context, [...path, 'relation', 'schemaView'], 'undeclared_schema_view');
    return alias === undefined ? new Set() : new Set([alias]);
  }
  if (node.kind === 'values') {
    shape(context, node, ['kind', 'alias', 'rows'], [], path);
    const alias = nonEmptyString(context, node.alias, [...path, 'alias']);
    if (!Array.isArray(node.rows) || node.rows.some((row) => !isRecord(row))) invalid(context, [...path, 'rows'], 'record_rows_required');
    return alias === undefined ? new Set() : new Set([alias]);
  }
  if (node.kind === 'recursion-ref') {
    shape(context, node, ['kind', 'name'], [], path);
    const name = nonEmptyString(context, node.name, [...path, 'name']);
    const aliases = name === undefined ? undefined : state.recursions.get(name);
    if (aliases === undefined) invalid(context, [...path, 'name'], 'recursion_reference_unbound');
    return aliases ?? new Set();
  }
  if (node.kind === 'recursive') {
    shape(context, node, ['kind', 'name', 'seed', 'step', 'key'], ['maxIterations', 'maxRows'], path);
    const name = nonEmptyString(context, node.name, [...path, 'name']);
    const seed = validateQueryNode(context, node.seed, [...path, 'seed'], outer, state, depth + 1);
    if (name !== undefined && state.recursions.has(name)) invalid(context, [...path, 'name'], 'duplicate_recursion_name');
    if (name !== undefined) state.recursions.set(name, seed);
    const step = validateQueryNode(context, node.step, [...path, 'step'], outer, state, depth + 1);
    if (name !== undefined) state.recursions.delete(name);
    if (!setEqual(seed, step)) invalid(context, [...path, 'step'], 'recursive_alias_shape_mismatch');
    validateExprArray(context, node.key, [...path, 'key'], union(outer, seed), state, depth + 1, false);
    optionalPositiveInteger(context, node.maxIterations, [...path, 'maxIterations']);
    optionalPositiveInteger(context, node.maxRows, [...path, 'maxRows']);
    return seed;
  }
  if (node.kind === 'join') {
    shape(context, node, ['kind', 'join', 'left', 'right'], ['on'], path);
    enumValue(context, node.join, ['inner', 'cross', 'left', 'semi', 'anti'], [...path, 'join']);
    const left = validateQueryNode(context, node.left, [...path, 'left'], outer, state, depth + 1);
    const right = validateQueryNode(context, node.right, [...path, 'right'], outer, state, depth + 1);
    const overlap = [...left].filter((alias) => right.has(alias));
    if (overlap.length > 0) invalid(context, path, 'duplicate_join_alias', { aliases: overlap });
    const scope = union(outer, left, right);
    if (node.join === 'cross' && node.on !== undefined) invalid(context, [...path, 'on'], 'cross_join_on_forbidden');
    if (node.join !== 'cross' && node.on === undefined) invalid(context, [...path, 'on'], 'join_condition_required');
    if (node.on !== undefined) validateExpr(context, node.on, [...path, 'on'], scope, state, depth + 1);
    return node.join === 'semi' || node.join === 'anti' ? left : union(left, right);
  }
  if (node.kind === 'set') {
    shape(context, node, ['kind', 'op', 'left', 'right'], [], path);
    enumValue(context, node.op, ['union', 'union-all', 'intersect', 'except'], [...path, 'op']);
    const left = validateQueryNode(context, node.left, [...path, 'left'], outer, state, depth + 1);
    validateQueryNode(context, node.right, [...path, 'right'], outer, state, depth + 1);
    return left;
  }
  if (!['where', 'select', 'with-fields', 'rename', 'omit', 'unnest', 'aggregate', 'distinct', 'order', 'slice', 'window', 'seek'].includes(node.kind as string)) {
    invalid(context, [...path, 'kind'], 'unknown_query_node', { kind: node.kind });
    return new Set();
  }
  const inputAliases = validateQueryNode(context, node.input, [...path, 'input'], outer, state, depth + 1);
  const scope = union(outer, inputAliases);
  if (node.kind === 'where') {
    shape(context, node, ['kind', 'input', 'predicate'], [], path); validateExpr(context, node.predicate, [...path, 'predicate'], scope, state, depth + 1); return inputAliases;
  }
  if (node.kind === 'select' || node.kind === 'with-fields') {
    shape(context, node, ['kind', 'input', 'alias', 'fields'], [], path);
    const alias = nonEmptyString(context, node.alias, [...path, 'alias']);
    validateExprRecord(context, node.fields, [...path, 'fields'], scope, state, depth + 1);
    if (node.kind === 'with-fields' && alias !== undefined && !inputAliases.has(alias)) invalid(context, [...path, 'alias'], 'alias_not_in_scope');
    return node.kind === 'select' ? (alias === undefined ? new Set() : new Set([alias])) : inputAliases;
  }
  if (node.kind === 'rename') {
    shape(context, node, ['kind', 'input', 'alias', 'fields'], [], path);
    const alias = nonEmptyString(context, node.alias, [...path, 'alias']);
    if (alias !== undefined && !inputAliases.has(alias)) invalid(context, [...path, 'alias'], 'alias_not_in_scope');
    if (!isRecord(node.fields) || Object.values(node.fields).some((name) => typeof name !== 'string' || name.length === 0)) invalid(context, [...path, 'fields'], 'string_map_required');
    else if (new Set(Object.values(node.fields)).size !== Object.keys(node.fields).length) invalid(context, [...path, 'fields'], 'duplicate_renamed_field');
    return inputAliases;
  }
  if (node.kind === 'omit') {
    shape(context, node, ['kind', 'input', 'alias', 'fields'], [], path);
    const alias = nonEmptyString(context, node.alias, [...path, 'alias']);
    if (alias !== undefined && !inputAliases.has(alias)) invalid(context, [...path, 'alias'], 'alias_not_in_scope');
    stringArray(context, node.fields, [...path, 'fields'], true);
    return inputAliases;
  }
  if (node.kind === 'unnest') {
    shape(context, node, ['kind', 'input', 'expression', 'alias', 'field'], [], path);
    validateExpr(context, node.expression, [...path, 'expression'], scope, state, depth + 1);
    const alias = nonEmptyString(context, node.alias, [...path, 'alias']);
    nonEmptyString(context, node.field, [...path, 'field']);
    if (alias !== undefined && inputAliases.has(alias)) invalid(context, [...path, 'alias'], 'duplicate_alias');
    return alias === undefined ? inputAliases : union(inputAliases, new Set([alias]));
  }
  if (node.kind === 'aggregate') {
    shape(context, node, ['kind', 'input', 'alias', 'groupBy', 'measures'], [], path);
    const alias = nonEmptyString(context, node.alias, [...path, 'alias']);
    validateExprRecord(context, node.groupBy, [...path, 'groupBy'], scope, state, depth + 1);
    if (!isRecord(node.measures)) invalid(context, [...path, 'measures'], 'record_required');
    else for (const [name, aggregate] of Object.entries(node.measures)) validateAggregate(context, aggregate, [...path, 'measures', name], scope, state, depth + 1);
    if (isRecord(node.groupBy) && isRecord(node.measures) && Object.keys(node.groupBy).some((name) => Object.hasOwn(node.measures as object, name))) invalid(context, path, 'duplicate_aggregate_output');
    return alias === undefined ? new Set() : new Set([alias]);
  }
  if (node.kind === 'distinct') { shape(context, node, ['kind', 'input'], [], path); return inputAliases; }
  if (node.kind === 'order') { shape(context, node, ['kind', 'input', 'by'], [], path); validateOrder(context, node.by, [...path, 'by'], scope, state, depth + 1); return inputAliases; }
  if (node.kind === 'slice') {
    shape(context, node, ['kind', 'input'], ['offset', 'limit'], path); optionalNonNegativeInteger(context, node.offset, [...path, 'offset']); optionalNonNegativeInteger(context, node.limit, [...path, 'limit']); return inputAliases;
  }
  if (node.kind === 'window') {
    shape(context, node, ['kind', 'input', 'alias', 'fields'], [], path);
    const alias = nonEmptyString(context, node.alias, [...path, 'alias']);
    if (alias !== undefined && !inputAliases.has(alias)) invalid(context, [...path, 'alias'], 'alias_not_in_scope');
    if (!isRecord(node.fields)) invalid(context, [...path, 'fields'], 'record_required');
    else for (const [name, window] of Object.entries(node.fields)) validateWindow(context, window, [...path, 'fields', name], scope, state, depth + 1);
    return inputAliases;
  }
  if (node.kind === 'seek') {
    shape(context, node, ['kind', 'input', 'by', 'after'], [], path); validateOrder(context, node.by, [...path, 'by'], scope, state, depth + 1); validateCursor(context, node.after, [...path, 'after']); return inputAliases;
  }
  return inputAliases;
};

const validateExpr = (context: ValidationContext, input: JsonValue | undefined, path: readonly unknown[], scope: ReadonlySet<string>, state: QueryValidationState, depth: number): void => {
  if (!enter(context, path, depth)) return;
  if (!isRecord(input) || typeof input.kind !== 'string') { invalid(context, path, 'expression_shape'); return; }
  const expression = input;
  if (expression.kind === 'literal') { shape(context, expression, ['kind', 'value'], [], path); return; }
  if (expression.kind === 'parameter') {
    shape(context, expression, ['kind', 'name'], [], path); const name = nonEmptyString(context, expression.name, [...path, 'name']);
    if (name !== undefined && !state.parameters.has(name)) invalid(context, [...path, 'name'], 'undeclared_parameter'); return;
  }
  if (expression.kind === 'field') { shape(context, expression, ['kind', 'alias', 'name'], [], path); validateAliasUse(context, expression.alias, scope, [...path, 'alias']); nonEmptyString(context, expression.name, [...path, 'name']); return; }
  if (expression.kind === 'key-of' || expression.kind === 'source-of') { shape(context, expression, ['kind', 'alias'], [], path); validateAliasUse(context, expression.alias, scope, [...path, 'alias']); return; }
  if (expression.kind === 'compare' || expression.kind === 'arithmetic') {
    shape(context, expression, ['kind', 'op', 'left', 'right'], [], path);
    enumValue(context, expression.op, expression.kind === 'compare' ? ['eq', 'ne', 'lt', 'lte', 'gt', 'gte'] : ['add', 'subtract', 'multiply', 'divide', 'modulo'], [...path, 'op']);
    validateExpr(context, expression.left, [...path, 'left'], scope, state, depth + 1); validateExpr(context, expression.right, [...path, 'right'], scope, state, depth + 1); return;
  }
  if (expression.kind === 'boolean') {
    if (expression.op === 'not') { shape(context, expression, ['kind', 'op', 'arg'], [], path); validateExpr(context, expression.arg, [...path, 'arg'], scope, state, depth + 1); }
    else { shape(context, expression, ['kind', 'op', 'args'], [], path); enumValue(context, expression.op, ['and', 'or'], [...path, 'op']); validateExprArray(context, expression.args, [...path, 'args'], scope, state, depth + 1, false); }
    return;
  }
  if (expression.kind === 'string') {
    shape(context, expression, ['kind', 'op', 'args'], [], path); enumValue(context, expression.op, ['concat', 'lower', 'upper', 'length'], [...path, 'op']); validateExprArray(context, expression.args, [...path, 'args'], scope, state, depth + 1, false);
    if (expression.op !== 'concat' && Array.isArray(expression.args) && expression.args.length !== 1) invalid(context, [...path, 'args'], 'string_operator_arity'); return;
  }
  if (expression.kind === 'array') { shape(context, expression, ['kind', 'items'], [], path); validateExprArray(context, expression.items, [...path, 'items'], scope, state, depth + 1, false); return; }
  if (expression.kind === 'record') { shape(context, expression, ['kind', 'fields'], [], path); validateExprRecord(context, expression.fields, [...path, 'fields'], scope, state, depth + 1); return; }
  if (expression.kind === 'case') {
    shape(context, expression, ['kind', 'branches', 'otherwise'], [], path);
    if (!Array.isArray(expression.branches) || expression.branches.length === 0) invalid(context, [...path, 'branches'], 'non_empty_array_required');
    else expression.branches.forEach((branch, index) => { const branchPath = [...path, 'branches', index]; if (shape(context, branch, ['when', 'then'], [], branchPath)) { validateExpr(context, (branch as RecordValue).when, [...branchPath, 'when'], scope, state, depth + 1); validateExpr(context, (branch as RecordValue).then, [...branchPath, 'then'], scope, state, depth + 1); } });
    validateExpr(context, expression.otherwise, [...path, 'otherwise'], scope, state, depth + 1); return;
  }
  if (expression.kind === 'coalesce') { shape(context, expression, ['kind', 'args'], [], path); validateExprArray(context, expression.args, [...path, 'args'], scope, state, depth + 1, true); return; }
  if (expression.kind === 'call') {
    shape(context, expression, ['kind', 'capability', 'args'], [], path); const ref = validateCapabilityRef(context, expression.capability, [...path, 'capability']);
    if (ref !== undefined) state.usedCapabilities.set(capabilityKey(ref), { ref, path: [...path, 'capability'] }); validateExprArray(context, expression.args, [...path, 'args'], scope, state, depth + 1, false); return;
  }
  if (expression.kind === 'subquery') {
    shape(context, expression, ['kind', 'mode', 'query'], [], path); enumValue(context, expression.mode, ['scalar', 'exists'], [...path, 'mode']); validateQueryNode(context, expression.query, [...path, 'query'], scope, state, depth + 1); return;
  }
  if (expression.kind === 'is-null' || expression.kind === 'is-missing') { shape(context, expression, ['kind', 'value'], [], path); validateExpr(context, expression.value, [...path, 'value'], scope, state, depth + 1); return; }
  invalid(context, [...path, 'kind'], 'unknown_expression', { kind: expression.kind });
};

const validateAggregate = (context: ValidationContext, input: JsonValue, path: readonly unknown[], scope: ReadonlySet<string>, state: QueryValidationState, depth: number): void => {
  if (!shape(context, input, ['kind', 'op'], ['value', 'orderBy'], path)) return;
  const aggregate = input as RecordValue;
  if (aggregate.kind !== 'aggregate') invalid(context, [...path, 'kind'], 'aggregate_kind');
  enumValue(context, aggregate.op, ['count', 'count-distinct', 'sum', 'average', 'minimum', 'maximum', 'any', 'every', 'collect', 'first', 'last'], [...path, 'op']);
  if (aggregate.op !== 'count' && aggregate.value === undefined) invalid(context, [...path, 'value'], 'aggregate_value_required');
  if (aggregate.value !== undefined) validateExpr(context, aggregate.value, [...path, 'value'], scope, state, depth + 1);
  if (aggregate.orderBy !== undefined) validateOrder(context, aggregate.orderBy, [...path, 'orderBy'], scope, state, depth + 1);
};

const validateWindow = (context: ValidationContext, input: JsonValue, path: readonly unknown[], scope: ReadonlySet<string>, state: QueryValidationState, depth: number): void => {
  if (!shape(context, input, ['kind', 'op', 'orderBy'], ['value', 'offset', 'partitionBy'], path)) return;
  const window = input as RecordValue;
  if (window.kind !== 'window') invalid(context, [...path, 'kind'], 'window_kind');
  enumValue(context, window.op, ['row-number', 'rank', 'lag'], [...path, 'op']);
  if (window.op === 'lag' && window.value === undefined) invalid(context, [...path, 'value'], 'lag_value_required');
  if (window.op !== 'lag' && (window.value !== undefined || window.offset !== undefined)) invalid(context, path, 'non_lag_value_or_offset');
  if (window.value !== undefined) validateExpr(context, window.value, [...path, 'value'], scope, state, depth + 1);
  optionalPositiveInteger(context, window.offset, [...path, 'offset']);
  if (window.partitionBy !== undefined) validateExprArray(context, window.partitionBy, [...path, 'partitionBy'], scope, state, depth + 1, false);
  validateOrder(context, window.orderBy, [...path, 'orderBy'], scope, state, depth + 1);
};

const validateOrder = (context: ValidationContext, input: JsonValue | undefined, path: readonly unknown[], scope: ReadonlySet<string>, state: QueryValidationState, depth: number): void => {
  if (!Array.isArray(input) || input.length === 0) { invalid(context, path, 'non_empty_array_required'); return; }
  input.forEach((term, index) => {
    const termPath = [...path, index]; if (!shape(context, term, ['value', 'direction'], ['nulls'], termPath)) return;
    const value = term as RecordValue; enumValue(context, value.direction, ['asc', 'desc'], [...termPath, 'direction']); if (value.nulls !== undefined) enumValue(context, value.nulls, ['first', 'last'], [...termPath, 'nulls']); validateExpr(context, value.value, [...termPath, 'value'], scope, state, depth + 1);
  });
};

const validateCursor = (context: ValidationContext, input: JsonValue | undefined, path: readonly unknown[]): void => {
  if (!shape(context, input, ['order', 'resultKey', 'basis', 'membershipRevision', 'mode'], [], path)) return;
  const cursor = input as RecordValue; if (!Array.isArray(cursor.order)) invalid(context, [...path, 'order'], 'array_required'); nonEmptyString(context, cursor.resultKey, [...path, 'resultKey']); nonNegativeInteger(context, cursor.membershipRevision, [...path, 'membershipRevision']); enumValue(context, cursor.mode, ['live', 'pinned'], [...path, 'mode']);
};

const validateTransactionBody = (context: ValidationContext, body: JsonValue): boolean => {
  if (!shape(context, body, ['schemaView', 'parameters', 'statements', 'guards', 'requiredCapabilities'], ['returning'], ['body'])) return false;
  const value = body as RecordValue;
  const schemaView = validateArtifactRef(context, value.schemaView, ['body', 'schemaView']);
  if (!isRecord(value.parameters)) invalid(context, ['body', 'parameters'], 'record_required');
  const parameters = new Set(isRecord(value.parameters) ? Object.keys(value.parameters) : []);
  checkNameBudget(context, parameters.size, ['body', 'parameters']);
  const capabilities = validateUniqueCapabilities(context, value.requiredCapabilities, ['body', 'requiredCapabilities']);
  const queryState: QueryValidationState = { parameters, schemaViews: new Map(schemaView === undefined ? [] : [[refKey(schemaView), schemaView]]), requiredCapabilities: capabilities, usedCapabilities: new Map(), recursions: new Map() };
  if (!Array.isArray(value.statements)) invalid(context, ['body', 'statements'], 'array_required');
  else value.statements.forEach((statement, index) => validateWriteStatement(context, statement, ['body', 'statements', index], schemaView, queryState, 0));
  if (!Array.isArray(value.guards)) invalid(context, ['body', 'guards'], 'array_required');
  else value.guards.forEach((guard, index) => validateGuard(context, guard, ['body', 'guards', index], value.statements, queryState));
  if (value.returning !== undefined) {
    if (!Array.isArray(value.returning)) invalid(context, ['body', 'returning'], 'array_required');
    else {
      const names = new Set<string>();
      value.returning.forEach((returning, index) => {
        const path = ['body', 'returning', index]; if (!shape(context, returning, ['name', 'root'], [], path)) return;
        const record = returning as RecordValue; const name = nonEmptyString(context, record.name, [...path, 'name']);
        if (name !== undefined && names.has(name)) invalid(context, [...path, 'name'], 'duplicate_returning_name'); else if (name !== undefined) names.add(name);
        validateQueryNode(context, record.root, [...path, 'root'], new Set(), queryState, 0);
      });
    }
  }
  for (const [key, use] of queryState.usedCapabilities) if (!capabilities.has(key)) invalid(context, use.path, 'undeclared_capability', { capability: use.ref });
  return context.issues.length === 0;
};

const validateWriteStatement = (context: ValidationContext, input: JsonValue, path: readonly unknown[], schemaView: ArtifactRef | undefined, state: QueryValidationState, depth: number): void => {
  if (!enter(context, path, depth)) return;
  if (!isRecord(input) || typeof input.kind !== 'string') { invalid(context, path, 'statement_shape'); return; }
  const statement = input;
  if (statement.kind === 'extension') { shape(context, statement, ['kind', 'capability', 'payload'], [], path); recordCapabilityUse(context, statement.capability, [...path, 'capability'], state); return; }
  if (statement.kind === 'statement.insert' || statement.kind === 'statement.upsert' || statement.kind === 'statement.replace-all') {
    shape(context, statement, ['kind', 'relation', 'rows'], statement.kind === 'statement.upsert' ? ['onConflict'] : [], path);
    validateWriteRelation(context, statement.relation, [...path, 'relation'], schemaView);
    validateWriteRows(context, statement.rows, [...path, 'rows'], state, depth + 1);
    if (statement.kind === 'statement.upsert') enumValue(context, statement.onConflict, ['reject', 'keep-existing', 'replace'], [...path, 'onConflict']); return;
  }
  if (statement.kind === 'statement.insert-from-query') {
    shape(context, statement, ['kind', 'relation', 'root'], [], path); validateWriteRelation(context, statement.relation, [...path, 'relation'], schemaView); validateQueryNode(context, statement.root, [...path, 'root'], new Set(), state, depth + 1); return;
  }
  if (statement.kind === 'statement.update') {
    shape(context, statement, ['kind', 'target', 'edits'], [], path); const aliases = validateWriteTarget(context, statement.target, [...path, 'target'], schemaView, state, depth + 1);
    if (!isRecord(statement.edits) || Object.keys(statement.edits).length === 0) invalid(context, [...path, 'edits'], 'non_empty_record_required');
    else for (const [name, edit] of Object.entries(statement.edits)) validateFieldEdit(context, edit, [...path, 'edits', name], aliases, state, depth + 1); return;
  }
  if (statement.kind === 'statement.delete') { shape(context, statement, ['kind', 'target'], [], path); validateWriteTarget(context, statement.target, [...path, 'target'], schemaView, state, depth + 1); return; }
  if (statement.kind === 'statement.rekey') {
    shape(context, statement, ['kind', 'target', 'key', 'references', 'requires'], [], path); const aliases = validateWriteTarget(context, statement.target, [...path, 'target'], schemaView, state, depth + 1); validateWriteExprRecord(context, statement.key, [...path, 'key'], aliases, state, depth + 1); enumValue(context, statement.references, ['source-local-declared', 'reject-if-referenced'], [...path, 'references']); recordCapabilityUse(context, statement.requires, [...path, 'requires'], state); return;
  }
  if (statement.kind === 'statement.move') {
    shape(context, statement, ['kind', 'target', 'parent', 'position', 'missingAnchor', 'requires'], [], path); const aliases = validateWriteTarget(context, statement.target, [...path, 'target'], schemaView, state, depth + 1); validateWriteExpr(context, statement.parent, [...path, 'parent'], aliases, state, depth + 1); validateMovePosition(context, statement.position, [...path, 'position'], aliases, state, depth + 1); enumValue(context, statement.missingAnchor, ['reject', 'beginning', 'end'], [...path, 'missingAnchor']); recordCapabilityUse(context, statement.requires, [...path, 'requires'], state); return;
  }
  invalid(context, [...path, 'kind'], 'unknown_statement', { kind: statement.kind });
};

const validateWriteRelation = (context: ValidationContext, input: JsonValue | undefined, path: readonly unknown[], schemaView: ArtifactRef | undefined): void => {
  if (!shape(context, input, ['relationId', 'schemaView'], [], path)) return; const relation = input as RecordValue; nonEmptyString(context, relation.relationId, [...path, 'relationId']); const ref = validateArtifactRef(context, relation.schemaView, [...path, 'schemaView']); if (ref !== undefined && schemaView !== undefined && refKey(ref) !== refKey(schemaView)) invalid(context, [...path, 'schemaView'], 'transaction_schema_mismatch');
};

const validateWriteTarget = (context: ValidationContext, input: JsonValue | undefined, path: readonly unknown[], schemaView: ArtifactRef | undefined, state: QueryValidationState, depth: number): ReadonlySet<string> => {
  if (!shape(context, input, ['relation', 'alias'], ['where'], path)) return new Set(); const target = input as RecordValue; validateWriteRelation(context, target.relation, [...path, 'relation'], schemaView); const alias = nonEmptyString(context, target.alias, [...path, 'alias']); const aliases = alias === undefined ? new Set<string>() : new Set([alias]); if (target.where !== undefined) validateWriteExpr(context, target.where, [...path, 'where'], aliases, state, depth + 1); return aliases;
};

const validateWriteRows = (context: ValidationContext, input: JsonValue | undefined, path: readonly unknown[], state: QueryValidationState, depth: number): void => {
  if (!Array.isArray(input)) { invalid(context, path, 'array_required'); return; } input.forEach((row, index) => validateWriteExprRecord(context, row, [...path, index], new Set(), state, depth + 1));
};

const validateWriteExprRecord = (context: ValidationContext, input: JsonValue | undefined, path: readonly unknown[], aliases: ReadonlySet<string>, state: QueryValidationState, depth: number): void => {
  if (!isRecord(input)) { invalid(context, path, 'record_required'); return; } for (const [name, expression] of Object.entries(input)) validateWriteExpr(context, expression, [...path, name], aliases, state, depth + 1);
};

const validateWriteExpr = (context: ValidationContext, input: JsonValue | undefined, path: readonly unknown[], aliases: ReadonlySet<string>, state: QueryValidationState, depth: number): void => {
  if (!enter(context, path, depth)) return;
  if (!isRecord(input) || typeof input.kind !== 'string') { invalid(context, path, 'write_expression_shape'); return; } const expression = input;
  if (expression.kind === 'literal') { shape(context, expression, ['kind', 'value'], [], path); return; }
  if (expression.kind === 'parameter') { shape(context, expression, ['kind', 'name'], [], path); const name = nonEmptyString(context, expression.name, [...path, 'name']); if (name !== undefined && !state.parameters.has(name)) invalid(context, [...path, 'name'], 'undeclared_parameter'); return; }
  if (expression.kind === 'field') { shape(context, expression, ['kind', 'alias', 'name'], [], path); validateAliasUse(context, expression.alias, aliases, [...path, 'alias']); nonEmptyString(context, expression.name, [...path, 'name']); return; }
  if (expression.kind === 'compare') { shape(context, expression, ['kind', 'op', 'left', 'right'], [], path); enumValue(context, expression.op, ['eq', 'ne', 'lt', 'lte', 'gt', 'gte'], [...path, 'op']); validateWriteExpr(context, expression.left, [...path, 'left'], aliases, state, depth + 1); validateWriteExpr(context, expression.right, [...path, 'right'], aliases, state, depth + 1); return; }
  if (expression.kind === 'boolean') {
    if (expression.op === 'not') { shape(context, expression, ['kind', 'op', 'arg'], [], path); validateWriteExpr(context, expression.arg, [...path, 'arg'], aliases, state, depth + 1); }
    else { shape(context, expression, ['kind', 'op', 'args'], [], path); enumValue(context, expression.op, ['and', 'or'], [...path, 'op']); if (!Array.isArray(expression.args)) invalid(context, [...path, 'args'], 'array_required'); else expression.args.forEach((arg, index) => validateWriteExpr(context, arg, [...path, 'args', index], aliases, state, depth + 1)); }
    return;
  }
  invalid(context, [...path, 'kind'], 'unknown_write_expression', { kind: expression.kind });
};

const validateFieldEdit = (context: ValidationContext, input: JsonValue, path: readonly unknown[], aliases: ReadonlySet<string>, state: QueryValidationState, depth: number): void => {
  if (!isRecord(input) || typeof input.kind !== 'string') { invalid(context, path, 'field_edit_shape'); return; } const edit = input;
  if (edit.kind === 'edit.replace') { shape(context, edit, ['kind', 'value'], [], path); validateWriteExpr(context, edit.value, [...path, 'value'], aliases, state, depth + 1); return; }
  if (edit.kind === 'edit.counter-increment') { shape(context, edit, ['kind', 'amount'], [], path); validateWriteExpr(context, edit.amount, [...path, 'amount'], aliases, state, depth + 1); return; }
  if (edit.kind === 'edit.text-splice') { shape(context, edit, ['kind', 'index', 'deleteCount', 'insert'], [], path); for (const name of ['index', 'deleteCount', 'insert']) validateWriteExpr(context, edit[name], [...path, name], aliases, state, depth + 1); return; }
  if (edit.kind === 'edit.list-splice') { shape(context, edit, ['kind', 'index', 'deleteCount', 'values', 'requires'], [], path); validateWriteExpr(context, edit.index, [...path, 'index'], aliases, state, depth + 1); validateWriteExpr(context, edit.deleteCount, [...path, 'deleteCount'], aliases, state, depth + 1); if (!Array.isArray(edit.values)) invalid(context, [...path, 'values'], 'array_required'); else edit.values.forEach((value, index) => validateWriteExpr(context, value, [...path, 'values', index], aliases, state, depth + 1)); recordCapabilityUse(context, edit.requires, [...path, 'requires'], state); return; }
  if (edit.kind === 'edit.conflict-resolve') { shape(context, edit, ['kind', 'observed', 'value'], [], path); if (!Array.isArray(edit.observed)) invalid(context, [...path, 'observed'], 'array_required'); validateWriteExpr(context, edit.value, [...path, 'value'], aliases, state, depth + 1); return; }
  if (edit.kind === 'extension') { shape(context, edit, ['kind', 'capability', 'payload'], [], path); recordCapabilityUse(context, edit.capability, [...path, 'capability'], state); return; }
  invalid(context, [...path, 'kind'], 'unknown_field_edit', { kind: edit.kind });
};

const validateMovePosition = (context: ValidationContext, input: JsonValue | undefined, path: readonly unknown[], aliases: ReadonlySet<string>, state: QueryValidationState, depth: number): void => {
  if (!isRecord(input) || typeof input.kind !== 'string') { invalid(context, path, 'move_position_shape'); return; } if (input.kind === 'beginning' || input.kind === 'end') { shape(context, input, ['kind'], [], path); return; } if (input.kind === 'before' || input.kind === 'after') { shape(context, input, ['kind', 'anchor'], [], path); validateWriteExpr(context, input.anchor, [...path, 'anchor'], aliases, state, depth + 1); return; } invalid(context, [...path, 'kind'], 'unknown_move_position');
};

const validateGuard = (context: ValidationContext, input: JsonValue, path: readonly unknown[], statements: JsonValue | undefined, state: QueryValidationState): void => {
  if (!isRecord(input) || typeof input.kind !== 'string') { invalid(context, path, 'guard_shape'); return; } const guard = input;
  if (guard.kind === 'guard.affected-count') { shape(context, guard, ['kind', 'statementIndex', 'count', 'op', 'value'], [], path); nonNegativeInteger(context, guard.statementIndex, [...path, 'statementIndex']); if (Number.isInteger(guard.statementIndex) && Array.isArray(statements) && (guard.statementIndex as number) >= statements.length) invalid(context, [...path, 'statementIndex'], 'statement_index_out_of_range'); enumValue(context, guard.count, ['matched', 'logicallyChanged', 'inserted', 'deleted'], [...path, 'count']); enumValue(context, guard.op, ['eq', 'gte', 'lte'], [...path, 'op']); nonNegativeInteger(context, guard.value, [...path, 'value']); return; }
  if (guard.kind === 'guard.query') { shape(context, guard, ['kind', 'root', 'expect'], [], path); enumValue(context, guard.expect, ['exists', 'empty'], [...path, 'expect']); validateQueryNode(context, guard.root, [...path, 'root'], new Set(), state, 0); return; }
  if (guard.kind === 'extension') { shape(context, guard, ['kind', 'capability', 'payload'], [], path); recordCapabilityUse(context, guard.capability, [...path, 'capability'], state); return; }
  invalid(context, [...path, 'kind'], 'unknown_guard');
};

const validateConstraintSetBody = (context: ValidationContext, body: JsonValue): boolean => {
  if (!shape(context, body, ['schemaView', 'constraints', 'requiredCapabilities'], [], ['body'])) return false; const value = body as RecordValue; const schema = validateArtifactRef(context, value.schemaView, ['body', 'schemaView']); const capabilities = validateUniqueCapabilities(context, value.requiredCapabilities, ['body', 'requiredCapabilities']); const state: QueryValidationState = { parameters: new Set(), schemaViews: new Map(schema === undefined ? [] : [[refKey(schema), schema]]), requiredCapabilities: capabilities, usedCapabilities: new Map(), recursions: new Map() };
  if (!Array.isArray(value.constraints)) invalid(context, ['body', 'constraints'], 'array_required');
  else {
    const ids = new Set<string>(); checkNameBudget(context, value.constraints.length, ['body', 'constraints']);
    value.constraints.forEach((constraint, index) => { const path = ['body', 'constraints', index]; if (!shape(context, constraint, ['id', 'code', 'dependencyRelations', 'violationQuery'], [], path)) return; const record = constraint as RecordValue; const id = nonEmptyString(context, record.id, [...path, 'id']); if (id !== undefined && ids.has(id)) invalid(context, [...path, 'id'], 'duplicate_constraint_id'); else if (id !== undefined) ids.add(id); nonEmptyString(context, record.code, [...path, 'code']); stringArray(context, record.dependencyRelations, [...path, 'dependencyRelations'], true); validateQueryNode(context, record.violationQuery, [...path, 'violationQuery'], new Set(), state, 0); });
  }
  for (const [key, use] of state.usedCapabilities) if (!capabilities.has(key)) invalid(context, use.path, 'undeclared_capability', { capability: use.ref });
  return context.issues.length === 0;
};

const validateStorageMappingBody = (context: ValidationContext, body: JsonValue): boolean => {
  if (!shape(context, body, ['schema', 'model', 'relations'], [], ['body'])) return false; const value = body as RecordValue; validateArtifactRef(context, value.schema, ['body', 'schema']); if (value.model !== 'json-tree-v1') invalid(context, ['body', 'model'], 'unsupported_mapping_model');
  if (!isRecord(value.relations)) invalid(context, ['body', 'relations'], 'record_required');
  else {
    checkNameBudget(context, Object.keys(value.relations).length, ['body', 'relations']);
    for (const [relationId, mapping] of Object.entries(value.relations)) {
      const path = ['body', 'relations', relationId]; if (relationId.length === 0 || !shape(context, mapping, ['collection', 'keys', 'fields'], [], path)) { if (relationId.length === 0) invalid(context, path, 'empty_relation_id'); continue; } const record = mapping as RecordValue; validateCollectionMapping(context, record.collection, [...path, 'collection']);
      if (!isRecord(record.keys)) invalid(context, [...path, 'keys'], 'record_required'); else for (const [name, key] of Object.entries(record.keys)) validateKeyMapping(context, key, [...path, 'keys', name]);
      if (!isRecord(record.fields)) invalid(context, [...path, 'fields'], 'record_required'); else for (const [name, field] of Object.entries(record.fields)) validateFieldMapping(context, field, [...path, 'fields', name]);
      if (isRecord(record.keys) && isRecord(record.fields)) for (const name of Object.keys(record.keys)) if (Object.hasOwn(record.fields, name)) invalid(context, path, 'key_field_mapped_twice', { field: name });
    }
  }
  return context.issues.length === 0;
};

const validateCollectionMapping = (context: ValidationContext, input: JsonValue | undefined, path: readonly unknown[]): void => {
  if (!shape(context, input, ['kind', 'path', 'absent'], [], path)) return; const value = input as RecordValue; enumValue(context, value.kind, ['object-map', 'array'], [...path, 'kind']); validateStoragePath(context, value.path, [...path, 'path']); enumValue(context, value.absent, ['empty', 'creatable', 'invalid'], [...path, 'absent']);
};
const validateKeyMapping = (context: ValidationContext, input: JsonValue, path: readonly unknown[]): void => {
  if (!isRecord(input) || typeof input.kind !== 'string') { invalid(context, path, 'key_mapping_shape'); return; } if (input.kind === 'map-key') { shape(context, input, ['kind', 'onMismatch'], ['mirrorPath'], path); if (input.onMismatch !== 'reject') invalid(context, [...path, 'onMismatch'], 'map_key_mismatch_policy'); if (input.mirrorPath !== undefined) validateStoragePath(context, input.mirrorPath, [...path, 'mirrorPath']); return; } if (input.kind === 'field') { shape(context, input, ['kind', 'path'], [], path); validateStoragePath(context, input.path, [...path, 'path']); return; } invalid(context, [...path, 'kind'], 'unknown_key_mapping');
};
const validateFieldMapping = (context: ValidationContext, input: JsonValue, path: readonly unknown[]): void => {
  if (!shape(context, input, ['path', 'write'], [], path)) return; const value = input as RecordValue; validateStoragePath(context, value.path, [...path, 'path']); if (!isRecord(value.write) || typeof value.write.kind !== 'string') { invalid(context, [...path, 'write'], 'write_mapping_shape'); return; } if (value.write.kind === 'read-only') shape(context, value.write, ['kind'], [], [...path, 'write']); else if (value.write.kind === 'replace') { shape(context, value.write, ['kind', 'capability'], [], [...path, 'write']); validateCapabilityRef(context, value.write.capability, [...path, 'write', 'capability']); } else invalid(context, [...path, 'write', 'kind'], 'unknown_write_mapping');
};
const validateStoragePath = (context: ValidationContext, input: JsonValue | undefined, path: readonly unknown[]): void => { if (!Array.isArray(input) || input.some((part) => !(typeof part === 'string' || (typeof part === 'number' && Number.isSafeInteger(part) && part >= 0)))) invalid(context, path, 'storage_path_invalid'); };

const validateSchemaLensBody = (context: ValidationContext, body: JsonValue): boolean => {
  if (!shape(context, body, ['from', 'to', 'relations'], [], ['body'])) return false; const value = body as RecordValue; validateArtifactRef(context, value.from, ['body', 'from']); validateArtifactRef(context, value.to, ['body', 'to']);
  if (!Array.isArray(value.relations)) invalid(context, ['body', 'relations'], 'array_required');
  else {
    const pairs = new Set<string>(); checkNameBudget(context, value.relations.length, ['body', 'relations']);
    value.relations.forEach((relation, index) => { const path = ['body', 'relations', index]; if (!shape(context, relation, ['fromRelationId', 'toRelationId', 'steps'], [], path)) return; const record = relation as RecordValue; const from = nonEmptyString(context, record.fromRelationId, [...path, 'fromRelationId']); const to = nonEmptyString(context, record.toRelationId, [...path, 'toRelationId']); if (from !== undefined && to !== undefined) { const pair = from + '\u0000' + to; if (pairs.has(pair)) invalid(context, path, 'duplicate_lens_relation'); else pairs.add(pair); } if (!Array.isArray(record.steps)) invalid(context, [...path, 'steps'], 'array_required'); else record.steps.forEach((step, stepIndex) => validateLensStep(context, step, [...path, 'steps', stepIndex])); });
  }
  if (context.issues.length === 0) { const validated = validateLens(body); if (!validated.success) context.issues.push(...validated.issues); }
  return context.issues.length === 0;
};

const validateLensStep = (context: ValidationContext, input: JsonValue, path: readonly unknown[]): void => {
  if (!isRecord(input) || typeof input.kind !== 'string') { invalid(context, path, 'lens_step_shape'); return; } const step = input;
  if (step.kind === 'lens.field') { shape(context, step, ['kind', 'from', 'to', 'write'], [], path); nonEmptyString(context, step.from, [...path, 'from']); nonEmptyString(context, step.to, [...path, 'to']); enumValue(context, step.write, ['invertible', 'read-only'], [...path, 'write']); return; }
  if (step.kind === 'lens.default') { shape(context, step, ['kind', 'to', 'value', 'write'], [], path); nonEmptyString(context, step.to, [...path, 'to']); if (step.write !== 'preserve') invalid(context, [...path, 'write'], 'default_write_policy'); return; }
  if (step.kind === 'lens.hide') { shape(context, step, ['kind', 'from', 'write'], [], path); nonEmptyString(context, step.from, [...path, 'from']); if (step.write !== 'preserve') invalid(context, [...path, 'write'], 'hide_write_policy'); return; }
  if (step.kind === 'lens.value-map') { shape(context, step, ['kind', 'from', 'to', 'cases', 'unmapped'], [], path); nonEmptyString(context, step.from, [...path, 'from']); nonEmptyString(context, step.to, [...path, 'to']); if (step.unmapped !== 'reject') invalid(context, [...path, 'unmapped'], 'unmapped_policy'); if (!Array.isArray(step.cases) || step.cases.length === 0) invalid(context, [...path, 'cases'], 'non_empty_array_required'); else step.cases.forEach((entry, index) => { const entryPath = [...path, 'cases', index]; if (shape(context, entry, ['from', 'to', 'writeBack'], [], entryPath)) enumValue(context, (entry as RecordValue).writeBack, ['to-from', 'same-only', 'reject'], [...entryPath, 'writeBack']); }); return; }
  if (step.kind === 'lens.lookup') { shape(context, step, ['kind', 'from', 'to', 'through', 'sourceFields', 'resultFields', 'onMissing', 'onAmbiguous', 'write'], [], path); nonEmptyString(context, step.from, [...path, 'from']); nonEmptyString(context, step.to, [...path, 'to']); validateRelationUse(context, step.through, [...path, 'through']); stringArray(context, step.sourceFields, [...path, 'sourceFields'], true); stringArray(context, step.resultFields, [...path, 'resultFields'], true); if (step.onMissing !== 'reject') invalid(context, [...path, 'onMissing'], 'lookup_missing_policy'); if (step.onAmbiguous !== 'reject') invalid(context, [...path, 'onAmbiguous'], 'lookup_ambiguous_policy'); enumValue(context, step.write, ['invertible', 'read-only'], [...path, 'write']); return; }
  if (step.kind === 'extension') { shape(context, step, ['kind', 'capability', 'payload'], [], path); validateCapabilityRef(context, step.capability, [...path, 'capability']); return; }
  invalid(context, [...path, 'kind'], 'unknown_lens_step');
};

const validateParameterDeclarations = (context: ValidationContext, input: JsonValue | undefined, path: readonly unknown[], capabilities: Map<string, CapabilityUse>): ReadonlySet<string> => {
  if (!isRecord(input)) { invalid(context, path, 'record_required'); return new Set(); } const names = Object.keys(input); checkNameBudget(context, names.length, path); for (const [name, declaration] of Object.entries(input)) { if (name.length === 0) invalid(context, [...path, name], 'empty_parameter_name'); validateValueDeclaration(context, declaration, [...path, name], 0, capabilities); } return new Set(names);
};

const validateValueDeclaration = (context: ValidationContext, input: JsonValue, path: readonly unknown[], depth: number, capabilities: Map<string, CapabilityUse>): void => {
  if (!enter(context, path, depth)) return;
  if (!isRecord(input) || typeof input.kind !== 'string') { invalid(context, path, 'value_declaration_shape'); return; } const declaration = input; const kind = declaration.kind as string;
  if (declaration.kind === 'array') { shape(context, declaration, ['kind', 'items'], [], path); validateValueDeclaration(context, declaration.items as JsonValue, [...path, 'items'], depth + 1, capabilities); return; }
  if (declaration.kind === 'tuple') { shape(context, declaration, ['kind', 'items'], [], path); if (!Array.isArray(declaration.items)) invalid(context, [...path, 'items'], 'array_required'); else declaration.items.forEach((item, index) => validateValueDeclaration(context, item, [...path, 'items', index], depth + 1, capabilities)); return; }
  if (declaration.kind === 'record') { shape(context, declaration, ['kind', 'fields'], ['optional'], path); if (!isRecord(declaration.fields)) invalid(context, [...path, 'fields'], 'record_required'); else for (const [name, field] of Object.entries(declaration.fields)) validateValueDeclaration(context, field, [...path, 'fields', name], depth + 1, capabilities); if (declaration.optional !== undefined) { const optional = stringArray(context, declaration.optional, [...path, 'optional'], true); if (optional !== undefined && isRecord(declaration.fields)) for (const name of optional) if (!Object.hasOwn(declaration.fields, name)) invalid(context, [...path, 'optional'], 'unknown_optional_field', { field: name }); } return; }
  if (declaration.kind === 'string') { shape(context, declaration, ['kind'], ['values'], path); if (declaration.values !== undefined) stringArray(context, declaration.values, [...path, 'values'], true); return; }
  if (['boolean', 'number', 'integer', 'decimal', 'bytes', 'json'].includes(kind)) { shape(context, declaration, ['kind'], [], path); return; }
  if (declaration.kind === 'instant') { shape(context, declaration, ['kind', 'precision'], [], path); enumValue(context, declaration.precision, ['millisecond', 'microsecond', 'nanosecond'], [...path, 'precision']); return; }
  if (declaration.kind === 'ref') { shape(context, declaration, ['kind', 'target'], [], path); if (shape(context, declaration.target, ['relationId'], [], [...path, 'target'])) nonEmptyString(context, (declaration.target as RecordValue).relationId, [...path, 'target', 'relationId']); return; }
  if (declaration.kind === 'custom') { shape(context, declaration, ['kind', 'codec'], [], path); const ref = validateCapabilityRef(context, declaration.codec, [...path, 'codec']); if (ref !== undefined) capabilities.set(capabilityKey(ref), { ref, path: [...path, 'codec'] }); return; }
  invalid(context, [...path, 'kind'], 'unknown_value_declaration');
};

const validateExprArray = (context: ValidationContext, input: JsonValue | undefined, path: readonly unknown[], scope: ReadonlySet<string>, state: QueryValidationState, depth: number, nonEmpty: boolean): void => { if (!Array.isArray(input) || (nonEmpty && input.length === 0)) { invalid(context, path, nonEmpty ? 'non_empty_array_required' : 'array_required'); return; } input.forEach((expression, index) => validateExpr(context, expression, [...path, index], scope, state, depth + 1)); };
const validateExprRecord = (context: ValidationContext, input: JsonValue | undefined, path: readonly unknown[], scope: ReadonlySet<string>, state: QueryValidationState, depth: number): void => { if (!isRecord(input)) { invalid(context, path, 'record_required'); return; } for (const [name, expression] of Object.entries(input)) validateExpr(context, expression, [...path, name], scope, state, depth + 1); };

const validateRelationUse = (context: ValidationContext, input: JsonValue | undefined, path: readonly unknown[]): { readonly schemaView: ArtifactRef; readonly relationId: string } | undefined => {
  if (!shape(context, input, ['schemaView', 'relationId'], [], path)) return undefined; const value = input as RecordValue; const schemaView = validateArtifactRef(context, value.schemaView, [...path, 'schemaView']); const relationId = nonEmptyString(context, value.relationId, [...path, 'relationId']); return schemaView === undefined || relationId === undefined ? undefined : { schemaView, relationId };
};

const validateUniqueRefs = (context: ValidationContext, input: JsonValue | undefined, path: readonly unknown[]): ReadonlyMap<string, ArtifactRef> => {
  const refs = new Map<string, ArtifactRef>(); if (!Array.isArray(input)) { invalid(context, path, 'array_required'); return refs; } checkNameBudget(context, input.length, path); input.forEach((candidate, index) => { const ref = validateArtifactRef(context, candidate, [...path, index]); if (ref === undefined) return; const key = refKey(ref); if (refs.has(key)) invalid(context, [...path, index], 'duplicate_artifact_ref'); else refs.set(key, ref); }); return refs;
};
const validateUniqueCapabilities = (context: ValidationContext, input: JsonValue | undefined, path: readonly unknown[]): ReadonlyMap<string, CapabilityRef> => {
  const refs = new Map<string, CapabilityRef>(); if (!Array.isArray(input)) { invalid(context, path, 'array_required'); return refs; } checkNameBudget(context, input.length, path); input.forEach((candidate, index) => { const ref = validateCapabilityRef(context, candidate, [...path, index]); if (ref === undefined) return; const key = capabilityKey(ref); if (refs.has(key)) invalid(context, [...path, index], 'duplicate_capability_ref'); else refs.set(key, ref); }); return refs;
};
const validateArtifactRef = (context: ValidationContext, input: JsonValue | undefined, path: readonly unknown[]): ArtifactRef | undefined => { if (!shape(context, input, ['id', 'contentHash'], ['locations'], path)) return undefined; const value = input as RecordValue; const id = nonEmptyString(context, value.id, [...path, 'id']); if (!hashValue(value.contentHash)) invalid(context, [...path, 'contentHash'], 'invalid_content_hash'); if (value.locations !== undefined && (!Array.isArray(value.locations) || value.locations.some((location) => typeof location !== 'string'))) invalid(context, [...path, 'locations'], 'string_array_required'); return id === undefined || !hashValue(value.contentHash) ? undefined : { id, contentHash: value.contentHash as `sha256:${string}`, ...(Array.isArray(value.locations) ? { locations: value.locations as string[] } : {}) }; };
const validateCapabilityRef = (context: ValidationContext, input: JsonValue | undefined, path: readonly unknown[]): CapabilityRef | undefined => { if (!shape(context, input, ['id', 'version', 'contractHash'], [], path)) return undefined; const value = input as RecordValue; const id = nonEmptyString(context, value.id, [...path, 'id']); const version = nonEmptyString(context, value.version, [...path, 'version']); if (!hashValue(value.contractHash)) invalid(context, [...path, 'contractHash'], 'invalid_contract_hash'); return id === undefined || version === undefined || !hashValue(value.contractHash) ? undefined : { id, version, contractHash: value.contractHash as `sha256:${string}` }; };
const recordCapabilityUse = (context: ValidationContext, input: JsonValue | undefined, path: readonly unknown[], state: QueryValidationState): void => { const ref = validateCapabilityRef(context, input, path); if (ref !== undefined) state.usedCapabilities.set(capabilityKey(ref), { ref, path }); };

const shape = (context: ValidationContext, input: JsonValue | undefined, required: readonly string[], optional: readonly string[], path: readonly unknown[]): input is RecordValue => {
  if (!isRecord(input)) { invalid(context, path, 'record_required'); return false; } const allowed = new Set([...required, ...optional]); for (const key of Object.keys(input)) if (!allowed.has(key)) invalid(context, [...path, key], 'unknown_member'); for (const key of required) if (!Object.hasOwn(input, key)) invalid(context, [...path, key], 'missing_member'); return true;
};
const isRecord = (value: unknown): value is RecordValue => value !== null && typeof value === 'object' && !Array.isArray(value);
const nonEmptyString = (context: ValidationContext, value: JsonValue | undefined, path: readonly unknown[]): string | undefined => { if (typeof value !== 'string' || value.length === 0) { invalid(context, path, 'non_empty_string_required'); return undefined; } return value; };
const enumValue = (context: ValidationContext, value: JsonValue | undefined, allowed: readonly string[], path: readonly unknown[]): void => { if (typeof value !== 'string' || !allowed.includes(value)) invalid(context, path, 'enum_value', { allowed }); };
const stringArray = (context: ValidationContext, value: JsonValue | undefined, path: readonly unknown[], unique: boolean): readonly string[] | undefined => { if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || item.length === 0)) { invalid(context, path, 'non_empty_string_array_required'); return undefined; } const output = value as string[]; if (unique && new Set(output).size !== output.length) invalid(context, path, 'duplicate_name'); return output; };
const optionalPositiveInteger = (context: ValidationContext, value: JsonValue | undefined, path: readonly unknown[]): void => { if (value !== undefined && (!Number.isSafeInteger(value) || (value as number) <= 0)) invalid(context, path, 'positive_integer_required'); };
const optionalNonNegativeInteger = (context: ValidationContext, value: JsonValue | undefined, path: readonly unknown[]): void => { if (value !== undefined) nonNegativeInteger(context, value, path); };
const nonNegativeInteger = (context: ValidationContext, value: JsonValue | undefined, path: readonly unknown[]): void => { if (!Number.isSafeInteger(value) || (value as number) < 0) invalid(context, path, 'non_negative_integer_required'); };
const validateAliasUse = (context: ValidationContext, value: JsonValue | undefined, aliases: ReadonlySet<string>, path: readonly unknown[]): void => { const alias = nonEmptyString(context, value, path); if (alias !== undefined && !aliases.has(alias)) invalid(context, path, 'alias_not_in_scope'); };
const enter = (context: ValidationContext, path: readonly unknown[], depth: number): boolean => { context.nodes += 1; if (depth > context.budget.maxSemanticDepth) { budgetIssue(context, path, 'maxSemanticDepth', context.budget.maxSemanticDepth); return false; } if (context.nodes > context.budget.maxSemanticNodes) { budgetIssue(context, path, 'maxSemanticNodes', context.budget.maxSemanticNodes); return false; } return true; };
const checkNameBudget = (context: ValidationContext, count: number, path: readonly unknown[]): void => { if (count > context.budget.maxNames) budgetIssue(context, path, 'maxNames', context.budget.maxNames); };
const budgetIssue = (context: ValidationContext, path: readonly unknown[], budget: string, limit: number): void => { if (context.budgetIssue) return; context.budgetIssue = true; context.issues.push(createIssue({ code: 'artifact.budget_exceeded', retry: 'after_input', path, details: { budget, limit } })); };
const invalid = (context: ValidationContext, path: readonly unknown[], reason: string, details: Readonly<Record<string, unknown>> = {}): void => { if (context.issues.length >= context.budget.maxIssues) { budgetIssue(context, path, 'maxIssues', context.budget.maxIssues); return; } context.issues.push(semanticIssue(context.family, path, reason, details)); };
const semanticIssue = (family: SemanticKind, path: readonly unknown[], reason: string, details: Readonly<Record<string, unknown>>): Issue => createIssue({ code: `${family}.artifact_invalid`, phase: 'parse', severity: 'error', retry: 'after_input', path, details: { reason, ...details } });
const semanticFailure = <Value>(family: SemanticKind, path: readonly unknown[], reason: string, details: Readonly<Record<string, unknown>>): ParseResult<Value> => ({ success: false, issues: [semanticIssue(family, path, reason, details)] });
const unwrap = <Value>(result: ParseResult<Value>): Value => { if (!result.success) throw new TarstateParseError(result.issues); return result.value; };
const errorName = (error: unknown): string => error instanceof Error ? error.name : typeof error;
const hashValue = (value: JsonValue | undefined): value is `sha256:${string}` => typeof value === 'string' && /^sha256:[0-9a-f]{64}$/.test(value);
const refKey = (ref: ArtifactRef): string => ref.id + '\u0000' + ref.contentHash;
const capabilityKey = (ref: CapabilityRef): string => ref.id + '\u0000' + ref.version + '\u0000' + ref.contractHash;
const union = <Value>(...sets: readonly ReadonlySet<Value>[]): Set<Value> => new Set(sets.flatMap((set) => [...set]));
const setEqual = <Value>(left: ReadonlySet<Value>, right: ReadonlySet<Value>): boolean => left.size === right.size && [...left].every((value) => right.has(value));
