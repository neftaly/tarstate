import { collectDiagnostics, normalizeDiagnostics, type TarstateDiagnostic } from './diagnostics.js';
import { stableKey } from './identity.js';
import type {
  ExprData,
  NullSortOrder,
  PredicateData,
  ProjectionData,
  Query,
  QueryData,
  SortData
} from './query.js';
import { isJsonValue, type FieldSpec, type RelationRef } from './schema.js';
import type { RelationSource } from './source.js';
import { equalityJoinPlan, type FieldExpression } from './join-planner.js';

export type QueryResult<Row> = {
  readonly rows: readonly Row[];
  readonly diagnostics: readonly TarstateDiagnostic[];
};

export type EvaluateFunction = (...args: readonly unknown[]) => unknown;
export type EvaluateFunctions = Readonly<Record<string, EvaluateFunction>>;
export type EvaluateEnv = Readonly<Record<string, unknown>>;
export type EvaluateOptions = {
  readonly functions?: EvaluateFunctions;
  readonly env?: EvaluateEnv;
};

type EvalContext = Record<string, unknown>;
type EvalState = {
  readonly source: RelationSource;
  readonly relations: Record<string, RelationRef>;
  readonly options: EvaluateOptions;
  readonly diagnostics: TarstateDiagnostic[];
};

export async function evaluate<Row>(
  source: RelationSource,
  query: Query<Row>,
  options: EvaluateOptions = {}
): Promise<QueryResult<Row>> {
  const state: EvalState = {
    source,
    relations: query.relations,
    options,
    diagnostics: []
  };
  const rows = await evaluateData(query.data, state);
  const sourceDiagnostics = await collectDiagnostics(source);

  return {
    rows: rows as readonly Row[],
    diagnostics: [...sourceDiagnostics, ...state.diagnostics]
  };
}

async function evaluateData(
  data: QueryData,
  state: EvalState,
  outerRow: EvalContext = {}
): Promise<readonly EvalContext[]> {
  switch (data.op) {
    case 'from':
      return relationRows(data.relation, data.alias, state, outerRow);
    case 'lookup':
      return lookupRows(data, state, outerRow);
    case 'constRows':
      return data.rows.map((row) => ({ ...outerRow, ...row }));
    case 'where': {
      const input = await evaluateData(data.input, state, outerRow);
      return filterAsync(input, (row) => evaluatePredicate(data.predicate, row, state));
    }
    case 'hash':
    case 'btree':
    case 'keyBy':
      return evaluateData(data.input, state, outerRow);
    case 'join':
      return joinRows(data.kind, data.left, data.right, data.on, state, outerRow);
    case 'select':
      return Promise.all((await evaluateData(data.input, state, outerRow)).map((row) =>
        projectRow(data.projection, row, state)
      ));
    case 'extend':
      return Promise.all((await evaluateData(data.input, state, outerRow)).map(async (row) => ({
        ...row,
        ...await projectRow(data.projection, row, state)
      })));
    case 'expand':
      return expandRows(data.input, data.collection, data.alias, data.fields, state, outerRow);
    case 'without':
      return (await evaluateData(data.input, state, outerRow)).map((row) => {
        const output = { ...row };
        for (const field of data.fields) {
          delete output[field];
        }
        return output;
      });
    case 'sort':
      return sortRows(await evaluateData(data.input, state, outerRow), data.order, state);
    case 'limit': {
      const offset = data.offset ?? 0;
      return (await evaluateData(data.input, state, outerRow)).slice(offset, offset + data.count);
    }
    case 'sortLimit':
      return (await sortRows(await evaluateData(data.input, state, outerRow), data.order, state)).slice(0, data.count);
    case 'union':
      return setUnion(await Promise.all(data.inputs.map((input) => evaluateData(input, state, outerRow))));
    case 'intersection':
      return setIntersection(await Promise.all(data.inputs.map((input) => evaluateData(input, state, outerRow))));
    case 'difference':
      return setDifference(await evaluateData(data.left, state, outerRow), await evaluateData(data.right, state, outerRow));
    case 'rename':
      return (await evaluateData(data.input, state, outerRow)).map((row) => renameRow(row, data.fields));
    case 'qualify':
      return (await evaluateData(data.input, state, outerRow)).map((row) => ({ [data.alias]: row }));
    case 'aggregate':
      return aggregateRows(await evaluateData(data.input, state, outerRow), data.groupBy, data.aggregates, state);
  }
}

