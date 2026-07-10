import type { ArtifactRef } from './artifacts.js';
import { parseScalarValue, type ScalarDeclaration } from './codec.js';
import type { PipeApplication, PipeOperator } from './internal-pipe.js';
import { sealTypedArtifact, type TypedArtifact, type TypedArtifactInput } from './internal-seal.js';
import { createIssue, type CapabilityRef, type Issue, type ParseResult } from './issues.js';
import type { CapabilityRegistry } from './registry.js';
import { safeParseJsonValue, type JsonValue, type PortableValue } from './value.js';
import type { AggregateExpr, Expr, OrderTerm, QueryNode, WindowExpr } from './query.js';

export type ValueDeclaration =
  | ScalarDeclaration
  | { readonly kind: 'array'; readonly items: ValueDeclaration }
  | { readonly kind: 'tuple'; readonly items: readonly ValueDeclaration[] }
  | { readonly kind: 'record'; readonly fields: Readonly<Record<string, ValueDeclaration>>; readonly optional?: readonly string[] };

export type QueryArtifactBody = {
  readonly schemaViews: readonly ArtifactRef[];
  readonly parameters: Readonly<Record<string, ValueDeclaration>>;
  readonly root: QueryNode;
  readonly requiredCapabilities: readonly CapabilityRef[];
};

export type QueryArtifact = TypedArtifact<'query', QueryArtifactBody>;

export const sealQuery = (input: TypedArtifactInput<QueryArtifactBody>): Promise<QueryArtifact> => sealTypedArtifact('query', input);

type AppliedOperator<Operator, Input> = Operator extends PipeOperator<infer _Type>
  ? PipeApplication<Operator, Input>['output']
  : Operator extends (value: Input) => infer Output ? Output : never;
type PipeResult<Input, Operators extends readonly unknown[]> = Operators extends readonly [infer First, ...infer Rest]
  ? PipeResult<AppliedOperator<First, Input>, Rest>
  : Input;
type ValidPipe<Input, Operators extends readonly unknown[]> = Operators extends readonly [infer First, ...infer Rest]
  ? First extends PipeOperator<infer _Type>
    ? PipeApplication<First, Input>['accepts'] extends true ? readonly [First, ...ValidPipe<AppliedOperator<First, Input>, Rest>] : never
    : First extends (value: Input) => infer Output ? readonly [First, ...ValidPipe<Output, Rest>] : never
  : readonly [];

/** Applies an unbounded sequence of typed operators left-to-right; inline callbacks must annotate their input. */
export function pipe<Input, const Operators extends readonly unknown[]>(value: Input, ...operators: Operators & ValidPipe<Input, Operators>): PipeResult<Input, Operators>;
export function pipe(value: unknown, ...operators: readonly ((value: never) => unknown)[]): unknown {
  return operators.reduce((current, operator) => operator(current as never), value);
}

