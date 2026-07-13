import { canonicalizeJson, type ArtifactRef } from './artifacts.js';
import type { ScalarDeclaration } from './codec.js';
import type { CapabilityRef } from './issues.js';
import type { PipeOperator, PipeType } from './internal-pipe.js';
import { prepareQuery, type Expr, type QueryNode } from './query.js';
import type { QueryArtifact, QueryArtifactBody, ValueDeclaration } from './query-builder.js';
import type { PreparedPlan } from './maintenance.js';
import { assertPreparedPlan } from './internal-prepared-plan.js';
import type { FieldDeclaration, RelationDeclaration, SchemaArtifact, SchemaBody } from './schema.js';
import type { JsonValue, PortableValue, TaggedValue } from './value.js';
import { stringTupleKey } from './internal-string-key.js';

type Simplify<Value> = { readonly [Key in keyof Value]: Value[Key] };
type UnionToIntersection<Union> = (Union extends unknown ? (value: Union) => void : never) extends (value: infer Intersection) => void ? Intersection : never;
type StringKey<Value> = Extract<keyof Value, string>;

/** Identity authoring helper: const inference is erased and the portable value is unchanged. */
export const schemaLiteral = <const Body extends SchemaBody>(body: Body): Body => body;

type SchemaBodyOf<Schema> = Schema extends SchemaBody
  ? Schema
  : Schema extends { readonly body: infer Body extends SchemaBody }
    ? Body
    : never;
type RelationsOf<Schema> = SchemaBodyOf<Schema>['relations'];
type RelationOf<Schema, Name extends PropertyKey> = Name extends keyof RelationsOf<Schema> ? RelationsOf<Schema>[Name] : never;
type FieldsOf<Relation> = Relation extends { readonly fields: infer Fields } ? Fields : never;
type OptionalFieldKeys<Fields> = {
  [Key in keyof Fields]-?: Fields[Key] extends { readonly optional: true } ? Key : never
}[keyof Fields];
type RequiredFieldKeys<Fields> = Exclude<keyof Fields, OptionalFieldKeys<Fields>>;

declare const customScalarValue: unique symbol;
declare const referenceKey: unique symbol;

/** A portable custom declaration paired with its exact decoded app value. */
export type CustomScalarDeclaration<Value extends TaggedValue> = {
  readonly kind: 'custom';
  readonly codec: CapabilityRef;
  readonly [customScalarValue]: Value;
};

/** Adds only compile-time codec evidence; the returned declaration stays portable. */
export const customScalar = <Value extends TaggedValue>(codec: CapabilityRef): CustomScalarDeclaration<Value> =>
  ({ kind: 'custom', codec }) as CustomScalarDeclaration<Value>;

export type RelationKey<Relation> = Relation extends { readonly key: infer Names extends readonly string[] }
  ? KeyTuple<Relation, Names>
  : never;

export type ReferenceScalarDeclaration<Target extends RelationDeclaration> = {
  readonly kind: 'ref';
  readonly target: { readonly relationId: Target['relationId'] };
  readonly [referenceKey]: RelationKey<Target>;
};

/** Identity helper used when another literal relation needs to reference this one. */
export const relationDeclaration = <const Relation extends RelationDeclaration>(relation: Relation): Relation => relation;

/** Builds a portable reference whose app value is the target's exact key tuple. */
export const referenceTo = <const Target extends RelationDeclaration>(target: Target): ReferenceScalarDeclaration<Target> =>
  ({ kind: 'ref', target: { relationId: target.relationId } }) as ReferenceScalarDeclaration<Target>;

export type ScalarValueOf<Declaration> =
  Declaration extends CustomScalarDeclaration<infer Value> ? Value
    : Declaration extends ReferenceScalarDeclaration<infer Target> ? RelationKey<Target>
      : Declaration extends { readonly kind: 'string'; readonly values: readonly (infer Value extends string)[] } ? Value
    : Declaration extends { readonly kind: 'string' } ? string
      : Declaration extends { readonly kind: 'boolean' } ? boolean
        : Declaration extends { readonly kind: 'number' | 'integer' } ? number
          : Declaration extends { readonly kind: 'decimal' } ? { readonly kind: 'tarstate.value'; readonly type: 'decimal'; readonly value: string }
            : Declaration extends { readonly kind: 'instant' } ? { readonly kind: 'tarstate.value'; readonly type: 'instant'; readonly value: string }
              : Declaration extends { readonly kind: 'bytes' } ? { readonly kind: 'tarstate.value'; readonly type: 'bytes'; readonly value: string }
                : Declaration extends { readonly kind: 'json' } ? JsonValue
                  : Declaration extends { readonly kind: 'ref' } ? readonly PortableValue[]
                    : Declaration extends { readonly kind: 'custom' } ? TaggedValue
                      : never;

