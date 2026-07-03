import {
  aggregate,
  and,
  any,
  asc,
  avg,
  btree,
  callMaybe,
  clauses,
  constRows,
  count,
  countDistinct,
  desc,
  difference,
  eq,
  expand,
  field,
  from,
  getKey,
  gt,
  gte,
  hash,
  hostFn,
  ifElse,
  intersection,
  join,
  leftJoin,
  lookup as lookupQuery,
  lt,
  lte,
  max,
  min,
  neq,
  not,
  notAny,
  or,
  pipe,
  project,
  qualify,
  rename,
  sort,
  sortLimit,
  sum,
  extend as extendQuery,
  uniqueIndex,
  where,
  without,
  union,
  type ExprData,
  type HostExpressionFunction,
  type HostFunction,
  type PredicateData,
  type PrimitiveValue,
  type ProjectionData,
  type Query,
  type QueryData,
  type SortData
} from './query.js';
import {
  deleteExact,
  deleteRows,
  insert,
  insertIgnore,
  insertOrMerge,
  insertOrReplace,
  insertOrUpdate,
  replaceAll,
  update,
  type RelationRowUpdateInput,
  type WritePatch
} from './write.js';
import type { RelationRef } from './schema.js';

type RelicRelationTarget = RelationRef<Record<string, unknown>> | Query<Record<string, unknown>>;
type RelicResolverRecord = Readonly<Record<string, RelicRelationTarget | undefined>>;
type RelicResolverFunction = (name: string) => RelicRelationTarget | undefined;
type RelicResolverObject = {
  readonly resolveRelation: RelicResolverFunction;
};

export type RelicParseErrorCode =
  | 'relic_invalid'
  | 'relic_unsupported'
  | 'relic_relation_missing'
  | 'relic_function_missing';
export type RelicParseErrorPath = readonly (string | number)[];
export type RelicResolver = RelicResolverRecord | RelicResolverFunction | RelicResolverObject;
export type RelicExprContext = {
  readonly alias?: string;
  readonly functions?: Readonly<Record<string, HostFunction | HostExpressionFunction | undefined>>;
};

export class RelicParseError extends Error {
  readonly code: RelicParseErrorCode;
  readonly path: RelicParseErrorPath;
  readonly form: unknown;

  constructor(
    message: string,
    form: unknown,
    options: {
      readonly code?: RelicParseErrorCode;
      readonly path?: RelicParseErrorPath;
    } = {}
  ) {
    super(message);
    this.name = 'RelicParseError';
    this.code = options.code ?? 'relic_unsupported';
    this.path = options.path ?? [];
    this.form = form;
  }
}

