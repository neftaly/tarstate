import { capabilityRefKey, createIssue, type CapabilityRef, type Issue } from './issues.js';
import { assertPreparedExpression } from './internal-prepared-expression.js';
import { detachAndFreezeJsonValue } from './internal-owned-json.js';
import {
  adoptExpressionScope,
  adoptFunctionRegistry,
  adoptJsonRecord,
  adoptJsonValue,
  cloneAndFreezeExpression,
  isOwnedQueryLogicalContainer,
  sealOwnedQueryLogicalContainer
} from './internal-query-ownership.js';
import { compareQueryJsonValues, compareQueryJsonValuesTotal, containsQueryLogicalUnknown } from './internal-query-values.js';
import type { Expr, FunctionRegistry, PreparedExpression, QueryFunction, QueryLogicalValue, QueryNode, QueryRecord, Completeness } from './query-model.js';
import {
  capabilityUnavailable,
  logicalAnd,
  logicalNot,
  logicalOr,
  logicalUnknown,
  missingValue,
  type EvaluationValue,
  type JsonValue,
  type LogicalTruth
} from './value.js';

export type QueryExpressionProvenance = {
  readonly sourceId?: string;
  readonly key?: JsonValue;
};

export type QueryExpressionRow = {
  readonly scope: Readonly<Record<string, QueryRecord>>;
  readonly provenance: Readonly<Record<string, QueryExpressionProvenance>>;
};

export type QueryExpressionResult =
  | { readonly status: 'known'; readonly value: JsonValue }
  | { readonly status: 'missing' | 'unknown' | 'indeterminate' | 'unavailable' };

export type QueryExpressionRuntime = {
  consumeWork(state: unknown): boolean;
  evaluateSubquery(state: unknown, node: QueryNode, outer: QueryExpressionRow): {
    readonly rows: readonly QueryRecord[];
    readonly completeness: Completeness;
    readonly unavailable: boolean;
  };
  markUnavailable(state: unknown): void;
};

export type QueryExpressionContext = {
  readonly row: QueryExpressionRow;
  readonly parameters: Readonly<Record<string, JsonValue>>;
  readonly functions: FunctionRegistry;
  readonly issues: Issue[];
  readonly runtime?: QueryExpressionRuntime;
  readonly runtimeState?: unknown;
};

const knownTrue: QueryExpressionResult = Object.freeze({ status: 'known', value: true });
const knownFalse: QueryExpressionResult = Object.freeze({ status: 'known', value: false });
const knownNull: QueryExpressionResult = Object.freeze({ status: 'known', value: null });
const knownObjects = new WeakMap<object, QueryExpressionResult>();
const knownLiterals = new WeakMap<object, QueryExpressionResult>();
const expressionFieldEntries = new WeakMap<object, readonly (readonly [string, Expr])[]>();

const legacyCapabilityRefKey = (ref: CapabilityRef): string =>
  ref.id + '\u0000' + ref.version + '\u0000' + ref.contractHash;

const missingQueryFunction = Symbol('missing-query-function');
const queryFunctions = new WeakMap<object, WeakMap<object, QueryFunction | typeof missingQueryFunction>>();

const resolveQueryFunction = (functions: FunctionRegistry, ref: CapabilityRef): QueryFunction | undefined =>
  functions.get(capabilityRefKey(ref))
  ?? (ref.id.includes('\u0000') || ref.version.includes('\u0000') || ref.contractHash.includes('\u0000')
    ? undefined
    : functions.get(legacyCapabilityRefKey(ref)));

const queryFunction = (functions: FunctionRegistry, ref: CapabilityRef): QueryFunction | undefined => {
  let byReference = queryFunctions.get(functions as object);
  if (byReference === undefined) {
    byReference = new WeakMap<object, QueryFunction | typeof missingQueryFunction>();
    queryFunctions.set(functions as object, byReference);
  }
  const cached = byReference.get(ref as object);
  if (cached !== undefined) return cached === missingQueryFunction ? undefined : cached;
  const resolved = resolveQueryFunction(functions, ref);
  byReference.set(ref as object, resolved ?? missingQueryFunction);
  return resolved;
};

const publicExpressionValue = (result: QueryExpressionResult): EvaluationValue => {
  if (result.status === 'known') return adoptJsonValue(result.value, 'Query expression result');
  if (result.status === 'missing') return missingValue;
  if (result.status === 'unknown' || result.status === 'indeterminate') return logicalUnknown;
  return capabilityUnavailable;
};