export type ValueOfDeclaration<Declaration> =
  Declaration extends ScalarDeclaration ? ScalarValueOf<Declaration>
    : Declaration extends { readonly kind: 'array'; readonly items: infer Item } ? readonly ValueOfDeclaration<Item>[]
      : Declaration extends { readonly kind: 'tuple'; readonly items: infer Items extends readonly unknown[] } ? { readonly [Index in keyof Items]: ValueOfDeclaration<Items[Index]> }
        : Declaration extends { readonly kind: 'record'; readonly fields: infer Fields; readonly optional?: infer Optional extends readonly string[] }
          ? Simplify<
              { readonly [Key in Exclude<keyof Fields, Optional[number]>]: ValueOfDeclaration<Fields[Key]> }
              & { readonly [Key in Extract<keyof Fields, Optional[number]>]?: ValueOfDeclaration<Fields[Key]> }
            >
          : never;

type FieldValue<Field> = Field extends { readonly type: infer Declaration }
  ? ScalarValueOf<Declaration> | (Field extends { readonly nullable: true } ? null : never)
  : never;

type RelationById<Body extends SchemaBody, Id> = {
  [Name in keyof Body['relations']]: Body['relations'][Name] extends { readonly relationId: Id }
    ? Body['relations'][Name]
    : never
}[keyof Body['relations']];

type SchemaScalarValue<Body extends SchemaBody, Declaration> =
  Declaration extends ReferenceScalarDeclaration<infer Target> ? RelationKey<Target>
    : Declaration extends { readonly kind: 'ref'; readonly target: { readonly relationId: infer RelationId } }
      ? SchemaRelationKey<Body, RelationById<Body, RelationId>>
      : ScalarValueOf<Declaration>;

type SchemaFieldValue<Body extends SchemaBody, Field> = Field extends { readonly type: infer Declaration }
  ? SchemaScalarValue<Body, Declaration> | (Field extends { readonly nullable: true } ? null : never)
  : never;

type SchemaRelationKey<Body extends SchemaBody, Relation> = Relation extends { readonly key: infer Names extends readonly string[] }
  ? {
      readonly [Index in keyof Names]: Names[Index] extends keyof FieldsOf<Relation>
        ? SchemaFieldValue<Body, FieldsOf<Relation>[Names[Index]]>
        : never
    }
  : never;

type SchemaRelationRow<Body extends SchemaBody, Relation> = Relation extends RelationDeclaration
  ? Simplify<
      { readonly [Key in RequiredFieldKeys<FieldsOf<Relation>>]: SchemaFieldValue<Body, FieldsOf<Relation>[Key]> }
      & { readonly [Key in OptionalFieldKeys<FieldsOf<Relation>>]?: SchemaFieldValue<Body, FieldsOf<Relation>[Key]> }
    >
  : never;

export type RowOfRelation<Relation> = Relation extends RelationDeclaration
  ? Simplify<
      { readonly [Key in RequiredFieldKeys<FieldsOf<Relation>>]: FieldValue<FieldsOf<Relation>[Key]> }
      & { readonly [Key in OptionalFieldKeys<FieldsOf<Relation>>]?: FieldValue<FieldsOf<Relation>[Key]> }
    >
  : never;

/** Exact application row inferred from a literal schema relation. */
export type SchemaRow<Schema, Name extends StringKey<RelationsOf<Schema>>> = SchemaRelationRow<SchemaBodyOf<Schema>, RelationOf<Schema, Name>>;

type KeyTuple<Relation, Names extends readonly unknown[]> = {
  readonly [Index in keyof Names]: Names[Index] extends keyof FieldsOf<Relation> ? FieldValue<FieldsOf<Relation>[Names[Index]]> : never
};

/** Ordered logical-key tuple inferred from a literal schema relation. */
export type SchemaKey<Schema, Name extends StringKey<RelationsOf<Schema>>> = SchemaRelationKey<SchemaBodyOf<Schema>, RelationOf<Schema, Name>>;

export type LiteralRelation<Body extends SchemaBody, Name extends StringKey<Body['relations']>> = {
  readonly schemaView: ArtifactRef;
  readonly relationId: Body['relations'][Name]['relationId'];
  readonly name: Name;
  readonly declaration: Body['relations'][Name];
};