export function fromRelicQuery(form: unknown, resolver: RelicResolver): Query<Record<string, unknown>> {
  if (isQuery(form)) return form;
  if (isLikelyEdnText(form)) unsupported('EDN text parsing is not supported; pass parsed JS arrays/objects', form);

  const queryClauses = relicQueryClauses(form);
  let current: Query<Record<string, unknown>> | undefined;

  for (const clause of queryClauses) {
    const [rawOp, ...args] = relicClause(clause);
    const op = relicOp(rawOp);

    switch (op) {
      case 'from':
        requireNoCurrent(current, clause);
        current = parseFrom(args, resolver, clause);
        break;
      case 'const':
        requireNoCurrent(current, clause);
        current = parseConst(args, clause);
        break;
      case 'where':
        current = pipe(requireCurrent(current, clause), where(parseWhere(args, clause)));
        break;
      case 'select':
        current = pipe(requireCurrent(current, clause), project(parseProjection(args, clause)));
        break;
      case 'extend':
        current = pipe(requireCurrent(current, clause), extendQuery(parseProjection(args, clause)));
        break;
      case 'without':
        current = pipe(requireCurrent(current, clause), without(...args.map((item) => fieldName(item, clause))));
        break;
      case 'expand':
        current = parseExpand(current, args, clause);
        break;
      case 'rename':
        current = pipe(requireCurrent(current, clause), rename(parseRename(args, clause)));
        break;
      case 'qualify':
        requireArity(args, 1, clause);
        current = pipe(requireCurrent(current, clause), qualify(fieldName(args[0], clause)));
        break;
      case 'sort':
        current = pipe(requireCurrent(current, clause), sort(...parseSort(args, clause)));
        break;
      case 'sort-limit':
        current = parseSortLimit(current, args, clause);
        break;
      case 'hash':
        current = pipe(requireCurrent(current, clause), hash(parseSingleExpression(args, clause)));
        break;
      case 'btree':
        current = pipe(requireCurrent(current, clause), btree(parseSingleExpression(args, clause)));
        break;
      case 'unique':
        current = pipe(requireCurrent(current, clause), uniqueIndex(parseSingleExpression(args, clause)));
        break;
      case 'join':
        current = pipe(requireCurrent(current, clause), join(parseQueryOperand(args[0], resolver, clause), parseJoinOn(args[1], clause) as PredicateData));
        break;
      case 'left-join':
        current = pipe(requireCurrent(current, clause), leftJoin(parseQueryOperand(args[0], resolver, clause), parseJoinOn(args[1], clause) as PredicateData));
        break;
      case 'agg':
        current = pipe(requireCurrent(current, clause), aggregate(parseAggregate(args, clause)));
        break;
      case 'union':
        current = parseSetOp('union', current, args, resolver, clause);
        break;
      case 'intersection':
        current = parseSetOp('intersection', current, args, resolver, clause);
        break;
      case 'difference':
        current = parseSetOp('difference', current, args, resolver, clause);
        break;
      case 'lookup':
        requireNoCurrent(current, clause);
        current = parseLookup(args, resolver, clause);
        break;
      default:
        unsupported(`Unsupported Relic query op "${displayOp(rawOp)}"`, clause);
    }
  }

  return requireCurrent(current, form);
}

export function fromRelicExpr(form: unknown, ctx: RelicExprContext = {}): ExprData {
  if (isExpr(form)) return form;

  if (isKeyword(form)) return field(ctx.alias ?? 'row', keywordName(form));
  if (isLikelyEdnText(form)) unsupported('EDN text parsing is not supported; pass parsed JS arrays/objects', form);
  if (isPrimitive(form)) return { op: 'value', value: form };
  if (!Array.isArray(form)) unsupported('Relic expression forms must be primitives, keywords, or call arrays', form);
  if (form.length === 0) unsupported('Relic expression call arrays must not be empty', form);

  const [rawOp, ...args] = form;
  const op = relicOp(rawOp);

  switch (op) {
    case '=':
      return comparison('=', args, form);
    case 'not=':
    case '!=':
      return comparison('!=', args, form);
    case '<':
      return comparison('<', args, form);
    case '<=':
      return comparison('<=', args, form);
    case '>':
      return comparison('>', args, form);
    case '>=':
      return comparison('>=', args, form);
    case 'and':
      return and(...args.map((arg) => predicate(arg, ctx)));
    case 'or':
      return or(...args.map((arg) => predicate(arg, ctx)));
    case 'not':
      requireArity(args, 1, form);
      return not(predicate(args[0], ctx));
    case 'if':
      requireArityRange(args, 2, 3, form);
      return ifElse(
        predicate(args[0], ctx),
        fromRelicExpr(args[1], ctx),
        args.length === 3 ? fromRelicExpr(args[2], ctx) : undefined
      );
    case '?':
      return parseHostCallMaybe(args, ctx, form);
    case 'rel/get':
    case ':rel/get':
    case 'com.wotbrew.relic/get':
      return parseGetKey(args, ctx, form);
    case 'count':
      if (args.length === 0) return count();
      requireArity(args, 1, form);
      return count(predicate(args[0], ctx));
    case 'rel/sum':
      requireArity(args, 1, form);
      return sum(fromRelicExpr(args[0], ctx) as ExprData<number>);
    case 'rel/avg':
      requireArity(args, 1, form);
      return avg(fromRelicExpr(args[0], ctx) as ExprData<number>);
    case 'min':
      requireArity(args, 1, form);
      return min(fromRelicExpr(args[0], ctx));
    case 'max':
      requireArity(args, 1, form);
      return max(fromRelicExpr(args[0], ctx));
    case 'rel/count-distinct':
      if (args.length === 0) return countDistinct();
      requireArity(args, 1, form);
      return countDistinct(fromRelicExpr(args[0], ctx));
    case 'rel/any':
      requireArity(args, 1, form);
      return any(predicate(args[0], ctx));
    case 'rel/not-any':
      requireArity(args, 1, form);
      return notAny(predicate(args[0], ctx));
    case 'rel/sel':
    case 'rel/sel1':
      unsupported(`Relic subquery expression ${displayOp(rawOp)} is not supported by the compatibility parser`, form);
      break;
    case ':':
    case '_':
      unsupported('Relic escape forms are not supported by the compatibility parser', form);
      break;
    default:
      return parseHostCall(op, rawOp, args, ctx, form);
  }
}