async function relationRows(
  relationName: string,
  alias: string,
  state: EvalState,
  outerRow: EvalContext
): Promise<readonly EvalContext[]> {
  const relation = state.relations[relationName];
  if (relation === undefined) {
    state.diagnostics.push({
      code: 'unsupported_lookup',
      message: `relation ${relationName} is not available`,
      relation: relationName
    });
    return [];
  }

  const rows = await readRows(state, relation);
  return validRelationRows(relation, rows, state).map((row) => ({ ...outerRow, [alias]: row }));
}

async function lookupRows(
  data: Extract<QueryData, { readonly op: 'lookup' }>,
  state: EvalState,
  outerRow: EvalContext
): Promise<readonly EvalContext[]> {
  const relation = state.relations[data.relation];
  if (relation === undefined) {
    return [];
  }

  const value = await evaluateExpr(data.value, outerRow, state);
  let rows: readonly unknown[] | undefined;

  if (state.source.lookup !== undefined) {
    try {
      rows = await state.source.lookup({ relation, field: data.field, value });
    } catch (error) {
      state.diagnostics.push(...normalizeDiagnostics(error, {
        code: 'source_error',
        message: 'source lookup failed',
        relation: relation.name,
        field: data.field
      }));
    }
  }

  if (rows === undefined) {
    rows = (await readRows(state, relation)).filter((row) =>
      isRecord(row) && Object.is(row[data.field], value)
    );
  }

  return validRelationRows(relation, rows, state).map((row) => ({ ...outerRow, [data.alias]: row }));
}

async function readRows(state: EvalState, relation: RelationRef): Promise<readonly unknown[]> {
  try {
    return await state.source.rows(relation);
  } catch (error) {
    state.diagnostics.push(...normalizeDiagnostics(error, {
      code: 'source_error',
      message: 'source rows failed',
      relation: relation.name
    }));
    return [];
  }
}

async function joinRows(
  kind: 'inner' | 'left',
  leftData: QueryData,
  rightData: QueryData,
  on: PredicateData,
  state: EvalState,
  outerRow: EvalContext
): Promise<readonly EvalContext[]> {
  const left = await evaluateData(leftData, state, outerRow);
  const right = await evaluateData(rightData, state, outerRow);
  const indexed = await equalityJoinRows(kind, left, right, on, state);
  if (indexed !== undefined) {
    return indexed;
  }

  const output: EvalContext[] = [];

  for (const leftRow of left) {
    let matched = false;

    for (const rightRow of right) {
      const merged = { ...leftRow, ...rightRow };
      if (await evaluatePredicate(on, merged, state)) {
        matched = true;
        output.push(merged);
      }
    }

    if (!matched && kind === 'left') {
      output.push(leftRow);
    }
  }

  return output;
}

async function equalityJoinRows(
  kind: 'inner' | 'left',
  left: readonly EvalContext[],
  right: readonly EvalContext[],
  on: PredicateData,
  state: EvalState
): Promise<readonly EvalContext[] | undefined> {
  const equality = equalityJoinPlan(on, (expr) => expressionSide(expr, left, right));
  if (equality === undefined) {
    return undefined;
  }

  if (right.length === 0) {
    return kind === 'left' ? left : [];
  }

  const rightIndex = new Map<string, { readonly row: EvalContext; readonly value: unknown }[]>();
  for (const rightRow of right) {
    const value = await evaluateExpr(equality.right, rightRow, state);
    const key = stableKey(value);
    const rows = rightIndex.get(key);
    if (rows === undefined) {
      rightIndex.set(key, [{ row: rightRow, value }]);
    } else {
      rows.push({ row: rightRow, value });
    }
  }

  const output: EvalContext[] = [];
  for (const leftRow of left) {
    const leftValue = await evaluateExpr(equality.left, leftRow, state);
    const candidates = rightIndex.get(stableKey(leftValue)) ?? [];
    let matched = false;

    for (const candidate of candidates) {
      if (!Object.is(leftValue, candidate.value)) {
        continue;
      }

      const merged = { ...leftRow, ...candidate.row };
      if (!equality.needsPredicateCheck || await evaluatePredicate(on, merged, state)) {
        matched = true;
        output.push(merged);
      }
    }

    if (!matched && kind === 'left') {
      output.push(leftRow);
    }
  }

  return output;
}

