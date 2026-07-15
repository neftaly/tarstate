import { canonicalizeJson, type ArtifactRef } from './artifacts.js';
import type { CapabilityRef } from './issues.js';
import { assertPreparedPlan } from './internal-prepared-plan.js';
import type { PipeOperator, PipeType } from './internal-pipe.js';
import { stringTupleKey } from './internal-string-key.js';
import type { QueryArtifact, QueryArtifactBody, ValueDeclaration } from './query-builder.js';
import type { Expr, QueryNode } from './query-model.js';
import type { PreparedPlan } from './query-plan-contract.js';
import { prepareQuery } from './query-prepare.js';
import type {
  LiteralRelation,
  SchemaRow,
  ValueOfDeclaration
} from './schema-authoring.js';
import type { SchemaBody } from './schema.js';
import type { JsonValue } from './value.js';

type Simplify<Value> = { readonly [Key in keyof Value]: Value[Key] };
type UnionToIntersection<Union> = (Union extends unknown ? (value: Union) => void : never) extends (value: infer Intersection) => void ? Intersection : never;
type StringKey<Value> = Extract<keyof Value, string>;

declare const expressionValue: unique symbol;
declare const expressionParameters: unique symbol;
declare const queryResultRow: unique symbol;
declare const preparedPlanRow: unique symbol;
declare const preparedPlanParameters: unique symbol;
export type TypedExpression<Value, Parameters extends Readonly<Record<string, ValueDeclaration>> = {}> = {
  readonly expression: Expr;
  readonly parameterDeclarations: Parameters;
  readonly [expressionValue]?: Value;
  readonly [expressionParameters]?: Parameters;
};

type ExpressionValue<Expression> = Expression extends TypedExpression<infer Value, Readonly<Record<string, ValueDeclaration>>> ? Value : never;
type ExpressionParameters<Expression> = Expression extends TypedExpression<unknown, infer Parameters> ? Parameters : {};
type AnyTypedExpression = TypedExpression<unknown, Readonly<Record<string, ValueDeclaration>>>;
type ParameterRecord<Value> = Value extends Readonly<Record<string, ValueDeclaration>> ? Value : never;
type ParametersOfExpressions<Expressions extends readonly AnyTypedExpression[]> = ParameterRecord<Simplify<UnionToIntersection<ExpressionParameters<Expressions[number]>>>>;

export type TypedAlias<Name extends string, Row> = {
  readonly name: Name;
  readonly row: { readonly [Field in keyof Row]: TypedExpression<Row[Field]> };
};
export type TypedAliases = Readonly<Record<string, TypedAlias<string, unknown>>>;

export type TypedQuery<Aliases extends TypedAliases, Parameters extends Readonly<Record<string, ValueDeclaration>>, ResultRow> = {
  readonly root: QueryNode;
  readonly aliases: Aliases;
  readonly parameterDeclarations: Parameters;
  readonly schemaViews: readonly ArtifactRef[];
  readonly [queryResultRow]?: ResultRow;
};

export type QueryParametersOf<Query> = Query extends TypedQuery<TypedAliases, infer Parameters, unknown>
  ? { readonly [Name in keyof Parameters]: ValueOfDeclaration<Parameters[Name]> }
  : Readonly<Record<string, unknown>>;
export type QueryResultRowOf<Query> = Query extends TypedQuery<TypedAliases, Readonly<Record<string, ValueDeclaration>>, infer Row>
  ? Row
  : Readonly<Record<string, unknown>>;

const makeAlias = <Name extends string, Row>(name: Name, fields: readonly string[]): TypedAlias<Name, Row> => {
  const row = Object.fromEntries(fields.map((field) => [
    field,
    {
      expression: { kind: 'field', alias: name, name: field },
      parameterDeclarations: {}
    }
  ])) as unknown as TypedAlias<Name, Row>['row'];
  return { name, row };
};

/** Starts a typed query while preserving the relation's exact row and alias. */
export const typedFrom = <const Body extends SchemaBody, const RelationName extends StringKey<Body['relations']>, const Alias extends string>(
  relation: LiteralRelation<Body, RelationName>,
  alias: Alias
): TypedQuery<{ readonly [Name in Alias]: TypedAlias<Alias, SchemaRow<Body, RelationName>> }, {}, SchemaRow<Body, RelationName>> => ({
  root: { kind: 'from', relation: { schemaView: relation.schemaView, relationId: relation.relationId }, alias },
  aliases: { [alias]: makeAlias<Alias, SchemaRow<Body, RelationName>>(alias, Object.keys(relation.declaration.fields)) } as { readonly [Name in Alias]: TypedAlias<Alias, SchemaRow<Body, RelationName>> },
  parameterDeclarations: {},
  schemaViews: [relation.schemaView]
});

