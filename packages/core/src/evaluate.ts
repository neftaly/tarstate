import type { TarstateDiagnostic } from './diagnostics.js';
import { stableKey as stableRowKey } from './identity.js';
import type {
  ExprData,
  OptionalProjection,
  PredicateData,
  ProjectionData,
  Query,
  QueryData,
  SortData
} from './query.js';
import type { RelationLookup, RelationRangeBound, RelationRangeLookup, RelationSource } from './source.js';
import { isJsonValue, type FieldSpec, type RelationRef } from './schema.js';

/** Rows plus diagnostics returned by one query evaluation. */
export type QueryResult<Row> = {
  readonly rows: readonly Row[];
  readonly diagnostics: readonly TarstateDiagnostic[];
};

export type RuntimeFunction = (...args: readonly unknown[]) => unknown;
export type RuntimeFunctions = Readonly<Record<string, RuntimeFunction>>;
export type EvaluateEnv = Readonly<Record<string, unknown>>;
export type EvaluateOptions = {
  readonly functions?: RuntimeFunctions;
  readonly env?: EvaluateEnv;
};
type EvaluationRuntime = {
  readonly functions: RuntimeFunctions;
  readonly env: EvaluateEnv;
};

type Context = Record<string, unknown>;
type LookupJoinPlan = {
  readonly alias: string;
  readonly relation: RelationRef;
  readonly field: string;
  readonly value: ExprData;
  readonly rightAliases: readonly string[];
};
type ProjectionStep = {
  readonly fieldName: string;
  readonly expr: ExprData;
};
type AggregateStep = ProjectionStep;
type AggregateCallExpr = Extract<ExprData, { readonly op: 'aggregateCall' }>;
type FieldExpr = Extract<ExprData, { readonly op: 'field' }>;
type LookupSourcePlan = {
  readonly alias: string;
  readonly relation: RelationRef;
  readonly field: string;
};
type RangeConstraint = {
  readonly field: FieldExpr;
  readonly lower?: RelationRangeBound;
  readonly upper?: RelationRangeBound;
};
type ComparableRangeValue = number | string;
type RowPlan = {
  readonly relationRef: RelationRef;
  readonly fields: readonly (readonly [string, FieldSpec])[];
  readonly keyFields: readonly string[];
};
/**
 * Evaluate a query once against a source.
 *
 * @remarks Always async so sync and async sources share one call shape.
 *
 * @example `const result = await evaluate(source, query)`
 */
export async function evaluate<Row>(
  source: RelationSource,
  query: Query<Row>,
  options: EvaluateOptions = {}
): Promise<QueryResult<Row>> {
  const diagnostics: TarstateDiagnostic[] = [];
  const runtime = evaluationRuntimeFor(options);
  const contexts = await evaluateData(source, query.relations, query.data, diagnostics, runtime);

  if (source.diagnostics) {
    diagnostics.push(...(await collectDiagnostics(source)));
  }

  return {
    rows: contexts as Row[],
    diagnostics
  };
}

async function collectDiagnostics(source: RelationSource): Promise<TarstateDiagnostic[]> {
  try {
    return Array.from(await source.diagnostics?.() ?? []);
  } catch (error) {
    return [
      {
        code: 'source_error',
        message: 'source diagnostics failed',
        detail: error
      }
    ];
  }
}

function evaluationRuntimeFor(options: EvaluateOptions): EvaluationRuntime {
  return {
    functions: options.functions === undefined
      ? builtinRuntimeFunctions
      : { ...builtinRuntimeFunctions, ...options.functions },
    env: options.env ?? {}
  };
}

async function evaluateData(
  source: RelationSource,
  relations: Record<string, RelationRef>,
  data: QueryData,
  diagnostics: TarstateDiagnostic[],
  runtime: EvaluationRuntime,
  scope: Context = {}
): Promise<unknown[]> {
  switch (data.op) {
    case 'from':
      return evaluateFrom(source, relationFor(relations, data.relation), data.alias, diagnostics);
    case 'lookup':
      return evaluateExplicitLookup(source, relations, data, diagnostics, runtime, scope);
    case 'constRows':
      return data.rows.map((row) => ({ ...row }));
    case 'where':
      return evaluateWhere(source, relations, data, diagnostics, runtime, scope);
    case 'keyBy':
      return evaluateData(source, relations, data.input, diagnostics, runtime, scope);
    case 'hash':
    case 'btree':
      return evaluateData(source, relations, data.input, diagnostics, runtime, scope);
    case 'join':
      return evaluateJoin(source, relations, data, diagnostics, runtime, scope);
    case 'select': {
      const projection = projectionPlan(data.projection);
      const inputRows = await evaluateData(source, relations, data.input, diagnostics, runtime, scope);
      const output: Record<string, unknown>[] = [];

      for (const context of inputRows) {
        output.push(await evaluateProjection(source, relations, context as Context, projection, diagnostics, runtime, scope));
      }

      return output;
    }
    case 'extend': {
      const projection = projectionPlan(data.projection);
      const inputRows = await evaluateData(source, relations, data.input, diagnostics, runtime, scope);

      return Promise.all(inputRows.map(async (row) => ({
        ...(row as Context),
        ...await evaluateProjection(source, relations, row as Context, projection, diagnostics, runtime, scope)
      })));
    }
    case 'expand': {
      const inputRows = await evaluateData(source, relations, data.input, diagnostics, runtime, scope);
      return evaluateExpand(source, relations, inputRows as Context[], data, diagnostics, runtime, scope);
    }
    case 'without': {
      const inputRows = await evaluateData(source, relations, data.input, diagnostics, runtime, scope);

      return inputRows.map((row) => omitFields(row as Context, data.fields));
    }
    case 'sort': {
      const inputRows = await evaluateData(source, relations, data.input, diagnostics, runtime, scope);
      return sortRows(source, relations, inputRows as Context[], data.order, diagnostics, runtime, scope);
    }
    case 'limit': {
      const inputRows = await evaluateData(source, relations, data.input, diagnostics, runtime, scope);
      const offset = data.offset ?? 0;
      return inputRows.slice(offset, offset + data.count);
    }
    case 'sortLimit': {
      const inputRows = await evaluateData(source, relations, data.input, diagnostics, runtime, scope);
      return (await sortRows(source, relations, inputRows as Context[], data.order, diagnostics, runtime, scope)).slice(0, data.count);
    }
    case 'union':
      return evaluateUnion(source, relations, data.inputs, diagnostics, runtime, scope);
    case 'intersection':
      return evaluateIntersection(source, relations, data.inputs, diagnostics, runtime, scope);
    case 'difference': {
      const leftRows = await evaluateData(source, relations, data.left, diagnostics, runtime, scope);
      const rightRows = await evaluateData(source, relations, data.right, diagnostics, runtime, scope);
      const rightKeys = new Set(rightRows.map(stableRowKey));

      return leftRows.filter((row) => !rightKeys.has(stableRowKey(row)));
    }
    case 'rename': {
      const inputRows = await evaluateData(source, relations, data.input, diagnostics, runtime, scope);

      return inputRows.map((row) => renameFields(row as Context, data.fields));
    }
    case 'qualify': {
      const inputRows = await evaluateData(source, relations, data.input, diagnostics, runtime, scope);

      return inputRows.map((row) => ({ [data.alias]: row }));
    }
    case 'aggregate':
      return evaluateAggregate(source, relations, data, diagnostics, runtime, scope);
  }
}

