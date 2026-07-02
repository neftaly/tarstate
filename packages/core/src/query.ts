import { stableValue } from './identity.js';
import type { RelationRef } from './schema.js';

// Phantom value type; keeps field refs typed without adding runtime data.
declare const fieldValue: unique symbol;
const subqueryRelations: unique symbol = Symbol('tarstate.subqueryRelations');
const hostFunctionId: unique symbol = Symbol('tarstate.hostFunctionId');

export type HostExpressionFunction<Value = unknown> = (...args: readonly unknown[]) => Value;

/** Canonical expression data produced by query constructors. */
export type ExprData<Value = unknown> =
  | { readonly op: 'field'; readonly alias: string; readonly field: string; readonly [fieldValue]?: Value }
  | { readonly op: 'value'; readonly value: Value; readonly [fieldValue]?: Value }
  | { readonly op: 'env'; readonly name: string; readonly [fieldValue]?: Value }
  | { readonly op: 'call'; readonly name: string; readonly args: readonly ExprData[]; readonly [fieldValue]?: Value }
  | {
      readonly op: 'hostCall';
      readonly id: string;
      readonly name: string;
      readonly args: readonly ExprData[];
      readonly fn?: HostExpressionFunction<Value>;
      readonly [fieldValue]?: Value;
    }
  | { readonly op: 'tuple'; readonly items: readonly ExprData[]; readonly [fieldValue]?: Value }
  | {
      readonly op: 'subquery';
      readonly mode: 'many' | 'one';
      readonly query: QueryData;
      readonly [subqueryRelations]?: Record<string, RelationRef>;
      readonly [fieldValue]?: Value;
    }
  | {
      readonly op: 'aggregateCall';
      readonly name: AggregateFunction;
      readonly expr?: ExprData;
      readonly distinct: boolean;
      readonly count?: number;
      readonly [fieldValue]?: Value;
    };

export type PrimitiveValue = string | number | boolean | null | undefined;
export type ExprInput<Value = unknown> = ExprData<Value> | PrimitiveValue;

export type ComparisonOp = 'eq' | 'neq' | 'lt' | 'lte' | 'gt' | 'gte';
export type AggregateFunction =
  | 'count'
  | 'sum'
  | 'avg'
  | 'min'
  | 'max'
  | 'any'
  | 'notAny'
  | 'setConcat'
  | 'top'
  | 'bottom'
  | 'topBy'
  | 'bottomBy'
  | 'maxBy'
  | 'minBy';

/** Canonical predicate data used by filters and joins. */
export type PredicateData =
  | { readonly op: ComparisonOp; readonly left: ExprData; readonly right: ExprData }
  | { readonly op: 'and'; readonly predicates: readonly PredicateData[] }
  | { readonly op: 'or'; readonly predicates: readonly PredicateData[] }
  | { readonly op: 'not'; readonly predicate: PredicateData };

/** Canonical projection map for selected result rows. */
export type ProjectionData = Record<string, ExprData | OptionalProjection>;

/** Projection marker for nullable rows introduced by left joins. */
export type OptionalProjection<Value = unknown> = {
  readonly kind: 'optionalProjection';
  readonly expr: ExprData<Value>;
};

export type SortDirection = 'asc' | 'desc';
export type NullSortOrder = 'first' | 'last';
export type SortData = {
  readonly expr: ExprData;
  readonly direction: SortDirection;
  readonly nulls?: NullSortOrder;
};
export type SortInput = ExprInput | SortData;
type AggregateCallOptions = {
  readonly distinct?: boolean;
  readonly count?: number;
};
export type AggregateConfig<GroupBy extends ProjectionShape, Aggregates extends ProjectionShape> = {
  readonly groupBy?: GroupBy;
  readonly aggregates: Aggregates;
};
export type ExpandOptions<
  Alias extends string | undefined = string | undefined,
  Fields extends readonly string[] | undefined = readonly string[] | undefined
> = {
  readonly as?: Alias;
  readonly fields?: Fields;
};

/** Canonical query tree inspected by planners and evaluators. */
export type QueryData =
  | { readonly op: 'from'; readonly relation: string; readonly alias: string }
  | { readonly op: 'lookup'; readonly relation: string; readonly alias: string; readonly field: string; readonly value: ExprData }
  | { readonly op: 'constRows'; readonly rows: readonly Record<string, unknown>[] }
  | {
      readonly op: 'where';
      readonly input: QueryData;
      readonly predicate: PredicateData;
    }
  | {
      readonly op: 'hash';
      readonly input: QueryData;
      readonly expressions: readonly ExprData[];
      readonly unique?: boolean;
    }
  | { readonly op: 'btree'; readonly input: QueryData; readonly expressions: readonly ExprData[] }
  | { readonly op: 'keyBy'; readonly input: QueryData; readonly fields: readonly string[] }
  | {
      readonly op: 'join';
      readonly kind: 'inner' | 'left';
      readonly left: QueryData;
      readonly right: QueryData;
      readonly on: PredicateData;
    }
  | { readonly op: 'select'; readonly input: QueryData; readonly projection: ProjectionData }
  | { readonly op: 'extend'; readonly input: QueryData; readonly projection: ProjectionData }
  | {
      readonly op: 'expand';
      readonly input: QueryData;
      readonly collection: ExprData;
      readonly alias?: string;
      readonly fields?: readonly string[];
    }
  | { readonly op: 'without'; readonly input: QueryData; readonly fields: readonly string[] }
  | { readonly op: 'sort'; readonly input: QueryData; readonly order: readonly SortData[] }
  | { readonly op: 'limit'; readonly input: QueryData; readonly count: number; readonly offset?: number }
  | { readonly op: 'sortLimit'; readonly input: QueryData; readonly order: readonly SortData[]; readonly count: number }
  | { readonly op: 'union'; readonly inputs: readonly QueryData[] }
  | { readonly op: 'intersection'; readonly inputs: readonly QueryData[] }
  | { readonly op: 'difference'; readonly left: QueryData; readonly right: QueryData }
  | { readonly op: 'rename'; readonly input: QueryData; readonly fields: Record<string, string> }
  | { readonly op: 'qualify'; readonly input: QueryData; readonly alias: string }
  | {
      readonly op: 'aggregate';
      readonly input: QueryData;
      readonly groupBy: ProjectionData;
      readonly aggregates: ProjectionData;
    };