export const typedLiteral = <const Value extends JsonValue>(value: Value): TypedExpression<Value> => ({ expression: { kind: 'literal', value }, parameterDeclarations: {} });

/** Declares one portable parameter and carries its decoded application type. */
export const typedParameter = <const Name extends string, const Declaration extends ValueDeclaration>(
  name: Name,
  declaration: Declaration
): TypedExpression<ValueOfDeclaration<Declaration>, { readonly [Key in Name]: Declaration }> => ({
  expression: { kind: 'parameter', name },
  parameterDeclarations: { [name]: declaration } as { readonly [Key in Name]: Declaration }
});

type ComparableExpressionValues<Left, Right> = [Left] extends [Right] ? unknown : [Right] extends [Left] ? unknown : never;
export const typedCompare = <Left, Right, LeftParameters extends Readonly<Record<string, ValueDeclaration>>, RightParameters extends Readonly<Record<string, ValueDeclaration>>>(
  op: 'eq' | 'ne' | 'lt' | 'lte' | 'gt' | 'gte',
  left: TypedExpression<Left, LeftParameters>,
  right: TypedExpression<Right, RightParameters> & ComparableExpressionValues<Left, Right>
): TypedExpression<boolean, Simplify<LeftParameters & RightParameters>> => ({
  expression: { kind: 'compare', op, left: left.expression, right: right.expression },
  parameterDeclarations: mergeParameterDeclarations(
    left.parameterDeclarations,
    right.parameterDeclarations
  ) as Simplify<LeftParameters & RightParameters>
});

type BooleanExpression = TypedExpression<boolean, Readonly<Record<string, ValueDeclaration>>>;
const typedBoolean = <const Expressions extends readonly [BooleanExpression, ...BooleanExpression[]]>(op: 'and' | 'or', expressions: Expressions): TypedExpression<boolean, ParametersOfExpressions<Expressions>> => ({
  expression: { kind: 'boolean', op, args: expressions.map(({ expression }) => expression) },
  parameterDeclarations: mergeParameterDeclarations(
    ...expressions.map(({ parameterDeclarations }) => parameterDeclarations)
  ) as ParametersOfExpressions<Expressions>
});
export const typedAnd = <const Expressions extends readonly [BooleanExpression, ...BooleanExpression[]]>(...expressions: Expressions): TypedExpression<boolean, ParametersOfExpressions<Expressions>> => typedBoolean('and', expressions);
export const typedOr = <const Expressions extends readonly [BooleanExpression, ...BooleanExpression[]]>(...expressions: Expressions): TypedExpression<boolean, ParametersOfExpressions<Expressions>> => typedBoolean('or', expressions);
export const typedNot = <Parameters extends Readonly<Record<string, ValueDeclaration>>>(expression: TypedExpression<boolean, Parameters>): TypedExpression<boolean, Parameters> => ({ expression: { kind: 'boolean', op: 'not', arg: expression.expression }, parameterDeclarations: expression.parameterDeclarations });
export const typedIsNull = <Value, Parameters extends Readonly<Record<string, ValueDeclaration>>>(expression: TypedExpression<Value, Parameters>): TypedExpression<boolean, Parameters> => ({ expression: { kind: 'is-null', value: expression.expression }, parameterDeclarations: expression.parameterDeclarations });
export const typedIsMissing = <Value, Parameters extends Readonly<Record<string, ValueDeclaration>>>(expression: TypedExpression<Value, Parameters>): TypedExpression<boolean, Parameters> => ({ expression: { kind: 'is-missing', value: expression.expression }, parameterDeclarations: expression.parameterDeclarations });
export const typedSourceOf = <Name extends string, Row>(alias: TypedAlias<Name, Row>): TypedExpression<string | undefined> => ({ expression: { kind: 'source-of', alias: alias.name }, parameterDeclarations: {} });