export function fromRelicTx(form: unknown, resolver: RelicResolver): readonly WritePatch[] {
  if (isLikelyEdnText(form)) unsupported('EDN text parsing is not supported; pass parsed JS arrays/objects', form);
  if (typeof form === 'function') unsupported('Function-valued transaction forms are not supported', form);
  if (isPlainRecord(form)) return seedMapPatches(form, resolver);
  if (!Array.isArray(form)) unsupported('Relic transaction forms must be op arrays, arrays of ops, or seed maps', form);
  if (form.length === 0) return [];

  if (Array.isArray(form[0])) return form.flatMap((item) => fromRelicTx(item, resolver));

  const [rawOp, rawRelation, ...args] = form;
  const op = relicOp(rawOp);

  switch (op) {
    case 'insert':
      return rowArgs(args, form).map((row) => insert(resolveRelationRef(rawRelation, resolver, form), row));
    case 'insert-ignore':
      return rowArgs(args, form).map((row) => insertIgnore(resolveRelationRef(rawRelation, resolver, form), row));
    case 'insert-or-replace':
      return rowArgs(args, form).map((row) => insertOrReplace(resolveRelationRef(rawRelation, resolver, form), row));
    case 'update': {
      requireArity(args, 2, form);
      return [update(resolveRelationRef(rawRelation, resolver, form), predicate(args[1]), changeMap(args[0], form))];
    }
    case 'delete': {
      requireArity(args, 1, form);
      return [deleteRows(resolveRelationRef(rawRelation, resolver, form), predicate(args[0]))];
    }
    case 'delete-exact':
      return rowArgs(args, form).map((row) => deleteExact(resolveRelationRef(rawRelation, resolver, form), row));
    case 'replace-all':
      return [replaceAll(resolveRelationRef(rawRelation, resolver, form), rowArgs(args, form))];
    case 'insert-or-merge':
      return parseInsertOrMerge(rawRelation, args, resolver, form);
    case 'insert-or-update':
      return parseInsertOrUpdate(rawRelation, args, resolver, form);
    default:
      unsupported(`Unsupported Relic transaction op "${displayOp(rawOp)}"`, form);
  }
}

function parseFrom(args: readonly unknown[], resolver: RelicResolver, form: unknown): Query<Record<string, unknown>> {
  requireArity(args, 1, form);
  return parseQueryOperand(args[0], resolver, form);
}

function parseConst(args: readonly unknown[], form: unknown): Query<Record<string, unknown>> {
  if (args.length === 0) unsupported('Relic :const requires rows', form);
  return constRows(rowArgs(args, form));
}

function parseLookup(args: readonly unknown[], resolver: RelicResolver, form: unknown): Query<Record<string, unknown>> {
  if (args.length === 2) return parseIndexedLookup(args, resolver, form);
  if (args.length === 3) {
    const relation = resolveRelationRef(args[0], resolver, form);
    return lookupQuery(relation, fieldName(args[1], form), args[2]);
  }

  invalid('Relic :lookup expects [indexed-query value] or [relation field value]', form);
}