/** Typed query value carrying canonical data and relation metadata. */
export type Query<Row = unknown> = {
  readonly data: QueryData;
  readonly relations: Record<string, RelationRef>;
  readonly __row?: Row;
};

export type QueryKeyInput = Query | QueryData;

/** Relation alias plus typed field refs for query expressions. */
export type AliasedRelationRef<Row extends Record<string, unknown>, Alias extends string> = {
  readonly relation: RelationRef<Row>;
  readonly alias: Alias;
} & {
  readonly [Field in keyof Row & string]: ExprData<Row[Field]>;
};

type Transform<Input, Output> = (input: Input) => Output;

// Each transform must accept the previous output, including the initial input.
type PipeTransforms<Input, Outputs extends readonly unknown[]> = {
  readonly [Index in keyof Outputs]: Index extends keyof readonly [Input, ...Outputs]
    ? Transform<(readonly [Input, ...Outputs])[Index], Outputs[Index]>
    : never;
};

type PipeResult<Input, Outputs extends readonly unknown[]> = Outputs extends readonly []
  ? Input
  : Outputs extends readonly [...unknown[], infer LastOutput]
    ? LastOutput
    : Input;

type ProjectionShape = Record<string, ExprData | OptionalProjection>;
type RenameShape = Record<string, string>;

type ProjectedRow<Shape extends ProjectionShape> = {
  readonly [Field in keyof Shape]: Shape[Field] extends OptionalProjection<infer Value>
    ? Value | undefined
    : Shape[Field] extends ExprData<infer Value>
      ? Value
      : never;
};

type RenameRow<Row, Mapping extends RenameShape> = Omit<Row, keyof Mapping> & {
  readonly [OldName in keyof Mapping as Mapping[OldName] & string]: OldName extends keyof Row ? Row[OldName] : unknown;
};

type TupleValues<Items extends readonly ExprInput[]> = {
  readonly [Index in keyof Items]: Items[Index] extends ExprData<infer Value> ? Value : Items[Index];
};

type ExpandItem<Collection> = Collection extends Iterable<infer Item> ? Item : unknown;
type ExpandedFields<Item, Fields extends readonly string[] | undefined> = Fields extends readonly string[]
  ? { readonly [Field in Fields[number]]: Item extends Record<Field, infer Value> ? Value : unknown }
  : Item extends Record<string, unknown>
    ? Item
    : Record<string, unknown>;
type ExpandedRow<
  Ctx,
  Collection,
  Alias extends string | undefined,
  Fields extends readonly string[] | undefined
> = Alias extends string
  ? Ctx & { readonly [Key in Alias]: ExpandItem<NonNullable<Collection>> }
  : Ctx & ExpandedFields<ExpandItem<NonNullable<Collection>>, Fields>;

/**
 * Apply functional query transforms left to right.
 *
 * @example `pipe(from(object), where(eq(object.kind, 'file')), project({ id: object.id }))`
 */
export function pipe<Input>(input: Input): Input;
export function pipe<Input, Output1>(
  input: Input,
  transform1: Transform<Input, Output1>
): Output1;
export function pipe<Input, Output1, Output2>(
  input: Input,
  transform1: Transform<Input, Output1>,
  transform2: Transform<Output1, Output2>
): Output2;
export function pipe<Input, Output1, Output2, Output3>(
  input: Input,
  transform1: Transform<Input, Output1>,
  transform2: Transform<Output1, Output2>,
  transform3: Transform<Output2, Output3>
): Output3;
export function pipe<Input, Output1, Output2, Output3, Output4>(
  input: Input,
  transform1: Transform<Input, Output1>,
  transform2: Transform<Output1, Output2>,
  transform3: Transform<Output2, Output3>,
  transform4: Transform<Output3, Output4>
): Output4;
export function pipe<Input, Output1, Output2, Output3, Output4, Output5>(
  input: Input,
  transform1: Transform<Input, Output1>,
  transform2: Transform<Output1, Output2>,
  transform3: Transform<Output2, Output3>,
  transform4: Transform<Output3, Output4>,
  transform5: Transform<Output4, Output5>
): Output5;
export function pipe<Input, Output1, Output2, Output3, Output4, Output5, Output6>(
  input: Input,
  transform1: Transform<Input, Output1>,
  transform2: Transform<Output1, Output2>,
  transform3: Transform<Output2, Output3>,
  transform4: Transform<Output3, Output4>,
  transform5: Transform<Output4, Output5>,
  transform6: Transform<Output5, Output6>
): Output6;
export function pipe<Input, Output1, Output2, Output3, Output4, Output5, Output6, Output7>(
  input: Input,
  transform1: Transform<Input, Output1>,
  transform2: Transform<Output1, Output2>,
  transform3: Transform<Output2, Output3>,
  transform4: Transform<Output3, Output4>,
  transform5: Transform<Output4, Output5>,
  transform6: Transform<Output5, Output6>,
  transform7: Transform<Output6, Output7>
): Output7;
export function pipe<Input, Output1, Output2, Output3, Output4, Output5, Output6, Output7, Output8>(
  input: Input,
  transform1: Transform<Input, Output1>,
  transform2: Transform<Output1, Output2>,
  transform3: Transform<Output2, Output3>,
  transform4: Transform<Output3, Output4>,
  transform5: Transform<Output4, Output5>,
  transform6: Transform<Output5, Output6>,
  transform7: Transform<Output6, Output7>,
  transform8: Transform<Output7, Output8>
): Output8;
export function pipe<Input, Output1, Output2, Output3, Output4, Output5, Output6, Output7, Output8, Output9>(
  input: Input,
  transform1: Transform<Input, Output1>,
  transform2: Transform<Output1, Output2>,
  transform3: Transform<Output2, Output3>,
  transform4: Transform<Output3, Output4>,
  transform5: Transform<Output4, Output5>,
  transform6: Transform<Output5, Output6>,
  transform7: Transform<Output6, Output7>,
  transform8: Transform<Output7, Output8>,
  transform9: Transform<Output8, Output9>
): Output9;
export function pipe<
  Input,
  Output1,
  Output2,
  Output3,
  Output4,
  Output5,
  Output6,
  Output7,
  Output8,
  Output9,
  Output10