const applyTypedWhere = <Aliases extends TypedAliases, QueryParameters extends Readonly<Record<string, ValueDeclaration>>, Row, PredicateParameters extends Readonly<Record<string, ValueDeclaration>>>(
  query: TypedQuery<Aliases, QueryParameters, Row>,
  expression: TypedExpression<boolean, PredicateParameters>
): TypedQuery<Aliases, Simplify<QueryParameters & PredicateParameters>, Row> => {
  assertTypedQueryInput(query);
  return {
    ...query,
    root: { kind: 'where', input: query.root, predicate: expression.expression },
    parameterDeclarations: mergeParameterDeclarations(
      query.parameterDeclarations,
      expression.parameterDeclarations
    ) as Simplify<QueryParameters & PredicateParameters>
  };
};

interface TypedWherePipe<PredicateParameters extends Readonly<Record<string, ValueDeclaration>>> extends PipeType {
  readonly accepts: this['input'] extends TypedQuery<TypedAliases, Readonly<Record<string, ValueDeclaration>>, unknown> ? true : false;
  readonly output: this['input'] extends TypedQuery<infer Aliases, infer QueryParameters, infer Row>
    ? TypedQuery<Aliases, Simplify<QueryParameters & PredicateParameters>, Row>
    : never;
}

export function typedWhere<PredicateParameters extends Readonly<Record<string, ValueDeclaration>>>(
  predicate: TypedExpression<boolean, PredicateParameters>
): (<Aliases extends TypedAliases, QueryParameters extends Readonly<Record<string, ValueDeclaration>>, Row>(
  query: TypedQuery<Aliases, QueryParameters, Row>
) => TypedQuery<Aliases, Simplify<QueryParameters & PredicateParameters>, Row>) & PipeOperator<TypedWherePipe<PredicateParameters>>;
export function typedWhere<Aliases extends TypedAliases, QueryParameters extends Readonly<Record<string, ValueDeclaration>>, Row, PredicateParameters extends Readonly<Record<string, ValueDeclaration>>>(
  query: TypedQuery<Aliases, QueryParameters, Row>,
  predicate: (aliases: Aliases) => TypedExpression<boolean, PredicateParameters>
): TypedQuery<Aliases, Simplify<QueryParameters & PredicateParameters>, Row>;
export function typedWhere(
  queryOrPredicate: TypedQuery<TypedAliases, Readonly<Record<string, ValueDeclaration>>, unknown> | TypedExpression<boolean, Readonly<Record<string, ValueDeclaration>>>,
  predicate?: (aliases: TypedAliases) => TypedExpression<boolean, Readonly<Record<string, ValueDeclaration>>>
): unknown {
  if ('root' in queryOrPredicate) {
    if (predicate === undefined) {
      throw new TypeError('typedWhere callback is required in direct-call form');
    }
    return applyTypedWhere(queryOrPredicate, predicate(queryOrPredicate.aliases));
  }
  return (query: TypedQuery<TypedAliases, Readonly<Record<string, ValueDeclaration>>, unknown>) => applyTypedWhere(query, queryOrPredicate);
}

export type TypedOrderTerm<Parameters extends Readonly<Record<string, ValueDeclaration>> = Readonly<Record<string, ValueDeclaration>>> = {
  readonly value: TypedExpression<unknown, Parameters>;
  readonly direction: 'asc' | 'desc';
  readonly nulls?: 'first' | 'last';
};
type AnyTypedOrderTerm = TypedOrderTerm<Readonly<Record<string, ValueDeclaration>>>;
type ParametersOfOrder<Terms extends readonly AnyTypedOrderTerm[]> = ParametersOfExpressions<{ readonly [Index in keyof Terms]: Terms[Index]['value'] }>;
const applyTypedOrderBy = <Aliases extends TypedAliases, QueryParameters extends Readonly<Record<string, ValueDeclaration>>, Row, const Terms extends readonly [AnyTypedOrderTerm, ...AnyTypedOrderTerm[]]>(
  query: TypedQuery<Aliases, QueryParameters, Row>,
  terms: Terms
): TypedQuery<Aliases, Simplify<QueryParameters & ParametersOfOrder<Terms>>, Row> => {
  assertTypedQueryInput(query);
  return {
    ...query,
    root: { kind: 'order', input: query.root, by: terms.map(({ value, direction, nulls }) => ({ value: value.expression, direction, ...(nulls === undefined ? {} : { nulls }) })) },
    parameterDeclarations: mergeParameterDeclarations(
      query.parameterDeclarations,
      ...terms.map(({ value }) => value.parameterDeclarations)
    ) as Simplify<QueryParameters & ParametersOfOrder<Terms>>
  };
};