/** Common functional builders; `Expr` and `QueryNode` remain the exhaustive advanced-authoring API. */
export const from = (relation: { readonly schemaView: ArtifactRef; readonly relationId: string }, alias: string): QueryNode => ({ kind: 'from', relation, alias });
export const constantValues = (alias: string, rows: readonly Readonly<Record<string, JsonValue>>[]): QueryNode => ({ kind: 'values', alias, rows });
export const where = (predicate: Expr) => (input: QueryNode): QueryNode => ({ kind: 'where', input, predicate });
export const select = (alias: string, fields: Readonly<Record<string, Expr>>) => (input: QueryNode): QueryNode => ({ kind: 'select', input, alias, fields });
export const withFields = (alias: string, fields: Readonly<Record<string, Expr>>) => (input: QueryNode): QueryNode => ({ kind: 'with-fields', input, alias, fields });
export const rename = (alias: string, fields: Readonly<Record<string, string>>) => (input: QueryNode): QueryNode => ({ kind: 'rename', input, alias, fields });
export const omit = (alias: string, fields: readonly string[]) => (input: QueryNode): QueryNode => ({ kind: 'omit', input, alias, fields });
export const unnest = (expression: Expr, alias: string, fieldName: string) => (input: QueryNode): QueryNode => ({ kind: 'unnest', input, expression, alias, field: fieldName });
export const join = (right: QueryNode, joinKind: 'inner' | 'cross' | 'left' | 'semi' | 'anti', on?: Expr) => (left: QueryNode): QueryNode => ({ kind: 'join', join: joinKind, left, right, ...(on === undefined ? {} : { on }) });
export const aggregate = (alias: string, groupBy: Readonly<Record<string, Expr>>, measures: Readonly<Record<string, AggregateExpr>>) => (input: QueryNode): QueryNode => ({ kind: 'aggregate', input, alias, groupBy, measures });
export const distinct = () => (input: QueryNode): QueryNode => ({ kind: 'distinct', input });
export const union = (right: QueryNode) => (left: QueryNode): QueryNode => ({ kind: 'set', op: 'union', left, right });
export const unionAll = (right: QueryNode) => (left: QueryNode): QueryNode => ({ kind: 'set', op: 'union-all', left, right });
export const intersect = (right: QueryNode) => (left: QueryNode): QueryNode => ({ kind: 'set', op: 'intersect', left, right });
export const except = (right: QueryNode) => (left: QueryNode): QueryNode => ({ kind: 'set', op: 'except', left, right });
export const orderBy = (by: readonly OrderTerm[]) => (input: QueryNode): QueryNode => ({ kind: 'order', input, by });
export const slice = (options: { readonly offset?: number; readonly limit?: number }) => (input: QueryNode): QueryNode => ({ kind: 'slice', input, ...options });
export const window = (alias: string, fields: Readonly<Record<string, WindowExpr>>) => (input: QueryNode): QueryNode => ({ kind: 'window', input, alias, fields });

export const literal = (value: JsonValue): Expr => ({ kind: 'literal', value });
export const parameter = (name: string): Expr => ({ kind: 'parameter', name });
export const field = (alias: string, name: string): Expr => ({ kind: 'field', alias, name });
export const compare = (op: Extract<Expr, { readonly kind: 'compare' }>['op'], left: Expr, right: Expr): Expr => ({ kind: 'compare', op, left, right });
export const and = (...args: readonly Expr[]): Expr => ({ kind: 'boolean', op: 'and', args });
export const or = (...args: readonly Expr[]): Expr => ({ kind: 'boolean', op: 'or', args });
export const not = (arg: Expr): Expr => ({ kind: 'boolean', op: 'not', arg });
export const isNull = (value: Expr): Expr => ({ kind: 'is-null', value });
export const isMissing = (value: Expr): Expr => ({ kind: 'is-missing', value });
export const keyOf = (alias: string): Expr => ({ kind: 'key-of', alias });
export const sourceOf = (alias: string): Expr => ({ kind: 'source-of', alias });
export const namedCall = (capability: CapabilityRef, args: readonly Expr[]): Expr => ({ kind: 'call', capability, args });
export const exists = (query: QueryNode): Expr => ({ kind: 'subquery', mode: 'exists', query });
export const scalarSubquery = (query: QueryNode): Expr => ({ kind: 'subquery', mode: 'scalar', query });