function parseIndexedLookup(
  args: readonly unknown[],
  resolver: RelicResolver,
  form: unknown
): Query<Record<string, unknown>> {
  const indexed = parseQueryOperand(args[0], resolver, form);
  const indexedData = indexed.data;

  if (indexedData.op !== 'hash' && indexedData.op !== 'uniqueIndex' && indexedData.op !== 'btree') {
    unsupported('Relic :lookup expects a query with a :hash, :unique, or :btree index declaration', form);
  }

  const expressions = indexedData.expressions;
  if (!Array.isArray(expressions) || expressions.length !== 1 || !isExpr(expressions[0])) {
    invalid('Relic :lookup requires a single index expression', form);
  }

  const inputData = indexedData.input;
  if (!isQueryData(inputData)) invalid('Relic :lookup index declarations must wrap a query input', form);

  const inputQuery: Query<Record<string, unknown>> = {
    data: inputData,
    relations: indexed.relations
  };
  const lookupValue = args[1];
  const directLookup = directRelationLookup(inputQuery, expressions[0], lookupValue);
  if (directLookup !== undefined) return directLookup;

  return pipe(inputQuery, where(eq(expressions[0], parseLookupLiteral(lookupValue, form))));
}

function parseLookupLiteral(input: unknown, form: unknown): PrimitiveValue {
  if (isPrimitive(input)) return input;
  invalid('Relic :lookup compatibility values must be primitive literals', form);
}

function directRelationLookup(
  query: Query<Record<string, unknown>>,
  expression: ExprData,
  lookupValue: unknown
): Query<Record<string, unknown>> | undefined {
  if (!isFieldExpression(expression) || query.data.op !== 'from') return undefined;
  if (expression.alias !== 'row' && expression.alias !== query.data.alias) return undefined;
  if (typeof query.data.relation !== 'string') return undefined;

  const relation = query.relations[query.data.relation];
  return isRelationRef(relation)
    ? lookupQuery(relation, expression.field, lookupValue)
    : undefined;
}

function parseWhere(args: readonly unknown[], form: unknown): PredicateData {
  if (args.length === 0) unsupported('Relic :where requires at least one predicate', form);
  return args.length === 1 ? predicate(args[0]) : and(...args.map((arg) => predicate(arg)));
}

function parseJoinOn(input: unknown, form: unknown): PredicateData | ReturnType<typeof clauses> {
  if (isPlainRecord(input)) return clauses(joinClauseMap(input));
  return predicate(input, {}, form);
}

function parseExpand(
  current: Query<Record<string, unknown>> | undefined,
  args: readonly unknown[],
  form: unknown
): Query<Record<string, unknown>> {
  if (args.length === 0) unsupported('Relic :expand requires at least one [binding expr] pair', form);

  return args.reduce<Query<Record<string, unknown>>>((query, item) => {
    const [binding, exprForm] = expandBinding(item);
    return pipe(query, expand(fromRelicExpr(exprForm), expandOptions(binding, item)));
  }, requireCurrent(current, form));
}

function expandBinding(input: unknown): readonly [unknown, unknown] {
  if (!Array.isArray(input) || input.length !== 2) {
    unsupported('Relic :expand entries must be [binding expr] pairs', input);
  }
  return [input[0], input[1]];
}

function expandOptions(binding: unknown, form: unknown): { readonly as?: string; readonly fields?: readonly string[] } {
  if (isStar(binding)) {
    unsupported('Relic :expand :* does not map to Tarstate expand options; use a field vector or alias binding', form);
  }

  if (Array.isArray(binding)) return { fields: binding.map((item) => fieldName(item, form)) };
  return { as: fieldName(binding, form) };
}

function parseRename(args: readonly unknown[], form: unknown): Record<string, string> {
  requireArity(args, 1, form);
  if (!isPlainRecord(args[0])) invalid('Relic :rename requires a plain object map', form);

  return Object.fromEntries(
    Object.entries(args[0]).map(([fromName, toName]) => [fieldName(fromName, form), fieldName(toName, form)])
  );
}

function parseSortLimit(
  current: Query<Record<string, unknown>> | undefined,
  args: readonly unknown[],
  form: unknown
): Query<Record<string, unknown>> {
  if (args.length === 0 || typeof args[0] !== 'number' || !Number.isFinite(args[0])) {
    invalid('Relic :sort-limit requires a finite numeric count', form);
  }

  const [countValue, ...order] = args;
  return pipe(requireCurrent(current, form), sortLimit(Math.max(0, countValue), ...parseSort(order, form)));
}

function parseSort(args: readonly unknown[], form: unknown): readonly SortData[] {
  if (args.length === 0) unsupported('Relic :sort requires at least one sort expression', form);
  return args.map((item) => parseSortItem(item));
}