async function evaluateFrom(
  source: RelationSource,
  relationRef: RelationRef,
  alias: string,
  diagnostics: TarstateDiagnostic[]
): Promise<Context[]> {
  const rows = await readRows(source, relationRef, diagnostics);
  return rowsToContexts(rows, alias, relationRef, diagnostics);
}

async function evaluateExplicitLookup(
  source: RelationSource,
  relations: Record<string, RelationRef>,
  data: Extract<QueryData, { op: 'lookup' }>,
  diagnostics: TarstateDiagnostic[],
  runtime: EvaluationRuntime,
  scope: Context
): Promise<Context[]> {
  const relation = relationFor(relations, data.relation);
  const value = await evaluateExpr(source, relations, {}, data.value, diagnostics, runtime, scope);

  if (source.lookup !== undefined) {
    const lookupRows = await readLookup(source, { relation, field: data.field, value }, diagnostics);

    if (lookupRows !== undefined) {
      return rowsToContexts(lookupRows, data.alias, relation, diagnostics);
    }
  }

  const rows = await readRows(source, relation, diagnostics);
  const contexts = rowsToContexts(rows, data.alias, relation, diagnostics);

  return contexts.filter((context) => evaluateField(context, scope, data.alias, data.field) === value);
}

async function evaluateWhere(
  source: RelationSource,
  relations: Record<string, RelationRef>,
  data: Extract<QueryData, { op: 'where' }>,
  diagnostics: TarstateDiagnostic[],
  runtime: EvaluationRuntime,
  scope: Context
): Promise<unknown[]> {
  const plannedLookup = lookupForWhere(relations, data);

  if (plannedLookup !== undefined && source.lookup !== undefined) {
    const lookupRows = await readLookup(source, plannedLookup.lookup, diagnostics);
    if (lookupRows !== undefined) {
      return rowsToContexts(lookupRows, plannedLookup.alias, plannedLookup.lookup.relation, diagnostics);
    }
  }

  const plannedRangeLookup = rangeLookupForWhere(relations, data);

  if (plannedRangeLookup !== undefined && source.rangeLookup !== undefined) {
    const lookupRows = await readRangeLookup(source, plannedRangeLookup.lookup, diagnostics);
    if (lookupRows !== undefined) {
      const contexts = rowsToContexts(lookupRows, plannedRangeLookup.alias, plannedRangeLookup.lookup.relation, diagnostics);
      return filterContextsByPredicate(source, relations, contexts, data.predicate, diagnostics, runtime, scope);
    }
  }

  const inputRows = await evaluateData(source, relations, data.input, diagnostics, runtime, scope);
  const output: unknown[] = [];

  for (const context of inputRows) {
    if (await evaluatePredicate(source, relations, context as Context, data.predicate, diagnostics, runtime, scope)) {
      output.push(context);
    }
  }

  return output;
}

async function evaluateJoin(
  source: RelationSource,
  relations: Record<string, RelationRef>,
  data: Extract<QueryData, { op: 'join' }>,
  diagnostics: TarstateDiagnostic[],
  runtime: EvaluationRuntime,
  scope: Context
): Promise<Context[]> {
  const lookupRows = await evaluateLookupJoin(source, relations, data, diagnostics, runtime, scope);

  if (lookupRows !== undefined) {
    return lookupRows;
  }

  const leftRows = (await evaluateData(source, relations, data.left, diagnostics, runtime, scope)) as Context[];
  const rightRows = (await evaluateData(source, relations, data.right, diagnostics, runtime, scope)) as Context[];
  const output: Context[] = [];
  const rightAliases = aliasesFor(data.right);

  for (const leftRow of leftRows) {
    let matched = false;

    for (const rightRow of rightRows) {
      const combined = { ...leftRow, ...rightRow };

      if (await evaluatePredicate(source, relations, combined, data.on, diagnostics, runtime, scope)) {
        output.push(combined);
        matched = true;
      }
    }

    if (!matched && data.kind === 'left') {
      output.push(contextWithNullAliases(leftRow, rightAliases));
    }
  }

  return output;
}

async function evaluateLookupJoin(
  source: RelationSource,
  relations: Record<string, RelationRef>,
  data: Extract<QueryData, { op: 'join' }>,
  diagnostics: TarstateDiagnostic[],
  runtime: EvaluationRuntime,
  scope: Context
): Promise<Context[] | undefined> {
  const plan = lookupForJoin(relations, data);

  if (plan === undefined || source.lookup === undefined) {
    return undefined;
  }

  const planDiagnostics: TarstateDiagnostic[] = [];
  const leftRows = (await evaluateData(source, relations, data.left, planDiagnostics, runtime, scope)) as Context[];
  const output: Context[] = [];
  const rightRowPlan = rowPlanFor(plan.relation);

  for (const leftRow of leftRows) {
    const diagnosticsBeforeLookup = planDiagnostics.length;
    const lookupRows = await readLookup(
      source,
      {
        relation: plan.relation,
        field: plan.field,
        value: await evaluateExpr(source, relations, leftRow, plan.value, planDiagnostics, runtime, scope)
      },
      planDiagnostics
    );

    if (lookupRows === undefined) {
      diagnostics.push(...planDiagnostics.slice(diagnosticsBeforeLookup));
      return undefined;
    }

    let matched = false;
    const seenKeys = lookupRows.length > 1 ? new Set<string>() : undefined;

    for (const lookupRow of lookupRows) {
      const rightRow = rowForContext(lookupRow, rightRowPlan, seenKeys, planDiagnostics);

      if (rightRow === undefined) {
        continue;
      }

      output.push({ ...leftRow, [plan.alias]: rightRow });
      matched = true;
    }

    if (!matched && data.kind === 'left') {
      output.push(contextWithNullAliases(leftRow, plan.rightAliases));
    }
  }

  diagnostics.push(...planDiagnostics);
  return output;
}

