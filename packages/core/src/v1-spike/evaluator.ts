import { canonicalJson, issue, sameJson, type CapabilityRef, type Expr, type Issue, type JsonValue, type QueryNode, type RelationUse } from './wire.js';

const missing = Symbol('tarstate.v1-spike.missing');
type Missing = typeof missing;
export type LogicalTruth = boolean | 'unknown';
export type Completeness = 'exact' | 'lower-bound' | 'unknown';
export type ScopedRow = Readonly<Record<string, Readonly<Record<string, JsonValue>>>>;

export type RelationInput = {
  readonly relation: RelationUse;
  readonly rows: readonly Readonly<Record<string, JsonValue>>[];
  readonly completeness: Completeness;
  readonly sourceIds?: readonly string[];
};

export type SpikeFunction = (args: readonly JsonValue[]) => JsonValue;
export type EvaluateQueryInput = {
  readonly root: QueryNode;
  readonly relations: readonly RelationInput[];
  readonly parameters?: Readonly<Record<string, JsonValue>>;
  readonly functions?: ReadonlyMap<string, SpikeFunction>;
};

export type EvaluateQueryResult = {
  readonly rows: readonly ScopedRow[];
  readonly completeness: Completeness;
  readonly issues: readonly Issue[];
};

type Evaluation = EvaluateQueryResult;
type ExprContext = {
  readonly row: ScopedRow;
  readonly parameters: Readonly<Record<string, JsonValue>>;
  readonly functions: ReadonlyMap<string, SpikeFunction>;
  readonly issues: Issue[];
};

const relationKey = (relation: RelationUse): string => relation.schemaView.id + '\u0000' + relation.schemaView.contentHash + '\u0000' + relation.relationId;
const capabilityKey = (capability: CapabilityRef): string => capability.id + '\u0000' + capability.version + '\u0000' + capability.contractHash;

export const evaluateQuery = (input: EvaluateQueryInput): EvaluateQueryResult => {
  const issues: Issue[] = [];
  const context = {
    relations: new Map(input.relations.map((relation) => [relationKey(relation.relation), relation])),
    parameters: input.parameters ?? {},
    functions: input.functions ?? new Map<string, SpikeFunction>(),
    issues
  };
  const result = evaluateNode(input.root, context);
  if (result.completeness === 'unknown') return { rows: [], completeness: 'unknown', issues };
  return { rows: result.rows, completeness: result.completeness, issues };
};

type NodeContext = {
  readonly relations: ReadonlyMap<string, RelationInput>;
  readonly parameters: Readonly<Record<string, JsonValue>>;
  readonly functions: ReadonlyMap<string, SpikeFunction>;
  readonly issues: Issue[];
};

const evaluateNode = (node: QueryNode, context: NodeContext): Evaluation => {
  if (node.kind === 'extension') {
    context.issues.push(issue('query.capability_unavailable', 'query', { capability: node.capability.id }, { retry: 'after_input' }));
    return { rows: [], completeness: 'unknown', issues: context.issues };
  }
  if (node.kind === 'from') {
    const input = context.relations.get(relationKey(node.relation));
    if (input === undefined) {
      context.issues.push(issue('query.input_unavailable', 'query', { relationId: node.relation.relationId }, { relationId: node.relation.relationId, retry: 'after_refresh' }));
      return { rows: [], completeness: 'unknown', issues: context.issues };
    }
    return {
      rows: input.completeness === 'unknown' ? [] : input.rows.map((row) => ({ [node.alias]: row })),
      completeness: input.completeness,
      issues: context.issues
    };
  }
  if (node.kind === 'where') {
    const inner = evaluateNode(node.input, context);
    if (inner.completeness === 'unknown') return inner;
    return {
      rows: inner.rows.filter((row) => asTruth(evaluateExpr(node.predicate, exprContext(row, context))) === true),
      completeness: inner.completeness,
      issues: context.issues
    };
  }
  if (node.kind === 'select') {
    const inner = evaluateNode(node.input, context);
    if (inner.completeness === 'unknown') return inner;
    return {
      rows: inner.rows.map((row) => ({ [node.alias]: project(node.fields, exprContext(row, context)) })),
      completeness: inner.completeness,
      issues: context.issues
    };
  }
  if (node.kind === 'join') {
    const left = evaluateNode(node.left, context);
    const right = evaluateNode(node.right, context);
    if (left.completeness === 'unknown' || right.completeness === 'unknown' || (node.join === 'anti' && (left.completeness !== 'exact' || right.completeness !== 'exact'))) {
      context.issues.push(issue('query.incomplete_non_monotone', 'query', { operator: node.join }));
      return { rows: [], completeness: 'unknown', issues: context.issues };
    }
    const rows: ScopedRow[] = [];
    for (const leftRow of left.rows) {
      let matched = false;
      for (const rightRow of right.rows) {
        const combined = { ...leftRow, ...rightRow };
        if (asTruth(evaluateExpr(node.on, exprContext(combined, context))) !== true) continue;
        matched = true;
        if (node.join === 'inner') rows.push(combined);
      }
      if (node.join === 'anti' && !matched) rows.push(leftRow);
    }
    return {
      rows,
      completeness: left.completeness === 'exact' && right.completeness === 'exact' ? 'exact' : 'lower-bound',
      issues: context.issues
    };
  }
  const inner = evaluateNode(node.input, context);
  if (inner.completeness !== 'exact') {
    context.issues.push(issue('query.incomplete_non_monotone', 'query', { operator: 'aggregate' }));
    return { rows: [], completeness: 'unknown', issues: context.issues };
  }
  const groups = new Map<string, { group: Readonly<Record<string, JsonValue>>; rows: ScopedRow[] }>();
  for (const row of inner.rows) {
    const group = project(node.groupBy, exprContext(row, context));
    const key = canonicalJson(group);
    const existing = groups.get(key);
    if (existing === undefined) groups.set(key, { group, rows: [row] });
    else existing.rows.push(row);
  }
  if (groups.size === 0 && Object.keys(node.groupBy).length === 0) groups.set('{}', { group: {}, rows: [] });
  const rows = [...groups.values()].map(({ group, rows: groupRows }) => {
    const output: Record<string, JsonValue> = { ...group };
    for (const [name, aggregate] of Object.entries(node.measures)) {
      const values = aggregate.value === undefined
        ? groupRows.map(() => 1 as JsonValue)
        : groupRows.map((row) => evaluateExpr(aggregate.value as Expr, exprContext(row, context))).filter((value): value is JsonValue => value !== missing && value !== null);
      output[name] = aggregate.distinct ? new Set(values.map(canonicalJson)).size : values.length;
    }
    return { [node.alias]: output };
  });
  return { rows, completeness: 'exact', issues: context.issues };
};