interface TypedOrderByPipe<Terms extends readonly [AnyTypedOrderTerm, ...AnyTypedOrderTerm[]]> extends PipeType {
  readonly accepts: this['input'] extends TypedQuery<TypedAliases, Readonly<Record<string, ValueDeclaration>>, unknown> ? true : false;
  readonly output: this['input'] extends TypedQuery<infer Aliases, infer QueryParameters, infer Row>
    ? TypedQuery<Aliases, Simplify<QueryParameters & ParametersOfOrder<Terms>>, Row>
    : never;
}

export function typedOrderBy<const Terms extends readonly [AnyTypedOrderTerm, ...AnyTypedOrderTerm[]]>(
  terms: Terms
): (<Aliases extends TypedAliases, QueryParameters extends Readonly<Record<string, ValueDeclaration>>, Row>(query: TypedQuery<Aliases, QueryParameters, Row>) => TypedQuery<Aliases, Simplify<QueryParameters & ParametersOfOrder<Terms>>, Row>) & PipeOperator<TypedOrderByPipe<Terms>>;
export function typedOrderBy<Aliases extends TypedAliases, QueryParameters extends Readonly<Record<string, ValueDeclaration>>, Row, const Terms extends readonly [AnyTypedOrderTerm, ...AnyTypedOrderTerm[]]>(
  query: TypedQuery<Aliases, QueryParameters, Row>,
  order: (aliases: Aliases) => Terms
): TypedQuery<Aliases, Simplify<QueryParameters & ParametersOfOrder<Terms>>, Row>;
export function typedOrderBy(
  queryOrTerms: TypedQuery<TypedAliases, Readonly<Record<string, ValueDeclaration>>, unknown> | readonly [AnyTypedOrderTerm, ...AnyTypedOrderTerm[]],
  order?: (aliases: TypedAliases) => readonly [AnyTypedOrderTerm, ...AnyTypedOrderTerm[]]
): unknown {
  if ('root' in queryOrTerms) {
    if (order === undefined) {
      throw new TypeError('typedOrderBy callback is required in direct-call form');
    }
    return applyTypedOrderBy(queryOrTerms, order(queryOrTerms.aliases));
  }
  return (query: TypedQuery<TypedAliases, Readonly<Record<string, ValueDeclaration>>, unknown>) => applyTypedOrderBy(query, queryOrTerms);
}

type FieldExpressionRecord = Readonly<Record<string, TypedExpression<unknown, Readonly<Record<string, ValueDeclaration>>>>>;
type ResultOfFields<Fields extends FieldExpressionRecord> = { readonly [Name in keyof Fields]: ExpressionValue<Fields[Name]> };
type ParametersOfFields<Fields extends FieldExpressionRecord> = Simplify<UnionToIntersection<ExpressionParameters<Fields[keyof Fields]>>>;

const applyTypedSelect = <Aliases extends TypedAliases, QueryParameters extends Readonly<Record<string, ValueDeclaration>>, const Alias extends string, const Fields extends FieldExpressionRecord>(
  query: TypedQuery<Aliases, QueryParameters, unknown>,
  alias: Alias,
  fields: Fields
): TypedQuery<{ readonly [Name in Alias]: TypedAlias<Alias, ResultOfFields<Fields>> }, Simplify<QueryParameters & ParametersOfFields<Fields>>, ResultOfFields<Fields>> => {
  assertTypedQueryInput(query);
  const parameterDeclarations = mergeParameterDeclarations(
    query.parameterDeclarations,
    ...Object.values(fields).map(({ parameterDeclarations }) => parameterDeclarations)
  ) as Simplify<QueryParameters & ParametersOfFields<Fields>>;
  const resultFields = Object.fromEntries(Object.entries(fields).map(([name, expression]) => [name, expression.expression]));
  return {
    root: { kind: 'select', input: query.root, alias, fields: resultFields },
    aliases: { [alias]: makeAlias<Alias, ResultOfFields<Fields>>(alias, Object.keys(fields)) } as { readonly [Name in Alias]: TypedAlias<Alias, ResultOfFields<Fields>> },
    parameterDeclarations,
    schemaViews: query.schemaViews
  };
};