/** Evaluates one expression using Tarstate missing/unknown three-valued semantics. */
export const evaluateExpression = (
  expression: Expr,
  row: Readonly<Record<string, QueryRecord>>,
  options: { readonly parameters?: Readonly<Record<string, JsonValue>>; readonly functions?: FunctionRegistry } = {}
): EvaluationValue => {
  const issues: Issue[] = [];
  const ownedExpression = cloneAndFreezeExpression(expression);
  const scoped: QueryExpressionRow = { scope: adoptExpressionScope(row), provenance: {} };
  const parameters = options.parameters === undefined ? {} : adoptJsonRecord(options.parameters, 'Query expression parameters');
  return publicExpressionValue(evaluateQueryExpression(ownedExpression, {
    row: scoped,
    parameters,
    functions: options.functions === undefined ? new Map() : adoptFunctionRegistry(options.functions),
    issues
  }));
};

/** Evaluates a sealed expression while adopting every changing input frame. */
export const evaluatePreparedExpression = (
  prepared: PreparedExpression,
  row: Readonly<Record<string, QueryRecord>>,
  options: { readonly parameters?: Readonly<Record<string, JsonValue>>; readonly functions?: FunctionRegistry } = {}
): EvaluationValue => {
  assertPreparedExpression(prepared);
  const issues: Issue[] = [];
  const scoped: QueryExpressionRow = { scope: adoptExpressionScope(row), provenance: {} };
  const parameters = options.parameters === undefined ? {} : adoptJsonRecord(options.parameters, 'Query expression parameters');
  return publicExpressionValue(evaluateQueryExpression(prepared.expression, {
    row: scoped,
    parameters,
    functions: options.functions === undefined ? new Map() : adoptFunctionRegistry(options.functions),
    issues
  }));
};