function expressionSide(
  expr: FieldExpression,
  left: readonly EvalContext[],
  right: readonly EvalContext[]
): 'left' | 'right' | undefined {
  const inLeft = rowsHaveField(left, expr);
  const inRight = rowsHaveField(right, expr);

  if (inLeft === inRight) {
    return undefined;
  }

  return inLeft ? 'left' : 'right';
}

function rowsHaveField(rows: readonly EvalContext[], expr: FieldExpression): boolean {
  return rows.some((row) => Object.hasOwn(row, expr.alias) || Object.hasOwn(row, expr.field));
}

async function expandRows(
  inputData: QueryData,
  collection: ExprData,
  alias: string | undefined,
  fields: readonly string[] | undefined,
  state: EvalState,
  outerRow: EvalContext
): Promise<readonly EvalContext[]> {
  const input = await evaluateData(inputData, state, outerRow);
  const output: EvalContext[] = [];

  for (const row of input) {
    const value = await evaluateExpr(collection, row, state);
    if (value === null || value === undefined || !isIterable(value)) {
      continue;
    }

    for (const item of value) {
      if (alias !== undefined) {
        output.push({ ...row, [alias]: item });
      } else if (isRecord(item)) {
        output.push({ ...row, ...pickFields(item, fields) });
      }
    }
  }

  return output;
}

async function projectRow(projection: ProjectionData, row: EvalContext, state: EvalState): Promise<EvalContext> {
  const output: Record<string, unknown> = {};

  for (const [name, item] of Object.entries(projection)) {
    const expr = projectionExpr(item);
    output[name] = expr.op === 'field'
      ? readField(row, expr.alias, expr.field)
      : await evaluateExpr(expr, row, state);
  }

  return output;
}

async function aggregateRows(
  rows: readonly EvalContext[],
  groupBy: ProjectionData,
  aggregates: ProjectionData,
  state: EvalState
): Promise<readonly EvalContext[]> {
  const groups = new Map<string, { readonly group: EvalContext; readonly rows: EvalContext[] }>();

  for (const row of rows) {
    const group = await projectRow(groupBy, row, state);
    const key = stableKey(group);
    const existing = groups.get(key);
    if (existing === undefined) {
      groups.set(key, { group, rows: [row] });
    } else {
      existing.rows.push(row);
    }
  }

  if (groups.size === 0 && Object.keys(groupBy).length === 0) {
    groups.set(stableKey({}), { group: {}, rows: [] });
  }

  return Promise.all(Array.from(groups.values()).map(async ({ group, rows: groupRows }) => {
    const output: Record<string, unknown> = { ...group };
    for (const [name, item] of Object.entries(aggregates)) {
      output[name] = await evaluateAggregate(projectionExpr(item), groupRows, state);
    }
    return output;
  }));
}

async function evaluateAggregate(expr: ExprData, rows: readonly EvalContext[], state: EvalState): Promise<unknown> {
  if (expr.op !== 'aggregateCall') {
    return evaluateExpr(expr, rows[0] ?? {}, state);
  }

  const values = expr.expr === undefined
    ? rows
    : await Promise.all(rows.map((row) => evaluateExpr(expr.expr as ExprData, row, state)));
  const aggregateValues = expr.distinct ? distinctValues(values) : values;

  switch (expr.name) {
    case 'count':
      return expr.expr === undefined ? rows.length : aggregateValues.filter((value) => value !== null && value !== undefined).length;
    case 'sum':
      return aggregateValues.reduce<number>((total, value) => total + (typeof value === 'number' ? value : 0), 0);
    case 'avg': {
      const numbers = aggregateValues.filter((value): value is number => typeof value === 'number');
      return numbers.length === 0 ? undefined : numbers.reduce((total, value) => total + value, 0) / numbers.length;
    }
    case 'min':
      return orderedValues(aggregateValues).at(0);
    case 'max':
      return orderedValues(aggregateValues).at(-1);
    case 'any':
      return aggregateValues.some(Boolean);
    case 'notAny':
      return !aggregateValues.some(Boolean);
    case 'setConcat':
      return new Set(aggregateValues.flatMap((value) => {
        if (value instanceof Set) return Array.from(value);
        if (Array.isArray(value)) return value;
        return [value];
      }));
    case 'top':
      return [...orderedValues(aggregateValues)].reverse().slice(0, expr.count ?? 0);
    case 'bottom':
      return orderedValues(aggregateValues).slice(0, expr.count ?? 0);
    case 'topBy':
      return (await rowsByAggregate(rows, expr.expr, state, 'desc')).slice(0, expr.count ?? 0);
    case 'bottomBy':
      return (await rowsByAggregate(rows, expr.expr, state, 'asc')).slice(0, expr.count ?? 0);
  }
}