async function evaluateUnion(
  source: RelationSource,
  relations: Record<string, RelationRef>,
  inputs: readonly QueryData[],
  diagnostics: TarstateDiagnostic[],
  runtime: EvaluationRuntime,
  scope: Context
): Promise<unknown[]> {
  const output: unknown[] = [];
  const seen = new Set<string>();

  for (const input of inputs) {
    const rows = await evaluateData(source, relations, input, diagnostics, runtime, scope);

    for (const row of rows) {
      const key = stableRowKey(row);

      if (!seen.has(key)) {
        seen.add(key);
        output.push(row);
      }
    }
  }

  return output;
}

async function evaluateIntersection(
  source: RelationSource,
  relations: Record<string, RelationRef>,
  inputs: readonly QueryData[],
  diagnostics: TarstateDiagnostic[],
  runtime: EvaluationRuntime,
  scope: Context
): Promise<unknown[]> {
  const [firstInput, ...restInputs] = inputs;

  if (firstInput === undefined) {
    return [];
  }

  const firstRows = await evaluateData(source, relations, firstInput, diagnostics, runtime, scope);
  const restKeySets = await Promise.all(
    restInputs.map(async (input) =>
      new Set((await evaluateData(source, relations, input, diagnostics, runtime, scope)).map(stableRowKey))
    )
  );
  const output: unknown[] = [];
  const seen = new Set<string>();

  for (const row of firstRows) {
    const key = stableRowKey(row);

    if (!seen.has(key) && restKeySets.every((keys) => keys.has(key))) {
      seen.add(key);
      output.push(row);
    }
  }

  return output;
}

async function evaluateAggregate(
  source: RelationSource,
  relations: Record<string, RelationRef>,
  data: Extract<QueryData, { op: 'aggregate' }>,
  diagnostics: TarstateDiagnostic[],
  runtime: EvaluationRuntime,
  scope: Context
): Promise<Record<string, unknown>[]> {
  const inputRows = (await evaluateData(source, relations, data.input, diagnostics, runtime, scope)) as Context[];
  const groupProjection = projectionPlan(data.groupBy);
  const aggregateProjection = projectionPlan(data.aggregates);
  const groups = new Map<string, { readonly group: Record<string, unknown>; readonly rows: Context[] }>();

  for (const row of inputRows) {
    const group = await evaluateProjection(source, relations, row, groupProjection, diagnostics, runtime, scope);
    const key = stableRowKey(group);
    const existing = groups.get(key);

    if (existing === undefined) {
      groups.set(key, { group, rows: [row] });
    } else {
      existing.rows.push(row);
    }
  }

  if (groups.size === 0 && groupProjection.length === 0) {
    groups.set(stableRowKey({}), { group: {}, rows: [] });
  }

  return Promise.all(Array.from(groups.values()).map(async ({ group, rows }) => ({
    ...group,
    ...await evaluateAggregates(source, relations, rows, aggregateProjection, diagnostics, runtime, scope)
  })));
}

async function evaluateExpand(
  source: RelationSource,
  relations: Record<string, RelationRef>,
  inputRows: readonly Context[],
  data: Extract<QueryData, { op: 'expand' }>,
  diagnostics: TarstateDiagnostic[],
  runtime: EvaluationRuntime,
  scope: Context
): Promise<Context[]> {
  const output: Context[] = [];

  for (const context of inputRows) {
    const collection = await evaluateExpr(source, relations, context, data.collection, diagnostics, runtime, scope);

    if (collection == null) {
      continue;
    }

    if (!isExpandable(collection)) {
      diagnostics.push({
        code: 'invalid_row',
        message: 'expand expression did not return an iterable collection',
        detail: { value: collection }
      });
      continue;
    }

    for (const item of collection) {
      const expanded = expandContext(context, item, data, diagnostics);

      if (expanded !== undefined) {
        output.push(expanded);
      }
    }
  }

  return output;
}

function expandContext(
  context: Context,
  item: unknown,
  data: Extract<QueryData, { op: 'expand' }>,
  diagnostics: TarstateDiagnostic[]
): Context | undefined {
  if (data.alias !== undefined) {
    return { ...context, [data.alias]: item };
  }

  if (!isRecord(item)) {
    diagnostics.push({
      code: 'invalid_row',
      message: 'expand item must be an object when no alias is provided',
      detail: { value: item }
    });
    return undefined;
  }

  if (data.fields === undefined) {
    return { ...context, ...item };
  }

  const selected: Record<string, unknown> = {};

  for (const fieldName of data.fields) {
    selected[fieldName] = item[fieldName];
  }

  return { ...context, ...selected };
}

function relationFor(relations: Record<string, RelationRef>, relationName: string): RelationRef {
  const relationRef = relations[relationName];

  if (relationRef === undefined) {
    throw new Error(`Unknown relation: ${relationName}`);
  }

  return relationRef;
}

async function readRows(
  source: RelationSource,
  relationRef: RelationRef,
  diagnostics: TarstateDiagnostic[]
): Promise<readonly unknown[]> {
  try {
    return rowsArray(await source.rows(relationRef));
  } catch (error) {
    diagnostics.push({
      code: 'source_error',
      message: `source rows failed for relation ${relationRef.name}`,
      relation: relationRef.name,
      detail: error
    });
    return [];
  }
}

async function readLookup(
  source: RelationSource,
  lookup: RelationLookup,
  diagnostics: TarstateDiagnostic[]
): Promise<readonly unknown[] | undefined> {
  try {
    const rows = await source.lookup?.(lookup);
    return rows === undefined ? undefined : rowsArray(rows);
  } catch (error) {
    diagnostics.push({
      code: 'source_error',
      message: `source lookup failed for relation ${lookup.relation.name}`,
      relation: lookup.relation.name,
      field: lookup.field,
      detail: error
    });
    return undefined;
  }
}

async function readRangeLookup(
  source: RelationSource,
  lookup: RelationRangeLookup,
  diagnostics: TarstateDiagnostic[]
): Promise<readonly unknown[] | undefined> {
  try {
    const rows = await source.rangeLookup?.(lookup);
    return rows === undefined ? undefined : rowsArray(rows);
  } catch (error) {
    diagnostics.push({
      code: 'source_error',
      message: `source range lookup failed for relation ${lookup.relation.name}`,
      relation: lookup.relation.name,
      field: lookup.field,
      detail: error
    });
    return undefined;
  }
}