interface TypedSelectPipe<Alias extends string, Fields extends FieldExpressionRecord> extends PipeType {
  readonly accepts: this['input'] extends TypedQuery<TypedAliases, Readonly<Record<string, ValueDeclaration>>, unknown> ? true : false;
  readonly output: this['input'] extends TypedQuery<TypedAliases, infer QueryParameters, unknown>
    ? TypedQuery<{ readonly [Name in Alias]: TypedAlias<Alias, ResultOfFields<Fields>> }, Simplify<QueryParameters & ParametersOfFields<Fields>>, ResultOfFields<Fields>>
    : never;
}

/** Projects an exact result-row type; supports both pipeline and callback forms. */
export function typedSelect<const Alias extends string, const Fields extends FieldExpressionRecord>(
  alias: Alias,
  fields: Fields
): (<Aliases extends TypedAliases, QueryParameters extends Readonly<Record<string, ValueDeclaration>>>(
  query: TypedQuery<Aliases, QueryParameters, unknown>
) => TypedQuery<{ readonly [Name in Alias]: TypedAlias<Alias, ResultOfFields<Fields>> }, Simplify<QueryParameters & ParametersOfFields<Fields>>, ResultOfFields<Fields>>) & PipeOperator<TypedSelectPipe<Alias, Fields>>;
export function typedSelect<Aliases extends TypedAliases, QueryParameters extends Readonly<Record<string, ValueDeclaration>>, const Alias extends string, const Fields extends FieldExpressionRecord>(
  query: TypedQuery<Aliases, QueryParameters, unknown>,
  alias: Alias,
  select: (aliases: Aliases) => Fields
): TypedQuery<{ readonly [Name in Alias]: TypedAlias<Alias, ResultOfFields<Fields>> }, Simplify<QueryParameters & ParametersOfFields<Fields>>, ResultOfFields<Fields>>;
export function typedSelect(
  queryOrAlias: TypedQuery<TypedAliases, Readonly<Record<string, ValueDeclaration>>, unknown> | string,
  aliasOrFields: string | FieldExpressionRecord,
  select?: (aliases: TypedAliases) => FieldExpressionRecord
): unknown {
  if (typeof queryOrAlias === 'string') {
    return (query: TypedQuery<TypedAliases, Readonly<Record<string, ValueDeclaration>>, unknown>) => applyTypedSelect(query, queryOrAlias, aliasOrFields as FieldExpressionRecord);
  }
  if (select === undefined) {
    throw new TypeError('typedSelect callback is required in direct-call form');
  }
  return applyTypedSelect(queryOrAlias, aliasOrFields as string, select(queryOrAlias.aliases));
}

type JoinedAliases<Left extends TypedAliases, Right extends TypedAliases> = Simplify<Left & Right>;
type JoinedRows<Aliases extends TypedAliases> = { readonly [Name in keyof Aliases]: Aliases[Name] extends TypedAlias<string, infer Row> ? Row : never };

/** Inner-joins disjoint alias scopes and rejects duplicate aliases at compile time. */
export const typedJoin = <LeftAliases extends TypedAliases, LeftParameters extends Readonly<Record<string, ValueDeclaration>>, RightAliases extends TypedAliases, RightParameters extends Readonly<Record<string, ValueDeclaration>>, PredicateParameters extends Readonly<Record<string, ValueDeclaration>>>(
  left: TypedQuery<LeftAliases, LeftParameters, unknown>,
  right: keyof LeftAliases & keyof RightAliases extends never ? TypedQuery<RightAliases, RightParameters, unknown> : never,
  on: (aliases: JoinedAliases<LeftAliases, RightAliases>) => TypedExpression<boolean, PredicateParameters>
): TypedQuery<JoinedAliases<LeftAliases, RightAliases>, Simplify<LeftParameters & RightParameters & PredicateParameters>, JoinedRows<JoinedAliases<LeftAliases, RightAliases>>> => {
  const aliases = { ...left.aliases, ...right.aliases } as JoinedAliases<LeftAliases, RightAliases>;
  const predicate = on(aliases);
  return {
    root: { kind: 'join', join: 'inner', left: left.root, right: right.root, on: predicate.expression },
    aliases,
    parameterDeclarations: mergeParameterDeclarations(
      left.parameterDeclarations,
      right.parameterDeclarations,
      predicate.parameterDeclarations
    ) as Simplify<LeftParameters & RightParameters & PredicateParameters>,
    schemaViews: uniqueSchemaViews([...left.schemaViews, ...right.schemaViews])
  };
};

