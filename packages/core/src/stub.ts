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
export type ExprInput<Value = unknown> = ExprData<Value> | PrimitiveValue;
export type ComparisonOp = 'eq' | 'neq' | 'lt' | 'lte' | 'gt' | 'gte';
export type AggregateFunction =
  | 'count'
  | 'countDistinct'
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
  return queryDataRowKeyFields(data);
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
export const hash = (...expressions: readonly ExprData[]): PreserveQueryTransform => ((query) =>
  ({ ...query, data: { op: 'hash', input: query.data, expressions } })) as PreserveQueryTransform;
export const btree = (...expressions: readonly ExprData[]): PreserveQueryTransform => ((query) =>
  ({ ...query, data: { op: 'btree', input: query.data, expressions } })) as PreserveQueryTransform;
export const uniqueIndex = (...expressions: readonly ExprData[]): PreserveQueryTransform => ((query) =>
  ({ ...query, data: { op: 'hash', input: query.data, expressions, unique: true } })) as PreserveQueryTransform;
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
export const count = (): ExprData<number> => aggregateCall<number>('count');
export const countDistinct = (input?: ExprInput): ExprData<number> => aggregateCall<number>('countDistinct', input);
export const sum = (input: ExprInput<number>): ExprData<number> => aggregateCall<number>('sum', input);
export const avg = (input: ExprInput<number>): ExprData<number> => aggregateCall<number>('avg', input);
export const min = <Value = unknown>(input: ExprInput<Value>): ExprData<Value> => aggregateCall<Value>('min', input);
export const max = <Value = unknown>(input: ExprInput<Value>): ExprData<Value> => aggregateCall<Value>('max', input);
export const top = <Value = unknown>(input: ExprInput<Value>, countValue = 1): ExprData<readonly Value[]> => aggregateCall<readonly Value[]>('top', input, countValue);
export const bottom = <Value = unknown>(input: ExprInput<Value>, countValue = 1): ExprData<readonly Value[]> => aggregateCall<readonly Value[]>('bottom', input, countValue);
export const topBy = <Value = unknown>(input: ExprInput<Value>, by: ExprInput, countValue = 1): ExprData<readonly Value[]> => aggregateCall<readonly Value[]>('topBy', input, by, countValue);
export const bottomBy = <Value = unknown>(input: ExprInput<Value>, by: ExprInput, countValue = 1): ExprData<readonly Value[]> => aggregateCall<readonly Value[]>('bottomBy', input, by, countValue);
export const maxBy = <Row = unknown>(input: ExprInput<Row>, by: ExprInput): ExprData<Row> => aggregateCall<Row>('maxBy', input, by);
export const minBy = <Row = unknown>(input: ExprInput<Row>, by: ExprInput): ExprData<Row> => aggregateCall<Row>('minBy', input, by);
export const setConcat = <Value = unknown>(input: ExprInput<readonly Value[]>): ExprData<readonly Value[]> => aggregateCall<readonly Value[]>('setConcat', input);
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
  if (typeof options.keyBy === 'function') return JSON.stringify(options.keyBy(row));
  if (Array.isArray(options.keyBy) && isRecord(row)) return JSON.stringify(options.keyBy.map((fieldName) => row[fieldName]));
  return JSON.stringify(row);
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
export type DbTransactionPlan = {
  readonly inputs: DbTransactionInputs;
  readonly patches: readonly WritePatch[];
  readonly diagnostics: readonly TarstateDiagnostic[];
};
/**
 * Placeholder for the transaction-builder surface (patch/read helpers exposed
 * to transaction callbacks). The rewrite fills this in; it intentionally adds
 * no members yet so `DbTransactionContext` is currently just `Db`.
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
  if (materializedRows !== undefined) {
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

  for (const input of inputs) {
    const items = normalizeTransactionItem(resolveTransactionInput(input, workingDb));
    for (const item of items) {
      if (isSetEnvTransaction(item)) {
        workingDb = applySetEnvTransaction(workingDb, item);
        continue;
      }

      patches.push(item);
      const patchResult = applyWritePatchToDb(workingDb, item);
      diagnostics.push(...patchResult.diagnostics);

      if (patchResult.diagnostics.some(isErrorDiagnostic)) {
        diagnostics.push(...constraintDiagnosticsForInvalidPatch(item, materializedConstraintsFor(inputDb)));
        return {
          db: inputDb,
          patches: patches.length,
          applied,
          deltas,
          diagnostics,
          committed: false
        };
      }

      workingDb = patchResult.db;
      applied += patchResult.applied;
      deltas.push(...patchResult.deltas);
      workingDb = applyCascadeDeletes(workingDb, materializedConstraintsFor(inputDb), patchResult.deltas, deltas);
    }
  }

  const materializationConstraints = materializedConstraintsFor(inputDb);
  if (materializationConstraints.length > 0) {
    const validation = validateConstraintsSync(workingDb, materializationConstraints, { env: workingDb.env });
    diagnostics.push(...validation.diagnostics);
    if (!validation.valid) {
      return {
        db: inputDb,
        patches: patches.length,
        applied: 0,
        deltas: [],
        diagnostics,
        committed: false
      };
    }
  }

  const materializations = maintainMaterializationSnapshots(inputDb, workingDb, { deltas });
  diagnostics.push(...materializations.diagnostics);
  const committedDb = applyMaterializationState(workingDb, materializedStateFor(inputDb), materializations) as DbValue;

  return {
    db: committedDb,
    patches: patches.length,
    applied,
    deltas,
    diagnostics,
    committed: true,
    ...(materializations.maintained === 0 ? {} : { materializations })
  };
}
function normalizeTransactionInputs(inputOrInputs: DbTransactionInput | DbTransactionInputs): DbTransactionInputs {
  return (Array.isArray(inputOrInputs) ? inputOrInputs : [inputOrInputs]) as DbTransactionInputs;
}

export type RelationRow<Relation extends RelationRef> = Relation extends RelationRef<infer Row> ? Row : never;
export type RelationRowUpdate<Relation extends RelationRef> = Partial<RelationRow<Relation>>;
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
export type DeleteExactPatch<Relation extends RelationRef = RelationRef> = { readonly op: 'deleteExact'; readonly relation: Relation; readonly row: Partial<RelationRow<Relation>> };
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
  readonly deleteExact: (row: Partial<RelationRow<Relation>>) => DeleteExactPatch<Relation>;
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
export const deleteExact = <Relation extends RelationRef>(relationRef: Relation, rowValue: Partial<RelationRow<Relation>>): DeleteExactPatch<Relation> => ({ op: 'deleteExact', relation: relationRef, row: rowValue });
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
 * Placeholder for any db-like value that can carry materializations. The
 * rewrite narrows this; today `mat`/`demat` accept any object and return it
 * unchanged.
 */