function rowsToContexts(
  rows: readonly unknown[],
  alias: string,
  relationRef: RelationRef,
  diagnostics: TarstateDiagnostic[]
): Context[] {
  // Keep scan and lookup result policy identical once rows are returned.
  const seenKeys = new Set<string>();
  const rowPlan = rowPlanFor(relationRef);
  const contexts: Context[] = [];

  for (const row of rows) {
    const contextRow = rowForContext(row, rowPlan, seenKeys, diagnostics);

    if (contextRow === undefined) {
      continue;
    }

    contexts.push({ [alias]: contextRow });
  }

  return contexts;
}

function rowsArray(rows: Iterable<unknown>): readonly unknown[] {
  return Array.isArray(rows) ? rows : Array.from(rows);
}

function isExpandable(input: unknown): input is Iterable<unknown> {
  return typeof input !== 'string' && typeof (input as Iterable<unknown>)[Symbol.iterator] === 'function';
}

function rowPlanFor(relationRef: RelationRef): RowPlan {
  return {
    relationRef,
    fields: Object.entries(relationRef.fields),
    keyFields: Array.isArray(relationRef.key) ? relationRef.key : [relationRef.key]
  };
}

function rowForContext(
  row: unknown,
  rowPlan: RowPlan,
  seenKeys: Set<string> | undefined,
  diagnostics: TarstateDiagnostic[]
): Record<string, unknown> | undefined {
  const relationRef = rowPlan.relationRef;

  if (!isRecord(row)) {
    diagnostics.push({
      code: 'invalid_row',
      message: `row for relation ${relationRef.name} is not an object`,
      relation: relationRef.name,
      detail: row
    });
    return undefined;
  }

  const diagnosticCount = appendRowDiagnostics(rowPlan, row, diagnostics);

  if (relationRef.ephemeral && diagnosticCount > 0) {
    return undefined;
  }

  if (seenKeys !== undefined) {
    const key = rowKey(rowPlan, row);
    if (key !== undefined) {
      if (seenKeys.has(key)) {
        diagnostics.push({
          code: 'duplicate_key',
          message: `duplicate key ${key} in relation ${relationRef.name}`,
          relation: relationRef.name,
          key
        });
      }
      seenKeys.add(key);
    }
  }

  return row;
}

function lookupForWhere(
  relations: Record<string, RelationRef>,
  data: Extract<QueryData, { op: 'where' }>
): { readonly lookup: RelationLookup; readonly alias: string } | undefined {
  const equality = equalityFieldLiteral(data.predicate);

  if (equality === undefined) {
    return undefined;
  }

  const sourcePlan = lookupSourceForField(relations, data.input, equality.field);

  if (sourcePlan === undefined) {
    return undefined;
  }

  return {
    lookup: { relation: sourcePlan.relation, field: sourcePlan.field, value: equality.value },
    alias: sourcePlan.alias
  };
}

function rangeLookupForWhere(
  relations: Record<string, RelationRef>,
  data: Extract<QueryData, { op: 'where' }>
): { readonly lookup: RelationRangeLookup; readonly alias: string } | undefined {
  const range = rangeFieldLiterals(data.predicate);

  if (range === undefined) {
    return undefined;
  }

  const sourcePlan = rangeLookupSourceForField(relations, data.input, range.field);

  if (sourcePlan === undefined) {
    return undefined;
  }

  return {
    lookup: {
      relation: sourcePlan.relation,
      field: sourcePlan.field,
      ...(range.lower === undefined ? {} : { lower: range.lower }),
      ...(range.upper === undefined ? {} : { upper: range.upper })
    },
    alias: sourcePlan.alias
  };
}

function lookupForJoin(
  relations: Record<string, RelationRef>,
  data: Extract<QueryData, { op: 'join' }>
): LookupJoinPlan | undefined {
  const equality = equalityFieldPair(data.on);

  if (equality === undefined) {
    return undefined;
  }

  const rightAliases = aliasesFor(data.right);
  const leftSourcePlan = lookupSourceForField(relations, data.right, equality.left);

  if (leftSourcePlan !== undefined && equality.right.alias !== leftSourcePlan.alias) {
    return {
      alias: leftSourcePlan.alias,
      relation: leftSourcePlan.relation,
      field: leftSourcePlan.field,
      value: equality.right,
      rightAliases
    };
  }

  const rightSourcePlan = lookupSourceForField(relations, data.right, equality.right);

  if (rightSourcePlan !== undefined && equality.left.alias !== rightSourcePlan.alias) {
    return {
      alias: rightSourcePlan.alias,
      relation: rightSourcePlan.relation,
      field: rightSourcePlan.field,
      value: equality.left,
      rightAliases
    };
  }

  return undefined;
}

function equalityFieldLiteral(
  predicate: PredicateData
): { readonly field: FieldExpr; readonly value: unknown } | undefined {
  if (predicate.op !== 'eq') {
    return undefined;
  }

  if (predicate.left.op === 'field' && predicate.right.op === 'value') {
    return { field: predicate.left, value: predicate.right.value };
  }

  if (predicate.right.op === 'field' && predicate.left.op === 'value') {
    return { field: predicate.right, value: predicate.left.value };
  }

  return undefined;
}

function equalityFieldPair(
  predicate: PredicateData
): { readonly left: FieldExpr; readonly right: FieldExpr } | undefined {
  if (predicate.op !== 'eq' || predicate.left.op !== 'field' || predicate.right.op !== 'field') {
    return undefined;
  }

  return { left: predicate.left, right: predicate.right };
}

function rangeFieldLiterals(predicate: PredicateData): RangeConstraint | undefined {
  if (predicate.op !== 'and') {
    return rangeFieldLiteral(predicate);
  }

  let range: RangeConstraint | undefined;

  for (const item of predicate.predicates) {
    const itemRange = rangeFieldLiteral(item);

    if (itemRange === undefined) {
      return undefined;
    }

    if (range !== undefined && !sameField(range.field, itemRange.field)) {
      return undefined;
    }

    range = mergeRangeConstraints(range, itemRange);
  }

  return range;
}