function parseSortItem(input: unknown): SortData {
  if (Array.isArray(input)) {
    if (input.length === 1) return asc(fromRelicExpr(input[0]));

    const direction = sortDirection(input[1]);
    if (direction === undefined) return asc(fromRelicExpr(input));

    if (input.length > 3) {
      invalid('Relic sort entries must be expr or [expr direction ?nulls]', input);
    }
    const [exprForm, , nullsForm] = input;
    const nulls = nullsForm === undefined ? undefined : sortNulls(nullsForm);

    if (nulls === undefined && nullsForm !== undefined) invalid('Relic sort nulls order must be :first or :last', input);

    return direction === 'desc'
      ? desc(fromRelicExpr(exprForm), nulls)
      : asc(fromRelicExpr(exprForm), nulls);
  }

  return asc(fromRelicExpr(input));
}

function sortDirection(input: unknown): 'asc' | 'desc' | undefined {
  if (typeof input !== 'string') return undefined;
  const name = keywordName(input);
  return name === 'asc' || name === 'desc' ? name : undefined;
}

function sortNulls(input: unknown): 'first' | 'last' | undefined {
  if (typeof input !== 'string') return undefined;
  const name = keywordName(input);
  return name === 'first' || name === 'last' ? name : undefined;
}

function parseSingleExpression(args: readonly unknown[], form: unknown): ExprData {
  requireArity(args, 1, form);
  return fromRelicExpr(args[0]);
}

function parseSetOp(
  op: 'union' | 'intersection' | 'difference',
  current: Query<Record<string, unknown>> | undefined,
  args: readonly unknown[],
  resolver: RelicResolver,
  form: unknown
): Query<Record<string, unknown>> {
  const inputs = current === undefined
    ? args.map((arg) => parseQueryOperand(arg, resolver, form))
    : [current, ...args.map((arg) => parseQueryOperand(arg, resolver, form))];

  if (inputs.length < 2) unsupported(`Relic :${op} requires two or more inputs`, form);
  if (op === 'union') return union(...inputs);
  if (op === 'intersection') return intersection(...inputs);

  const [first, ...rest] = inputs;
  if (first === undefined) unsupported('Relic :difference requires a left input', form);
  return rest.reduce<Query<Record<string, unknown>>>((left, right) => difference(left, right), first);
}

function parseAggregate(args: readonly unknown[], form: unknown): { readonly groupBy?: ProjectionData; readonly aggregates: ProjectionData } {
  if (args.length === 0) unsupported('Relic :agg requires aggregate bindings', form);

  const [first, ...rest] = args;
  const hasGroupBy = isGroupByVector(first);
  const aggregateArgs = hasGroupBy ? rest : args;
  const aggregates = parseProjection(aggregateArgs, form);

  if (Object.keys(aggregates).length === 0) unsupported('Relic :agg requires at least one aggregate binding', form);
  return hasGroupBy
    ? { groupBy: groupByProjection(first, form), aggregates }
    : { aggregates };
}

function parseProjection(args: readonly unknown[], form: unknown): ProjectionData {
  if (args.length === 0) unsupported('Relic projection requires at least one field or binding', form);

  const projection: Record<string, ExprData> = {};
  const items = args.length === 1 && isPlainRecord(args[0])
    ? Object.entries(args[0]).map(([key, value]) => [key, value] as const)
    : args;

  for (const item of items) {
    const [name, exprForm] = projectionBinding(item, form);
    projection[name] = fromRelicExpr(exprForm);
  }

  return projection;
}

function groupByProjection(input: unknown, form: unknown): ProjectionData {
  if (!Array.isArray(input)) unsupported('Relic :agg group-by must be an array', form);
  const projection: Record<string, ExprData> = {};

  for (const item of input) {
    const name = fieldName(item, form);
    projection[name] = field('row', name);
  }

  return projection;
}

function projectionBinding(item: unknown, form: unknown): readonly [string, unknown] {
  if (Array.isArray(item)) {
    if (item.length !== 2) unsupported('Relic projection bindings must be [field expr] pairs', item);
    return [fieldName(item[0], item), item[1]];
  }

  if (typeof item === 'string') {
    const name = fieldName(item, form);
    return [name, keyword(name)];
  }

  unsupported('Relic projection entries must be keywords or [field expr] pairs', item);
}