>(
  input: Input,
  transform1: Transform<Input, Output1>,
  transform2: Transform<Output1, Output2>,
  transform3: Transform<Output2, Output3>,
  transform4: Transform<Output3, Output4>,
  transform5: Transform<Output4, Output5>,
  transform6: Transform<Output5, Output6>,
  transform7: Transform<Output6, Output7>,
  transform8: Transform<Output7, Output8>,
  transform9: Transform<Output8, Output9>,
  transform10: Transform<Output9, Output10>
): Output10;
export function pipe<Input, const Outputs extends readonly unknown[]>(
  input: Input,
  ...transforms: PipeTransforms<Input, Outputs>
): PipeResult<Input, Outputs>;
export function pipe(input: unknown, ...transforms: readonly Transform<unknown, unknown>[]): unknown {
  return transforms.reduce((current, transform) => transform(current), input);
}

/** Build a stable structural key for query identity and caches. */
export function queryKey(input: QueryKeyInput): string {
  const data = isQuery(input) ? input.data : input;
  return `query:${JSON.stringify(stableValue(data))}`;
}

/** Return relation names that can affect a query. */
export function relationDependencies(input: QueryKeyInput): readonly string[] {
  const data = isQuery(input) ? input.data : input;
  const names = new Set<string>();

  collectDependencies(data, names);
  return Array.from(names);
}

/** Alias for `relationDependencies`, matching Relic-style naming. */
export const dependencies = relationDependencies;

/** Return declared output row key fields, when a query owns result-row identity metadata. */
export function queryRowKeyFields(input: QueryKeyInput): readonly string[] | undefined {
  const data = isQuery(input) ? input.data : input;
  return rowKeyFieldsForData(data);
}

/** Alias for `queryRowKeyFields`, for row-shape metadata call sites. */
export const rowKeyFields = queryRowKeyFields;

/** Alias a relation and expose typed field refs. */
export function as<Row extends Record<string, unknown>, Alias extends string>(
  relationRef: RelationRef<Row>,
  alias: Alias
): AliasedRelationRef<Row, Alias> {
  const refs = Object.keys(relationRef.fields).reduce<Record<string, ExprData>>((fields, fieldName) => {
    fields[fieldName] = { op: 'field', alias, field: fieldName };
    return fields;
  }, {});

  return { relation: relationRef, alias, ...refs } as AliasedRelationRef<Row, Alias>;
}

/** Start a query from an aliased relation. */
export function from<Row extends Record<string, unknown>, Alias extends string>(
  aliasedRelation: AliasedRelationRef<Row, Alias>
): Query<Record<Alias, Row>> {
  const { relation: relationRef, alias } = aliasedRelation;

  return {
    data: { op: 'from', relation: relationRef.name, alias },
    relations: { [relationRef.name]: relationRef }
  } as Query<Record<Alias, Row>>;
}

/** Start a query from an explicit equality lookup, falling back to scans when unsupported by the source. */
export function lookup<Row extends Record<string, unknown>, Alias extends string, Field extends keyof Row & string>(
  aliasedRelation: AliasedRelationRef<Row, Alias>,
  fieldName: Field,
  valueInput: ExprInput<Row[Field]>
): Query<Record<Alias, Row>> {
  const { relation: relationRef, alias } = aliasedRelation;
  const valueExpr = expr(valueInput);

  return {
    data: { op: 'lookup', relation: relationRef.name, alias, field: fieldName, value: valueExpr },
    relations: { [relationRef.name]: relationRef, ...relationsForExpr(valueExpr) }
  } as Query<Record<Alias, Row>>;
}

/** Start a query from literal rows. */
export function constRows<Row extends Record<string, unknown>>(rows: readonly Row[]): Query<Row> {
  return {
    data: { op: 'constRows', rows },
    relations: {}
  };
}

/** Filter rows by a predicate. */
export function where<Ctx>(predicate: PredicateData): (query: Query<Ctx>) => Query<Ctx> {
  return (query) => ({
    ...query,
    data: { op: 'where', input: query.data, predicate },
    relations: { ...query.relations, ...relationsForPredicate(predicate) }
  });
}

/** Declare hash-index intent for equality lookup planning and future materialized indexes. */
export function hash(...expressions: readonly ExprInput[]): <Ctx>(query: Query<Ctx>) => Query<Ctx> {
  return indexDeclaration('hash', expressions);
}

/**
 * Declare unique hash-index intent without exporting a root-level `unique` name.
 *
 * @remarks This is query metadata only; uniqueness validation stays in `@tarstate/core/constraints`.
 */