function rangeFieldLiteral(predicate: PredicateData): RangeConstraint | undefined {
  switch (predicate.op) {
    case 'lt':
      return rangeComparison(predicate.left, predicate.right, 'upper', false);
    case 'lte':
      return rangeComparison(predicate.left, predicate.right, 'upper', true);
    case 'gt':
      return rangeComparison(predicate.left, predicate.right, 'lower', false);
    case 'gte':
      return rangeComparison(predicate.left, predicate.right, 'lower', true);
    default:
      return undefined;
  }
}

function rangeComparison(
  left: ExprData,
  right: ExprData,
  fieldSide: 'lower' | 'upper',
  inclusive: boolean
): RangeConstraint | undefined {
  if (left.op === 'field' && right.op === 'value') {
    return rangeConstraint(left, fieldSide, { value: right.value, inclusive });
  }

  if (right.op === 'field' && left.op === 'value') {
    return rangeConstraint(right, invertedRangeSide(fieldSide), { value: left.value, inclusive });
  }

  return undefined;
}

function rangeConstraint(
  field: FieldExpr,
  side: 'lower' | 'upper',
  bound: RelationRangeBound
): RangeConstraint {
  return side === 'lower'
    ? { field, lower: bound }
    : { field, upper: bound };
}

function invertedRangeSide(side: 'lower' | 'upper'): 'lower' | 'upper' {
  return side === 'lower' ? 'upper' : 'lower';
}

function mergeRangeConstraints(
  current: RangeConstraint | undefined,
  next: RangeConstraint
): RangeConstraint {
  if (current === undefined) {
    return next;
  }

  const lower = stricterLowerBound(current.lower, next.lower);
  const upper = stricterUpperBound(current.upper, next.upper);

  return {
    field: current.field,
    ...(lower === undefined ? {} : { lower }),
    ...(upper === undefined ? {} : { upper })
  };
}

function stricterLowerBound(
  current: RelationRangeBound | undefined,
  next: RelationRangeBound | undefined
): RelationRangeBound | undefined {
  if (current === undefined) {
    return next;
  }

  if (next === undefined) {
    return current;
  }

  const comparison = compareRangeBoundValues(current, next);

  if (comparison === undefined) {
    return current;
  }

  if (comparison < 0) {
    return next;
  }

  if (comparison > 0) {
    return current;
  }

  return { value: current.value, inclusive: current.inclusive && next.inclusive };
}

function stricterUpperBound(
  current: RelationRangeBound | undefined,
  next: RelationRangeBound | undefined
): RelationRangeBound | undefined {
  if (current === undefined) {
    return next;
  }

  if (next === undefined) {
    return current;
  }

  const comparison = compareRangeBoundValues(current, next);

  if (comparison === undefined) {
    return current;
  }

  if (comparison > 0) {
    return next;
  }

  if (comparison < 0) {
    return current;
  }

  return { value: current.value, inclusive: current.inclusive && next.inclusive };
}

function compareRangeBoundValues(left: RelationRangeBound, right: RelationRangeBound): number | undefined {
  const leftValue = comparableRangeValue(left.value);
  const rightValue = comparableRangeValue(right.value);

  if (leftValue === undefined || rightValue === undefined || typeof leftValue !== typeof rightValue) {
    return undefined;
  }

  if (leftValue === rightValue) {
    return 0;
  }

  return leftValue < rightValue ? -1 : 1;
}

function comparableRangeValue(value: unknown): ComparableRangeValue | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }

  return typeof value === 'string' ? value : undefined;
}

function sameField(left: FieldExpr, right: FieldExpr): boolean {
  return left.alias === right.alias && left.field === right.field;
}

function lookupSourceForField(
  relations: Record<string, RelationRef>,
  data: QueryData,
  field: FieldExpr
): LookupSourcePlan | undefined {
  switch (data.op) {
    case 'from':
      if (field.alias !== data.alias) {
        return undefined;
      }

      return {
        alias: data.alias,
        relation: relationFor(relations, data.relation),
        field: field.field
      };
    case 'hash':
      return hashLookupSourceForField(relations, data, field);
    case 'btree':
    case 'keyBy':
      return lookupSourceForField(relations, data.input, field);
    default:
      return undefined;
  }
}

function hashLookupSourceForField(
  relations: Record<string, RelationRef>,
  data: Extract<QueryData, { op: 'hash' }>,
  field: FieldExpr
): LookupSourcePlan | undefined {
  const input = indexBaseFrom(data.input);

  if (input === undefined || !hashDeclaresField(data, field) || field.alias !== input.alias) {
    return undefined;
  }

  return {
    alias: input.alias,
    relation: relationFor(relations, input.relation),
    field: field.field
  };
}

function hashDeclaresField(data: Extract<QueryData, { op: 'hash' }>, field: FieldExpr): boolean {
  const [expression] = data.expressions;

  return data.expressions.length === 1 &&
    expression?.op === 'field' &&
    expression.alias === field.alias &&
    expression.field === field.field;
}

function rangeLookupSourceForField(
  relations: Record<string, RelationRef>,
  data: QueryData,
  field: FieldExpr
): LookupSourcePlan | undefined {
  switch (data.op) {
    case 'btree':
      return btreeRangeLookupSourceForField(relations, data, field);
    case 'hash':
    case 'keyBy':
      return rangeLookupSourceForField(relations, data.input, field);
    default:
      return undefined;
  }
}

function btreeRangeLookupSourceForField(
  relations: Record<string, RelationRef>,
  data: Extract<QueryData, { op: 'btree' }>,
  field: FieldExpr
): LookupSourcePlan | undefined {
  const input = indexBaseFrom(data.input);

  if (input === undefined || !btreeDeclaresField(data, field) || field.alias !== input.alias) {
    return undefined;
  }

  return {
    alias: input.alias,
    relation: relationFor(relations, input.relation),
    field: field.field
  };
}

function btreeDeclaresField(data: Extract<QueryData, { op: 'btree' }>, field: FieldExpr): boolean {
  const [expression] = data.expressions;

  return data.expressions.length === 1 &&
    expression?.op === 'field' &&
    expression.alias === field.alias &&
    expression.field === field.field;
}

function indexBaseFrom(data: QueryData): Extract<QueryData, { op: 'from' }> | undefined {
  switch (data.op) {
    case 'from':
      return data;
    case 'hash':
    case 'btree':
    case 'keyBy':
      return indexBaseFrom(data.input);
    default:
      return undefined;
  }
}