export const evaluateQueryExpression = (expression: Expr, context: QueryExpressionContext): QueryExpressionResult => {
  if (context.runtime !== undefined && !context.runtime.consumeWork(context.runtimeState)) return { status: 'unavailable' };
  if (expression.kind === 'literal') {
    const cached = knownLiterals.get(expression);
    if (cached !== undefined) return cached;
    const result = knownExpression(expression.value);
    knownLiterals.set(expression, result);
    return result;
  }
  if (expression.kind === 'parameter') return Object.hasOwn(context.parameters, expression.name) ? knownExpression(context.parameters[expression.name] as JsonValue) : { status: 'missing' };
  if (expression.kind === 'field') {
    const record = context.row.scope[expression.alias];
    if (record === undefined || !Object.hasOwn(record, expression.name)) return { status: 'missing' };
    const value = record[expression.name] as QueryLogicalValue;
    return value === logicalUnknown ? { status: 'unknown' } : knownExpression(value as JsonValue);
  }
  if (expression.kind === 'key-of' || expression.kind === 'source-of') {
    const provenance = context.row.provenance[expression.alias];
    if (provenance === undefined) return { status: 'missing' };
    const value = expression.kind === 'key-of' ? provenance.key : provenance.sourceId;
    return value === undefined ? { status: 'missing' } : knownExpression(value);
  }
  if (expression.kind === 'is-null' || expression.kind === 'is-missing') {
    const value = evaluateQueryExpression(expression.value, context);
    if (value.status === 'unavailable' || value.status === 'indeterminate') return value;
    if (expression.kind === 'is-missing') return knownExpression(value.status === 'missing');
    if (value.status === 'unknown') return value;
    return knownExpression(value.status === 'known' && value.value === null);
  }
  if (expression.kind === 'compare') {
    const left = evaluateQueryExpression(expression.left, context);
    const right = evaluateQueryExpression(expression.right, context);
    const unavailable = propagateExpression(left, right);
    if (unavailable !== undefined) return unavailable;
    if (left.status !== 'known' || right.status !== 'known' || left.value === null || right.value === null) return { status: 'unknown' };
    if (expression.op === 'eq' || expression.op === 'ne') {
      const equal = compareQueryJsonValuesTotal(left.value, right.value) === 0;
      return knownExpression(expression.op === 'eq' ? equal : !equal);
    }
    const comparison = compareQueryJsonValues(left.value, right.value);
    if (comparison === undefined) return { status: 'unknown' };
    return knownExpression(expression.op === 'lt' ? comparison < 0 : expression.op === 'lte' ? comparison <= 0 : expression.op === 'gt' ? comparison > 0 : comparison >= 0);
  }
  if (expression.kind === 'boolean') {
    if (expression.op === 'not') {
      const value = evaluateQueryExpression(expression.arg, context);
      if (value.status === 'unavailable' || value.status === 'indeterminate') return value;
      const truth = value.status === 'known' && typeof value.value === 'boolean' ? value.value : logicalUnknown;
      const result = logicalNot(truth);
      return result === logicalUnknown ? { status: 'unknown' } : knownExpression(result);
    }
    const values = expression.args.map((argument) => evaluateQueryExpression(argument, context));
    if (values.some((value) => value.status === 'unavailable')) return { status: 'unavailable' };
    const truths = values.map((value): LogicalTruth => value.status === 'known' && typeof value.value === 'boolean' ? value.value : logicalUnknown);
    const result = expression.op === 'and' ? logicalAnd(truths) : logicalOr(truths);
    return result === logicalUnknown ? values.some((value) => value.status === 'indeterminate') ? { status: 'indeterminate' } : { status: 'unknown' } : knownExpression(result);
  }
  if (expression.kind === 'arithmetic') {
    const left = evaluateQueryExpression(expression.left, context);
    const right = evaluateQueryExpression(expression.right, context);
    const propagated = propagateExpression(left, right);
    if (propagated !== undefined) return propagated;
    if (left.status !== 'known' || right.status !== 'known' || typeof left.value !== 'number' || typeof right.value !== 'number') return { status: 'unknown' };
    if ((expression.op === 'divide' || expression.op === 'modulo') && right.value === 0) return { status: 'unknown' };
    const value = expression.op === 'add' ? left.value + right.value : expression.op === 'subtract' ? left.value - right.value : expression.op === 'multiply' ? left.value * right.value : expression.op === 'divide' ? left.value / right.value : left.value % right.value;
    return Number.isFinite(value) ? knownExpression(value) : { status: 'unknown' };
  }
  if (expression.kind === 'string') {
    const args = expression.args.map((argument) => evaluateQueryExpression(argument, context));
    if (args.some((value) => value.status === 'unavailable')) return { status: 'unavailable' };
    if (args.some((value) => value.status === 'indeterminate')) return { status: 'indeterminate' };
    if (args.some((value) => value.status !== 'known' || typeof value.value !== 'string')) return { status: 'unknown' };
    const strings = args.map((value) => (value as { readonly status: 'known'; readonly value: string }).value);
    if (expression.op === 'concat') return knownExpression(strings.join(''));
    const value = strings[0]!;
    return knownExpression(expression.op === 'lower' ? value.toLowerCase() : expression.op === 'upper' ? value.toUpperCase() : Array.from(value).length);
  }
  if (expression.kind === 'array') {
    const values = expression.items.map((item) => evaluateQueryExpression(item, context));
    if (values.some((value) => value.status === 'unavailable')) return { status: 'unavailable' };
    if (values.some((value) => value.status === 'indeterminate')) return { status: 'indeterminate' };
    if (values.some((value) => value.status !== 'known')) return { status: 'unknown' };
    return knownExpression(sealOwnedQueryLogicalContainer(Object.freeze(
      values.map((value) => (value as { readonly status: 'known'; readonly value: JsonValue }).value)
    )));
  }
  if (expression.kind === 'record') {
    const fields = projectExpressionFields(expression.fields, context);
    return Object.values(fields).some((value) => containsQueryLogicalUnknown(value)) ? { status: 'unknown' } : knownExpression(fields as JsonValue);
  }
  if (expression.kind === 'case') {
    for (const branch of expression.branches) {
      const condition = evaluateQueryExpression(branch.when, context);
      if (condition.status === 'unavailable' || condition.status === 'indeterminate') return condition;
      if (condition.status === 'known' && condition.value === true) return evaluateQueryExpression(branch.then, context);
    }
    return evaluateQueryExpression(expression.otherwise, context);
  }
  if (expression.kind === 'coalesce') {
    for (const argument of expression.args) {
      const value = evaluateQueryExpression(argument, context);
      if (value.status === 'unavailable' || value.status === 'indeterminate') return value;
      if (value.status === 'unknown') return value;
      if (value.status === 'known' && value.value !== null) return value;
    }
    return knownExpression(null);
  }
  if (expression.kind === 'subquery') {
    if (context.runtime === undefined) return { status: 'unavailable' };
    const result = context.runtime.evaluateSubquery(context.runtimeState, expression.query, context.row);
    if (result.unavailable) {
      context.runtime.markUnavailable(context.runtimeState);
      return { status: 'unavailable' };
    }
    if (result.completeness === 'unknown') return { status: 'indeterminate' };
    if (expression.mode === 'exists') return result.rows.length > 0 ? knownExpression(true) : result.completeness === 'exact' ? knownExpression(false) : { status: 'indeterminate' };
    if (result.completeness !== 'exact') return { status: 'indeterminate' };
    if (result.rows.length !== 1) {
      context.issues.push(createIssue({ code: 'query.scalar_subquery_cardinality', phase: 'query', severity: 'error', retry: 'after_input', details: { rows: result.rows.length } }));
      return { status: 'unknown' };
    }
    const values = Object.values(result.rows[0] as QueryRecord);
    if (values.length !== 1) {
      context.issues.push(createIssue({ code: 'query.scalar_subquery_cardinality', phase: 'query', severity: 'error', retry: 'after_input', details: { fields: values.length } }));
      return { status: 'unknown' };
    }
    return values[0] === logicalUnknown ? { status: 'unknown' } : knownExpression(values[0] as JsonValue);
  }
  if (expression.kind === 'call') {
    const fn = queryFunction(context.functions, expression.capability);
    if (fn === undefined) {
      context.issues.push(createIssue({ code: 'query.capability_unavailable', retry: 'after_capability', requiredCapabilities: [expression.capability] }));
      return { status: 'unavailable' };
    }
    const args: JsonValue[] = [];
    for (const argument of expression.args) {
      const value = evaluateQueryExpression(argument, context);
      if (value.status === 'unavailable') return { status: 'unavailable' };
      if (value.status !== 'known') return { status: 'unknown' };
      args.push(value.value);
    }
    try {
      const returned = fn(Object.freeze(args));
      if (returned === null || typeof returned === 'string' || typeof returned === 'boolean') return knownExpression(returned);
      if (typeof returned === 'number') {
        if (!Number.isFinite(returned)) throw new TypeError('Query function returned a non-portable number');
        return knownExpression(returned);
      }
      if (isOwnedQueryLogicalContainer(returned)) return knownExpression(returned);
      const parsed = detachAndFreezeJsonValue(returned);
      if (!parsed.success) throw new TypeError('Query function returned a non-portable value: ' + parsed.issues.map(({ code }) => code).join(', '));
      return knownExpression(parsed.value);
    } catch (error) {
      context.issues.push(createIssue({ code: 'query.function_failed', phase: 'query', severity: 'error', retry: 'after_input', requiredCapabilities: [expression.capability], details: { error: error instanceof Error ? error.name : typeof error } }));
      return { status: 'unavailable' };
    }
  }
  return assertNever(expression);
};