export const relationLiteral = <const Body extends SchemaBody, const Name extends StringKey<Body['relations']>>(
  schema: SchemaArtifact<Body>,
  name: Name
): LiteralRelation<Body, Name> => {
  const declaration = schema.body.relations[name] as Body['relations'][Name];
  const schemaView = { id: schema.id, contentHash: schema.contentHash };
  return { schemaView, relationId: declaration.relationId, name, declaration };
};

declare const expressionValue: unique symbol;
declare const expressionParameters: unique symbol;
declare const queryResultRow: unique symbol;
declare const preparedPlanRow: unique symbol;
declare const preparedPlanParameters: unique symbol;
declare const returningRow: unique symbol;
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
  const row = Object.fromEntries(fields.map((field) => [field, { expression: { kind: 'field', alias: name, name: field }, parameterDeclarations: {} }])) as unknown as TypedAlias<Name, Row>['row'];
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
  parameterDeclarations: { ...left.parameterDeclarations, ...right.parameterDeclarations } as Simplify<LeftParameters & RightParameters>
});

type BooleanExpression = TypedExpression<boolean, Readonly<Record<string, ValueDeclaration>>>;
const typedBoolean = <const Expressions extends readonly [BooleanExpression, ...BooleanExpression[]]>(op: 'and' | 'or', expressions: Expressions): TypedExpression<boolean, ParametersOfExpressions<Expressions>> => ({
  expression: { kind: 'boolean', op, args: expressions.map(({ expression }) => expression) },
  parameterDeclarations: Object.assign({}, ...expressions.map(({ parameterDeclarations }) => parameterDeclarations)) as ParametersOfExpressions<Expressions>
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
  return {
    ...query,
    root: { kind: 'where', input: query.root, predicate: expression.expression },
    parameterDeclarations: { ...query.parameterDeclarations, ...expression.parameterDeclarations } as Simplify<QueryParameters & PredicateParameters>
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
  if ('root' in queryOrPredicate) return applyTypedWhere(queryOrPredicate, predicate!(queryOrPredicate.aliases));
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
): TypedQuery<Aliases, Simplify<QueryParameters & ParametersOfOrder<Terms>>, Row> => ({
  ...query,
  root: { kind: 'order', input: query.root, by: terms.map(({ value, direction, nulls }) => ({ value: value.expression, direction, ...(nulls === undefined ? {} : { nulls }) })) },
  parameterDeclarations: Object.assign({}, query.parameterDeclarations, ...terms.map(({ value }) => value.parameterDeclarations)) as Simplify<QueryParameters & ParametersOfOrder<Terms>>
});

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
  if ('root' in queryOrTerms) return applyTypedOrderBy(queryOrTerms, order!(queryOrTerms.aliases));
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
  const parameterDeclarations = Object.assign({}, query.parameterDeclarations, ...Object.values(fields).map(({ parameterDeclarations }) => parameterDeclarations)) as Simplify<QueryParameters & ParametersOfFields<Fields>>;
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
  return applyTypedSelect(queryOrAlias, aliasOrFields as string, select!(queryOrAlias.aliases));
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
    parameterDeclarations: { ...left.parameterDeclarations, ...right.parameterDeclarations, ...predicate.parameterDeclarations } as Simplify<LeftParameters & RightParameters & PredicateParameters>,
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

export type TypedReturning<Name extends string, Query extends TypedQuery<TypedAliases, Readonly<Record<string, ValueDeclaration>>, unknown>> = {
  readonly name: Name;
  readonly root: QueryNode;
  readonly [returningRow]?: QueryResultRowOf<Query>;
};
export const typedReturning = <const Name extends string, Query extends TypedQuery<TypedAliases, Readonly<Record<string, ValueDeclaration>>, unknown>>(
  name: Name,
  query: Query
): TypedReturning<Name, Query> => ({ name, root: query.root });
export type ReturningRowOf<Returning> = Returning extends TypedReturning<string, infer Query> ? QueryResultRowOf<Query> : Readonly<Record<string, unknown>>;

type CapabilityIds<References> = References extends readonly (infer Reference)[] ? Reference extends { readonly id: infer Id extends string } ? Id : never : never;
type HasCapability<References, Id extends string> = Id extends CapabilityIds<References> ? true : false;
type FieldEditKind<References> = CapabilityIds<References> extends infer Id extends string
  ? Id extends 'urn:tarstate:capability:field/replace' ? 'replace'
    : Id extends 'urn:tarstate:capability:field/counter-increment' ? 'counter-increment'
      : Id extends 'urn:tarstate:capability:field/text-splice' ? 'text-splice'
        : Id extends 'urn:tarstate:capability:field/conflict-resolve' ? 'conflict-resolve'
          : Id extends never ? never : 'custom'
  : never;
type EntityCapabilities<Relation> = Relation extends { readonly entityEditCapabilities: infer References } ? References : readonly [];
type MoveCapability<References> = HasCapability<References, 'urn:tarstate:capability:entity/move'> extends true ? true
  : HasCapability<References, 'urn:tarstate:capability:entity/copy-relocate'> extends true ? true
    : HasCapability<References, 'urn:tarstate:capability:entity/identity-preserving-move'>;
type FieldAccess<Fields> = { readonly [Field in keyof Fields]: Fields[Field] extends FieldDeclaration ? readonly FieldEditKind<Fields[Field]['editCapabilities']>[] : readonly never[] };
type EditableFieldNames<Access> = Access extends { readonly fields: infer Fields } ? { [Field in keyof Fields]-?: Fields[Field] extends readonly (infer Kind)[] ? [Kind] extends [never] ? never : Field : never }[keyof Fields] : never;

/** Compile-time edit capabilities inferred from one literal relation declaration. */
export type RelationAccessOf<Body, Name extends StringKey<RelationsOf<Body>>> = RelationOf<Body, Name> extends infer Relation
  ? {
      readonly declaration: Relation;
      readonly readable: true;
      readonly writable: EditableFieldNames<{ fields: FieldAccess<FieldsOf<Relation>> }> extends never
        ? CapabilityIds<EntityCapabilities<Relation>> extends never ? false : true
        : true;
      readonly rekey: HasCapability<EntityCapabilities<Relation>, 'urn:tarstate:capability:entity/rekey'>;
      readonly move: MoveCapability<EntityCapabilities<Relation>>;
      readonly fields: FieldAccess<FieldsOf<Relation>>;
    }
  : never;

export const relationAccess = <const Body extends SchemaBody, const Name extends StringKey<Body['relations']>>(
  body: Body,
  name: Name
): RelationAccessOf<Body, Name> => {
  const relation = body.relations[name] as Body['relations'][Name];
  const entityIds = new Set((relation.entityEditCapabilities ?? []).map(({ id }) => id));
  const fields = Object.fromEntries(Object.entries(relation.fields).map(([fieldName, declaration]) => [fieldName, (declaration.editCapabilities ?? []).map(({ id }) => fieldEditKind(id))]));
  const writable = Object.values(fields).some((kinds) => kinds.length > 0) || entityIds.size > 0;
  return {
    declaration: relation,
    readable: true,
    writable,
    rekey: entityIds.has('urn:tarstate:capability:entity/rekey'),
    move: entityIds.has('urn:tarstate:capability:entity/move') || entityIds.has('urn:tarstate:capability:entity/copy-relocate') || entityIds.has('urn:tarstate:capability:entity/identity-preserving-move'),
    fields
  } as RelationAccessOf<Body, Name>;
};

type AccessRow<Access> = Access extends { readonly declaration: infer Relation } ? RowOfRelation<Relation> : never;
type AccessKey<Access> = Access extends { readonly declaration: infer Relation } ? RelationKey<Relation> : never;

export const typedFieldEdit = <Access, Field extends EditableFieldNames<Access>>(access: Access, field: Field, value: Field extends keyof AccessRow<Access> ? AccessRow<Access>[Field] : never): { readonly field: Field; readonly value: Field extends keyof AccessRow<Access> ? AccessRow<Access>[Field] : never } => {
  void access;
  return { field, value };
};
export const typedRekey = <Access extends { readonly rekey: true }>(access: Access, key: AccessKey<Access>): { readonly kind: 'rekey'; readonly key: AccessKey<Access> } => { void access; return { kind: 'rekey', key }; };
export const typedMove = <Access extends { readonly move: true }>(access: Access, parent: PortableValue): { readonly kind: 'move'; readonly parent: PortableValue } => { void access; return { kind: 'move', parent }; };

export type RuntimeTypedQuery = QueryArtifact;
export type RuntimeQueryParameters = QueryParametersOf<RuntimeTypedQuery>;
export type RuntimeQueryResultRow = QueryResultRowOf<RuntimeTypedQuery>;

const fieldEditKind = (id: string): string => id.startsWith('urn:tarstate:capability:field/') ? id.slice('urn:tarstate:capability:field/'.length) : 'custom';
const uniqueSchemaViews = (references: readonly ArtifactRef[]): readonly ArtifactRef[] => [...new Map(references.map((reference) => [stringTupleKey(reference.id, reference.contentHash), reference])).values()];