function parseQueryOperand(input: unknown, resolver: RelicResolver, form: unknown): Query<Record<string, unknown>> {
  if (isQuery(input)) return input;
  if (isRelationRef(input)) return from(input);
  if (isRelicQueryForm(input)) return fromRelicQuery(input, resolver);
  if (typeof input === 'string') {
    const resolved = resolveRelationTarget(input, resolver, form);
    return isQuery(resolved) ? resolved : from(resolved);
  }

  unsupported('Relic query operands must be relation keywords, relation refs, queries, or query arrays', input);
}

function comparison(op: '=' | '!=' | '<' | '<=' | '>' | '>=', args: readonly unknown[], form: unknown): PredicateData {
  requireArity(args, 2, form);
  const left = fromRelicExpr(args[0]);
  const right = fromRelicExpr(args[1]);

  switch (op) {
    case '=':
      return eq(left, right);
    case '!=':
      return neq(left, right);
    case '<':
      return lt(left, right);
    case '<=':
      return lte(left, right);
    case '>':
      return gt(left, right);
    case '>=':
      return gte(left, right);
  }
}

function parseHostCall(
  op: string,
  rawOp: unknown,
  args: readonly unknown[],
  ctx: RelicExprContext,
  form: unknown
): ExprData {
  return {
    op: 'call',
    fn: hostFunctionFor(op, rawOp, ctx, form),
    args: args.map((arg) => fromRelicExpr(arg, ctx))
  };
}

function parseHostCallMaybe(args: readonly unknown[], ctx: RelicExprContext, form: unknown): ExprData {
  if (args.length === 0) invalid('Relic :? requires a registered host call name', form);
  const [rawOp, ...callArgs] = args;
  const op = relicOp(rawOp);
  return callMaybe(
    hostFunctionFor(op, rawOp, ctx, form),
    ...callArgs.map((arg) => fromRelicExpr(arg, ctx))
  );
}

function hostFunctionFor(
  op: string,
  rawOp: unknown,
  ctx: RelicExprContext,
  form: unknown
): HostFunction {
  const fn = ctx.functions?.[op];
  if (fn === undefined) {
    functionMissing(`Unregistered Relic host call "${displayOp(rawOp)}" is not supported`, form);
  }

  return typeof fn === 'function' ? hostFn(op, fn) : fn;
}

function parseGetKey(args: readonly unknown[], ctx: RelicExprContext, form: unknown): ExprData {
  requireArity(args, 2, form);
  return getKey(fromRelicExpr(args[0], ctx), getKeyInput(args[1], ctx, form));
}

function getKeyInput(input: unknown, ctx: RelicExprContext, form: unknown): string | number | ExprData<string | number> {
  if (typeof input === 'string') return keywordName(input);
  if (typeof input === 'number') return input;
  if (Array.isArray(input)) return fromRelicExpr(input, ctx) as ExprData<string | number>;
  invalid('Relic rel/get keys must be strings, numbers, or expression arrays', form);
}

function predicate(input: unknown, ctx: RelicExprContext = {}, _form: unknown = input): PredicateData {
  return fromRelicExpr(input, ctx) as PredicateData;
}

function seedMapPatches(input: Record<string, unknown>, resolver: RelicResolver): readonly WritePatch[] {
  return Object.entries(input).flatMap(([relationName, rows]) =>
    rowArgs([rows], input).map((row) => insert(resolveRelationRef(relationName, resolver, input), row))
  );
}

function parseInsertOrMerge(
  rawRelation: unknown,
  args: readonly unknown[],
  resolver: RelicResolver,
  form: unknown
): readonly WritePatch[] {
  if (args.length < 2) invalid('Relic :insert-or-merge requires a merge binding and at least one row', form);
  const [binding, ...rows] = args;
  const relation = resolveRelationRef(rawRelation, resolver, form);
  const merge = mergeBinding(binding, form);

  return rowArgs(rows, form).map((row) =>
    merge === undefined
      ? insertOrMerge(relation, row)
      : insertOrMerge(relation, row, { merge })
  );
}