const exprContext = (row: ScopedRow, context: NodeContext): ExprContext => ({
  row,
  parameters: context.parameters,
  functions: context.functions,
  issues: context.issues
});

export const evaluateExpression = (
  expression: Expr,
  row: ScopedRow,
  parameters: Readonly<Record<string, JsonValue>> = {},
  functions: ReadonlyMap<string, SpikeFunction> = new Map()
): JsonValue | Missing => evaluateExpr(expression, { row, parameters, functions, issues: [] });

const evaluateExpr = (expression: Expr, context: ExprContext): JsonValue | Missing => {
  if (expression.kind === 'literal') return expression.value;
  if (expression.kind === 'parameter') return Object.hasOwn(context.parameters, expression.name) ? context.parameters[expression.name] as JsonValue : missing;
  if (expression.kind === 'field') {
    const relation = context.row[expression.alias];
    return relation !== undefined && Object.hasOwn(relation, expression.name) ? relation[expression.name] as JsonValue : missing;
  }
  if (expression.kind === 'compare') {
    const left = evaluateExpr(expression.left, context);
    const right = evaluateExpr(expression.right, context);
    if (left === missing || right === missing || left === null || right === null) return 'unknown';
    const comparison = compareJson(left, right);
    if (expression.op === 'eq') return sameJson(left, right);
    if (expression.op === 'ne') return !sameJson(left, right);
    if (comparison === undefined) return 'unknown';
    if (expression.op === 'lt') return comparison < 0;
    if (expression.op === 'lte') return comparison <= 0;
    if (expression.op === 'gt') return comparison > 0;
    return comparison >= 0;
  }
  if (expression.kind === 'boolean') {
    if (expression.op === 'not') {
      const value = asTruth(evaluateExpr(expression.arg, context));
      return value === 'unknown' ? value : !value;
    }
    const values = expression.args.map((argument) => asTruth(evaluateExpr(argument, context)));
    if (expression.op === 'and') return values.includes(false) ? false : values.includes('unknown') ? 'unknown' : true;
    return values.includes(true) ? true : values.includes('unknown') ? 'unknown' : false;
  }
  if (expression.kind === 'call') {
    const fn = context.functions.get(capabilityKey(expression.capability));
    if (fn === undefined) {
      context.issues.push(issue('query.capability_unavailable', 'query', { capability: expression.capability.id }, { retry: 'after_input' }));
      return missing;
    }
    const args = expression.args.map((argument) => evaluateExpr(argument, context));
    return args.some((argument) => argument === missing) ? missing : fn(args as JsonValue[]);
  }
  context.issues.push(issue('query.capability_unavailable', 'query', { capability: expression.capability.id }, { retry: 'after_input' }));
  return missing;
};

const project = (fields: Readonly<Record<string, Expr>>, context: ExprContext): Readonly<Record<string, JsonValue>> => {
  const output: Record<string, JsonValue> = {};
  for (const [name, expression] of Object.entries(fields)) {
    const value = evaluateExpr(expression, context);
    if (value !== missing) output[name] = value;
  }
  return output;
};

const asTruth = (value: JsonValue | Missing): LogicalTruth => value === true ? true : value === false ? false : 'unknown';

const compareJson = (left: JsonValue, right: JsonValue): number | undefined => {
  if (typeof left !== typeof right || left === null || right === null || typeof left === 'object') return undefined;
  if (typeof left === 'number' && typeof right === 'number') return left < right ? -1 : left > right ? 1 : 0;
  if (typeof left === 'string' && typeof right === 'string') return left < right ? -1 : left > right ? 1 : 0;
  if (typeof left === 'boolean' && typeof right === 'boolean') return left === right ? 0 : left ? 1 : -1;
  return undefined;
};