function aliasesFor(data: QueryData): string[] {
  switch (data.op) {
    case 'from':
    case 'lookup':
      return [data.alias];
    case 'constRows':
      return [];
    case 'where':
    case 'hash':
    case 'btree':
    case 'keyBy':
    case 'select':
    case 'extend':
    case 'sort':
    case 'limit':
    case 'sortLimit':
    case 'rename':
    case 'qualify':
    case 'aggregate':
    case 'without':
      return aliasesFor(data.input);
    case 'expand':
      return data.alias === undefined ? aliasesFor(data.input) : [...aliasesFor(data.input), data.alias];
    case 'join':
      return [...aliasesFor(data.left), ...aliasesFor(data.right)];
    case 'difference':
      return [...aliasesFor(data.left), ...aliasesFor(data.right)];
    case 'union':
    case 'intersection':
      return data.inputs.flatMap((input) => aliasesFor(input));
  }
}

function appendRowDiagnostics(
  rowPlan: RowPlan,
  row: Record<string, unknown>,
  diagnostics: TarstateDiagnostic[]
): number {
  const relationRef = rowPlan.relationRef;
  const diagnosticsBefore = diagnostics.length;

  for (const [fieldName, spec] of rowPlan.fields) {
    const hasField = Object.hasOwn(row, fieldName);
    const value = row[fieldName];

    if (!hasField || value === undefined) {
      if (!spec.optional) {
        diagnostics.push({
          code: 'invalid_row',
          message: `missing required field ${fieldName} in relation ${relationRef.name}`,
          relation: relationRef.name,
          field: fieldName
        });
      }
      continue;
    }

    if (value === null) {
      if (!spec.nullable) {
        diagnostics.push({
          code: 'invalid_row',
          message: `null field ${fieldName} is not nullable in relation ${relationRef.name}`,
          relation: relationRef.name,
          field: fieldName
        });
      }
      continue;
    }

    if (!valueMatches(spec, value)) {
      diagnostics.push({
        code: 'invalid_row',
        message: `invalid field ${fieldName} in relation ${relationRef.name}`,
        relation: relationRef.name,
        field: fieldName,
        detail: value
      });
    }
  }

  return diagnostics.length - diagnosticsBefore;
}

function valueMatches(spec: FieldSpec, value: unknown): boolean {
  switch (spec.valueKind) {
    case 'string':
    case 'id':
    case 'ref':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number';
    case 'boolean':
      return typeof value === 'boolean';
    case 'anchoredPath':
      return Array.isArray(value);
    case 'json':
      return isJsonValue(value);
  }
}

function rowKey(rowPlan: RowPlan, row: Record<string, unknown>): string | undefined {
  const values: unknown[] = [];

  for (const keyField of rowPlan.keyFields) {
    const value = row[keyField];

    if (value === undefined) {
      return undefined;
    }

    values.push(value);
  }

  return JSON.stringify(values);
}

async function evaluatePredicate(
  source: RelationSource,
  relations: Record<string, RelationRef>,
  context: Context,
  predicate: PredicateData,
  diagnostics: TarstateDiagnostic[],
  runtime: EvaluationRuntime,
  scope: Context
): Promise<boolean> {
  switch (predicate.op) {
    case 'eq':
      return await evaluateExpr(source, relations, context, predicate.left, diagnostics, runtime, scope) ===
        await evaluateExpr(source, relations, context, predicate.right, diagnostics, runtime, scope);
    case 'neq':
      return await evaluateExpr(source, relations, context, predicate.left, diagnostics, runtime, scope) !==
        await evaluateExpr(source, relations, context, predicate.right, diagnostics, runtime, scope);
    case 'lt':
      return compareValues(
        await evaluateExpr(source, relations, context, predicate.left, diagnostics, runtime, scope),
        await evaluateExpr(source, relations, context, predicate.right, diagnostics, runtime, scope)
      ) < 0;
    case 'lte':
      return compareValues(
        await evaluateExpr(source, relations, context, predicate.left, diagnostics, runtime, scope),
        await evaluateExpr(source, relations, context, predicate.right, diagnostics, runtime, scope)
      ) <= 0;
    case 'gt':
      return compareValues(
        await evaluateExpr(source, relations, context, predicate.left, diagnostics, runtime, scope),
        await evaluateExpr(source, relations, context, predicate.right, diagnostics, runtime, scope)
      ) > 0;
    case 'gte':
      return compareValues(
        await evaluateExpr(source, relations, context, predicate.left, diagnostics, runtime, scope),
        await evaluateExpr(source, relations, context, predicate.right, diagnostics, runtime, scope)
      ) >= 0;
    case 'and':
      for (const item of predicate.predicates) {
        if (!await evaluatePredicate(source, relations, context, item, diagnostics, runtime, scope)) {
          return false;
        }
      }
      return true;
    case 'or':
      for (const item of predicate.predicates) {
        if (await evaluatePredicate(source, relations, context, item, diagnostics, runtime, scope)) {
          return true;
        }
      }
      return false;
    case 'not':
      return !await evaluatePredicate(source, relations, context, predicate.predicate, diagnostics, runtime, scope);
  }
}

async function filterContextsByPredicate(
  source: RelationSource,
  relations: Record<string, RelationRef>,
  contexts: readonly Context[],
  predicate: PredicateData,
  diagnostics: TarstateDiagnostic[],
  runtime: EvaluationRuntime,
  scope: Context
): Promise<Context[]> {
  const output: Context[] = [];

  for (const context of contexts) {
    if (await evaluatePredicate(source, relations, context, predicate, diagnostics, runtime, scope)) {
      output.push(context);
    }
  }

  return output;
}

function projectionPlan(projection: ProjectionData): ProjectionStep[] {
  const steps: ProjectionStep[] = [];

  for (const [fieldName, expr] of Object.entries(projection)) {
    steps.push({
      fieldName,
      expr: isOptionalProjection(expr) ? expr.expr : expr
    });
  }

  return steps;
}

async function evaluateProjection(
  source: RelationSource,
  relations: Record<string, RelationRef>,
  context: Context,
  projection: readonly ProjectionStep[],
  diagnostics: TarstateDiagnostic[],
  runtime: EvaluationRuntime,
  scope: Context
): Promise<Record<string, unknown>> {
  const row: Record<string, unknown> = {};

  for (const step of projection) {
    row[step.fieldName] = await evaluateExpr(source, relations, context, step.expr, diagnostics, runtime, scope);
  }

  return row;
}

async function evaluateAggregates(
  source: RelationSource,
  relations: Record<string, RelationRef>,
  rows: readonly Context[],
  projection: readonly AggregateStep[],
  diagnostics: TarstateDiagnostic[],
  runtime: EvaluationRuntime,
  scope: Context
): Promise<Record<string, unknown>> {
  const output: Record<string, unknown> = {};

  for (const step of projection) {
    output[step.fieldName] = await evaluateAggregateExpr(source, relations, rows, step.expr, diagnostics, runtime, scope);
  }

  return output;
}