async function evaluatePredicate(predicate: PredicateData, row: EvalContext, state: EvalState): Promise<boolean> {
  switch (predicate.op) {
    case 'eq':
      return Object.is(await evaluateExpr(predicate.left, row, state), await evaluateExpr(predicate.right, row, state));
    case 'neq':
      return !Object.is(await evaluateExpr(predicate.left, row, state), await evaluateExpr(predicate.right, row, state));
    case 'lt':
      return compareValues(await evaluateExpr(predicate.left, row, state), await evaluateExpr(predicate.right, row, state)) < 0;
    case 'lte':
      return compareValues(await evaluateExpr(predicate.left, row, state), await evaluateExpr(predicate.right, row, state)) <= 0;
    case 'gt':
      return compareValues(await evaluateExpr(predicate.left, row, state), await evaluateExpr(predicate.right, row, state)) > 0;
    case 'gte':
      return compareValues(await evaluateExpr(predicate.left, row, state), await evaluateExpr(predicate.right, row, state)) >= 0;
    case 'and':
      return everyAsync(predicate.predicates, (item) => evaluatePredicate(item, row, state));
    case 'or':
      return someAsync(predicate.predicates, (item) => evaluatePredicate(item, row, state));
    case 'not':
      return !await evaluatePredicate(predicate.predicate, row, state);
  }
}

async function evaluateExpr(expr: ExprData, row: EvalContext, state: EvalState): Promise<unknown> {
  switch (expr.op) {
    case 'field':
      return readField(row, expr.alias, expr.field);
    case 'value':
      return expr.value;
    case 'env':
      return state.options.env?.[expr.name];
    case 'call': {
      const fn = state.options.functions?.[expr.name];
      if (fn === undefined) {
        state.diagnostics.push({
          code: 'unsupported_expression',
          message: `function ${expr.name} is not available`
        });
        return undefined;
      }
      return fn(...await Promise.all(expr.args.map((arg) => evaluateExpr(arg, row, state))));
    }
    case 'hostCall': {
      if (expr.fn === undefined) {
        state.diagnostics.push({
          code: 'unsupported_expression',
          message: `host function ${expr.name} is not available; function expressions only work in memory`
        });
        return undefined;
      }

      const args = await Promise.all(expr.args.map((arg) => evaluateExpr(arg, row, state)));
      try {
        return expr.fn(...args);
      } catch (error) {
        state.diagnostics.push({
          code: 'unsupported_expression',
          message: `host function ${expr.name} failed`,
          detail: error
        });
        return undefined;
      }
    }
    case 'tuple':
      return Promise.all(expr.items.map((item) => evaluateExpr(item, row, state)));
    case 'aggregateCall':
      return evaluateAggregate(expr, [row], state);
    case 'subquery':
      return evaluateSubqueryExpr(expr, row, state);
  }
}

function readField(row: EvalContext, alias: string, field: string): unknown {
  const aliased = row[alias];

  if (isRecord(aliased)) {
    return aliased[field];
  }

  if (aliased !== undefined && field === 'value') {
    return aliased;
  }

  return row[field];
}