export function uniqueIndex(...expressions: readonly ExprInput[]): <Ctx>(query: Query<Ctx>) => Query<Ctx> {
  return indexDeclaration('hash', expressions, { unique: true });
}

/** Declare btree-index intent for range lookup planning and future materialized indexes. */
export function btree(...expressions: readonly ExprInput[]): <Ctx>(query: Query<Ctx>) => Query<Ctx> {
  return indexDeclaration('btree', expressions);
}

/** Declare stable output row identity using one or more fields from the final row. */
export function keyBy<Field extends string, const Rest extends readonly string[]>(
  field: Field,
  ...rest: Rest
): <Ctx extends Record<Field | Rest[number], unknown>>(query: Query<Ctx>) => Query<Ctx> {
  const fields = [field, ...rest];

  return (query) => ({
    ...query,
    data: { op: 'keyBy', input: query.data, fields }
  });
}

/** Inner join another query by predicate. */
export function join<Right>(
  right: Query<Right>,
  predicate: PredicateData
): <Left>(left: Query<Left>) => Query<Left & Right> {
  return joinQuery('inner', right, predicate);
}

/** Left join another query, preserving unmatched left rows. */
export function leftJoin<Right>(
  right: Query<Right>,
  predicate: PredicateData
): <Left>(left: Query<Left>) => Query<Left & Partial<Right>> {
  return joinQuery('left', right, predicate) as <Left>(left: Query<Left>) => Query<Left & Partial<Right>>;
}

/** Select result fields from expressions. */
export function project<Shape extends ProjectionShape>(
  projection: Shape
): <Ctx>(query: Query<Ctx>) => Query<ProjectedRow<Shape>> {
  return (query) => ({
    data: { op: 'select', input: query.data, projection },
    relations: { ...query.relations, ...relationsForProjection(projection) }
  }) as Query<ProjectedRow<Shape>>;
}

/** Alias for project, matching Relic-style naming. */
export function select<Shape extends ProjectionShape>(
  projection: Shape
): <Ctx>(query: Query<Ctx>) => Query<ProjectedRow<Shape>> {
  return project(projection);
}

/** Extend each row with computed fields. */
export function extend<Shape extends ProjectionShape>(
  projection: Shape
): <Ctx>(query: Query<Ctx>) => Query<Ctx & ProjectedRow<Shape>> {
  return <Ctx>(query: Query<Ctx>) => ({
    data: { op: 'extend', input: query.data, projection },
    relations: { ...query.relations, ...relationsForProjection(projection) }
  }) as Query<Ctx & ProjectedRow<Shape>>;
}

/** Expand each iterable collection value into one output row per item. */
export function expand<
  Collection,
  Alias extends string | undefined = undefined,
  const Fields extends readonly string[] | undefined = undefined
>(
  collection: ExprData<Collection>,
  options: ExpandOptions<Alias, Fields> = {}
): <Ctx>(query: Query<Ctx>) => Query<ExpandedRow<Ctx, Collection, Alias, Fields>> {
  return <Ctx>(query: Query<Ctx>) => ({
    data: {
      op: 'expand',
      input: query.data,
      collection,
      ...(options.as === undefined ? {} : { alias: options.as }),
      ...(options.fields === undefined ? {} : { fields: options.fields })
    },
    relations: { ...query.relations, ...relationsForExpr(collection) }
  }) as Query<ExpandedRow<Ctx, Collection, Alias, Fields>>;
}

/** Drop fields from each row. */
export function without<const Fields extends readonly string[]>(
  ...fields: Fields
): <Ctx>(query: Query<Ctx>) => Query<Omit<Ctx, Fields[number]>> {
  return <Ctx>(query: Query<Ctx>) => ({
    data: { op: 'without', input: query.data, fields },
    relations: query.relations
  }) as Query<Omit<Ctx, Fields[number]>>;
}

/** Sort rows by one or more expressions. */
export function sort(...order: readonly SortInput[]): <Ctx>(query: Query<Ctx>) => Query<Ctx> {
  const normalizedOrder = order.map((item) => sortData(item));

  return (query) => ({
    ...query,
    data: { op: 'sort', input: query.data, order: normalizedOrder },
    relations: { ...query.relations, ...relationsForSort(normalizedOrder) }
  });
}

/** Limit row count. */
export function limit(count: number, offset?: number): <Ctx>(query: Query<Ctx>) => Query<Ctx> {
  return (query) => ({
    ...query,
    data: offset === undefined
      ? { op: 'limit', input: query.data, count }
      : { op: 'limit', input: query.data, count, offset }
  });
}

/** Sort rows and keep the first count rows. */
export function sortLimit(count: number, ...order: readonly SortInput[]): <Ctx>(query: Query<Ctx>) => Query<Ctx> {
  const normalizedOrder = order.map((item) => sortData(item));

  return (query) => ({
    ...query,
    data: { op: 'sortLimit', input: query.data, order: normalizedOrder, count },
    relations: { ...query.relations, ...relationsForSort(normalizedOrder) }
  });
}

export function union<Row>(left: Query<Row>, right: Query<Row>, ...rest: readonly Query<Row>[]): Query<Row>;
export function union<Row>(right: Query<Row>, ...rest: readonly Query<Row>[]): (left: Query<Row>) => Query<Row>;
/** Combine compatible query rows. */
export function union<Row>(first: Query<Row>, second?: Query<Row>, ...rest: readonly Query<Row>[]) {
  return setOperation('union', first, second, rest);
}

export function intersection<Row>(left: Query<Row>, right: Query<Row>, ...rest: readonly Query<Row>[]): Query<Row>;
export function intersection<Row>(right: Query<Row>, ...rest: readonly Query<Row>[]): (left: Query<Row>) => Query<Row>;
/** Keep rows common to compatible queries. */
export function intersection<Row>(first: Query<Row>, second?: Query<Row>, ...rest: readonly Query<Row>[]) {
  return setOperation('intersection', first, second, rest);
}