async function evaluateAggregateExpr(
  source: RelationSource,
  relations: Record<string, RelationRef>,
  rows: readonly Context[],
  expr: ExprData,
  diagnostics: TarstateDiagnostic[],
  runtime: EvaluationRuntime,
  scope: Context
): Promise<unknown> {
  if (expr.op !== 'aggregateCall') {
    return rows[0] === undefined
      ? undefined
      : evaluateExpr(source, relations, rows[0], expr, diagnostics, runtime, scope);
  }

  const values = expr.expr === undefined
    ? rows
    : await Promise.all(rows.map((row) =>
        evaluateExpr(source, relations, row, expr.expr as ExprData, diagnostics, runtime, scope)
      ));
  const aggregateValues = expr.distinct ? distinctValues(values) : values;

  switch (expr.name) {
    case 'count':
      return expr.expr === undefined ? aggregateValues.length : aggregateValues.filter((value) => value != null).length;
    case 'sum':
      return sumValues(aggregateValues);
    case 'avg': {
      const numericValues = aggregateValues.filter((value): value is number => typeof value === 'number');
      return numericValues.length === 0
        ? undefined
        : numericValues.reduce((total, value) => total + value, 0) / numericValues.length;
    }
    case 'min':
      return minMaxValue(aggregateValues, 'min');
    case 'max':
      return minMaxValue(aggregateValues, 'max');
    case 'any':
      return aggregateValues.some(Boolean);
    case 'notAny':
      return !aggregateValues.some(Boolean);
    case 'setConcat':
      return setConcatValues(aggregateValues);
    case 'top':
      return sortedAggregateValues(aggregateValues, aggregateCount(expr), 'desc');
    case 'bottom':
      return sortedAggregateValues(aggregateValues, aggregateCount(expr), 'asc');
    case 'topBy':
      return sortedAggregateRows(source, relations, rows, expr.expr, aggregateCount(expr), 'desc', diagnostics, runtime, scope, expr.distinct);
    case 'bottomBy':
      return sortedAggregateRows(source, relations, rows, expr.expr, aggregateCount(expr), 'asc', diagnostics, runtime, scope, expr.distinct);
  }
}

function sumValues(values: readonly unknown[]): number {
  let total = 0;

  for (const value of values) {
    total += numericValue(value);
  }

  return total;
}

function distinctValues(values: readonly unknown[]): unknown[] {
  const output: unknown[] = [];
  const seen = new Set<string>();

  for (const value of values) {
    const key = stableRowKey(value);

    if (!seen.has(key)) {
      seen.add(key);
      output.push(value);
    }
  }

  return output;
}

function setConcatValues(values: readonly unknown[]): ReadonlySet<unknown> {
  const output = new Set<unknown>();
  const seen = new Set<string>();

  for (const value of values) {
    const items = isSetConcatCollection(value) ? value : [value];

    for (const item of items) {
      const key = stableRowKey(item);

      if (!seen.has(key)) {
        seen.add(key);
        output.add(item);
      }
    }
  }

  return output;
}

function isSetConcatCollection(input: unknown): input is Iterable<unknown> {
  return Array.isArray(input) || input instanceof Set;
}

function numericValue(value: unknown): number {
  return typeof value === 'number' ? value : 0;
}

function stringValue(value: unknown): string {
  if (value == null) {
    return '';
  }

  if (typeof value === 'string') {
    return value;
  }

  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }

  return stableRowKey(value);
}

function minMaxValue(values: readonly unknown[], mode: 'min' | 'max'): unknown {
  let selected: unknown;

  for (const value of values) {
    if (value == null) {
      continue;
    }

    if (selected === undefined) {
      selected = value;
      continue;
    }

    const comparison = compareValues(value, selected);
    if ((mode === 'min' && comparison < 0) || (mode === 'max' && comparison > 0)) {
      selected = value;
    }
  }

  return selected;
}

function sortedAggregateValues(
  values: readonly unknown[],
  count: number,
  direction: 'asc' | 'desc'
): readonly unknown[] {
  return [...values]
    .filter((value) => value != null)
    .sort((left, right) => direction === 'asc' ? compareValues(left, right) : compareValues(right, left))
    .slice(0, count);
}

async function sortedAggregateRows(
  source: RelationSource,
  relations: Record<string, RelationRef>,
  rows: readonly Context[],
  expr: ExprData | undefined,
  count: number,
  direction: 'asc' | 'desc',
  diagnostics: TarstateDiagnostic[],
  runtime: EvaluationRuntime,
  scope: Context,
  distinct: boolean
): Promise<readonly Context[]> {
  if (expr === undefined) {
    return [];
  }

  const candidates = (await Promise.all(rows.map(async (row) => ({
      row,
      value: await evaluateExpr(source, relations, row, expr, diagnostics, runtime, scope)
    }))))
    .filter((candidate) => candidate.value != null);
  const uniqueCandidates = distinct ? distinctRowCandidates(candidates) : candidates;

  return [...uniqueCandidates]
    .sort((left, right) => {
      const comparison = direction === 'asc'
        ? compareValues(left.value, right.value)
        : compareValues(right.value, left.value);

      return comparison === 0 ? compareValues(stableRowKey(left.row), stableRowKey(right.row)) : comparison;
    })
    .slice(0, count)
    .map((candidate) => candidate.row);
}

function distinctRowCandidates(
  candidates: readonly { readonly row: Context; readonly value: unknown }[]
): readonly { readonly row: Context; readonly value: unknown }[] {
  const output: { readonly row: Context; readonly value: unknown }[] = [];
  const seen = new Set<string>();

  for (const candidate of candidates) {
    const key = stableRowKey(candidate.row);

    if (!seen.has(key)) {
      seen.add(key);
      output.push(candidate);
    }
  }

  return output;
}

function aggregateCount(expr: AggregateCallExpr): number {
  return expr.count ?? Number.POSITIVE_INFINITY;
}

function isOptionalProjection(input: ExprData | OptionalProjection): input is OptionalProjection {
  return 'kind' in input && input.kind === 'optionalProjection';
}