async function sortRows(
  rows: readonly EvalContext[],
  order: readonly SortData[],
  state: EvalState
): Promise<readonly EvalContext[]> {
  const keyedRows = await Promise.all(rows.map(async (row) => ({
    row,
    values: await Promise.all(order.map((item) => evaluateExpr(item.expr, row, state)))
  })));

  return keyedRows.sort((left, right) => {
    for (let index = 0; index < order.length; index += 1) {
      const item = order[index] as SortData;
      const comparison = compareSortValues(
        left.values[index],
        right.values[index],
        item.direction,
        item.nulls
      );

      if (comparison !== 0) {
        return comparison;
      }
    }

    return 0;
  }).map((item) => item.row);
}

function compareSortValues(
  left: unknown,
  right: unknown,
  direction: 'asc' | 'desc',
  nulls: NullSortOrder | undefined
): number {
  const leftNull = left === null || left === undefined;
  const rightNull = right === null || right === undefined;
  if (leftNull || rightNull) {
    if (leftNull && rightNull) return 0;
    const nullOrder = nulls ?? 'last';
    return leftNull === (nullOrder === 'first') ? -1 : 1;
  }

  const comparison = compareValues(left, right);
  return direction === 'asc' ? comparison : -comparison;
}

function compareValues(left: unknown, right: unknown): number {
  if (Object.is(left, right)) return 0;
  if ((typeof left === 'number' && typeof right === 'number') || (typeof left === 'string' && typeof right === 'string')) {
    return left < right ? -1 : 1;
  }
  return String(left) < String(right) ? -1 : 1;
}

function validRelationRows(
  relation: RelationRef,
  rows: readonly unknown[],
  state: EvalState
): readonly Record<string, unknown>[] {
  const output: Record<string, unknown>[] = [];

  for (const row of rows) {
    if (!isRecord(row)) {
      state.diagnostics.push(invalidRowDiagnostic(relation, undefined, undefined, 'row is not an object'));
      continue;
    }

    const diagnostics = validateRelationRow(relation, row);
    if (diagnostics.length === 0) {
      output.push(row);
    } else {
      state.diagnostics.push(...diagnostics);
    }
  }

  return output;
}

export function validateRelationRow(
  relation: RelationRef,
  row: Record<string, unknown>
): readonly TarstateDiagnostic[] {
  const diagnostics: TarstateDiagnostic[] = [];
  const key = rowKey(relation, row);

  for (const [field, spec] of Object.entries(relation.fields)) {
    const value = row[field];
    if (value === undefined) {
      if (!spec.optional) {
        diagnostics.push(invalidRowDiagnostic(relation, field, key, `${field} is required`));
      }
      continue;
    }

    if (value === null) {
      if (!spec.nullable) {
        diagnostics.push(invalidRowDiagnostic(relation, field, key, `${field} cannot be null`));
      }
      continue;
    }

    if (!validFieldValue(spec, value)) {
      diagnostics.push(invalidRowDiagnostic(relation, field, key, `${field} has invalid ${spec.valueKind} value`));
    }
  }

  return diagnostics;
}

function validFieldValue(spec: FieldSpec, value: unknown): boolean {
  switch (spec.valueKind) {
    case 'string':
    case 'id':
    case 'ref':
    case 'anchoredPath':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'json':
      return isJsonValue(value);
  }
}

function invalidRowDiagnostic(
  relation: RelationRef,
  field: string | undefined,
  key: string | undefined,
  message: string
): TarstateDiagnostic {
  return {
    code: 'invalid_row',
    message,
    relation: relation.name,
    ...(field === undefined ? {} : { field }),
    ...(key === undefined ? {} : { key })
  };
}

export function rowKey(relation: RelationRef, row: Record<string, unknown>): string | undefined {
  if (Array.isArray(relation.key)) {
    return stableKey(relation.key.map((field) => row[field]));
  }

  if (typeof relation.key !== 'string') {
    return undefined;
  }

  const value = row[relation.key];
  return keyPart(value);
}

function distinctValues(values: readonly unknown[]): readonly unknown[] {
  const seen = new Set<string>();
  const output: unknown[] = [];

  for (const value of values) {
    const key = stableKey(value);
    if (!seen.has(key)) {
      seen.add(key);
      output.push(value);
    }
  }

  return output;
}

function orderedValues(values: readonly unknown[]): readonly unknown[] {
  return [...values]
    .filter((value) => value !== null && value !== undefined)
    .sort(compareValues);
}