export const safeParseQueryParameters = (
  declarations: Readonly<Record<string, ValueDeclaration>>,
  input: unknown,
  options: { readonly registry?: CapabilityRegistry; readonly refFields?: (relationId: string) => readonly ScalarDeclaration[] | undefined } = {}
): ParseResult<Readonly<Record<string, PortableValue>>> => {
  const portable = safeParseJsonValue(input);
  if (!portable.success || !isRecord(portable.value)) return queryParameterFailure([], { reason: 'parameters_not_record' });
  const issues: Issue[] = [];
  const output: Record<string, PortableValue> = {};
  for (const name of Object.keys(portable.value)) if (!Object.hasOwn(declarations, name)) issues.push(queryParameterIssue([name], { reason: 'extra' }));
  for (const [name, declaration] of Object.entries(declarations)) {
    if (!Object.hasOwn(portable.value, name)) { issues.push(queryParameterIssue([name], { reason: 'missing' })); continue; }
    const parsed = parseDeclaredValue(declaration, portable.value[name], [name], options);
    if (parsed.success) output[name] = parsed.value;
    else issues.push(...parsed.issues);
  }
  return issues.length === 0 ? { success: true, value: output, issues: [] } : { success: false, issues };
};

const parseDeclaredValue = (
  declaration: ValueDeclaration,
  input: unknown,
  path: readonly unknown[],
  options: { readonly registry?: CapabilityRegistry; readonly refFields?: (relationId: string) => readonly ScalarDeclaration[] | undefined }
): ParseResult<PortableValue> => {
  if (declaration.kind === 'array') {
    if (!Array.isArray(input)) return queryParameterFailure(path, { expected: 'array' });
    const values: PortableValue[] = [];
    const issues: Issue[] = [];
    input.forEach((value, index) => {
      const parsed = parseDeclaredValue(declaration.items, value, [...path, index], options);
      if (parsed.success) values.push(parsed.value); else issues.push(...parsed.issues);
    });
    return issues.length === 0 ? { success: true, value: values, issues: [] } : { success: false, issues };
  }
  if (declaration.kind === 'tuple') {
    if (!Array.isArray(input) || input.length !== declaration.items.length) return queryParameterFailure(path, { expected: 'tuple', arity: declaration.items.length });
    const values: PortableValue[] = [];
    const issues: Issue[] = [];
    declaration.items.forEach((item, index) => {
      const parsed = parseDeclaredValue(item, input[index], [...path, index], options);
      if (parsed.success) values.push(parsed.value); else issues.push(...parsed.issues);
    });
    return issues.length === 0 ? { success: true, value: values, issues: [] } : { success: false, issues };
  }
  if (declaration.kind === 'record') {
    if (!isRecord(input)) return queryParameterFailure(path, { expected: 'record' });
    const output: Record<string, PortableValue> = {};
    const issues: Issue[] = [];
    const optional = new Set(declaration.optional ?? []);
    for (const fieldName of Object.keys(input)) if (!Object.hasOwn(declaration.fields, fieldName)) issues.push(queryParameterIssue([...path, fieldName], { reason: 'extra' }));
    for (const [fieldName, fieldDeclaration] of Object.entries(declaration.fields)) {
      if (!Object.hasOwn(input, fieldName)) {
        if (!optional.has(fieldName)) issues.push(queryParameterIssue([...path, fieldName], { reason: 'missing' }));
        continue;
      }
      const parsed = parseDeclaredValue(fieldDeclaration, input[fieldName], [...path, fieldName], options);
      if (parsed.success) output[fieldName] = parsed.value; else issues.push(...parsed.issues);
    }
    return issues.length === 0 ? { success: true, value: output, issues: [] } : { success: false, issues };
  }
  return parseScalarValue(declaration, input, {
    ...(options.registry === undefined ? {} : { registry: options.registry }),
    ...(options.refFields === undefined ? {} : { refFields: options.refFields }),
    path
  });
};

const queryParameterIssue = (path: readonly unknown[], details: JsonValue): Issue => createIssue({ code: 'query.parameter_invalid', phase: 'query', severity: 'error', retry: 'after_input', path, details });
const queryParameterFailure = (path: readonly unknown[], details: JsonValue): ParseResult<never> => ({ success: false, issues: [queryParameterIssue(path, details)] });
const isRecord = (value: unknown): value is Readonly<Record<string, PortableValue>> => value !== null && typeof value === 'object' && !Array.isArray(value);