export function difference<Row>(right: Query<Row>): (left: Query<Row>) => Query<Row>;
export function difference<Row>(left: Query<Row>, right: Query<Row>): Query<Row>;
/** Remove rows present in the right query from the left query. */
export function difference<Row>(first: Query<Row>, second?: Query<Row>) {
  if (second === undefined) {
    return (left: Query<Row>): Query<Row> => difference(left, first);
  }

  return {
    data: { op: 'difference', left: first.data, right: second.data },
    relations: mergeRelations(first, second)
  } as Query<Row>;
}

/** Rename row fields using an old-name to new-name map. */
export function rename<Mapping extends RenameShape>(
  fields: Mapping
): <Ctx>(query: Query<Ctx>) => Query<RenameRow<Ctx, Mapping>> {
  return <Ctx>(query: Query<Ctx>) => ({
    data: { op: 'rename', input: query.data, fields },
    relations: query.relations
  }) as Query<RenameRow<Ctx, Mapping>>;
}

/** Nest each row under an alias. */
export function qualify<Alias extends string>(alias: Alias): <Ctx>(query: Query<Ctx>) => Query<Record<Alias, Ctx>> {
  return <Ctx>(query: Query<Ctx>) => ({
    data: { op: 'qualify', input: query.data, alias },
    relations: query.relations
  }) as Query<Record<Alias, Ctx>>;
}

/** Alias for `qualify`, for explicit row-shape qualification call sites. */
export function qualifyRow<Alias extends string>(alias: Alias): <Ctx>(query: Query<Ctx>) => Query<Record<Alias, Ctx>> {
  return qualify(alias);
}

/** Group rows and compute aggregate projections. */
export function aggregate<GroupBy extends ProjectionShape, Aggregates extends ProjectionShape>(
  config: AggregateConfig<GroupBy, Aggregates>
): <Ctx>(query: Query<Ctx>) => Query<ProjectedRow<GroupBy> & ProjectedRow<Aggregates>> {
  return (query) => ({
    data: {
      op: 'aggregate',
      input: query.data,
      groupBy: config.groupBy ?? {},
      aggregates: config.aggregates
    },
    relations: {
      ...query.relations,
      ...relationsForProjection(config.groupBy ?? {}),
      ...relationsForProjection(config.aggregates)
    }
  }) as Query<ProjectedRow<GroupBy> & ProjectedRow<Aggregates>>;
}

/** Relic-shaped alias for `aggregate`. */
export const agg = aggregate;

/** Compare expressions or primitive literals with strict equality. */
export function eq(left: ExprInput, right: ExprInput): PredicateData {
  return comparison('eq', left, right);
}

/** Compare expressions or primitive literals with strict inequality. */
export function neq(left: ExprInput, right: ExprInput): PredicateData {
  return comparison('neq', left, right);
}

/** Compare whether the left expression is less than the right expression. */
export function lt(left: ExprInput, right: ExprInput): PredicateData {
  return comparison('lt', left, right);
}

/** Compare whether the left expression is less than or equal to the right expression. */
export function lte(left: ExprInput, right: ExprInput): PredicateData {
  return comparison('lte', left, right);
}

/** Compare whether the left expression is greater than the right expression. */
export function gt(left: ExprInput, right: ExprInput): PredicateData {
  return comparison('gt', left, right);
}

/** Compare whether the left expression is greater than or equal to the right expression. */
export function gte(left: ExprInput, right: ExprInput): PredicateData {
  return comparison('gte', left, right);
}

/** Require every predicate to match. */
export function and(...predicates: readonly PredicateData[]): PredicateData {
  return { op: 'and', predicates };
}

/** Require at least one predicate to match. */
export function or(...predicates: readonly PredicateData[]): PredicateData {
  return { op: 'or', predicates };
}

/** Negate a predicate. */
export function not(predicate: PredicateData): PredicateData {
  return { op: 'not', predicate };
}

/** Lift a literal value into an expression. */
export function value<Value>(input: Value): ExprData<Value> {
  return { op: 'value', value: input };
}

/** Build a field expression without a schema-derived alias object. */
export function field<Value = unknown>(alias: string, fieldName: string): ExprData<Value> {
  return { op: 'field', alias, field: fieldName };
}

/** Read a named value from the evaluator or database environment. */
export function env<Value = unknown>(name: string): ExprData<Value> {
  return { op: 'env', name };
}

/** Build a named expression call. */
export function call<Value = unknown>(name: string, ...args: readonly ExprInput[]): ExprData<Value>;
export function call<const Args extends readonly ExprInput[], Value>(
  fn: (...args: TupleValues<Args>) => Value,
  ...args: Args
): ExprData<Value>;
export function call<Value = unknown>(
  nameOrFn: string | HostExpressionFunction<Value>,
  ...args: readonly ExprInput[]
): ExprData<Value> {
  return typeof nameOrFn === 'function'
    ? createHostCall(nameOrFn, args)
    : { op: 'call', name: nameOrFn, args: args.map(expr) };
}

/** Build an expression call backed directly by a host function. */
export function hostCall<const Args extends readonly ExprInput[], Value>(
  fn: (...args: TupleValues<Args>) => Value,
  ...args: Args
): ExprData<Value>;
export function hostCall<Value = unknown>(
  fn: HostExpressionFunction<Value>,
  ...args: readonly ExprInput[]
): ExprData<Value> {
  return createHostCall(fn, args);
}

/** Build a tuple expression. */
export function tuple<const Items extends readonly ExprInput[]>(...items: Items): ExprData<TupleValues<Items>> {
  return { op: 'tuple', items: items.map(expr) } as ExprData<TupleValues<Items>>;
}