export const knownExpression = (value: JsonValue): QueryExpressionResult => {
  if (value === true) return knownTrue;
  if (value === false) return knownFalse;
  if (value === null) return knownNull;
  if (typeof value !== 'object' || !Object.isFrozen(value)) return { status: 'known', value };
  const cached = knownObjects.get(value);
  if (cached !== undefined) return cached;
  const result: QueryExpressionResult = { status: 'known', value };
  knownObjects.set(value, result);
  return result;
};

const propagateExpression = (...values: readonly QueryExpressionResult[]): QueryExpressionResult | undefined =>
  values.some((value) => value.status === 'unavailable') ? { status: 'unavailable' }
    : values.some((value) => value.status === 'indeterminate') ? { status: 'indeterminate' }
      : values.some((value) => value.status === 'unknown') ? { status: 'unknown' }
        : undefined;

export const expressionJson = (result: QueryExpressionResult): JsonValue => result.status === 'known' ? result.value : null;

const cachedExpressionFieldEntries = (fields: Readonly<Record<string, Expr>>): readonly (readonly [string, Expr])[] => {
  const cached = expressionFieldEntries.get(fields);
  if (cached !== undefined) return cached;
  const entries = Object.entries(fields);
  expressionFieldEntries.set(fields, entries);
  return entries;
};

const projectLeafExpression = (
  expression: Expr,
  context: QueryExpressionContext
): QueryLogicalValue | undefined => {
  if (context.runtime !== undefined && !context.runtime.consumeWork(context.runtimeState)) {
    context.runtime.markUnavailable(context.runtimeState);
    return undefined;
  }
  if (expression.kind === 'literal') return expression.value;
  if (expression.kind === 'parameter') return context.parameters[expression.name];
  if (expression.kind === 'field') {
    const record = context.row.scope[expression.alias];
    return record?.[expression.name];
  }
  if (expression.kind === 'key-of' || expression.kind === 'source-of') {
    const provenance = context.row.provenance[expression.alias];
    return expression.kind === 'key-of' ? provenance?.key : provenance?.sourceId;
  }
  return undefined;
};

export const projectExpressionFields = (fields: Readonly<Record<string, Expr>>, context: QueryExpressionContext): QueryRecord => {
  const output: Record<string, QueryLogicalValue> = {};
  for (const [name, expression] of cachedExpressionFieldEntries(fields)) {
    if (expression.kind === 'literal' || expression.kind === 'parameter' || expression.kind === 'field' || expression.kind === 'key-of' || expression.kind === 'source-of') {
      const value = projectLeafExpression(expression, context);
      if (value !== undefined) output[name] = value;
      continue;
    }
    const result = evaluateQueryExpression(expression, context);
    if (result.status === 'known') output[name] = result.value;
    else if (result.status === 'unknown') output[name] = logicalUnknown;
    else if ((result.status === 'unavailable' || result.status === 'indeterminate') && context.runtime !== undefined) context.runtime.markUnavailable(context.runtimeState);
  }
  return sealOwnedQueryLogicalContainer(Object.freeze(output));
};

const assertNever = (value: never): never => {
  throw new TypeError('Unsupported query expression: ' + String(value));
};