async function rowsByAggregate(
  rows: readonly EvalContext[],
  expr: ExprData | undefined,
  state: EvalState,
  direction: 'asc' | 'desc'
): Promise<readonly EvalContext[]> {
  if (expr === undefined) {
    return [...rows];
  }

  const keyedRows = await Promise.all(rows.map(async (row) => ({
    row,
    value: await evaluateExpr(expr, row, state)
  })));

  return keyedRows.sort((left, right) =>
    compareSortValues(left.value, right.value, direction, 'last')
  ).map((item) => item.row);
}

async function evaluateSubqueryExpr(
  expr: Extract<ExprData, { readonly op: 'subquery' }>,
  row: EvalContext,
  state: EvalState
): Promise<unknown> {
  const rows = await evaluateData(expr.query, state, row);
  return expr.mode === 'many' ? rows : rows[0];
}

async function filterAsync<T>(
  items: readonly T[],
  predicate: (item: T) => Promise<boolean>
): Promise<readonly T[]> {
  const decisions = await Promise.all(items.map(predicate));
  return items.filter((_, index) => decisions[index]);
}

async function everyAsync<T>(
  items: readonly T[],
  predicate: (item: T) => Promise<boolean>
): Promise<boolean> {
  for (const item of items) {
    if (!await predicate(item)) {
      return false;
    }
  }
  return true;
}

async function someAsync<T>(
  items: readonly T[],
  predicate: (item: T) => Promise<boolean>
): Promise<boolean> {
  for (const item of items) {
    if (await predicate(item)) {
      return true;
    }
  }
  return false;
}

function setUnion(inputs: readonly (readonly EvalContext[])[]): readonly EvalContext[] {
  const seen = new Set<string>();
  const output: EvalContext[] = [];

  for (const rows of inputs) {
    for (const row of rows) {
      const key = stableKey(row);
      if (!seen.has(key)) {
        seen.add(key);
        output.push(row);
      }
    }
  }

  return output;
}

function setIntersection(inputs: readonly (readonly EvalContext[])[]): readonly EvalContext[] {
  if (inputs.length === 0) {
    return [];
  }

  const rightKeys = inputs.slice(1).map((rows) => new Set(rows.map(stableKey)));
  const emitted = new Set<string>();
  const firstInput = inputs[0] ?? [];
  return firstInput.filter((row) => {
    const key = stableKey(row);
    if (emitted.has(key) || rightKeys.some((keys) => !keys.has(key))) {
      return false;
    }
    emitted.add(key);
    return true;
  });
}

function setDifference(left: readonly EvalContext[], right: readonly EvalContext[]): readonly EvalContext[] {
  const rightKeys = new Set(right.map(stableKey));
  const emitted = new Set<string>();

  return left.filter((row) => {
    const key = stableKey(row);
    if (emitted.has(key) || rightKeys.has(key)) {
      return false;
    }
    emitted.add(key);
    return true;
  });
}

function renameRow(row: EvalContext, fields: Record<string, string>): EvalContext {
  const output = { ...row };
  for (const [oldName, newName] of Object.entries(fields)) {
    if (Object.hasOwn(output, oldName)) {
      output[newName] = output[oldName];
      delete output[oldName];
    }
  }
  return output;
}

function pickFields(row: Record<string, unknown>, fields: readonly string[] | undefined): Record<string, unknown> {
  if (fields === undefined) {
    return row;
  }

  return Object.fromEntries(fields.map((field) => [field, row[field]]));
}

function isIterable(input: unknown): input is Iterable<unknown> {
  return typeof input === 'object' &&
    input !== null &&
    typeof (input as { readonly [Symbol.iterator]?: unknown })[Symbol.iterator] === 'function';
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === 'object' && input !== null && !Array.isArray(input);
}

function projectionExpr(item: ProjectionData[string]): ExprData {
  return isOptionalProjection(item) ? item.expr : item;
}

function isOptionalProjection(
  item: ProjectionData[string]
): item is Extract<ProjectionData[string], { readonly kind: 'optionalProjection' }> {
  return 'kind' in item && item.kind === 'optionalProjection';
}

function keyPart(value: unknown): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  switch (typeof value) {
    case 'string':
      return value;
    case 'number':
    case 'boolean':
    case 'bigint':
      return value.toString();
    default:
      return stableKey(value);
  }
}