/** Evaluate a correlated subquery and return all selected rows as an array expression. */
export function sel<Row>(query: Query<Row>): ExprData<readonly Row[]> {
  return subqueryExpr('many', query) as ExprData<readonly Row[]>;
}

/** Evaluate a correlated subquery and return its single selected row, or undefined when absent. */
export function sel1<Row>(query: Query<Row>): ExprData<Row | undefined> {
  return subqueryExpr('one', query) as ExprData<Row | undefined>;
}

/** Sort ascending by expression. */
export function asc(input: SortInput, nulls?: NullSortOrder): SortData {
  return sortData(input, 'asc', nulls);
}

/** Sort descending by expression. */
export function desc(input: SortInput, nulls?: NullSortOrder): SortData {
  return sortData(input, 'desc', nulls);
}

/** Count rows or non-null expression values. */
export function count(input?: ExprInput, options: { readonly distinct?: boolean } = {}): ExprData<number> {
  return aggregateCall('count', input, options);
}

/** Count distinct non-null expression values. */
export function countDistinct(input: ExprInput): ExprData<number> {
  return count(input, { distinct: true });
}

/** Sum expression values. */
export function sum(input: ExprInput, options: { readonly distinct?: boolean } = {}): ExprData<number> {
  return aggregateCall('sum', input, options);
}

/** Average expression values. */
export function avg(input: ExprInput, options: { readonly distinct?: boolean } = {}): ExprData<number> {
  return aggregateCall('avg', input, options);
}

/** Minimum expression value. */
export function min<Value = unknown>(input: ExprInput<Value>, options: { readonly distinct?: boolean } = {}): ExprData<Value> {
  return aggregateCall('min', input, options);
}

/** Maximum expression value. */
export function max<Value = unknown>(input: ExprInput<Value>, options: { readonly distinct?: boolean } = {}): ExprData<Value> {
  return aggregateCall('max', input, options);
}

/** True when any aggregate input value is truthy. */
export function any(input: ExprInput, options: { readonly distinct?: boolean } = {}): ExprData<boolean> {
  return aggregateCall('any', input, options);
}

/** True when no aggregate input value is truthy. */
export function notAny(input: ExprInput, options: { readonly distinct?: boolean } = {}): ExprData<boolean> {
  return aggregateCall('notAny', input, options);
}

/** Bind a structural set of aggregate input values. */
export function setConcat<Value>(
  input: ExprInput<ReadonlySet<Value>>,
  options?: { readonly distinct?: boolean }
): ExprData<ReadonlySet<Value>>;
export function setConcat<Value>(
  input: ExprInput<readonly Value[]>,
  options?: { readonly distinct?: boolean }
): ExprData<ReadonlySet<Value>>;
export function setConcat<Value>(
  input: ExprInput<Value>,
  options?: { readonly distinct?: boolean }
): ExprData<ReadonlySet<Value>>;
export function setConcat(
  input: ExprInput,
  options: { readonly distinct?: boolean } = {}
): ExprData<ReadonlySet<unknown>> {
  return aggregateCall('setConcat', input, options);
}

/** Bind the highest aggregate input values. */
export function top<Value>(
  count: number,
  input: ExprInput<Value>,
  options: { readonly distinct?: boolean } = {}
): ExprData<readonly Value[]> {
  return aggregateCall('top', input, { ...options, count: aggregateLimit('top', count) });
}

/** Bind the lowest aggregate input values. */
export function bottom<Value>(
  count: number,
  input: ExprInput<Value>,
  options: { readonly distinct?: boolean } = {}
): ExprData<readonly Value[]> {
  return aggregateCall('bottom', input, { ...options, count: aggregateLimit('bottom', count) });
}

/** Bind the highest rows by aggregate input value. */
export function topBy<Row = unknown>(
  count: number,
  input: ExprInput,
  options: { readonly distinct?: boolean } = {}
): ExprData<readonly Row[]> {
  return aggregateCall('topBy', input, { ...options, count: aggregateLimit('topBy', count) });
}

/** Bind the lowest rows by aggregate input value. */
export function bottomBy<Row = unknown>(
  count: number,
  input: ExprInput,
  options: { readonly distinct?: boolean } = {}
): ExprData<readonly Row[]> {
  return aggregateCall('bottomBy', input, { ...options, count: aggregateLimit('bottomBy', count) });
}

/** Bind the highest row by aggregate input value. */
export function maxBy<Row = unknown>(
  input: ExprInput,
  options: { readonly distinct?: boolean } = {}
): ExprData<Row | undefined> {
  return aggregateCall('maxBy', input, options);
}

/** Bind the lowest row by aggregate input value. */
export function minBy<Row = unknown>(
  input: ExprInput,
  options: { readonly distinct?: boolean } = {}
): ExprData<Row | undefined> {
  return aggregateCall('minBy', input, options);
}

/**
 * Mark a projection as optional after a left join.
 *
 * @remarks Use this for fields read from a relation that may be absent.
 */
export function maybe<Value>(expr: ExprData<Value>): OptionalProjection<Value> {
  return { kind: 'optionalProjection', expr };
}

function expr(input: ExprInput): ExprData {
  return isExprData(input) ? input : value(input);
}

function comparison(op: ComparisonOp, left: ExprInput, right: ExprInput): PredicateData {
  return { op, left: expr(left), right: expr(right) };
}

function isExprData(input: ExprInput): input is ExprData {
  return typeof input === 'object' && input !== null && 'op' in input;
}

function isQuery(input: QueryKeyInput): input is Query {
  return typeof input === 'object' && input !== null && 'data' in input && 'relations' in input;
}

