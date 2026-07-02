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
export type PredicateData = Readonly<Record<string, unknown>> & { readonly op: string };
export type OptionalProjection<Value = unknown> = {
  readonly kind: 'optionalProjection';
  readonly expr: ExprData<Value>;
};
export type ProjectionData = Record<string, ExprData | OptionalProjection>;
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
  readonly relations: Record<string, AnyRelationRef>;
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
  { readonly alias: Alias } & { readonly [Field in keyof Row & string]: ExprData<Row[Field]> };
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
type JoinQueryTransform<Right, Kind extends 'inner' | 'left'> = (<Left>(query: Query<Left>) => Query<Kind extends 'left' ? Left & Partial<Right> : Left & Right>) & {
  readonly __queryJoin?: Kind;
  readonly __queryRight?: Right;
};
type QualifyQueryTransform<Alias extends string> = (<Row>(query: Query<Row>) => Query<Record<Alias, Row>>) & { readonly __queryQualify?: Alias };
type PipeStep<Input, Transform> =
  Transform extends { readonly __queryTransform?: 'preserve' } ? Input
    : Transform extends { readonly __queryProject?: infer RowOut } ? Query<RowOut>
      : Transform extends { readonly __queryExtend?: infer RowAdd } ? Input extends Query<infer Row> ? Query<Row & RowAdd> : never
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

export function relationDependencies(_input: QueryKeyInput): readonly string[] {
  return [];
}

export function queryRowKeyFields(_input: QueryKeyInput): readonly string[] | undefined {
  return undefined;
}