export type MaterializableDb = object;
export type SnapshotMaterializationTarget = Db | RelationSource;
export type MaterializedDb = { readonly materialized?: readonly MaterializationMetadata[] };
export type MaterializationMode = 'snapshot' | 'incremental';
export type MaterializationMaintenanceKind = MaterializationMode;
export type MaterializationMaintenanceDecision = 'skipped' | 'carried' | 'recomputed' | 'incremental';
export type MaterializationIndexSpec = Readonly<Record<string, unknown>>;
export type MaterializationOptions = { readonly id?: string; readonly mode?: MaterializationMode };
export type SnapshotMaterializationOptions = MaterializationOptions;
export type MaterializationQueryBatch<Row = unknown> = Record<string, Query<Row>>;
export type MaterializationEnvDelta = {
  readonly name: string;
  readonly before: unknown;
  readonly after: unknown;
};
export type MaterializationMaintenanceOptions = { readonly deltas?: readonly RelationDelta[]; readonly envDeltas?: readonly unknown[] };
export type SnapshotRefreshTarget<Row = unknown> = string | MaterializationMetadata<Row> | Query<Row>;
export type MaterializedSourceOptions = EvaluateOptions;
export type MaterializationMetadata<Row = unknown> = {
  readonly id: string;
  readonly query: Query<Row>;
  readonly queryKey: string;
  readonly mode: MaterializationMode;
};
export type MaterializationExplanation<Row = unknown> = {
  readonly query: Query<Row>;
  readonly supported: boolean;
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
export type MaterializationIndex<Row = unknown> = Readonly<Record<string, unknown>> & { readonly rows?: readonly Row[] };
export type MaterializationNestedRows<Row = unknown> = Readonly<Record<string, readonly Row[]>>;
export type MaterializationNestedUniqueRows<Row = unknown> = Readonly<Record<string, Row | undefined>>;
export type MaterializationSetLike<Row = unknown> = { readonly values: () => IterableIterator<Row> };
export type MaterializationMapLike<Key = unknown, Value = unknown> = { readonly get: (key: Key) => Value | undefined };
export type MaterializationHashIndex<Row = unknown, Value = unknown> = MaterializationMapLike<Value, readonly Row[]>;
export type MaterializationRangeBound<Value = unknown> = RelationRangeBound<Value>;
export type MaterializationRange<Value = unknown> = { readonly lower?: MaterializationRangeBound<Value>; readonly upper?: MaterializationRangeBound<Value> };
export type MaterializationBtreeIndex<Row = unknown, Value = unknown> = MaterializationMapLike<Value, readonly Row[]>;
export type MaterializationUniqueIndex<Row = unknown, Value = unknown> = MaterializationMapLike<Value, Row>;
export type MaterializationIndexResult<Row = unknown> = MaterializationSetLike<Row>;
export type MaterializedQueryResult<Row = unknown> = QueryResult<Row> & { readonly materialized: boolean };
export type MaterializationIndexOptions<Field extends string = string> = { readonly fields?: readonly Field[] };
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
    constraints: [...current.constraints]
  };

  for (const input of inputs) {
    state = addMaterializationInput(dbValue, state, input);
  }

  return withMaterializedState(dbValue, state) as DbValue & MaterializedDb;
}
export async function materializeSnapshot<DbValue extends SnapshotMaterializationTarget, Row>(
  dbValue: DbValue,
  query: Query<Row>,
  options: SnapshotMaterializationOptions = {}
): Promise<DbValue & MaterializedDb> {
  return mat(dbValue, materializationMetadata(query, options));
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
  for (const id of metadataIds) rows.delete(id);

  return withMaterializedState(dbValue, {
    metadata: current.metadata.filter((item) => !metadataIds.has(item.id)),
    rows,
    constraints: current.constraints.filter((item) => !constraintKeys.has(constraintKey(item)))
  }) as DbValue;
};
export const isMaterialized = (input: unknown): input is MaterializedDb => isRecord(input) && 'materialized' in input;
export const materializationsFor = (input: unknown): readonly MaterializationMetadata[] => materializedStateFor(input).metadata;
export const materializationForQuery = <Row = unknown>(input: unknown, query: Query<Row>): MaterializationMetadata<Row> | undefined =>
  materializationsFor(input).find((item) => item.queryKey === queryKey(query)) as MaterializationMetadata<Row> | undefined;
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
  return fromObjectSource(data);
};
export const materializedLookupRowsFor = <Row = unknown>(input?: unknown, id?: string): readonly Row[] | undefined =>
  input === undefined || id === undefined ? undefined : materializedRowsFor<Row>(input, id);
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
  const touchedDependencies = relationDeltaNames(options.deltas ?? []);

  for (const metadata of beforeState.metadata) {
    const previousRows = beforeState.rows.get(metadata.id) as readonly Row[] | undefined;
    const dependencies = relationDependencies(metadata.query);
    const touched = dependencies.filter((name) => touchedDependencies.includes(name));
    if (previousRows !== undefined && options.deltas !== undefined && touched.length === 0) {
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
        envDependencies: queryEnvDependencies(metadata.query),
        touchedEnvDependencies: [],
        indexSpecs: [],
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

    const refresh = refreshMaterializationRows<Row>(target, metadata.query as Query<Row>);
    const diff = diffRows(previousRows ?? [], refresh.rows);
    const added = diff.changes.flatMap((change) => change.kind === 'added' ? [change.row] : []);
    const removed = diff.changes.flatMap((change) => change.kind === 'removed' ? [change.row] : []);

    changes.push({
      update: 'recomputed',
      recomputed: true,
      reason: 'snapshot recompute',
      id: metadata.id,
      queryKey: metadata.queryKey,
      query: metadata.query as Query<Row>,
      maintenance: metadata.mode,
      dependencies,
      touchedDependencies: touched,
      envDependencies: queryEnvDependencies(metadata.query),
      touchedEnvDependencies: [],
      indexSpecs: [],
      previousRowsAvailable: previousRows !== undefined,
      previousRows,
      rows: refresh.rows,
      added,
      removed,
      rowChanges: diff.changes,
      diagnostics: [...refresh.diagnostics, ...diff.diagnostics]
    });
  }

  return {
    maintained: changes.length,
    recomputed: changes.filter((change) => change.recomputed).length,
    carried: changes.filter((change) => change.update === 'carried').length,
    skipped: 0,
    changes,
    diagnostics: changes.flatMap((change) => change.diagnostics)
  };
}
export const explainMaterialization = <Row>(query: Query<Row>): MaterializationExplanation<Row> => ({ query, supported: true, diagnostics: [] });
export const index = <Row = unknown>(): MaterializationIndex<Row> => ({});

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
export const isWatchMaterialization = (): boolean => false;
export const watchRuntime = <Version, Row>(runtime: RelationRuntime<Version>, target: WatchTarget<Row>, listener: WatchListener<Row>, options: WatchOptions<Row> = {}): RuntimeWatchHandle<Row> =>
  watch(runtime.source, target, listener, options) as RuntimeWatchHandle<Row>;
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
export const transferWatches = (): void => {};
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
  let state = dbFromRuntime(input.runtime, input.relations, input.env);
  let version = input.runtime.source.version?.();
  const snapshot = (): StoreSnapshot<Version> => ({
    db: state,
    source: input.runtime.source,
    revision,
    diagnostics: input.runtime.source.diagnostics?.() ?? [],
    ...(version === undefined ? {} : { version })
  });
  const refreshFromRuntime = (): StoreSnapshot<Version> => {
    const runtimeSnapshot = input.runtime.snapshot?.();
    const source = runtimeSnapshot?.source ?? input.runtime.source;
    version = runtimeSnapshot?.version ?? source.version?.();
    state = dbFromSource(source, input.relations, state.env);
    revision += 1;
    for (const listener of listeners) listener();
    return {
      db: state,
      source,
      revision,
      diagnostics: runtimeSnapshot?.diagnostics ?? source.diagnostics?.() ?? [],
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

      const report = await tryApplyRelationPatches(input.runtime, transactionResult.deltas.flatMap(deltaToPatches), { readVersion: true });
      const nextSnapshot = refreshFromRuntime();
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
  const viewSnapshot = (): StoreViewSnapshot<Row, Version> => {
    const current = snapshot();
    const result = qResult(current.db, queryValue);
    return {
      rows: result.rows,
      diagnostics: [...current.diagnostics, ...result.diagnostics],
      revision: current.revision,
      queryKey: key,
      ...(current.version === undefined ? {} : { version: current.version })
    };
  };
  return {
    query: queryValue,
    queryKey: key,
    getSnapshot: viewSnapshot,
    subscribe: subscribeStore,
    refresh: async () => viewSnapshot()
  };
}

function createWatchHandle<DbValue extends WatchDb, Row>(dbValue: DbValue, target: WatchTarget<Row>, options: WatchOptions<Row>): WatchHandle<DbValue, Row> {
  const id = options.label ?? `watch:${WATCH_ID += 1}`;
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

const MATERIALIZATION_STATE = Symbol('tarstate.materializationState');
const ATTACHED_WATCH_TARGETS = Symbol('tarstate.attachedWatchTargets');
const EMPTY_MATERIALIZATION_STATE: InternalMaterializationState = Object.freeze({
  metadata: Object.freeze([]) as readonly MaterializationMetadata[],
  rows: new Map<string, readonly unknown[]>(),
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
      return evaluateNestedInput(source, data, relations, options, outer, diagnostics)
        .filter((entry) => Boolean(evaluateExpr(data.predicate, entry, source, relations, options, diagnostics, outer)));
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

  switch (fn) {
    case 'count':
      return rows.length;
    case 'countDistinct':
      return new Set((args.length === 0 ? rows.map((entry) => entry.row) : values(0)).map(stableKey)).size;
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

function applyWritePatchToDb(dbValue: Db, patch: WritePatch): WriteApplyResult {
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
      const key = keyOf(patch.row as Record<string, unknown>);
      if (findIndexByKey(key) === -1) {
        rows.push(patch.row as Record<string, unknown>);
        added = [patch.row];
      }
      break;
    }
    case 'insertOrReplace': {
      const key = keyOf(patch.row as Record<string, unknown>);
      const indexValue = findIndexByKey(key);
      if (indexValue === -1) {
        rows.push(patch.row as Record<string, unknown>);
        added = [patch.row];
      } else {
        removed = [rows[indexValue]];
        rows[indexValue] = patch.row as Record<string, unknown>;
        added = [patch.row];
      }
      break;
    }
    case 'insertOrMerge': {
      const key = keyOf(patch.row as Record<string, unknown>);
      const indexValue = findIndexByKey(key);
      if (indexValue === -1) {
        rows.push(patch.row as Record<string, unknown>);
        added = [patch.row];
      } else {
        const current = rows[indexValue] as RelationRow<RelationRef>;
        const updateValue = mergeUpdate(current, patch.row, patch.merge);
        const next = { ...current, ...updateValue };
        removed = [current];
        rows[indexValue] = next;
        added = [next];
      }
      break;
    }
    case 'insertOrUpdate': {
      const key = keyOf(patch.row as Record<string, unknown>);
      const indexValue = findIndexByKey(key);
      if (indexValue === -1) {
        rows.push(patch.row as Record<string, unknown>);
        added = [patch.row];
      } else {
        const current = rows[indexValue] as RelationRow<RelationRef>;
        const updateValue = relationUpdateFor(current, patch.update ?? patch.row);
        const next = { ...current, ...updateValue };
        removed = [current];
        rows[indexValue] = next;
        added = [next];
      }
      break;
    }
    case 'updateByKey': {
      const indexValue = findIndexByKey(keyFromPatch(patch.key as RelationKeyInput));
      if (indexValue !== -1) {
        const current = rows[indexValue] as RelationRow<RelationRef>;
        const next = { ...current, ...relationUpdateFor(current, patch.changes) };
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
        const next = { ...current, ...relationUpdateFor(current as RelationRow<RelationRef>, patch.changes) };
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
        if (partialRowMatches(rowValue, patch.row as Record<string, unknown>)) removed.push(rowValue);
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

function relationUpdateFor(
  current: RelationRow<RelationRef>,
  input: RelationRowUpdateInput<RelationRef>
): RelationRowUpdate<RelationRef> {
  return typeof input === 'function' ? input(current) : input;
}

function mergeUpdate(
  current: RelationRow<RelationRef>,
  incoming: RelationRow<RelationRef>,
  merge: RelationMergeInput<RelationRef> | undefined
): RelationRowUpdate<RelationRef> {
  if (typeof merge === 'function') return merge(current, incoming);
  if (Array.isArray(merge)) {
    return Object.fromEntries(merge.map((fieldName) => [fieldName, incoming[fieldName]]));
  }
  return incoming;
}

function predicateMatchesRow(predicate: PredicateData, rowValue: Record<string, unknown>, relationRef: RelationRef, dbValue: Db): boolean {
  const diagnostics: TarstateDiagnostic[] = [];
  const entry = entryForRow(rowValue, relationRef.name, relationRef.name);
  for (const alias of relationPredicateAliases(relationRef.name)) entry.aliases[alias] = rowValue;
  return Boolean(evaluateExpr(predicate, entry, dbSource(dbValue), { [relationRef.name]: relationRef }, { env: dbValue.env }, diagnostics, undefined));
}

function partialRowMatches(rowValue: Record<string, unknown>, partial: Record<string, unknown>): boolean {
  return Object.entries(partial).every(([fieldName, fieldValue]) => Object.is(rowValue[fieldName], fieldValue));
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
    for (const delta of newDeltas) {
      if (delta.relation.name !== constraint.target.name || delta.removed.length === 0) continue;
      for (const removedRow of delta.removed) {
        if (!isRecord(removedRow)) continue;
        const predicate = or(...constraint.fields.map((fieldName, indexValue) =>
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
  rows.set(metadata.id, refreshMaterializationRows(target, metadata.query).rows);
  return {
    metadata: [...state.metadata.filter((item) => item.id !== metadata.id), metadata],
    rows,
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
  return { metadata: [], rows: new Map(), constraints: [] };
}

function applyMaterializationState(dbValue: Db, previous: InternalMaterializationState, maintenance: MaterializationMaintenanceResult): Db {
  if (previous.metadata.length === 0 && previous.constraints.length === 0) return dbValue;
  const rows = new Map(previous.rows);
  for (const change of maintenance.changes) rows.set(change.id, change.rows);
  return withMaterializedState(dbValue, {
    metadata: previous.metadata,
    rows,
    constraints: previous.constraints
  });
}

function refreshMaterializationRows<Row>(target: unknown, query: Query<Row>): MaterializationRefreshResult<Row> {
  if (isDb(target)) return qResult(target, query);
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
  if (input === null || typeof input === 'string' || typeof input === 'number' || typeof input === 'boolean') return JSON.stringify(input);
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

function queryDataRowKeyFields(data: QueryData): readonly string[] | undefined {
  switch (data.op) {
    case 'keyBy':
      return stringArray(data.fields);
    case 'from':
      return typeof data.relation === 'string' ? undefined : undefined;
    case 'where':
    case 'hash':
    case 'btree':
    case 'sort':
    case 'limit':
    case 'sortLimit':
      return queryDataFrom(data.input) === undefined ? undefined : queryDataRowKeyFields(queryDataFrom(data.input) as QueryData);
    default:
      return undefined;
  }
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

function dbFromRuntime<Version>(runtime: RelationRuntime<Version>, relations: readonly RelationRef[], envValue: DbInputEnv | undefined): Db {
  return dbFromSource(runtime.snapshot?.().source ?? runtime.source, relations, envValue);
}

function dbFromSource(source: RelationSource, relations: readonly RelationRef[], envValue: DbInputEnv | undefined): Db {
  return createDb(
    Object.fromEntries(relations.map((relationRef) => [relationRef.name, source.rows(relationRef)])),
    envValue === undefined ? {} : { env: envValue }
  );
}

function deltaToPatches(delta: RelationDelta): readonly WritePatch[] {
  return [
    ...delta.removed.map((rowValue) => deleteExact(delta.relation, rowValue as Record<string, unknown>)),
    ...delta.added.map((rowValue) => insertOrReplace(delta.relation, rowValue as Record<string, unknown>))
  ];
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

function aggregateCall<Value = unknown>(op: AggregateFunction, ...args: readonly unknown[]): ExprData<Value> {
  return { op: 'aggregateCall', fn: op, args };
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