export const typedQueryBody = <Aliases extends TypedAliases, Parameters extends Readonly<Record<string, ValueDeclaration>>, Row>(
  query: TypedQuery<Aliases, Parameters, Row>,
  requiredCapabilities: readonly CapabilityRef[] = []
): QueryArtifactBody => ({ schemaViews: query.schemaViews, parameters: query.parameterDeclarations, root: query.root, requiredCapabilities });

/** Prepared-plan carrier consumed by adapters without changing the plan wire shape. */
export type TypedPreparedPlan<Query, Row, Parameters extends Readonly<Record<string, unknown>>> = PreparedPlan<Query> & {
  readonly [preparedPlanRow]?: (row: Row) => Row;
  readonly [preparedPlanParameters]?: (parameters: Parameters) => Parameters;
};

/** Exact result row inferred from a typed prepared plan. */
export type PreparedPlanRow<Plan> = Plan extends { readonly [preparedPlanRow]?: (row: infer Row) => unknown } ? Row : never;
/** Exact parameter object inferred from a typed prepared plan. */
export type PreparedPlanParameters<Plan> = Plan extends { readonly [preparedPlanParameters]?: (parameters: infer Parameters) => unknown } ? Parameters : never;

/** Attaches query inference to a plan with the same portable query semantics. */
export const typedPreparedPlan = <
  Aliases extends TypedAliases,
  Parameters extends Readonly<Record<string, ValueDeclaration>>,
  Row
>(
  plan: PreparedPlan<QueryNode>,
  query: TypedQuery<Aliases, Parameters, Row>
): TypedPreparedPlan<QueryNode, Row, { readonly [Name in keyof Parameters]: ValueOfDeclaration<Parameters[Name]> }> => {
  assertPreparedPlan(plan);
  if (canonicalizeJson(plan.query as JsonValue) !== canonicalizeJson(query.root as JsonValue)) throw new Error('Prepared plan root does not match the typed query');
  return plan;
};

/** Prepares a typed query while preserving its inferred row and parameter types. */
export const prepareTypedQuery = async <
  Aliases extends TypedAliases,
  Parameters extends Readonly<Record<string, ValueDeclaration>>,
  Row
>(
  query: TypedQuery<Aliases, Parameters, Row>,
  options: {
    readonly registryFingerprint: string;
    readonly authorityFingerprint: string;
    readonly datasetId: string;
  }
): Promise<TypedPreparedPlan<QueryNode, Row, { readonly [Name in keyof Parameters]: ValueOfDeclaration<Parameters[Name]> }>> =>
  typedPreparedPlan(await prepareQuery({ root: query.root, ...options }), query);

export type RuntimeTypedQuery = QueryArtifact;
export type RuntimeQueryParameters = QueryParametersOf<RuntimeTypedQuery>;
export type RuntimeQueryResultRow = QueryResultRowOf<RuntimeTypedQuery>;
const uniqueSchemaViews = (references: readonly ArtifactRef[]): readonly ArtifactRef[] => [...new Map(references.map((reference) => [stringTupleKey(reference.id, reference.contentHash), reference])).values()];

const mergeParameterDeclarations = (
  ...records: readonly Readonly<Record<string, ValueDeclaration>>[]
): Readonly<Record<string, ValueDeclaration>> => {
  const merged: Record<string, ValueDeclaration> = {};
  for (const record of records) {
    for (const [name, declaration] of Object.entries(record)) {
      const previous = merged[name];
      if (
        previous !== undefined
        && canonicalizeJson(previous as JsonValue) !== canonicalizeJson(declaration as JsonValue)
      ) {
        throw new TypeError(`Conflicting declarations for query parameter ${JSON.stringify(name)}`);
      }
      merged[name] = declaration;
    }
  }
  return merged;
};

const assertTypedQueryInput = (value: unknown): void => {
  if (
    value === null
    || typeof value !== 'object'
    || !Object.hasOwn(value, 'root')
    || !Object.hasOwn(value, 'aliases')
    || !Object.hasOwn(value, 'parameterDeclarations')
    || !Object.hasOwn(value, 'schemaViews')
  ) {
    throw new TypeError('Typed query operator received an invalid query input');
  }
};