function mergeBinding(input: unknown, form: unknown): readonly string[] | undefined {
  if (isStar(input)) return undefined;
  if (Array.isArray(input)) return input.map((item) => fieldName(item, form));
  unsupported('Relic :insert-or-merge supports only :* or a field vector in the compatibility parser', form);
}

function parseInsertOrUpdate(
  rawRelation: unknown,
  args: readonly unknown[],
  resolver: RelicResolver,
  form: unknown
): readonly WritePatch[] {
  if (args.length < 2) invalid('Relic :insert-or-update requires an update map and at least one row', form);
  const [changes, ...rows] = args;
  const relation = resolveRelationRef(rawRelation, resolver, form);
  const updateMap = changeMap(changes, form);

  return rowArgs(rows, form).map((row) => insertOrUpdate(relation, row, { update: updateMap }));
}

function rowArgs(args: readonly unknown[], form: unknown): readonly Record<string, unknown>[] {
  if (args.length === 0) unsupported('Relic write op requires at least one row', form);
  if (args.length === 1) return rowsFrom(args[0], form);
  return args.flatMap((arg) => rowsFrom(arg, form));
}

function rowsFrom(input: unknown, form: unknown): readonly Record<string, unknown>[] {
  const values = input instanceof Set ? Array.from(input) : Array.isArray(input) ? input : [input];

  return values.map((value) => {
    if (!isPlainRecord(value)) unsupported('Relic rows must be plain objects', form);
    return normalizeRecord(value);
  });
}

function changeMap(input: unknown, form: unknown): RelationRowUpdateInput<RelationRef> {
  if (typeof input === 'function') unsupported('Function-valued Relic update forms are not supported', form);
  if (!isPlainRecord(input)) unsupported('Relic :update changes must be a plain object', form);

  const changes: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (typeof value === 'function') unsupported('Function-valued Relic update changes are not supported', form);
    changes[fieldName(key, form)] = shouldParseUpdateExpr(value) ? fromRelicExpr(value) : value;
  }
  return changes;
}

function shouldParseUpdateExpr(input: unknown): boolean {
  return isKeyword(input) || Array.isArray(input);
}

function joinClauseMap(input: Record<string, unknown>): Record<string, string> {
  return Object.fromEntries(Object.entries(input).map(([key, value]) => [fieldName(key, input), fieldName(value, input)]));
}

function resolveRelationRef(input: unknown, resolver: RelicResolver, form: unknown): RelationRef<Record<string, unknown>> {
  const resolved = resolveRelationTarget(input, resolver, form);
  if (isQuery(resolved)) unsupported('Relic transaction relation operands must resolve to relation refs, not queries', form);
  return resolved;
}

function resolveRelationTarget(input: unknown, resolver: RelicResolver, form: unknown): RelicRelationTarget {
  if (isRelationRef(input) || isQuery(input)) return input;
  if (typeof input !== 'string') unsupported('Relic relation names must be keywords or strings', input);

  const name = keywordName(input);
  const candidates = [name, keyword(name), input];
  let resolved: RelicRelationTarget | undefined;

  if (typeof resolver === 'function') {
    for (const candidate of candidates) {
      resolved = resolver(candidate);
      if (resolved !== undefined) break;
    }
  } else if ('resolveRelation' in resolver && typeof resolver.resolveRelation === 'function') {
    for (const candidate of candidates) {
      resolved = resolver.resolveRelation(candidate);
      if (resolved !== undefined) break;
    }
  } else {
    const recordResolver = resolver as RelicResolverRecord;
    for (const candidate of candidates) {
      resolved = recordResolver[candidate];
      if (resolved !== undefined) break;
    }
  }

  if (!isRelationRef(resolved) && !isQuery(resolved)) {
    relationMissing(`Relic relation "${input}" could not be resolved`, form);
  }

  return resolved;
}

function relicQueryClauses(form: unknown): readonly unknown[] {
  if (!Array.isArray(form) || form.length === 0) invalid('Relic queries must be non-empty arrays of clauses', form);
  if (!form.every(Array.isArray)) invalid('Relic queries must be arrays of clause arrays', form);
  return form;
}