function collectDependencies(data: QueryData, names: Set<string>): void {
  switch (data.op) {
    case 'from':
      names.add(data.relation);
      return;
    case 'lookup':
      names.add(data.relation);
      collectExprDependencies(data.value, names);
      return;
    case 'constRows':
      return;
    case 'where':
      collectDependencies(data.input, names);
      collectPredicateDependencies(data.predicate, names);
      return;
    case 'keyBy':
      collectDependencies(data.input, names);
      return;
    case 'hash':
    case 'btree':
      collectDependencies(data.input, names);
      for (const expression of data.expressions) {
        collectExprDependencies(expression, names);
      }
      return;
    case 'select':
    case 'extend':
      collectDependencies(data.input, names);
      collectProjectionDependencies(data.projection, names);
      return;
    case 'expand':
      collectDependencies(data.input, names);
      collectExprDependencies(data.collection, names);
      return;
    case 'sort':
    case 'sortLimit':
      collectDependencies(data.input, names);
      for (const item of data.order) {
        collectExprDependencies(item.expr, names);
      }
      return;
    case 'aggregate':
      collectDependencies(data.input, names);
      collectProjectionDependencies(data.groupBy, names);
      collectProjectionDependencies(data.aggregates, names);
      return;
    case 'without':
    case 'limit':
    case 'rename':
    case 'qualify':
      collectDependencies(data.input, names);
      return;
    case 'join':
      collectDependencies(data.left, names);
      collectDependencies(data.right, names);
      collectPredicateDependencies(data.on, names);
      return;
    case 'union':
    case 'intersection':
      for (const input of data.inputs) {
        collectDependencies(input, names);
      }
      return;
    case 'difference':
      collectDependencies(data.left, names);
      collectDependencies(data.right, names);
      return;
  }
}

function rowKeyFieldsForData(data: QueryData): readonly string[] | undefined {
  switch (data.op) {
    case 'keyBy':
      return data.fields;
    case 'where':
    case 'hash':
    case 'btree':
    case 'extend':
    case 'expand':
    case 'sort':
    case 'limit':
    case 'sortLimit':
      return rowKeyFieldsForData(data.input);
    case 'select':
      return projectedRowKeyFields(rowKeyFieldsForData(data.input), data.projection);
    case 'without':
      return retainedRowKeyFields(rowKeyFieldsForData(data.input), data.fields);
    case 'rename':
      return renamedRowKeyFields(rowKeyFieldsForData(data.input), data.fields);
    case 'qualify':
    case 'aggregate':
      return undefined;
    default:
      return undefined;
  }
}

function projectedRowKeyFields(
  fields: readonly string[] | undefined,
  projection: ProjectionData
): readonly string[] | undefined {
  return fields !== undefined && fields.every((field) => Object.hasOwn(projection, field)) ? fields : undefined;
}

function retainedRowKeyFields(
  fields: readonly string[] | undefined,
  omittedFields: readonly string[]
): readonly string[] | undefined {
  return fields !== undefined && fields.every((field) => !omittedFields.includes(field)) ? fields : undefined;
}

function renamedRowKeyFields(
  fields: readonly string[] | undefined,
  renames: Record<string, string>
): readonly string[] | undefined {
  return fields?.map((field) => renames[field] ?? field);
}

function collectPredicateDependencies(predicate: PredicateData, names: Set<string>): void {
  switch (predicate.op) {
    case 'eq':
    case 'neq':
    case 'lt':
    case 'lte':
    case 'gt':
    case 'gte':
      collectExprDependencies(predicate.left, names);
      collectExprDependencies(predicate.right, names);
      return;
    case 'and':
    case 'or':
      for (const item of predicate.predicates) {
        collectPredicateDependencies(item, names);
      }
      return;
    case 'not':
      collectPredicateDependencies(predicate.predicate, names);
      return;
  }
}

function collectProjectionDependencies(projection: ProjectionData, names: Set<string>): void {
  for (const item of Object.values(projection)) {
    collectExprDependencies(isOptionalProjection(item) ? item.expr : item, names);
  }
}

function collectExprDependencies(exprData: ExprData, names: Set<string>): void {
  switch (exprData.op) {
    case 'field':
    case 'env':
    case 'value':
      return;
    case 'call':
    case 'hostCall':
      for (const arg of exprData.args) {
        collectExprDependencies(arg, names);
      }
      return;
    case 'tuple':
      for (const item of exprData.items) {
        collectExprDependencies(item, names);
      }
      return;
    case 'aggregateCall':
      if (exprData.expr !== undefined) {
        collectExprDependencies(exprData.expr, names);
      }
      return;
    case 'subquery':
      collectDependencies(exprData.query, names);
      return;
  }
}

function sortData(input: SortInput, direction?: SortDirection, nulls?: NullSortOrder): SortData {
  if (isSortData(input)) {
    if (direction === undefined && nulls === undefined) {
      return input;
    }

    return sortDataWithNulls(input.expr, direction ?? input.direction, nulls ?? input.nulls);
  }

  return sortDataWithNulls(expr(input), direction ?? 'asc', nulls);
}

function isSortData(input: SortInput): input is SortData {
  return typeof input === 'object' && input !== null && 'expr' in input && 'direction' in input;
}

function sortDataWithNulls(expr: ExprData, direction: SortDirection, nulls: NullSortOrder | undefined): SortData {
  return nulls === undefined ? { expr, direction } : { expr, direction, nulls };
}

function aggregateCall<Value>(
  name: AggregateFunction,
  input: ExprInput | undefined,
  options: AggregateCallOptions
): ExprData<Value> {
  return input === undefined
    ? aggregateCallData(name, undefined, options)
    : aggregateCallData(name, expr(input), options);
}