async function evaluateExpr(
  source: RelationSource,
  relations: Record<string, RelationRef>,
  context: Context,
  expr: ExprData,
  diagnostics: TarstateDiagnostic[],
  runtime: EvaluationRuntime,
  scope: Context
): Promise<unknown> {
  switch (expr.op) {
    case 'field':
      return evaluateField(context, scope, expr.alias, expr.field);
    case 'env':
      return runtime.env[expr.name];
    case 'value':
      return expr.value;
    case 'call':
      return evaluateCall(
        expr.name,
        await Promise.all(expr.args.map((arg) => evaluateExpr(source, relations, context, arg, diagnostics, runtime, scope))),
        diagnostics,
        runtime
      );
    case 'tuple':
      return Promise.all(expr.items.map((item) => evaluateExpr(source, relations, context, item, diagnostics, runtime, scope)));
    case 'subquery':
      return evaluateSubqueryExpr(source, relations, context, expr, diagnostics, runtime, scope);
    case 'aggregateCall':
      return undefined;
  }
}

async function evaluateSubqueryExpr(
  source: RelationSource,
  relations: Record<string, RelationRef>,
  context: Context,
  expr: Extract<ExprData, { readonly op: 'subquery' }>,
  diagnostics: TarstateDiagnostic[],
  runtime: EvaluationRuntime,
  scope: Context
): Promise<unknown> {
  const rows = await evaluateData(source, relations, expr.query, diagnostics, runtime, scopedContext(context, scope));

  if (expr.mode === 'many') {
    return rows;
  }

  if (rows.length <= 1) {
    return rows[0];
  }

  diagnostics.push({
    code: 'unsupported_expression',
    message: 'sel1 subquery returned more than one row',
    detail: { rows: rows.length, query: expr.query }
  });

  return undefined;
}

function evaluateField(context: Context, scope: Context, alias: string, field: string): unknown {
  if (alias.length === 0) {
    return Object.hasOwn(context, field) ? context[field] : scope[field];
  }

  const row = context[alias];
  if (isRecord(row)) {
    return row[field];
  }

  const scopedRow = scope[alias];
  return isRecord(scopedRow) ? scopedRow[field] : undefined;
}

function scopedContext(context: Context, scope: Context): Context {
  return { ...scope, ...context };
}

const builtinRuntimeFunctions: RuntimeFunctions = {
  add: (...args) => args.reduce<number>((total, value) => total + numericValue(value), 0),
  sub: (left, right) => numericValue(left) - numericValue(right),
  mul: (...args) => args.reduce<number>((total, value) => total * numericValue(value), 1),
  div: (left, right) => {
    const divisor = numericValue(right);
    return divisor === 0 ? undefined : numericValue(left) / divisor;
  },
  mod: (left, right) => {
    const divisor = numericValue(right);
    return divisor === 0 ? undefined : numericValue(left) % divisor;
  },
  concat: (...args) => args.map(stringValue).join(''),
  lower: (value) => (typeof value === 'string' ? value.toLowerCase() : undefined),
  upper: (value) => (typeof value === 'string' ? value.toUpperCase() : undefined),
  length: (value) => (typeof value === 'string' || Array.isArray(value) ? value.length : undefined),
  coalesce: (...args) => args.find((value) => value != null),
  not: (value) => !value
};

function evaluateCall(
  name: string,
  args: readonly unknown[],
  diagnostics: TarstateDiagnostic[],
  runtime: EvaluationRuntime
): unknown {
  if (name === 'env') {
    const [envName] = args;
    return typeof envName === 'string' ? runtime.env[envName] : undefined;
  }

  const runtimeFunction = runtime.functions[name];

  if (runtimeFunction === undefined) {
    diagnostics.push({
      code: 'unsupported_expression',
      message: `unsupported expression call ${name}`,
      detail: { name, args }
    });
    return undefined;
  }

  return runtimeFunction(...args);
}

function omitFields(row: Context, fields: readonly string[]): Record<string, unknown> {
  const output = { ...row };

  for (const field of fields) {
    delete output[field];
  }

  return output;
}

function renameFields(row: Context, fields: Record<string, string>): Record<string, unknown> {
  const output = { ...row };

  for (const [from, to] of Object.entries(fields)) {
    if (Object.hasOwn(output, from)) {
      output[to] = output[from];
      delete output[from];
    }
  }

  return output;
}

async function sortRows(
  source: RelationSource,
  relations: Record<string, RelationRef>,
  rows: readonly Context[],
  order: readonly SortData[],
  diagnostics: TarstateDiagnostic[],
  runtime: EvaluationRuntime,
  scope: Context
): Promise<Context[]> {
  const keyedRows = await Promise.all(rows.map(async (row) => ({
    row,
    keys: await Promise.all(order.map((item) =>
      evaluateExpr(source, relations, row, item.expr, diagnostics, runtime, scope)
    ))
  })));

  return keyedRows.sort((left, right) => {
    for (let index = 0; index < order.length; index += 1) {
      const item = order[index] as SortData;
      const comparison = compareSortValues(
        left.keys[index],
        right.keys[index],
        item
      );

      if (comparison !== 0) {
        return comparison;
      }
    }

    return 0;
  }).map((item) => item.row);
}

function compareSortValues(left: unknown, right: unknown, sort: SortData): number {
  const leftNull = left == null;
  const rightNull = right == null;

  if (leftNull || rightNull) {
    if (leftNull && rightNull) {
      return 0;
    }

    const nulls = sort.nulls ?? 'last';
    const nullComparison = leftNull ? -1 : 1;
    return nulls === 'first' ? nullComparison : -nullComparison;
  }

  const comparison = compareValues(left, right);
  return sort.direction === 'asc' ? comparison : -comparison;
}

function compareValues(left: unknown, right: unknown): number {
  if (left === right) {
    return 0;
  }

  if (typeof left === 'number' && typeof right === 'number') {
    return left < right ? -1 : 1;
  }

  if (typeof left === 'string' && typeof right === 'string') {
    return left < right ? -1 : 1;
  }

  if (typeof left === 'boolean' && typeof right === 'boolean') {
    return Number(left) - Number(right);
  }

  if (left instanceof Date && right instanceof Date) {
    return left.getTime() - right.getTime();
  }

  const leftKey = stableRowKey(left);
  const rightKey = stableRowKey(right);

  if (leftKey === rightKey) {
    return 0;
  }

  return leftKey < rightKey ? -1 : 1;
}

function contextWithNullAliases(context: Context, aliases: readonly string[]): Context {
  const output = { ...context };

  for (const alias of aliases) {
    output[alias] = null;
  }

  return output;
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === 'object' && input !== null && !Array.isArray(input);
}
