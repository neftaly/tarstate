import type { RelationRef } from './schema.js';

// Phantom value type; keeps field refs typed without adding runtime data.
declare const fieldValue: unique symbol;

/** Canonical expression data produced by query constructors. */
export type ExprData<Value = unknown> =
  | { readonly op: 'field'; readonly alias: string; readonly field: string; readonly [fieldValue]?: Value }
  | { readonly op: 'value'; readonly value: Value; readonly [fieldValue]?: Value };

export type PrimitiveValue = string | number | boolean | null | undefined;
export type ExprInput<Value = unknown> = ExprData<Value> | PrimitiveValue;

/** Canonical predicate data used by filters and joins. */
export type PredicateData =
  | { readonly op: 'eq'; readonly left: ExprData; readonly right: ExprData }
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

/** Canonical query tree inspected by planners and evaluators. */
export type QueryData =
  | { readonly op: 'from'; readonly relation: string; readonly alias: string }
  | { readonly op: 'where'; readonly input: QueryData; readonly predicate: PredicateData }
  | {
      readonly op: 'join';
      readonly kind: 'inner' | 'left';
      readonly left: QueryData;
      readonly right: QueryData;
      readonly on: PredicateData;
    }
  | { readonly op: 'select'; readonly input: QueryData; readonly projection: ProjectionData };

/** Typed query value carrying canonical data and relation metadata. */
export type Query<Row = unknown> = {
  readonly data: QueryData;
  readonly relations: Record<string, RelationRef>;
  readonly __row?: Row;
};

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

type ProjectedRow<Shape extends ProjectionShape> = {
  readonly [Field in keyof Shape]: Shape[Field] extends OptionalProjection<infer Value>
    ? Value | undefined
    : Shape[Field] extends ExprData<infer Value>
      ? Value
      : never;
};

/**
 * Apply functional query transforms left to right.
 *
 * @example `pipe(from(object), where(eq(object.kind, 'file')), project({ id: object.id }))`
 */
export function pipe<Input, const Outputs extends readonly unknown[]>(
  input: Input,
  ...transforms: PipeTransforms<Input, Outputs>
): PipeResult<Input, Outputs>;
export function pipe(input: unknown, ...transforms: readonly Transform<unknown, unknown>[]): unknown {
  return transforms.reduce((current, transform) => transform(current), input);
}

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

/** Filter rows by a predicate. */
export function where<Ctx>(predicate: PredicateData): (query: Query<Ctx>) => Query<Ctx> {
  return (query) => ({
    ...query,
    data: { op: 'where', input: query.data, predicate }
  });
}

/** Inner join another query by predicate. */
export function join<Left, Right>(
  right: Query<Right>,
  predicate: PredicateData
): (left: Query<Left>) => Query<Left & Right> {
  return joinQuery('inner', right, predicate);
}

/** Left join another query, preserving unmatched left rows. */
export function leftJoin<Left, Right>(
  right: Query<Right>,
  predicate: PredicateData
): (left: Query<Left>) => Query<Left & Partial<Right>> {
  return joinQuery('left', right, predicate) as (left: Query<Left>) => Query<Left & Partial<Right>>;
}

/** Select result fields from expressions. */
export function project<Shape extends ProjectionShape>(
  projection: Shape
): <Ctx>(query: Query<Ctx>) => Query<ProjectedRow<Shape>> {
  return (query) => ({
    data: { op: 'select', input: query.data, projection },
    relations: query.relations
  }) as Query<ProjectedRow<Shape>>;
}

/** Compare expressions or primitive literals with strict equality. */
export function eq(left: ExprInput, right: ExprInput): PredicateData {
  return { op: 'eq', left: expr(left), right: expr(right) };
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

function isExprData(input: ExprInput): input is ExprData {
  return typeof input === 'object' && input !== null && 'op' in input;
}

function joinQuery<Left, Right>(
  kind: 'inner' | 'left',
  right: Query<Right>,
  predicate: PredicateData
): (left: Query<Left>) => Query<Left & Right> {
  return (left) => {
    return {
      data: { op: 'join', kind, left: left.data, right: right.data, on: predicate },
      relations: { ...left.relations, ...right.relations }
    } as Query<Left & Right>;
  };
}