function aggregateCallData<Value>(
  name: AggregateFunction,
  exprData: ExprData | undefined,
  options: AggregateCallOptions
): ExprData<Value> {
  return {
    op: 'aggregateCall',
    name,
    ...(exprData === undefined ? {} : { expr: exprData }),
    distinct: options.distinct ?? false,
    ...(options.count === undefined ? {} : { count: options.count })
  };
}

function aggregateLimit(name: AggregateFunction, count: number): number {
  if (!Number.isInteger(count) || count < 0) {
    throw new RangeError(`${name} aggregate requires a non-negative integer count`);
  }

  return count;
}

function joinQuery<Left, Right>(
  kind: 'inner' | 'left',
  right: Query<Right>,
  predicate: PredicateData
): (left: Query<Left>) => Query<Left & Right> {
  return (left) => {
    return {
      data: { op: 'join', kind, left: left.data, right: right.data, on: predicate },
      relations: { ...left.relations, ...right.relations, ...relationsForPredicate(predicate) }
    } as Query<Left & Right>;
  };
}

function indexDeclaration(
  op: 'hash' | 'btree',
  expressions: readonly ExprInput[],
  options: { readonly unique?: boolean } = {}
): <Ctx>(query: Query<Ctx>) => Query<Ctx> {
  const normalizedExpressions = expressions.map(expr);

  return (query) => ({
    ...query,
    data: {
      op,
      input: query.data,
      expressions: normalizedExpressions,
      ...(options.unique === undefined ? {} : { unique: options.unique })
    },
    relations: { ...query.relations, ...relationsForExprs(normalizedExpressions) }
  });
}

function setOperation<Row>(
  op: 'union' | 'intersection',
  first: Query<Row>,
  second: Query<Row> | undefined,
  rest: readonly Query<Row>[]
): Query<Row> | ((left: Query<Row>) => Query<Row>) {
  if (second === undefined) {
    return (left: Query<Row>): Query<Row> => setOperation(op, left, first, rest) as Query<Row>;
  }

  const inputs = [first, second, ...rest];

  return {
    data: { op, inputs: inputs.map((input) => input.data) },
    relations: mergeRelations(...inputs)
  } as Query<Row>;
}

function mergeRelations(...queries: readonly Query[]): Record<string, RelationRef> {
  return queries.reduce<Record<string, RelationRef>>((relations, query) => ({ ...relations, ...query.relations }), {});
}

function subqueryExpr<Row>(mode: 'many' | 'one', query: Query<Row>): ExprData {
  const output = { op: 'subquery', mode, query: query.data } as ExprData;

  Object.defineProperty(output, subqueryRelations, {
    value: query.relations,
    enumerable: false
  });

  return output;
}

function relationsForPredicate(predicate: PredicateData): Record<string, RelationRef> {
  switch (predicate.op) {
    case 'eq':
    case 'neq':
    case 'lt':
    case 'lte':
    case 'gt':
    case 'gte':
      return { ...relationsForExpr(predicate.left), ...relationsForExpr(predicate.right) };
    case 'and':
    case 'or':
      return predicate.predicates.reduce<Record<string, RelationRef>>(
        (relations, item) => ({ ...relations, ...relationsForPredicate(item) }),
        {}
      );
    case 'not':
      return relationsForPredicate(predicate.predicate);
  }
}

function relationsForProjection(projection: ProjectionData): Record<string, RelationRef> {
  return Object.values(projection).reduce<Record<string, RelationRef>>(
    (relations, item) => ({
      ...relations,
      ...relationsForExpr(isOptionalProjection(item) ? item.expr : item)
    }),
    {}
  );
}

function relationsForSort(order: readonly SortData[]): Record<string, RelationRef> {
  return order.reduce<Record<string, RelationRef>>(
    (relations, item) => ({ ...relations, ...relationsForExpr(item.expr) }),
    {}
  );
}

function relationsForExprs(expressions: readonly ExprData[]): Record<string, RelationRef> {
  return expressions.reduce<Record<string, RelationRef>>(
    (relations, item) => ({ ...relations, ...relationsForExpr(item) }),
    {}
  );
}

function relationsForExpr(exprData: ExprData): Record<string, RelationRef> {
  switch (exprData.op) {
    case 'field':
    case 'env':
    case 'value':
      return {};
    case 'call':
    case 'hostCall':
      return relationsForExprs(exprData.args);
    case 'tuple':
      return relationsForExprs(exprData.items);
    case 'aggregateCall':
      return exprData.expr === undefined ? {} : relationsForExpr(exprData.expr);
    case 'subquery':
      return exprData[subqueryRelations] ?? {};
  }
}

function isOptionalProjection(input: ExprData | OptionalProjection): input is OptionalProjection {
  return 'kind' in input && input.kind === 'optionalProjection';
}

const hostFunctionIds = new WeakMap<HostExpressionFunction, string>();
let nextHostFunctionId = 0;

function createHostCall<Value>(fn: HostExpressionFunction<Value>, args: readonly ExprInput[]): ExprData<Value> {
  const output = {
    op: 'hostCall',
    id: stableHostFunctionId(fn),
    name: fn.name === '' ? 'anonymous' : fn.name,
    args: args.map(expr)
  } as ExprData<Value>;

  Object.defineProperty(output, 'fn', {
    value: fn,
    enumerable: false
  });

  return output;
}

function stableHostFunctionId(fn: HostExpressionFunction): string {
  const existing = hostFunctionIds.get(fn);
  if (existing !== undefined) return existing;
  nextHostFunctionId += 1;
  const id = `host:${nextHostFunctionId}:${fn.name === '' ? 'anonymous' : fn.name}`;
  hostFunctionIds.set(fn, id);
  Object.defineProperty(fn, hostFunctionId, {
    value: id,
    enumerable: false,
    configurable: true
  });
  return id;
}