export function as<Row extends object, Alias extends string>(relationRef: RelationRef<Row>, alias: Alias): AliasedRelationRef<Row, Alias>;
export function as<Row, Alias extends string>(query: Query<Row>, alias: Alias): AliasedQuery<Row, Alias>;
export function as<Row, Alias extends string>(
  input: RelationRef<Row & object> | Query<Row>,
  alias: Alias
): AliasedRelationRef<Row & object, Alias> | AliasedQuery<Row, Alias> {
  const target = { ...input, alias };
  return new Proxy(target, {
    get(valueTarget, property, receiver) {
      if (typeof property === 'string' && !(property in valueTarget)) {
        return field(alias, property);
      }
      return Reflect.get(valueTarget, property, receiver);
    }
  }) as AliasedRelationRef<Row & object, Alias> | AliasedQuery<Row, Alias>;
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

export function tuple<const Values extends readonly ExprInput[]>(...values: Values): ExprData<unknown[]> {
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
export const any = (...predicates: readonly PredicateData[]): PredicateData => ({ op: 'any', predicates });
export const notAny = (...predicates: readonly PredicateData[]): PredicateData => ({ op: 'notAny', predicates });

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
export const join = <Right>(right: Query<Right>, on: PredicateData): JoinQueryTransform<Right, 'inner'> => ((left) =>
  ({ data: { op: 'join', kind: 'inner', left: left.data, right: right.data, on }, relations: { ...left.relations, ...right.relations } })) as JoinQueryTransform<Right, 'inner'>;
export const leftJoin = <Right>(right: Query<Right>, on: PredicateData): JoinQueryTransform<Right, 'left'> => ((left) =>
  ({ data: { op: 'join', kind: 'left', left: left.data, right: right.data, on }, relations: { ...left.relations, ...right.relations } })) as JoinQueryTransform<Right, 'left'>;
export const project = <Shape extends ProjectionData>(projection: Shape): ProjectQueryTransform<ProjectedRow<Shape>> => ((query) =>
  ({ data: { op: 'project', input: query.data, projection }, relations: query.relations })) as ProjectQueryTransform<ProjectedRow<Shape>>;
export const extend = <Shape extends ProjectionData>(projection: Shape): ExtendQueryTransform<ProjectedRow<Shape>> => ((query) =>
  ({ data: { op: 'extend', input: query.data, projection }, relations: query.relations })) as ExtendQueryTransform<ProjectedRow<Shape>>;
export const expand = <Collection, Alias extends string | undefined = undefined, Fields extends readonly string[] | undefined = undefined>(
  collection: ExprData<Collection>,
  options: ExpandOptions<Alias, Fields> = {}
) => ((query) => ({ ...query, data: { op: 'expand', input: query.data, collection, ...options } })) as PreserveQueryTransform;
export const without = (...fields: readonly string[]): PreserveQueryTransform => ((query) =>
  ({ ...query, data: { op: 'without', input: query.data, fields } })) as PreserveQueryTransform;
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
export const rename = (fields: Record<string, string>): PreserveQueryTransform => ((query) =>
  ({ ...query, data: { op: 'rename', input: query.data, fields } })) as PreserveQueryTransform;
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
export const sum = (input: ExprInput): ExprData<number> => aggregateCall<number>('sum', input);
export const avg = (input: ExprInput): ExprData<number> => aggregateCall<number>('avg', input);
export const min = <Value = unknown>(input: ExprInput<Value>): ExprData<Value> => aggregateCall<Value>('min', input);
export const max = <Value = unknown>(input: ExprInput<Value>): ExprData<Value> => aggregateCall<Value>('max', input);
export const top = <Value = unknown>(input: ExprInput<Value>, countValue = 1): ExprData<readonly Value[]> => aggregateCall<readonly Value[]>('top', input, countValue);
export const bottom = <Value = unknown>(input: ExprInput<Value>, countValue = 1): ExprData<readonly Value[]> => aggregateCall<readonly Value[]>('bottom', input, countValue);
export const topBy = <Value = unknown>(input: ExprInput<Value>, by: ExprInput, countValue = 1): ExprData<readonly Value[]> => aggregateCall<readonly Value[]>('topBy', input, by, countValue);
export const bottomBy = <Value = unknown>(input: ExprInput<Value>, by: ExprInput, countValue = 1): ExprData<readonly Value[]> => aggregateCall<readonly Value[]>('bottomBy', input, by, countValue);
export const maxBy = <Row = unknown>(input: ExprInput<Row>, by: ExprInput): ExprData<Row> => aggregateCall<Row>('maxBy', input, by);
export const minBy = <Row = unknown>(input: ExprInput<Row>, by: ExprInput): ExprData<Row> => aggregateCall<Row>('minBy', input, by);
export const setConcat = <Value = unknown>(input: ExprInput<readonly Value[]>): ExprData<readonly Value[]> => aggregateCall<readonly Value[]>('setConcat', input);
export const sel = <Row>(query: Query<Row>): ExprData<readonly Row[]> => ({ op: 'sel', query: query.data });
export const sel1 = <Row>(query: Query<Row>): ExprData<Row | undefined> => ({ op: 'sel1', query: query.data });

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

export function evaluate<Row>(_source: RelationSource, _query: Query<Row>, _options: EvaluateOptions = {}): QueryResult<Row> {
  throw notImplemented('evaluate');
}

export function validateRelationRow(_relation: RelationRef, _row: Record<string, unknown>): readonly TarstateDiagnostic[] {
  throw notImplemented('validateRelationRow');
}

export function rowKey(relationRef: RelationRef, row: Record<string, unknown>): string | undefined {
  const fields = Array.isArray(relationRef.key) ? relationRef.key : [relationRef.key];
  return JSON.stringify(fields.map((fieldName) => row[fieldName]));
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

export function diffRows<Row>(_before: readonly Row[], _after: readonly Row[], _options: RowDiffOptions<Row> = {}): RowDiff<Row> {
  throw notImplemented('diffRows');
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
  return { relationNames: Object.keys(data), rows: (relationRef) => data[relationRef.name] ?? [] };
}

export const isRelationSource = (input: unknown): input is RelationSource => isRecord(input) && typeof input.rows === 'function';
export const composeSources = (...sources: readonly RelationSource[]): RelationSource => ({
  relationNames: Array.from(new Set(sources.flatMap((source) => source.relationNames ?? []))),
  rows: (relationRef) => sources.flatMap((source) => source.rows(relationRef))
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
export type RelationApplyOptions = TarstateDiagnosticOptions & { readonly readVersion?: boolean };
export type RelationApplyReport<Version = unknown> = RelationApplyResult<Version> & { readonly source: AdapterSource<Version> };

export async function tryApplyRelationPatches<Version = unknown>(
  runtime: RelationRuntime<Version>,
  patches: Iterable<WritePatch>,
  _options: RelationApplyOptions = {}
): Promise<RelationApplyReport<Version>> {
  const patchList = Array.from(patches);
  return {
    status: 'rejected',
    patches: patchList.length,
    applied: 0,
    deltas: [],
    diagnostics: [stubDiagnostic('tryApplyRelationPatches')],
    source: runtime.source
  };
}

export const composeRelationRuntimes = (...runtimes: readonly RelationRuntime[]): RelationRuntime<readonly unknown[]> => ({
  source: composeSources(...runtimes.map((runtime) => runtime.source)) as AdapterSource<readonly unknown[]>
});
export const isRelationRuntime = (input: unknown): input is RelationRuntime => isRecord(input) && isRelationSource(input.source);

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
export type DbTransactionResult = {
  readonly db: Db;
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

export class DbTransactionError extends Error {
  readonly result: DbTransactionResult;
  constructor(result: DbTransactionResult) {
    super('transaction failed');
    this.name = 'DbTransactionError';
    this.result = result;
  }
}

export function createDb(data: DbInputData = {}, options: DbInputEnv | DbOptions = EMPTY_DB_ENV): Db {
  return { data, env: dbEnvFromOptions(options) };
}
export const dbSource = (input: Db): RelationSource => fromObjectSource(input.data);
export const stripMeta = <Input>(input: Input): Input extends Db ? DbData : Input => (isDb(input) ? input.data : input) as never;
export const withEnv = (input: Db, envValue: DbInputEnv): Db => ({ ...input, env: envValue });
export const getEnv = (input: Db): DbEnv => input.env;
export const updateEnv = (input: Db, update: (env: DbEnv) => DbInputEnv): Db => withEnv(input, update(input.env));
export const setEnvTx = (envValue: DbEnvUpdate): SetEnvTransaction => ({ op: 'setEnv', env: envValue });
export function q<Row>(_db: Db, _query: Query<Row> | RelationRef, _options: DbQueryOptions<Row> = {}): QueryResult<Row> {
  throw notImplemented('q');
}
export function qRows<Row>(inputDb: Db, query: Query<Row> | RelationRef, options: DbQueryOptions<Row> = {}): readonly Row[] {
  return q(inputDb, query, options).rows;
}
export function qMany<Queries extends QueryBatch>(_db: Db, _queries: Queries, _options: DbQueryOptions = {}): QueryBatchResult<Queries> {
  throw notImplemented('qMany');
}
export function qManyRows<Queries extends QueryBatch>(inputDb: Db, queries: Queries, options: DbQueryOptions = {}): QueryBatchRows<Queries> {
  const result = qMany(inputDb, queries, options);
  return Object.fromEntries(Object.entries(result).map(([name, queryResult]) => [name, queryResult.rows])) as QueryBatchRows<Queries>;
}
export function row<Relation extends RelationRef>(_db: Db, _relation: Relation, _key: RelationKeyValue<Relation>, _options?: RowLookupOptions<RelationRow<Relation>>): RelationRow<Relation> | undefined;
export function row<Relation extends RelationRef>(_db: Db, _relation: Relation, _key: RelationKeyInput, _options?: RowLookupOptions<RelationRow<Relation>>): RelationRow<Relation> | undefined;
export function row<Row>(_db: Db, _query: Query<Row>, _predicate: PredicateData, _options?: RowPredicateOptions<Row>): Row | undefined;
export function row<Relation extends RelationRef>(_db: Db, _relation: Relation, _predicate: PredicateData, _options?: RowPredicateOptions<RelationRow<Relation>>): RelationRow<Relation> | undefined;
export function row<Row>(_db: Db, _query: Query<Row>, _options?: RowLookupOptions<Row>): Row | undefined;
export function row<Relation extends RelationRef>(_db: Db, _relation: Relation, _options?: RowLookupOptions<RelationRow<Relation>>): RelationRow<Relation> | undefined;
export function row<Row>(_db: Db, _query: Query<Row> | RelationRef, _keyOrPredicateOrOptions?: RelationKeyInput | PredicateData | RowLookupOptions<Row>, _options?: RowLookupOptions<Row>): Row | undefined {
  throw notImplemented('row');
}
export function exists<Relation extends RelationRef>(_db: Db, _relation: Relation, _key: RelationKeyValue<Relation>, _options?: RowLookupOptions<RelationRow<Relation>>): boolean;
export function exists<Row>(_db: Db, _query: Query<Row>, _predicate: PredicateData, _options?: RowPredicateOptions<Row>): boolean;
export function exists<Relation extends RelationRef>(_db: Db, _relation: Relation, _predicate: PredicateData, _options?: RowPredicateOptions<RelationRow<Relation>>): boolean;
export function exists<Row>(_db: Db, _query: Query<Row>, _options?: RowLookupOptions<Row>): boolean;
export function exists<Relation extends RelationRef>(_db: Db, _relation: Relation, _options?: RowLookupOptions<RelationRow<Relation>>): boolean;
export function exists<Row>(_db: Db, _query: Query<Row> | RelationRef, _keyOrPredicateOrOptions?: RelationKeyInput | PredicateData | RowLookupOptions<Row>, _options?: RowLookupOptions<Row>): boolean {
  throw notImplemented('exists');
}
export type DbTransactionOptions = { readonly label?: string };
export function whatIf<Queries extends QueryBatch>(_db: Db, _query: Queries, ..._inputs: DbTransactionInputs): QueryBatchResult<Queries>;
export function whatIf<Row>(_db: Db, _query: Query<Row> | RelationRef, ..._inputs: DbTransactionInputs): QueryResult<Row>;
export function whatIf(_db: Db, _query: Query<unknown> | RelationRef | QueryBatch, ..._inputs: DbTransactionInputs): QueryResult<unknown> | QueryBatchResult<QueryBatch> {
  throw notImplemented('whatIf');
}
export function transact(inputDb: Db, inputs: DbTransactionInputs, options?: DbTransactionOptions): Db;
export function transact(inputDb: Db, input: DbTransactionInput, options?: DbTransactionOptions): Db;
export function transact(inputDb: Db, inputOrInputs: DbTransactionInput | DbTransactionInputs, _options: DbTransactionOptions = {}): Db {
  const result = tryTransact(inputDb, ...normalizeTransactionInputs(inputOrInputs));
  if (!result.committed) throw new DbTransactionError(result);
  return result.db;
}
export function tryTransact(inputDb: Db, ...inputs: DbTransactionInputs): DbTransactionResult {
  return { db: inputDb, patches: inputs.length, applied: 0, deltas: [], diagnostics: [stubDiagnostic('tryTransact')], committed: false };
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
export type ConstraintAttachmentInput = ConstraintData | ConstraintSet;
export type ConstraintAttachment = { readonly constraints: ConstraintSet };
export type ConstrainedDb = Db & { readonly constraints?: ConstraintSet };
export type ConstraintValidationInput = ConstraintSet | ConstraintData;
export type ConstraintValidationOptions = EvaluateOptions;
export type ConstraintValidationResult = {
  readonly valid: boolean;
  readonly diagnostics: readonly TarstateDiagnostic[];
};

export class DbConstraintTransactionError extends Error {
  readonly result: DbTransactionResult;
  constructor(result: DbTransactionResult) {
    super('constraint transaction failed');
    this.name = 'DbConstraintTransactionError';
    this.result = result;
  }
}

export const check = (queryOrPredicate: Query | PredicateData, predicate?: PredicateData): CheckConstraintData =>
  ({ op: 'check', ...(predicate === undefined ? { predicate: queryOrPredicate as PredicateData } : { query: queryOrPredicate as Query, predicate }) });
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
export const attachConstraints = <DbValue extends Db>(dbValue: DbValue, constraints: ConstraintSet): DbValue & ConstrainedDb => ({ ...dbValue, constraints });
export const detachConstraints = <DbValue extends Db>(dbValue: DbValue): DbValue => dbValue;
export const attachedConstraintsFor = (dbValue: Partial<ConstrainedDb>): ConstraintSet => dbValue.constraints ?? [];
export const hasAttachedConstraints = (dbValue: Partial<ConstrainedDb>): boolean => attachedConstraintsFor(dbValue).length > 0;
export const validateConstraints = async (): Promise<ConstraintValidationResult> => ({ valid: false, diagnostics: [stubDiagnostic('validateConstraints')] });
export const tryTransactConstrained = (dbValue: Db, ...inputs: DbTransactionInputs): DbTransactionResult => tryTransact(dbValue, ...inputs);
export const transactConstrained = (dbValue: Db, ...inputs: DbTransactionInputs): Db => transact(dbValue, inputs);

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
  readonly diagnostics: readonly MaterializationDiagnostic[];
};
export type MaterializationDiagnostic = TarstateDiagnostic;
export type MaterializationRefreshResult<Row = unknown> = {
  readonly kind: 'materializationRefresh';
  readonly rows: readonly Row[];
  readonly diagnostics: readonly MaterializationDiagnostic[];
};
export type MaterializationMaintenanceChange<Row = unknown> = {
  readonly kind: 'materializationMaintenanceChange';
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
  readonly diagnostics: readonly MaterializationDiagnostic[];
};
export type MaterializationMaintenanceResult<Row = unknown> = {
  readonly kind: 'materializationMaintenance';
  readonly maintained: number;
  readonly recomputed: number;
  readonly carried: number;
  readonly skipped: number;
  readonly changes: readonly MaterializationMaintenanceChange<Row>[];
  readonly diagnostics: readonly MaterializationDiagnostic[];
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

export function mat<DbValue extends object>(dbValue: DbValue, ..._inputs: readonly unknown[]): DbValue & MaterializedDb {
  return dbValue as DbValue & MaterializedDb;
}
export async function materializeSnapshot<DbValue extends SnapshotMaterializationTarget, Row>(
  dbValue: DbValue,
  _query: Query<Row>,
  _options: SnapshotMaterializationOptions = {}
): Promise<DbValue & MaterializedDb> {
  return dbValue as DbValue & MaterializedDb;
}
export const demat = <DbValue extends MaterializableDb>(dbValue: DbValue, ..._targets: readonly unknown[]): DbValue => dbValue;
export const isMaterialized = (input: unknown): input is MaterializedDb => isRecord(input) && 'materialized' in input;
export const materializationsFor = (_input: unknown): readonly MaterializationMetadata[] => [];
export const materializationForQuery = <Row = unknown>(_input: unknown, _query: Query<Row>): MaterializationMetadata<Row> | undefined => undefined;
export const materializedRowsFor = <Row = unknown>(_input: unknown, _id: string): readonly Row[] | undefined => undefined;
export const materializedRowsForQuery = <Row = unknown>(_input: unknown, _query: Query<Row>): readonly Row[] | undefined => undefined;
export function readMaterializedQuery<Row>(_input: unknown, _query: Query<Row>): MaterializedQueryResult<Row> {
  throw notImplemented('readMaterializedQuery');
}
export const materializedSourceFor = (_input: unknown): RelationSource | undefined => undefined;
export const materializedLookupRowsFor = (): readonly unknown[] | undefined => undefined;
export const maintainMaterializationSnapshots = (): MaterializationMaintenanceResult => emptyMaintenance();
export const explainMaterialization = <Row>(query: Query<Row>): MaterializationExplanation<Row> => ({ query, supported: false, diagnostics: [stubDiagnostic('explainMaterialization')] });
export const index = <Row = unknown>(): MaterializationIndex<Row> => ({});

export type MemoryRelationRuntimeOptions = { readonly relationNames?: readonly string[] };
export function createMemoryRelationRuntime(data: DbInputData = {}, options: MemoryRelationRuntimeOptions = {}): RelationRuntime<number> {
  return {
    source: { ...fromObjectSource(data), version: () => 0 },
    target: {
      relationNames: options.relationNames ?? Object.keys(data),
      apply: (patches) => ({ status: 'rejected', patches: patches.length, applied: 0, deltas: [], diagnostics: [stubDiagnostic('createMemoryRelationRuntime')] })
    },
    snapshot: () => ({ source: { ...fromObjectSource(data), version: () => 0 }, version: 0 })
  };
}

export type StoreDiagnostic = TarstateDiagnostic;
export type StoreSnapshot<Version = unknown> = {
  readonly db: Db;
  readonly source: RelationSource;
  readonly revision: number;
  readonly diagnostics: readonly StoreDiagnostic[];
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
  readonly diagnostics: readonly StoreDiagnostic[];
  readonly version?: Version;
  readonly durability?: RelationApplyDurability;
};
export type StoreCommitSnapshot<Version = unknown> = StoreSnapshot<Version>;
export type StoreCommitResult<Version = unknown> = {
  readonly kind: 'tarstateCommit';
  readonly status: StoreCommitStatus;
  readonly reflected: boolean;
  readonly effects: StoreCommitEffects<Version>;
  readonly snapshot: StoreCommitSnapshot<Version>;
  readonly diagnostics: readonly StoreDiagnostic[];
};
export type StoreCommitInput = DbTransactionInput;
export type StoreCommitOptions = DbTransactionOptions;
export type StoreCommit<Version = unknown> = {
  (inputs: DbTransactionInputs, options?: StoreCommitOptions): Promise<StoreCommitResult<Version>>;
  (input: DbTransactionInput, options?: StoreCommitOptions): Promise<StoreCommitResult<Version>>;
};
export type StoreQueryOptions<Row = unknown, MappedRow = Row> = DbQueryOptions<Row, MappedRow>;
export type StoreViewReadOptions<Row = unknown, MappedRow = Row> = StoreQueryOptions<Row, MappedRow>;
export type StoreViewSnapshot<Row = unknown, Version = unknown> = {
  readonly rows: readonly Row[];
  readonly diagnostics: readonly StoreDiagnostic[];
  readonly revision: number;
  readonly queryKey: string;
  readonly snapshot: StoreSnapshot<Version>;
  readonly db: Db;
  readonly source: RelationSource;
  readonly version?: Version;
};
export type StoreQuery = <Row>(query: Query<Row> | RelationRef, options?: StoreQueryOptions<Row>) => StoreQueryResult<Row>;
export type StoreQueries = <Queries extends QueryBatch>(queries: Queries, options?: StoreQueryOptions) => StoreQueryBatchResult<Queries>;
export type StoreWhatIf = {
  <Queries extends QueryBatch>(query: Queries, ...inputs: DbTransactionInputs): StoreQueryBatchResult<Queries>;
  <Row>(query: Query<Row> | RelationRef, ...inputs: DbTransactionInputs): StoreQueryResult<Row>;
};
export type StoreViewRead<Row = unknown, Version = unknown> = () => StoreViewSnapshot<Row, Version>;
export type StoreView<Row = unknown, Version = unknown> = {
  readonly kind: 'view';
  readonly query: Query<Row>;
  readonly queryKey: string;
  readonly getSnapshot: () => StoreViewSnapshot<Row, Version>;
  readonly subscribe: (listener: () => void) => () => void;
  readonly read: StoreViewRead<Row, Version>;
  readonly rows: () => readonly Row[];
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
  return createStubStore(state);
}
export function createRuntimeStore<Version>(_input: StoreRuntimeInput<Version>): Store<Version> {
  return createStubStore(createDb()) as Store<Version>;
}

export type WatchDb = Db | RelationSource;
export type WatchDiagnostic = TarstateDiagnostic & { readonly surface?: 'watch' | 'changeTracking' };
export type WatchRuntimeDiagnostic<Row = unknown> = WatchDiagnostic | RowDiffDiagnostic<Row>;
export type ChangeSet = { readonly deltas?: readonly RelationDelta[]; readonly diagnostics: readonly WatchDiagnostic[] };
export type WatchTarget<Row = unknown> = Query<Row> | RelationRef;
export type WatchEvent<Row = unknown> = {
  readonly kind: 'watchEvent';
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
export type WatchRefreshResult<Row = unknown> = Omit<WatchEvent<Row>, 'kind' | 'changes'> & { readonly kind: 'watchRefresh'; readonly delivered: boolean };
export type WatchUnsubscribeResult = { readonly kind: 'watchUnsubscribe'; readonly id: string; readonly unsubscribed: boolean; readonly diagnostics: readonly WatchDiagnostic[] };
export type WatchSubscription = { readonly kind: 'watchSubscription'; readonly id: string; readonly active: boolean; readonly diagnostics: readonly WatchDiagnostic[]; readonly unsubscribe: () => WatchUnsubscribeResult };
export type WatchHandle<DbValue extends WatchDb = WatchDb, Row = unknown> = {
  readonly kind: 'watch';
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
  readonly kind: 'watchTarget';
  readonly db: DbValue;
  readonly target: WatchTarget<Row>;
  readonly handle: WatchHandle<DbValue, Row>;
  readonly supported: boolean;
  readonly diagnostics: readonly WatchDiagnostic[];
  readonly unwatch: () => UnwatchResult;
  readonly label?: string;
};
export type UnwatchResult = { readonly kind: 'unwatch'; readonly id: string; readonly closed: boolean; readonly diagnostics: readonly WatchDiagnostic[] };
export type TrackedChange<Row = unknown> = Omit<WatchEvent<Row>, 'kind' | 'changes'> & { readonly kind: 'trackedChange' };
export type WatchTargetChange<Row = unknown> = Pick<TrackedChange<Row>, 'kind' | 'id' | 'targetKey' | 'target' | 'changed' | 'added' | 'removed' | 'unchanged' | 'rowChanges' | 'diagnostics'>;
export type WatchChangeMap<Row = unknown> = ReadonlyMap<WatchTarget<Row>, WatchTargetChange<Row>>;
export type WatchChangeKeyMap<Row = unknown> = ReadonlyMap<string, WatchTargetChange<Row>>;
export type QueryDiffOptions<Row = unknown> = EvaluateOptions & RowDiffOptions<Row>;
export type QueryDiffDiagnostic<Row = unknown> = TarstateDiagnostic | RowDiffDiagnostic<Row>;
export type QueryDiff<Row = unknown> = {
  readonly kind: 'queryDiff';
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

export function attachWatches<DbValue extends Db>(dbValue: DbValue, ..._targets: readonly WatchTarget[]): DbValue {
  return dbValue;
}
export function watch<DbValue extends WatchDb, Row>(dbValue: DbValue, target: WatchTarget<Row>, listener: WatchListener<Row>, options?: WatchOptions<Row>): WatchHandle<DbValue, Row>;
export function watch<DbValue extends WatchDb, Row>(dbValue: DbValue, target: WatchTarget<Row>, _listener: WatchListener<Row>, options: WatchOptions<Row> = {}): WatchHandle<DbValue, Row> {
  return createWatchHandle(dbValue, target, options);
}
export const watchTarget = <DbValue extends WatchDb, Row>(dbValue: DbValue, target: WatchTarget<Row>, options: WatchOptions<Row> = {}): WatchTargetRegistration<DbValue, Row> => {
  const handle = createWatchHandle(dbValue, target, options);
  return { kind: 'watchTarget', db: dbValue, target, handle, supported: true, diagnostics: [], unwatch: handle.unwatch };
};
export const unwatchTarget = (_registration: Pick<WatchTargetRegistration, 'handle'> | Pick<WatchHandle, 'id'>): UnwatchResult => ({ kind: 'unwatch', id: 'watch', closed: true, diagnostics: [] });
export const watchChangeMap = <Row>(_changes: Iterable<TrackedChange<Row>>): WatchChangeMap<Row> => new Map();
export const watchChangeKeyMap = <Row>(_changes: Iterable<TrackedChange<Row>>): WatchChangeKeyMap<Row> => new Map();
export const watchTargetKey = (target: WatchTarget): string => isQuery(target) ? queryKey(target) : `relation:${target.name}`;
export const isWatchMaterialization = (): boolean => false;
export const watchRuntime = <Version, Row>(runtime: RelationRuntime<Version>, target: WatchTarget<Row>, listener: WatchListener<Row>, options: WatchOptions<Row> = {}): RuntimeWatchHandle<Row> =>
  watch(runtime.source, target, listener, options) as RuntimeWatchHandle<Row>;
export const unwatch = (_handle: Pick<WatchHandle, 'id'>): UnwatchResult => ({ kind: 'unwatch', id: _handle.id, closed: true, diagnostics: [] });
export const subscribeWatch = <Row>(_handle: Pick<WatchHandle<WatchDb, Row>, 'id' | 'supported' | 'target'>, _listener: WatchListener<Row>): WatchSubscription =>
  ({ kind: 'watchSubscription', id: _handle.id, active: false, diagnostics: [watchDiagnostic('subscribeWatch')], unsubscribe: () => ({ kind: 'watchUnsubscribe', id: _handle.id, unsubscribed: false, diagnostics: [] }) });
export async function diffQuery<Row>(_before: WatchDb, _after: WatchDb, target: Query<Row>): Promise<QueryDiff<Row>> {
  return { kind: 'queryDiff', target, queryKey: queryKey(target), beforeRows: [], afterRows: [], changed: false, added: [], removed: [], unchanged: [], rowChanges: [], diagnostics: [stubDiagnostic('diffQuery')] };
}
export const diffOptionsForTarget = <Row>(_target: WatchTarget<Row>, options: WatchOptions<Row>): RowDiffOptions<Row> => options;
export const transferWatches = (): void => {};
export async function trackedChangesForDbTransition(): Promise<{ readonly changes: readonly TrackedChange[]; readonly diagnostics: readonly WatchRuntimeDiagnostic[] }> {
  return { changes: [], diagnostics: [stubDiagnostic('trackedChangesForDbTransition')] };
}
export const trackedChangeFromMaterializationChange = <Row>(change: MaterializationMaintenanceChange<Row>): TrackedChange<Row> =>
  ({ kind: 'trackedChange', id: change.id, targetKey: change.queryKey, target: change.query, changed: change.rowChanges.length > 0, previousRows: change.previousRows ?? [], rows: change.rows, added: change.added, removed: change.removed, unchanged: [], rowChanges: change.rowChanges, diagnostics: change.diagnostics });

export type TrackTransactDiagnostic = WatchRuntimeDiagnostic | MaterializationDiagnostic;
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
  readonly kind: 'trackTransact';
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
  readonly kind: 'trackRuntimeCommit';
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

export async function trackTransact<DbValue extends WatchDb>(_db: DbValue, ..._inputs: readonly unknown[]): Promise<TrackTransactResult<DbValue>> {
  throw notImplemented('trackTransact');
}
export async function trackRuntimeCommit<Version>(_runtime: RelationRuntime<Version>, _patches: Iterable<WritePatch>, _options: TrackRuntimeCommitOptions = {}): Promise<TrackRuntimeCommitResult<Version>> {
  throw notImplemented('trackRuntimeCommit');
}

function createStubStore<Version = unknown>(state: Db): Store<Version> {
  let revision = 0;
  const snapshot = (): StoreSnapshot<Version> => ({ db: state, source: dbSource(state), revision, diagnostics: [] });
  return {
    getSnapshot: snapshot,
    subscribe: () => () => {},
    query: (queryValue, options) => ({ ...q(state, queryValue, options), revision }),
    queries: () => {
      throw notImplemented('store.queries');
    },
    whatIf: () => {
      throw notImplemented('store.whatIf');
    },
    view: (queryValue) => createStubView(queryValue, snapshot),
    commit: async (inputOrInputs, _options = {}) => {
      const inputs = normalizeTransactionInputs(inputOrInputs);
      revision += 1;
      return {
        kind: 'tarstateCommit',
        status: 'rejected',
        reflected: false,
        effects: { patches: inputs.length, applied: 0, deltas: [], diagnostics: [stubDiagnostic('store.commit')] },
        snapshot: snapshot(),
        diagnostics: [stubDiagnostic('store.commit')]
      };
    },
    refresh: async () => snapshot(),
    close: () => {}
  };
}

function createStubView<Row, Version>(queryValue: Query<Row>, snapshot: () => StoreSnapshot<Version>): StoreView<Row, Version> {
  const key = queryKey(queryValue);
  const viewSnapshot = (): StoreViewSnapshot<Row, Version> => ({
    rows: [],
    diagnostics: [stubDiagnostic('store.view')],
    revision: snapshot().revision,
    queryKey: key,
    snapshot: snapshot(),
    db: snapshot().db,
    source: snapshot().source
  });
  return {
    kind: 'view',
    query: queryValue,
    queryKey: key,
    getSnapshot: viewSnapshot,
    subscribe: () => () => {},
    read: viewSnapshot,
    rows: () => [],
    refresh: async () => viewSnapshot()
  };
}

function createWatchHandle<DbValue extends WatchDb, Row>(dbValue: DbValue, target: WatchTarget<Row>, options: WatchOptions<Row>): WatchHandle<DbValue, Row> {
  return {
    kind: 'watch',
    id: options.label ?? 'watch',
    db: dbValue,
    target,
    supported: true,
    mode: 'db',
    diagnostics: [watchDiagnostic('watch')],
    refresh: async () => ({ kind: 'watchRefresh', id: options.label ?? 'watch', targetKey: watchTargetKey(target), target, delivered: false, changed: false, previousRows: [], rows: [], added: [], removed: [], unchanged: [], rowChanges: [], diagnostics: [watchDiagnostic('watch.refresh')] }),
    unwatch: () => ({ kind: 'unwatch', id: options.label ?? 'watch', closed: true, diagnostics: [] }),
    ...(options.label === undefined ? {} : { label: options.label })
  };
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

function mergeRelations(inputs: readonly Query[]): Record<string, RelationRef> {
  return Object.assign({}, ...inputs.map((input) => input.relations));
}

function arrayify(input: ConstraintRelationFields): readonly string[] {
  return typeof input === 'string' ? [input] : input;
}

function emptyMaintenance(): MaterializationMaintenanceResult {
  return { kind: 'materializationMaintenance', maintained: 0, recomputed: 0, carried: 0, skipped: 0, changes: [], diagnostics: [stubDiagnostic('maintainMaterializationSnapshots')] };
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

function dbEnvFromOptions(options: DbInputEnv | DbOptions): DbInputEnv {
  if ('env' in options) {
    return isRecord(options.env) ? options.env : EMPTY_DB_ENV;
  }
  return Object.fromEntries(Object.entries(options));
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

function stubDiagnostic(surface: string): TarstateDiagnostic {
  return { code: 'not_implemented', severity: 'warning', message: `${surface} is not implemented in rewrite stub`, surface };
}

function watchDiagnostic(label: string): WatchDiagnostic {
  return { code: 'not_implemented', severity: 'warning', message: `${label} is not implemented in rewrite stub`, surface: 'watch' };
}

function notImplemented(surface: string): Error {
  return Object.assign(new Error(`${surface} is not implemented in rewrite stub`), { code: 'not_implemented', surface });
}
