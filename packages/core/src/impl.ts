export type MaybePromise<T> = T | Promise<T>;

export type TarstateDiagnosticSeverity = 'info' | 'warning' | 'error';
export type TarstateCoreDiagnosticCode =
  | 'diagnostic'
  | 'not_implemented'
  | 'query_invalid'
  | 'relation_invalid'
  | 'relation_missing'
  | 'field_invalid'
  | 'field_missing'
  | 'row_invalid'
  | 'required'
  | 'unique'
  | 'foreign_key'
  | 'check'
  | 'constraint_failed'
  | 'materialization_unsupported'
  | 'materialization_missing'
  | 'materialization_stale'
  | 'change_tracking_unsupported'
  | 'runtime_unsupported';
export type TarstateDiagnosticCode = TarstateCoreDiagnosticCode | (string & {});
export type TarstateDiagnosticMode = 'collect' | 'throw' | 'warn';
export type TarstateDiagnosticOptions = {
  readonly diagnosticMode?: TarstateDiagnosticMode;
};

export type TarstateDiagnostic = {
  readonly code: TarstateDiagnosticCode;
  readonly severity?: TarstateDiagnosticSeverity;
  readonly message: string;
  readonly relation?: string;
  readonly field?: string;
  readonly surface?: string;
  readonly detail?: unknown;
};

export function diagnostic(input: TarstateDiagnostic): TarstateDiagnostic {
  return input;
}

export function normalizeDiagnostics(
  values: unknown,
  fallback: TarstateDiagnostic
): readonly TarstateDiagnostic[] {
  const list = Array.isArray(values) ? values : [values];
  return list.map((value) => isDiagnostic(value)
    ? value
    : {
        ...fallback,
        message: value instanceof Error ? value.message : typeof value === 'string' ? value : fallback.message,
        detail: value
      });
}

export function collectDiagnostics(...diagnostics: readonly unknown[]): readonly TarstateDiagnostic[] {
  return diagnostics.flatMap((item) => normalizeDiagnostics(item, {
    code: 'diagnostic',
    severity: 'info',
    message: 'diagnostic'
  }));
}

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | readonly JsonValue[] | { readonly [key: string]: JsonValue };
type PrimitiveFieldKind = 'string' | 'number' | 'boolean' | 'id' | 'ref' | 'anchoredPath' | 'json';

export type FieldSpec<Value = unknown> = {
  readonly kind: 'field';
  readonly valueKind: PrimitiveFieldKind;
  readonly optional: boolean;
  readonly nullable: boolean;
  readonly idDomain?: string;
  readonly ref?: string;
  readonly __value?: Value;
};

type RelationFields = Record<string, FieldSpec>;
type RelationKeySpec<Row extends object> = keyof Row & string | readonly (keyof Row & string)[];
type AnyRelationRef = {
  readonly kind: 'relation';
  readonly name: string;
  readonly key: string | readonly string[];
  readonly fields: RelationFields;
  readonly ephemeral: boolean;
  readonly __row?: unknown;
};

export type RelationRef<
  Row extends object = Record<string, unknown>,
  Key extends RelationKeySpec<Row> = RelationKeySpec<Row>
> = {
  readonly kind: 'relation';
  readonly name: string;
  readonly key: Key;
  readonly fields: RelationFields;
  readonly ephemeral: boolean;
  readonly __row?: Row;
};

type RelationRowFromFields<Fields extends RelationFields> = {
  readonly [Field in keyof Fields & string]: Fields[Field] extends FieldSpec<infer Value> ? Value : unknown;
};
type NonNullish<Value> = Exclude<Value, null | undefined>;
type RelationInputField<Value> =
  NonNullish<Value> extends string ? FieldSpec<string | Extract<Value, null | undefined>>
    : NonNullish<Value> extends number ? FieldSpec<number | Extract<Value, null | undefined>>
      : NonNullish<Value> extends boolean ? FieldSpec<boolean | Extract<Value, null | undefined>>
        : FieldSpec<Value>;
type RelationInput<Row extends object, Key extends RelationKeySpec<Row> = RelationKeySpec<Row>> = {
  readonly key: Key;
  readonly fields: { readonly [Field in keyof Row & string]: RelationInputField<Row[Field]> };
  readonly ephemeral?: boolean;
};

export function relation<Row extends object, const Key extends RelationKeySpec<Row> = RelationKeySpec<Row>>(input: RelationInput<Row, Key>): RelationRef<Row, Key>;
export function relation<const Fields extends RelationFields, const Key extends RelationKeySpec<RelationRowFromFields<Fields>>>(input: {
  readonly key: Key;
  readonly fields: Fields;
  readonly ephemeral?: boolean;
}): RelationRef<RelationRowFromFields<Fields>, Key>;
export function relation<Row extends object, Key extends RelationKeySpec<Row> = RelationKeySpec<Row>>(input: RelationInput<Row, Key>): RelationRef<Row, Key> {
  return { kind: 'relation', name: '', key: input.key, fields: input.fields, ephemeral: input.ephemeral ?? false };
}

export function defineSchema<const Schema extends Record<string, AnyRelationRef>>(
  schema: Schema
): { readonly [Key in keyof Schema]: Schema[Key] & { readonly name: Key & string } } {
  return Object.fromEntries(Object.entries(schema).map(([name, ref]) => [name, { ...ref, name }])) as never;
}

function fieldSpec<Value>(valueKind: PrimitiveFieldKind): FieldSpec<Value> {
  return { kind: 'field', valueKind, optional: false, nullable: false };
}

export const stringField = (): FieldSpec<string> => fieldSpec('string');
export const numberField = (): FieldSpec<number> => fieldSpec('number');
export const booleanField = (): FieldSpec<boolean> => fieldSpec('boolean');
export const anchoredPathField = (): FieldSpec<string> => fieldSpec('anchoredPath');
export const jsonField = (): FieldSpec<JsonValue> => fieldSpec('json');
export const idField = (domain: string): FieldSpec<string> => ({ ...fieldSpec<string>('id'), idDomain: domain });
export const refField = (target: string): FieldSpec<string> => ({ ...fieldSpec<string>('ref'), ref: target });
export const nullable = <Value>(spec: FieldSpec<Value>): FieldSpec<Value | null> => ({ ...spec, nullable: true });
export const optional = <Value>(spec: FieldSpec<Value>): FieldSpec<Value | undefined> => ({ ...spec, optional: true });

export function isJsonValue(input: unknown): input is JsonValue {
  if (input === null || typeof input === 'string' || typeof input === 'number' || typeof input === 'boolean') return true;
  if (Array.isArray(input)) return input.every(isJsonValue);
  return isRecord(input) && Object.values(input).every(isJsonValue);
}

export type HostExpressionFunction<Value = unknown> = (...args: readonly unknown[]) => Value;
export type HostFunction<Value = unknown> = {
  readonly kind: 'hostFunction';
  readonly name: string;
  readonly fn: HostExpressionFunction<Value>;
  readonly __value?: Value;
};
export type PrimitiveValue = string | number | boolean | null | undefined;
export type ExprData<Value = unknown> = Readonly<Record<string, unknown>> & {
  readonly op: string;
  readonly __value?: Value;
};
export type AggregateExprData<Value = unknown> = ExprData<Value> & {
  readonly __tarstateExprKind: 'aggregate';
};
export type RowExprData<Value = unknown> = ExprData<Value> & {
  readonly __tarstateExprKind?: never;
};
export type ExprInput<Value = unknown> = ExprData<Value> | PrimitiveValue;
export type ComparisonOp = 'eq' | 'neq' | 'lt' | 'lte' | 'gt' | 'gte';
export type AggregateFunction =
  | 'count'
  | 'countDistinct'
  | 'any'
  | 'notAny'
  | 'sum'
  | 'avg'
  | 'min'
  | 'max'
  | 'top'
  | 'bottom'
  | 'topBy'
  | 'bottomBy'
  | 'maxBy'
  | 'minBy'
  | 'setConcat';
export type PredicateData = ExprData<boolean>;
export type OptionalProjection<Value = unknown> = {
  readonly kind: 'optionalProjection';
  readonly expr: ExprData<Value>;
};
export type ProjectionData = Readonly<Record<string, ExprData | OptionalProjection>>;
export type SortDirection = 'asc' | 'desc';
export type NullSortOrder = 'first' | 'last';
export type SortData = {
  readonly expr: ExprData;
  readonly direction: SortDirection;
  readonly nulls?: NullSortOrder;
};
export type SortInput = ExprInput | SortData;
export type AggregateConfig<GroupBy extends ProjectionData = ProjectionData, Aggregates extends ProjectionData = ProjectionData> = {
  readonly groupBy?: GroupBy;
  readonly aggregates: Aggregates;
};
type ClauseFieldKeys<Row> = Row extends object ? keyof Row & string : string;
type ClauseMapShape<Left, Right> =
  Readonly<Partial<Record<ClauseFieldKeys<Left>, ClauseFieldKeys<Right>>>>;
declare const EQUI_JOIN_CLAUSE_MAP: unique symbol;
declare const CORRELATION_CLAUSE_MAP: unique symbol;
export type EquiJoinClauseMap<Left = Record<string, unknown>, Right = Record<string, unknown>> =
  ClauseMapShape<Left, Right> & {
    readonly [EQUI_JOIN_CLAUSE_MAP]: {
      readonly left: Left;
      readonly right: Right;
    };
  };
export type CorrelationClauseMap<Outer = Record<string, unknown>, Inner = Record<string, unknown>> =
  ClauseMapShape<Outer, Inner> & {
    readonly [CORRELATION_CLAUSE_MAP]: {
      readonly outer: Outer;
      readonly inner: Inner;
    };
  };
export type ExpandOptions<
  Alias extends string | undefined = string | undefined,
  Fields extends readonly string[] | undefined = readonly string[] | undefined
> = {
  readonly as?: Alias;
  readonly fields?: Fields;
};
export type QueryData = Readonly<Record<string, unknown>> & { readonly op: string };
export type Query<Row = unknown> = {
  readonly data: QueryData;
  readonly relations: Readonly<Record<string, AnyRelationRef>>;
  readonly __row?: Row;
};
export type QueryKeyInput = Query | QueryData;
export class QueryKeyError extends Error {
  readonly code = 'unsupported_query_key_value';
  readonly path: string;
  readonly value: unknown;

  constructor(path: string, value: unknown, reason: string) {
    super(`queryKey cannot encode ${reason} at ${path}`);
    this.name = 'QueryKeyError';
    this.path = path;
    this.value = value;
  }
}
type AliasedFieldAccess<Row, Alias extends string> =
  {
    readonly alias: Alias;
    readonly $: AliasFieldNamespace<Row>;
  } & AliasedFlatFieldAccess<Row>;
type RowFieldKeys<Row> = Row extends object ? keyof Row & string : never;
type LiteralRowFieldKeys<Row> = string extends RowFieldKeys<Row> ? never : RowFieldKeys<Row>;
type AliasedReservedField = keyof RelationRef | keyof Query | 'alias' | '$';
type AliasFieldNamespace<Row> = string extends RowFieldKeys<Row>
  ? Readonly<Record<string, ExprData<unknown>>>
  : { readonly [Field in RowFieldKeys<Row>]: ExprData<Row[Field]> };
type AliasedFlatFieldAccess<Row> = {
  readonly [Field in Exclude<LiteralRowFieldKeys<Row>, AliasedReservedField>]: ExprData<Row[Field]>;
};
export type AliasedRelationRef<Row extends object, Alias extends string> =
  RelationRef<Row> & AliasedFieldAccess<Row, Alias>;
export type AliasedQuery<Row, Alias extends string> = Query<Row> & AliasedFieldAccess<Row, Alias>;

type ExprValue<Input> = Input extends ExprData<infer Value> ? Value : Input;
type ProjectedRow<Shape extends ProjectionData> = {
  readonly [Key in keyof Shape]: Shape[Key] extends OptionalProjection<infer Value>
    ? Value | undefined
    : Shape[Key] extends ExprData<infer Value>
      ? Value
      : unknown;
};

type PreserveQueryTransform = (<Row>(query: Query<Row>) => Query<Row>) & { readonly __queryTransform?: 'preserve' };
type ProjectQueryTransform<RowOut> = (<Row>(query: Query<Row>) => Query<RowOut>) & { readonly __queryProject?: RowOut };
type ExtendQueryTransform<RowAdd> = (<Row>(query: Query<Row>) => Query<Row & RowAdd>) & { readonly __queryExtend?: RowAdd };
type WithoutQueryTransform<Fields extends readonly string[]> = (<Row>(query: Query<Row>) => Query<Omit<Row, Extract<Fields[number], keyof Row>>>) & {
  readonly __queryWithout?: Fields;
};
type RenameFields = Readonly<Record<string, string>>;
type RenameSourceKeys<Row, Fields extends RenameFields> = Extract<keyof Fields, keyof Row> & string;
type RenameDestinationKeys<Row, Fields extends RenameFields> = Fields[RenameSourceKeys<Row, Fields>] & string;
type RenameRow<Row, Fields extends RenameFields> =
  Omit<Row, RenameSourceKeys<Row, Fields> | Extract<RenameDestinationKeys<Row, Fields>, keyof Row & string>>
  & { readonly [Field in RenameSourceKeys<Row, Fields> as Fields[Field] & string]: Row[Field] };
type RenameQueryTransform<Fields extends RenameFields> = (<Row>(query: Query<Row>) => Query<RenameRow<Row, Fields>>) & {
  readonly __queryRename?: Fields;
};
type ExpandedItem<Collection> = NonNullish<Collection> extends ReadonlyArray<infer Item>
  ? Item
  : NonNullish<Collection> extends Iterable<infer Item>
    ? Item
    : unknown;
type ExpandAliasRow<Collection, Alias> = Alias extends string ? { readonly [Key in Alias]: ExpandedItem<Collection> } : {};
type TupleFieldValue<Item, Index extends PropertyKey> =
  Index extends keyof Item
    ? Item[Index]
    : Index extends `${infer NumberIndex extends number}`
      ? NumberIndex extends keyof Item ? Item[NumberIndex] : unknown
      : unknown;
type ExpandTupleFieldsRow<Item, Fields extends readonly string[]> = {
  readonly [Index in keyof Fields as Index extends `${number}` ? Fields[Index] extends string ? Fields[Index] : never : never]: TupleFieldValue<Item, Index>;
};
type ExpandObjectFieldsRow<Item, Fields extends readonly string[]> = {
  readonly [Field in Fields[number]]: Field extends keyof Item ? Item[Field] : unknown;
};
type ExpandFieldsRow<Collection, Fields> = Fields extends readonly string[]
  ? ExpandedItem<Collection> extends readonly unknown[]
    ? ExpandTupleFieldsRow<ExpandedItem<Collection>, Fields>
    : ExpandedItem<Collection> extends object
      ? ExpandObjectFieldsRow<ExpandedItem<Collection>, Fields>
      : { readonly [Field in Fields[number]]: unknown }
  : {};
type ExpandRow<Collection, Alias, Fields> = ExpandAliasRow<Collection, Alias> & ExpandFieldsRow<Collection, Fields>;
type ExpandQueryTransform<RowAdd> = (<Row>(query: Query<Row>) => Query<Row & RowAdd>) & { readonly __queryExpand?: RowAdd };
type JoinQueryTransform<Right, Kind extends 'inner' | 'left'> = (<Left>(query: Query<Left>) => Query<Kind extends 'left' ? Left & Partial<Right> : Left & Right>) & {
  readonly __queryJoin?: Kind;
  readonly __queryRight?: Right;
};
type QualifyQueryTransform<Alias extends string> = (<Row>(query: Query<Row>) => Query<Record<Alias, Row>>) & { readonly __queryQualify?: Alias };
type PipeStep<Input, Transform> =
  Transform extends { readonly __queryTransform?: 'preserve' } ? Input
    : Transform extends { readonly __queryProject?: infer RowOut } ? Query<RowOut>
      : Transform extends { readonly __queryExtend?: infer RowAdd } ? Input extends Query<infer Row> ? Query<Row & RowAdd> : never
        : Transform extends { readonly __queryWithout?: infer Fields }
          ? Input extends Query<infer Row>
            ? Fields extends readonly string[] ? Query<Omit<Row, Extract<Fields[number], keyof Row>>> : never
            : never
          : Transform extends { readonly __queryRename?: infer Fields }
            ? Input extends Query<infer Row>
              ? Fields extends RenameFields ? Query<RenameRow<Row, Fields>> : never
              : never
            : Transform extends { readonly __queryExpand?: infer RowAdd }
              ? Input extends Query<infer Row> ? Query<Row & RowAdd> : never
              : Transform extends { readonly __queryJoin?: infer Kind; readonly __queryRight?: infer Right }
                ? Input extends Query<infer Left>
                  ? Query<Kind extends 'left' ? Left & Partial<Right> : Left & Right>
                  : never
                : Transform extends { readonly __queryQualify?: infer Alias }
            ? Input extends Query<infer Row>
              ? Alias extends string ? Query<Record<Alias, Row>> : never
              : never
            : Transform extends (input: Input) => infer Output ? Output : never;
type PipeResult<Input, Transforms extends readonly unknown[]> = Transforms extends readonly []
  ? Input
  : Transforms extends readonly [infer First, ...infer Rest]
    ? PipeResult<PipeStep<Input, First>, Rest>
    : never;

export function pipe<Input, const Transforms extends readonly unknown[]>(
  input: Input,
  ...transforms: Transforms
): PipeResult<Input, Transforms>;
export function pipe(input: unknown, ...transforms: readonly ((input: unknown) => unknown)[]): unknown {
  return transforms.reduce((current, transform) => transform(current), input);
}

export function queryKey(input: QueryKeyInput): string {
  return `query:${encodeQueryKeyValue('data' in input ? input.data : input, '$')}`;
}

export function relationDependencies(input: QueryKeyInput): readonly string[] {
  return queryDataDependencies(isQuery(input) ? input.data : input as QueryData);
}

export function queryRowKeyFields(input: QueryKeyInput): readonly string[] | undefined {
  const data = isQuery(input) ? input.data : input as QueryData;
  return queryDataRowKeyFields(data, isQuery(input) ? input.relations : {});
}

export const clauses = <Left = Record<string, unknown>, Right = Record<string, unknown>>(
  map: ClauseMapShape<Left, Right>
): EquiJoinClauseMap<Left, Right> => map as EquiJoinClauseMap<Left, Right>;
export const correlate = <Outer = Record<string, unknown>, Inner = Record<string, unknown>>(
  map: ClauseMapShape<Outer, Inner>
): CorrelationClauseMap<Outer, Inner> => map as CorrelationClauseMap<Outer, Inner>;

export function as<Row extends object, Alias extends string>(relationRef: RelationRef<Row>, alias: Alias): AliasedRelationRef<Row, Alias>;
export function as<Row, Alias extends string>(query: Query<Row>, alias: Alias): AliasedQuery<Row, Alias>;
export function as<Row, Alias extends string>(
  input: RelationRef<Row & object> | Query<Row>,
  alias: Alias
): AliasedRelationRef<Row & object, Alias> | AliasedQuery<Row, Alias> {
  const target: Record<string, unknown> = { ...input, alias };
  const namespace: Record<string, ExprData> = {};

  for (const fieldName of aliasedFieldNames(input)) {
    const exprData = field(alias, fieldName);
    defineAliasProperty(namespace, fieldName, exprData);
    if (!(fieldName in target) && !ALIASED_FIELD_RESERVED_KEYS.has(fieldName)) {
      defineAliasProperty(target, fieldName, exprData);
    }
  }

  defineAliasProperty(target, '$', namespace);
  return target as AliasedRelationRef<Row & object, Alias> | AliasedQuery<Row, Alias>;
}

export function field<Value = unknown>(alias: string, name: string): ExprData<Value> {
  return { op: 'field', alias, field: name };
}

export function value<Value extends PrimitiveValue>(literal: Value): ExprData<Value> {
  return { op: 'value', value: literal };
}

export function env<Value = unknown>(name: string): ExprData<Value> {
  return { op: 'env', name };
}

export function hostFn<Value = unknown>(name: string, fn: HostExpressionFunction<Value>): HostFunction<Value> {
  if (name.trim() === '') throw new QueryKeyError('$.fn.name', name, 'an empty host function name');
  return { kind: 'hostFunction', name, fn };
}

export function call<Value = unknown>(fn: HostFunction<Value>, ...args: readonly ExprInput[]): ExprData<Value> {
  return { op: 'call', fn, args };
}

export function maybe<Value>(expr: ExprData<Value>): ExprData<Value | undefined> {
  return { op: 'maybe', expr };
}

export function tuple<const Values extends readonly ExprInput[]>(
  ...values: Values
): ExprData<{ readonly [Index in keyof Values]: ExprValue<Values[Index]> }> {
  return { op: 'tuple', values };
}

function comparison(op: ComparisonOp, left: ExprInput, right: ExprInput): PredicateData {
  return { op, left: expr(left), right: expr(right) };
}

export function eq<Left extends ExprInput>(left: Left, right: ExprInput<ExprValue<Left> | null | undefined>): PredicateData {
  return comparison('eq', left, right);
}
export function neq<Left extends ExprInput>(left: Left, right: ExprInput<ExprValue<Left> | null | undefined>): PredicateData {
  return comparison('neq', left, right);
}
export function lt<Left extends ExprInput>(left: Left, right: ExprInput<ExprValue<Left>>): PredicateData {
  return comparison('lt', left, right);
}
export function lte<Left extends ExprInput>(left: Left, right: ExprInput<ExprValue<Left>>): PredicateData {
  return comparison('lte', left, right);
}
export function gt<Left extends ExprInput>(left: Left, right: ExprInput<ExprValue<Left>>): PredicateData {
  return comparison('gt', left, right);
}
export function gte<Left extends ExprInput>(left: Left, right: ExprInput<ExprValue<Left>>): PredicateData {
  return comparison('gte', left, right);
}

export const and = (...predicates: readonly PredicateData[]): PredicateData => ({ op: 'and', predicates });
export const or = (...predicates: readonly PredicateData[]): PredicateData => ({ op: 'or', predicates });
export const not = (predicate: PredicateData): PredicateData => ({ op: 'not', predicate });
export const isNull = (input: ExprInput): PredicateData => ({ op: 'isNull', expr: expr(input) });
export const notNull = (input: ExprInput): PredicateData => ({ op: 'notNull', expr: expr(input) });
export const isMissing = (input: ExprInput): PredicateData => ({ op: 'isMissing', expr: expr(input) });
export const notMissing = (input: ExprInput): PredicateData => ({ op: 'notMissing', expr: expr(input) });

export function from<Row extends object>(relationRef: RelationRef<Row> | AliasedRelationRef<Row, string>): Query<Row> {
  const alias = 'alias' in relationRef ? relationRef.alias : relationRef.name;
  return { data: { op: 'from', relation: relationRef.name, alias }, relations: { [relationRef.name]: relationRef } };
}

export function lookup<Row extends object, Field extends keyof Row & string>(
  relationRef: RelationRef<Row> | AliasedRelationRef<Row, string>,
  fieldName: Field,
  lookupValue: Row[Field]
): Query<Row> {
  const alias = 'alias' in relationRef ? relationRef.alias : relationRef.name;
  return { data: { op: 'lookup', relation: relationRef.name, alias, field: fieldName, value: lookupValue }, relations: { [relationRef.name]: relationRef } };
}

export function constRows<Row extends object>(rows: readonly Row[]): Query<Row> {
  return { data: { op: 'constRows', rows }, relations: {} };
}

export const where = (predicate: PredicateData): PreserveQueryTransform => ((query) =>
  ({ ...query, data: { op: 'where', input: query.data, predicate } })) as PreserveQueryTransform;
export const hash = (expression: ExprData): PreserveQueryTransform => ((query) =>
  ({ ...query, data: { op: 'hash', input: query.data, expressions: [expression] } })) as PreserveQueryTransform;
export const btree = (expression: ExprData): PreserveQueryTransform => ((query) =>
  ({ ...query, data: { op: 'btree', input: query.data, expressions: [expression] } })) as PreserveQueryTransform;
export const uniqueIndex = (expression: ExprData): PreserveQueryTransform => ((query) =>
  ({ ...query, data: { op: 'uniqueIndex', input: query.data, expressions: [expression] } })) as PreserveQueryTransform;
export const keyBy = (...fields: readonly string[]): PreserveQueryTransform => ((query) =>
  ({ ...query, data: { op: 'keyBy', input: query.data, fields } })) as PreserveQueryTransform;
export function join<Right>(right: Query<Right>, on: PredicateData): JoinQueryTransform<Right, 'inner'>;
export function join<Left, Right>(right: Query<Right>, on: EquiJoinClauseMap<Left, Right>): JoinQueryTransform<Right, 'inner'>;
export function join<Right>(right: Query<Right>, on: PredicateData | EquiJoinClauseMap<unknown, Right>): JoinQueryTransform<Right, 'inner'> {
  return ((left) =>
    ({ data: { op: 'join', kind: 'inner', left: left.data, right: right.data, on, ...queryAliasData(right, 'rightAlias') }, relations: { ...left.relations, ...right.relations } })) as JoinQueryTransform<Right, 'inner'>;
}
export function leftJoin<Right>(right: Query<Right>, on: PredicateData): JoinQueryTransform<Right, 'left'>;
export function leftJoin<Left, Right>(right: Query<Right>, on: EquiJoinClauseMap<Left, Right>): JoinQueryTransform<Right, 'left'>;
export function leftJoin<Right>(right: Query<Right>, on: PredicateData | EquiJoinClauseMap<unknown, Right>): JoinQueryTransform<Right, 'left'> {
  return ((left) =>
    ({ data: { op: 'join', kind: 'left', left: left.data, right: right.data, on, ...queryAliasData(right, 'rightAlias') }, relations: { ...left.relations, ...right.relations } })) as JoinQueryTransform<Right, 'left'>;
}
export const project = <Shape extends ProjectionData>(projection: Shape): ProjectQueryTransform<ProjectedRow<Shape>> => ((query) =>
  ({ data: { op: 'project', input: query.data, projection }, relations: query.relations })) as ProjectQueryTransform<ProjectedRow<Shape>>;
export const extend = <Shape extends ProjectionData>(projection: Shape): ExtendQueryTransform<ProjectedRow<Shape>> => ((query) =>
  ({ data: { op: 'extend', input: query.data, projection }, relations: query.relations })) as ExtendQueryTransform<ProjectedRow<Shape>>;
export const expand = <Collection, const Alias extends string | undefined = undefined, const Fields extends readonly string[] | undefined = undefined>(
  collection: ExprData<Collection>,
  options: ExpandOptions<Alias, Fields> = {} as ExpandOptions<Alias, Fields>
): ExpandQueryTransform<ExpandRow<Collection, Alias, Fields>> =>
  ((query) => ({ ...query, data: { op: 'expand', input: query.data, collection, ...options } })) as ExpandQueryTransform<ExpandRow<Collection, Alias, Fields>>;
export const without = <const Fields extends readonly string[]>(...fields: Fields): WithoutQueryTransform<Fields> => ((query) =>
  ({ ...query, data: { op: 'without', input: query.data, fields } })) as WithoutQueryTransform<Fields>;
export const sort = (...order: readonly SortInput[]): PreserveQueryTransform => ((query) =>
  ({ ...query, data: { op: 'sort', input: query.data, order } })) as PreserveQueryTransform;
export const limit = (count: number, offset?: number): PreserveQueryTransform => ((query) =>
  ({ ...query, data: { op: 'limit', input: query.data, count, offset } })) as PreserveQueryTransform;
export const sortLimit = (count: number, ...order: readonly SortInput[]): PreserveQueryTransform => ((query) =>
  ({ ...query, data: { op: 'sortLimit', input: query.data, order, count } })) as PreserveQueryTransform;
export const union = <Row>(...inputs: readonly Query<Row>[]): Query<Row> =>
  ({ data: { op: 'union', inputs: inputs.map((item) => item.data) }, relations: mergeRelations(inputs) });
export const intersection = <Row>(...inputs: readonly Query<Row>[]): Query<Row> =>
  ({ data: { op: 'intersection', inputs: inputs.map((item) => item.data) }, relations: mergeRelations(inputs) });
export const difference = <Row>(left: Query<Row>, right: Query<Row>): Query<Row> =>
  ({ data: { op: 'difference', left: left.data, right: right.data }, relations: { ...left.relations, ...right.relations } });
export const rename = <const Fields extends RenameFields>(fields: Fields): RenameQueryTransform<Fields> => ((query) =>
  ({ ...query, data: { op: 'rename', input: query.data, fields } })) as RenameQueryTransform<Fields>;
export const qualify = <Alias extends string>(alias: Alias): QualifyQueryTransform<Alias> => ((query) =>
  ({ data: { op: 'qualify', input: query.data, alias }, relations: query.relations })) as QualifyQueryTransform<Alias>;
export const aggregate = <GroupBy extends ProjectionData, Aggregates extends ProjectionData>(
  config: AggregateConfig<GroupBy, Aggregates>
): ProjectQueryTransform<ProjectedRow<GroupBy> & ProjectedRow<Aggregates>> =>
  ((query) => ({ data: { op: 'aggregate', input: query.data, ...config }, relations: query.relations })) as ProjectQueryTransform<ProjectedRow<GroupBy> & ProjectedRow<Aggregates>>;

export const asc = (input: SortInput, nulls?: NullSortOrder): SortData => ({ expr: expr(input), direction: 'asc', ...(nulls === undefined ? {} : { nulls }) });
export const desc = (input: SortInput, nulls?: NullSortOrder): SortData => ({ expr: expr(input), direction: 'desc', ...(nulls === undefined ? {} : { nulls }) });
export const count = (predicate?: PredicateData): AggregateExprData<number> => predicate === undefined ? aggregateCall<number>('count') : aggregateCall<number>('count', predicate);
export const countDistinct = (input?: ExprInput): AggregateExprData<number> => aggregateCall<number>('countDistinct', input);
export const any = (predicate: PredicateData): AggregateExprData<boolean> => aggregateCall<boolean>('any', predicate);
export const notAny = (predicate: PredicateData): AggregateExprData<boolean> => aggregateCall<boolean>('notAny', predicate);
export const sum = (input: ExprInput<number>): AggregateExprData<number> => aggregateCall<number>('sum', input);
export const avg = (input: ExprInput<number>): AggregateExprData<number> => aggregateCall<number>('avg', input);
export const min = <Value = unknown>(input: ExprInput<Value>): AggregateExprData<Value> => aggregateCall<Value>('min', input);
export const max = <Value = unknown>(input: ExprInput<Value>): AggregateExprData<Value> => aggregateCall<Value>('max', input);
export const top = <Value = unknown>(input: ExprInput<Value>, countValue = 1): AggregateExprData<readonly Value[]> => aggregateCall<readonly Value[]>('top', input, countValue);
export const bottom = <Value = unknown>(input: ExprInput<Value>, countValue = 1): AggregateExprData<readonly Value[]> => aggregateCall<readonly Value[]>('bottom', input, countValue);
export const topBy = <Value = unknown>(input: ExprInput<Value>, by: ExprInput, countValue = 1): AggregateExprData<readonly Value[]> => aggregateCall<readonly Value[]>('topBy', input, by, countValue);
export const bottomBy = <Value = unknown>(input: ExprInput<Value>, by: ExprInput, countValue = 1): AggregateExprData<readonly Value[]> => aggregateCall<readonly Value[]>('bottomBy', input, by, countValue);
export const maxBy = <Row = unknown>(input: ExprInput<Row>, by: ExprInput): AggregateExprData<Row> => aggregateCall<Row>('maxBy', input, by);
export const minBy = <Row = unknown>(input: ExprInput<Row>, by: ExprInput): AggregateExprData<Row> => aggregateCall<Row>('minBy', input, by);
export const setConcat = <Value = unknown>(input: ExprInput<readonly Value[]>): AggregateExprData<readonly Value[]> => aggregateCall<readonly Value[]>('setConcat', input);
export const self = <Row = unknown>(): ExprData<Row> => ({ op: 'self' });
export function sel<Row>(query: Query<Row>): ExprData<readonly Row[]>;
export function sel<Outer, Row>(query: Query<Row>, correlation: CorrelationClauseMap<Outer, Row>): ExprData<readonly Row[]>;
export function sel<Row>(query: Query<Row>, correlation?: CorrelationClauseMap<unknown, Row>): ExprData<readonly Row[]> {
  return { op: 'sel', query: query.data, relations: query.relations, ...(correlation === undefined ? {} : { correlation }) };
}
export function sel1<Row>(query: Query<Row>): ExprData<Row | undefined>;
export function sel1<Outer, Row>(query: Query<Row>, correlation: CorrelationClauseMap<Outer, Row>): ExprData<Row | undefined>;
export function sel1<Row>(query: Query<Row>, correlation?: CorrelationClauseMap<unknown, Row>): ExprData<Row | undefined> {
  return { op: 'sel1', query: query.data, relations: query.relations, ...(correlation === undefined ? {} : { correlation }) };
}

export type EvaluateFunction = (...args: readonly unknown[]) => unknown;
export type EvaluateFunctions = Readonly<Record<string, EvaluateFunction>>;
export type EvaluateEnv = Readonly<Record<string, unknown>>;
export type EvaluateOptions = TarstateDiagnosticOptions & {
  readonly env?: EvaluateEnv;
  readonly functions?: EvaluateFunctions;
};
export type QueryResult<Row> = {
  readonly rows: readonly Row[];
  readonly diagnostics: readonly TarstateDiagnostic[];
};

export function evaluate<Row>(source: RelationSource, query: Query<Row>, options: EvaluateOptions = {}): QueryResult<Row> {
  const diagnostics: TarstateDiagnostic[] = [...(source.diagnostics?.() ?? [])];

  try {
    const rows = evaluateQueryData(source, query.data, query.relations, options, undefined, diagnostics)
      .map((entry) => entry.row as Row);
    return finishQueryResult({ rows, diagnostics }, options);
  } catch (error) {
    diagnostics.push(...normalizeDiagnostics(error, {
      code: 'query_invalid',
      severity: 'error',
      message: 'query evaluation failed',
      surface: 'evaluate'
    }));
    return finishQueryResult({ rows: [], diagnostics }, options);
  }
}

export function validateRelationRow(relationRef: RelationRef, rowValue: Record<string, unknown>): readonly TarstateDiagnostic[] {
  const diagnostics: TarstateDiagnostic[] = [];

  if (!isRecord(rowValue)) {
    diagnostics.push({
      code: 'row_invalid',
      severity: 'error',
      message: `row for relation "${relationRef.name}" must be an object`,
      relation: relationRef.name,
      surface: 'validateRelationRow',
      detail: rowValue
    });
    return diagnostics;
  }

  for (const [fieldName, spec] of Object.entries(relationRef.fields)) {
    const hasField = Object.prototype.hasOwnProperty.call(rowValue, fieldName);
    const fieldValue = rowValue[fieldName];

    if (!hasField || fieldValue === undefined) {
      if (!spec.optional) {
        diagnostics.push({
          code: 'field_missing',
          severity: 'error',
          message: `relation "${relationRef.name}" row is missing required field "${fieldName}"`,
          relation: relationRef.name,
          field: fieldName,
          surface: 'validateRelationRow'
        });
      }
      continue;
    }

    if (fieldValue === null) {
      if (!spec.nullable) {
        diagnostics.push({
          code: 'field_invalid',
          severity: 'error',
          message: `relation "${relationRef.name}" field "${fieldName}" must not be null`,
          relation: relationRef.name,
          field: fieldName,
          surface: 'validateRelationRow'
        });
      }
      continue;
    }

    if (!fieldValueMatchesSpec(spec, fieldValue)) {
      diagnostics.push({
        code: 'field_invalid',
        severity: 'error',
        message: `relation "${relationRef.name}" field "${fieldName}" must be ${fieldSpecDescription(spec)}`,
        relation: relationRef.name,
        field: fieldName,
        surface: 'validateRelationRow',
        detail: fieldValue
      });
    }
  }

  for (const keyField of relationKeyFields(relationRef)) {
    if (rowValue[keyField] === undefined || rowValue[keyField] === null) {
      diagnostics.push({
        code: 'field_missing',
        severity: 'error',
        message: `relation "${relationRef.name}" key field "${keyField}" is missing`,
        relation: relationRef.name,
        field: keyField,
        surface: 'validateRelationRow'
      });
    }
  }

  return diagnostics;
}

export function rowKey(relationRef: RelationRef, row: Record<string, unknown>): string | undefined {
  const fields = relationKeyFields(relationRef);
  const values: unknown[] = [];

  for (const fieldName of fields) {
    if (!Object.prototype.hasOwnProperty.call(row, fieldName) || row[fieldName] === undefined) return undefined;
    values.push(row[fieldName]);
  }

  return stableKey(values);
}

export type RowChange<Row = unknown> =
  | { readonly kind: 'added'; readonly row: Row; readonly key: string }
  | { readonly kind: 'removed'; readonly row: Row; readonly key: string }
  | { readonly kind: 'updated'; readonly before: Row; readonly after: Row; readonly key: string };
export type RowKeySelector<Row = unknown> = (row: Row) => unknown;
export type RowDiffSide = 'before' | 'after';
export type RowDiffDiagnostic<Row = unknown> = TarstateDiagnostic & {
  readonly side?: RowDiffSide;
  readonly row?: Row;
};
export type RowDiffOptions<Row = unknown> = {
  readonly keyBy?: RowKeySelector<Row> | readonly string[];
};
export type RowDiff<Row = unknown> = {
  readonly changes: readonly RowChange<Row>[];
  readonly diagnostics: readonly RowDiffDiagnostic<Row>[];
};

export function diffRows<Row>(before: readonly Row[], after: readonly Row[], options: RowDiffOptions<Row> = {}): RowDiff<Row> {
  const diagnostics: RowDiffDiagnostic<Row>[] = [];
  const beforeMap = new Map<string, Row>();
  const afterMap = new Map<string, Row>();
  const duplicateBefore = new Set<string>();
  const duplicateAfter = new Set<string>();

  for (const rowValue of before) {
    const key = rowDiffKey(rowValue, options);
    if (beforeMap.has(key)) duplicateBefore.add(key);
    beforeMap.set(key, rowValue);
  }

  for (const rowValue of after) {
    const key = rowDiffKey(rowValue, options);
    if (afterMap.has(key)) duplicateAfter.add(key);
    afterMap.set(key, rowValue);
  }

  for (const key of duplicateBefore) {
    diagnostics.push({
      code: 'row_invalid',
      severity: 'warning',
      message: `duplicate before row diff key ${key}`,
      side: 'before',
      surface: 'diffRows'
    });
  }

  for (const key of duplicateAfter) {
    diagnostics.push({
      code: 'row_invalid',
      severity: 'warning',
      message: `duplicate after row diff key ${key}`,
      side: 'after',
      surface: 'diffRows'
    });
  }

  const changes: RowChange<Row>[] = [];
  const keys = new Set<string>([...beforeMap.keys(), ...afterMap.keys()]);

  for (const key of keys) {
    const beforeRow = beforeMap.get(key);
    const afterRow = afterMap.get(key);

    if (beforeRow === undefined && afterRow !== undefined) {
      changes.push({ kind: 'added', row: afterRow, key });
      continue;
    }

    if (beforeRow !== undefined && afterRow === undefined) {
      changes.push({ kind: 'removed', row: beforeRow, key });
      continue;
    }

    if (beforeRow !== undefined && afterRow !== undefined && stableKey(beforeRow) !== stableKey(afterRow)) {
      changes.push({ kind: 'updated', before: beforeRow, after: afterRow, key });
    }
  }

  return { changes, diagnostics };
}

export function rowDiffKey<Row>(row: Row, options: RowDiffOptions<Row> = {}): string {
  if (typeof options.keyBy === 'function') return stableKey(options.keyBy(row));
  if (Array.isArray(options.keyBy) && isRecord(row)) return stableKey(options.keyBy.map((fieldName) => row[fieldName]));
  return stableKey(row);
}

export type RelationLookup = {
  readonly relation: RelationRef;
  readonly field: string;
  readonly value: unknown;
};
export type RelationRangeBound<Value = unknown> = {
  readonly value: Value;
  readonly inclusive: boolean;
};
export type RelationRangeLookup = {
  readonly relation: RelationRef;
  readonly field: string;
  readonly lower?: RelationRangeBound;
  readonly upper?: RelationRangeBound;
};
export type RelationSource = {
  readonly relationNames?: readonly string[];
  readonly rows: (relation: RelationRef) => readonly unknown[];
  readonly lookup?: (lookup: RelationLookup) => readonly unknown[] | undefined;
  readonly rangeLookup?: (lookup: RelationRangeLookup) => readonly unknown[] | undefined;
  readonly version?: () => unknown;
  readonly diagnostics?: () => readonly TarstateDiagnostic[];
};

export function fromObjectSource(data: Record<string, readonly unknown[]>): RelationSource {
  return {
    relationNames: Object.keys(data),
    rows: (relationRef) => data[relationRef.name] ?? [],
    lookup: ({ relation: relationRef, field: fieldName, value: lookupValue }) =>
      (data[relationRef.name] ?? []).filter((rowValue) => isRecord(rowValue) && Object.is(rowValue[fieldName], lookupValue)),
    rangeLookup: ({ relation: relationRef, field: fieldName, lower, upper }) =>
      (data[relationRef.name] ?? []).filter((rowValue) => {
        if (!isRecord(rowValue)) return false;
        const valueValue = rowValue[fieldName];
        if (lower !== undefined) {
          const comparisonValue = compareValues(valueValue, lower.value);
          if (comparisonValue < 0 || (comparisonValue === 0 && !lower.inclusive)) return false;
        }
        if (upper !== undefined) {
          const comparisonValue = compareValues(valueValue, upper.value);
          if (comparisonValue > 0 || (comparisonValue === 0 && !upper.inclusive)) return false;
        }
        return true;
      })
  };
}

export const isRelationSource = (input: unknown): input is RelationSource => isRecord(input) && typeof input.rows === 'function';
export const composeSources = (...sources: readonly RelationSource[]): RelationSource => ({
  relationNames: Array.from(new Set(sources.flatMap((source) => source.relationNames ?? []))),
  rows: (relationRef) => sources.flatMap((source) => source.rows(relationRef)),
  lookup: (lookupValue) => sources.flatMap((source) =>
    source.lookup?.(lookupValue) ?? source.rows(lookupValue.relation)
      .filter((rowValue) => isRecord(rowValue) && Object.is(rowValue[lookupValue.field], lookupValue.value))),
  rangeLookup: (lookupValue) => sources.flatMap((source) =>
    source.rangeLookup?.(lookupValue) ?? source.rows(lookupValue.relation)
      .filter((rowValue) => {
        if (!isRecord(rowValue)) return false;
        const valueValue = rowValue[lookupValue.field];
        if (lookupValue.lower !== undefined) {
          const comparisonValue = compareValues(valueValue, lookupValue.lower.value);
          if (comparisonValue < 0 || (comparisonValue === 0 && !lookupValue.lower.inclusive)) return false;
        }
        if (lookupValue.upper !== undefined) {
          const comparisonValue = compareValues(valueValue, lookupValue.upper.value);
          if (comparisonValue > 0 || (comparisonValue === 0 && !lookupValue.upper.inclusive)) return false;
        }
        return true;
      }))
});

export type RelationDelta<Relation extends RelationRef = RelationRef> = {
  readonly relation: Relation;
  readonly added: readonly unknown[];
  readonly removed: readonly unknown[];
};

export const relationDeltas = (...deltas: readonly RelationDelta[]): readonly RelationDelta[] => deltas;
export const relationDeltaNames = (deltas: readonly RelationDelta[]): readonly string[] =>
  Array.from(new Set(deltas.map((delta) => delta.relation.name)));
const materializationEnvDeltaNames = (deltas: readonly MaterializationEnvDelta[]): readonly string[] =>
  Array.from(new Set(deltas.map((delta) => delta.name)));

export type AdapterSource<Version = unknown> = Omit<RelationSource, 'version'> & {
  readonly version?: () => Version | undefined;
};
export type AdapterSnapshot<Version = unknown> = {
  readonly source: AdapterSource<Version>;
  readonly version?: Version;
  readonly diagnostics?: readonly TarstateDiagnostic[];
};
export type RelationApplyDurability = 'durable' | 'ephemeral' | 'memory';
export type RelationApplyStatus = 'accepted' | 'partial' | 'rejected';
export type RelationApplyAcceptedResult<Version = unknown> = RelationApplyResultBase<Version> & { readonly status: 'accepted' };
export type RelationApplyPartialResult<Version = unknown> = RelationApplyResultBase<Version> & { readonly status: 'partial' };
export type RelationApplyRejectedResult<Version = unknown> = RelationApplyResultBase<Version> & {
  readonly status: 'rejected';
  readonly applied: 0;
  readonly deltas: readonly [];
};
export type RelationApplyResult<Version = unknown> =
  | RelationApplyAcceptedResult<Version>
  | RelationApplyPartialResult<Version>
  | RelationApplyRejectedResult<Version>;
type RelationApplyResultBase<Version = unknown> = {
  readonly patches: number;
  readonly applied: number;
  readonly deltas: readonly RelationDelta[];
  readonly diagnostics: readonly TarstateDiagnostic[];
  readonly version?: Version;
  readonly durability?: RelationApplyDurability;
};
export type RelationApply<Version = unknown> = (patches: readonly WritePatch[]) => MaybePromise<RelationApplyResult<Version>>;
export type RelationPatchTarget<Version = unknown> = {
  readonly relationNames?: readonly string[];
  readonly ownsRelation?: (relationName: string) => boolean;
  readonly apply: RelationApply<Version>;
};
export type RelationRuntime<Version = unknown> = {
  readonly source: AdapterSource<Version>;
  readonly target?: RelationPatchTarget<Version>;
  readonly snapshot?: () => AdapterSnapshot<Version>;
  readonly subscribe?: (listener: () => void) => () => void;
};
export type RelationRuntimeVersion<Runtime extends RelationRuntime = RelationRuntime> =
  Runtime extends RelationRuntime<infer Version> ? Version : never;
export type ComposedRelationRuntimeVersion<Runtimes extends readonly RelationRuntime[]> = {
  readonly [Index in keyof Runtimes]: RelationRuntimeVersion<Runtimes[Index]>;
};
export type RelationApplyOptions = TarstateDiagnosticOptions & { readonly readVersion?: boolean };
export type RelationApplyReport<Version = unknown> = RelationApplyResult<Version> & { readonly source: AdapterSource<Version> };

export async function tryApplyRelationPatches<Version = unknown>(
  runtime: RelationRuntime<Version>,
  patches: Iterable<WritePatch>,
  options: RelationApplyOptions = {}
): Promise<RelationApplyReport<Version>> {
  const patchList = Array.from(patches);
  if (runtime.target === undefined) {
    return {
      status: 'rejected',
      patches: patchList.length,
      applied: 0,
      deltas: [],
      diagnostics: [{
        code: 'runtime_unsupported',
        severity: 'error',
        message: 'relation runtime does not expose a writable target',
        surface: 'tryApplyRelationPatches'
      }],
      source: runtime.source
    };
  }

  const result = await Promise.resolve(runtime.target.apply(patchList));
  const snapshot = runtime.snapshot?.();
  const source = snapshot?.source ?? runtime.source;
  const version = options.readVersion === false
    ? result.version
    : snapshot?.version ?? result.version ?? source.version?.();

  return {
    ...result,
    ...(version === undefined ? {} : { version }),
    source
  };
}

export const composeRelationRuntimes = <const Runtimes extends readonly RelationRuntime[]>(
  ...runtimes: Runtimes
): RelationRuntime<ComposedRelationRuntimeVersion<Runtimes>> => {
  const source = composeRuntimeSources(runtimes);
  const target = composeRuntimeTarget(runtimes, source);
  const subscribe = composeRuntimeSubscribe(runtimes);

  return {
    source,
    ...(target === undefined ? {} : { target }),
    snapshot: () => composeRuntimeSnapshot(runtimes),
    ...(subscribe === undefined ? {} : { subscribe })
  };
};
export const isRelationRuntime = (input: unknown): input is RelationRuntime => isRecord(input) && isRelationSource(input.source);

function composeRuntimeSources<const Runtimes extends readonly RelationRuntime[]>(
  runtimes: Runtimes,
  sources: readonly AdapterSource[] = runtimes.map((runtime) => runtime.source)
): AdapterSource<ComposedRelationRuntimeVersion<Runtimes>> {
  const rowSource = composeSources(...sources);
  const hasDiagnostics = sources.some((source) => source.diagnostics !== undefined);

  return {
    ...rowSource,
    version: () => composeSourceVersions<Runtimes>(sources),
    ...(hasDiagnostics ? { diagnostics: () => sources.flatMap((source) => source.diagnostics?.() ?? []) } : {})
  };
}

function composeSourceVersions<const Runtimes extends readonly RelationRuntime[]>(
  sources: readonly AdapterSource[]
): ComposedRelationRuntimeVersion<Runtimes> | undefined {
  const versions: unknown[] = [];

  for (const source of sources) {
    const version = source.version?.();
    if (version === undefined) return undefined;
    versions.push(version);
  }

  return versions as ComposedRelationRuntimeVersion<Runtimes>;
}

function composeRuntimeSnapshot<const Runtimes extends readonly RelationRuntime[]>(
  runtimes: Runtimes
): AdapterSnapshot<ComposedRelationRuntimeVersion<Runtimes>> {
  const sources: AdapterSource[] = [];
  const snapshotDiagnostics: TarstateDiagnostic[] = [];
  const versions: unknown[] = [];
  let hasCompleteVersion = true;

  for (const runtime of runtimes) {
    const snapshot = runtime.snapshot?.();
    const source = snapshot?.source ?? runtime.source;
    const version = snapshot?.version ?? source.version?.();

    sources.push(source);
    if (snapshot?.diagnostics !== undefined) snapshotDiagnostics.push(...snapshot.diagnostics);

    if (version === undefined) {
      hasCompleteVersion = false;
    } else {
      versions.push(version);
    }
  }

  const source = composeRuntimeSources(runtimes, sources);
  const diagnostics = [
    ...snapshotDiagnostics,
    ...(source.diagnostics?.() ?? [])
  ];
  const version = hasCompleteVersion
    ? versions as ComposedRelationRuntimeVersion<Runtimes>
    : undefined;

  return {
    source,
    ...(version === undefined ? {} : { version }),
    ...(diagnostics.length === 0 ? {} : { diagnostics })
  };
}

function composeRuntimeTarget<const Runtimes extends readonly RelationRuntime[]>(
  runtimes: Runtimes,
  source: AdapterSource<ComposedRelationRuntimeVersion<Runtimes>>
): RelationPatchTarget<ComposedRelationRuntimeVersion<Runtimes>> | undefined {
  const targets = runtimes.flatMap((runtime) => runtime.target === undefined ? [] : [runtime.target]);
  if (targets.length === 0) return undefined;

  const targetRelationNames = Array.from(new Set(targets.flatMap((target) => target.relationNames ?? [])));

  return {
    ...(targetRelationNames.length === 0 ? {} : { relationNames: targetRelationNames }),
    ownsRelation: (relationName) => targets.some((target) => targetOwnsRelation(target, relationName)),
    apply: async (patches) => {
      const patchList = Array.from(patches);
      const routedTargets = targets.map((target) => ({ target, patches: [] as WritePatch[] }));
      const unroutedPatches: WritePatch[] = [];

      for (const patch of patchList) {
        const owningTargets = routedTargets.filter(({ target }) => targetOwnsRelation(target, patch.relation.name));

        if (owningTargets.length === 0) {
          unroutedPatches.push(patch);
          continue;
        }

        for (const routedTarget of owningTargets) {
          routedTarget.patches.push(patch);
        }
      }

      const results = await Promise.all(routedTargets
        .filter(({ patches: targetPatches }) => targetPatches.length > 0)
        .map(({ target, patches: targetPatches }) => Promise.resolve(target.apply(targetPatches))));
      const diagnostics = [
        ...results.flatMap((result) => result.diagnostics),
        ...unroutedPatches.map((patch) => unsupportedRuntimeTargetDiagnostic(patch.relation.name))
      ];
      const version = source.version?.();
      const durability = composeApplyDurability(results);
      const status = composeApplyStatus(patchList.length, unroutedPatches.length, results);
      const applied = results.reduce<number>((sum, result) => sum + result.applied, 0);
      const deltas = results.flatMap((result) => result.deltas);
      const resultBase = {
        patches: patchList.length,
        diagnostics,
        ...(version === undefined ? {} : { version }),
        ...(durability === undefined ? {} : { durability })
      };

      return status === 'rejected'
        ? { status, ...resultBase, applied: 0, deltas: [] }
        : { status, ...resultBase, applied, deltas };
    }
  };
}

function targetOwnsRelation(target: RelationPatchTarget, relationName: string): boolean {
  if (target.ownsRelation !== undefined) return target.ownsRelation(relationName);
  if (target.relationNames !== undefined) return target.relationNames.includes(relationName);
  return true;
}

function composeApplyStatus(
  patchCount: number,
  unroutedPatchCount: number,
  results: readonly RelationApplyResult[]
): RelationApplyStatus {
  if (patchCount === 0) return 'accepted';
  if (results.length === 0) return 'rejected';
  if (unroutedPatchCount > 0) {
    return results.some((result) => result.status !== 'rejected' || result.applied > 0) ? 'partial' : 'rejected';
  }

  if (results.every((result) => result.status === 'accepted')) return 'accepted';
  return results.some((result) => result.status !== 'rejected' || result.applied > 0) ? 'partial' : 'rejected';
}

function composeApplyDurability(results: readonly RelationApplyResult[]): RelationApplyDurability | undefined {
  const durabilities = results
    .map((result) => result.durability)
    .filter((durability): durability is RelationApplyDurability => durability !== undefined);
  const first = durabilities[0];

  return first !== undefined && durabilities.every((durability) => durability === first) ? first : undefined;
}

function composeRuntimeSubscribe(
  runtimes: readonly RelationRuntime[]
): ((listener: () => void) => () => void) | undefined {
  const subscribedRuntimes = runtimes.filter(hasRuntimeSubscribe);
  if (subscribedRuntimes.length === 0) return undefined;

  return (listener) => {
    const unsubscribers = subscribedRuntimes.map((runtime) => runtime.subscribe(listener));
    let subscribed = true;

    return () => {
      if (!subscribed) return;
      subscribed = false;
      for (const unsubscribe of unsubscribers) unsubscribe();
    };
  };
}

function hasRuntimeSubscribe(
  runtime: RelationRuntime
): runtime is RelationRuntime & { readonly subscribe: (listener: () => void) => () => void } {
  return runtime.subscribe !== undefined;
}

function unsupportedRuntimeTargetDiagnostic(relationName: string): TarstateDiagnostic {
  return {
    code: 'runtime_unsupported',
    severity: 'warning',
    message: `no composed relation runtime target owns relation "${relationName}"`,
    relation: relationName,
    surface: 'composeRelationRuntimes'
  };
}

export type DbInputData = { readonly [relationName: string]: readonly unknown[] };
export type DbData = { readonly [relationName: string]: readonly unknown[] };
export type DbEnv = EvaluateEnv;
export type DbInputEnv = Readonly<Record<string, unknown>>;
export type DbOptions = TarstateDiagnosticOptions & { readonly env?: DbInputEnv };
const EMPTY_DB_ENV: DbInputEnv = Object.freeze(Object.create(null));
export type Db = {
  readonly data: DbData;
  readonly env: DbEnv;
};
export type DbEnvUpdate = DbInputEnv | ((env: DbEnv, db: Db) => DbInputEnv);
export type SetEnvTransaction = { readonly op: 'setEnv'; readonly env: DbEnvUpdate };
export type DbTransactionItem = WriteInput | SetEnvTransaction | Iterable<WritePatch | SetEnvTransaction>;
export type DbTransactionInput =
  | DbTransactionItem
  | ((db: DbTransactionContext) => DbTransactionItem)
  | ((tx: DbTransactionContext, db: Db) => DbTransactionItem);
export type DbTransactionInputs = readonly DbTransactionInput[];
export type DbTransactionResult<DbValue extends Db = Db> = {
  readonly db: DbValue;
  readonly patches: number;
  readonly applied: number;
  readonly deltas: readonly RelationDelta[];
  readonly diagnostics: readonly TarstateDiagnostic[];
  readonly committed: boolean;
  readonly materializations?: MaterializationMaintenanceResult;
};
const TRANSACTION_WRITE_PATCHES = Symbol('tarstate.transactionWritePatches');
type DbTransactionResultWithWritePatches<DbValue extends Db = Db> = DbTransactionResult<DbValue> & {
  readonly [TRANSACTION_WRITE_PATCHES]: readonly WritePatch[];
};
export type DbTransactionPlan = {
  readonly inputs: DbTransactionInputs;
  readonly patches: readonly WritePatch[];
  readonly diagnostics: readonly TarstateDiagnostic[];
};
/**
 * Extension point for patch/read helpers exposed to transaction callbacks.
 * Today the callback context is the staged `Db`; helpers can be added here
 * without changing callback call sites.
 */
export type DbTransactionBuilder = object;
export type DbTransactionContext = Db & DbTransactionBuilder;
export type QueryBatchTarget = Query<unknown> | RelationRef | { readonly q: Query<unknown> | RelationRef };
export type QueryBatch = Record<string, QueryBatchTarget>;
export type QueryBatchTargetRow<Target> = Target extends { readonly q: infer QueryValue }
  ? QueryBatchTargetRow<QueryValue>
  : Target extends Query<infer Row>
    ? Row
    : Target extends RelationRef<infer Row>
      ? Row
      : unknown;
export type QueryBatchResult<Queries extends QueryBatch> = { readonly [Key in keyof Queries]: QueryResult<QueryBatchTargetRow<Queries[Key]>> };
export type MappedQueryBatchResult<Queries extends QueryBatch, MappedRow> = { readonly [Key in keyof Queries]: QueryResult<MappedRow> };
export type QueryBatchRows<Queries extends QueryBatch> = { readonly [Key in keyof Queries]: readonly QueryBatchTargetRow<Queries[Key]>[] };
export type MappedQueryBatchRows<Queries extends QueryBatch, MappedRow> = { readonly [Key in keyof Queries]: readonly MappedRow[] };
export type DbQueryIntoResult<Row, Rows> = Omit<QueryResult<Row>, 'rows'> & { readonly rows: Rows };
export type DbQuerySort<Row = unknown> = DbQuerySortKey<Row> | readonly DbQuerySortKey<Row>[];
export type DbQuerySortKey<Row = unknown> = string | ((row: Row) => unknown);
export type DbQueryOptions<Row = unknown, MappedRow = Row> = EvaluateOptions & {
  readonly sort?: DbQuerySort<Row>;
  readonly rsort?: DbQuerySort<Row>;
  readonly mapRows?: (rows: readonly Row[]) => readonly MappedRow[];
  readonly into?: (rows: readonly MappedRow[]) => unknown;
};
export type RelationKeyValue<Relation extends RelationRef> =
  Relation extends RelationRef<infer Row, infer Key>
    ? Key extends readonly (keyof Row & string)[]
      ? { readonly [Index in keyof Key]: Key[Index] extends keyof Row ? Row[Key[Index]] : never }
      : Key extends keyof Row
        ? Row[Key]
        : RelationKeyInput
    : RelationKeyInput;
export type RowLookupOptions<Row = unknown, MappedRow = Row> = DbQueryOptions<Row, MappedRow>;
export type RowPredicateOptions<Row = unknown, MappedRow = Row> = DbQueryOptions<Row, MappedRow>;

export class DbTransactionError<DbValue extends Db = Db> extends Error {
  readonly result: DbTransactionResult<DbValue>;
  constructor(result: DbTransactionResult<DbValue>) {
    super('transaction failed');
    this.name = 'DbTransactionError';
    this.result = result;
  }
}

export function createDb(data: DbInputData = {}, options: DbOptions = {}): Db {
  return { data: cloneDbData(data), env: dbEnvFromOptions(options) };
}
export const dbSource = (input: Db): RelationSource => fromObjectSource(input.data);
export const stripMeta = <Input>(input: Input): Input extends Db ? DbData : Input => (isDb(input) ? input.data : input) as never;
export const withEnv = (input: Db, envValue: DbInputEnv): Db => ({ ...input, env: envValue });
export const getEnv = (input: Db): DbEnv => input.env;
export const updateEnv = (input: Db, update: (env: DbEnv) => DbInputEnv): Db => withEnv(input, update(input.env));
export const setEnvTx = (envValue: DbEnvUpdate): SetEnvTransaction => ({ op: 'setEnv', env: envValue });
export function q<Relation extends RelationRef, MappedRow = RelationRow<Relation>>(_db: Db, _query: Relation, _options?: DbQueryOptions<RelationRow<Relation>, MappedRow>): readonly MappedRow[];
export function q<Row, MappedRow = Row>(_db: Db, _query: Query<Row>, _options?: DbQueryOptions<Row, MappedRow>): readonly MappedRow[];
export function q<Row, MappedRow = Row>(_db: Db, _query: Query<Row> | RelationRef, _options?: DbQueryOptions<Row, MappedRow>): readonly MappedRow[];
export function q(dbValue: Db, queryValue: Query<any> | RelationRef<any, any>, options: DbQueryOptions<any, any> = {}): readonly any[] {
  return qResult(dbValue, queryValue, options).rows;
}
export function qResult<Relation extends RelationRef, MappedRow = RelationRow<Relation>>(_db: Db, _query: Relation, _options?: DbQueryOptions<RelationRow<Relation>, MappedRow>): QueryResult<MappedRow>;
export function qResult<Row, MappedRow = Row>(_db: Db, _query: Query<Row>, _options?: DbQueryOptions<Row, MappedRow>): QueryResult<MappedRow>;
export function qResult<Row, MappedRow = Row>(_db: Db, _query: Query<Row> | RelationRef, _options?: DbQueryOptions<Row, MappedRow>): QueryResult<MappedRow>;
export function qResult(dbValue: Db, queryValue: Query<any> | RelationRef<any, any>, options: DbQueryOptions<any, any> = {}): QueryResult<any> {
  const queryObject = queryForTarget(queryValue);
  const materializedRows = isQuery(queryValue) ? materializedRowsForQuery(dbValue, queryObject) : undefined;
  if (materializedRows !== undefined && !hasEvaluateContextOverrides(options)) {
    return {
      rows: hasDbQueryRowTransforms(options) ? applyDbQueryOptions(materializedRows, options) : materializedRows,
      diagnostics: []
    };
  }
  const result = evaluate(dbSource(dbValue), queryObject, { ...options, env: options.env ?? dbValue.env });
  const sortedRows = applyDbQueryOptions(result.rows, options);
  return { rows: sortedRows, diagnostics: result.diagnostics };
}
export function qMany<Queries extends QueryBatch>(dbValue: Db, queries: Queries, options: DbQueryOptions = {}): QueryBatchRows<Queries> {
  const results: Record<string, readonly unknown[]> = {};
  for (const [name, target] of Object.entries(queries)) {
    results[name] = q(dbValue, queryBatchTargetQuery(target), options);
  }
  return results as QueryBatchRows<Queries>;
}
export function qManyResult<Queries extends QueryBatch>(dbValue: Db, queries: Queries, options: DbQueryOptions = {}): QueryBatchResult<Queries> {
  const results: Record<string, QueryResult<unknown>> = {};
  for (const [name, target] of Object.entries(queries)) {
    results[name] = qResult(dbValue, queryBatchTargetQuery(target), options);
  }
  return results as QueryBatchResult<Queries>;
}
export function row<Relation extends RelationRef>(_db: Db, _relation: Relation, _key: RelationKeyValue<Relation>, _options?: RowLookupOptions<RelationRow<Relation>>): RelationRow<Relation> | undefined;
export function row<Row>(_db: Db, _query: Query<Row>, _predicate: PredicateData, _options?: RowPredicateOptions<Row>): Row | undefined;
export function row<Relation extends RelationRef>(_db: Db, _relation: Relation, _predicate: PredicateData, _options?: RowPredicateOptions<RelationRow<Relation>>): RelationRow<Relation> | undefined;
export function row<Row>(_db: Db, _query: Query<Row>, _options?: RowLookupOptions<Row>): Row | undefined;
export function row<Relation extends RelationRef>(_db: Db, _relation: Relation, _options?: RowLookupOptions<RelationRow<Relation>>): RelationRow<Relation> | undefined;
export function row<Row>(dbValue: Db, queryValue: Query<Row> | RelationRef, keyOrPredicateOrOptions?: RelationKeyInput | PredicateData | RowLookupOptions<Row>, options?: RowLookupOptions<Row>): Row | undefined {
  if (isRelationRef(queryValue) && isRelationKeyInput(keyOrPredicateOrOptions)) {
    const key = relationKeyInputToKey(queryValue, keyOrPredicateOrOptions);
    return q(dbValue, queryValue, options as DbQueryOptions<Row>)
      .find((rowValue) => isRecord(rowValue) && rowKey(queryValue, rowValue) === key) as Row | undefined;
  }

  if (isPredicateData(keyOrPredicateOrOptions)) {
    const queryObject = pipe(queryForTarget(queryValue), where(keyOrPredicateOrOptions));
    return q(dbValue, queryObject, options as DbQueryOptions<Row>)[0] as Row | undefined;
  }

  const readOptions = (keyOrPredicateOrOptions === undefined || isRelationKeyInput(keyOrPredicateOrOptions))
    ? options
    : keyOrPredicateOrOptions;
  return q(dbValue, queryForTarget(queryValue), readOptions as DbQueryOptions<Row>)[0] as Row | undefined;
}
export function exists<Relation extends RelationRef>(_db: Db, _relation: Relation, _key: RelationKeyValue<Relation>, _options?: RowLookupOptions<RelationRow<Relation>>): boolean;
export function exists<Row>(_db: Db, _query: Query<Row>, _predicate: PredicateData, _options?: RowPredicateOptions<Row>): boolean;
export function exists<Relation extends RelationRef>(_db: Db, _relation: Relation, _predicate: PredicateData, _options?: RowPredicateOptions<RelationRow<Relation>>): boolean;
export function exists<Row>(_db: Db, _query: Query<Row>, _options?: RowLookupOptions<Row>): boolean;
export function exists<Relation extends RelationRef>(_db: Db, _relation: Relation, _options?: RowLookupOptions<RelationRow<Relation>>): boolean;
export function exists<Row>(dbValue: Db, queryValue: Query<Row> | RelationRef, keyOrPredicateOrOptions?: RelationKeyInput | PredicateData | RowLookupOptions<Row>, options?: RowLookupOptions<Row>): boolean {
  return row(dbValue, queryValue as Query<Row>, keyOrPredicateOrOptions as never, options) !== undefined;
}
export type DbTransactionOptions = { readonly label?: string };
export function whatIf<Queries extends QueryBatch>(_db: Db, _query: Queries, ..._inputs: DbTransactionInputs): QueryBatchResult<Queries>;
export function whatIf<Row>(_db: Db, _query: Query<Row> | RelationRef, ..._inputs: DbTransactionInputs): QueryResult<Row>;
export function whatIf(dbValue: Db, queryValue: Query<unknown> | RelationRef | QueryBatch, ...inputs: DbTransactionInputs): QueryResult<unknown> | QueryBatchResult<QueryBatch> {
  const result = tryTransact(dbValue, ...inputs);
  const readDb = result.committed ? result.db : dbValue;
  return isQueryBatch(queryValue)
    ? qManyResult(readDb, queryValue)
    : qResult(readDb, queryValue);
}
export function transact<DbValue extends Db>(inputDb: DbValue, inputs: DbTransactionInputs, options?: DbTransactionOptions): DbValue;
export function transact<DbValue extends Db>(inputDb: DbValue, input: DbTransactionInput, options?: DbTransactionOptions): DbValue;
export function transact<DbValue extends Db>(inputDb: DbValue, inputOrInputs: DbTransactionInput | DbTransactionInputs, _options: DbTransactionOptions = {}): DbValue {
  const result = tryTransact(inputDb, ...normalizeTransactionInputs(inputOrInputs));
  if (!result.committed) throw new DbTransactionError(result);
  return result.db;
}
export function tryTransact<DbValue extends Db>(inputDb: DbValue, ...inputs: DbTransactionInputs): DbTransactionResult<DbValue> {
  const diagnostics: TarstateDiagnostic[] = [];
  const patches: WritePatch[] = [];
  let workingDb: Db = cloneDb(inputDb);
  let applied = 0;
  const deltas: RelationDelta[] = [];
  const envDeltas: MaterializationEnvDelta[] = [];
  const materializationConstraints = materializedConstraintsFor(inputDb);

  for (const input of inputs) {
    const items = normalizeTransactionItem(resolveTransactionInput(input, workingDb));
    for (const item of items) {
      if (isSetEnvTransaction(item)) {
        const beforeEnv = envSnapshot(workingDb.env);
        workingDb = applySetEnvTransaction(workingDb, item);
        envDeltas.push(...envDeltasFor(beforeEnv, workingDb.env));
        continue;
      }

      patches.push(item);
      const patchResult = applyWritePatchToDb(workingDb, item, materializationConstraints);
      diagnostics.push(...patchResult.diagnostics);

      if (patchResult.diagnostics.some(isErrorDiagnostic)) {
        diagnostics.push(...constraintDiagnosticsForInvalidPatch(item, materializationConstraints));
        return withTransactionWritePatches({
          db: inputDb,
          patches: patches.length,
          applied,
          deltas,
          diagnostics,
          committed: false
        }, patches);
      }

      workingDb = patchResult.db;
      applied += patchResult.applied;
      deltas.push(...patchResult.deltas);
      workingDb = applyCascadeDeletes(workingDb, materializationConstraints, patchResult.deltas, deltas);
    }
  }

  if (materializationConstraints.length > 0) {
    const validation = validateConstraintsSync(workingDb, materializationConstraints, { env: workingDb.env });
    diagnostics.push(...validation.diagnostics);
    if (!validation.valid) {
      return withTransactionWritePatches({
        db: inputDb,
        patches: patches.length,
        applied: 0,
        deltas: [],
        diagnostics,
        committed: false
      }, patches);
    }
  }

  const maintained = maintainMaterializations(inputDb, workingDb, { deltas, envDeltas });
  const materializations = maintained.materializations;
  diagnostics.push(...materializations.diagnostics);
  const committedDb = maintained.db as DbValue;

  return withTransactionWritePatches({
    db: committedDb,
    patches: patches.length,
    applied,
    deltas,
    diagnostics,
    committed: true,
    ...(materializations.maintained === 0 ? {} : { materializations })
  }, patches);
}
function normalizeTransactionInputs(inputOrInputs: DbTransactionInput | DbTransactionInputs): DbTransactionInputs {
  return (Array.isArray(inputOrInputs) ? inputOrInputs : [inputOrInputs]) as DbTransactionInputs;
}

function hasEvaluateContextOverrides(options: EvaluateOptions): boolean {
  return options.env !== undefined || options.functions !== undefined;
}

function withTransactionWritePatches<DbValue extends Db>(
  result: DbTransactionResult<DbValue>,
  patches: readonly WritePatch[]
): DbTransactionResult<DbValue> {
  Object.defineProperty(result, TRANSACTION_WRITE_PATCHES, {
    value: patches,
    enumerable: false,
    configurable: false
  });
  return result;
}

function transactionWritePatches(result: DbTransactionResult): readonly WritePatch[] {
  return (result as Partial<DbTransactionResultWithWritePatches>)[TRANSACTION_WRITE_PATCHES] ?? [];
}

export type RelationRow<Relation extends RelationRef> = Relation extends RelationRef<infer Row> ? Row : never;
type RelationFieldUpdateValue<Value> = Value | RowExprData<Value>;
export type RelationRowUpdate<Relation extends RelationRef> = Partial<{
  readonly [Field in keyof RelationRow<Relation>]: RelationFieldUpdateValue<RelationRow<Relation>[Field]>;
}>;
export type RelationRowUpdateInput<Relation extends RelationRef> =
  | RelationRowUpdate<Relation>
  | ((row: RelationRow<Relation>) => RelationRowUpdate<Relation>);
export type RelationKeyInput = string | number | readonly unknown[];
export type RelationMergeInput<Relation extends RelationRef = RelationRef> =
  | readonly (keyof RelationRow<Relation> & string)[]
  | ((current: RelationRow<Relation>, incoming: RelationRow<Relation>) => RelationRowUpdate<Relation>);
export type InsertPatch<Relation extends RelationRef = RelationRef> = { readonly op: 'insert'; readonly relation: Relation; readonly row: RelationRow<Relation> };
export type InsertIgnorePatch<Relation extends RelationRef = RelationRef> = { readonly op: 'insertIgnore'; readonly relation: Relation; readonly row: RelationRow<Relation> };
export type InsertOrReplacePatch<Relation extends RelationRef = RelationRef> = { readonly op: 'insertOrReplace'; readonly relation: Relation; readonly row: RelationRow<Relation> };
export type UpdateByKeyPatch<Relation extends RelationRef = RelationRef> = { readonly op: 'updateByKey'; readonly relation: Relation; readonly key: RelationKeyValue<Relation>; readonly changes: RelationRowUpdateInput<Relation> };
export type UpdatePatch<Relation extends RelationRef = RelationRef> = { readonly op: 'update'; readonly relation: Relation; readonly predicate: PredicateData; readonly changes: RelationRowUpdateInput<Relation> };
export type InsertOrMergeOptions<Relation extends RelationRef = RelationRef> = { readonly merge?: RelationMergeInput<Relation> };
export type InsertOrMergePatch<Relation extends RelationRef = RelationRef> = { readonly op: 'insertOrMerge'; readonly relation: Relation; readonly row: RelationRow<Relation>; readonly merge?: RelationMergeInput<Relation> };
export type InsertOrUpdateOptions<Relation extends RelationRef = RelationRef> = { readonly update?: RelationRowUpdateInput<Relation> };
export type InsertOrUpdatePatch<Relation extends RelationRef = RelationRef> = { readonly op: 'insertOrUpdate'; readonly relation: Relation; readonly row: RelationRow<Relation>; readonly update?: RelationRowUpdateInput<Relation> };
export type DeleteByKeyPatch<Relation extends RelationRef = RelationRef> = { readonly op: 'deleteByKey'; readonly relation: Relation; readonly key: RelationKeyValue<Relation> };
export type DeletePatch<Relation extends RelationRef = RelationRef> = { readonly op: 'delete'; readonly relation: Relation; readonly predicate: PredicateData };
export type DeleteExactPatch<Relation extends RelationRef = RelationRef> = { readonly op: 'deleteExact'; readonly relation: Relation; readonly row: RelationRow<Relation> };
export type ReplaceAllPatch<Relation extends RelationRef = RelationRef> = { readonly op: 'replaceAll'; readonly relation: Relation; readonly rows: readonly RelationRow<Relation>[] };
export type RelationSchema = Readonly<Record<string, RelationRef>>;
export type SchemaSeedInput<Schema extends RelationSchema> = {
  readonly [Name in keyof Schema]?: readonly RelationRow<Schema[Name]>[];
};
export type SchemaSeedPatch<Schema extends RelationSchema> = {
  readonly [Name in keyof Schema]: InsertPatch<Schema[Name]>;
}[keyof Schema];
export type SchemaSeedPatches<Schema extends RelationSchema> = readonly SchemaSeedPatch<Schema>[];
export type WritePatch<Relation extends RelationRef = RelationRef> =
  | InsertPatch<Relation>
  | InsertIgnorePatch<Relation>
  | InsertOrReplacePatch<Relation>
  | UpdateByKeyPatch<Relation>
  | UpdatePatch<Relation>
  | InsertOrMergePatch<Relation>
  | InsertOrUpdatePatch<Relation>
  | DeleteByKeyPatch<Relation>
  | DeletePatch<Relation>
  | DeleteExactPatch<Relation>
  | ReplaceAllPatch<Relation>;
export type WriteInput<Relation extends RelationRef = RelationRef> = WritePatch<Relation> | readonly WritePatch<Relation>[];
export type RelationWriter<Relation extends RelationRef> = {
  readonly insert: (row: RelationRow<Relation>) => InsertPatch<Relation>;
  readonly insertIgnore: (row: RelationRow<Relation>) => InsertIgnorePatch<Relation>;
  readonly insertOrReplace: (row: RelationRow<Relation>) => InsertOrReplacePatch<Relation>;
  readonly updateByKey: (key: RelationKeyValue<Relation>, changes: RelationRowUpdateInput<Relation>) => UpdateByKeyPatch<Relation>;
  readonly update: (predicate: PredicateData, changes: RelationRowUpdateInput<Relation>) => UpdatePatch<Relation>;
  readonly insertOrMerge: (row: RelationRow<Relation>, options?: InsertOrMergeOptions<Relation>) => InsertOrMergePatch<Relation>;
  readonly insertOrUpdate: (row: RelationRow<Relation>, options?: InsertOrUpdateOptions<Relation>) => InsertOrUpdatePatch<Relation>;
  readonly deleteByKey: (key: RelationKeyValue<Relation>) => DeleteByKeyPatch<Relation>;
  readonly delete: (predicate: PredicateData) => DeletePatch<Relation>;
  readonly deleteExact: (row: RelationRow<Relation>) => DeleteExactPatch<Relation>;
  readonly replaceAll: (rows: readonly RelationRow<Relation>[]) => ReplaceAllPatch<Relation>;
};
export const insert = <Relation extends RelationRef>(relationRef: Relation, rowValue: RelationRow<Relation>): InsertPatch<Relation> => ({ op: 'insert', relation: relationRef, row: rowValue });
export const insertIgnore = <Relation extends RelationRef>(relationRef: Relation, rowValue: RelationRow<Relation>): InsertIgnorePatch<Relation> => ({ op: 'insertIgnore', relation: relationRef, row: rowValue });
export const insertOrReplace = <Relation extends RelationRef>(relationRef: Relation, rowValue: RelationRow<Relation>): InsertOrReplacePatch<Relation> => ({ op: 'insertOrReplace', relation: relationRef, row: rowValue });
export const updateByKey = <Relation extends RelationRef>(relationRef: Relation, key: RelationKeyValue<Relation>, changes: RelationRowUpdateInput<Relation>): UpdateByKeyPatch<Relation> => ({ op: 'updateByKey', relation: relationRef, key, changes });
export const update = <Relation extends RelationRef>(relationRef: Relation, predicate: PredicateData, changes: RelationRowUpdateInput<Relation>): UpdatePatch<Relation> => ({ op: 'update', relation: relationRef, predicate, changes });
export const insertOrMerge = <Relation extends RelationRef>(relationRef: Relation, rowValue: RelationRow<Relation>, options: InsertOrMergeOptions<Relation> = {}): InsertOrMergePatch<Relation> => ({
  op: 'insertOrMerge',
  relation: relationRef,
  row: rowValue,
  ...(options.merge === undefined ? {} : { merge: options.merge })
});
export const insertOrUpdate = <Relation extends RelationRef>(relationRef: Relation, rowValue: RelationRow<Relation>, options: InsertOrUpdateOptions<Relation> = {}): InsertOrUpdatePatch<Relation> => ({
  op: 'insertOrUpdate',
  relation: relationRef,
  row: rowValue,
  ...(options.update === undefined ? {} : { update: options.update })
});
export const deleteByKey = <Relation extends RelationRef>(relationRef: Relation, key: RelationKeyValue<Relation>): DeleteByKeyPatch<Relation> => ({ op: 'deleteByKey', relation: relationRef, key });
export const deleteRows = <Relation extends RelationRef>(relationRef: Relation, predicate: PredicateData): DeletePatch<Relation> => ({ op: 'delete', relation: relationRef, predicate });
export const deleteExact = <Relation extends RelationRef>(relationRef: Relation, rowValue: RelationRow<Relation>): DeleteExactPatch<Relation> => ({ op: 'deleteExact', relation: relationRef, row: rowValue });
export const replaceAll = <Relation extends RelationRef>(relationRef: Relation, rows: readonly RelationRow<Relation>[]): ReplaceAllPatch<Relation> => ({ op: 'replaceAll', relation: relationRef, rows });
export function seed<Schema extends RelationSchema>(schemaValue: Schema, rows: SchemaSeedInput<Schema>): SchemaSeedPatches<Schema> {
  const patches: WritePatch[] = [];
  for (const [name, relationRef] of Object.entries(schemaValue)) {
    const relationRows = rows[name as keyof Schema] as readonly RelationRow<RelationRef>[] | undefined;
    if (relationRows === undefined) continue;
    for (const rowValue of relationRows) {
      patches.push(insert(relationRef, rowValue));
    }
  }
  return patches as unknown as SchemaSeedPatches<Schema>;
}
export const write = <Relation extends RelationRef>(relationRef: Relation): RelationWriter<Relation> => ({
  insert: (rowValue) => insert(relationRef, rowValue),
  insertIgnore: (rowValue) => insertIgnore(relationRef, rowValue),
  insertOrReplace: (rowValue) => insertOrReplace(relationRef, rowValue),
  updateByKey: (key, changes) => updateByKey(relationRef, key, changes),
  update: (predicate, changes) => update(relationRef, predicate, changes),
  insertOrMerge: (rowValue, options) => insertOrMerge(relationRef, rowValue, options),
  insertOrUpdate: (rowValue, options) => insertOrUpdate(relationRef, rowValue, options),
  deleteByKey: (key) => deleteByKey(relationRef, key),
  delete: (predicate) => deleteRows(relationRef, predicate),
  deleteExact: (rowValue) => deleteExact(relationRef, rowValue),
  replaceAll: (rows) => replaceAll(relationRef, rows)
});
export const isWritePatch = (input: unknown): input is WritePatch => isRecord(input) && typeof input.op === 'string' && isRelationRef(input.relation);
export const writeInputPatches = (input: WriteInput): readonly WritePatch[] => Array.isArray(input) ? input : [input as WritePatch];

export type ConstraintRelationField = string;
export type ConstraintRelationFields = ConstraintRelationField | readonly ConstraintRelationField[];
export type ConstraintRelationRow<Relation extends RelationRef = RelationRef> = RelationRow<Relation>;
export type ForeignKeyCascade = 'restrict' | 'delete';
export type CheckConstraintData = { readonly op: 'check'; readonly query?: Query; readonly predicate: PredicateData };
export type RequiredConstraintData = { readonly op: 'req'; readonly query: Query | RelationRef; readonly fields: readonly string[] };
export type ForeignKeyConstraintData = { readonly op: 'fk'; readonly query: Query | RelationRef; readonly fields: readonly string[]; readonly target: RelationRef; readonly targetFields: readonly string[]; readonly cascade?: ForeignKeyCascade };
export type UniqueConstraintData = { readonly op: 'unique'; readonly query: Query | RelationRef; readonly fields: readonly string[] };
export type QueryRequiredConstraintData = RequiredConstraintData;
export type QueryForeignKeyConstraintData = ForeignKeyConstraintData;
export type QueryUniqueConstraintData = UniqueConstraintData;
export type ConstraintData = CheckConstraintData | RequiredConstraintData | ForeignKeyConstraintData | UniqueConstraintData;
export type ConstraintSet = readonly ConstraintData[];
export type ConstraintOptions = { readonly name?: string };
export type ConstraintValidationInput = ConstraintSet | ConstraintData;
export type ConstraintValidationOptions = EvaluateOptions;
export type ConstraintValidationResult = {
  readonly valid: boolean;
  readonly diagnostics: readonly TarstateDiagnostic[];
};

export function check(predicate: PredicateData): CheckConstraintData;
export function check(query: Query, predicate: PredicateData): CheckConstraintData;
export function check(queryOrPredicate: Query | PredicateData, predicate?: PredicateData): CheckConstraintData {
  return { op: 'check', ...(predicate === undefined ? { predicate: queryOrPredicate as PredicateData } : { query: queryOrPredicate as Query, predicate }) };
}
export const req = (query: Query | RelationRef, ...fields: readonly string[]): RequiredConstraintData => ({ op: 'req', query, fields });
export const fk = (
  query: Query | RelationRef,
  fields: ConstraintRelationFields,
  target: RelationRef,
  targetFields: ConstraintRelationFields,
  options: { readonly cascade?: ForeignKeyCascade } = {}
): ForeignKeyConstraintData => ({
  op: 'fk',
  query,
  fields: arrayify(fields),
  target,
  targetFields: arrayify(targetFields),
  ...(options.cascade === undefined ? {} : { cascade: options.cascade })
});
export const unique = (query: Query | RelationRef, ...fields: readonly string[]): UniqueConstraintData => ({ op: 'unique', query, fields });
export const constrain = (...constraints: readonly ConstraintData[]): ConstraintSet => constraints;
export async function validateConstraints(dbValue: Db | RelationSource, constraints: ConstraintValidationInput, options?: ConstraintValidationOptions): Promise<ConstraintValidationResult>;
export async function validateConstraints(constraints: ConstraintValidationInput, options?: ConstraintValidationOptions): Promise<ConstraintValidationResult>;
export async function validateConstraints(
  dbOrConstraints: Db | RelationSource | ConstraintValidationInput,
  constraintsOrOptions?: ConstraintValidationInput | ConstraintValidationOptions,
  maybeOptions: ConstraintValidationOptions = {}
): Promise<ConstraintValidationResult> {
  if (isDb(dbOrConstraints) || isRelationSource(dbOrConstraints)) {
    return validateConstraintsSync(dbOrConstraints, constraintsOrOptions as ConstraintValidationInput, maybeOptions);
  }

  return {
    valid: false,
    diagnostics: [{
      code: 'constraint_failed',
      severity: 'error',
      message: 'validateConstraints requires a Db or RelationSource as its first argument',
      surface: 'validateConstraints'
    }]
  };
}

/**
 * Any db-like value that can carry materialization metadata.
 * `Db` values are maintained by transactions; source-only targets can still
 * be materialized for snapshot reads.
 */
export type MaterializableDb = object;
export type SnapshotMaterializationTarget = Db | RelationSource;
export type MaterializedDb = { readonly materialized?: readonly MaterializationMetadata[] };
export type MaterializationMode = 'snapshot' | 'incremental';
export type MaterializationMaintenanceKind = MaterializationMode;
export type MaterializationMaintenanceDecision = 'skipped' | 'carried' | 'recomputed' | 'incremental';
export type MaterializationIndexSpec =
  | {
      readonly op: 'hash';
      readonly field: string;
      readonly expressions: readonly [ExprData];
    }
  | {
      readonly op: 'btree';
      readonly field: string;
      readonly expressions: readonly [ExprData];
    }
  | {
      readonly op: 'uniqueIndex';
      readonly field: string;
      readonly expressions: readonly [ExprData];
    };
export type MaterializationOptions = { readonly id?: string; readonly mode?: MaterializationMode };
export type SnapshotMaterializationOptions = MaterializationOptions;
export type MaterializationEnvDelta = {
  readonly name: string;
  readonly before: unknown;
  readonly after: unknown;
};
export type MaterializationMaintenanceOptions = { readonly deltas?: readonly RelationDelta[]; readonly envDeltas?: readonly MaterializationEnvDelta[] };
export type MaterializationMetadata<Row = unknown> = {
  readonly id: string;
  readonly query: Query<Row>;
  readonly queryKey: string;
  readonly mode: MaterializationMode;
};
export type MaterializationExplanation<Row = unknown> = {
  readonly query: Query<Row>;
  readonly supported: boolean;
  readonly update: 'incremental' | 'recomputed';
  readonly recomputed: boolean;
  readonly reason: string;
  readonly diagnostics: readonly TarstateDiagnostic[];
};
export type MaterializationRefreshResult<Row = unknown> = {
  readonly rows: readonly Row[];
  readonly diagnostics: readonly TarstateDiagnostic[];
};
export type MaterializationMaintenanceChange<Row = unknown> = {
  readonly update: MaterializationMaintenanceDecision;
  readonly recomputed: boolean;
  readonly reason: string;
  readonly id: string;
  readonly queryKey: string;
  readonly query: Query<Row>;
  readonly maintenance: MaterializationMaintenanceKind;
  readonly dependencies: readonly string[];
  readonly touchedDependencies: readonly string[];
  readonly envDependencies: readonly string[];
  readonly touchedEnvDependencies: readonly string[];
  readonly indexSpecs: readonly MaterializationIndexSpec[];
  readonly previousRowsAvailable: boolean;
  readonly previousRows: readonly Row[] | undefined;
  readonly rows: readonly Row[];
  readonly added: readonly Row[];
  readonly removed: readonly Row[];
  readonly rowChanges: readonly RowChange<Row>[];
  readonly diagnostics: readonly TarstateDiagnostic[];
};
export type MaterializationMaintenanceResult<Row = unknown> = {
  readonly maintained: number;
  readonly recomputed: number;
  readonly carried: number;
  readonly skipped: number;
  readonly changes: readonly MaterializationMaintenanceChange<Row>[];
  readonly diagnostics: readonly TarstateDiagnostic[];
};
export type MaterializationMaintainResult<DbValue extends Db = Db, Row = unknown> = {
  readonly db: DbValue & MaterializedDb;
  readonly materializations: MaterializationMaintenanceResult<Row>;
};
export type MaterializationRangeBound<Value = unknown> = RelationRangeBound<Value>;
export type MaterializationRange<Value = unknown> = { readonly lower?: MaterializationRangeBound<Value>; readonly upper?: MaterializationRangeBound<Value> };
export type MaterializedQueryResult<Row = unknown> = QueryResult<Row> & { readonly materialized: boolean };
export type MaterializationInput<Row = unknown> =
  | Query<Row>
  | ConstraintData
  | ConstraintSet
  | MaterializationMetadata<Row>;
export type MaterializationTarget<Row = unknown> =
  | string
  | Query<Row>
  | ConstraintData
  | ConstraintSet
  | MaterializationMetadata<Row>;

export function mat<DbValue extends object>(dbValue: DbValue, ...inputs: readonly MaterializationInput[]): DbValue & MaterializedDb {
  const current = materializedStateFor(dbValue);
  let state: InternalMaterializationState = {
    metadata: [...current.metadata],
    rows: new Map(current.rows),
    aux: new Map(current.aux),
    constraints: [...current.constraints]
  };

  for (const input of inputs) {
    state = addMaterializationInput(dbValue, state, input);
  }

  return withMaterializedState(dbValue, state) as DbValue & MaterializedDb;
}
export const demat = <DbValue extends MaterializableDb>(dbValue: DbValue, ...targets: readonly MaterializationTarget[]): DbValue => {
  const current = materializedStateFor(dbValue);
  if (current.metadata.length === 0 && current.constraints.length === 0) return dbValue;

  if (targets.length === 0) {
    return withMaterializedState(dbValue, emptyMaterializationState()) as DbValue;
  }

  const metadataIds = new Set<string>();
  const constraintKeys = new Set<string>();

  for (const target of targets) {
    if (typeof target === 'string') {
      metadataIds.add(target);
      continue;
    }
    if (isQuery(target)) {
      metadataIds.add(materializationIdForQuery(target));
      continue;
    }
    if (isMaterializationMetadata(target)) {
      metadataIds.add(target.id);
      continue;
    }
    for (const constraint of flattenConstraints(target as ConstraintValidationInput)) {
      constraintKeys.add(constraintKey(constraint));
    }
  }

  const rows = new Map(current.rows);
  const aux = new Map(current.aux);
  for (const id of metadataIds) {
    rows.delete(id);
    aux.delete(id);
  }

  return withMaterializedState(dbValue, {
    metadata: current.metadata.filter((item) => !metadataIds.has(item.id)),
    rows,
    aux,
    constraints: current.constraints.filter((item) => !constraintKeys.has(constraintKey(item)))
  }) as DbValue;
};
export const isMaterialized = (input: unknown): input is MaterializedDb => isRecord(input) && 'materialized' in input;
export const materializationsFor = (input: unknown): readonly MaterializationMetadata[] => materializedStateFor(input).metadata;
export const materializationForQuery = <Row = unknown>(input: unknown, query: Query<Row>): MaterializationMetadata<Row> | undefined =>
  materializationsFor(input).find((item) => item.queryKey === queryKey(query)) as MaterializationMetadata<Row> | undefined;
export const materializedRelationFor = (id: string): RelationRef<Record<string, unknown>> => ({
  kind: 'relation',
  name: id,
  key: 'id',
  fields: {},
  ephemeral: true
});
export const materializedRelationForQuery = <Row = unknown>(input: unknown, query: Query<Row>): RelationRef<Record<string, unknown>> | undefined => {
  const metadata = materializationForQuery(input, query);
  return metadata === undefined ? undefined : materializedRelationFor(metadata.id);
};
export const materializedRowsFor = <Row = unknown>(input: unknown, id: string): readonly Row[] | undefined =>
  materializedStateFor(input).rows.get(id) as readonly Row[] | undefined;
export const materializedRowsForQuery = <Row = unknown>(input: unknown, query: Query<Row>): readonly Row[] | undefined => {
  const metadata = materializationForQuery(input, query);
  return metadata === undefined ? undefined : materializedRowsFor<Row>(input, metadata.id);
};
export function readMaterializedQuery<Row>(input: unknown, query: Query<Row>): MaterializedQueryResult<Row> {
  const rows = materializedRowsForQuery<Row>(input, query);
  if (rows !== undefined) return { rows, diagnostics: [], materialized: true };
  if (isDb(input)) return { ...qResult(input, query), materialized: false };
  if (isRelationSource(input)) return { ...evaluate(input, query), materialized: false };
  return {
    rows: [],
    diagnostics: [{
      code: 'materialization_missing',
      severity: 'error',
      message: 'materialized query is not available',
      surface: 'readMaterializedQuery'
    }],
    materialized: false
  };
}
export const materializedSourceFor = (input: unknown): RelationSource | undefined => {
  const state = materializedStateFor(input);
  if (state.metadata.length === 0) return undefined;
  const data = Object.fromEntries(state.metadata.map((item) => [item.id, state.rows.get(item.id) ?? []]));
  const fallback = fromObjectSource(data);
  return {
    ...(fallback.relationNames === undefined ? {} : { relationNames: fallback.relationNames }),
    rows: fallback.rows,
    lookup: (lookupValue) => materializedIndexLookup(state, lookupValue) ?? fallback.lookup?.(lookupValue),
    rangeLookup: (lookupValue) => materializedIndexRangeLookup(state, lookupValue) ?? fallback.rangeLookup?.(lookupValue)
  };
};
export function maintainMaterializationSnapshots<Row = unknown>(
  before?: unknown,
  after?: unknown,
  options: MaterializationMaintenanceOptions = {}
): MaterializationMaintenanceResult<Row> {
  const beforeState = materializedStateFor(before);
  const target = after ?? before;
  if (beforeState.metadata.length === 0 || target === undefined) {
    return { maintained: 0, recomputed: 0, carried: 0, skipped: 0, changes: [], diagnostics: [] };
  }

  const changes: MaterializationMaintenanceChange<Row>[] = [];
  const nextAux = new Map(beforeState.aux);
  const touchedDependencies = relationDeltaNames(options.deltas ?? []);
  const touchedEnvDependencies = materializationEnvDeltaNames(options.envDeltas ?? []);
  const hasRelationChangeHints = options.deltas !== undefined;
  const hasEnvChangeHints = options.envDeltas !== undefined;

  for (const metadata of beforeState.metadata) {
    const previousRows = beforeState.rows.get(metadata.id) as readonly Row[] | undefined;
    const dependencies = relationDependencies(metadata.query);
    const touched = dependencies.filter((name) => touchedDependencies.includes(name));
    const envDependencies = queryEnvDependencies(metadata.query);
    const touchedEnv = envDependencies.filter((name) => touchedEnvDependencies.includes(name));
    const envHintsCoverDependencies = hasEnvChangeHints || envDependencies.length === 0;
    const indexSpecs = materializationIndexSpecs(metadata.query);
    if (previousRows !== undefined && hasRelationChangeHints && envHintsCoverDependencies && touched.length === 0 && touchedEnv.length === 0) {
      changes.push({
        update: 'carried',
        recomputed: false,
        reason: 'dependencies unchanged',
        id: metadata.id,
        queryKey: metadata.queryKey,
        query: metadata.query as Query<Row>,
        maintenance: metadata.mode,
        dependencies,
        touchedDependencies: [],
        envDependencies,
        touchedEnvDependencies: [],
        indexSpecs,
        previousRowsAvailable: true,
        previousRows,
        rows: previousRows,
        added: [],
        removed: [],
        rowChanges: [],
        diagnostics: []
      });
      continue;
    }

    const incremental = previousRows === undefined || !hasRelationChangeHints || !envHintsCoverDependencies || touchedEnv.length > 0
      ? undefined
      : maintainMaterializationIncrementally(before, target, metadata.query as Query<Row>, previousRows, options.deltas, beforeState.aux.get(metadata.id));

    if (incremental !== undefined && incremental.supported) {
      const refreshedAux = materializationAuxForRows(target, metadata.query as Query<Row>, incremental.rows, incremental.aux);
      if (refreshedAux === undefined) nextAux.delete(metadata.id);
      else nextAux.set(metadata.id, refreshedAux);
      changes.push({
        update: 'incremental',
        recomputed: false,
        reason: incremental.reason,
        id: metadata.id,
        queryKey: metadata.queryKey,
        query: metadata.query as Query<Row>,
        maintenance: metadata.mode,
        dependencies,
        touchedDependencies: touched,
        envDependencies,
        touchedEnvDependencies: touchedEnv,
        indexSpecs,
        previousRowsAvailable: true,
        previousRows,
        rows: incremental.rows,
        added: incremental.added,
        removed: incremental.removed,
        rowChanges: incremental.rowChanges,
        diagnostics: incremental.diagnostics
      });
      continue;
    }

    const fallbackDiagnostics = [
      ...(previousRows === undefined ? [materializationUnsupportedDiagnostic('incremental maintenance requires previous rows')] : []),
      ...(touchedEnv.length > 0 ? [materializationUnsupportedDiagnostic(`env dependency changed: ${touchedEnv.join(', ')}`)] : []),
      ...(incremental === undefined ? [] : incremental.diagnostics)
    ];
    const recomputed = recomputeMaterializationChange(target, metadata as MaterializationMetadata<Row>, previousRows, {
      dependencies,
      touchedDependencies: touched,
      envDependencies,
      touchedEnvDependencies: touchedEnv,
      indexSpecs,
      reason: fallbackDiagnostics.length === 0
        ? 'snapshot recompute'
        : `snapshot recompute: ${fallbackDiagnostics.map((item) => item.message).join('; ')}`,
      diagnostics: fallbackDiagnostics
    });
    changes.push(recomputed);
    const refreshedAux = materializationAuxForRows<Row>(target, metadata.query as Query<Row>, recomputed.rows);
    if (refreshedAux === undefined) nextAux.delete(metadata.id);
    else nextAux.set(metadata.id, refreshedAux);
  }

  const result: MaterializationMaintenanceResult<Row> = {
    maintained: changes.length,
    recomputed: changes.filter((change) => change.recomputed).length,
    carried: changes.filter((change) => change.update === 'carried').length,
    skipped: 0,
    changes,
    diagnostics: changes.flatMap((change) => change.diagnostics)
  };
  return withMaterializationMaintenanceAux(result, nextAux);
}

export function maintainMaterializations<DbValue extends Db, Row = unknown>(
  before: Db,
  after: DbValue,
  options: MaterializationMaintenanceOptions = {}
): MaterializationMaintainResult<DbValue, Row> {
  const materializations = maintainMaterializationSnapshots<Row>(before, after, options);
  return {
    db: applyMaterializationState(after, materializedStateFor(before), materializations) as DbValue & MaterializedDb,
    materializations
  };
}

type MaterializationRowKeyPath = readonly string[];
type MaterializationRowIdentity<Row = unknown> = {
  readonly paths: readonly MaterializationRowKeyPath[];
  readonly fields: readonly string[] | undefined;
  readonly expressions?: readonly ExprData[];
  readonly keyBy: RowKeySelector<Row>;
  readonly keyOf: (row: Row) => string;
  readonly unique: boolean;
  readonly readable?: boolean;
};
type IncrementalJoinSide = {
  readonly side: 'left' | 'right';
  readonly relation: RelationRef;
  readonly alias: string;
  readonly data: QueryData;
};
type IncrementalJoinShape = {
  readonly data: QueryData;
  readonly clause: Readonly<Record<string, string>>;
  readonly left: IncrementalJoinSide;
  readonly right: IncrementalJoinSide;
};
type IncrementalAggregateShape = {
  readonly data: QueryData;
  readonly input: QueryData;
  readonly relation: RelationRef;
  readonly groupIdentity: MaterializationRowIdentity;
};
const MATERIALIZATION_MAINTENANCE_AUX: unique symbol = Symbol('tarstate.materializationMaintenanceAux');
type IncrementalTopNShape = {
  readonly count: number;
  readonly preLimitData: QueryData;
  readonly finalSort: QueryData;
};
type InternalMaterializationIndexKind = 'hash' | 'btree' | 'uniqueIndex';
type InternalMaterializationIndexSpec = {
  readonly op: InternalMaterializationIndexKind;
  readonly field: string;
};
type InternalMaterializationIndexEntry = {
  readonly order: number;
  readonly row: unknown;
};
type InternalMaterializationIndexBucket = {
  readonly value: unknown;
  readonly entries: readonly InternalMaterializationIndexEntry[];
};
type InternalMaterializationIndex = InternalMaterializationIndexSpec & {
  readonly buckets: ReadonlyMap<string, InternalMaterializationIndexBucket>;
  readonly orderedBuckets?: readonly InternalMaterializationIndexBucket[];
};
type InternalMaterializationAux = {
  readonly topNPreLimitRows?: readonly unknown[];
  readonly indexes?: readonly InternalMaterializationIndex[];
};
type InternalMaterializationMaintenanceAux<Row = unknown> = MaterializationMaintenanceResult<Row> & {
  readonly [MATERIALIZATION_MAINTENANCE_AUX]?: ReadonlyMap<string, InternalMaterializationAux>;
};
type IncrementalAggregateAccumulatorField =
  | { readonly kind: 'count'; readonly field: string; readonly predicate?: unknown }
  | { readonly kind: 'sum'; readonly field: string; readonly expr: unknown };
type IncrementalAggregateAccumulator = {
  readonly plainCountField: string;
  readonly fields: readonly IncrementalAggregateAccumulatorField[];
};
type IncrementalAggregateContribution = {
  readonly group: Record<string, unknown>;
  readonly removed: Map<string, number>;
  readonly added: Map<string, number>;
};
type IncrementalMaterializationSupport<Row = unknown> =
  | {
      readonly supported: true;
      readonly relation: RelationRef;
      readonly touchedRelations: readonly RelationRef[];
      readonly identity: MaterializationRowIdentity<Row>;
      readonly finalSort?: QueryData;
      readonly topN?: IncrementalTopNShape;
      readonly join?: IncrementalJoinShape;
      readonly aggregate?: IncrementalAggregateShape;
      readonly trusted: boolean;
      readonly reason: string;
    }
  | {
      readonly supported: false;
      readonly reason: string;
      readonly diagnostics: readonly TarstateDiagnostic[];
    };
type IncrementalMaterializationShape =
  | {
      readonly supported: true;
      readonly relation: RelationRef;
      readonly touchedRelations: readonly RelationRef[];
      readonly finalSort?: QueryData;
      readonly topN?: IncrementalTopNShape;
      readonly join?: IncrementalJoinShape;
      readonly aggregate?: IncrementalAggregateShape;
    }
  | {
      readonly supported: false;
      readonly reason: string;
      readonly diagnostics: readonly TarstateDiagnostic[];
    };
type IncrementalMaterializationResult<Row = unknown> =
  | {
      readonly supported: true;
      readonly reason: string;
      readonly rows: readonly Row[];
      readonly added: readonly Row[];
      readonly removed: readonly Row[];
      readonly rowChanges: readonly RowChange<Row>[];
      readonly diagnostics: readonly TarstateDiagnostic[];
      readonly aux?: InternalMaterializationAux;
    }
  | {
      readonly supported: false;
      readonly reason: string;
      readonly diagnostics: readonly TarstateDiagnostic[];
    };
type IncrementalMaterializedRowsResult<Row = unknown> =
  | {
      readonly supported: true;
      readonly rows: readonly Row[];
      readonly added: readonly Row[];
      readonly removed: readonly Row[];
      readonly rowChanges: readonly RowChange<Row>[];
    }
  | { readonly supported: false; readonly reason: string; readonly diagnostics: readonly TarstateDiagnostic[] };
type IncrementalMaterializedSortPlacement<Row = unknown> = {
  readonly compare: (left: Row, right: Row) => number;
};
type IncrementalJoinContribution<Row = unknown> = {
  readonly side: IncrementalJoinSide['side'];
  readonly deltaIndex: number;
  readonly row: Row;
  readonly key: string;
};
const SOURCE_ORDER_PLACEMENT_MIN_ROWS = 64;

function maintainMaterializationIncrementally<Row>(
  before: unknown,
  target: unknown,
  query: Query<Row>,
  previousRows: readonly Row[],
  deltas: readonly RelationDelta[],
  previousAux?: InternalMaterializationAux
): IncrementalMaterializationResult<Row> {
  const support = incrementalMaterializationSupport(query);
  if (!support.supported) return support;

  const touchedRelationNames = new Set(support.touchedRelations.map((relationRef) => relationRef.name));
  const relationDeltasForQuery = deltas.filter((delta) => touchedRelationNames.has(delta.relation.name));
  if (relationDeltasForQuery.length === 0) {
    return {
      supported: true,
      reason: 'incremental delta maintenance',
      rows: previousRows,
      added: [],
      removed: [],
      rowChanges: [],
      diagnostics: []
    };
  }

  const evaluateOptions = materializationEvaluateOptions(target);
  if (support.join !== undefined) {
    return maintainJoinMaterializationIncrementally(before, target, query, previousRows, relationDeltasForQuery, support, support.join, evaluateOptions);
  }
  if (support.aggregate !== undefined) {
    return maintainAggregateMaterializationIncrementally(before, target, query, previousRows, relationDeltasForQuery, support, support.aggregate, evaluateOptions);
  }
  if (support.topN !== undefined) {
    return maintainTopNMaterializationIncrementally(target, query, previousRows, relationDeltasForQuery, support, support.topN, evaluateOptions, previousAux);
  }

  return maintainSingleRelationMaterializationIncrementally(target, query, previousRows, relationDeltasForQuery, support, evaluateOptions);
}

function maintainTopNMaterializationIncrementally<Row>(
  target: unknown,
  query: Query<Row>,
  previousRows: readonly Row[],
  relationDeltasForQuery: readonly RelationDelta[],
  support: Extract<IncrementalMaterializationSupport<Row>, { readonly supported: true }>,
  topN: IncrementalTopNShape,
  evaluateOptions: EvaluateOptions,
  previousAux?: InternalMaterializationAux
): IncrementalMaterializationResult<Row> {
  const previousPreLimitRows = previousAux?.topNPreLimitRows as readonly Row[] | undefined;
  if (previousPreLimitRows === undefined) {
    const reason = 'top-N incremental maintenance requires auxiliary pre-limit rows';
    return { supported: false, reason, diagnostics: [materializationUnsupportedDiagnostic(reason)] };
  }

  const preLimitQuery = { data: topN.preLimitData, relations: query.relations } as Query<Row>;
  const preLimitUpdate = maintainSingleRelationMaterializationIncrementally(
    target,
    preLimitQuery,
    previousPreLimitRows,
    relationDeltasForQuery,
    support,
    evaluateOptions
  );
  if (!preLimitUpdate.supported) return preLimitUpdate;

  const rows = preLimitUpdate.rows.slice(0, topN.count);
  const diff = diffRows(previousRows, rows, { keyBy: support.identity.keyBy });
  return {
    supported: true,
    reason: 'incremental delta maintenance',
    rows,
    added: diff.changes.flatMap((change) => change.kind === 'added' ? [change.row] : []),
    removed: diff.changes.flatMap((change) => change.kind === 'removed' ? [change.row] : []),
    rowChanges: diff.changes,
    diagnostics: [...preLimitUpdate.diagnostics, ...diff.diagnostics],
    aux: { topNPreLimitRows: preLimitUpdate.rows }
  };
}

function maintainSingleRelationMaterializationIncrementally<Row>(
  target: unknown,
  query: Query<Row>,
  previousRows: readonly Row[],
  relationDeltasForQuery: readonly RelationDelta[],
  support: Extract<IncrementalMaterializationSupport<Row>, { readonly supported: true }>,
  evaluateOptions: EvaluateOptions
): IncrementalMaterializationResult<Row> {
  const diagnostics: TarstateDiagnostic[] = [];
  let rows = previousRows;
  const useDirectRowChanges = support.trusted;
  const directRowChanges = support.trusted
    ? incrementalRowChangeTracker(previousRows, support.identity.keyOf)
    : undefined;
  const sortPlacement = support.trusted && support.finalSort !== undefined
    ? incrementalMaterializedSortPlacement(support.finalSort, query.relations, evaluateOptions, diagnostics)
    : undefined;
  let singleDeltaRowChanges: readonly RowChange<Row>[] | undefined;
  for (const delta of relationDeltasForQuery) {
    const addedResult = evaluateDeltaRows(query, support.relation, delta.added, evaluateOptions);
    const removedResult = evaluateDeltaRows(query, support.relation, delta.removed, evaluateOptions);
    diagnostics.push(...addedResult.diagnostics, ...removedResult.diagnostics);

    const rowUpdate = applyIncrementalMaterializedRows(
      rows,
      removedResult.rows,
      addedResult.rows,
      support.identity,
      {
        sourceRemovedCount: delta.removed.length,
        sorted: support.finalSort !== undefined,
        ...(
          support.finalSort === undefined && support.identity.unique
            ? { sourceOrderKeys: () => materializedSourceOrderKeys(target, support.relation) }
            : {}
        ),
        ...(sortPlacement === undefined ? {} : { sortPlacement })
      }
    );

    if (!rowUpdate.supported) {
      return {
        supported: false,
        reason: rowUpdate.reason,
        diagnostics: [...diagnostics, ...rowUpdate.diagnostics]
      };
    }
    rows = rowUpdate.rows;
    if (
      useDirectRowChanges
      && relationDeltasForQuery.length === 1
      && (support.finalSort === undefined || addedRowChangeCount(rowUpdate.rowChanges) <= 1)
    ) {
      singleDeltaRowChanges = rowUpdate.rowChanges;
    } else {
      directRowChanges?.apply(rowUpdate.rowChanges);
    }
  }

  const orderedRows = sortPlacement === undefined
    ? applyIncrementalMaterializedSort(
        rows,
        support.finalSort,
        query.relations,
        evaluateOptions
      )
    : { rows, diagnostics: [] };
  if (!support.trusted) {
    const refresh = refreshMaterializationRows(target, query);
    if (stableKey(orderedRows.rows) !== stableKey(refresh.rows)) {
      const reason = 'incremental materialization candidate differed from full recompute';
      return {
        supported: false,
        reason,
        diagnostics: [...diagnostics, ...orderedRows.diagnostics, ...refresh.diagnostics, materializationUnsupportedDiagnostic(reason)]
      };
    }
  }

  const directChanges = singleDeltaRowChanges ?? directRowChanges?.changes(orderedRows.rows);
  const diff = directChanges === undefined
    ? diffRows(previousRows, orderedRows.rows, { keyBy: support.identity.keyBy })
    : { changes: directChanges, diagnostics: [] };
  return {
    supported: true,
    reason: 'incremental delta maintenance',
    rows: orderedRows.rows,
    added: diff.changes.flatMap((change) => change.kind === 'added' ? [change.row] : []),
    removed: diff.changes.flatMap((change) => change.kind === 'removed' ? [change.row] : []),
    rowChanges: diff.changes,
    diagnostics: [...diagnostics, ...orderedRows.diagnostics, ...diff.diagnostics]
  };
}

function maintainAggregateMaterializationIncrementally<Row>(
  before: unknown,
  target: unknown,
  query: Query<Row>,
  previousRows: readonly Row[],
  relationDeltasForQuery: readonly RelationDelta[],
  support: Extract<IncrementalMaterializationSupport<Row>, { readonly supported: true }>,
  aggregateShape: IncrementalAggregateShape,
  evaluateOptions: EvaluateOptions
): IncrementalMaterializationResult<Row> {
  const diagnostics: TarstateDiagnostic[] = [];
  const accumulated = maintainAggregateMaterializationWithAccumulator(
    target,
    query,
    previousRows,
    relationDeltasForQuery,
    support,
    aggregateShape,
    evaluateOptions,
    diagnostics
  );
  if (accumulated !== undefined) return accumulated;

  const affected = affectedAggregateGroupKeys(aggregateShape, query.relations, relationDeltasForQuery, evaluateOptions, diagnostics);
  if (!affected.supported) return { ...affected, diagnostics: [...diagnostics, ...affected.diagnostics] };
  if (affected.keys.size === 0) {
    return {
      supported: true,
      reason: 'incremental delta maintenance',
      rows: previousRows,
      added: [],
      removed: [],
      rowChanges: [],
      diagnostics
    };
  }

  const beforeRows = aggregateMaterializationRowsForAffectedGroups(
    before,
    query,
    aggregateShape,
    affected.keys,
    materializationEvaluateOptions(before),
    diagnostics
  );
  if (!beforeRows.supported) return { ...beforeRows, diagnostics: [...diagnostics, ...beforeRows.diagnostics] };

  const afterRows = aggregateMaterializationRowsForAffectedGroups(
    target,
    query,
    aggregateShape,
    affected.keys,
    evaluateOptions,
    diagnostics
  );
  if (!afterRows.supported) return { ...afterRows, diagnostics: [...diagnostics, ...afterRows.diagnostics] };

  return applyAggregateMaterializedRows(
    target,
    query,
    previousRows,
    beforeRows.rows,
    afterRows.rows,
    relationDeltasForQuery,
    support,
    evaluateOptions,
    diagnostics
  );
}

function maintainAggregateMaterializationWithAccumulator<Row>(
  target: unknown,
  query: Query<Row>,
  previousRows: readonly Row[],
  relationDeltasForQuery: readonly RelationDelta[],
  support: Extract<IncrementalMaterializationSupport<Row>, { readonly supported: true }>,
  aggregateShape: IncrementalAggregateShape,
  evaluateOptions: EvaluateOptions,
  diagnostics: TarstateDiagnostic[]
): IncrementalMaterializationResult<Row> | undefined {
  const accumulator = incrementalAggregateAccumulatorFor(aggregateShape.data);
  if (accumulator === undefined) return undefined;
  if (!aggregateAccumulatorCanUseMaterializedRows(query.data, aggregateShape.data)) return undefined;

  const contributions = aggregateDeltaContributions(
    aggregateShape,
    query.relations,
    relationDeltasForQuery,
    accumulator,
    evaluateOptions,
    diagnostics
  );
  if (contributions.size === 0) {
    return {
      supported: true,
      reason: 'incremental delta maintenance',
      rows: previousRows,
      added: [],
      removed: [],
      rowChanges: [],
      diagnostics
    };
  }

  const rows = aggregateAccumulatorMaterializedRows(previousRows, contributions, support.identity, aggregateShape, accumulator);
  if (rows === undefined) return undefined;

  return applyAggregateMaterializedRows(
    target,
    query,
    previousRows,
    rows.removed,
    rows.added,
    relationDeltasForQuery,
    support,
    evaluateOptions,
    diagnostics
  );
}

function applyAggregateMaterializedRows<Row>(
  target: unknown,
  query: Query<Row>,
  previousRows: readonly Row[],
  removedRows: readonly Row[],
  addedRows: readonly Row[],
  relationDeltasForQuery: readonly RelationDelta[],
  support: Extract<IncrementalMaterializationSupport<Row>, { readonly supported: true }>,
  evaluateOptions: EvaluateOptions,
  diagnostics: TarstateDiagnostic[]
): IncrementalMaterializationResult<Row> {
  const finalSortPlacement = support.finalSort === undefined
    ? undefined
    : incrementalMaterializedSortPlacement(support.finalSort, query.relations, evaluateOptions, diagnostics);
  if (finalSortPlacement === undefined) {
    const reason = 'aggregate incremental maintenance requires final sort with group identity';
    return { supported: false, reason, diagnostics: [materializationUnsupportedDiagnostic(reason)] };
  }

  const rowUpdate = applyIncrementalMaterializedRows(
    previousRows,
    removedRows,
    addedRows,
    support.identity,
    {
      sourceRemovedCount: relationDeltasForQuery.reduce((countValue, delta) => countValue + delta.removed.length, 0),
      sorted: true,
      sortPlacement: finalSortPlacement
    }
  );
  if (!rowUpdate.supported) {
    return {
      supported: false,
      reason: rowUpdate.reason,
      diagnostics: [...diagnostics, ...rowUpdate.diagnostics]
    };
  }

  if (!support.trusted) {
    const refresh = refreshMaterializationRows(target, query);
    if (stableKey(rowUpdate.rows) !== stableKey(refresh.rows)) {
      const reason = 'incremental materialization candidate differed from full recompute';
      return {
        supported: false,
        reason,
        diagnostics: [...diagnostics, ...refresh.diagnostics, materializationUnsupportedDiagnostic(reason)]
      };
    }
  }

  const diff = diffRows(previousRows, rowUpdate.rows, { keyBy: support.identity.keyBy });
  return {
    supported: true,
    reason: 'incremental delta maintenance',
    rows: rowUpdate.rows,
    added: diff.changes.flatMap((change) => change.kind === 'added' ? [change.row] : []),
    removed: diff.changes.flatMap((change) => change.kind === 'removed' ? [change.row] : []),
    rowChanges: diff.changes,
    diagnostics: [...diagnostics, ...diff.diagnostics]
  };
}

function incrementalAggregateAccumulatorFor(data: QueryData): IncrementalAggregateAccumulator | undefined {
  const fields: IncrementalAggregateAccumulatorField[] = [];
  let plainCountField: string | undefined;

  for (const [fieldName, projectionExpr] of Object.entries(projectionFrom(data.aggregates))) {
    const exprData = unwrapOptionalProjection(projectionExpr);
    if (!isExpr(exprData) || exprData.op !== 'aggregateCall') return undefined;

    const fn = typeof exprData.fn === 'string' ? exprData.fn : '';
    const args = arrayFromUnknown(exprData.args);
    if (fn === 'count' && args.length === 0) {
      plainCountField ??= fieldName;
      fields.push({ kind: 'count', field: fieldName });
      continue;
    }
    if (fn === 'count' && args.length === 1 && trustedRowLocalExpr(args[0])) {
      fields.push({ kind: 'count', field: fieldName, predicate: args[0] });
      continue;
    }
    if (fn === 'sum' && args.length === 1 && trustedRowLocalExpr(args[0])) {
      fields.push({ kind: 'sum', field: fieldName, expr: args[0] });
      continue;
    }
    return undefined;
  }

  return plainCountField === undefined ? undefined : { plainCountField, fields };
}

function aggregateAccumulatorCanUseMaterializedRows(data: QueryData, aggregateData: QueryData): boolean {
  if (data === aggregateData) return true;
  switch (data.op) {
    case 'hash':
    case 'btree':
    case 'uniqueIndex':
    case 'keyBy':
    case 'sort': {
      const input = queryDataFrom(data.input);
      return input !== undefined && aggregateAccumulatorCanUseMaterializedRows(input, aggregateData);
    }
    default:
      return false;
  }
}

function aggregateDeltaContributions(
  aggregateShape: IncrementalAggregateShape,
  relations: Readonly<Record<string, AnyRelationRef>>,
  relationDeltasForQuery: readonly RelationDelta[],
  accumulator: IncrementalAggregateAccumulator,
  options: EvaluateOptions,
  diagnostics: TarstateDiagnostic[]
): ReadonlyMap<string, IncrementalAggregateContribution> {
  const contributions = new Map<string, IncrementalAggregateContribution>();
  for (const delta of relationDeltasForQuery) {
    if (delta.relation.name !== aggregateShape.relation.name) continue;
    accumulateAggregateDeltaRows(aggregateShape, relations, delta.removed, 'removed', accumulator, options, diagnostics, contributions);
    accumulateAggregateDeltaRows(aggregateShape, relations, delta.added, 'added', accumulator, options, diagnostics, contributions);
  }
  return contributions;
}

function accumulateAggregateDeltaRows(
  aggregateShape: IncrementalAggregateShape,
  relations: Readonly<Record<string, AnyRelationRef>>,
  rows: readonly unknown[],
  phase: 'removed' | 'added',
  accumulator: IncrementalAggregateAccumulator,
  options: EvaluateOptions,
  diagnostics: TarstateDiagnostic[],
  contributions: Map<string, IncrementalAggregateContribution>
): void {
  if (rows.length === 0) return;
  const source = fromObjectSource({ [aggregateShape.relation.name]: rows });
  const entries = evaluateQueryData(source, aggregateShape.input, relations, options, undefined, diagnostics);
  const groupProjection = projectionFrom(aggregateShape.data.groupBy);
  for (const entry of entries) {
    const group = evaluateProjection(groupProjection, entry, source, relations, options, diagnostics, undefined);
    const key = aggregateShape.groupIdentity.keyOf(group);
    let contribution = contributions.get(key);
    if (contribution === undefined) {
      contribution = { group, removed: new Map(), added: new Map() };
      contributions.set(key, contribution);
    }
    const values = phase === 'removed' ? contribution.removed : contribution.added;
    for (const field of accumulator.fields) {
      const valueValue = aggregateDeltaContributionValue(field, entry, source, relations, options, diagnostics);
      values.set(field.field, (values.get(field.field) ?? 0) + valueValue);
    }
  }
}

function aggregateDeltaContributionValue(
  fieldValue: IncrementalAggregateAccumulatorField,
  entry: EvalEntry,
  source: RelationSource,
  relations: Readonly<Record<string, AnyRelationRef>>,
  options: EvaluateOptions,
  diagnostics: TarstateDiagnostic[]
): number {
  if (fieldValue.kind === 'count') {
    return fieldValue.predicate === undefined
      ? 1
      : evaluateExpr(fieldValue.predicate, entry, source, relations, options, diagnostics, undefined) ? 1 : 0;
  }

  const valueValue = evaluateExpr(fieldValue.expr, entry, source, relations, options, diagnostics, undefined);
  return typeof valueValue === 'number' ? valueValue : 0;
}

function aggregateAccumulatorMaterializedRows<Row>(
  previousRows: readonly Row[],
  contributions: ReadonlyMap<string, IncrementalAggregateContribution>,
  identity: MaterializationRowIdentity<Row>,
  aggregateShape: IncrementalAggregateShape,
  accumulator: IncrementalAggregateAccumulator
): { readonly removed: readonly Row[]; readonly added: readonly Row[] } | undefined {
  const previousLookup = previousRowLookup(previousRows, identity);
  const groupFields = projectionFieldNames(aggregateShape.data.groupBy);
  const removed: Row[] = [];
  const added: Row[] = [];

  for (const [key, contribution] of contributions) {
    const previous = previousLookup.get(key)?.row;
    const previousRecord = isRecord(previous) ? previous : undefined;
    const previousCount = aggregateNumericField(previousRecord, accumulator.plainCountField);
    if (previousCount === undefined) return undefined;

    const removedCount = contribution.removed.get(accumulator.plainCountField) ?? 0;
    if (previous === undefined && removedCount > 0) return undefined;
    const nextCount = previousCount
      - removedCount
      + (contribution.added.get(accumulator.plainCountField) ?? 0);
    if (!Number.isFinite(nextCount) || nextCount < 0) return undefined;

    if (previous !== undefined) removed.push(previous);
    if (nextCount === 0) continue;

    const rowValue: Record<string, unknown> = {};
    const groupSource = previousRecord ?? contribution.group;
    for (const fieldName of groupFields) rowValue[fieldName] = groupSource[fieldName];

    for (const fieldValue of accumulator.fields) {
      const previousValue = aggregateNumericField(previousRecord, fieldValue.field);
      if (previousValue === undefined) return undefined;
      const nextValue = previousValue
        - (contribution.removed.get(fieldValue.field) ?? 0)
        + (contribution.added.get(fieldValue.field) ?? 0);
      if (fieldValue.kind === 'count' && (!Number.isFinite(nextValue) || nextValue < 0)) return undefined;
      rowValue[fieldValue.field] = nextValue;
    }
    added.push(rowValue as Row);
  }

  return { removed, added };
}

function aggregateNumericField(rowValue: Record<string, unknown> | undefined, fieldName: string): number | undefined {
  if (rowValue === undefined) return 0;
  const valueValue = rowValue[fieldName];
  return typeof valueValue === 'number' ? valueValue : undefined;
}

function aggregateMaterializationRowsForAffectedGroups<Row>(
  target: unknown,
  query: Query<Row>,
  aggregateShape: IncrementalAggregateShape,
  affectedKeys: ReadonlySet<string>,
  options: EvaluateOptions,
  diagnostics: TarstateDiagnostic[]
): { readonly supported: true; readonly rows: readonly Row[] } | { readonly supported: false; readonly reason: string; readonly diagnostics: readonly TarstateDiagnostic[] } {
  const relationRows = materializationTargetRelationRows(target, aggregateShape.relation);
  if (relationRows === undefined) {
    return unsupportedIncrementalShape('aggregate incremental maintenance requires readable relation snapshots');
  }

  const source = fromObjectSource({ [aggregateShape.relation.name]: relationRows });
  const aggregateRows = aggregateRowsForAffectedGroups(source, aggregateShape, query.relations, affectedKeys, options, diagnostics);
  const finalData = queryDataReplacingAggregateWithRows(query.data, aggregateShape.data, aggregateRows);
  if (finalData === undefined) {
    return unsupportedIncrementalShape('aggregate incremental maintenance requires supported final aggregate wrappers');
  }

  return {
    supported: true,
    rows: evaluateQueryData(fromObjectSource({}), finalData, query.relations, options, undefined, diagnostics)
      .map((entry) => entry.row as Row)
  };
}

function aggregateRowsForAffectedGroups(
  source: RelationSource,
  aggregateShape: IncrementalAggregateShape,
  relations: Readonly<Record<string, AnyRelationRef>>,
  affectedKeys: ReadonlySet<string>,
  options: EvaluateOptions,
  diagnostics: TarstateDiagnostic[]
): readonly Record<string, unknown>[] {
  const input = evaluateQueryData(source, aggregateShape.input, relations, options, undefined, diagnostics);
  const groupProjection = projectionFrom(aggregateShape.data.groupBy);
  const aggregateProjection = projectionFrom(aggregateShape.data.aggregates);
  const groups = new Map<string, { readonly group: Record<string, unknown>; readonly rows: EvalEntry[] }>();

  for (const entry of input) {
    const group = evaluateProjection(groupProjection, entry, source, relations, options, diagnostics, undefined);
    const key = aggregateShape.groupIdentity.keyOf(group);
    if (!affectedKeys.has(key)) continue;
    const existing = groups.get(key);
    if (existing === undefined) {
      groups.set(key, { group, rows: [entry] });
    } else {
      existing.rows.push(entry);
    }
  }

  return Array.from(groups.values()).map(({ group, rows }) => ({
    ...group,
    ...evaluateAggregateProjection(aggregateProjection, rows, source, relations, options, diagnostics, undefined)
  }));
}

function queryDataReplacingAggregateWithRows(
  data: QueryData,
  aggregateData: QueryData,
  rows: readonly Record<string, unknown>[]
): QueryData | undefined {
  if (data === aggregateData) return { op: 'constRows', rows };
  const input = queryDataFrom(data.input);
  if (input === undefined) return undefined;
  const replaced = queryDataReplacingAggregateWithRows(input, aggregateData, rows);
  if (replaced === undefined) return undefined;

  switch (data.op) {
    case 'where':
    case 'project':
    case 'extend':
    case 'without':
    case 'rename':
    case 'qualify':
    case 'hash':
    case 'btree':
    case 'uniqueIndex':
    case 'keyBy':
    case 'sort':
      return { ...data, input: replaced };
    default:
      return undefined;
  }
}

function affectedAggregateGroupKeys(
  aggregateShape: IncrementalAggregateShape,
  relations: Readonly<Record<string, AnyRelationRef>>,
  relationDeltasForQuery: readonly RelationDelta[],
  options: EvaluateOptions,
  diagnostics: TarstateDiagnostic[]
): { readonly supported: true; readonly keys: ReadonlySet<string> } | { readonly supported: false; readonly reason: string; readonly diagnostics: readonly TarstateDiagnostic[] } {
  const keys = new Set<string>();
  for (const delta of relationDeltasForQuery) {
    if (delta.relation.name !== aggregateShape.relation.name) continue;
    for (const key of aggregateGroupKeysForRows(aggregateShape, relations, delta.removed, options, diagnostics)) keys.add(key);
    for (const key of aggregateGroupKeysForRows(aggregateShape, relations, delta.added, options, diagnostics)) keys.add(key);
  }
  return { supported: true, keys };
}

function aggregateGroupKeysForRows(
  aggregateShape: IncrementalAggregateShape,
  relations: Readonly<Record<string, AnyRelationRef>>,
  rows: readonly unknown[],
  options: EvaluateOptions,
  diagnostics: TarstateDiagnostic[]
): readonly string[] {
  if (rows.length === 0) return [];
  const source = fromObjectSource({ [aggregateShape.relation.name]: rows });
  const entries = evaluateQueryData(source, aggregateShape.input, relations, options, undefined, diagnostics);
  const groupProjection = projectionFrom(aggregateShape.data.groupBy);
  return entries.map((entry) => {
    const group = evaluateProjection(groupProjection, entry, source, relations, options, diagnostics, undefined);
    return aggregateShape.groupIdentity.keyOf(group);
  });
}

function maintainJoinMaterializationIncrementally<Row>(
  before: unknown,
  target: unknown,
  query: Query<Row>,
  previousRows: readonly Row[],
  relationDeltasForQuery: readonly RelationDelta[],
  support: Extract<IncrementalMaterializationSupport<Row>, { readonly supported: true }>,
  joinShape: IncrementalJoinShape,
  evaluateOptions: EvaluateOptions
): IncrementalMaterializationResult<Row> {
  const beforeLeftRows = materializationTargetRelationRows(before, joinShape.left.relation);
  const beforeRightRows = materializationTargetRelationRows(before, joinShape.right.relation);
  const afterLeftRows = materializationTargetRelationRows(target, joinShape.left.relation);
  const afterRightRows = materializationTargetRelationRows(target, joinShape.right.relation);
  if (beforeLeftRows === undefined || beforeRightRows === undefined || afterLeftRows === undefined || afterRightRows === undefined) {
    return unsupportedIncrementalShape('join incremental maintenance requires readable before and after relation snapshots');
  }

  const previousDuplicateKeys = duplicateMaterializedRowKeys(previousRows, support.identity);
  if (previousDuplicateKeys.length > 0) return nonUniqueMaterializedRowKeysResult(previousDuplicateKeys);

  const diagnostics: TarstateDiagnostic[] = [];
  const removedContributions: IncrementalJoinContribution<Row>[] = [];
  const addedContributions: IncrementalJoinContribution<Row>[] = [];

  for (const [deltaIndex, delta] of relationDeltasForQuery.entries()) {
    const side = delta.relation.name === joinShape.left.relation.name
      ? joinShape.left
      : delta.relation.name === joinShape.right.relation.name
        ? joinShape.right
        : undefined;
    if (side === undefined) continue;

    const removedResult = evaluateJoinDeltaRows(
      query,
      joinShape,
      side.side,
      delta.removed,
      side.side === 'left' ? beforeRightRows : beforeLeftRows,
      evaluateOptions
    );
    const addedResult = evaluateJoinDeltaRows(
      query,
      joinShape,
      side.side,
      delta.added,
      side.side === 'left' ? afterRightRows : afterLeftRows,
      evaluateOptions
    );
    diagnostics.push(...removedResult.diagnostics, ...addedResult.diagnostics);
    removedContributions.push(...joinContributions(removedResult.rows, side.side, deltaIndex, support.identity));
    addedContributions.push(...joinContributions(addedResult.rows, side.side, deltaIndex, support.identity));
  }

  const removedRows = coalesceJoinContributions(removedContributions, 'removed');
  const addedRows = coalesceJoinContributions(addedContributions, 'added');
  if (!removedRows.supported) return { ...removedRows, diagnostics: [...diagnostics, ...removedRows.diagnostics] };
  if (!addedRows.supported) return { ...addedRows, diagnostics: [...diagnostics, ...addedRows.diagnostics] };

  const finalSortPlacement = support.finalSort === undefined
    ? undefined
    : incrementalMaterializedSortPlacement(support.finalSort, query.relations, evaluateOptions, diagnostics);
  const sourceOrderPlacement = support.finalSort === undefined
    ? incrementalJoinSourceOrderPlacement(target, joinShape, support.identity)
    : undefined;
  const sortPlacement = finalSortPlacement ?? sourceOrderPlacement;
  const rowUpdate = applyIncrementalMaterializedRows(
    previousRows,
    removedRows.rows,
    addedRows.rows,
    support.identity,
    {
      sourceRemovedCount: relationDeltasForQuery.reduce((countValue, delta) => countValue + delta.removed.length, 0),
      sorted: support.finalSort !== undefined || sourceOrderPlacement !== undefined,
      ...(sortPlacement === undefined ? {} : { sortPlacement })
    }
  );
  if (!rowUpdate.supported) {
    return {
      supported: false,
      reason: rowUpdate.reason,
      diagnostics: [...diagnostics, ...rowUpdate.diagnostics]
    };
  }

  const orderedRows = { rows: rowUpdate.rows, diagnostics: [] };
  if (!support.trusted) {
    const refresh = refreshMaterializationRows(target, query);
    if (stableKey(orderedRows.rows) !== stableKey(refresh.rows)) {
      const reason = 'incremental materialization candidate differed from full recompute';
      return {
        supported: false,
        reason,
        diagnostics: [...diagnostics, ...orderedRows.diagnostics, ...refresh.diagnostics, materializationUnsupportedDiagnostic(reason)]
      };
    }
  }

  const diff = diffRows(previousRows, orderedRows.rows, { keyBy: support.identity.keyBy });
  return {
    supported: true,
    reason: 'incremental delta maintenance',
    rows: orderedRows.rows,
    added: diff.changes.flatMap((change) => change.kind === 'added' ? [change.row] : []),
    removed: diff.changes.flatMap((change) => change.kind === 'removed' ? [change.row] : []),
    rowChanges: diff.changes,
    diagnostics: [...diagnostics, ...orderedRows.diagnostics, ...diff.diagnostics]
  };
}

function materializationTargetRelationRows(target: unknown, relationRef: RelationRef): readonly unknown[] | undefined {
  if (isDb(target)) return target.data[relationRef.name] ?? [];
  if (isRelationSource(target)) return target.rows(relationRef);
  return undefined;
}

function evaluateJoinDeltaRows<Row>(
  query: Query<Row>,
  joinShape: IncrementalJoinShape,
  changedSide: IncrementalJoinSide['side'],
  changedRows: readonly unknown[],
  oppositeRows: readonly unknown[],
  options: EvaluateOptions
): MaterializationRefreshResult<Row> {
  if (changedRows.length === 0 || oppositeRows.length === 0) return { rows: [], diagnostics: [] };
  const source = fromObjectSource({
    [joinShape.left.relation.name]: changedSide === 'left' ? changedRows : oppositeRows,
    [joinShape.right.relation.name]: changedSide === 'right' ? changedRows : oppositeRows
  });
  return evaluate(source, query, options);
}

function joinContributions<Row>(
  rows: readonly Row[],
  side: IncrementalJoinSide['side'],
  deltaIndex: number,
  identity: MaterializationRowIdentity<Row>
): readonly IncrementalJoinContribution<Row>[] {
  return rows.map((rowValue) => ({ side, deltaIndex, row: rowValue, key: identity.keyOf(rowValue) }));
}

function coalesceJoinContributions<Row>(
  contributions: readonly IncrementalJoinContribution<Row>[],
  phase: 'removed' | 'added'
): { readonly supported: true; readonly rows: readonly Row[] } | { readonly supported: false; readonly reason: string; readonly diagnostics: readonly TarstateDiagnostic[] } {
  const byKey = new Map<string, IncrementalJoinContribution<Row>[]>();
  for (const contribution of contributions) {
    const existing = byKey.get(contribution.key);
    if (existing === undefined) byKey.set(contribution.key, [contribution]);
    else existing.push(contribution);
  }

  const rows: Row[] = [];
  const duplicateKeys: string[] = [];
  for (const [key, entries] of byKey) {
    const first = entries[0];
    if (first === undefined) continue;
    if (entries.length === 1) {
      rows.push(first.row);
      continue;
    }

    const perDelta = new Map<number, IncrementalJoinContribution<Row>[]>();
    for (const entry of entries) {
      const deltaEntries = perDelta.get(entry.deltaIndex);
      if (deltaEntries === undefined) perDelta.set(entry.deltaIndex, [entry]);
      else deltaEntries.push(entry);
    }

    if (Array.from(perDelta.values()).some((deltaEntries) => deltaEntries.length > 1)) {
      duplicateKeys.push(key);
      continue;
    }

    if (entries.every((entry) => rowsEqualForDiff(first.row, entry.row))) {
      rows.push(first.row);
      continue;
    }

    const sorted = [...entries].sort((left, right) => left.deltaIndex - right.deltaIndex);
    const selected = phase === 'removed' ? sorted[0] : sorted[sorted.length - 1];
    if (selected === undefined) duplicateKeys.push(key);
    else rows.push(selected.row);
  }

  return duplicateKeys.length === 0
    ? { supported: true, rows }
    : nonUniqueMaterializedRowKeysResult(duplicateKeys);
}

function duplicateMaterializedRowKeys<Row>(
  rows: readonly Row[],
  identity: MaterializationRowIdentity<Row>
): readonly string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const rowValue of rows) {
    const key = identity.keyOf(rowValue);
    if (seen.has(key)) duplicates.add(key);
    else seen.add(key);
  }
  return [...duplicates];
}

function nonUniqueMaterializedRowKeysResult(
  duplicateKeys: readonly string[]
): { readonly supported: false; readonly reason: string; readonly diagnostics: readonly TarstateDiagnostic[] } {
  const reason = `incremental maintenance requires unique materialized row keys: ${uniqueStrings(duplicateKeys).join(', ')}`;
  return { supported: false, reason, diagnostics: [materializationUnsupportedDiagnostic(reason)] };
}

function incrementalJoinSourceOrderPlacement<Row>(
  target: unknown,
  joinShape: IncrementalJoinShape,
  identity: MaterializationRowIdentity<Row>
): IncrementalMaterializedSortPlacement<Row> | undefined {
  if (!identity.unique || identity.paths.length === 0) return undefined;
  const leftKeyFields = relationKeyFields(joinShape.left.relation);
  const rightKeyFields = relationKeyFields(joinShape.right.relation);
  if (identity.paths.length !== leftKeyFields.length + rightKeyFields.length) return undefined;

  const leftRows = materializationTargetRelationRows(target, joinShape.left.relation);
  const rightRows = materializationTargetRelationRows(target, joinShape.right.relation);
  if (leftRows === undefined || rightRows === undefined) return undefined;

  const leftOrder = relationKeyOrder(leftRows, joinShape.left.relation);
  const rightOrder = relationKeyOrder(rightRows, joinShape.right.relation);
  const leftKeyCount = leftKeyFields.length;

  const orderFor = (rowValue: Row): { readonly left: number; readonly right: number; readonly key: string } => {
    const values = identity.paths.map((path) => valueAtPath(rowValue, path));
    const left = leftOrder.get(stableKey(values.slice(0, leftKeyCount))) ?? Number.POSITIVE_INFINITY;
    const right = rightOrder.get(stableKey(values.slice(leftKeyCount))) ?? Number.POSITIVE_INFINITY;
    return { left, right, key: stableKey(values) };
  };

  return {
    compare: (left, right) => {
      const leftOrderValue = orderFor(left);
      const rightOrderValue = orderFor(right);
      if (leftOrderValue.left !== rightOrderValue.left) return leftOrderValue.left < rightOrderValue.left ? -1 : 1;
      if (leftOrderValue.right !== rightOrderValue.right) return leftOrderValue.right < rightOrderValue.right ? -1 : 1;
      return leftOrderValue.key < rightOrderValue.key ? -1 : leftOrderValue.key > rightOrderValue.key ? 1 : 0;
    }
  };
}

function relationKeyOrder(rows: readonly unknown[], relationRef: RelationRef): ReadonlyMap<string, number> {
  const fields = relationKeyFields(relationRef);
  const order = new Map<string, number>();
  rows.forEach((rowValue, indexValue) => {
    const key = stableKey(fields.map((fieldName) => isRecord(rowValue) ? rowValue[fieldName] : undefined));
    if (!order.has(key)) order.set(key, indexValue);
  });
  return order;
}

function recomputeMaterializationChange<Row>(
  target: unknown,
  metadata: MaterializationMetadata<Row>,
  previousRows: readonly Row[] | undefined,
  options: {
    readonly dependencies: readonly string[];
    readonly touchedDependencies: readonly string[];
    readonly envDependencies: readonly string[];
    readonly touchedEnvDependencies: readonly string[];
    readonly indexSpecs: readonly MaterializationIndexSpec[];
    readonly reason: string;
    readonly diagnostics: readonly TarstateDiagnostic[];
  }
): MaterializationMaintenanceChange<Row> {
  const refresh = refreshMaterializationRows<Row>(target, metadata.query);
  const diff = diffRows(previousRows ?? [], refresh.rows);
  return {
    update: 'recomputed',
    recomputed: true,
    reason: options.reason,
    id: metadata.id,
    queryKey: metadata.queryKey,
    query: metadata.query,
    maintenance: metadata.mode,
    dependencies: options.dependencies,
    touchedDependencies: options.touchedDependencies,
    envDependencies: options.envDependencies,
    touchedEnvDependencies: options.touchedEnvDependencies,
    indexSpecs: options.indexSpecs,
    previousRowsAvailable: previousRows !== undefined,
    previousRows,
    rows: refresh.rows,
    added: diff.changes.flatMap((change) => change.kind === 'added' ? [change.row] : []),
    removed: diff.changes.flatMap((change) => change.kind === 'removed' ? [change.row] : []),
    rowChanges: diff.changes,
    diagnostics: [...options.diagnostics, ...refresh.diagnostics, ...diff.diagnostics]
  };
}

function materializationIndexSpecs(query: Query): readonly MaterializationIndexSpec[] {
  const finalFields = finalRowFieldExpressions(query.data, query.relations);
  return materializationIndexSpecsFromData(query.data, finalFields);
}

function materializationIndexSpecsFromData(
  data: QueryData,
  finalFields: ReadonlyMap<string, ExprData>
): readonly MaterializationIndexSpec[] {
  const input = queryDataFrom(data.input);
  const nested = input === undefined ? [] : materializationIndexSpecsFromData(input, finalFields);
  const own = materializationIndexSpecFromData(data, finalFields);
  return own === undefined ? nested : [...nested, own];
}

function materializationIndexSpecFromData(
  data: QueryData,
  finalFields: ReadonlyMap<string, ExprData>
): MaterializationIndexSpec | undefined {
  const expression = arrayFromUnknown(data.expressions)[0];
  if (!isExpr(expression) || arrayFromUnknown(data.expressions).length !== 1) return undefined;
  const expressions = [expression] as const;
  const fieldName = finalRowFieldNameForExpr(expression, finalFields);
  if (fieldName === undefined) return undefined;

  switch (data.op) {
    case 'hash':
      return {
        op: 'hash',
        field: fieldName,
        expressions
      };
    case 'btree':
      return {
        op: 'btree',
        field: fieldName,
        expressions
      };
    case 'uniqueIndex':
      return {
        op: 'uniqueIndex',
        field: fieldName,
        expressions
      };
    default:
      return undefined;
  }
}

function internalMaterializationIndexSpec(input: MaterializationIndexSpec): InternalMaterializationIndexSpec | undefined {
  const op = input.op;
  const fieldName = input.field;
  if ((op !== 'hash' && op !== 'btree' && op !== 'uniqueIndex') || typeof fieldName !== 'string') return undefined;
  return { op, field: fieldName };
}

function materializationIndexesForRows<Row>(
  query: Query<Row>,
  rows: readonly Row[]
): readonly InternalMaterializationIndex[] | undefined {
  const specs = materializationIndexSpecs(query).flatMap((spec) => {
    const internal = internalMaterializationIndexSpec(spec);
    return internal === undefined ? [] : [internal];
  });
  if (specs.length === 0) return undefined;
  return specs.map((spec) => materializationIndexForRows(spec, rows));
}

function materializationIndexForRows<Row>(
  spec: InternalMaterializationIndexSpec,
  rows: readonly Row[]
): InternalMaterializationIndex {
  const buckets = new Map<string, { value: unknown; entries: InternalMaterializationIndexEntry[] }>();
  for (const [order, rowValue] of rows.entries()) {
    if (!isRecord(rowValue)) continue;
    const valueValue = rowValue[spec.field];
    const key = stableKey(valueValue);
    const existing = buckets.get(key);
    if (existing === undefined) {
      buckets.set(key, { value: valueValue, entries: [{ order, row: rowValue }] });
    } else {
      existing.entries.push({ order, row: rowValue });
    }
  }

  const finalizedBuckets = new Map<string, InternalMaterializationIndexBucket>(
    Array.from(buckets, ([key, bucket]) => [key, { value: bucket.value, entries: bucket.entries }])
  );
  return {
    ...spec,
    buckets: finalizedBuckets,
    ...(spec.op === 'btree'
      ? { orderedBuckets: Array.from(finalizedBuckets.values()).sort((left, right) => compareValues(left.value, right.value)) }
      : {})
  };
}

function materializedIndexLookup(
  state: InternalMaterializationState,
  lookupValue: RelationLookup
): readonly unknown[] | undefined {
  const indexes = state.aux.get(lookupValue.relation.name)?.indexes;
  const index = indexes?.find((item) =>
    (item.op === 'hash' || item.op === 'uniqueIndex') && item.field === lookupValue.field);
  if (index === undefined) return undefined;
  const bucket = index.buckets.get(stableKey(lookupValue.value));
  if (bucket === undefined) return [];
  return bucket.entries
    .filter((entry) => isRecord(entry.row) && Object.is(entry.row[lookupValue.field], lookupValue.value))
    .map((entry) => entry.row);
}

function materializedIndexRangeLookup(
  state: InternalMaterializationState,
  lookupValue: RelationRangeLookup
): readonly unknown[] | undefined {
  const rows = state.rows.get(lookupValue.relation.name);
  const indexes = state.aux.get(lookupValue.relation.name)?.indexes;
  const index = indexes?.find((item) => item.op === 'btree' && item.field === lookupValue.field);
  if (index === undefined) return undefined;
  const buckets = materializedIndexRangeBuckets(index, lookupValue);
  const matchedEntryCount = buckets.reduce((sumValue, bucket) => sumValue + bucket.entries.length, 0);
  if (rows !== undefined && matchedEntryCount > rows.length / 16) {
    return rows.filter((rowValue) =>
      isRecord(rowValue) && materializationRangeContainsValue(rowValue[lookupValue.field], lookupValue));
  }
  return buckets.flatMap((bucket) => bucket.entries)
    .sort((left, right) => left.order - right.order)
    .map((entry) => entry.row);
}

function materializedIndexRangeBuckets(
  index: InternalMaterializationIndex,
  lookupValue: RelationRangeLookup
): readonly InternalMaterializationIndexBucket[] {
  const orderedBuckets = index.orderedBuckets;
  if (orderedBuckets === undefined) {
    return Array.from(index.buckets.values()).filter((bucket) => materializationRangeContainsValue(bucket.value, lookupValue));
  }

  const start = lookupValue.lower === undefined ? 0 : materializationRangeLowerIndex(orderedBuckets, lookupValue.lower);
  const end = lookupValue.upper === undefined ? orderedBuckets.length : materializationRangeUpperIndex(orderedBuckets, lookupValue.upper);
  return orderedBuckets.slice(start, end);
}

function materializationRangeLowerIndex(
  buckets: readonly InternalMaterializationIndexBucket[],
  lower: RelationRangeBound
): number {
  let start = 0;
  let end = buckets.length;
  while (start < end) {
    const midpoint = Math.floor((start + end) / 2);
    const bucket = buckets[midpoint];
    const comparisonValue = bucket === undefined ? 1 : compareValues(bucket.value, lower.value);
    if (comparisonValue < 0 || (comparisonValue === 0 && !lower.inclusive)) start = midpoint + 1;
    else end = midpoint;
  }
  return start;
}

function materializationRangeUpperIndex(
  buckets: readonly InternalMaterializationIndexBucket[],
  upper: RelationRangeBound
): number {
  let start = 0;
  let end = buckets.length;
  while (start < end) {
    const midpoint = Math.floor((start + end) / 2);
    const bucket = buckets[midpoint];
    const comparisonValue = bucket === undefined ? 1 : compareValues(bucket.value, upper.value);
    if (comparisonValue > 0 || (comparisonValue === 0 && !upper.inclusive)) end = midpoint;
    else start = midpoint + 1;
  }
  return start;
}

function materializationRangeContainsValue(valueValue: unknown, lookupValue: RelationRangeLookup): boolean {
  if (lookupValue.lower !== undefined) {
    const comparisonValue = compareValues(valueValue, lookupValue.lower.value);
    if (comparisonValue < 0 || (comparisonValue === 0 && !lookupValue.lower.inclusive)) return false;
  }
  if (lookupValue.upper !== undefined) {
    const comparisonValue = compareValues(valueValue, lookupValue.upper.value);
    if (comparisonValue > 0 || (comparisonValue === 0 && !lookupValue.upper.inclusive)) return false;
  }
  return true;
}

function incrementalMaterializationSupport<Row>(query: Query<Row>): IncrementalMaterializationSupport<Row> {
  const topN = incrementalTopNMaterializationPlan(query.data, query.relations);
  if (topN.kind === 'unsupported') return { supported: false, reason: topN.reason, diagnostics: topN.diagnostics };
  if (topN.kind === 'supported') return incrementalTopNMaterializationSupport(query, topN.plan);

  const shape = incrementalMaterializationShape(query.data, query.relations);
  if (!shape.supported) return shape;

  const identity = shape.join === undefined
    ? rowIdentityForQueryData<Row>(query.data, query.relations)
    : joinMaterializedRowIdentity<Row>(query.data, query.relations, shape.join);
  const aggregateGroupIdentity = shape.aggregate === undefined
    ? undefined
    : aggregateGroupIdentityForFinalData<Row>(query.data, query.relations);
  if (shape.aggregate !== undefined && aggregateGroupIdentity === undefined) {
    const reason = 'aggregate incremental maintenance requires final projection to preserve group identity';
    return { supported: false, reason, diagnostics: [materializationUnsupportedDiagnostic(reason)] };
  }
  if (identity === undefined || identity.readable === false) {
    return {
      supported: false,
      reason: 'incremental maintenance requires a stable materialized row identity',
      diagnostics: [materializationUnsupportedDiagnostic('incremental maintenance requires a stable materialized row identity')]
    };
  }
  if (shape.aggregate !== undefined) {
    if (shape.finalSort === undefined) {
      const reason = 'aggregate incremental maintenance requires final sort with group identity';
      return { supported: false, reason, diagnostics: [materializationUnsupportedDiagnostic(reason)] };
    }
    const preservesGroupIdentity = aggregateGroupIdentity !== undefined && stableKey(aggregateGroupIdentity.paths) === stableKey(identity.paths);
    if (!preservesGroupIdentity) {
      const reason = 'aggregate incremental maintenance requires final projection to preserve group identity';
      return { supported: false, reason, diagnostics: [materializationUnsupportedDiagnostic(reason)] };
    }
    if (
      shape.finalSort !== undefined
      && !finalSortIncludesMaterializedIdentity(shape.finalSort, query.relations, identity)
    ) {
      const reason = 'aggregate final sort requires group identity in sort order';
      return { supported: false, reason, diagnostics: [materializationUnsupportedDiagnostic(reason)] };
    }
  }

  return {
    supported: true,
    relation: shape.relation,
    touchedRelations: shape.touchedRelations,
    identity,
    ...(shape.finalSort === undefined ? {} : { finalSort: shape.finalSort }),
    ...(shape.topN === undefined ? {} : { topN: shape.topN }),
    ...(shape.join === undefined ? {} : { join: shape.join }),
    ...(shape.aggregate === undefined ? {} : { aggregate: shape.aggregate }),
    trusted: trustedIncrementalMaterialization(query, shape, identity),
    reason: shape.join === undefined
      ? shape.aggregate === undefined
        ? 'single-source pipeline with stable row identity'
        : 'single-source aggregate pipeline with stable group identity'
      : 'two-relation equi-join pipeline with stable row identity'
  };
}

type IncrementalTopNPlanResult =
  | { readonly kind: 'none' }
  | { readonly kind: 'supported'; readonly plan: IncrementalTopNShape }
  | { readonly kind: 'unsupported'; readonly reason: string; readonly diagnostics: readonly TarstateDiagnostic[] };

function incrementalTopNMaterializationPlan(
  data: QueryData,
  relations: Readonly<Record<string, AnyRelationRef>>
): IncrementalTopNPlanResult {
  switch (data.op) {
    case 'limit': {
      const count = topNLimitCount(data.count);
      if (count === undefined) return unsupportedTopNPlan('top-N incremental maintenance requires a finite limit count');
      if (data.offset !== undefined && topNLimitCount(data.offset) !== 0) {
        return unsupportedTopNPlan('top-N incremental maintenance does not support offset');
      }

      const input = queryDataFrom(data.input);
      if (input?.op !== 'sort') {
        return unsupportedTopNPlan('top-N incremental maintenance requires sorted limit input');
      }

      return { kind: 'supported', plan: { count, preLimitData: input, finalSort: input } };
    }
    case 'sortLimit': {
      const count = topNLimitCount(data.count);
      if (count === undefined) return unsupportedTopNPlan('top-N incremental maintenance requires a finite limit count');
      const finalSort = sortDataForSortLimit(data);
      return { kind: 'supported', plan: { count, preLimitData: finalSort, finalSort } };
    }
    case 'project': {
      const input = queryDataFrom(data.input);
      if (input === undefined) return { kind: 'none' };
      const nested = incrementalTopNMaterializationPlan(input, relations);
      if (nested.kind !== 'supported') return nested;

      const preLimitData = { ...data, input: nested.plan.preLimitData } as QueryData;
      const finalSort = projectedFinalSortData(preLimitData, nested.plan.finalSort, relations);
      const identity = rowIdentityForQueryData(preLimitData, relations);
      if (finalSort === undefined || identity === undefined || identity.readable === false) {
        return unsupportedTopNPlan('project-after-top-N requires final projection to preserve row identity and sort keys');
      }

      return {
        kind: 'supported',
        plan: {
          count: nested.plan.count,
          preLimitData,
          finalSort
        }
      };
    }
    default:
      return { kind: 'none' };
  }
}

function topNLimitCount(input: unknown): number | undefined {
  return typeof input === 'number' && Number.isFinite(input) ? Math.max(0, input) : undefined;
}

function sortDataForSortLimit(data: QueryData): QueryData {
  return { op: 'sort', input: data.input, order: data.order };
}

function unsupportedTopNPlan(reason: string): Extract<IncrementalTopNPlanResult, { readonly kind: 'unsupported' }> {
  return { kind: 'unsupported', reason, diagnostics: [materializationUnsupportedDiagnostic(reason)] };
}

function incrementalTopNMaterializationSupport<Row>(
  query: Query<Row>,
  topN: IncrementalTopNShape
): IncrementalMaterializationSupport<Row> {
  const preLimitQuery = { data: topN.preLimitData, relations: query.relations } as Query<Row>;
  const support = incrementalMaterializationSupport(preLimitQuery);
  if (!support.supported) return support;

  if (support.join !== undefined || support.aggregate !== undefined) {
    return unsupportedIncrementalShape('top-N incremental maintenance requires a direct single-source input');
  }
  if (support.finalSort === undefined) {
    return unsupportedIncrementalShape('top-N incremental maintenance requires a final sort order');
  }
  if (!finalSortEvaluableFromFinalRow(support.finalSort, query.relations)) {
    return unsupportedIncrementalShape('top-N incremental maintenance requires sort expressions evaluable from final rows');
  }
  if (!finalSortIncludesMaterializedIdentity(support.finalSort, query.relations, support.identity)) {
    return unsupportedIncrementalShape('top-N incremental maintenance requires final sort to include materialized identity');
  }
  if (!support.trusted) {
    return unsupportedIncrementalShape('top-N incremental maintenance requires trusted row-local expressions');
  }

  return {
    supported: true,
    relation: support.relation,
    touchedRelations: support.touchedRelations,
    identity: support.identity,
    finalSort: support.finalSort,
    topN: { ...topN, finalSort: support.finalSort },
    trusted: true,
    reason: 'single-source top-N pipeline with total sort order'
  };
}

function trustedIncrementalMaterialization<Row>(
  query: Query<Row>,
  shape: Extract<IncrementalMaterializationShape, { readonly supported: true }>,
  identity: MaterializationRowIdentity<Row>
): boolean {
  if (!trustedIncrementalQueryExpressions(query.data)) return false;
  return shape.finalSort === undefined
    || (
      finalSortEvaluableFromFinalRow(shape.finalSort, query.relations)
      && finalSortIncludesMaterializedIdentity(shape.finalSort, query.relations, identity)
    );
}

function incrementalMaterializationShape(
  data: QueryData,
  relations: Readonly<Record<string, AnyRelationRef>>,
  finalPosition = true
): IncrementalMaterializationShape {
  switch (data.op) {
    case 'from':
    case 'lookup': {
      const relationName = typeof data.relation === 'string' ? data.relation : undefined;
      const relationRef = relationName === undefined ? undefined : relations[relationName];
      if (relationRef === undefined) {
        const reason = 'incremental maintenance requires a readable source relation';
        return { supported: false, reason, diagnostics: [materializationUnsupportedDiagnostic(reason)] };
      }
      return { supported: true, relation: relationRef as RelationRef, touchedRelations: [relationRef as RelationRef] };
    }
    case 'where':
      if (containsIncrementalSubquery(data.predicate)) return unsupportedIncrementalShape('correlated or selected subqueries are not incrementally maintained');
      return incrementalNestedShape(data, relations);
    case 'project':
      if (projectionHasAggregate(projectionFrom(data.projection))) return unsupportedIncrementalShape('aggregate projection is not incrementally maintained');
      if (containsIncrementalSubquery(data.projection)) return unsupportedIncrementalShape('correlated or selected subqueries are not incrementally maintained');
      if (finalPosition) {
        const input = queryDataFrom(data.input);
        if (input?.op === 'sort') {
          const order = arrayFromUnknown(input.order);
          if (order.some(containsIncrementalSubquery)) return unsupportedIncrementalShape('correlated or selected subqueries are not incrementally maintained');
          if (order.some(containsAggregateCall)) return unsupportedIncrementalShape('aggregate sort expressions are not incrementally maintained');
          const finalSort = projectedFinalSortData(data, input, relations);
          if (finalSort === undefined) {
            return unsupportedIncrementalShape('sort-before-project requires final projection to preserve sort keys');
          }
          const nested = incrementalNestedShape(input, relations);
          return nested.supported ? { ...nested, finalSort } : nested;
        }
      }
      return incrementalNestedShape(data, relations);
    case 'extend':
      if (containsIncrementalSubquery(data.projection)) return unsupportedIncrementalShape('correlated or selected subqueries are not incrementally maintained');
      return incrementalNestedShape(data, relations);
    case 'without':
    case 'rename':
    case 'qualify':
    case 'keyBy':
    case 'hash':
    case 'btree':
    case 'uniqueIndex':
      return incrementalNestedShape(data, relations);
    case 'aggregate':
      return incrementalAggregateMaterializationShape(data, relations);
    case 'sort': {
      if (!finalPosition) return unsupportedIncrementalShape('non-final sort queries are not incrementally maintained');
      const order = arrayFromUnknown(data.order);
      if (order.some(containsIncrementalSubquery)) return unsupportedIncrementalShape('correlated or selected subqueries are not incrementally maintained');
      if (order.some(containsAggregateCall)) return unsupportedIncrementalShape('aggregate sort expressions are not incrementally maintained');
      const nested = incrementalNestedShape(data, relations);
      return nested.supported ? { ...nested, finalSort: data } : nested;
    }
    case 'limit':
    case 'sortLimit':
      return unsupportedIncrementalShape('limit queries require auxiliary pre-limit state and are not incrementally maintained');
    case 'join':
      return incrementalJoinMaterializationShape(data, relations);
    case 'union':
    case 'intersection':
    case 'difference':
      return unsupportedIncrementalShape('set operation queries are not incrementally maintained');
    case 'expand':
      return unsupportedIncrementalShape('expand queries are not incrementally maintained');
    default:
      return unsupportedIncrementalShape(`query op "${data.op}" is not incrementally maintained`);
  }
}

function incrementalNestedShape(
  data: QueryData,
  relations: Readonly<Record<string, AnyRelationRef>>
): ReturnType<typeof incrementalMaterializationShape> {
  const input = queryDataFrom(data.input);
  return input === undefined
    ? unsupportedIncrementalShape('incremental maintenance requires a nested input query')
    : incrementalMaterializationShape(input, relations, false);
}

function unsupportedIncrementalShape(reason: string): { readonly supported: false; readonly reason: string; readonly diagnostics: readonly TarstateDiagnostic[] } {
  return { supported: false, reason, diagnostics: [materializationUnsupportedDiagnostic(reason)] };
}

function incrementalAggregateMaterializationShape(
  data: QueryData,
  relations: Readonly<Record<string, AnyRelationRef>>
): IncrementalMaterializationShape {
  const groupProjection = projectionFrom(data.groupBy);
  if (Object.keys(groupProjection).length === 0) {
    return unsupportedIncrementalShape('aggregate incremental maintenance requires non-empty groupBy identity');
  }
  if (!trustedProjectionExpressions(groupProjection)) {
    return unsupportedIncrementalShape('aggregate groupBy expressions are not incrementally maintained');
  }

  const aggregateProjectionSupport = supportedIncrementalAggregateProjection(data.aggregates);
  if (!aggregateProjectionSupport.supported) return aggregateProjectionSupport;

  const input = queryDataFrom(data.input);
  if (input === undefined) return unsupportedIncrementalShape('incremental maintenance requires a nested input query');
  const nested = incrementalMaterializationShape(input, relations, false);
  if (!nested.supported) return nested;
  if (nested.join !== undefined || nested.aggregate !== undefined) {
    return unsupportedIncrementalShape('aggregate incremental maintenance requires a direct single-source input');
  }

  const groupIdentity = aggregateGroupIdentityForData(data);
  if (groupIdentity === undefined) {
    return unsupportedIncrementalShape('aggregate incremental maintenance requires non-empty groupBy identity');
  }

  return {
    supported: true,
    relation: nested.relation,
    touchedRelations: nested.touchedRelations,
    aggregate: {
      data,
      input,
      relation: nested.relation,
      groupIdentity
    }
  };
}

function supportedIncrementalAggregateProjection(
  input: unknown
): { readonly supported: true } | { readonly supported: false; readonly reason: string; readonly diagnostics: readonly TarstateDiagnostic[] } {
  const projection = projectionFrom(input);
  for (const projectionExpr of Object.values(projection)) {
    const data = unwrapOptionalProjection(projectionExpr);
    if (!isExpr(data) || data.op !== 'aggregateCall') {
      return unsupportedIncrementalShape('aggregate projections must contain only supported aggregate calls');
    }

    const fn = typeof data.fn === 'string' ? data.fn : '';
    const args = arrayFromUnknown(data.args);
    if (fn === 'count') {
      if (args.length === 0) continue;
      if (args.length === 1 && trustedRowLocalExpr(args[0])) continue;
      return unsupportedIncrementalShape('count aggregate predicates are not incrementally maintained');
    }
    if (fn === 'sum') {
      if (args.length === 1 && trustedRowLocalExpr(args[0])) continue;
      return unsupportedIncrementalShape('sum aggregate expressions are not incrementally maintained');
    }

    return unsupportedIncrementalShape(`aggregate function "${fn}" is not incrementally maintained`);
  }
  return { supported: true };
}

function incrementalJoinMaterializationShape(
  data: QueryData,
  relations: Readonly<Record<string, AnyRelationRef>>
): IncrementalMaterializationShape {
  if (data.kind !== 'inner') {
    return unsupportedIncrementalShape(data.kind === 'left'
      ? 'left join queries are not incrementally maintained'
      : 'non-inner join queries are not incrementally maintained');
  }

  if (isPredicateData(data.on)) {
    return unsupportedIncrementalShape('predicate join queries are not incrementally maintained');
  }

  const clause = equiJoinClauseMapFrom(data.on);
  if (clause === undefined) {
    return unsupportedIncrementalShape('join clause queries require a non-empty equi-clause map');
  }

  const leftData = queryDataFrom(data.left);
  const rightData = queryDataFrom(data.right);
  const left = leftData === undefined ? undefined : directIncrementalJoinSide('left', leftData, relations);
  const right = rightData === undefined ? undefined : directIncrementalJoinSide('right', rightData, relations);
  if (left === undefined || right === undefined || left.relation.name === right.relation.name) {
    return unsupportedIncrementalShape('join incremental maintenance requires two direct relation inputs');
  }

  const joinShape: IncrementalJoinShape = { data, clause, left, right };
  return {
    supported: true,
    relation: left.relation,
    touchedRelations: [left.relation, right.relation],
    join: joinShape
  };
}

function directIncrementalJoinSide(
  side: 'left' | 'right',
  data: QueryData,
  relations: Readonly<Record<string, AnyRelationRef>>
): IncrementalJoinSide | undefined {
  if (data.op !== 'from' && data.op !== 'lookup') return undefined;
  const relationName = typeof data.relation === 'string' ? data.relation : undefined;
  const relationRef = relationName === undefined ? undefined : relations[relationName];
  if (!isRelationRef(relationRef)) return undefined;
  const alias = typeof data.alias === 'string' ? data.alias : relationRef.name;
  return { side, relation: relationRef as RelationRef, alias, data };
}

function equiJoinClauseMapFrom(input: unknown): Readonly<Record<string, string>> | undefined {
  if (!isRecord(input) || isPredicateData(input)) return undefined;
  const entries = Object.entries(input);
  if (entries.length === 0 || entries.some(([, rightField]) => typeof rightField !== 'string')) return undefined;
  return Object.fromEntries(entries) as Record<string, string>;
}

function materializationUnsupportedDiagnostic(message: string): TarstateDiagnostic {
  return {
    code: 'materialization_unsupported',
    severity: 'info',
    message,
    surface: 'materialization'
  };
}

function projectedFinalSortData(
  projectData: QueryData,
  sortData: QueryData,
  relations: Readonly<Record<string, AnyRelationRef>>
): QueryData | undefined {
  const finalSort = { ...sortData, input: projectData } as QueryData;
  return finalSortEvaluableFromFinalRow(finalSort, relations) ? finalSort : undefined;
}

function evaluateDeltaRows<Row>(
  query: Query<Row>,
  relationRef: RelationRef,
  rows: readonly unknown[],
  options: EvaluateOptions
): MaterializationRefreshResult<Row> {
  if (rows.length === 0) return { rows: [], diagnostics: [] };
  return evaluate(fromObjectSource({ [relationRef.name]: rows }), query, options);
}

function materializationEvaluateOptions(target: unknown): EvaluateOptions {
  return isDb(target) ? { env: target.env } : {};
}

function applyIncrementalMaterializedRows<Row>(
  previousRows: readonly Row[],
  removedRows: readonly Row[],
  addedRows: readonly Row[],
  identity: MaterializationRowIdentity<Row>,
  options: {
    readonly sourceRemovedCount?: number;
    readonly sorted?: boolean;
    readonly sourceOrderKeys?: () => readonly string[] | undefined;
    readonly sortPlacement?: IncrementalMaterializedSortPlacement<Row>;
  } = {}
): IncrementalMaterializedRowsResult<Row> {
  const keyOf = identity.keyOf;
  const removedByKey = new Map<string, Row>();
  const addedByKey = new Map<string, Row>();
  const duplicateKeys = new Set<string>();

  const track = <Value>(map: Map<string, Value>, key: string, value: Value): void => {
    if (map.has(key)) duplicateKeys.add(key);
    map.set(key, value);
  };

  const removedKeyedRows = removedRows.map((rowValue) => {
    const key = keyOf(rowValue);
    track(removedByKey, key, rowValue);
    return { key, row: rowValue };
  });
  const addedKeyedRows = addedRows.map((rowValue) => {
    const key = keyOf(rowValue);
    track(addedByKey, key, rowValue);
    return { key, row: rowValue };
  });

  const previousLookup = previousRowLookup(previousRows, identity);
  for (const key of previousLookup.duplicateKeys) duplicateKeys.add(key);

  if (duplicateKeys.size > 0) {
    const reason = `incremental maintenance requires unique materialized row keys: ${Array.from(duplicateKeys).join(', ')}`;
    return { supported: false, reason, diagnostics: [materializationUnsupportedDiagnostic(reason)] };
  }

  const staleRemovedKeys: string[] = [];
  const removedEntries = removedKeyedRows.map(({ key, row }) => {
    const previous = previousLookup.get(key);
    if (previous === undefined || !rowsEqualForDiff(previous.row, row)) staleRemovedKeys.push(key);
    return { key, row, previous: previous?.row, index: previous?.index ?? -1 };
  });

  if (staleRemovedKeys.length > 0) {
    const reason = `incremental maintenance found stale removed materialized row keys: ${[...uniqueStrings(staleRemovedKeys)].sort().join(', ')}`;
    return { supported: false, reason, diagnostics: [materializationUnsupportedDiagnostic(reason)] };
  }

  const retainedCollisionKeys = Array.from(addedByKey.keys())
    .filter((key) => previousLookup.get(key) !== undefined && !removedByKey.has(key))
    .sort();
  if (retainedCollisionKeys.length > 0) {
    const reason = `incremental maintenance cannot add materialized row keys that collide with retained rows: ${retainedCollisionKeys.join(', ')}`;
    return { supported: false, reason, diagnostics: [materializationUnsupportedDiagnostic(reason)] };
  }

  const retainedCount = previousRows.length - removedRows.length;
  const sourceRemovedCount = options.sourceRemovedCount ?? removedRows.length;
  const ambiguousUnsortedPlacement = options.sorted !== true
    && sourceRemovedCount > 0
    && addedRows.length > 0
    && retainedCount > 0
    && (sourceRemovedCount > removedRows.length || removedRows.length !== addedRows.length);
  const sourceOrderKeys = ambiguousUnsortedPlacement && identity.unique && previousRows.length >= SOURCE_ORDER_PLACEMENT_MIN_ROWS
    ? options.sourceOrderKeys?.()
    : undefined;
  if (ambiguousUnsortedPlacement && sourceOrderKeys === undefined) {
    const reason = 'incremental maintenance cannot deterministically place materialized rows added by source updates';
    return { supported: false, reason, diagnostics: [materializationUnsupportedDiagnostic(reason)] };
  }

  const removedIndexes = new Set(removedEntries.map((entry) => entry.index));
  const rowChanges = materializedDeltaRowChanges(removedEntries, addedKeyedRows, removedByKey, addedByKey);
  const added = rowChanges.flatMap((change) => change.kind === 'added' ? [change.row] : []);
  const removed = rowChanges.flatMap((change) => change.kind === 'removed' ? [change.row] : []);

  if (removedRows.length === 0 && addedRows.length === 0) {
    return { supported: true, rows: previousRows, added, removed, rowChanges };
  }

  const sortedRows = (): readonly Row[] | undefined => options.sortPlacement === undefined
    ? undefined
    : incrementalSortedMaterializedRows(previousRows, removedEntries, addedRows, options.sortPlacement);
  const sourceOrderedRows = (): readonly Row[] | undefined => sourceOrderKeys === undefined
    ? undefined
    : incrementalSourceOrderedMaterializedRows(previousRows, removedEntries, addedRows, identity, sourceOrderKeys);

  if (removedRows.length === previousRows.length) {
    return {
      supported: true,
      rows: sortedRows() ?? sourceOrderedRows() ?? addedRows,
      added,
      removed,
      rowChanges
    };
  }

  if (removedRows.length === 0) {
    return {
      supported: true,
      rows: sortedRows() ?? sourceOrderedRows() ?? [...previousRows, ...addedRows],
      added,
      removed,
      rowChanges
    };
  }

  if (removedRows.length === 1 && addedRows.length === 1) {
    const removedEntry = removedEntries[0];
    const addedRow = addedRows[0];
    if (removedEntry !== undefined && addedRow !== undefined) {
      const sorted = sortedRows();
      if (sorted !== undefined) return { supported: true, rows: sorted, added, removed, rowChanges };
      const rows = [...previousRows];
      rows[removedEntry.index] = addedRow;
      return { supported: true, rows, added, removed, rowChanges };
    }
  }

  if (removedRows.length === 1 && addedRows.length === 0) {
    const removedEntry = removedEntries[0];
    if (removedEntry !== undefined) {
      const sorted = sortedRows();
      if (sorted !== undefined) return { supported: true, rows: sorted, added, removed, rowChanges };
      return {
        supported: true,
        rows: [...previousRows.slice(0, removedEntry.index), ...previousRows.slice(removedEntry.index + 1)],
        added,
        removed,
        rowChanges
      };
    }
  }

  if (removedRows.length === addedRows.length) {
    const sorted = sortedRows();
    if (sorted !== undefined) return { supported: true, rows: sorted, added, removed, rowChanges };
    const replacements = new Map<number, Row>();
    removedEntries.forEach((entry, indexValue) => {
      const added = addedRows[indexValue];
      if (added !== undefined) replacements.set(entry.index, added);
    });
    const rows: Row[] = [];
    previousRows.forEach((rowValue, indexValue) => {
      const replacement = replacements.get(indexValue);
      if (replacement !== undefined) {
        rows.push(replacement);
      } else if (!removedIndexes.has(indexValue)) {
        rows.push(rowValue);
      }
    });
    return {
      supported: true,
      rows,
      added,
      removed,
      rowChanges
    };
  }

  const rows = previousRows.filter((_, indexValue) => !removedIndexes.has(indexValue));
  if (addedRows.length > 0) {
    const firstRemovedIndex = Math.min(...removedEntries.map((entry) => entry.index));
    rows.splice(Number.isFinite(firstRemovedIndex) ? Math.min(firstRemovedIndex, rows.length) : rows.length, 0, ...addedRows);
  }
  return { supported: true, rows: sortedRows() ?? sourceOrderedRows() ?? rows, added, removed, rowChanges };
}

function previousRowLookup<Row>(
  rows: readonly Row[],
  identity: MaterializationRowIdentity<Row>
): {
  readonly duplicateKeys: ReadonlySet<string>;
  readonly get: (key: string) => { readonly row: Row; readonly index: number } | undefined;
} {
  if (!identity.unique) {
    const map = new Map<string, { readonly row: Row; readonly index: number }>();
    const duplicateKeys = new Set<string>();
    rows.forEach((rowValue, indexValue) => {
      const key = identity.keyOf(rowValue);
      if (map.has(key)) duplicateKeys.add(key);
      map.set(key, { row: rowValue, index: indexValue });
    });
    return { duplicateKeys, get: (key) => map.get(key) };
  }

  const cache = new Map<string, { readonly row: Row; readonly index: number } | undefined>();
  return {
    duplicateKeys: new Set<string>(),
    get: (key) => {
      if (cache.has(key)) return cache.get(key);
      const entry = findMaterializedRowByKey(rows, identity.keyOf, key);
      cache.set(key, entry);
      return entry;
    }
  };
}

function findMaterializedRowByKey<Row>(
  rows: readonly Row[],
  keyOf: (row: Row) => string,
  key: string
): { readonly row: Row; readonly index: number } | undefined {
  for (let indexValue = 0; indexValue < rows.length; indexValue += 1) {
    const rowValue = rows[indexValue];
    if (rowValue !== undefined && keyOf(rowValue) === key) return { row: rowValue, index: indexValue };
  }
  return undefined;
}

function materializedSourceOrderKeys(target: unknown, relationRef: RelationRef): readonly string[] | undefined {
  const rows = isDb(target)
    ? target.data[relationRef.name] ?? []
    : isRelationSource(target)
      ? target.rows(relationRef)
      : undefined;
  if (rows === undefined) return undefined;
  const paths = relationKeyFields(relationRef).map((fieldName) => [fieldName]);
  return rows.map((rowValue) => rowIdentityKey(rowValue, paths));
}

function incrementalSourceOrderedMaterializedRows<Row>(
  previousRows: readonly Row[],
  removedEntries: readonly { readonly index: number }[],
  addedRows: readonly Row[],
  identity: MaterializationRowIdentity<Row>,
  sourceOrderKeys: readonly string[]
): readonly Row[] {
  if (addedRows.length === 0) {
    const removedIndexes = new Set(removedEntries.map((entry) => entry.index));
    return previousRows.filter((_, indexValue) => !removedIndexes.has(indexValue));
  }

  const sourceIndex = new Map<string, number>();
  sourceOrderKeys.forEach((key, indexValue) => {
    if (!sourceIndex.has(key)) sourceIndex.set(key, indexValue);
  });

  const sourcePosition = (rowValue: Row): number => sourceIndex.get(identity.keyOf(rowValue)) ?? Number.POSITIVE_INFINITY;
  const removedIndexes = new Set(removedEntries.map((entry) => entry.index));
  const rows = previousRows.filter((_, indexValue) => !removedIndexes.has(indexValue));
  const additions = addedRows
    .map((rowValue, ordinal) => ({ row: rowValue, position: sourcePosition(rowValue), ordinal }))
    .sort((left, right) => left.position === right.position ? left.ordinal - right.ordinal : left.position - right.position);

  for (const addition of additions) {
    const insertIndex = rows.findIndex((rowValue) => sourcePosition(rowValue) > addition.position);
    rows.splice(insertIndex === -1 ? rows.length : insertIndex, 0, addition.row);
  }

  return rows;
}

function materializedDeltaRowChanges<Row>(
  removedEntries: readonly {
    readonly key: string;
    readonly row: Row;
    readonly previous: Row | undefined;
    readonly index: number;
  }[],
  addedRows: readonly { readonly key: string; readonly row: Row }[],
  removedByKey: ReadonlyMap<string, Row>,
  addedByKey: ReadonlyMap<string, Row>
): readonly RowChange<Row>[] {
  const existingChanges: { readonly index: number; readonly change: RowChange<Row> }[] = [];
  const consumedAddedKeys = new Set<string>();

  for (const entry of removedEntries) {
    const before = entry.previous ?? entry.row;
    const after = addedByKey.get(entry.key);
    if (after === undefined) {
      existingChanges.push({ index: entry.index, change: { kind: 'removed', row: before, key: entry.key } });
      continue;
    }

    consumedAddedKeys.add(entry.key);
    if (!rowsEqualForDiff(before, after)) {
      existingChanges.push({ index: entry.index, change: { kind: 'updated', before, after, key: entry.key } });
    }
  }

  const addedChanges = addedRows
    .filter((entry) => !removedByKey.has(entry.key) && !consumedAddedKeys.has(entry.key))
    .map((entry): RowChange<Row> => ({ kind: 'added', row: entry.row, key: entry.key }));

  return [
    ...existingChanges
      .sort((left, right) => left.index - right.index)
      .map((entry) => entry.change),
    ...addedChanges
  ];
}

function rowsEqualForDiff<Row>(left: Row, right: Row): boolean {
  return Object.is(left, right) || stableKey(left) === stableKey(right);
}

function addedRowChangeCount<Row>(changes: readonly RowChange<Row>[]): number {
  let count = 0;
  for (const change of changes) {
    if (change.kind === 'added') count += 1;
  }
  return count;
}

function incrementalRowChangeTracker<Row>(
  previousRows: readonly Row[],
  keyOf: (row: Row) => string
): {
  readonly apply: (changes: readonly RowChange<Row>[]) => void;
  readonly changes: (finalRows: readonly Row[]) => readonly RowChange<Row>[];
} {
  type ChangeState = {
    existedBefore: boolean;
    before?: Row;
    after?: Row;
    beforeIndex: number;
    sequence: number;
  };

  const states = new Map<string, ChangeState>();
  const originalCache = new Map<string, { readonly row: Row; readonly index: number } | undefined>();
  let sequence = 0;

  const original = (key: string): { readonly row: Row; readonly index: number } | undefined => {
    if (originalCache.has(key)) return originalCache.get(key);
    const entry = findMaterializedRowByKey(previousRows, keyOf, key);
    originalCache.set(key, entry);
    return entry;
  };

  const apply = (changes: readonly RowChange<Row>[]): void => {
    for (const change of changes) {
      const current = states.get(change.key);

      if (change.kind === 'added') {
        if (current === undefined) {
          states.set(change.key, {
            existedBefore: false,
            after: change.row,
            beforeIndex: Number.POSITIVE_INFINITY,
            sequence: sequence++
          });
        } else {
          current.after = change.row;
        }
        continue;
      }

      if (change.kind === 'removed') {
        if (current === undefined) {
          const entry = original(change.key);
          states.set(change.key, {
            existedBefore: true,
            before: entry?.row ?? change.row,
            beforeIndex: entry?.index ?? Number.POSITIVE_INFINITY,
            sequence: sequence++
          });
        } else if (!current.existedBefore) {
          states.delete(change.key);
        } else {
          delete current.after;
        }
        continue;
      }

      if (current === undefined) {
        const entry = original(change.key);
        states.set(change.key, {
          existedBefore: entry !== undefined,
          before: entry?.row ?? change.before,
          after: change.after,
          beforeIndex: entry?.index ?? Number.POSITIVE_INFINITY,
          sequence: sequence++
        });
      } else {
        current.after = change.after;
      }
    }
  };

  const changes = (finalRows: readonly Row[]): readonly RowChange<Row>[] => {
    const existingChanges: { readonly index: number; readonly change: RowChange<Row> }[] = [];
    const addedStates = new Map<string, ChangeState>();

    for (const [key, state] of states) {
      if (!state.existedBefore) {
        if (state.after !== undefined) addedStates.set(key, state);
        continue;
      }

      if (state.before === undefined) continue;
      if (state.after === undefined) {
        existingChanges.push({ index: state.beforeIndex, change: { kind: 'removed', row: state.before, key } });
      } else if (!rowsEqualForDiff(state.before, state.after)) {
        existingChanges.push({ index: state.beforeIndex, change: { kind: 'updated', before: state.before, after: state.after, key } });
      }
    }

    const addedChanges: RowChange<Row>[] = [];
    if (addedStates.size === 1) {
      const [entry] = addedStates;
      if (entry !== undefined && entry[1].after !== undefined) addedChanges.push({ kind: 'added', row: entry[1].after, key: entry[0] });
    } else if (addedStates.size > 1) {
      for (const rowValue of finalRows) {
        const key = keyOf(rowValue);
        const state = addedStates.get(key);
        if (state?.after === undefined) continue;
        addedChanges.push({ kind: 'added', row: state.after, key });
        addedStates.delete(key);
      }
      addedChanges.push(...Array.from(addedStates, ([key, state]) => ({ key, state }))
        .sort((left, right) => left.state.sequence - right.state.sequence)
        .flatMap(({ key, state }): RowChange<Row>[] => state.after === undefined ? [] : [{ kind: 'added', row: state.after, key }]));
    }

    return [
      ...existingChanges
        .sort((left, right) => left.index - right.index)
        .map((entry) => entry.change),
      ...addedChanges
    ];
  };

  return { apply, changes };
}

function incrementalMaterializedSortPlacement<Row>(
  sortData: QueryData,
  relations: Readonly<Record<string, AnyRelationRef>>,
  options: EvaluateOptions,
  diagnostics: TarstateDiagnostic[]
): IncrementalMaterializedSortPlacement<Row> {
  const order = arrayFromUnknown(sortData.order);
  const source = fromObjectSource({});
  const aliases = uniqueStrings(Object.keys(relations), queryDataAliases(sortData));
  return {
    compare: (left, right) => compareMaterializedSortRows(left, right, order, source, relations, options, diagnostics, aliases)
  };
}

function compareMaterializedSortRows<Row>(
  left: Row,
  right: Row,
  order: readonly unknown[],
  source: RelationSource,
  relations: Readonly<Record<string, AnyRelationRef>>,
  options: EvaluateOptions,
  diagnostics: TarstateDiagnostic[],
  aliases: readonly string[]
): number {
  if (order.length === 0) return 0;
  const leftEntry = entryForMaterializedSortRow(left, aliases);
  const rightEntry = entryForMaterializedSortRow(right, aliases);
  for (const sortInput of order) {
    const sortData = normalizeSortInput(sortInput);
    const leftValue = evaluateExpr(sortData.expr, leftEntry, source, relations, options, diagnostics, undefined);
    const rightValue = evaluateExpr(sortData.expr, rightEntry, source, relations, options, diagnostics, undefined);
    const comparisonValue = compareNullable(leftValue, rightValue, sortData.nulls);
    if (comparisonValue !== 0) return sortData.direction === 'desc' ? -comparisonValue : comparisonValue;
  }
  return 0;
}

function incrementalSortedMaterializedRows<Row>(
  previousRows: readonly Row[],
  removedEntries: readonly { readonly index: number }[],
  addedRows: readonly Row[],
  placement: IncrementalMaterializedSortPlacement<Row>
): readonly Row[] {
  type PositionedRow = { readonly row: Row; readonly ordinal: number };

  const removedIndexes = new Set(removedEntries.map((entry) => entry.index));
  const base: PositionedRow[] = [];
  const insertions: PositionedRow[] = [];
  const pushInsertion = (row: Row, ordinal: number): void => {
    insertions.push({ row, ordinal });
  };

  if (removedEntries.length === previousRows.length) {
    addedRows.forEach((rowValue, indexValue) => pushInsertion(rowValue, indexValue));
    return mergePositionedMaterializedRows(base, insertions, placement);
  }

  if (removedEntries.length === 0) {
    previousRows.forEach((rowValue, indexValue) => base.push({ row: rowValue, ordinal: indexValue }));
    addedRows.forEach((rowValue, indexValue) => pushInsertion(rowValue, previousRows.length + indexValue));
    return mergePositionedMaterializedRows(base, insertions, placement);
  }

  if (removedEntries.length === addedRows.length) {
    const replacements = new Map<number, Row>();
    removedEntries.forEach((entry, indexValue) => {
      const added = addedRows[indexValue];
      if (added !== undefined) replacements.set(entry.index, added);
    });

    let ordinal = 0;
    previousRows.forEach((rowValue, indexValue) => {
      const replacement = replacements.get(indexValue);
      if (replacement !== undefined) {
        pushInsertion(replacement, ordinal);
        ordinal += 1;
      } else if (!removedIndexes.has(indexValue)) {
        base.push({ row: rowValue, ordinal });
        ordinal += 1;
      }
    });
    return mergePositionedMaterializedRows(base, insertions, placement);
  }

  const retainedRows = previousRows.filter((_, indexValue) => !removedIndexes.has(indexValue));
  const firstRemovedIndex = Math.min(...removedEntries.map((entry) => entry.index));
  const insertIndex = Number.isFinite(firstRemovedIndex) ? Math.min(firstRemovedIndex, retainedRows.length) : retainedRows.length;
  let ordinal = 0;
  for (let indexValue = 0; indexValue <= retainedRows.length; indexValue += 1) {
    if (indexValue === insertIndex) {
      for (const rowValue of addedRows) {
        pushInsertion(rowValue, ordinal);
        ordinal += 1;
      }
    }
    const rowValue = retainedRows[indexValue];
    if (rowValue !== undefined) {
      base.push({ row: rowValue, ordinal });
      ordinal += 1;
    }
  }

  return mergePositionedMaterializedRows(base, insertions, placement);
}

function mergePositionedMaterializedRows<Row>(
  base: { readonly row: Row; readonly ordinal: number }[],
  insertions: readonly { readonly row: Row; readonly ordinal: number }[],
  placement: IncrementalMaterializedSortPlacement<Row>
): readonly Row[] {
  if (insertions.length === 0) return base.map((entry) => entry.row);

  for (const insertion of insertions) {
    let low = 0;
    let high = base.length;
    while (low < high) {
      const mid = Math.floor((low + high) / 2);
      const current = base[mid];
      if (current === undefined || comparePositionedMaterializedRows(current, insertion, placement) <= 0) {
        low = mid + 1;
      } else {
        high = mid;
      }
    }
    base.splice(low, 0, insertion);
  }

  return base.map((entry) => entry.row);
}

function comparePositionedMaterializedRows<Row>(
  left: { readonly row: Row; readonly ordinal: number },
  right: { readonly row: Row; readonly ordinal: number },
  placement: IncrementalMaterializedSortPlacement<Row>
): number {
  const comparisonValue = placement.compare(left.row, right.row);
  return comparisonValue === 0 ? left.ordinal - right.ordinal : comparisonValue;
}

function applyIncrementalMaterializedSort<Row>(
  rows: readonly Row[],
  sortData: QueryData | undefined,
  relations: Readonly<Record<string, AnyRelationRef>>,
  options: EvaluateOptions
): MaterializationRefreshResult<Row> {
  if (sortData === undefined) return { rows, diagnostics: [] };
  const diagnostics: TarstateDiagnostic[] = [];
  const source = fromObjectSource({});
  const aliases = uniqueStrings(Object.keys(relations), queryDataAliases(sortData));
  const entries = rows.map((rowValue) => entryForMaterializedSortRow(rowValue, aliases));
  return {
    rows: sortEntries(entries, arrayFromUnknown(sortData.order), source, relations, options, diagnostics, undefined)
      .map((entry) => entry.row as Row),
    diagnostics
  };
}

function entryForMaterializedSortRow(rowValue: unknown, aliases: readonly string[]): EvalEntry {
  const entry = entryForRow(rowValue);
  const aliasValues = Object.fromEntries(aliases.map((alias) => [alias, rowValue]));
  return { row: rowValue, aliases: { ...aliasValues, ...entry.aliases } };
}

function queryDataAliases(data: QueryData): readonly string[] {
  const aliases: string[] = [];
  const visit = (valueValue: unknown): void => {
    const queryData = queryDataFrom(valueValue);
    if (queryData === undefined) return;
    if (typeof queryData.alias === 'string') aliases.push(queryData.alias);
    if (typeof queryData.rightAlias === 'string') aliases.push(queryData.rightAlias);
    for (const item of [queryData.input, queryData.left, queryData.right]) visit(item);
    for (const item of queryDataArray(queryData.inputs)) visit(item);
  };
  visit(data);
  return uniqueStrings(aliases);
}

function trustedIncrementalQueryExpressions(data: QueryData): boolean {
  const nestedTrusted = (): boolean => {
    const input = queryDataFrom(data.input);
    return input !== undefined && trustedIncrementalQueryExpressions(input);
  };

  switch (data.op) {
    case 'from':
    case 'lookup':
      return true;
    case 'where':
      return trustedRowLocalExpr(data.predicate) && nestedTrusted();
    case 'project':
      return trustedProjectionExpressions(data.projection) && nestedTrusted();
    case 'extend':
      return trustedProjectionExpressions(data.projection) && nestedTrusted();
    case 'hash':
    case 'btree':
    case 'uniqueIndex':
      return arrayFromUnknown(data.expressions).every(trustedRowLocalExpr) && nestedTrusted();
    case 'sort':
      return arrayFromUnknown(data.order)
        .every((sortInput) => trustedRowLocalExpr(normalizeSortInput(sortInput).expr))
        && nestedTrusted();
    case 'aggregate':
      return trustedProjectionExpressions(data.groupBy)
        && supportedIncrementalAggregateProjection(data.aggregates).supported
        && nestedTrusted();
    case 'join': {
      if (data.kind !== 'inner' || isPredicateData(data.on) || equiJoinClauseMapFrom(data.on) === undefined) return false;
      const left = queryDataFrom(data.left);
      const right = queryDataFrom(data.right);
      return left !== undefined
        && right !== undefined
        && (left.op === 'from' || left.op === 'lookup')
        && (right.op === 'from' || right.op === 'lookup');
    }
    case 'without':
    case 'rename':
    case 'qualify':
    case 'keyBy':
      return nestedTrusted();
    default:
      return false;
  }
}

function trustedProjectionExpressions(input: unknown): boolean {
  return Object.values(projectionFrom(input)).every(trustedRowLocalExpr);
}

function trustedRowLocalExpr(input: unknown): boolean {
  const data = exprFrom(unwrapOptionalProjection(input));
  switch (data.op) {
    case 'value':
    case 'field':
    case 'env':
    case 'self':
      return true;
    case 'maybe':
      return trustedRowLocalExpr(data.expr);
    case 'tuple':
      return arrayFromUnknown(data.values).every(trustedRowLocalExpr);
    case 'eq':
    case 'neq':
    case 'lt':
    case 'lte':
    case 'gt':
    case 'gte':
      return trustedRowLocalExpr(data.left) && trustedRowLocalExpr(data.right);
    case 'and':
    case 'or':
      return arrayFromUnknown(data.predicates).every(trustedRowLocalExpr);
    case 'not':
      return trustedRowLocalExpr(data.predicate);
    case 'isNull':
    case 'notNull':
    case 'isMissing':
    case 'notMissing':
      return trustedRowLocalExpr(data.expr);
    default:
      return false;
  }
}

function finalSortEvaluableFromFinalRow(sortData: QueryData, relations: Readonly<Record<string, AnyRelationRef>>): boolean {
  const input = queryDataFrom(sortData.input);
  if (input === undefined) return false;
  const finalRowFields = finalRowFieldExpressions(input, relations);
  if (finalRowFields.size === 0) return false;
  return arrayFromUnknown(sortData.order)
    .every((sortInput) => finalRowExprEvaluableFromFields(normalizeSortInput(sortInput).expr, finalRowFields));
}

function finalSortIncludesMaterializedIdentity<Row>(
  sortData: QueryData,
  relations: Readonly<Record<string, AnyRelationRef>>,
  identity: MaterializationRowIdentity<Row>
): boolean {
  if (!identity.unique || identity.fields === undefined) return false;
  const input = queryDataFrom(sortData.input);
  if (input === undefined) return false;
  const finalRowFields = finalRowFieldExpressions(input, relations);
  if (finalRowFields.size === 0) return false;
  const sortedFields = new Set(arrayFromUnknown(sortData.order)
    .flatMap((sortInput) => {
      const fieldName = finalRowFieldNameForExpr(normalizeSortInput(sortInput).expr, finalRowFields);
      return fieldName === undefined ? [] : [fieldName];
    }));
  return identity.fields.every((fieldName) => sortedFields.has(fieldName));
}

function finalRowFieldNameForExpr(input: unknown, finalRowFields: ReadonlyMap<string, ExprData>): string | undefined {
  const data = exprFrom(unwrapOptionalProjection(input));
  if (data.op !== 'field') return undefined;
  const fieldName = typeof data.field === 'string' ? data.field : undefined;
  if (fieldName === undefined) return undefined;
  const alias = typeof data.alias === 'string' ? data.alias : 'row';
  if (alias === 'row') return finalRowFields.has(fieldName) ? fieldName : undefined;
  const finalExpr = finalRowFields.get(fieldName);
  return finalExpr !== undefined && stableKey(finalExpr) === stableKey(data) ? fieldName : undefined;
}

function finalRowExprEvaluableFromFields(input: unknown, finalRowFields: ReadonlyMap<string, ExprData>): boolean {
  if (!trustedRowLocalExpr(input)) return false;
  const data = exprFrom(unwrapOptionalProjection(input));
  switch (data.op) {
    case 'value':
    case 'env':
      return true;
    case 'field': {
      const fieldName = typeof data.field === 'string' ? data.field : undefined;
      if (fieldName === undefined) return false;
      const alias = typeof data.alias === 'string' ? data.alias : 'row';
      if (alias === 'row') return finalRowFields.has(fieldName);
      const finalExpr = finalRowFields.get(fieldName);
      return finalExpr !== undefined && stableKey(finalExpr) === stableKey(data);
    }
    case 'maybe':
      return finalRowExprEvaluableFromFields(data.expr, finalRowFields);
    case 'tuple':
      return arrayFromUnknown(data.values).every((item) => finalRowExprEvaluableFromFields(item, finalRowFields));
    case 'eq':
    case 'neq':
    case 'lt':
    case 'lte':
    case 'gt':
    case 'gte':
      return finalRowExprEvaluableFromFields(data.left, finalRowFields)
        && finalRowExprEvaluableFromFields(data.right, finalRowFields);
    case 'and':
    case 'or':
      return arrayFromUnknown(data.predicates).every((item) => finalRowExprEvaluableFromFields(item, finalRowFields));
    case 'not':
      return finalRowExprEvaluableFromFields(data.predicate, finalRowFields);
    case 'isNull':
    case 'notNull':
    case 'isMissing':
    case 'notMissing':
      return finalRowExprEvaluableFromFields(data.expr, finalRowFields);
    default:
      return false;
  }
}

function finalRowFieldExpressions(data: QueryData, relations: Readonly<Record<string, AnyRelationRef>>): ReadonlyMap<string, ExprData> {
  switch (data.op) {
    case 'from':
    case 'lookup': {
      const relationName = typeof data.relation === 'string' ? data.relation : undefined;
      const relationRef = relationName === undefined ? undefined : relations[relationName];
      if (!isRelationRef(relationRef)) return new Map();
      const alias = typeof data.alias === 'string' ? data.alias : relationRef.name;
      return new Map(relationFieldNames(relationRef).map((fieldName) => [fieldName, field(alias, fieldName)]));
    }
    case 'join': {
      const leftData = queryDataFrom(data.left);
      const rightData = queryDataFrom(data.right);
      const left = leftData === undefined ? undefined : directIncrementalJoinSide('left', leftData, relations);
      const right = rightData === undefined ? undefined : directIncrementalJoinSide('right', rightData, relations);
      if (left === undefined || right === undefined) return new Map();
      const rightFieldNames = new Set(relationFieldNames(right.relation));
      const fields = new Map<string, ExprData>();
      for (const fieldName of relationFieldNames(left.relation)) {
        if (!rightFieldNames.has(fieldName)) fields.set(fieldName, field(left.alias, fieldName));
      }
      for (const fieldName of relationFieldNames(right.relation)) fields.set(fieldName, field(right.alias, fieldName));
      return fields;
    }
    case 'aggregate': {
      const fields = new Map<string, ExprData>();
      for (const fieldName of uniqueStrings(projectionFieldNames(data.groupBy), projectionFieldNames(data.aggregates))) {
        fields.set(fieldName, field('row', fieldName));
      }
      return fields;
    }
    case 'where':
    case 'hash':
    case 'btree':
    case 'uniqueIndex':
    case 'keyBy':
    case 'sort':
      return nestedFinalRowFieldExpressions(data, relations);
    case 'project':
      return projectionFieldExpressions(projectionFrom(data.projection));
    case 'extend': {
      const fields = new Map(nestedFinalRowFieldExpressions(data, relations));
      for (const [fieldName, exprData] of projectionFieldExpressions(projectionFrom(data.projection))) fields.set(fieldName, exprData);
      return fields;
    }
    case 'without': {
      const fields = new Map(nestedFinalRowFieldExpressions(data, relations));
      for (const fieldName of stringArray(data.fields)) fields.delete(fieldName);
      return fields;
    }
    case 'rename': {
      const fields = isRecord(data.fields) ? data.fields : {};
      return new Map(Array.from(nestedFinalRowFieldExpressions(data, relations), ([fieldName, exprData]) => {
        const renamed = fields[fieldName];
        return [typeof renamed === 'string' ? renamed : fieldName, exprData];
      }));
    }
    case 'qualify': {
      const alias = typeof data.alias === 'string' ? data.alias : 'row';
      return new Map([[alias, { op: 'self' } as ExprData]]);
    }
    default:
      return new Map();
  }
}

function nestedFinalRowFieldExpressions(data: QueryData, relations: Readonly<Record<string, AnyRelationRef>>): ReadonlyMap<string, ExprData> {
  const input = queryDataFrom(data.input);
  return input === undefined ? new Map() : finalRowFieldExpressions(input, relations);
}

function projectionFieldExpressions(projection: ProjectionData): ReadonlyMap<string, ExprData> {
  const fields = new Map<string, ExprData>();
  for (const [fieldName, projectionExpr] of Object.entries(projection)) {
    const exprData = unwrapOptionalProjection(projectionExpr);
    if (isExpr(exprData)) fields.set(fieldName, exprData);
  }
  return fields;
}

function containsIncrementalSubquery(input: unknown): boolean {
  if (!isRecord(input)) return false;
  if (input.op === 'sel' || input.op === 'sel1' || 'correlation' in input) return true;
  return Object.values(input).some((valueValue) => {
    if (Array.isArray(valueValue)) return valueValue.some(containsIncrementalSubquery);
    return containsIncrementalSubquery(valueValue);
  });
}

export const explainMaterialization = <Row>(query: Query<Row>): MaterializationExplanation<Row> => {
  const incremental = incrementalMaterializationSupport(query);
  return {
    query,
    supported: incremental.supported,
    update: incremental.supported ? 'incremental' : 'recomputed',
    recomputed: !incremental.supported,
    reason: incremental.reason,
    diagnostics: incremental.supported ? [] : incremental.diagnostics
  };
};
export type MemoryRelationRuntimeOptions = { readonly relationNames?: readonly string[] };
export function createMemoryRelationRuntime(data: DbInputData = {}, options: MemoryRelationRuntimeOptions = {}): RelationRuntime<number> {
  let dbValue = createDb(data);
  let version = 0;
  const listeners = new Set<() => void>();
  const relationNames = options.relationNames ?? Object.keys(data);
  const source = (): AdapterSource<number> => ({
    ...fromObjectSource(dbValue.data),
    relationNames,
    version: () => version
  });
  const notify = (): void => {
    for (const listener of listeners) listener();
  };

  return {
    source: {
      relationNames,
      rows: (relationRef) => dbValue.data[relationRef.name] ?? [],
      lookup: (lookupValue) => fromObjectSource(dbValue.data).lookup?.(lookupValue),
      rangeLookup: (lookupValue) => fromObjectSource(dbValue.data).rangeLookup?.(lookupValue),
      version: () => version
    },
    target: {
      relationNames,
      apply: (patches) => {
        const patchList = Array.from(patches);
        let nextDb = dbValue;
        let applied = 0;
        const diagnostics: TarstateDiagnostic[] = [];
        const deltas: RelationDelta[] = [];

        for (const patch of patchList) {
          const result = applyWritePatchToDb(nextDb, patch);
          diagnostics.push(...result.diagnostics);
          if (result.diagnostics.some(isErrorDiagnostic)) {
            return { status: 'rejected', patches: patchList.length, applied: 0, deltas: [], diagnostics, version };
          }
          nextDb = result.db;
          applied += result.applied;
          deltas.push(...result.deltas);
        }

        dbValue = nextDb;
        version += 1;
        notify();

        return {
          status: 'accepted',
          patches: patchList.length,
          applied,
          deltas,
          diagnostics,
          version,
          durability: 'memory'
        };
      }
    },
    snapshot: () => ({ source: source(), version }),
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    }
  };
}

export type StoreSnapshot<Version = unknown> = {
  readonly db: Db;
  readonly source: RelationSource;
  readonly revision: number;
  readonly diagnostics: readonly TarstateDiagnostic[];
  readonly version?: Version;
};
export type StoreQueryResult<Row = unknown> = QueryResult<Row> & { readonly revision: number };
export type StoreQueryBatchResult<Queries extends QueryBatch> = { readonly [Key in keyof Queries]: StoreQueryResult<QueryBatchTargetRow<Queries[Key]>> };
export type StoreMappedQueryBatchResult<Queries extends QueryBatch, MappedRow> = { readonly [Key in keyof Queries]: StoreQueryResult<MappedRow> };
export type StoreCommitStatus = RelationApplyStatus;
export type StoreCommitEffects<Version = unknown> = {
  readonly patches: number;
  readonly applied: number;
  readonly deltas: readonly RelationDelta[];
  readonly diagnostics: readonly TarstateDiagnostic[];
  readonly version?: Version;
  readonly durability?: RelationApplyDurability;
};
export type StoreCommitSnapshot<Version = unknown> = StoreSnapshot<Version>;
export type StoreCommitResult<Version = unknown> = {
  readonly status: StoreCommitStatus;
  readonly reflected: boolean;
  readonly effects: StoreCommitEffects<Version>;
  readonly snapshot: StoreCommitSnapshot<Version>;
  readonly diagnostics: readonly TarstateDiagnostic[];
};
export type StoreCommitInput = DbTransactionInput;
export type StoreCommitOptions = DbTransactionOptions;
export type StoreCommit<Version = unknown> = {
  (inputs: DbTransactionInputs, options?: StoreCommitOptions): Promise<StoreCommitResult<Version>>;
  (input: DbTransactionInput, options?: StoreCommitOptions): Promise<StoreCommitResult<Version>>;
};
export type StoreQueryOptions<Row = unknown, MappedRow = Row> = DbQueryOptions<Row, MappedRow>;
export type StoreViewSnapshot<Row = unknown, Version = unknown> = {
  readonly rows: readonly Row[];
  readonly diagnostics: readonly TarstateDiagnostic[];
  readonly revision: number;
  readonly queryKey: string;
  readonly version?: Version;
};
export type StoreQuery = <Row>(query: Query<Row> | RelationRef, options?: StoreQueryOptions<Row>) => StoreQueryResult<Row>;
export type StoreQueries = <Queries extends QueryBatch>(queries: Queries, options?: StoreQueryOptions) => StoreQueryBatchResult<Queries>;
export type StoreWhatIf = {
  <Queries extends QueryBatch>(query: Queries, ...inputs: DbTransactionInputs): StoreQueryBatchResult<Queries>;
  <Row>(query: Query<Row> | RelationRef, ...inputs: DbTransactionInputs): StoreQueryResult<Row>;
};
export type StoreView<Row = unknown, Version = unknown> = {
  readonly query: Query<Row>;
  readonly queryKey: string;
  readonly getSnapshot: () => StoreViewSnapshot<Row, Version>;
  readonly subscribe: (listener: () => void) => () => void;
  readonly refresh: () => Promise<StoreViewSnapshot<Row, Version>>;
};
export type Store<Version = unknown> = {
  readonly getSnapshot: () => StoreSnapshot<Version>;
  readonly subscribe: (listener: () => void) => () => void;
  readonly query: StoreQuery;
  readonly queries: StoreQueries;
  readonly whatIf: StoreWhatIf;
  readonly view: <Row>(query: Query<Row>) => StoreView<Row, Version>;
  readonly commit: StoreCommit<Version>;
  readonly refresh: () => Promise<StoreSnapshot<Version>>;
  readonly close: () => void;
};
export type StoreSeedInput = Db | DbInputData;
export type StoreRuntimeInput<Version = unknown> = TarstateDiagnosticOptions & {
  readonly runtime: RelationRuntime<Version>;
  readonly relations: readonly RelationRef[];
  readonly env?: DbInputEnv;
};

export function createStore(input: StoreSeedInput = createDb()): Store {
  const state = isDb(input) ? input : createDb(input);
  return createDbBackedStore(state);
}
export function createRuntimeStore<Version>(input: StoreRuntimeInput<Version>): Store<Version> {
  return createRuntimeBackedStore(input);
}

export type WatchDb = Db | RelationSource;
export type WatchDiagnostic = TarstateDiagnostic & { readonly surface?: 'watch' | 'changeTracking' };
export type WatchRuntimeDiagnostic<Row = unknown> = WatchDiagnostic | RowDiffDiagnostic<Row>;
export type ChangeSet = { readonly deltas?: readonly RelationDelta[]; readonly diagnostics: readonly WatchDiagnostic[] };
export type WatchTarget<Row = unknown> = Query<Row> | RelationRef;
export type WatchEvent<Row = unknown> = {
  readonly id: string;
  readonly targetKey: string;
  readonly target: WatchTarget<Row>;
  readonly changed: boolean;
  readonly previousRows: readonly Row[];
  readonly rows: readonly Row[];
  readonly added: readonly Row[];
  readonly removed: readonly Row[];
  readonly unchanged: readonly Row[];
  readonly rowChanges: readonly RowChange<Row>[];
  readonly changes: ChangeSet;
  readonly diagnostics: readonly WatchRuntimeDiagnostic<Row>[];
};
export type WatchListener<Row = unknown> = (event: WatchEvent<Row>) => void | Promise<void>;
export type WatchOptions<Row = unknown> = EvaluateOptions & RowDiffOptions<Row> & { readonly label?: string; readonly immediate?: boolean };
export type WatchRefreshResult<Row = unknown> = Omit<WatchEvent<Row>, 'changes'> & { readonly delivered: boolean };
export type WatchUnsubscribeResult = { readonly id: string; readonly unsubscribed: boolean; readonly diagnostics: readonly WatchDiagnostic[] };
export type WatchSubscription = { readonly id: string; readonly active: boolean; readonly diagnostics: readonly WatchDiagnostic[]; readonly unsubscribe: () => WatchUnsubscribeResult };
export type WatchHandle<DbValue extends WatchDb = WatchDb, Row = unknown> = {
  readonly id: string;
  readonly db: DbValue;
  readonly target: WatchTarget<Row>;
  readonly supported: boolean;
  readonly mode: 'db';
  readonly diagnostics: readonly WatchDiagnostic[];
  readonly refresh: (nextDb?: DbValue | RelationSource) => Promise<WatchRefreshResult<Row>>;
  readonly unwatch: () => UnwatchResult;
  readonly label?: string;
};
export type RuntimeWatchHandle<Row = unknown> = WatchHandle<RelationSource, Row>;
export type WatchTargetRegistration<DbValue extends WatchDb = WatchDb, Row = unknown> = {
  readonly db: DbValue;
  readonly target: WatchTarget<Row>;
  readonly handle: WatchHandle<DbValue, Row>;
  readonly supported: boolean;
  readonly diagnostics: readonly WatchDiagnostic[];
  readonly unwatch: () => UnwatchResult;
  readonly label?: string;
};
export type UnwatchResult = { readonly id: string; readonly closed: boolean; readonly diagnostics: readonly WatchDiagnostic[] };
export type TrackedChange<Row = unknown> = Omit<WatchEvent<Row>, 'changes'>;
export type WatchTargetChange<Row = unknown> = Pick<TrackedChange<Row>, 'id' | 'targetKey' | 'target' | 'changed' | 'added' | 'removed' | 'unchanged' | 'rowChanges' | 'diagnostics'>;
export type WatchChangeMap<Row = unknown> = ReadonlyMap<WatchTarget<Row>, WatchTargetChange<Row>>;
export type WatchChangeKeyMap<Row = unknown> = ReadonlyMap<string, WatchTargetChange<Row>>;
export type QueryDiffOptions<Row = unknown> = EvaluateOptions & RowDiffOptions<Row>;
export type QueryDiffDiagnostic<Row = unknown> = TarstateDiagnostic | RowDiffDiagnostic<Row>;
export type QueryDiff<Row = unknown> = {
  readonly target: Query<Row>;
  readonly queryKey: string;
  readonly beforeRows: readonly Row[];
  readonly afterRows: readonly Row[];
  readonly changed: boolean;
  readonly added: readonly Row[];
  readonly removed: readonly Row[];
  readonly unchanged: readonly Row[];
  readonly rowChanges: readonly RowChange<Row>[];
  readonly diagnostics: readonly QueryDiffDiagnostic<Row>[];
};

export function attachWatches<DbValue extends Db>(dbValue: DbValue, ...targets: readonly WatchTarget[]): DbValue {
  return withAttachedWatchTargets(dbValue, uniqueWatchTargets([...attachedWatchTargetsFor(dbValue), ...targets]));
}
export function watch<DbValue extends WatchDb, Row>(dbValue: DbValue, target: WatchTarget<Row>, listener: WatchListener<Row>, options: WatchOptions<Row> = {}): WatchHandle<DbValue, Row> {
  const handle = createWatchHandle(dbValue, target, options);
  subscribeWatch(handle, listener);
  if (options.immediate === true) void handle.refresh(dbValue);
  return handle;
}
export const watchTarget = <DbValue extends WatchDb, Row>(dbValue: DbValue, target: WatchTarget<Row>, options: WatchOptions<Row> = {}): WatchTargetRegistration<DbValue, Row> => {
  const handle = createWatchHandle(dbValue, target, options);
  return { db: dbValue, target, handle, supported: true, diagnostics: [], unwatch: handle.unwatch };
};
export const unwatchTarget = (registration: Pick<WatchTargetRegistration, 'handle'> | Pick<WatchHandle, 'id'>): UnwatchResult =>
  'handle' in registration ? registration.handle.unwatch() : unwatch(registration);
export const watchChangeMap = <Row>(changes: Iterable<TrackedChange<Row>>): WatchChangeMap<Row> =>
  new Map(Array.from(changes, (change) => [change.target, change as WatchTargetChange<Row>]));
export const watchChangeKeyMap = <Row>(changes: Iterable<TrackedChange<Row>>): WatchChangeKeyMap<Row> =>
  new Map(Array.from(changes, (change) => [change.targetKey, change as WatchTargetChange<Row>]));
export const watchTargetKey = (target: WatchTarget): string => isQuery(target) ? queryKey(target) : `relation:${target.name}`;
export const isWatchMaterialization = (input: unknown): input is MaterializationMetadata | MaterializationMaintenanceChange =>
  isMaterializationMetadata(input) || isMaterializationMaintenanceChange(input);
export const watchRuntime = <Version, Row>(runtime: RelationRuntime<Version>, target: WatchTarget<Row>, listener: WatchListener<Row>, options: WatchOptions<Row> = {}): RuntimeWatchHandle<Row> => {
  const source = runtime.snapshot?.().source ?? runtime.source;
  const handle = watch(source, target, listener, options) as RuntimeWatchHandle<Row>;
  const runtimeUnsubscribe = runtime.subscribe?.(() => {
    void handle.refresh(runtime.snapshot?.().source ?? runtime.source);
  });

  return {
    ...handle,
    unwatch: () => {
      runtimeUnsubscribe?.();
      return handle.unwatch();
    }
  };
};
export const unwatch = (handle: Pick<WatchHandle, 'id'>): UnwatchResult => {
  const state = WATCH_STATES.get(handle.id);
  if (state === undefined) return { id: handle.id, closed: false, diagnostics: [] };
  state.active = false;
  state.listeners.clear();
  WATCH_STATES.delete(handle.id);
  return { id: handle.id, closed: true, diagnostics: [] };
};
export const subscribeWatch = <Row>(handle: Pick<WatchHandle<WatchDb, Row>, 'id' | 'supported' | 'target'>, listener: WatchListener<Row>): WatchSubscription => {
  const state = WATCH_STATES.get(handle.id);
  if (state === undefined || !handle.supported) {
    return {
      id: handle.id,
      active: false,
      diagnostics: [watchDiagnostic('subscribeWatch')],
      unsubscribe: () => ({ id: handle.id, unsubscribed: false, diagnostics: [] })
    };
  }

  state.listeners.add(listener as WatchListener<unknown>);
  let active = true;
  return {
    id: handle.id,
    active,
    diagnostics: [],
    unsubscribe: () => {
      if (!active) return { id: handle.id, unsubscribed: false, diagnostics: [] };
      active = false;
      state.listeners.delete(listener as WatchListener<unknown>);
      return { id: handle.id, unsubscribed: true, diagnostics: [] };
    }
  };
};
export async function diffQuery<Row>(before: WatchDb, after: WatchDb, target: Query<Row>, options: QueryDiffOptions<Row> = {}): Promise<QueryDiff<Row>> {
  const beforeResult = readWatchTargetRows(before, target, options);
  const afterResult = readWatchTargetRows(after, target, options);
  const diff = diffRows(beforeResult.rows, afterResult.rows, options);
  const added = diff.changes.flatMap((change) => change.kind === 'added' ? [change.row] : []);
  const removed = diff.changes.flatMap((change) => change.kind === 'removed' ? [change.row] : []);
  const changedKeys = new Set(diff.changes.map((change) => change.key));
  const unchanged = afterResult.rows.filter((rowValue) => !changedKeys.has(rowDiffKey(rowValue, options)));

  return {
    target,
    queryKey: queryKey(target),
    beforeRows: beforeResult.rows,
    afterRows: afterResult.rows,
    changed: diff.changes.length > 0,
    added,
    removed,
    unchanged,
    rowChanges: diff.changes,
    diagnostics: [...beforeResult.diagnostics, ...afterResult.diagnostics, ...diff.diagnostics]
  };
}
export const diffOptionsForTarget = <Row>(_target: WatchTarget<Row>, options: WatchOptions<Row>): RowDiffOptions<Row> => options;
export const transferWatches = <DbValue extends Db>(from: Db, to: DbValue): DbValue =>
  withAttachedWatchTargets(to, uniqueWatchTargets([...attachedWatchTargetsFor(to), ...attachedWatchTargetsFor(from)]));
export async function trackedChangesForDbTransition<DbValue extends WatchDb = WatchDb>(
  before?: DbValue,
  after?: DbValue,
  targets: readonly WatchTarget[] = []
): Promise<{ readonly changes: readonly TrackedChange[]; readonly diagnostics: readonly WatchRuntimeDiagnostic[] }> {
  if (before === undefined || after === undefined) return { changes: [], diagnostics: [] };
  const changes: TrackedChange[] = [];
  const diagnostics: WatchRuntimeDiagnostic[] = [];
  const effectiveTargets = targets.length > 0
    ? targets
    : uniqueWatchTargets([...attachedWatchTargetsFor(before), ...materializationsFor(before).map((item) => item.query)]);

  for (const target of effectiveTargets) {
    const queryTarget = queryForTarget(target);
    const diff = await diffQuery(before, after, queryTarget);
    diagnostics.push(...diff.diagnostics);
    changes.push({
      id: watchTargetKey(target),
      targetKey: diff.queryKey,
      target,
      changed: diff.changed,
      previousRows: diff.beforeRows,
      rows: diff.afterRows,
      added: diff.added,
      removed: diff.removed,
      unchanged: diff.unchanged,
      rowChanges: diff.rowChanges,
      diagnostics: diff.diagnostics
    });
  }

  return { changes, diagnostics };
}
export const trackedChangeFromMaterializationChange = <Row>(change: MaterializationMaintenanceChange<Row>): TrackedChange<Row> =>
  ({ id: change.id, targetKey: change.queryKey, target: change.query, changed: change.rowChanges.length > 0, previousRows: change.previousRows ?? [], rows: change.rows, added: change.added, removed: change.removed, unchanged: [], rowChanges: change.rowChanges, diagnostics: change.diagnostics });

export type TrackTransactDiagnostic = WatchRuntimeDiagnostic | TarstateDiagnostic;
export type TrackRuntimeCommitDiagnostic = TrackTransactDiagnostic;
export type TrackTransactOutput<DbValue extends WatchDb = WatchDb> = DbValue | { readonly db: DbValue };
export type TrackTransactCallback<DbValue extends WatchDb, Result extends TrackTransactOutput<DbValue>> = (db: DbValue) => Result | Promise<Result>;
export type TrackTransactOptions = { readonly label?: string; readonly mode?: 'transaction' | 'callback'; readonly throwOnUnsupported?: boolean };
export type TrackTransactChangeView<Row = unknown> = {
  readonly targetKey: string;
  readonly target: WatchTarget<Row>;
  readonly added: readonly Row[];
  readonly removed: readonly Row[];
  readonly unchanged: readonly Row[];
  readonly rowChanges: readonly RowChange<Row>[];
};
export type TrackTransactQueryChanges<Row = unknown> = Readonly<Record<string, TrackTransactChangeView<Row>>>;
export type TrackRuntimeCommitOptions = TrackTransactOptions & RelationApplyOptions;
export type TrackTransactResult<DbValue extends WatchDb = WatchDb> = {
  readonly db: DbValue;
  readonly result?: DbTransactionResult;
  readonly supported: boolean;
  readonly changes: readonly TrackedChange[];
  readonly changeMap: WatchChangeMap;
  readonly changesByTarget: WatchChangeMap;
  readonly changesByTargetKey: WatchChangeKeyMap;
  readonly changesByQueryKey: TrackTransactQueryChanges;
  readonly deltas: readonly RelationDelta[];
  readonly materializations?: MaterializationMaintenanceResult;
  readonly diagnostics: readonly TrackTransactDiagnostic[];
  readonly label?: string;
};
export type TrackRuntimeCommitStatus = RelationApplyStatus;
export type TrackRuntimeCommitSupportedResult<Version = unknown> = {
  readonly runtime: RelationRuntime<Version>;
  readonly source: AdapterSource<Version>;
  readonly supported: true;
  readonly status: TrackRuntimeCommitStatus;
  readonly patches: number;
  readonly applied: number;
  readonly changes: readonly TrackedChange[];
  readonly changeMap: WatchChangeMap;
  readonly changesByTarget: WatchChangeMap;
  readonly changesByTargetKey: WatchChangeKeyMap;
  readonly deltas: readonly RelationDelta[];
  readonly diagnostics: readonly TrackRuntimeCommitDiagnostic[];
  readonly version?: Version;
  readonly durability?: RelationApplyDurability;
  readonly label?: string;
};
export type TrackRuntimeCommitUnsupportedResult<Version = unknown> = Omit<TrackRuntimeCommitSupportedResult<Version>, 'runtime' | 'source' | 'supported' | 'applied' | 'changes' | 'deltas'> & {
  readonly runtime: unknown;
  readonly source?: AdapterSource<Version>;
  readonly supported: false;
  readonly applied: 0;
  readonly changes: readonly [];
  readonly deltas: readonly [];
};
export type TrackRuntimeCommitResult<Version = unknown> = TrackRuntimeCommitSupportedResult<Version> | TrackRuntimeCommitUnsupportedResult<Version>;

export class UnsupportedChangeTrackingError extends Error {
  readonly code = 'change_tracking_unsupported';
}

export async function trackTransact<DbValue extends WatchDb>(dbValue: DbValue, ...inputs: readonly unknown[]): Promise<TrackTransactResult<DbValue>> {
  const options = trackOptionsFromInputs(inputs);
  if (!isDb(dbValue)) {
    if (options.throwOnUnsupported === true) throw new UnsupportedChangeTrackingError('change tracking requires a Db input');
    return unsupportedTrackTransactResult(dbValue, options);
  }

  const transactionInputs = inputs.filter((input): input is DbTransactionInput => !isTrackTransactOptions(input));
  const result = transactionInputs.length === 1 && typeof transactionInputs[0] === 'function'
    ? tryTransact(dbValue, transactionInputs[0])
    : tryTransact(dbValue, ...(transactionInputs as DbTransactionInputs));
  const nextDb = result.committed ? result.db : dbValue;
  const tracked = await trackedChangesForDbTransition(dbValue, nextDb);

  return {
    db: nextDb as DbValue,
    result,
    supported: true,
    changes: tracked.changes,
    changeMap: watchChangeMap(tracked.changes),
    changesByTarget: watchChangeMap(tracked.changes),
    changesByTargetKey: watchChangeKeyMap(tracked.changes),
    changesByQueryKey: Object.fromEntries(tracked.changes.map((change) => [change.targetKey, toTrackChangeView(change)])),
    deltas: result.deltas,
    ...(result.materializations === undefined ? {} : { materializations: result.materializations }),
    diagnostics: [...result.diagnostics, ...tracked.diagnostics],
    ...(options.label === undefined ? {} : { label: options.label })
  };
}
export async function trackRuntimeCommit<Version>(runtime: RelationRuntime<Version>, patches: Iterable<WritePatch>, options: TrackRuntimeCommitOptions = {}): Promise<TrackRuntimeCommitResult<Version>> {
  if (runtime.target === undefined) {
    if (options.throwOnUnsupported === true) throw new UnsupportedChangeTrackingError('runtime does not expose a writable target');
    return {
      runtime,
      source: runtime.source,
      supported: false,
      status: 'rejected',
      patches: 0,
      applied: 0,
      changes: [],
      changeMap: new Map(),
      changesByTarget: new Map(),
      changesByTargetKey: new Map(),
      deltas: [],
      diagnostics: [{
        code: 'change_tracking_unsupported',
        severity: 'error',
        message: 'runtime does not expose a writable target',
        surface: 'trackRuntimeCommit'
      }],
      ...(options.label === undefined ? {} : { label: options.label })
    };
  }

  const beforeSource = runtime.snapshot?.().source ?? runtime.source;
  const report = await tryApplyRelationPatches(runtime, patches, options);
  const afterSource = report.source;
  const relationTargets = relationDeltaNames(report.deltas)
    .map((name) => relationFromSourceName(name))
    .filter((relationRef): relationRef is RelationRef => relationRef !== undefined);
  const tracked = await trackedChangesForDbTransition(beforeSource, afterSource, relationTargets);

  return {
    runtime,
    source: afterSource,
    supported: true,
    status: report.status,
    patches: report.patches,
    applied: report.applied,
    changes: tracked.changes,
    changeMap: watchChangeMap(tracked.changes),
    changesByTarget: watchChangeMap(tracked.changes),
    changesByTargetKey: watchChangeKeyMap(tracked.changes),
    deltas: report.deltas,
    diagnostics: [...report.diagnostics, ...tracked.diagnostics],
    ...(report.version === undefined ? {} : { version: report.version }),
    ...(report.durability === undefined ? {} : { durability: report.durability }),
    ...(options.label === undefined ? {} : { label: options.label })
  };
}

function createDbBackedStore<Version = unknown>(initialState: Db): Store<Version> {
  let state = initialState;
  let revision = 0;
  let closed = false;
  const listeners = new Set<() => void>();
  const snapshot = (): StoreSnapshot<Version> => ({ db: state, source: dbSource(state), revision, diagnostics: [] });
  const notify = (): void => {
    if (closed) return;
    for (const listener of listeners) listener();
  };

  return {
    getSnapshot: snapshot,
    subscribe: (listener) => {
      if (closed) return () => {};
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    query: (queryValue, options) => ({ ...qResult(state, queryValue, options), revision }),
    queries: (queries, options) => addRevisionToBatch(qManyResult(state, queries, options), revision),
    whatIf: ((queryValue: Query<unknown> | RelationRef | QueryBatch, ...inputs: DbTransactionInputs) => {
      if (isQueryBatch(queryValue)) return addRevisionToBatch(whatIf(state, queryValue, ...inputs), revision);
      return { ...whatIf(state, queryValue, ...inputs), revision };
    }) as StoreWhatIf,
    view: (queryValue) => createStoreView(queryValue, snapshot, (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    }),
    commit: async (inputOrInputs, _options = {}) => {
      if (closed) {
        const closedSnapshot = snapshot();
        const diagnostics: readonly TarstateDiagnostic[] = [{
          code: 'runtime_unsupported',
          severity: 'error',
          message: 'store is closed',
          surface: 'store.commit'
        }];
        return {
          status: 'rejected',
          reflected: false,
          effects: { patches: 0, applied: 0, deltas: [], diagnostics },
          snapshot: closedSnapshot,
          diagnostics
        };
      }

      const result = tryTransact(state, ...normalizeTransactionInputs(inputOrInputs));
      if (result.committed) {
        state = result.db;
        revision += 1;
        notify();
      }

      return {
        status: result.committed ? 'accepted' : 'rejected',
        reflected: result.committed,
        effects: {
          patches: result.patches,
          applied: result.applied,
          deltas: result.deltas,
          diagnostics: result.diagnostics
        },
        snapshot: snapshot(),
        diagnostics: result.diagnostics
      };
    },
    refresh: async () => snapshot(),
    close: () => {
      closed = true;
      listeners.clear();
    }
  };
}

function createRuntimeBackedStore<Version>(input: StoreRuntimeInput<Version>): Store<Version> {
  let revision = 0;
  let closed = false;
  const listeners = new Set<() => void>();
  const initialRuntimeSnapshot = input.runtime.snapshot?.();
  let currentSource = initialRuntimeSnapshot?.source ?? input.runtime.source;
  let state = dbFromSource(currentSource, input.relations, input.env);
  let version = initialRuntimeSnapshot?.version ?? currentSource.version?.();
  const snapshot = (): StoreSnapshot<Version> => ({
    db: state,
    source: currentSource,
    revision,
    diagnostics: currentSource.diagnostics?.() ?? [],
    ...(version === undefined ? {} : { version })
  });
  const refreshFromRuntime = (): StoreSnapshot<Version> => {
    const runtimeSnapshot = input.runtime.snapshot?.();
    currentSource = runtimeSnapshot?.source ?? input.runtime.source;
    version = runtimeSnapshot?.version ?? currentSource.version?.();
    state = dbFromSource(currentSource, input.relations, state.env);
    revision += 1;
    for (const listener of listeners) listener();
    return {
      db: state,
      source: currentSource,
      revision,
      diagnostics: runtimeSnapshot?.diagnostics ?? currentSource.diagnostics?.() ?? [],
      ...(version === undefined ? {} : { version })
    };
  };
  const runtimeUnsubscribe = input.runtime.subscribe?.(() => {
    if (!closed) refreshFromRuntime();
  });

  return {
    getSnapshot: snapshot,
    subscribe: (listener) => {
      if (closed) return () => {};
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    query: (queryValue, options) => ({ ...qResult(state, queryValue, options), revision }),
    queries: (queries, options) => addRevisionToBatch(qManyResult(state, queries, options), revision),
    whatIf: ((queryValue: Query<unknown> | RelationRef | QueryBatch, ...inputs: DbTransactionInputs) => {
      if (isQueryBatch(queryValue)) return addRevisionToBatch(whatIf(state, queryValue, ...inputs), revision);
      return { ...whatIf(state, queryValue, ...inputs), revision };
    }) as StoreWhatIf,
    view: (queryValue) => createStoreView(queryValue, snapshot, (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    }),
    commit: async (inputOrInputs) => {
      if (closed) {
        const closedSnapshot = snapshot();
        const diagnostics: readonly TarstateDiagnostic[] = [{
          code: 'runtime_unsupported',
          severity: 'error',
          message: 'store is closed',
          surface: 'store.commit'
        }];
        return {
          status: 'rejected',
          reflected: false,
          effects: { patches: 0, applied: 0, deltas: [], diagnostics },
          snapshot: closedSnapshot,
          diagnostics
        };
      }

      const transactionResult = tryTransact(state, ...normalizeTransactionInputs(inputOrInputs));
      if (!transactionResult.committed) {
        return {
          status: 'rejected',
          reflected: false,
          effects: {
            patches: transactionResult.patches,
            applied: 0,
            deltas: [],
            diagnostics: transactionResult.diagnostics
          },
          snapshot: snapshot(),
          diagnostics: transactionResult.diagnostics
        };
      }

      const report = await tryApplyRelationPatches(input.runtime, transactionWritePatches(transactionResult), { readVersion: true });
      const nextSnapshot = report.status === 'rejected' ? snapshot() : refreshFromRuntime();
      return {
        status: report.status,
        reflected: report.status !== 'rejected',
        effects: {
          patches: report.patches,
          applied: report.applied,
          deltas: report.deltas,
          diagnostics: report.diagnostics,
          ...(report.version === undefined ? {} : { version: report.version }),
          ...(report.durability === undefined ? {} : { durability: report.durability })
        },
        snapshot: nextSnapshot,
        diagnostics: report.diagnostics
      };
    },
    refresh: async () => refreshFromRuntime(),
    close: () => {
      closed = true;
      runtimeUnsubscribe?.();
      listeners.clear();
    }
  };
}

function createStoreView<Row, Version>(
  queryValue: Query<Row>,
  snapshot: () => StoreSnapshot<Version>,
  subscribeStore: (listener: () => void) => () => void
): StoreView<Row, Version> {
  const key = queryKey(queryValue);
  let cachedSnapshot: StoreViewSnapshot<Row, Version> | undefined;
  let cachedSnapshotDiagnosticsKey: string | undefined;
  const viewSnapshot = (): StoreViewSnapshot<Row, Version> => {
    const current = snapshot();
    const diagnosticsKey = diagnosticsFingerprint(current.diagnostics);
    if (
      cachedSnapshot !== undefined
      && cachedSnapshot.revision === current.revision
      && cachedSnapshot.queryKey === key
      && cachedSnapshotDiagnosticsKey === diagnosticsKey
    ) {
      return cachedSnapshot;
    }
    const result = qResult(current.db, queryValue);
    cachedSnapshot = {
      rows: result.rows,
      diagnostics: [...current.diagnostics, ...result.diagnostics],
      revision: current.revision,
      queryKey: key,
      ...(current.version === undefined ? {} : { version: current.version })
    };
    cachedSnapshotDiagnosticsKey = diagnosticsKey;
    return cachedSnapshot;
  };
  return {
    query: queryValue,
    queryKey: key,
    getSnapshot: viewSnapshot,
    subscribe: subscribeStore,
    refresh: async () => viewSnapshot()
  };
}

function diagnosticsFingerprint(diagnostics: readonly TarstateDiagnostic[]): string {
  return envValueFingerprint(diagnostics);
}

function createWatchHandle<DbValue extends WatchDb, Row>(dbValue: DbValue, target: WatchTarget<Row>, options: WatchOptions<Row>): WatchHandle<DbValue, Row> {
  const id = nextWatchId(options.label);
  const initial = readWatchTargetRows(dbValue, target, options);
  const state: InternalWatchState<Row> = {
    id,
    target,
    db: dbValue,
    previousRows: initial.rows,
    listeners: new Set(),
    active: true,
    options
  };
  WATCH_STATES.set(id, state as InternalWatchState<unknown>);

  return {
    id,
    db: dbValue,
    target,
    supported: true,
    mode: 'db',
    diagnostics: initial.diagnostics.map(toWatchDiagnostic),
    refresh: async (nextDb) => {
      const currentState = WATCH_STATES.get(id) as InternalWatchState<Row> | undefined;
      if (currentState === undefined || !currentState.active) {
        return {
          id,
          targetKey: watchTargetKey(target),
          target,
          delivered: false,
          changed: false,
          previousRows: state.previousRows,
          rows: state.previousRows,
          added: [],
          removed: [],
          unchanged: state.previousRows,
          rowChanges: [],
          diagnostics: []
        };
      }

      const currentDb = nextDb ?? currentState.db;
      currentState.db = currentDb;
      const next = readWatchTargetRows(currentDb, target, currentState.options);
      const diff = diffRows(currentState.previousRows, next.rows, currentState.options);
      const added = diff.changes.flatMap((change) => change.kind === 'added' ? [change.row] : []);
      const removed = diff.changes.flatMap((change) => change.kind === 'removed' ? [change.row] : []);
      const changedKeys = new Set(diff.changes.map((change) => change.key));
      const unchanged = next.rows.filter((rowValue) => !changedKeys.has(rowDiffKey(rowValue, currentState.options)));
      const event: WatchEvent<Row> = {
        id,
        targetKey: watchTargetKey(target),
        target,
        changed: diff.changes.length > 0,
        previousRows: currentState.previousRows,
        rows: next.rows,
        added,
        removed,
        unchanged,
        rowChanges: diff.changes,
        changes: { diagnostics: [] },
        diagnostics: [...next.diagnostics, ...diff.diagnostics]
      };
      currentState.previousRows = next.rows;
      await Promise.all(Array.from(currentState.listeners, (listener) => Promise.resolve(listener(event))));
      return { ...event, delivered: currentState.listeners.size > 0 };
    },
    unwatch: () => unwatch({ id }),
    ...(options.label === undefined ? {} : { label: options.label })
  };
}

function nextWatchId(label: string | undefined): string {
  if (label !== undefined && !WATCH_STATES.has(label)) return label;

  let id: string;
  do {
    id = label === undefined ? `watch:${WATCH_ID += 1}` : `${label}:${WATCH_ID += 1}`;
  } while (WATCH_STATES.has(id));
  return id;
}

type EvalEntry<Row = unknown> = {
  row: Row;
  aliases: Record<string, unknown>;
};

type WriteApplyResult = {
  db: Db;
  applied: number;
  deltas: readonly RelationDelta[];
  diagnostics: readonly TarstateDiagnostic[];
};

type InternalMaterializationState = {
  metadata: readonly MaterializationMetadata[];
  rows: ReadonlyMap<string, readonly unknown[]>;
  aux: ReadonlyMap<string, InternalMaterializationAux>;
  constraints: readonly ConstraintData[];
};

type InternalWatchState<Row = unknown> = {
  id: string;
  target: WatchTarget<Row>;
  db: WatchDb;
  previousRows: readonly Row[];
  listeners: Set<WatchListener<Row>>;
  active: boolean;
  options: WatchOptions<Row>;
};
type WherePushdown =
  | { readonly kind: 'lookup'; readonly field: string; readonly value: unknown }
  | {
      readonly kind: 'range';
      readonly field: string;
      readonly lower?: RelationRangeBound;
      readonly upper?: RelationRangeBound;
    };
type WherePushdownTarget = WherePushdown & {
  readonly relation: RelationRef;
  readonly alias: string;
};

const MATERIALIZATION_STATE = Symbol('tarstate.materializationState');
const ATTACHED_WATCH_TARGETS = Symbol('tarstate.attachedWatchTargets');
const EMPTY_MATERIALIZATION_STATE: InternalMaterializationState = Object.freeze({
  metadata: Object.freeze([]) as readonly MaterializationMetadata[],
  rows: new Map<string, readonly unknown[]>(),
  aux: new Map<string, InternalMaterializationAux>(),
  constraints: Object.freeze([]) as readonly ConstraintData[]
});
const WATCH_STATES = new Map<string, InternalWatchState<unknown>>();
let WATCH_ID = 0;

function evaluateQueryData(
  source: RelationSource,
  data: QueryData,
  relations: Readonly<Record<string, AnyRelationRef>>,
  options: EvaluateOptions,
  outer: EvalEntry | undefined,
  diagnostics: TarstateDiagnostic[]
): readonly EvalEntry[] {
  switch (data.op) {
    case 'from':
      return evaluateFrom(source, data, relations, diagnostics);
    case 'lookup':
      return evaluateLookup(source, data, relations, diagnostics);
    case 'constRows':
      return arrayFromUnknown(data.rows).map((rowValue) => entryForRow(rowValue));
    case 'where':
      return evaluateWhere(source, data, relations, options, outer, diagnostics);
    case 'project': {
      const input = evaluateNestedInput(source, data, relations, options, outer, diagnostics);
      const projection = projectionFrom(data.projection);
      if (projectionHasAggregate(projection)) {
        const rowValue = evaluateProjectionAggregate(projection, input, source, relations, options, diagnostics, outer);
        return [entryForRow(rowValue)];
      }
      return input.map((entry) => {
        const rowValue = evaluateProjection(projection, entry, source, relations, options, diagnostics, outer);
        return { row: rowValue, aliases: { ...entry.aliases, row: rowValue } };
      });
    }
    case 'extend': {
      const input = evaluateNestedInput(source, data, relations, options, outer, diagnostics);
      const projection = projectionFrom(data.projection);
      return input.map((entry) => {
        const extension = evaluateProjection(projection, entry, source, relations, options, diagnostics, outer);
        const rowValue = { ...(isRecord(entry.row) ? entry.row : {}), ...extension };
        return { row: rowValue, aliases: { ...entry.aliases, row: rowValue } };
      });
    }
    case 'without': {
      const removed = new Set(stringArray(data.fields));
      return evaluateNestedInput(source, data, relations, options, outer, diagnostics).map((entry) => {
        const rowValue: Record<string, unknown> = {};
        if (isRecord(entry.row)) {
          for (const [fieldName, fieldValue] of Object.entries(entry.row)) {
            if (!removed.has(fieldName)) rowValue[fieldName] = fieldValue;
          }
        }
        return { row: rowValue, aliases: { ...entry.aliases, row: rowValue } };
      });
    }
    case 'rename': {
      const fields = isRecord(data.fields) ? data.fields : {};
      return evaluateNestedInput(source, data, relations, options, outer, diagnostics).map((entry) => {
        const rowValue: Record<string, unknown> = {};
        if (isRecord(entry.row)) {
          for (const [fieldName, fieldValue] of Object.entries(entry.row)) {
            const renamed = fields[fieldName];
            rowValue[typeof renamed === 'string' ? renamed : fieldName] = fieldValue;
          }
        }
        return { row: rowValue, aliases: { ...entry.aliases, row: rowValue } };
      });
    }
    case 'qualify': {
      const alias = typeof data.alias === 'string' ? data.alias : 'row';
      return evaluateNestedInput(source, data, relations, options, outer, diagnostics).map((entry) => {
        const rowValue = { [alias]: entry.row };
        return { row: rowValue, aliases: { ...entry.aliases, [alias]: entry.row, row: rowValue } };
      });
    }
    case 'expand':
      return evaluateExpand(source, data, relations, options, outer, diagnostics);
    case 'join':
      return evaluateJoin(source, data, relations, options, outer, diagnostics);
    case 'aggregate':
      return evaluateAggregate(source, data, relations, options, outer, diagnostics);
    case 'sort':
      return sortEntries(evaluateNestedInput(source, data, relations, options, outer, diagnostics), arrayFromUnknown(data.order), source, relations, options, diagnostics, outer);
    case 'limit':
      return limitEntries(evaluateNestedInput(source, data, relations, options, outer, diagnostics), data.count, data.offset);
    case 'sortLimit':
      return limitEntries(sortEntries(evaluateNestedInput(source, data, relations, options, outer, diagnostics), arrayFromUnknown(data.order), source, relations, options, diagnostics, outer), data.count);
    case 'union':
      return setUnionEntries(queryDataArray(data.inputs).map((input) => evaluateQueryData(source, input, relations, options, outer, diagnostics)));
    case 'intersection':
      return setIntersectionEntries(queryDataArray(data.inputs).map((input) => evaluateQueryData(source, input, relations, options, outer, diagnostics)));
    case 'difference':
      return setDifferenceEntries(
        evaluateQueryData(source, queryDataFrom(data.left) ?? { op: 'constRows', rows: [] }, relations, options, outer, diagnostics),
        evaluateQueryData(source, queryDataFrom(data.right) ?? { op: 'constRows', rows: [] }, relations, options, outer, diagnostics)
      );
    case 'hash':
    case 'btree':
    case 'uniqueIndex':
    case 'keyBy':
      return evaluateNestedInput(source, data, relations, options, outer, diagnostics);
    default:
      diagnostics.push({
        code: 'query_invalid',
        severity: 'error',
        message: `unsupported query op "${data.op}"`,
        surface: 'evaluate'
      });
      return [];
  }
}

function evaluateFrom(
  source: RelationSource,
  data: QueryData,
  relations: Readonly<Record<string, AnyRelationRef>>,
  diagnostics: TarstateDiagnostic[]
): readonly EvalEntry[] {
  const relationName = typeof data.relation === 'string' ? data.relation : undefined;
  const relationRef = relationName === undefined ? undefined : relations[relationName];
  if (!isRelationRef(relationRef)) {
    diagnostics.push(relationMissingDiagnostic(relationName ?? String(data.relation), 'from'));
    return [];
  }
  const alias = typeof data.alias === 'string' ? data.alias : relationRef.name;
  return readRelationRows(source, relationRef, diagnostics).map((rowValue) => entryForRow(rowValue, alias, relationRef.name));
}

function evaluateLookup(
  source: RelationSource,
  data: QueryData,
  relations: Readonly<Record<string, AnyRelationRef>>,
  diagnostics: TarstateDiagnostic[]
): readonly EvalEntry[] {
  const relationName = typeof data.relation === 'string' ? data.relation : undefined;
  const relationRef = relationName === undefined ? undefined : relations[relationName];
  const fieldName = typeof data.field === 'string' ? data.field : undefined;
  if (!isRelationRef(relationRef) || fieldName === undefined) {
    diagnostics.push(relationMissingDiagnostic(relationName ?? String(data.relation), 'lookup'));
    return [];
  }
  const alias = typeof data.alias === 'string' ? data.alias : relationRef.name;
  const lookupRows = source.lookup?.({ relation: relationRef, field: fieldName, value: data.value })
    ?? source.rows(relationRef).filter((rowValue) => isRecord(rowValue) && Object.is(rowValue[fieldName], data.value));
  return validateSourceRows(relationRef, lookupRows, diagnostics).map((rowValue) => entryForRow(rowValue, alias, relationRef.name));
}

function evaluateWhere(
  source: RelationSource,
  data: QueryData,
  relations: Readonly<Record<string, AnyRelationRef>>,
  options: EvaluateOptions,
  outer: EvalEntry | undefined,
  diagnostics: TarstateDiagnostic[]
): readonly EvalEntry[] {
  const pushed = wherePushdownTargets(data, relations);
  let input: readonly EvalEntry[] | undefined;
  for (const candidate of pushed) {
    const pushedRows = readWherePushdownRows(source, candidate);
    if (pushedRows !== undefined) {
      input = validateSourceRows(candidate.relation, pushedRows, diagnostics)
        .map((rowValue) => entryForRow(rowValue, candidate.alias, candidate.relation.name));
      break;
    }
  }
  if (input === undefined) {
    input = evaluateNestedInput(source, data, relations, options, outer, diagnostics);
  }
  return input.filter((entry) => Boolean(evaluateExpr(data.predicate, entry, source, relations, options, diagnostics, outer)));
}

function readWherePushdownRows(
  source: RelationSource,
  pushdown: WherePushdownTarget
): readonly unknown[] | undefined {
  switch (pushdown.kind) {
    case 'lookup':
      return source.lookup?.({ relation: pushdown.relation, field: pushdown.field, value: pushdown.value });
    case 'range':
      return source.rangeLookup?.({
        relation: pushdown.relation,
        field: pushdown.field,
        ...(pushdown.lower === undefined ? {} : { lower: pushdown.lower }),
        ...(pushdown.upper === undefined ? {} : { upper: pushdown.upper })
      });
  }
}

function wherePushdownTargets(
  data: QueryData,
  relations: Readonly<Record<string, AnyRelationRef>>
): readonly WherePushdownTarget[] {
  const input = queryDataFrom(data.input);
  if (input?.op !== 'from') return [];
  const relationName = typeof input.relation === 'string' ? input.relation : undefined;
  const relationRef = relationName === undefined ? undefined : relations[relationName];
  if (!isRelationRef(relationRef)) return [];
  const alias = typeof input.alias === 'string' ? input.alias : relationRef.name;
  return wherePushdowns(data.predicate, new Set([alias, relationRef.name, 'row']))
    .map((pushdown) => ({ ...pushdown, relation: relationRef, alias }));
}

function wherePushdowns(input: unknown, aliases: ReadonlySet<string>): readonly WherePushdown[] {
  const data = exprFrom(unwrapOptionalProjection(input));
  switch (data.op) {
    case 'eq':
    case 'lt':
    case 'lte':
    case 'gt':
    case 'gte': {
      const pushdown = comparisonWherePushdown(data.op, data.left, data.right, aliases);
      return pushdown === undefined ? [] : [pushdown];
    }
    case 'and':
      return arrayFromUnknown(data.predicates).flatMap((predicate) => wherePushdowns(predicate, aliases));
    default:
      return [];
  }
}

function comparisonWherePushdown(
  op: string,
  left: unknown,
  right: unknown,
  aliases: ReadonlySet<string>
): WherePushdown | undefined {
  const leftField = wherePushdownField(left, aliases);
  const rightLiteral = wherePushdownLiteral(right);
  if (leftField !== undefined && rightLiteral !== undefined) {
    return directComparisonWherePushdown(op, leftField, rightLiteral.value);
  }

  const rightField = wherePushdownField(right, aliases);
  const leftLiteral = wherePushdownLiteral(left);
  if (rightField !== undefined && leftLiteral !== undefined) {
    return reversedComparisonWherePushdown(op, rightField, leftLiteral.value);
  }

  return undefined;
}

function directComparisonWherePushdown(op: string, fieldName: string, valueValue: unknown): WherePushdown | undefined {
  switch (op) {
    case 'eq':
      return { kind: 'lookup', field: fieldName, value: valueValue };
    case 'gt':
      return { kind: 'range', field: fieldName, lower: { value: valueValue, inclusive: false } };
    case 'gte':
      return { kind: 'range', field: fieldName, lower: { value: valueValue, inclusive: true } };
    case 'lt':
      return { kind: 'range', field: fieldName, upper: { value: valueValue, inclusive: false } };
    case 'lte':
      return { kind: 'range', field: fieldName, upper: { value: valueValue, inclusive: true } };
    default:
      return undefined;
  }
}

function reversedComparisonWherePushdown(op: string, fieldName: string, valueValue: unknown): WherePushdown | undefined {
  switch (op) {
    case 'eq':
      return { kind: 'lookup', field: fieldName, value: valueValue };
    case 'gt':
      return { kind: 'range', field: fieldName, upper: { value: valueValue, inclusive: false } };
    case 'gte':
      return { kind: 'range', field: fieldName, upper: { value: valueValue, inclusive: true } };
    case 'lt':
      return { kind: 'range', field: fieldName, lower: { value: valueValue, inclusive: false } };
    case 'lte':
      return { kind: 'range', field: fieldName, lower: { value: valueValue, inclusive: true } };
    default:
      return undefined;
  }
}

function wherePushdownField(input: unknown, aliases: ReadonlySet<string>): string | undefined {
  const data = exprFrom(unwrapOptionalProjection(input));
  if (data.op !== 'field') return undefined;
  const alias = typeof data.alias === 'string' ? data.alias : 'row';
  const fieldName = typeof data.field === 'string' ? data.field : undefined;
  return fieldName !== undefined && aliases.has(alias) ? fieldName : undefined;
}

function wherePushdownLiteral(input: unknown): { readonly value: unknown } | undefined {
  const data = exprFrom(unwrapOptionalProjection(input));
  return data.op === 'value' ? { value: data.value } : undefined;
}

function evaluateNestedInput(
  source: RelationSource,
  data: QueryData,
  relations: Readonly<Record<string, AnyRelationRef>>,
  options: EvaluateOptions,
  outer: EvalEntry | undefined,
  diagnostics: TarstateDiagnostic[]
): readonly EvalEntry[] {
  const input = queryDataFrom(data.input);
  return input === undefined ? [] : evaluateQueryData(source, input, relations, options, outer, diagnostics);
}

function evaluateJoin(
  source: RelationSource,
  data: QueryData,
  relations: Readonly<Record<string, AnyRelationRef>>,
  options: EvaluateOptions,
  outer: EvalEntry | undefined,
  diagnostics: TarstateDiagnostic[]
): readonly EvalEntry[] {
  const leftData = queryDataFrom(data.left);
  const rightData = queryDataFrom(data.right);
  if (leftData === undefined || rightData === undefined) return [];
  const leftRows = evaluateQueryData(source, leftData, relations, options, outer, diagnostics);
  const rightRows = evaluateQueryData(source, rightData, relations, options, outer, diagnostics);
  const rightAlias = typeof data.rightAlias === 'string' ? data.rightAlias : undefined;
  const rows: EvalEntry[] = [];

  for (const leftEntry of leftRows) {
    let matched = false;
    for (const rightEntry of rightRows) {
      const combined = combineEntries(leftEntry, rightEntry, rightAlias);
      if (joinMatches(data.on, leftEntry, rightEntry, combined, source, relations, options, diagnostics, outer)) {
        matched = true;
        rows.push(combined);
      }
    }

    if (!matched && data.kind === 'left') rows.push(leftEntry);
  }

  return rows;
}

function evaluateAggregate(
  source: RelationSource,
  data: QueryData,
  relations: Readonly<Record<string, AnyRelationRef>>,
  options: EvaluateOptions,
  outer: EvalEntry | undefined,
  diagnostics: TarstateDiagnostic[]
): readonly EvalEntry[] {
  const input = evaluateNestedInput(source, data, relations, options, outer, diagnostics);
  const groupProjection = projectionFrom(data.groupBy);
  const aggregateProjection = projectionFrom(data.aggregates);
  const groups = new Map<string, { group: Record<string, unknown>; rows: EvalEntry[] }>();

  if (Object.keys(groupProjection).length === 0) {
    groups.set('[]', { group: {}, rows: [...input] });
  } else {
    for (const entry of input) {
      const group = evaluateProjection(groupProjection, entry, source, relations, options, diagnostics, outer);
      const key = stableKey(group);
      const existing = groups.get(key);
      if (existing === undefined) {
        groups.set(key, { group, rows: [entry] });
      } else {
        existing.rows.push(entry);
      }
    }
  }

  if (input.length === 0 && groups.size === 0) groups.set('[]', { group: {}, rows: [] });

  return Array.from(groups.values()).map(({ group, rows }) => {
    const aggregateRow = evaluateAggregateProjection(aggregateProjection, rows, source, relations, options, diagnostics, outer);
    const rowValue = { ...group, ...aggregateRow };
    return entryForRow(rowValue);
  });
}

function evaluateExpand(
  source: RelationSource,
  data: QueryData,
  relations: Readonly<Record<string, AnyRelationRef>>,
  options: EvaluateOptions,
  outer: EvalEntry | undefined,
  diagnostics: TarstateDiagnostic[]
): readonly EvalEntry[] {
  const input = evaluateNestedInput(source, data, relations, options, outer, diagnostics);
  const collectionExpr = exprFrom(data.collection);
  const alias = typeof data.as === 'string' ? data.as : undefined;
  const fields = stringArray(data.fields);
  const rows: EvalEntry[] = [];

  for (const entry of input) {
    const collection = evaluateExpr(collectionExpr, entry, source, relations, options, diagnostics, outer);
    for (const item of iterableValues(collection)) {
      const extension: Record<string, unknown> = {};
      if (alias !== undefined) extension[alias] = item;
      for (const [index, fieldName] of fields.entries()) {
        extension[fieldName] = Array.isArray(item) ? item[index] : isRecord(item) ? item[fieldName] : undefined;
      }
      const rowValue = { ...(isRecord(entry.row) ? entry.row : {}), ...extension };
      rows.push({
        row: rowValue,
        aliases: { ...entry.aliases, ...(alias === undefined ? {} : { [alias]: item }), row: rowValue }
      });
    }
  }

  return rows;
}

function evaluateProjection(
  projection: ProjectionData,
  entry: EvalEntry,
  source: RelationSource,
  relations: Readonly<Record<string, AnyRelationRef>>,
  options: EvaluateOptions,
  diagnostics: TarstateDiagnostic[],
  outer: EvalEntry | undefined
): Record<string, unknown> {
  const rowValue: Record<string, unknown> = {};
  for (const [fieldName, projectionExpr] of Object.entries(projection)) {
    rowValue[fieldName] = evaluateProjectionValue(projectionExpr, entry, source, relations, options, diagnostics, outer);
  }
  return rowValue;
}

function evaluateProjectionAggregate(
  projection: ProjectionData,
  rows: readonly EvalEntry[],
  source: RelationSource,
  relations: Readonly<Record<string, AnyRelationRef>>,
  options: EvaluateOptions,
  diagnostics: TarstateDiagnostic[],
  outer: EvalEntry | undefined
): Record<string, unknown> {
  const aggregateRows = evaluateAggregateProjection(projection, rows, source, relations, options, diagnostics, outer);
  const scalarRows = rows[0] === undefined
    ? {}
    : evaluateProjection(
        Object.fromEntries(Object.entries(projection).filter(([, projectionExpr]) => !containsAggregateCall(projectionExpr))) as ProjectionData,
        rows[0],
        source,
        relations,
        options,
        diagnostics,
        outer
      );
  return { ...scalarRows, ...aggregateRows };
}

function evaluateAggregateProjection(
  projection: ProjectionData,
  rows: readonly EvalEntry[],
  source: RelationSource,
  relations: Readonly<Record<string, AnyRelationRef>>,
  options: EvaluateOptions,
  diagnostics: TarstateDiagnostic[],
  outer: EvalEntry | undefined
): Record<string, unknown> {
  const rowValue: Record<string, unknown> = {};
  for (const [fieldName, projectionExpr] of Object.entries(projection)) {
    if (containsAggregateCall(projectionExpr)) {
      rowValue[fieldName] = evaluateAggregateExpr(projectionExpr, rows, source, relations, options, diagnostics, outer);
    }
  }
  return rowValue;
}

function evaluateProjectionValue(
  projectionExpr: ExprData | OptionalProjection,
  entry: EvalEntry,
  source: RelationSource,
  relations: Readonly<Record<string, AnyRelationRef>>,
  options: EvaluateOptions,
  diagnostics: TarstateDiagnostic[],
  outer: EvalEntry | undefined
): unknown {
  if (isOptionalProjection(projectionExpr)) {
    return evaluateExpr(projectionExpr.expr, entry, source, relations, options, diagnostics, outer);
  }
  return evaluateExpr(projectionExpr, entry, source, relations, options, diagnostics, outer);
}

function evaluateExpr(
  input: unknown,
  entry: EvalEntry,
  source: RelationSource,
  relations: Readonly<Record<string, AnyRelationRef>>,
  options: EvaluateOptions,
  diagnostics: TarstateDiagnostic[],
  outer: EvalEntry | undefined
): unknown {
  const data = exprFrom(input);
  switch (data.op) {
    case 'value':
      return data.value;
    case 'field':
      return evaluateField(data, entry);
    case 'env':
      return typeof data.name === 'string' ? options.env?.[data.name] : undefined;
    case 'self':
      return entry.row;
    case 'maybe':
      return evaluateExpr(data.expr, entry, source, relations, options, diagnostics, outer);
    case 'tuple':
      return arrayFromUnknown(data.values).map((valueData) => evaluateExpr(valueData, entry, source, relations, options, diagnostics, outer));
    case 'call':
      return evaluateCall(data, entry, source, relations, options, diagnostics, outer);
    case 'sel':
    case 'sel1':
      return evaluateSelectionExpr(data, entry, source, relations, options, diagnostics, outer);
    case 'eq':
      return Object.is(evaluateExpr(data.left, entry, source, relations, options, diagnostics, outer), evaluateExpr(data.right, entry, source, relations, options, diagnostics, outer));
    case 'neq':
      return !Object.is(evaluateExpr(data.left, entry, source, relations, options, diagnostics, outer), evaluateExpr(data.right, entry, source, relations, options, diagnostics, outer));
    case 'lt':
      return compareValues(evaluateExpr(data.left, entry, source, relations, options, diagnostics, outer), evaluateExpr(data.right, entry, source, relations, options, diagnostics, outer)) < 0;
    case 'lte':
      return compareValues(evaluateExpr(data.left, entry, source, relations, options, diagnostics, outer), evaluateExpr(data.right, entry, source, relations, options, diagnostics, outer)) <= 0;
    case 'gt':
      return compareValues(evaluateExpr(data.left, entry, source, relations, options, diagnostics, outer), evaluateExpr(data.right, entry, source, relations, options, diagnostics, outer)) > 0;
    case 'gte':
      return compareValues(evaluateExpr(data.left, entry, source, relations, options, diagnostics, outer), evaluateExpr(data.right, entry, source, relations, options, diagnostics, outer)) >= 0;
    case 'and':
      return arrayFromUnknown(data.predicates).every((predicate) => Boolean(evaluateExpr(predicate, entry, source, relations, options, diagnostics, outer)));
    case 'or':
      return arrayFromUnknown(data.predicates).some((predicate) => Boolean(evaluateExpr(predicate, entry, source, relations, options, diagnostics, outer)));
    case 'not':
      return !evaluateExpr(data.predicate, entry, source, relations, options, diagnostics, outer);
    case 'isNull':
      return evaluateExpr(data.expr, entry, source, relations, options, diagnostics, outer) === null;
    case 'notNull':
      return evaluateExpr(data.expr, entry, source, relations, options, diagnostics, outer) !== null
        && evaluateExpr(data.expr, entry, source, relations, options, diagnostics, outer) !== undefined;
    case 'isMissing':
      return evaluateExpr(data.expr, entry, source, relations, options, diagnostics, outer) === undefined;
    case 'notMissing':
      return evaluateExpr(data.expr, entry, source, relations, options, diagnostics, outer) !== undefined;
    case 'aggregateCall':
      diagnostics.push({
        code: 'query_invalid',
        severity: 'warning',
        message: 'aggregate expression was evaluated outside an aggregate context',
        surface: 'evaluate'
      });
      return undefined;
    default:
      return undefined;
  }
}

function evaluateAggregateExpr(
  input: unknown,
  rows: readonly EvalEntry[],
  source: RelationSource,
  relations: Readonly<Record<string, AnyRelationRef>>,
  options: EvaluateOptions,
  diagnostics: TarstateDiagnostic[],
  outer: EvalEntry | undefined
): unknown {
  const data = unwrapOptionalProjection(input);
  if (!isExpr(data)) return undefined;
  if (data.op !== 'aggregateCall') {
    return rows[0] === undefined ? undefined : evaluateExpr(data, rows[0], source, relations, options, diagnostics, outer);
  }

  const fn = typeof data.fn === 'string' ? data.fn : '';
  const args = arrayFromUnknown(data.args);
  const values = (argIndex: number): readonly unknown[] => rows.map((entry) =>
    evaluateExpr(args[argIndex], entry, source, relations, options, diagnostics, outer));
  const predicateMatches = (argIndex: number): readonly EvalEntry[] => rows.filter((entry) =>
    Boolean(evaluateExpr(args[argIndex], entry, source, relations, options, diagnostics, outer)));

  switch (fn) {
    case 'count':
      return args.length === 0 ? rows.length : predicateMatches(0).length;
    case 'countDistinct':
      return new Set((args.length === 0 ? rows.map((entry) => entry.row) : values(0)).map(stableKey)).size;
    case 'any':
      return predicateMatches(0).length > 0;
    case 'notAny':
      return predicateMatches(0).length === 0;
    case 'sum':
      return values(0).reduce<number>((sumValue, valueValue) => sumValue + (typeof valueValue === 'number' ? valueValue : 0), 0);
    case 'avg': {
      const numeric = values(0).filter((valueValue): valueValue is number => typeof valueValue === 'number');
      return numeric.length === 0 ? undefined : numeric.reduce((sumValue, valueValue) => sumValue + valueValue, 0) / numeric.length;
    }
    case 'min':
      return extremum(values(0), 'min');
    case 'max':
      return extremum(values(0), 'max');
    case 'top':
      return sortedValues(values(0), 'desc').slice(0, numberArg(args[1], 1));
    case 'bottom':
      return sortedValues(values(0), 'asc').slice(0, numberArg(args[1], 1));
    case 'topBy':
      return rowsBy(rows, args[1], 'desc', source, relations, options, diagnostics, outer)
        .slice(0, numberArg(args[2], 1))
        .map((entry) => evaluateExpr(args[0], entry, source, relations, options, diagnostics, outer));
    case 'bottomBy':
      return rowsBy(rows, args[1], 'asc', source, relations, options, diagnostics, outer)
        .slice(0, numberArg(args[2], 1))
        .map((entry) => evaluateExpr(args[0], entry, source, relations, options, diagnostics, outer));
    case 'maxBy': {
      const entryValue = rowsBy(rows, args[1], 'desc', source, relations, options, diagnostics, outer)[0];
      return entryValue === undefined ? undefined : evaluateExpr(args[0], entryValue, source, relations, options, diagnostics, outer);
    }
    case 'minBy': {
      const entryValue = rowsBy(rows, args[1], 'asc', source, relations, options, diagnostics, outer)[0];
      return entryValue === undefined ? undefined : evaluateExpr(args[0], entryValue, source, relations, options, diagnostics, outer);
    }
    case 'setConcat': {
      const seen = new Set<string>();
      const result: unknown[] = [];
      for (const valueValue of values(0)) {
        if (!Array.isArray(valueValue)) continue;
        for (const item of valueValue) {
          const key = stableKey(item);
          if (!seen.has(key)) {
            seen.add(key);
            result.push(item);
          }
        }
      }
      return result;
    }
    default:
      return undefined;
  }
}

function evaluateField(data: ExprData, entry: EvalEntry): unknown {
  const alias = typeof data.alias === 'string' ? data.alias : 'row';
  const fieldName = typeof data.field === 'string' ? data.field : undefined;
  if (fieldName === undefined) return undefined;
  const target = alias === 'row' ? entry.row : entry.aliases[alias];
  return isRecord(target) ? target[fieldName] : undefined;
}

function evaluateCall(
  data: ExprData,
  entry: EvalEntry,
  source: RelationSource,
  relations: Readonly<Record<string, AnyRelationRef>>,
  options: EvaluateOptions,
  diagnostics: TarstateDiagnostic[],
  outer: EvalEntry | undefined
): unknown {
  const fn = data.fn;
  if (!isHostFunction(fn)) return undefined;
  const args = arrayFromUnknown(data.args).map((arg) => evaluateExpr(arg, entry, source, relations, options, diagnostics, outer));
  const registryFn = options.functions?.[fn.name];
  return (registryFn ?? fn.fn)(...args);
}

function evaluateSelectionExpr(
  data: ExprData,
  entry: EvalEntry,
  source: RelationSource,
  parentRelations: Readonly<Record<string, AnyRelationRef>>,
  options: EvaluateOptions,
  diagnostics: TarstateDiagnostic[],
  _outer: EvalEntry | undefined
): unknown {
  const queryData = queryDataFrom(data.query);
  if (queryData === undefined) return data.op === 'sel1' ? undefined : [];
  const relationData = isRecord(data.relations) ? data.relations as Readonly<Record<string, AnyRelationRef>> : parentRelations;
  const rows = evaluateQueryData(source, queryData, { ...parentRelations, ...relationData }, options, entry, diagnostics)
    .filter((innerEntry) => correlationMatches(data.correlation, entry, innerEntry));
  const resultRows = rows.map((rowEntry) => rowEntry.row);
  return data.op === 'sel1' ? resultRows[0] : resultRows;
}

function finishQueryResult<Row>(result: QueryResult<Row>, options: EvaluateOptions): QueryResult<Row> {
  const diagnostics = result.diagnostics;
  if (diagnostics.length > 0) {
    if (options.diagnosticMode === 'throw') throw new Error(diagnostics.map((item) => item.message).join('\n'));
    if (options.diagnosticMode === 'warn') {
      for (const item of diagnostics) console.warn(item.message);
    }
  }
  return result;
}

function readRelationRows(
  source: RelationSource,
  relationRef: RelationRef,
  diagnostics: TarstateDiagnostic[]
): readonly Record<string, unknown>[] {
  return validateSourceRows(relationRef, source.rows(relationRef), diagnostics);
}

function validateSourceRows(
  relationRef: RelationRef,
  rows: readonly unknown[],
  diagnostics: TarstateDiagnostic[]
): readonly Record<string, unknown>[] {
  const result: Record<string, unknown>[] = [];
  for (const rowValue of rows) {
    if (!isRecord(rowValue)) {
      diagnostics.push({
        code: 'row_invalid',
        severity: 'error',
        message: `relation "${relationRef.name}" row must be an object`,
        relation: relationRef.name,
        surface: 'evaluate',
        detail: rowValue
      });
      continue;
    }
    diagnostics.push(...validateRelationRow(relationRef, rowValue));
    result.push(rowValue);
  }
  return result;
}

function relationMissingDiagnostic(relationName: string, surface: string): TarstateDiagnostic {
  return {
    code: 'relation_missing',
    severity: 'error',
    message: `relation "${relationName}" is not available`,
    relation: relationName,
    surface
  };
}

function entryForRow(rowValue: unknown, alias?: string, relationName?: string): EvalEntry {
  const aliases: Record<string, unknown> = { row: rowValue };
  if (alias !== undefined) aliases[alias] = rowValue;
  if (relationName !== undefined) aliases[relationName] = rowValue;
  return { row: rowValue, aliases };
}

function combineEntries(left: EvalEntry, right: EvalEntry, rightAlias?: string): EvalEntry {
  const rowValue = {
    ...(isRecord(left.row) ? left.row : {}),
    ...(isRecord(right.row) ? right.row : {})
  };
  return {
    row: rowValue,
    aliases: {
      ...left.aliases,
      ...right.aliases,
      ...(rightAlias === undefined ? {} : { [rightAlias]: right.row }),
      row: rowValue
    }
  };
}

function joinMatches(
  on: unknown,
  left: EvalEntry,
  right: EvalEntry,
  combined: EvalEntry,
  source: RelationSource,
  relations: Readonly<Record<string, AnyRelationRef>>,
  options: EvaluateOptions,
  diagnostics: TarstateDiagnostic[],
  outer: EvalEntry | undefined
): boolean {
  if (isPredicateData(on)) {
    return Boolean(evaluateExpr(on, combined, source, relations, options, diagnostics, outer));
  }
  if (!isRecord(on)) return false;
  return Object.entries(on).every(([leftField, rightField]) =>
    typeof rightField === 'string'
      && isRecord(left.row)
      && isRecord(right.row)
      && Object.is(left.row[leftField], right.row[rightField]));
}

function correlationMatches(correlation: unknown, outer: EvalEntry, inner: EvalEntry): boolean {
  if (!isRecord(correlation)) return true;
  return Object.entries(correlation).every(([outerField, innerField]) =>
    typeof innerField === 'string'
      && isRecord(outer.row)
      && isRecord(inner.row)
      && Object.is(outer.row[outerField], inner.row[innerField]));
}

function sortEntries(
  rows: readonly EvalEntry[],
  order: readonly unknown[],
  source: RelationSource,
  relations: Readonly<Record<string, AnyRelationRef>>,
  options: EvaluateOptions,
  diagnostics: TarstateDiagnostic[],
  outer: EvalEntry | undefined
): readonly EvalEntry[] {
  if (order.length === 0) return [...rows];
  return [...rows].sort((left, right) => {
    for (const sortInput of order) {
      const sortData = normalizeSortInput(sortInput);
      const leftValue = evaluateExpr(sortData.expr, left, source, relations, options, diagnostics, outer);
      const rightValue = evaluateExpr(sortData.expr, right, source, relations, options, diagnostics, outer);
      const comparisonValue = compareNullable(leftValue, rightValue, sortData.nulls);
      if (comparisonValue !== 0) return sortData.direction === 'desc' ? -comparisonValue : comparisonValue;
    }
    return 0;
  });
}

function limitEntries(rows: readonly EvalEntry[], countValue: unknown, offsetValue?: unknown): readonly EvalEntry[] {
  const countNumber = typeof countValue === 'number' ? Math.max(0, countValue) : rows.length;
  const offsetNumber = typeof offsetValue === 'number' ? Math.max(0, offsetValue) : 0;
  return rows.slice(offsetNumber, offsetNumber + countNumber);
}

function setUnionEntries(groups: readonly (readonly EvalEntry[])[]): readonly EvalEntry[] {
  const seen = new Set<string>();
  const result: EvalEntry[] = [];
  for (const group of groups) {
    for (const entry of group) {
      const key = stableKey(entry.row);
      if (!seen.has(key)) {
        seen.add(key);
        result.push(entry);
      }
    }
  }
  return result;
}

function setIntersectionEntries(groups: readonly (readonly EvalEntry[])[]): readonly EvalEntry[] {
  const [first, ...rest] = groups;
  if (first === undefined) return [];
  return first.filter((entry) => {
    const key = stableKey(entry.row);
    return rest.every((group) => group.some((candidate) => stableKey(candidate.row) === key));
  });
}

function setDifferenceEntries(left: readonly EvalEntry[], right: readonly EvalEntry[]): readonly EvalEntry[] {
  const rightKeys = new Set(right.map((entry) => stableKey(entry.row)));
  return left.filter((entry) => !rightKeys.has(stableKey(entry.row)));
}

function projectionFrom(input: unknown): ProjectionData {
  return isRecord(input) ? input as ProjectionData : {};
}

function exprFrom(input: unknown): ExprData {
  return isExpr(input) ? input : value(input as PrimitiveValue);
}

function queryDataArray(input: unknown): readonly QueryData[] {
  return Array.isArray(input) ? input.flatMap((item) => {
    const data = queryDataFrom(item);
    return data === undefined ? [] : [data];
  }) : [];
}

function arrayFromUnknown(input: unknown): readonly unknown[] {
  return Array.isArray(input) ? input : [];
}

function iterableValues(input: unknown): readonly unknown[] {
  if (input === undefined || input === null) return [];
  if (typeof input === 'string') return Array.from(input);
  if (Array.isArray(input)) return input;
  if (typeof (input as { [Symbol.iterator]?: unknown })[Symbol.iterator] === 'function') {
    return Array.from(input as Iterable<unknown>);
  }
  return [];
}

function isOptionalProjection(input: unknown): input is OptionalProjection {
  return isRecord(input) && input.kind === 'optionalProjection' && isExpr(input.expr);
}

function isPredicateData(input: unknown): input is PredicateData {
  return isExpr(input) && (
    input.op === 'eq'
    || input.op === 'neq'
    || input.op === 'lt'
    || input.op === 'lte'
    || input.op === 'gt'
    || input.op === 'gte'
    || input.op === 'and'
    || input.op === 'or'
    || input.op === 'not'
    || input.op === 'isNull'
    || input.op === 'notNull'
    || input.op === 'isMissing'
    || input.op === 'notMissing'
  );
}

function unwrapOptionalProjection(input: unknown): unknown {
  return isOptionalProjection(input) ? input.expr : input;
}

function projectionHasAggregate(projection: ProjectionData): boolean {
  return Object.values(projection).some(containsAggregateCall);
}

function containsAggregateCall(input: unknown): boolean {
  const valueValue = unwrapOptionalProjection(input);
  if (!isRecord(valueValue)) return false;
  if (valueValue.op === 'aggregateCall') return true;
  return Object.values(valueValue).some((item) => {
    if (Array.isArray(item)) return item.some(containsAggregateCall);
    return containsAggregateCall(item);
  });
}

function normalizeSortInput(input: unknown): SortData {
  if (isRecord(input) && isExpr(input.expr) && (input.direction === 'asc' || input.direction === 'desc')) {
    return {
      expr: input.expr,
      direction: input.direction,
      ...(input.nulls === 'first' || input.nulls === 'last' ? { nulls: input.nulls } : {})
    };
  }
  return { expr: exprFrom(input), direction: 'asc' };
}

function compareNullable(left: unknown, right: unknown, nulls: NullSortOrder | undefined): number {
  const leftNullish = left === null || left === undefined;
  const rightNullish = right === null || right === undefined;
  if (leftNullish || rightNullish) {
    if (leftNullish && rightNullish) return 0;
    const nullFirst = nulls === 'first';
    return leftNullish ? (nullFirst ? -1 : 1) : (nullFirst ? 1 : -1);
  }
  return compareValues(left, right);
}

function compareValues(left: unknown, right: unknown): number {
  if (Object.is(left, right)) return 0;
  if (left === undefined || left === null) return -1;
  if (right === undefined || right === null) return 1;
  if (typeof left === 'number' && typeof right === 'number') return left < right ? -1 : 1;
  if (typeof left === 'string' && typeof right === 'string') return left.localeCompare(right);
  if (typeof left === 'boolean' && typeof right === 'boolean') return Number(left) - Number(right);
  return stableKey(left).localeCompare(stableKey(right));
}

function sortedValues(values: readonly unknown[], direction: SortDirection): readonly unknown[] {
  return [...values].sort((left, right) => direction === 'desc' ? -compareValues(left, right) : compareValues(left, right));
}

function extremum(values: readonly unknown[], mode: 'min' | 'max'): unknown {
  const filtered = values.filter((valueValue) => valueValue !== undefined && valueValue !== null);
  return filtered.reduce<unknown>((current, valueValue) => {
    if (current === undefined) return valueValue;
    const comparisonValue = compareValues(valueValue, current);
    return mode === 'min'
      ? comparisonValue < 0 ? valueValue : current
      : comparisonValue > 0 ? valueValue : current;
  }, undefined);
}

function rowsBy(
  rows: readonly EvalEntry[],
  by: unknown,
  direction: SortDirection,
  source: RelationSource,
  relations: Readonly<Record<string, AnyRelationRef>>,
  options: EvaluateOptions,
  diagnostics: TarstateDiagnostic[],
  outer: EvalEntry | undefined
): readonly EvalEntry[] {
  return [...rows].sort((left, right) => {
    const leftValue = evaluateExpr(by, left, source, relations, options, diagnostics, outer);
    const rightValue = evaluateExpr(by, right, source, relations, options, diagnostics, outer);
    const comparisonValue = compareValues(leftValue, rightValue);
    return direction === 'desc' ? -comparisonValue : comparisonValue;
  });
}

function numberArg(input: unknown, fallback: number): number {
  return typeof input === 'number' && Number.isFinite(input) ? input : fallback;
}

function queryForTarget<Row>(target: Query<Row> | RelationRef): Query<Row> {
  return isQuery(target) ? target : from(target as RelationRef<Record<string, unknown>>) as Query<Row>;
}

function queryBatchTargetQuery(target: QueryBatchTarget): Query<unknown> | RelationRef {
  return isRecord(target) && 'q' in target ? target.q as Query<unknown> | RelationRef : target as Query<unknown> | RelationRef;
}

function isQueryBatch(input: unknown): input is QueryBatch {
  return isRecord(input) && !isQuery(input) && !isRelationRef(input);
}

function applyDbQueryOptions<Row, MappedRow>(rows: readonly Row[], options: DbQueryOptions<Row, MappedRow>): readonly MappedRow[] {
  let result = [...rows];
  if (options.sort !== undefined) result = sortPlainRows(result, options.sort, 'asc');
  if (options.rsort !== undefined) result = sortPlainRows(result, options.rsort, 'desc');
  const mapped = options.mapRows === undefined ? result as unknown as readonly MappedRow[] : options.mapRows(result);
  return mapped;
}

function hasDbQueryRowTransforms(options: DbQueryOptions<unknown, unknown>): boolean {
  return options.sort !== undefined || options.rsort !== undefined || options.mapRows !== undefined;
}

function sortPlainRows<Row>(rows: readonly Row[], sortValue: DbQuerySort<Row>, direction: SortDirection): Row[] {
  const keys = Array.isArray(sortValue) ? sortValue : [sortValue];
  return [...rows].sort((left, right) => {
    for (const key of keys) {
      const leftValue = typeof key === 'function' ? key(left) : isRecord(left) ? left[key] : undefined;
      const rightValue = typeof key === 'function' ? key(right) : isRecord(right) ? right[key] : undefined;
      const comparisonValue = compareValues(leftValue, rightValue);
      if (comparisonValue !== 0) return direction === 'desc' ? -comparisonValue : comparisonValue;
    }
    return 0;
  });
}

function isRelationKeyInput(input: unknown): input is RelationKeyInput {
  return typeof input === 'string' || typeof input === 'number' || Array.isArray(input);
}

function relationKeyInputToKey(relationRef: RelationRef, input: RelationKeyInput): string {
  return stableKey(Array.isArray(relationRef.key) ? input : [input]);
}

function cloneDb(input: Db): Db {
  return { ...input, data: cloneDbData(input.data), env: input.env };
}

function cloneDbData(data: DbInputData): DbData {
  return Object.fromEntries(Object.entries(data).map(([name, rows]) => [name, [...rows]]));
}

function resolveTransactionInput(input: DbTransactionInput, dbValue: Db): DbTransactionItem {
  if (typeof input === 'function') return input(dbValue as DbTransactionContext, dbValue);
  return input;
}

function normalizeTransactionItem(input: DbTransactionItem): readonly (WritePatch | SetEnvTransaction)[] {
  if (isWritePatch(input) || isSetEnvTransaction(input)) return [input];
  if (isIterableTransactionItems(input)) return Array.from(input);
  return writeInputPatches(input as WriteInput);
}

function isIterableTransactionItems(input: unknown): input is Iterable<WritePatch | SetEnvTransaction> {
  return !isWritePatch(input)
    && !isSetEnvTransaction(input)
    && typeof input !== 'string'
    && input !== undefined
    && input !== null
    && typeof (input as { [Symbol.iterator]?: unknown })[Symbol.iterator] === 'function';
}

function isSetEnvTransaction(input: unknown): input is SetEnvTransaction {
  return isRecord(input) && input.op === 'setEnv';
}

function applySetEnvTransaction(dbValue: Db, tx: SetEnvTransaction): Db {
  const envValue = typeof tx.env === 'function' ? tx.env(dbValue.env, dbValue) : tx.env;
  return { ...dbValue, env: envValue };
}

type EnvSnapshotEntry = {
  readonly value: unknown;
  readonly fingerprint: string;
  readonly identitySensitive: boolean;
};
type EnvSnapshot = ReadonlyMap<string, EnvSnapshotEntry>;

function envSnapshot(envValue: DbEnv): EnvSnapshot {
  return new Map(Object.keys(envValue).map((name) => [name, {
    value: envValue[name],
    fingerprint: envValueFingerprint(envValue[name]),
    identitySensitive: envValueIdentitySensitive(envValue[name])
  }]));
}

function envDeltasFor(before: EnvSnapshot, after: DbEnv): readonly MaterializationEnvDelta[] {
  const names = new Set([...before.keys(), ...Object.keys(after)]);
  const deltas: MaterializationEnvDelta[] = [];
  for (const name of names) {
    const beforeValue = before.get(name);
    const afterHasValue = Object.prototype.hasOwnProperty.call(after, name);
    const afterValue = afterHasValue ? after[name] : undefined;
    const beforeFingerprint = beforeValue?.fingerprint ?? '~missing';
    const afterFingerprint = afterHasValue ? envValueFingerprint(afterValue) : '~missing';
    const identityChanged = beforeValue?.identitySensitive === true && !Object.is(beforeValue.value, afterValue);
    if (beforeFingerprint !== afterFingerprint || identityChanged) {
      deltas.push({ name, before: beforeValue?.value, after: afterValue });
    }
  }
  return deltas;
}

function envValueFingerprint(
  input: unknown,
  seen: Map<object, number> = new Map()
): string {
  if (input === undefined) return '~undefined';
  if (typeof input === 'number') {
    if (Number.isNaN(input)) return '~number:NaN';
    if (input === Infinity) return '~number:Infinity';
    if (input === -Infinity) return '~number:-Infinity';
    if (Object.is(input, -0)) return '~number:-0';
    return JSON.stringify(input);
  }
  if (input === null || typeof input === 'string' || typeof input === 'boolean') return JSON.stringify(input);
  if (typeof input === 'bigint') return `~bigint:${input.toString()}`;
  if (typeof input === 'symbol') return `~symbol:${String(input.description)}`;
  if (typeof input === 'function') return `~function:${input.name}`;
  if (input instanceof Date) return `~date:${Number.isNaN(input.valueOf()) ? 'Invalid' : input.toISOString()}`;
  if (input instanceof RegExp) return `~regexp:${input.source}/${input.flags}`;
  if (input instanceof Map) {
    const reference = envSeenReference(input, seen);
    if (reference !== undefined) return reference;
    return `~map:{${Array.from(input.entries())
      .map(([key, valueValue]) => `${envValueFingerprint(key, seen)}=>${envValueFingerprint(valueValue, seen)}`)
      .join(',')}}`;
  }
  if (input instanceof Set) {
    const reference = envSeenReference(input, seen);
    if (reference !== undefined) return reference;
    return `~set:[${Array.from(input.values()).map((item) => envValueFingerprint(item, seen)).join(',')}]`;
  }
  if (Array.isArray(input)) {
    const reference = envSeenReference(input, seen);
    if (reference !== undefined) return reference;
    return `[${input.map((item) => envValueFingerprint(item, seen)).join(',')}]`;
  }
  if (isRecord(input)) {
    const reference = envSeenReference(input, seen);
    if (reference !== undefined) return reference;
    return `{${Object.keys(input)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${envValueFingerprint(input[key], seen)}`)
      .join(',')}}`;
  }
  if (typeof input === 'object' && input !== null) return Object.prototype.toString.call(input);
  return JSON.stringify(String(input as string | number | boolean | bigint | null | undefined));
}

function envValueIdentitySensitive(input: unknown): boolean {
  return (typeof input === 'object' && input !== null) || typeof input === 'function' || typeof input === 'symbol';
}

function envSeenReference(input: object, seen: Map<object, number>): string | undefined {
  const existing = seen.get(input);
  if (existing !== undefined) return `~ref:${existing}`;
  seen.set(input, seen.size);
  return undefined;
}

function applyWritePatchToDb(dbValue: Db, patch: WritePatch, constraints: readonly ConstraintData[] = []): WriteApplyResult {
  const relationRef = patch.relation;
  const beforeRows = [...(dbValue.data[relationRef.name] ?? [])] as Record<string, unknown>[];
  const diagnostics: TarstateDiagnostic[] = [];
  const rowDiagnostics = validatePatchRows(patch);
  diagnostics.push(...rowDiagnostics);
  if (rowDiagnostics.some(isErrorDiagnostic)) return { db: dbValue, applied: 0, deltas: [], diagnostics };

  const rows = [...beforeRows];
  const keyOf = (rowValue: Record<string, unknown>): string | undefined => rowKey(relationRef, rowValue);
  const keyFromPatch = (key: RelationKeyInput): string => relationKeyInputToKey(relationRef, key);
  const findIndexByKey = (key: string | undefined): number => key === undefined ? -1 : rows.findIndex((rowValue) => keyOf(rowValue) === key);
  const findConflictIndexes = (rowValue: Record<string, unknown>): readonly number[] => conflictIndexesFor(dbValue, relationRef, rows, rowValue, constraints);
  let added: unknown[] = [];
  let removed: unknown[] = [];

  switch (patch.op) {
    case 'insert': {
      const key = keyOf(patch.row as Record<string, unknown>);
      if (findIndexByKey(key) !== -1) diagnostics.push(uniqueKeyDiagnostic(relationRef, patch.row));
      else {
        rows.push(patch.row as Record<string, unknown>);
        added = [patch.row];
      }
      break;
    }
    case 'insertIgnore': {
      if (findConflictIndexes(patch.row as Record<string, unknown>).length === 0) {
        rows.push(patch.row as Record<string, unknown>);
        added = [patch.row];
      }
      break;
    }
    case 'insertOrReplace': {
      const conflictIndexes = findConflictIndexes(patch.row as Record<string, unknown>);
      if (conflictIndexes.length === 0) {
        rows.push(patch.row as Record<string, unknown>);
        added = [patch.row];
      } else {
        removed = replaceConflictingRows(rows, conflictIndexes, patch.row as Record<string, unknown>);
        added = [patch.row];
      }
      break;
    }
    case 'insertOrMerge': {
      const conflictIndexes = findConflictIndexes(patch.row as Record<string, unknown>);
      const indexValue = conflictIndexes[0] ?? -1;
      if (indexValue === -1) {
        rows.push(patch.row as Record<string, unknown>);
        added = [patch.row];
      } else {
        const current = rows[indexValue] as RelationRow<RelationRef>;
        const updateResult = mergeUpdate(current, patch.row, patch.merge, relationRef, dbValue);
        diagnostics.push(...updateResult.diagnostics);
        const next = { ...current, ...updateResult.update };
        removed = replaceConflictingRows(rows, conflictIndexes, next);
        added = [next];
      }
      break;
    }
    case 'insertOrUpdate': {
      const conflictIndexes = findConflictIndexes(patch.row as Record<string, unknown>);
      const indexValue = conflictIndexes[0] ?? -1;
      if (indexValue === -1) {
        rows.push(patch.row as Record<string, unknown>);
        added = [patch.row];
      } else {
        const current = rows[indexValue] as RelationRow<RelationRef>;
        const updateResult = relationUpdateFor(current, patch.update ?? patch.row, relationRef, dbValue);
        diagnostics.push(...updateResult.diagnostics);
        const next = { ...current, ...updateResult.update };
        removed = replaceConflictingRows(rows, conflictIndexes, next);
        added = [next];
      }
      break;
    }
    case 'updateByKey': {
      const indexValue = findIndexByKey(keyFromPatch(patch.key as RelationKeyInput));
      if (indexValue !== -1) {
        const current = rows[indexValue] as RelationRow<RelationRef>;
        const updateResult = relationUpdateFor(current, patch.changes, relationRef, dbValue);
        diagnostics.push(...updateResult.diagnostics);
        const next = { ...current, ...updateResult.update };
        const nextDiagnostics = validateRelationRow(relationRef, next);
        diagnostics.push(...nextDiagnostics);
        if (!nextDiagnostics.some(isErrorDiagnostic)) {
          removed = [current];
          rows[indexValue] = next;
          added = [next];
        }
      }
      break;
    }
    case 'update': {
      const nextRows = rows.map((current) => {
        if (!predicateMatchesRow(patch.predicate, current, relationRef, dbValue)) return current;
        const updateResult = relationUpdateFor(current as RelationRow<RelationRef>, patch.changes, relationRef, dbValue);
        diagnostics.push(...updateResult.diagnostics);
        const next = { ...current, ...updateResult.update };
        diagnostics.push(...validateRelationRow(relationRef, next));
        removed.push(current);
        added.push(next);
        return next;
      });
      rows.splice(0, rows.length, ...nextRows);
      break;
    }
    case 'deleteByKey': {
      const indexValue = findIndexByKey(keyFromPatch(patch.key as RelationKeyInput));
      if (indexValue !== -1) {
        const [rowValue] = rows.splice(indexValue, 1);
        if (rowValue !== undefined) removed = [rowValue];
      }
      break;
    }
    case 'delete': {
      const kept: Record<string, unknown>[] = [];
      for (const rowValue of rows) {
        if (predicateMatchesRow(patch.predicate, rowValue, relationRef, dbValue)) removed.push(rowValue);
        else kept.push(rowValue);
      }
      rows.splice(0, rows.length, ...kept);
      break;
    }
    case 'deleteExact': {
      const kept: Record<string, unknown>[] = [];
      for (const rowValue of rows) {
        if (rowExactlyMatches(rowValue, patch.row as Record<string, unknown>)) removed.push(rowValue);
        else kept.push(rowValue);
      }
      rows.splice(0, rows.length, ...kept);
      break;
    }
    case 'replaceAll':
      removed = [...rows];
      rows.splice(0, rows.length, ...(patch.rows as readonly Record<string, unknown>[]));
      added = [...patch.rows];
      break;
    default:
      break;
  }

  if (diagnostics.some(isErrorDiagnostic)) return { db: dbValue, applied: 0, deltas: [], diagnostics };
  if (added.length === 0 && removed.length === 0) return { db: dbValue, applied: 0, deltas: [], diagnostics };
  const nextData = { ...dbValue.data, [relationRef.name]: rows };
  return {
    db: { ...dbValue, data: nextData },
    applied: 1,
    deltas: [{ relation: relationRef, added, removed }],
    diagnostics
  };
}

function validatePatchRows(patch: WritePatch): readonly TarstateDiagnostic[] {
  switch (patch.op) {
    case 'insert':
    case 'insertIgnore':
    case 'insertOrReplace':
    case 'insertOrMerge':
    case 'insertOrUpdate':
      return validateRelationRow(patch.relation, patch.row as Record<string, unknown>);
    case 'replaceAll':
      return patch.rows.flatMap((rowValue) => validateRelationRow(patch.relation, rowValue as Record<string, unknown>));
    default:
      return [];
  }
}

type EvaluatedRelationUpdate = {
  readonly update: RelationRowUpdate<RelationRef>;
  readonly diagnostics: readonly TarstateDiagnostic[];
};

function relationUpdateFor(
  current: RelationRow<RelationRef>,
  input: RelationRowUpdateInput<RelationRef>,
  relationRef: RelationRef,
  dbValue: Db
): EvaluatedRelationUpdate {
  const updateValue = typeof input === 'function' ? input(current) : input;
  return evaluateRelationUpdateMap(current, updateValue, relationRef, dbValue);
}

function mergeUpdate(
  current: RelationRow<RelationRef>,
  incoming: RelationRow<RelationRef>,
  merge: RelationMergeInput<RelationRef> | undefined,
  relationRef: RelationRef,
  dbValue: Db
): EvaluatedRelationUpdate {
  const updateValue = typeof merge === 'function'
    ? merge(current, incoming)
    : Array.isArray(merge)
      ? Object.fromEntries(merge.map((fieldName) => [fieldName, incoming[fieldName]]))
      : incoming;
  return evaluateRelationUpdateMap(current, updateValue, relationRef, dbValue);
}

function predicateMatchesRow(predicate: PredicateData, rowValue: Record<string, unknown>, relationRef: RelationRef, dbValue: Db): boolean {
  const diagnostics: TarstateDiagnostic[] = [];
  const entry = entryForRow(rowValue, relationRef.name, relationRef.name);
  for (const alias of relationPredicateAliases(relationRef.name)) entry.aliases[alias] = rowValue;
  return Boolean(evaluateExpr(predicate, entry, dbSource(dbValue), { [relationRef.name]: relationRef }, { env: dbValue.env }, diagnostics, undefined));
}

function rowExactlyMatches(rowValue: Record<string, unknown>, exact: Record<string, unknown>): boolean {
  return stableKey(rowValue) === stableKey(exact);
}

function evaluateRelationUpdateMap(
  current: RelationRow<RelationRef>,
  input: RelationRowUpdate<RelationRef>,
  relationRef: RelationRef,
  dbValue: Db
): EvaluatedRelationUpdate {
  const updateValue: Record<string, unknown> = {};
  const diagnostics: TarstateDiagnostic[] = [];
  const entry = entryForRow(current, relationRef.name, relationRef.name);
  for (const alias of relationPredicateAliases(relationRef.name)) entry.aliases[alias] = current;

  for (const [fieldName, fieldValue] of Object.entries(input)) {
    updateValue[fieldName] = isEvaluableExpr(fieldValue)
      ? evaluateExpr(fieldValue, entry, dbSource(dbValue), { [relationRef.name]: relationRef }, { env: dbValue.env }, diagnostics, undefined)
      : fieldValue;
  }

  return { update: updateValue as RelationRowUpdate<RelationRef>, diagnostics };
}

function isEvaluableExpr(input: unknown): input is ExprData {
  if (!isExpr(input)) return false;
  return [
    'value',
    'field',
    'env',
    'self',
    'maybe',
    'tuple',
    'call',
    'sel',
    'sel1',
    'eq',
    'neq',
    'lt',
    'lte',
    'gt',
    'gte',
    'and',
    'or',
    'not',
    'isNull',
    'notNull',
    'isMissing',
    'notMissing'
  ].includes(input.op);
}

function replaceConflictingRows(
  rows: Record<string, unknown>[],
  conflictIndexes: readonly number[],
  next: Record<string, unknown>
): unknown[] {
  const indexes = uniqueSortedIndexes(conflictIndexes);
  const firstIndex = indexes[0];
  if (firstIndex === undefined) return [];

  const removed = indexes.map((indexValue) => rows[indexValue]).filter((rowValue): rowValue is Record<string, unknown> => rowValue !== undefined);
  const removeSet = new Set(indexes);
  const nextRows = rows.filter((_, indexValue) => !removeSet.has(indexValue));
  nextRows.splice(Math.min(firstIndex, nextRows.length), 0, next);
  rows.splice(0, rows.length, ...nextRows);
  return removed;
}

function conflictIndexesFor(
  dbValue: Db,
  relationRef: RelationRef,
  rows: readonly Record<string, unknown>[],
  incoming: Record<string, unknown>,
  constraints: readonly ConstraintData[]
): readonly number[] {
  const indexes: number[] = [];
  const incomingKey = rowKey(relationRef, incoming);
  if (incomingKey !== undefined) {
    const relationKeyIndex = rows.findIndex((rowValue) => rowKey(relationRef, rowValue) === incomingKey);
    if (relationKeyIndex !== -1) indexes.push(relationKeyIndex);
  }

  for (const constraint of constraints) {
    if (constraint.op !== 'unique') continue;
    indexes.push(...uniqueConstraintConflictIndexes(dbValue, relationRef, rows, incoming, constraint));
  }

  return uniqueSortedIndexes(indexes);
}

function uniqueConstraintConflictIndexes(
  dbValue: Db,
  relationRef: RelationRef,
  rows: readonly Record<string, unknown>[],
  incoming: Record<string, unknown>,
  constraint: UniqueConstraintData
): readonly number[] {
  if (constraint.fields.length === 0 || constraintRelationName(constraint.query) !== relationRef.name) return [];

  const incomingKey = uniqueConstraintRowKey(incoming, constraint.fields);
  if (incomingKey === undefined) return [];

  if (!incomingParticipatesInUniqueConstraint(dbValue, relationRef, rows, incoming, constraint, incomingKey)) return [];

  return rows.flatMap((rowValue, indexValue) =>
    uniqueConstraintRowKey(rowValue, constraint.fields) === incomingKey ? [indexValue] : []);
}

function incomingParticipatesInUniqueConstraint(
  dbValue: Db,
  relationRef: RelationRef,
  rows: readonly Record<string, unknown>[],
  incoming: Record<string, unknown>,
  constraint: UniqueConstraintData,
  incomingKey: string
): boolean {
  if (isRelationRef(constraint.query)) return true;

  const beforeCounts = uniqueConstraintQueryKeyCounts(dbValue, constraint);
  const nextDb = {
    ...dbValue,
    data: {
      ...dbValue.data,
      [relationRef.name]: [...rows, incoming]
    }
  };
  const afterCounts = uniqueConstraintQueryKeyCounts(nextDb, constraint);
  const beforeCount = beforeCounts.get(incomingKey) ?? 0;
  const afterCount = afterCounts.get(incomingKey) ?? 0;
  return beforeCount > 0 && afterCount > beforeCount;
}

function uniqueConstraintQueryKeyCounts(dbValue: Db, constraint: UniqueConstraintData): Map<string, number> {
  const counts = new Map<string, number>();
  const result = evaluateConstraintQuery(dbSource(dbValue), constraint.query, { env: dbValue.env });
  for (const rowValue of result.rows) {
    if (!isRecord(rowValue)) continue;
    const key = uniqueConstraintRowKey(rowValue, constraint.fields);
    if (key === undefined) continue;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

function uniqueConstraintRowKey(rowValue: Record<string, unknown>, fields: readonly string[]): string | undefined {
  return stableKey(fields.map((fieldName) => rowValue[fieldName]));
}

function uniqueSortedIndexes(indexes: readonly number[]): readonly number[] {
  return [...new Set(indexes)].sort((left, right) => left - right);
}

function relationPredicateAliases(relationName: string): readonly string[] {
  if (relationName.endsWith('ies')) return [relationName.slice(0, -3) + 'y'];
  if (relationName.endsWith('s') && relationName.length > 1) return [relationName.slice(0, -1)];
  return [];
}

function uniqueKeyDiagnostic(relationRef: RelationRef, rowValue: unknown): TarstateDiagnostic {
  const keyFields = relationKeyFields(relationRef);
  return {
    code: 'unique',
    severity: 'error',
    message: `relation "${relationRef.name}" already contains key ${rowKey(relationRef, rowValue as Record<string, unknown>) ?? '<missing>'}`,
    relation: relationRef.name,
    ...(keyFields.length === 1 ? { field: keyFields[0] } : {}),
    surface: 'write'
  };
}

function constraintDiagnosticsForInvalidPatch(patch: WritePatch, constraints: readonly ConstraintData[]): readonly TarstateDiagnostic[] {
  const relationRef = patch.relation;
  const rowValue = patchRowForDiagnostics(patch);
  if (rowValue === undefined) return [];
  const diagnostics: TarstateDiagnostic[] = [];

  for (const constraint of constraints) {
    if (constraint.op !== 'req' || !constraintMatchesRelation(constraint.query, relationRef.name)) continue;
    for (const fieldName of constraint.fields) {
      if (rowValue[fieldName] === undefined || rowValue[fieldName] === null) {
        diagnostics.push({
          code: 'required',
          severity: 'error',
          message: `required field "${fieldName}" is missing`,
          relation: relationRef.name,
          field: fieldName,
          surface: 'validateConstraints',
          detail: rowValue
        });
      }
    }
  }

  return diagnostics;
}

function patchRowForDiagnostics(patch: WritePatch): Record<string, unknown> | undefined {
  switch (patch.op) {
    case 'insert':
    case 'insertIgnore':
    case 'insertOrReplace':
    case 'insertOrMerge':
    case 'insertOrUpdate':
      return isRecord(patch.row) ? patch.row : undefined;
    default:
      return undefined;
  }
}

function constraintMatchesRelation(queryValue: Query | RelationRef, relationName: string): boolean {
  return isRelationRef(queryValue)
    ? queryValue.name === relationName
    : relationDependencies(queryValue).includes(relationName);
}

function validateConstraintsSync(
  dbOrSource: Db | RelationSource,
  input: ConstraintValidationInput | undefined,
  options: ConstraintValidationOptions = {}
): ConstraintValidationResult {
  const constraints = flattenConstraints(input);
  const diagnostics: TarstateDiagnostic[] = [];
  const source = isDb(dbOrSource) ? dbSource(dbOrSource) : dbOrSource;
  const envValue = options.env ?? (isDb(dbOrSource) ? dbOrSource.env : undefined);

  const evaluateOptions = envValue === undefined ? options : { ...options, env: envValue };
  for (const constraint of constraints) {
    diagnostics.push(...validateConstraint(source, constraint, evaluateOptions));
  }

  return { valid: !diagnostics.some(isErrorDiagnostic), diagnostics };
}

function validateConstraint(source: RelationSource, constraint: ConstraintData, options: EvaluateOptions): readonly TarstateDiagnostic[] {
  switch (constraint.op) {
    case 'req':
      return validateRequiredConstraint(source, constraint, options);
    case 'unique':
      return validateUniqueConstraint(source, constraint, options);
    case 'fk':
      return validateForeignKeyConstraint(source, constraint, options);
    case 'check':
      return validateCheckConstraint(source, constraint, options);
    default:
      return [];
  }
}

function validateRequiredConstraint(source: RelationSource, constraint: RequiredConstraintData, options: EvaluateOptions): readonly TarstateDiagnostic[] {
  const result = evaluateConstraintQuery(source, constraint.query, options);
  const diagnostics: TarstateDiagnostic[] = [...result.diagnostics];
  const relationName = constraintRelationName(constraint.query);
  for (const rowValue of result.rows) {
    if (!isRecord(rowValue)) continue;
    for (const fieldName of constraint.fields) {
      if (rowValue[fieldName] === undefined || rowValue[fieldName] === null) {
        diagnostics.push({
          code: 'required',
          severity: 'error',
          message: `required field "${fieldName}" is missing`,
          field: fieldName,
          ...(relationName === undefined ? {} : { relation: relationName }),
          surface: 'validateConstraints',
          detail: rowValue
        });
      }
    }
  }
  return diagnostics;
}

function validateUniqueConstraint(source: RelationSource, constraint: UniqueConstraintData, options: EvaluateOptions): readonly TarstateDiagnostic[] {
  const result = evaluateConstraintQuery(source, constraint.query, options);
  const diagnostics: TarstateDiagnostic[] = [...result.diagnostics];
  const seen = new Map<string, unknown>();
  const relationName = constraintRelationName(constraint.query);
  for (const rowValue of result.rows) {
    if (!isRecord(rowValue)) continue;
    const key = stableKey(constraint.fields.map((fieldName) => rowValue[fieldName]));
    if (seen.has(key)) {
      diagnostics.push({
        code: 'unique',
        severity: 'error',
        message: `unique constraint failed for fields ${constraint.fields.join(', ')}`,
        ...(relationName === undefined ? {} : { relation: relationName }),
        ...(constraint.fields.length === 1 ? { field: constraint.fields[0] } : {}),
        surface: 'validateConstraints',
        detail: rowValue
      });
    }
    seen.set(key, rowValue);
  }
  return diagnostics;
}

function validateForeignKeyConstraint(source: RelationSource, constraint: ForeignKeyConstraintData, options: EvaluateOptions): readonly TarstateDiagnostic[] {
  const result = evaluateConstraintQuery(source, constraint.query, options);
  const targetRows = source.rows(constraint.target).filter(isRecord);
  const targetKeys = new Set(targetRows.map((rowValue) => stableKey(constraint.targetFields.map((fieldName) => rowValue[fieldName]))));
  const diagnostics: TarstateDiagnostic[] = [...result.diagnostics];
  const relationName = constraintRelationName(constraint.query);

  for (const rowValue of result.rows) {
    if (!isRecord(rowValue)) continue;
    const values = constraint.fields.map((fieldName) => rowValue[fieldName]);
    if (values.some((valueValue) => valueValue === undefined || valueValue === null)) continue;
    if (!targetKeys.has(stableKey(values))) {
      diagnostics.push({
        code: 'foreign_key',
        severity: 'error',
        message: `foreign key constraint failed for fields ${constraint.fields.join(', ')}`,
        ...(relationName === undefined ? { relation: constraint.target.name } : { relation: relationName }),
        ...(constraint.fields.length === 1 ? { field: constraint.fields[0] } : {}),
        surface: 'validateConstraints',
        detail: rowValue
      });
    }
  }
  return diagnostics;
}

function validateCheckConstraint(source: RelationSource, constraint: CheckConstraintData, options: EvaluateOptions): readonly TarstateDiagnostic[] {
  const queryValue = constraint.query ?? constRows([{}]);
  const diagnostics: TarstateDiagnostic[] = [];
  const entries = evaluateConstraintEntries(source, queryValue, options, diagnostics);
  const relationName = constraintRelationName(queryValue);
  const fieldName = checkConstraintField(constraint.predicate);
  for (const entry of entries) {
    if (!evaluateExpr(constraint.predicate, entry, source, isQuery(queryValue) ? queryValue.relations : {}, options, diagnostics, undefined)) {
      diagnostics.push({
        code: 'check',
        severity: 'error',
        message: 'check constraint failed',
        ...(relationName === undefined ? {} : { relation: relationName }),
        ...(fieldName === undefined ? {} : { field: fieldName }),
        surface: 'validateConstraints',
        detail: entry.row
      });
    }
  }
  return diagnostics;
}

function constraintRelationName(queryValue: Query | RelationRef): string | undefined {
  if (isRelationRef(queryValue)) return queryValue.name;
  const dependencies = relationDependencies(queryValue);
  return dependencies.length === 1 ? dependencies[0] : undefined;
}

function checkConstraintField(predicate: PredicateData): string | undefined {
  if (predicate.op === 'gt' || predicate.op === 'gte' || predicate.op === 'lt' || predicate.op === 'lte' || predicate.op === 'eq' || predicate.op === 'neq') {
    const left = predicate.left;
    return isExpr(left) && left.op === 'field' && typeof left.field === 'string' ? left.field : undefined;
  }
  return undefined;
}

function evaluateConstraintQuery(source: RelationSource, queryValue: Query | RelationRef, options: EvaluateOptions): QueryResult<unknown> {
  return evaluate(source, queryForTarget(queryValue), options);
}

function evaluateConstraintEntries(
  source: RelationSource,
  queryValue: Query | RelationRef,
  options: EvaluateOptions,
  diagnostics: TarstateDiagnostic[]
): readonly EvalEntry[] {
  const queryObject = queryForTarget(queryValue);
  return evaluateQueryData(source, queryObject.data, queryObject.relations, options, undefined, diagnostics);
}

function flattenConstraints(input: ConstraintValidationInput | undefined): readonly ConstraintData[] {
  if (input === undefined) return [];
  return Array.isArray(input) ? input.flatMap((item) => flattenConstraints(item)) : [input as ConstraintData];
}

function applyCascadeDeletes(
  dbValue: Db,
  constraints: readonly ConstraintData[],
  newDeltas: readonly RelationDelta[],
  allDeltas: RelationDelta[]
): Db {
  let current = dbValue;
  for (const constraint of constraints) {
    if (constraint.op !== 'fk' || constraint.cascade !== 'delete' || !isRelationRef(constraint.query)) continue;
    if (constraint.fields.length === 0) continue;
    for (const delta of newDeltas) {
      if (delta.relation.name !== constraint.target.name || delta.removed.length === 0) continue;
      for (const removedRow of delta.removed) {
        if (!isRecord(removedRow)) continue;
        const predicate = and(...constraint.fields.map((fieldName, indexValue) =>
          eq(field('row', fieldName), value(removedRow[constraint.targetFields[indexValue] ?? ''] as PrimitiveValue))));
        const result = applyWritePatchToDb(current, deleteRows(constraint.query, predicate));
        current = result.db;
        allDeltas.push(...result.deltas);
      }
    }
  }
  return current;
}

function addMaterializationInput(
  target: unknown,
  state: InternalMaterializationState,
  input: MaterializationInput
): InternalMaterializationState {
  if (isQuery(input)) {
    return addMaterializationMetadata(target, state, materializationMetadata(input));
  }
  if (isMaterializationMetadata(input)) {
    return addMaterializationMetadata(target, state, input);
  }
  const constraints = [...state.constraints, ...flattenConstraints(input as ConstraintValidationInput)];
  return { ...state, constraints: dedupeConstraints(constraints) };
}

function addMaterializationMetadata(
  target: unknown,
  state: InternalMaterializationState,
  metadata: MaterializationMetadata
): InternalMaterializationState {
  const rows = new Map(state.rows);
  const refresh = refreshMaterializationRows(target, metadata.query);
  rows.set(metadata.id, refresh.rows);
  const aux = new Map(state.aux);
  const materializationAux = materializationAuxForRows(
    target,
    metadata.query,
    refresh.rows,
    materializationAuxForTarget(target, metadata.query)
  );
  if (materializationAux === undefined) aux.delete(metadata.id);
  else aux.set(metadata.id, materializationAux);
  return {
    metadata: [...state.metadata.filter((item) => item.id !== metadata.id), metadata],
    rows,
    aux,
    constraints: state.constraints
  };
}

function materializationMetadata<Row>(query: Query<Row>, options: MaterializationOptions = {}): MaterializationMetadata<Row> {
  const key = queryKey(query);
  return {
    id: options.id ?? materializationIdForQuery(query),
    query,
    queryKey: key,
    mode: options.mode ?? 'snapshot'
  };
}

function materializationIdForQuery<Row>(query: Query<Row>): string {
  return `query:${queryKey(query)}`;
}

function materializationAuxForTarget<Row>(target: unknown, query: Query<Row>): InternalMaterializationAux | undefined {
  const support = incrementalMaterializationSupport(query);
  if (!support.supported || support.topN === undefined) return undefined;
  const preLimitQuery = { data: support.topN.preLimitData, relations: query.relations } as Query<Row>;
  return { topNPreLimitRows: refreshMaterializationRows(target, preLimitQuery).rows };
}

function materializationAuxForRows<Row>(
  target: unknown,
  query: Query<Row>,
  rows: readonly Row[],
  existingAux?: InternalMaterializationAux
): InternalMaterializationAux | undefined {
  const topNPreLimitRows = existingAux?.topNPreLimitRows ?? materializationAuxForTarget(target, query)?.topNPreLimitRows;
  const indexes = materializationIndexesForRows(query, rows);
  if (topNPreLimitRows === undefined && indexes === undefined) return undefined;
  return {
    ...(topNPreLimitRows === undefined ? {} : { topNPreLimitRows }),
    ...(indexes === undefined ? {} : { indexes })
  };
}

function withMaterializationMaintenanceAux<Row>(
  result: MaterializationMaintenanceResult<Row>,
  aux: ReadonlyMap<string, InternalMaterializationAux>
): MaterializationMaintenanceResult<Row> {
  Object.defineProperty(result, MATERIALIZATION_MAINTENANCE_AUX, {
    value: aux,
    enumerable: false,
    configurable: true
  });
  return result;
}

function materializationMaintenanceAuxFor<Row>(
  maintenance: MaterializationMaintenanceResult<Row>
): ReadonlyMap<string, InternalMaterializationAux> | undefined {
  return (maintenance as InternalMaterializationMaintenanceAux<Row>)[MATERIALIZATION_MAINTENANCE_AUX];
}

function materializedStateFor(input: unknown): InternalMaterializationState {
  if (!isRecord(input)) return EMPTY_MATERIALIZATION_STATE;
  const state = (input as { [MATERIALIZATION_STATE]?: InternalMaterializationState })[MATERIALIZATION_STATE];
  return state ?? EMPTY_MATERIALIZATION_STATE;
}

function attachedWatchTargetsFor(input: unknown): readonly WatchTarget[] {
  if (!isRecord(input)) return [];
  return (input as { [ATTACHED_WATCH_TARGETS]?: readonly WatchTarget[] })[ATTACHED_WATCH_TARGETS] ?? [];
}

function withAttachedWatchTargets<DbValue extends Db>(input: DbValue, targets: readonly WatchTarget[]): DbValue {
  const output = { ...input } as DbValue & { [ATTACHED_WATCH_TARGETS]?: readonly WatchTarget[] };
  Object.defineProperty(output, ATTACHED_WATCH_TARGETS, {
    value: targets,
    enumerable: false,
    configurable: true
  });
  return output;
}

function uniqueWatchTargets(targets: readonly WatchTarget[]): readonly WatchTarget[] {
  const seen = new Set<string>();
  const result: WatchTarget[] = [];
  for (const target of targets) {
    const key = watchTargetKey(target);
    if (!seen.has(key)) {
      seen.add(key);
      result.push(target);
    }
  }
  return result;
}

function materializedConstraintsFor(input: unknown): readonly ConstraintData[] {
  return materializedStateFor(input).constraints;
}

function withMaterializedState<DbValue extends object>(input: DbValue, state: InternalMaterializationState): DbValue & MaterializedDb {
  const output = {
    ...input,
    ...(state.metadata.length === 0 ? {} : { materialized: state.metadata })
  } as DbValue & MaterializedDb & { [MATERIALIZATION_STATE]?: InternalMaterializationState };
  Object.defineProperty(output, MATERIALIZATION_STATE, {
    value: state,
    enumerable: false,
    configurable: true
  });
  return output;
}

function emptyMaterializationState(): InternalMaterializationState {
  return { metadata: [], rows: new Map(), aux: new Map(), constraints: [] };
}

function applyMaterializationState(dbValue: Db, previous: InternalMaterializationState, maintenance: MaterializationMaintenanceResult): Db {
  if (previous.metadata.length === 0 && previous.constraints.length === 0) return dbValue;
  const rows = new Map(previous.rows);
  for (const change of maintenance.changes) rows.set(change.id, change.rows);
  const aux = new Map(materializationMaintenanceAuxFor(maintenance) ?? previous.aux);
  return withMaterializedState(dbValue, {
    metadata: previous.metadata,
    rows,
    aux,
    constraints: previous.constraints
  });
}

function refreshMaterializationRows<Row>(target: unknown, query: Query<Row>): MaterializationRefreshResult<Row> {
  if (isDb(target)) return qResult(demat(target, query), query);
  if (isRelationSource(target)) return evaluate(target, query);
  return {
    rows: [],
    diagnostics: [{
      code: 'materialization_unsupported',
      severity: 'warning',
      message: 'materialization target is not readable',
      surface: 'materialization'
    }]
  };
}

function isMaterializationMetadata(input: unknown): input is MaterializationMetadata {
  return isRecord(input)
    && typeof input.id === 'string'
    && isQuery(input.query)
    && typeof input.queryKey === 'string'
    && (input.mode === 'snapshot' || input.mode === 'incremental');
}

function isMaterializationMaintenanceChange(input: unknown): input is MaterializationMaintenanceChange {
  return isRecord(input)
    && typeof input.id === 'string'
    && typeof input.queryKey === 'string'
    && isQuery(input.query)
    && (input.update === 'skipped' || input.update === 'carried' || input.update === 'recomputed' || input.update === 'incremental')
    && Array.isArray(input.rows)
    && Array.isArray(input.rowChanges);
}

function constraintKey(input: ConstraintData): string {
  return encodeQueryKeyValue(input, '$constraint');
}

function dedupeConstraints(constraints: readonly ConstraintData[]): readonly ConstraintData[] {
  const seen = new Set<string>();
  const result: ConstraintData[] = [];
  for (const constraint of constraints) {
    const key = constraintKey(constraint);
    if (!seen.has(key)) {
      seen.add(key);
      result.push(constraint);
    }
  }
  return result;
}

function fieldValueMatchesSpec(spec: FieldSpec, valueValue: unknown): boolean {
  switch (spec.valueKind) {
    case 'string':
    case 'id':
    case 'ref':
    case 'anchoredPath':
      return typeof valueValue === 'string';
    case 'number':
      return typeof valueValue === 'number' && Number.isFinite(valueValue);
    case 'boolean':
      return typeof valueValue === 'boolean';
    case 'json':
      return isJsonValue(valueValue);
    default:
      return true;
  }
}

function fieldSpecDescription(spec: FieldSpec): string {
  switch (spec.valueKind) {
    case 'id':
    case 'ref':
    case 'anchoredPath':
      return 'a string';
    case 'json':
      return 'a JSON value';
    default:
      return `a ${spec.valueKind}`;
  }
}

function relationKeyFields(relationRef: RelationRef): readonly string[] {
  return Array.isArray(relationRef.key) ? [...relationRef.key] : [relationRef.key as string];
}

function isErrorDiagnostic(input: TarstateDiagnostic): boolean {
  return input.severity === 'error';
}

function stableKey(input: unknown): string {
  if (input === undefined) return '~undefined';
  if (typeof input === 'number') {
    if (Number.isNaN(input)) return '~number:NaN';
    if (input === Infinity) return '~number:Infinity';
    if (input === -Infinity) return '~number:-Infinity';
    if (Object.is(input, -0)) return '~number:-0';
    return JSON.stringify(input);
  }
  if (input === null || typeof input === 'string' || typeof input === 'boolean') return JSON.stringify(input);
  if (typeof input === 'bigint') return `~bigint:${input.toString()}`;
  if (typeof input === 'symbol') return `~symbol:${String(input.description)}`;
  if (typeof input === 'function') return `~function:${input.name}`;
  if (Array.isArray(input)) return `[${input.map(stableKey).join(',')}]`;
  if (isRecord(input)) {
    return `{${Object.keys(input).sort().map((key) => `${JSON.stringify(key)}:${stableKey(input[key])}`).join(',')}}`;
  }
  return JSON.stringify(String(input as string | number | boolean | bigint | null | undefined));
}

function queryAliasData(query: Query<unknown>, name: string): Record<string, string> {
  return 'alias' in query && typeof query.alias === 'string' ? { [name]: query.alias } : {};
}

function queryDataDependencies(data: QueryData): readonly string[] {
  switch (data.op) {
    case 'from':
    case 'lookup':
      return typeof data.relation === 'string' ? [data.relation] : [];
    case 'join':
      return uniqueStrings(
        nestedDependencies(data.left),
        nestedDependencies(data.right),
        exprDependencies(data.on)
      );
    case 'union':
    case 'intersection':
      return uniqueStrings(...queryDataArray(data.inputs).map(queryDataDependencies));
    case 'difference':
      return uniqueStrings(nestedDependencies(data.left), nestedDependencies(data.right));
    default:
      return uniqueStrings(nestedDependencies(data.input), exprDependencies(data), projectionDependencies(data.projection), projectionDependencies(data.groupBy), projectionDependencies(data.aggregates));
  }
}

function nestedDependencies(input: unknown): readonly string[] {
  const data = queryDataFrom(input);
  return data === undefined ? [] : queryDataDependencies(data);
}

function projectionDependencies(input: unknown): readonly string[] {
  if (!isRecord(input)) return [];
  return uniqueStrings(...Object.values(input).map(exprDependencies));
}

function exprDependencies(input: unknown): readonly string[] {
  if (!isRecord(input)) return [];
  const dependencies: (readonly string[])[] = Object.entries(input).map(([key, valueValue]) => {
    if (key === 'query') {
      const data = queryDataFrom(valueValue);
      return data === undefined ? [] : queryDataDependencies(data);
    }
    if (Array.isArray(valueValue)) return uniqueStrings(...valueValue.map(exprDependencies));
    return exprDependencies(valueValue);
  });
  return uniqueStrings(...dependencies);
}

function queryDataRowKeyFields(data: QueryData, relations: Readonly<Record<string, AnyRelationRef>> = {}): readonly string[] | undefined {
  return rowIdentityForQueryData(data, relations)?.fields;
}

function rowIdentityForQueryData<Row = unknown>(
  data: QueryData,
  relations: Readonly<Record<string, AnyRelationRef>>
): MaterializationRowIdentity<Row> | undefined {
  switch (data.op) {
    case 'from':
    case 'lookup': {
      const relationName = typeof data.relation === 'string' ? data.relation : undefined;
      const relationRef = relationName === undefined ? undefined : relations[relationName];
      if (relationRef === undefined) return undefined;
      return rowIdentityFromPaths(relationKeyFields(relationRef as RelationRef).map((fieldName) => [fieldName]), { unique: true });
    }
    case 'where':
    case 'hash':
    case 'btree':
    case 'uniqueIndex':
    case 'sort':
    case 'limit':
    case 'sortLimit':
      return rowIdentityForNestedQuery<Row>(data, relations);
    case 'keyBy': {
      const fields = stringArray(data.fields);
      return fields.length === 0 ? undefined : rowIdentityFromPaths(fields.map((fieldName) => [fieldName]));
    }
    case 'extend':
      return rowIdentityForNestedQuery<Row>(data, relations);
    case 'without': {
      const input = rowIdentityForNestedQuery<Row>(data, relations);
      if (input === undefined) return undefined;
      const removed = new Set(stringArray(data.fields));
      return input.paths.some((path) => removed.has(path[0] ?? '')) ? undefined : input;
    }
    case 'rename': {
      const input = rowIdentityForNestedQuery<Row>(data, relations);
      if (input === undefined) return undefined;
      const fields = isRecord(data.fields) ? data.fields : {};
      const paths = input.paths.map((path) => {
        const [first, ...rest] = path;
        if (first === undefined) return path;
        const renamed = fields[first];
        return [typeof renamed === 'string' ? renamed : first, ...rest];
      });
      return rowIdentityFromPaths(paths, { unique: input.unique });
    }
    case 'qualify': {
      const input = rowIdentityForNestedQuery<Row>(data, relations);
      if (input === undefined) return undefined;
      const alias = typeof data.alias === 'string' ? data.alias : 'row';
      return rowIdentityFromPaths(input.paths.map((path) => [alias, ...path]), { unique: input.unique });
    }
    case 'project':
      return projectedRowIdentity<Row>(data, relations);
    case 'aggregate':
      return aggregateGroupIdentityForData<Row>(data);
    default:
      return undefined;
  }
}

function rowIdentityForNestedQuery<Row>(
  data: QueryData,
  relations: Readonly<Record<string, AnyRelationRef>>
): MaterializationRowIdentity<Row> | undefined {
  const input = queryDataFrom(data.input);
  return input === undefined ? undefined : rowIdentityForQueryData(input, relations);
}

function joinMaterializedRowIdentity<Row>(
  data: QueryData,
  relations: Readonly<Record<string, AnyRelationRef>>,
  joinShape: IncrementalJoinShape
): MaterializationRowIdentity<Row> | undefined {
  const finalFields = finalRowFieldExpressions(data, relations);
  if (finalFields.size === 0) return undefined;

  const paths: MaterializationRowKeyPath[] = [];
  for (const exprData of joinIdentityFieldExpressions(joinShape)) {
    const fieldName = directFinalFieldForExpr(exprData, finalFields);
    if (fieldName === undefined) return undefined;
    paths.push([fieldName]);
  }

  const fieldNames = paths.map((path) => path[0] as string);
  if (new Set(fieldNames).size !== fieldNames.length) return undefined;
  return rowIdentityFromPaths<Row>(paths, { unique: true });
}

function joinIdentityFieldExpressions(joinShape: IncrementalJoinShape): readonly ExprData[] {
  return [
    ...relationKeyFields(joinShape.left.relation).map((fieldName) => field(joinShape.left.alias, fieldName)),
    ...relationKeyFields(joinShape.right.relation).map((fieldName) => field(joinShape.right.alias, fieldName))
  ];
}

function directFinalFieldForExpr(exprData: ExprData, finalFields: ReadonlyMap<string, ExprData>): string | undefined {
  const key = stableKey(exprData);
  for (const [fieldName, finalExpr] of finalFields) {
    if (stableKey(finalExpr) === key) return fieldName;
  }
  return undefined;
}

function projectedRowIdentity<Row>(
  data: QueryData,
  relations: Readonly<Record<string, AnyRelationRef>>
): MaterializationRowIdentity<Row> | undefined {
  const input = rowIdentityForNestedQuery(data, relations);
  if (input === undefined) return undefined;

  const projection = projectionFrom(data.projection);
  const paths: MaterializationRowKeyPath[] = [];
  for (const path of input.paths) {
    if (path.length !== 1) return undefined;
    const outputField = directProjectionFieldFor(path[0] as string, projection);
    if (outputField === undefined) return undefined;
    paths.push([outputField]);
  }

  return rowIdentityFromPaths<Row>(paths, { unique: input.unique });
}

function directProjectionFieldFor(inputField: string, projection: ProjectionData): string | undefined {
  return directProjectionFieldForAlias(inputField, projection);
}

function directProjectionFieldForAlias(inputField: string, projection: ProjectionData, alias?: string): string | undefined {
  for (const [outputField, projectionExpr] of Object.entries(projection)) {
    const exprValue = unwrapOptionalProjection(projectionExpr);
    if (
      isRecord(exprValue)
      && exprValue.op === 'field'
      && exprValue.field === inputField
      && (alias === undefined || exprValue.alias === alias)
    ) return outputField;
  }
  return undefined;
}

function aggregateGroupIdentityForData<Row = unknown>(data: QueryData): MaterializationRowIdentity<Row> | undefined {
  const fields = projectionFieldNames(data.groupBy);
  return fields.length === 0 ? undefined : rowIdentityFromPaths<Row>(fields.map((fieldName) => [fieldName]), { unique: true });
}

function aggregateGroupIdentityForFinalData<Row = unknown>(
  data: QueryData,
  relations: Readonly<Record<string, AnyRelationRef>>
): MaterializationRowIdentity<Row> | undefined {
  switch (data.op) {
    case 'aggregate':
      return aggregateGroupIdentityForData<Row>(data);
    case 'where':
    case 'hash':
    case 'btree':
    case 'uniqueIndex':
    case 'sort':
    case 'keyBy':
      return aggregateGroupIdentityForNestedFinalData<Row>(data, relations);
    case 'extend': {
      const input = aggregateGroupIdentityForNestedFinalData<Row>(data, relations);
      if (input === undefined) return undefined;
      const projection = projectionFrom(data.projection);
      return input.paths.some((path) => path.length === 1 && Object.prototype.hasOwnProperty.call(projection, path[0] ?? ''))
        ? undefined
        : input;
    }
    case 'without': {
      const input = aggregateGroupIdentityForNestedFinalData<Row>(data, relations);
      if (input === undefined) return undefined;
      const removed = new Set(stringArray(data.fields));
      return input.paths.some((path) => removed.has(path[0] ?? '')) ? undefined : input;
    }
    case 'rename': {
      const input = aggregateGroupIdentityForNestedFinalData<Row>(data, relations);
      if (input === undefined) return undefined;
      const fields = isRecord(data.fields) ? data.fields : {};
      return rowIdentityFromPaths<Row>(input.paths.map((path) => {
        const [first, ...rest] = path;
        if (first === undefined) return path;
        const renamed = fields[first];
        return [typeof renamed === 'string' ? renamed : first, ...rest];
      }), { unique: input.unique });
    }
    case 'qualify': {
      const input = aggregateGroupIdentityForNestedFinalData<Row>(data, relations);
      if (input === undefined) return undefined;
      const alias = typeof data.alias === 'string' ? data.alias : 'row';
      return rowIdentityFromPaths<Row>(input.paths.map((path) => [alias, ...path]), { unique: input.unique });
    }
    case 'project': {
      const input = aggregateGroupIdentityForNestedFinalData<Row>(data, relations);
      if (input === undefined) return undefined;
      const projection = projectionFrom(data.projection);
      const paths: MaterializationRowKeyPath[] = [];
      for (const path of input.paths) {
        if (path.length !== 1) return undefined;
        const outputField = directProjectionFieldForAlias(path[0] as string, projection, 'row');
        if (outputField === undefined) return undefined;
        paths.push([outputField]);
      }
      return rowIdentityFromPaths<Row>(paths, { unique: input.unique });
    }
    default:
      return undefined;
  }
}

function aggregateGroupIdentityForNestedFinalData<Row>(
  data: QueryData,
  relations: Readonly<Record<string, AnyRelationRef>>
): MaterializationRowIdentity<Row> | undefined {
  const input = queryDataFrom(data.input);
  return input === undefined ? undefined : aggregateGroupIdentityForFinalData<Row>(input, relations);
}

function rowIdentityFromPaths<Row = unknown>(
  paths: readonly MaterializationRowKeyPath[],
  options: { readonly unique?: boolean } = {}
): MaterializationRowIdentity<Row> | undefined {
  if (paths.length === 0) return undefined;
  return {
    paths,
    fields: paths.every((path) => path.length === 1) ? paths.map((path) => path[0] as string) : undefined,
    keyBy: (rowValue) => paths.map((path) => valueAtPath(rowValue, path)),
    keyOf: (rowValue) => rowIdentityKey(rowValue, paths),
    unique: options.unique === true
  };
}

function rowIdentityKey(input: unknown, paths: readonly MaterializationRowKeyPath[]): string {
  return stableKey(paths.map((path) => valueAtPath(input, path)));
}

function valueAtPath(input: unknown, path: readonly string[]): unknown {
  let current = input;
  for (const fieldName of path) {
    if (!isRecord(current)) return undefined;
    current = current[fieldName];
  }
  return current;
}

function queryEnvDependencies(query: Query): readonly string[] {
  return envDependenciesFromData(query.data);
}

function envDependenciesFromData(data: unknown): readonly string[] {
  if (!isRecord(data)) return [];
  const names: string[] = [];
  if (data.op === 'env' && typeof data.name === 'string') names.push(data.name);
  for (const valueValue of Object.values(data)) {
    if (Array.isArray(valueValue)) {
      for (const item of valueValue) names.push(...envDependenciesFromData(item));
    } else {
      names.push(...envDependenciesFromData(valueValue));
    }
  }
  return uniqueStrings(names);
}

function addRevisionToBatch<Queries extends QueryBatch>(result: QueryBatchResult<Queries>, revision: number): StoreQueryBatchResult<Queries> {
  return Object.fromEntries(Object.entries(result).map(([name, valueValue]) => [name, { ...valueValue, revision }])) as StoreQueryBatchResult<Queries>;
}

function dbFromSource(source: RelationSource, relations: readonly RelationRef[], envValue: DbInputEnv | undefined): Db {
  return createDb(
    Object.fromEntries(relations.map((relationRef) => [relationRef.name, source.rows(relationRef)])),
    envValue === undefined ? {} : { env: envValue }
  );
}

function readWatchTargetRows<Row>(dbValue: WatchDb, target: WatchTarget<Row>, options: WatchOptions<Row> | QueryDiffOptions<Row> = {}): QueryResult<Row> {
  if (isDb(dbValue)) return qResult(dbValue, queryForTarget(target), options);
  return evaluate(dbValue, queryForTarget(target), options);
}

function toWatchDiagnostic(input: TarstateDiagnostic): WatchDiagnostic {
  return {
    code: input.code,
    message: input.message,
    ...(input.severity === undefined ? {} : { severity: input.severity }),
    ...(input.relation === undefined ? {} : { relation: input.relation }),
    ...(input.field === undefined ? {} : { field: input.field }),
    surface: input.surface === 'changeTracking' ? 'changeTracking' : 'watch',
    ...(input.detail === undefined ? {} : { detail: input.detail })
  };
}

function toTrackChangeView<Row>(change: TrackedChange<Row>): TrackTransactChangeView<Row> {
  return {
    targetKey: change.targetKey,
    target: change.target,
    added: change.added,
    removed: change.removed,
    unchanged: change.unchanged,
    rowChanges: change.rowChanges
  };
}

function isTrackTransactOptions(input: unknown): input is TrackTransactOptions {
  return isRecord(input)
    && !isWritePatch(input)
    && !isSetEnvTransaction(input)
    && ('label' in input || 'mode' in input || 'throwOnUnsupported' in input);
}

function trackOptionsFromInputs(inputs: readonly unknown[]): TrackTransactOptions {
  const last = inputs[inputs.length - 1];
  return isTrackTransactOptions(last) ? last : {};
}

function unsupportedTrackTransactResult<DbValue extends WatchDb>(dbValue: DbValue, options: TrackTransactOptions): TrackTransactResult<DbValue> {
  return {
    db: dbValue,
    supported: false,
    changes: [],
    changeMap: new Map(),
    changesByTarget: new Map(),
    changesByTargetKey: new Map(),
    changesByQueryKey: {},
    deltas: [],
    diagnostics: [{
      code: 'change_tracking_unsupported',
      severity: 'error',
      message: 'change tracking requires a Db input',
      surface: 'trackTransact'
    }],
    ...(options.label === undefined ? {} : { label: options.label })
  };
}

function relationFromSourceName(name: string): RelationRef | undefined {
  return {
    kind: 'relation',
    name,
    key: [],
    fields: {},
    ephemeral: false
  } as RelationRef;
}

function expr(input: ExprInput | SortInput): ExprData {
  return isExpr(input) ? input : value(input as PrimitiveValue);
}

function isExpr(input: unknown): input is ExprData {
  return isRecord(input) && typeof input.op === 'string';
}

function aggregateCall<Value = unknown>(op: AggregateFunction, ...args: readonly unknown[]): AggregateExprData<Value> {
  return { op: 'aggregateCall', fn: op, args } as unknown as AggregateExprData<Value>;
}

const ALIASED_FIELD_RESERVED_KEYS = new Set<string>([
  'kind',
  'name',
  'key',
  'fields',
  'ephemeral',
  '__row',
  'data',
  'relations',
  'alias',
  '$'
]);

function defineAliasProperty(target: Record<string, unknown>, name: string, value: unknown): void {
  Object.defineProperty(target, name, {
    value,
    enumerable: true,
    configurable: true,
    writable: false
  });
}

function aliasedFieldNames(input: AnyRelationRef | Query): readonly string[] {
  if (isQuery(input)) return queryFieldNames(input);
  return Object.keys(input.fields);
}

function queryFieldNames(query: Query): readonly string[] {
  return queryDataFieldNames(query.data, query.relations);
}

function queryDataFieldNames(data: QueryData, relations: Readonly<Record<string, AnyRelationRef>>): readonly string[] {
  switch (data.op) {
    case 'from':
    case 'lookup':
      return typeof data.relation === 'string' ? relationFieldNames(relations[data.relation]) : [];
    case 'constRows':
      return rowFieldNames(data.rows);
    case 'project':
      return projectionFieldNames(data.projection);
    case 'aggregate':
      return uniqueStrings(projectionFieldNames(data.groupBy), projectionFieldNames(data.aggregates));
    case 'extend':
      return uniqueStrings(inputFieldNames(data, relations), projectionFieldNames(data.projection));
    case 'where':
    case 'hash':
    case 'btree':
    case 'keyBy':
    case 'sort':
    case 'limit':
    case 'sortLimit':
      return inputFieldNames(data, relations);
    case 'join':
      return uniqueStrings(nestedQueryFieldNames(data.left, relations), nestedQueryFieldNames(data.right, relations));
    case 'union':
    case 'intersection':
      return Array.isArray(data.inputs)
        ? uniqueStrings(...data.inputs.map((input) => nestedQueryFieldNames(input, relations)))
        : [];
    case 'difference':
      return nestedQueryFieldNames(data.left, relations);
    case 'without': {
      const removed = new Set(stringArray(data.fields));
      return inputFieldNames(data, relations).filter((fieldName) => !removed.has(fieldName));
    }
    case 'rename':
      return renamedFieldNames(inputFieldNames(data, relations), data.fields);
    case 'expand':
      return uniqueStrings(
        inputFieldNames(data, relations),
        typeof data.as === 'string' ? [data.as] : [],
        stringArray(data.fields)
      );
    case 'qualify':
      return typeof data.alias === 'string' ? [data.alias] : [];
    default:
      return [];
  }
}

function inputFieldNames(data: QueryData, relations: Readonly<Record<string, AnyRelationRef>>): readonly string[] {
  return nestedQueryFieldNames(data.input, relations);
}

function nestedQueryFieldNames(data: unknown, relations: Readonly<Record<string, AnyRelationRef>>): readonly string[] {
  const queryData = queryDataFrom(data);
  return queryData === undefined ? [] : queryDataFieldNames(queryData, relations);
}

function queryDataFrom(data: unknown): QueryData | undefined {
  return isRecord(data) && typeof data.op === 'string' ? data as QueryData : undefined;
}

function relationFieldNames(relationRef: unknown): readonly string[] {
  return isRelationRef(relationRef) ? Object.keys(relationRef.fields) : [];
}

function projectionFieldNames(projection: unknown): readonly string[] {
  return isRecord(projection) ? Object.keys(projection) : [];
}

function rowFieldNames(rows: unknown): readonly string[] {
  return Array.isArray(rows)
    ? uniqueStrings(...rows.map((rowValue) => isRecord(rowValue) ? Object.keys(rowValue) : []))
    : [];
}

function renamedFieldNames(inputFields: readonly string[], fields: unknown): readonly string[] {
  if (!isRecord(fields)) return inputFields;
  return inputFields.map((fieldName) => {
    const renamed = fields[fieldName];
    return typeof renamed === 'string' ? renamed : fieldName;
  });
}

function stringArray(input: unknown): readonly string[] {
  return Array.isArray(input) && input.every((item) => typeof item === 'string') ? input : [];
}

function uniqueStrings(...groups: readonly (readonly string[])[]): readonly string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const group of groups) {
    for (const item of group) {
      if (!seen.has(item)) {
        seen.add(item);
        result.push(item);
      }
    }
  }
  return result;
}

function mergeRelations(inputs: readonly Query[]): Record<string, RelationRef> {
  return Object.assign({}, ...inputs.map((input) => input.relations));
}

function arrayify(input: ConstraintRelationFields): readonly string[] {
  return typeof input === 'string' ? [input] : input;
}

function isRelationRef(input: unknown): input is RelationRef {
  return isRecord(input) && input.kind === 'relation' && typeof input.name === 'string';
}

function isQuery(input: unknown): input is Query {
  return isRecord(input) && isRecord(input.data) && isRecord(input.relations);
}

function isDb(input: unknown): input is Db {
  return isRecord(input) && isRecord(input.data) && isRecord(input.env);
}

function dbEnvFromOptions(options: DbOptions): DbInputEnv {
  return isRecord(options.env) ? options.env : EMPTY_DB_ENV;
}

function isDiagnostic(input: unknown): input is TarstateDiagnostic {
  return isRecord(input)
    && typeof input.code === 'string'
    && (input.severity === undefined || isDiagnosticSeverity(input.severity))
    && typeof input.message === 'string';
}

function isDiagnosticSeverity(input: unknown): input is TarstateDiagnosticSeverity {
  return input === 'info' || input === 'warning' || input === 'error';
}

function encodeQueryKeyValue(input: unknown, path: string): string {
  if (input === null || typeof input === 'string' || typeof input === 'boolean') return JSON.stringify(input);
  if (typeof input === 'number') {
    if (!Number.isFinite(input)) throw new QueryKeyError(path, input, 'a non-finite number');
    return JSON.stringify(input);
  }
  if (input === undefined) return '~undefined';
  if (typeof input === 'function') throw new QueryKeyError(path, input, 'a raw function');
  if (typeof input === 'bigint') throw new QueryKeyError(path, input, 'a bigint');
  if (typeof input === 'symbol') throw new QueryKeyError(path, input, 'a symbol');
  if (Array.isArray(input)) return `[${input.map((item, index) => encodeQueryKeyValue(item, `${path}[${index}]`)).join(',')}]`;
  if (isHostFunction(input)) {
    return `{"kind":"hostFunction","name":${encodeQueryKeyValue(input.name, `${path}.name`)}}`;
  }
  if (!isPlainRecord(input)) throw new QueryKeyError(path, input, 'a non-plain object');

  return `{${Object.keys(input)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${encodeQueryKeyValue(input[key], `${path}.${key}`)}`)
    .join(',')}}`;
}

function isHostFunction(input: unknown): input is HostFunction {
  return isRecord(input)
    && input.kind === 'hostFunction'
    && typeof input.name === 'string'
    && typeof input.fn === 'function';
}

function isPlainRecord(input: unknown): input is Record<string, unknown> {
  return isRecord(input) && Object.getPrototypeOf(input) === Object.prototype;
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === 'object' && input !== null && !Array.isArray(input);
}

function watchDiagnostic(label: string): WatchDiagnostic {
  return { code: 'change_tracking_unsupported', severity: 'warning', message: `${label} is not attached to an active watch`, surface: 'watch' };
}