function relicClause(form: unknown): readonly unknown[] {
  if (!Array.isArray(form) || form.length === 0) invalid('Relic query clauses must be non-empty arrays', form);
  return form;
}

function isRelicQueryForm(input: unknown): boolean {
  return Array.isArray(input) && input.length > 0 && input.every(Array.isArray);
}

function isGroupByVector(input: unknown): input is readonly unknown[] {
  return Array.isArray(input) && input.every((item) => typeof item === 'string');
}

function requireNoCurrent(current: Query<Record<string, unknown>> | undefined, form: unknown): void {
  if (current !== undefined) unsupported('Relic :from and :const must be the first query clause in this compatibility parser', form);
}

function requireCurrent(current: Query<Record<string, unknown>> | undefined, form: unknown): Query<Record<string, unknown>> {
  if (current === undefined) unsupported('Relic query transform requires an input relation', form);
  return current;
}

function requireArity(args: readonly unknown[], expected: number, form: unknown): void {
  if (args.length !== expected) invalid(`Relic form expected ${expected} argument(s), got ${args.length}`, form);
}

function requireArityRange(args: readonly unknown[], min: number, max: number, form: unknown): void {
  if (args.length < min || args.length > max) {
    invalid(`Relic form expected ${min}-${max} argument(s), got ${args.length}`, form);
  }
}

function fieldName(input: unknown, form: unknown): string {
  if (typeof input !== 'string') invalid('Relic field names must be keywords or strings', form);
  const name = keywordName(input);
  if (name === '') invalid('Relic field names must not be empty', form);
  return name;
}

function relicOp(input: unknown): string {
  if (typeof input !== 'string') invalid('Relic ops must be keywords or strings', input);
  return keywordName(input);
}

function keywordName(input: string): string {
  return input.startsWith(':') ? input.slice(1) : input;
}

function keyword(name: string): string {
  return name.startsWith(':') ? name : ':' + name;
}

function isStar(input: unknown): boolean {
  return typeof input === 'string' && ['*', ':*', '::rel/*', ':com.wotbrew.relic/*'].includes(input);
}

function displayOp(input: unknown): string {
  return typeof input === 'string' ? input : String(input);
}

function unsupported(message: string, form: unknown): never {
  throw new RelicParseError(message, form, { code: 'relic_unsupported' });
}

function invalid(message: string, form: unknown): never {
  throw new RelicParseError(message, form, { code: 'relic_invalid' });
}

function relationMissing(message: string, form: unknown): never {
  throw new RelicParseError(message, form, { code: 'relic_relation_missing' });
}

function functionMissing(message: string, form: unknown): never {
  throw new RelicParseError(message, form, { code: 'relic_function_missing' });
}

function normalizeRecord(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(input).map(([key, value]) => [fieldName(key, input), value]));
}

function isKeyword(input: unknown): input is string {
  return typeof input === 'string' && input.startsWith(':');
}

function isPrimitive(input: unknown): input is string | number | boolean | null | undefined {
  return input === null || input === undefined || typeof input === 'string' || typeof input === 'number' || typeof input === 'boolean';
}

function isLikelyEdnText(input: unknown): boolean {
  return typeof input === 'string' && /^\s*[[{(]/.test(input);
}

function isExpr(input: unknown): input is ExprData {
  return isPlainRecord(input) && typeof input.op === 'string';
}

function isFieldExpression(input: ExprData): input is ExprData & { readonly op: 'field'; readonly alias: string; readonly field: string } {
  return input.op === 'field'
    && typeof input.alias === 'string'
    && typeof input.field === 'string';
}

function isRelationRef(input: unknown): input is RelationRef<Record<string, unknown>> {
  return isPlainRecord(input) && input.kind === 'relation' && typeof input.name === 'string';
}

function isQuery(input: unknown): input is Query<Record<string, unknown>> {
  return isPlainRecord(input) && isPlainRecord(input.data) && isPlainRecord(input.relations);
}

function isQueryData(input: unknown): input is QueryData {
  return isPlainRecord(input) && typeof input.op === 'string';
}

function isPlainRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === 'object'
    && input !== null
    && !Array.isArray(input)
    && (Object.getPrototypeOf(input) === Object.prototype || Object.getPrototypeOf(input) === null);
}
