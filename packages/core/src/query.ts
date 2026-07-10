import { canonicalizeJson, sha256Json, type ArtifactRef } from './artifacts.js';
import { createIssue, type CapabilityRef, type Issue } from './issues.js';
import { capabilityUnavailable, logicalAnd, logicalNot, logicalOr, logicalUnknown, missingValue, type EvaluationValue, type JsonValue, type LogicalTruth, type LogicalUnknown } from './value.js';
import { FullRecomputeStrategy, type PreparedPlan } from './maintenance.js';

export type Completeness = 'exact' | 'lower-bound' | 'unknown';
export type QueryLogicalValue = null | boolean | number | string | LogicalUnknown | readonly QueryLogicalValue[] | { readonly [key: string]: QueryLogicalValue };
export type QueryRecord = Readonly<Record<string, QueryLogicalValue>>;

export type RelationUse = { readonly schemaView: ArtifactRef; readonly relationId: string };
export type RelationInput = {
  readonly relation: RelationUse;
  readonly rows: readonly QueryRecord[];
  /** Stable base-row occurrence identities; attachment view identity is deliberately excluded. */
  readonly occurrenceIds?: readonly string[];
  readonly completeness: Completeness;
  readonly sourceId?: string;
  readonly attachmentId?: string;
  readonly basis?: JsonValue;
};

export type QueryFunction = (args: readonly JsonValue[]) => JsonValue;
export type FunctionRegistry = ReadonlyMap<string, QueryFunction>;

export type Expr =
  | { readonly kind: 'literal'; readonly value: JsonValue }
  | { readonly kind: 'parameter'; readonly name: string }
  | { readonly kind: 'field'; readonly alias: string; readonly name: string }
  | { readonly kind: 'compare'; readonly op: 'eq' | 'ne' | 'lt' | 'lte' | 'gt' | 'gte'; readonly left: Expr; readonly right: Expr }
  | { readonly kind: 'boolean'; readonly op: 'and' | 'or'; readonly args: readonly Expr[] }
  | { readonly kind: 'boolean'; readonly op: 'not'; readonly arg: Expr }
  | { readonly kind: 'arithmetic'; readonly op: 'add' | 'subtract' | 'multiply' | 'divide' | 'modulo'; readonly left: Expr; readonly right: Expr }
  | { readonly kind: 'string'; readonly op: 'concat' | 'lower' | 'upper' | 'length'; readonly args: readonly Expr[] }
  | { readonly kind: 'array'; readonly items: readonly Expr[] }
  | { readonly kind: 'record'; readonly fields: Readonly<Record<string, Expr>> }
  | { readonly kind: 'case'; readonly branches: readonly { readonly when: Expr; readonly then: Expr }[]; readonly otherwise: Expr }
  | { readonly kind: 'coalesce'; readonly args: readonly Expr[] }
  | { readonly kind: 'call'; readonly capability: CapabilityRef; readonly args: readonly Expr[] }
  | { readonly kind: 'subquery'; readonly mode: 'scalar' | 'exists'; readonly query: QueryNode }
  | { readonly kind: 'is-null' | 'is-missing'; readonly value: Expr }
  | { readonly kind: 'key-of' | 'source-of'; readonly alias: string };

export type AggregateExpr = {
  readonly kind: 'aggregate';
  readonly op: 'count' | 'count-distinct' | 'sum' | 'average' | 'minimum' | 'maximum' | 'any' | 'every' | 'collect' | 'first' | 'last';
  readonly value?: Expr;
  readonly orderBy?: readonly OrderTerm[];
};

export type OrderTerm = { readonly value: Expr; readonly direction: 'asc' | 'desc'; readonly nulls?: 'first' | 'last' };

export type WindowExpr = {
  readonly kind: 'window';
  readonly op: 'row-number' | 'rank' | 'lag';
  readonly value?: Expr;
  readonly offset?: number;
  readonly partitionBy?: readonly Expr[];
  readonly orderBy: readonly OrderTerm[];
};

export type QueryNode =
  | { readonly kind: 'from'; readonly relation: RelationUse; readonly alias: string }
  | { readonly kind: 'values'; readonly alias: string; readonly rows: readonly QueryRecord[] }
  | { readonly kind: 'where'; readonly input: QueryNode; readonly predicate: Expr }
  | { readonly kind: 'select'; readonly input: QueryNode; readonly alias: string; readonly fields: Readonly<Record<string, Expr>> }
  | { readonly kind: 'with-fields'; readonly input: QueryNode; readonly alias: string; readonly fields: Readonly<Record<string, Expr>> }
  | { readonly kind: 'rename'; readonly input: QueryNode; readonly alias: string; readonly fields: Readonly<Record<string, string>> }
  | { readonly kind: 'omit'; readonly input: QueryNode; readonly alias: string; readonly fields: readonly string[] }
  | { readonly kind: 'unnest'; readonly input: QueryNode; readonly expression: Expr; readonly alias: string; readonly field: string }
  | { readonly kind: 'join'; readonly join: 'inner' | 'cross' | 'left' | 'semi' | 'anti'; readonly left: QueryNode; readonly right: QueryNode; readonly on?: Expr }
  | { readonly kind: 'aggregate'; readonly input: QueryNode; readonly alias: string; readonly groupBy: Readonly<Record<string, Expr>>; readonly measures: Readonly<Record<string, AggregateExpr>> }
  | { readonly kind: 'distinct'; readonly input: QueryNode }
  | { readonly kind: 'set'; readonly op: 'union' | 'union-all' | 'intersect' | 'except'; readonly left: QueryNode; readonly right: QueryNode }
  | { readonly kind: 'order'; readonly input: QueryNode; readonly by: readonly OrderTerm[] }
  | { readonly kind: 'slice'; readonly input: QueryNode; readonly offset?: number; readonly limit?: number }
  | { readonly kind: 'window'; readonly input: QueryNode; readonly alias: string; readonly fields: Readonly<Record<string, WindowExpr>> }
  | { readonly kind: 'seek'; readonly input: QueryNode; readonly by: readonly OrderTerm[]; readonly after: QueryCursor }
  | { readonly kind: 'recursion-ref'; readonly name: string }
  | { readonly kind: 'recursive'; readonly name: string; readonly seed: QueryNode; readonly step: QueryNode; readonly key: readonly Expr[]; readonly maxIterations?: number; readonly maxRows?: number };

export type QueryCursor = {
  readonly order: readonly JsonValue[];
  readonly resultKey: string;
  readonly basis: JsonValue;
  readonly membershipRevision: number;
  readonly mode: 'live' | 'pinned';
};

export type QueryRequest = {
  readonly root: QueryNode;
  readonly relations: readonly RelationInput[];
  readonly parameters?: Readonly<Record<string, JsonValue>>;
  readonly functions?: FunctionRegistry;
  readonly basis?: JsonValue;
  readonly membershipRevision?: number;
};

export type QueryResult = {
  readonly rows: readonly QueryRecord[];
  readonly resultKeys: readonly string[];
  readonly completeness: Completeness;
  readonly issues: readonly Issue[];
};

type Provenance = { readonly sourceId?: string; readonly attachmentId?: string; readonly relationId: string; readonly key?: JsonValue; readonly occurrence: string };
type ScopedRow = { readonly scope: Readonly<Record<string, QueryRecord>>; readonly provenance: Readonly<Record<string, Provenance>> };
type NodeResult = { readonly rows: readonly ScopedRow[]; readonly completeness: Completeness };
type ExpressionResult = { readonly status: 'known'; readonly value: JsonValue } | { readonly status: 'missing' | 'unknown' | 'indeterminate' | 'unavailable' };
type EvalContext = { readonly row: ScopedRow; readonly parameters: Readonly<Record<string, JsonValue>>; readonly functions: FunctionRegistry; readonly issues: Issue[]; readonly query?: QueryContext };
type QueryContext = {
  readonly relations: ReadonlyMap<string, RelationInput>;
  readonly parameters: Readonly<Record<string, JsonValue>>;
  readonly functions: FunctionRegistry;
  readonly issues: Issue[];
  readonly recursions: Map<string, readonly ScopedRow[]>;
  readonly basis?: JsonValue;
  readonly membershipRevision?: number;
  readonly outer?: ScopedRow;
  unavailable: boolean;
};

const relationKey = (relation: RelationUse): string => relation.schemaView.id + '\u0000' + relation.schemaView.contentHash + '\u0000' + relation.relationId;
const capabilityKey = (ref: CapabilityRef): string => ref.id + '\u0000' + ref.version + '\u0000' + ref.contractHash;

export const evaluateQuery = (request: QueryRequest): QueryResult => {
  const issues: Issue[] = [];
  const context: QueryContext = {
    relations: new Map(request.relations.map((input) => [relationKey(input.relation), input])),
    parameters: request.parameters ?? {},
    functions: request.functions ?? new Map(),
    issues,
    recursions: new Map(),
    ...(request.basis === undefined ? {} : { basis: request.basis }),
    ...(request.membershipRevision === undefined ? {} : { membershipRevision: request.membershipRevision }),
    unavailable: false
  };
  const result = evaluateNode(request.root, context);
  if (context.unavailable || result.completeness === 'unknown') return { rows: [], resultKeys: [], completeness: 'unknown', issues };
  const rows = result.rows.map(visibleRow);
  return { rows, resultKeys: result.rows.map(resultKey), completeness: result.completeness, issues };
};

export const prepareQuery = async (input: {
  readonly root: QueryNode;
  readonly registryFingerprint: string;
  readonly authorityFingerprint: string;
  readonly datasetId: string;
}): Promise<PreparedPlan<QueryNode>> => {
  const semantic = { root: input.root, registryFingerprint: input.registryFingerprint, authorityFingerprint: input.authorityFingerprint, datasetId: input.datasetId } as unknown as JsonValue;
  const planId = await sha256Json(semantic);
  return { planId, rootNodeId: planId + ':root', query: input.root, registryFingerprint: input.registryFingerprint, authorityFingerprint: input.authorityFingerprint, datasetId: input.datasetId };
};

export const queryMaintenanceEvaluator = (relations: readonly RelationInput[], parameters?: Readonly<Record<string, JsonValue>>, functions?: FunctionRegistry) =>
  (plan: PreparedPlan<QueryNode>): Omit<import('./maintenance.js').MaintainedResult<QueryRecord>, 'state'> => evaluateQuery({ root: plan.query, relations, ...(parameters === undefined ? {} : { parameters }), ...(functions === undefined ? {} : { functions }) });

const evaluateNode = (node: QueryNode, context: QueryContext): NodeResult => {
  if (node.kind === 'from') {
    const input = context.relations.get(relationKey(node.relation));
    if (input === undefined || input.completeness === 'unknown') {
      context.issues.push(createIssue({ code: 'query.parameter_invalid', phase: 'query', severity: 'error', retry: 'after_refresh', relationId: node.relation.relationId, details: { reason: 'input_unavailable' } }));
      return { rows: [], completeness: 'unknown' };
    }
    if (input.occurrenceIds !== undefined && input.occurrenceIds.length !== input.rows.length) {
      context.issues.push(createIssue({ code: 'query.input_identity_invalid', phase: 'query', severity: 'error', retry: 'after_input', relationId: node.relation.relationId }));
      return { rows: [], completeness: 'unknown' };
    }
    return {
      rows: input.rows.map((fields, index) => ({
        scope: { ...context.outer?.scope, [node.alias]: fields },
        provenance: { ...context.outer?.provenance, [node.alias]: { ...(input.sourceId === undefined ? {} : { sourceId: input.sourceId }), ...(input.attachmentId === undefined ? {} : { attachmentId: input.attachmentId }), relationId: node.relation.relationId, ...(Object.hasOwn(fields, 'id') ? { key: fields.id as JsonValue } : {}), occurrence: input.occurrenceIds?.[index] ?? relationKey(node.relation) + ':' + index } }
      })),
      completeness: input.completeness
    };
  }
  if (node.kind === 'values') return { rows: node.rows.map((fields, index) => ({ scope: { ...context.outer?.scope, [node.alias]: fields }, provenance: { ...context.outer?.provenance, [node.alias]: { relationId: 'values', occurrence: 'values:' + index } } })), completeness: 'exact' };
  if (node.kind === 'recursion-ref') return { rows: context.recursions.get(node.name) ?? [], completeness: 'exact' };
  if (node.kind === 'recursive') return evaluateRecursive(node, context);
  if (node.kind === 'where') {
    const inner = evaluateNode(node.input, context);
    if (inner.completeness === 'unknown') return inner;
    const rows = inner.rows.filter((row) => {
      const result = evaluateExpr(node.predicate, exprContext(row, context));
      if (result.status === 'unavailable' || result.status === 'indeterminate') context.unavailable = true;
      return result.status === 'known' && result.value === true;
    });
    return context.unavailable ? { rows: [], completeness: 'unknown' } : { rows, completeness: inner.completeness };
  }
  if (node.kind === 'select') {
    const inner = evaluateNode(node.input, context);
    return mapProjection(inner, node.alias, (row) => projectFields(node.fields, exprContext(row, context)), context);
  }
  if (node.kind === 'with-fields') {
    const inner = evaluateNode(node.input, context);
    const rows = inner.rows.map((row) => {
      const base = row.scope[node.alias] ?? {};
      const additions = projectFields(node.fields, exprContext(row, context));
      return { scope: { ...row.scope, [node.alias]: { ...base, ...additions } }, provenance: row.provenance };
    });
    return context.unavailable ? { rows: [], completeness: 'unknown' } : { rows, completeness: inner.completeness };
  }
  if (node.kind === 'rename') {
    const inner = evaluateNode(node.input, context);
    return { rows: inner.rows.map((row) => ({ ...row, scope: { ...row.scope, [node.alias]: renameFields(row.scope[node.alias] ?? {}, node.fields) } })), completeness: inner.completeness };
  }
  if (node.kind === 'omit') {
    const inner = evaluateNode(node.input, context);
    return { rows: inner.rows.map((row) => ({ ...row, scope: { ...row.scope, [node.alias]: omitFields(row.scope[node.alias] ?? {}, new Set(node.fields)) } })), completeness: inner.completeness };
  }
  if (node.kind === 'unnest') {
    const inner = evaluateNode(node.input, context);
    const rows: ScopedRow[] = [];
    for (const row of inner.rows) {
      const value = evaluateExpr(node.expression, exprContext(row, context));
      if (value.status === 'unavailable' || value.status === 'indeterminate') context.unavailable = true;
      if (value.status !== 'known' || !Array.isArray(value.value)) continue;
      value.value.forEach((item, index) => rows.push({ scope: { ...row.scope, [node.alias]: { [node.field]: item } }, provenance: { ...row.provenance, [node.alias]: { relationId: 'unnest', occurrence: resultKey(row) + ':' + index } } }));
    }
    return context.unavailable ? { rows: [], completeness: 'unknown' } : { rows, completeness: inner.completeness };
  }
  if (node.kind === 'join') return evaluateJoin(node, context);
  if (node.kind === 'aggregate') return evaluateAggregate(node, context);
  if (node.kind === 'distinct') {
    const inner = evaluateNode(node.input, context);
    const seen = new Set<string>();
    return { rows: inner.rows.filter((row) => { const key = canonicalizeQueryValue(visibleRow(row)); if (seen.has(key)) return false; seen.add(key); return true; }), completeness: inner.completeness };
  }
  if (node.kind === 'set') return evaluateSet(node, context);
  if (node.kind === 'order') {
    const inner = evaluateNode(node.input, context);
    if (inner.completeness !== 'exact') return nonMonotoneUnknown(context, 'order');
    const rows = [...inner.rows].sort((left, right) => compareOrder(left, right, node.by, context));
    return context.unavailable ? { rows: [], completeness: 'unknown' } : { rows, completeness: 'exact' };
  }
  if (node.kind === 'slice') {
    const inner = evaluateNode(node.input, context);
    if (inner.completeness !== 'exact') return nonMonotoneUnknown(context, 'slice');
    const offset = Math.max(0, node.offset ?? 0);
    const end = node.limit === undefined ? undefined : offset + Math.max(0, node.limit);
    return { rows: inner.rows.slice(offset, end), completeness: 'exact' };
  }
  if (node.kind === 'window') return evaluateWindow(node, context);
  return evaluateSeek(node, context);
};

const evaluateJoin = (node: Extract<QueryNode, { readonly kind: 'join' }>, context: QueryContext): NodeResult => {
  const left = evaluateNode(node.left, context);
  const right = evaluateNode(node.right, context);
  if (left.completeness === 'unknown' || right.completeness === 'unknown') return { rows: [], completeness: 'unknown' };
  if ((node.join === 'anti' || node.join === 'left') && right.completeness !== 'exact') return nonMonotoneUnknown(context, node.join);
  const rows: ScopedRow[] = [];
  for (const leftRow of left.rows) {
    let matched = false;
    for (const rightRow of right.rows) {
      const combined = { scope: { ...leftRow.scope, ...rightRow.scope }, provenance: { ...leftRow.provenance, ...rightRow.provenance } };
      const result = node.join === 'cross' || node.on === undefined ? known(true) : evaluateExpr(node.on, exprContext(combined, context));
      if (result.status === 'unavailable' || result.status === 'indeterminate') context.unavailable = true;
      if (result.status !== 'known' || result.value !== true) continue;
      matched = true;
      if (node.join === 'inner' || node.join === 'cross' || node.join === 'left') rows.push(combined);
    }
    if (node.join === 'semi' && matched) rows.push(leftRow);
    if (node.join === 'anti' && !matched) rows.push(leftRow);
    if (node.join === 'left' && !matched) {
      const missingRight = Object.fromEntries([...queryAliases(node.right)].map((alias) => [alias, {}]));
      rows.push({ scope: { ...leftRow.scope, ...missingRight }, provenance: leftRow.provenance });
    }
  }
  if (context.unavailable) return { rows: [], completeness: 'unknown' };
  return { rows, completeness: left.completeness === 'exact' && right.completeness === 'exact' ? 'exact' : 'lower-bound' };
};

const evaluateAggregate = (node: Extract<QueryNode, { readonly kind: 'aggregate' }>, context: QueryContext): NodeResult => {
  const inner = evaluateNode(node.input, context);
  if (inner.completeness !== 'exact') return nonMonotoneUnknown(context, 'aggregate');
  const groups = new Map<string, { readonly key: QueryRecord; readonly rows: ScopedRow[] }>();
  for (const row of inner.rows) {
    const key = projectFields(node.groupBy, exprContext(row, context));
    const canonical = canonicalizeQueryValue(key);
    const existing = groups.get(canonical);
    if (existing === undefined) groups.set(canonical, { key, rows: [row] });
    else existing.rows.push(row);
  }
  if (groups.size === 0 && Object.keys(node.groupBy).length === 0) groups.set('{}', { key: {}, rows: [] });
  const rows = [...groups.values()].map(({ key, rows: members }, index): ScopedRow => {
    const output: Record<string, QueryLogicalValue> = { ...key };
    for (const [name, aggregate] of Object.entries(node.measures)) output[name] = aggregateValue(aggregate, members, context);
    return { scope: { [node.alias]: output }, provenance: { [node.alias]: { relationId: 'aggregate', occurrence: 'aggregate:' + index + ':' + canonicalizeQueryValue(key) } } };
  });
  return context.unavailable ? { rows: [], completeness: 'unknown' } : { rows, completeness: 'exact' };
};

const aggregateValue = (aggregate: AggregateExpr, rows: readonly ScopedRow[], context: QueryContext): QueryLogicalValue => {
  const ordered = aggregate.orderBy === undefined ? rows : [...rows].sort((left, right) => compareOrder(left, right, aggregate.orderBy ?? [], context));
  const values = aggregate.value === undefined ? ordered.map(() => known(1)) : ordered.map((row) => evaluateExpr(aggregate.value as Expr, exprContext(row, context)));
  if (values.some((value) => value.status === 'unavailable' || value.status === 'indeterminate')) context.unavailable = true;
  const knownValues = values.filter((result): result is { readonly status: 'known'; readonly value: JsonValue } => result.status === 'known' && result.value !== null).map((result) => result.value);
  if (aggregate.op === 'count') return knownValues.length;
  if (aggregate.op === 'count-distinct') return new Set(knownValues.map(canonicalizeJson)).size;
  if (aggregate.op === 'collect') return knownValues;
  if (aggregate.op === 'first') return knownValues[0] ?? null;
  if (aggregate.op === 'last') return knownValues.at(-1) ?? null;
  if (aggregate.op === 'any' || aggregate.op === 'every') {
    const truths = values.map((result): LogicalTruth => result.status === 'known' && typeof result.value === 'boolean' ? result.value : logicalUnknown);
    const truth = aggregate.op === 'any' ? logicalOr(truths) : logicalAnd(truths);
    return truth;
  }
  const numbers = knownValues.filter((value): value is number => typeof value === 'number');
  if (aggregate.op === 'sum') return numbers.length === 0 ? null : numbers.reduce((sum, value) => sum + value, 0);
  if (aggregate.op === 'average') return numbers.length === 0 ? null : numbers.reduce((sum, value) => sum + value, 0) / numbers.length;
  if (knownValues.length === 0) return null;
  const sorted = [...knownValues].sort(compareJsonValuesTotal);
  return aggregate.op === 'minimum' ? sorted[0] as JsonValue : sorted.at(-1) as JsonValue;
};

const evaluateSet = (node: Extract<QueryNode, { readonly kind: 'set' }>, context: QueryContext): NodeResult => {
  const left = evaluateNode(node.left, context);
  const right = evaluateNode(node.right, context);
  if (left.completeness === 'unknown' || right.completeness === 'unknown') return { rows: [], completeness: 'unknown' };
  if (node.op === 'except' && right.completeness !== 'exact') return nonMonotoneUnknown(context, node.op);
  if (node.op === 'union-all') return { rows: [...left.rows, ...right.rows], completeness: left.completeness === 'exact' && right.completeness === 'exact' ? 'exact' : 'lower-bound' };
  const leftMap = uniqueRows(left.rows);
  const rightMap = uniqueRows(right.rows);
  if (node.op === 'union') return { rows: [...new Map([...leftMap, ...rightMap]).values()], completeness: left.completeness === 'exact' && right.completeness === 'exact' ? 'exact' : 'lower-bound' };
  if (node.op === 'intersect') return { rows: [...leftMap].filter(([key]) => rightMap.has(key)).map(([, row]) => row), completeness: left.completeness === 'exact' && right.completeness === 'exact' ? 'exact' : 'lower-bound' };
  return { rows: [...leftMap].filter(([key]) => !rightMap.has(key)).map(([, row]) => row), completeness: left.completeness };
};

const evaluateWindow = (node: Extract<QueryNode, { readonly kind: 'window' }>, context: QueryContext): NodeResult => {
  const inner = evaluateNode(node.input, context);
  if (inner.completeness !== 'exact') return nonMonotoneUnknown(context, 'window');
  const output = [...inner.rows];
  for (const [field, window] of Object.entries(node.fields)) {
    const partitions = new Map<string, ScopedRow[]>();
    for (const row of output) {
      const partitionValues = (window.partitionBy ?? []).map((expr) => evaluateExpr(expr, exprContext(row, context)));
      if (partitionValues.some((value) => value.status === 'unavailable' || value.status === 'indeterminate')) context.unavailable = true;
      const key = canonicalizeJson(partitionValues.map(expressionJson));
      const rows = partitions.get(key) ?? [];
      rows.push(row);
      partitions.set(key, rows);
    }
    for (const partition of partitions.values()) {
      partition.sort((left, right) => compareOrder(left, right, window.orderBy, context));
      let rank = 1;
      let previousOrder: string | undefined;
      partition.forEach((row, index) => {
        const orderValues = window.orderBy.map((term) => evaluateExpr(term.value, exprContext(row, context)));
        if (orderValues.some((item) => item.status === 'unavailable' || item.status === 'indeterminate')) context.unavailable = true;
        const orderKey = canonicalizeJson(orderValues.map(expressionJson));
        if (previousOrder !== undefined && previousOrder !== orderKey) rank = index + 1;
        previousOrder = orderKey;
        let value: JsonValue = window.op === 'row-number' ? index + 1 : rank;
        if (window.op === 'lag') {
          const previous = partition[index - (window.offset ?? 1)];
          const lagged = previous === undefined || window.value === undefined ? undefined : evaluateExpr(window.value, exprContext(previous, context));
          if (lagged?.status === 'unavailable' || lagged?.status === 'indeterminate') context.unavailable = true;
          value = lagged === undefined ? null : expressionJson(lagged);
        }
        const aliasFields = row.scope[node.alias] ?? {};
        const rowIndex = output.indexOf(row);
        output[rowIndex] = { ...row, scope: { ...row.scope, [node.alias]: { ...aliasFields, [field]: value } } };
      });
    }
  }
  return context.unavailable ? { rows: [], completeness: 'unknown' } : { rows: output, completeness: 'exact' };
};

const evaluateSeek = (node: Extract<QueryNode, { readonly kind: 'seek' }>, context: QueryContext): NodeResult => {
  const inner = evaluateNode(node.input, context);
  if (inner.completeness !== 'exact') return nonMonotoneUnknown(context, 'seek');
  if (context.basis === undefined || context.membershipRevision === undefined || canonicalizeJson(context.basis) !== canonicalizeJson(node.after.basis) || context.membershipRevision !== node.after.membershipRevision) {
    context.issues.push(createIssue({ code: 'query.cursor_stale', phase: 'query', severity: 'error', retry: 'after_refresh', details: { mode: node.after.mode } }));
    return { rows: [], completeness: 'unknown' };
  }
  const rows = [...inner.rows].sort((left, right) => compareOrder(left, right, node.by, context)).filter((row) => compareRowToCursor(row, node.by, node.after, context) > 0);
  return context.unavailable ? { rows: [], completeness: 'unknown' } : { rows, completeness: 'exact' };
};

const evaluateRecursive = (node: Extract<QueryNode, { readonly kind: 'recursive' }>, context: QueryContext): NodeResult => {
  if (!isMonotoneRecursiveBody(node.step)) {
    context.issues.push(createIssue({ code: 'query.recursion_non_monotone', phase: 'query', severity: 'error', retry: 'after_input' }));
    return { rows: [], completeness: 'unknown' };
  }
  const seed = evaluateNode(node.seed, context);
  if (seed.completeness !== 'exact') return nonMonotoneUnknown(context, 'recursive');
  const maxIterations = node.maxIterations ?? 100;
  const maxRows = node.maxRows ?? 100_000;
  const previous = context.recursions.get(node.name);
  const rows: ScopedRow[] = [];
  const keys = new Set<string>();
  const add = (candidate: ScopedRow): boolean => {
    const parts = node.key.map((expression) => evaluateExpr(expression, exprContext(candidate, context)));
    if (parts.some((part) => part.status === 'unavailable' || part.status === 'indeterminate')) context.unavailable = true;
    if (parts.some((part) => part.status !== 'known')) return false;
    const key = canonicalizeJson(parts.map((part) => (part as { readonly status: 'known'; readonly value: JsonValue }).value));
    if (keys.has(key)) return false;
    keys.add(key);
    rows.push(candidate);
    return true;
  };
  try {
    seed.rows.forEach(add);
    if (rows.length > maxRows) return recursionBudgetUnknown(context, 'rows', maxRows);
    for (let iteration = 0; iteration < maxIterations; iteration += 1) {
      context.recursions.set(node.name, [...rows]);
      const step = evaluateNode(node.step, context);
      if (step.completeness !== 'exact' || context.unavailable) return { rows: [], completeness: 'unknown' };
      let changed = false;
      for (const candidate of step.rows) {
        changed = add(candidate) || changed;
        if (rows.length > maxRows) return recursionBudgetUnknown(context, 'rows', maxRows);
      }
      if (!changed) return { rows, completeness: 'exact' };
    }
    return recursionBudgetUnknown(context, 'iterations', maxIterations);
  } finally {
    if (previous === undefined) context.recursions.delete(node.name);
    else context.recursions.set(node.name, previous);
  }
};

const recursionBudgetUnknown = (context: QueryContext, budget: 'rows' | 'iterations', limit: number): NodeResult => {
  context.issues.push(createIssue({ code: 'query.recursion_budget_exceeded', phase: 'query', severity: 'error', retry: 'after_input', details: { budget, limit } }));
  return { rows: [], completeness: 'unknown' };
};

const isMonotoneRecursiveBody = (node: QueryNode): boolean => {
  if (node.kind === 'aggregate' || node.kind === 'distinct' || node.kind === 'order' || node.kind === 'slice' || node.kind === 'window' || node.kind === 'seek') return false;
  if (node.kind === 'join' && (node.join === 'anti' || node.join === 'left')) return false;
  if (node.kind === 'set' && node.op !== 'union-all' && node.op !== 'union') return false;
  if (node.kind === 'where' || node.kind === 'select' || node.kind === 'with-fields' || node.kind === 'rename' || node.kind === 'omit' || node.kind === 'unnest') return isMonotoneRecursiveBody(node.input);
  if (node.kind === 'join' || node.kind === 'set') return isMonotoneRecursiveBody(node.left) && isMonotoneRecursiveBody(node.right);
  if (node.kind === 'recursive') return isMonotoneRecursiveBody(node.seed) && isMonotoneRecursiveBody(node.step);
  return true;
};

const queryAliases = (node: QueryNode): ReadonlySet<string> => {
  if (node.kind === 'from' || node.kind === 'values') return new Set([node.alias]);
  if (node.kind === 'select' || node.kind === 'aggregate') return new Set([node.alias]);
  if (node.kind === 'recursion-ref') return new Set();
  if (node.kind === 'recursive') return queryAliases(node.seed);
  if (node.kind === 'join') return node.join === 'semi' || node.join === 'anti' ? queryAliases(node.left) : new Set([...queryAliases(node.left), ...queryAliases(node.right)]);
  if (node.kind === 'set') return new Set([...queryAliases(node.left), ...queryAliases(node.right)]);
  if (node.kind === 'unnest') return new Set([...queryAliases(node.input), node.alias]);
  return queryAliases(node.input);
};

export const evaluateExpression = (expression: Expr, row: Readonly<Record<string, QueryRecord>>, options: { readonly parameters?: Readonly<Record<string, JsonValue>>; readonly functions?: FunctionRegistry } = {}): EvaluationValue => {
  const issues: Issue[] = [];
  const scoped: ScopedRow = { scope: row, provenance: {} };
  const result = evaluateExpr(expression, { row: scoped, parameters: options.parameters ?? {}, functions: options.functions ?? new Map(), issues });
  if (result.status === 'known') return result.value;
  if (result.status === 'missing') return missingValue;
  if (result.status === 'unknown' || result.status === 'indeterminate') return logicalUnknown;
  return capabilityUnavailable;
};

const evaluateExpr = (expression: Expr, context: EvalContext): ExpressionResult => {
  if (expression.kind === 'literal') return known(expression.value);
  if (expression.kind === 'parameter') return Object.hasOwn(context.parameters, expression.name) ? known(context.parameters[expression.name] as JsonValue) : { status: 'missing' };
  if (expression.kind === 'field') {
    const record = context.row.scope[expression.alias];
    if (record === undefined || !Object.hasOwn(record, expression.name)) return { status: 'missing' };
    const value = record[expression.name] as QueryLogicalValue;
    return value === logicalUnknown ? { status: 'unknown' } : known(value as JsonValue);
  }
  if (expression.kind === 'key-of' || expression.kind === 'source-of') {
    const provenance = context.row.provenance[expression.alias];
    if (provenance === undefined) return { status: 'missing' };
    const value = expression.kind === 'key-of' ? provenance.key : provenance.sourceId;
    return value === undefined ? { status: 'missing' } : known(value);
  }
  if (expression.kind === 'is-null' || expression.kind === 'is-missing') {
    const value = evaluateExpr(expression.value, context);
    if (value.status === 'unavailable' || value.status === 'indeterminate') return value;
    if (expression.kind === 'is-missing') return known(value.status === 'missing');
    if (value.status === 'unknown') return value;
    return known(value.status === 'known' && value.value === null);
  }
  if (expression.kind === 'compare') {
    const left = evaluateExpr(expression.left, context);
    const right = evaluateExpr(expression.right, context);
    const unavailable = propagate(left, right);
    if (unavailable !== undefined) return unavailable;
    if (left.status !== 'known' || right.status !== 'known' || left.value === null || right.value === null) return { status: 'unknown' };
    if (expression.op === 'eq' || expression.op === 'ne') {
      const equal = canonicalizeJson(left.value) === canonicalizeJson(right.value);
      return known(expression.op === 'eq' ? equal : !equal);
    }
    const comparison = compareJsonValues(left.value, right.value);
    if (comparison === undefined) return { status: 'unknown' };
    return known(expression.op === 'lt' ? comparison < 0 : expression.op === 'lte' ? comparison <= 0 : expression.op === 'gt' ? comparison > 0 : comparison >= 0);
  }
  if (expression.kind === 'boolean') {
    if (expression.op === 'not') {
      const value = evaluateExpr(expression.arg, context);
      if (value.status === 'unavailable' || value.status === 'indeterminate') return value;
      const truth = value.status === 'known' && typeof value.value === 'boolean' ? value.value : logicalUnknown;
      const result = logicalNot(truth);
      return result === logicalUnknown ? { status: 'unknown' } : known(result);
    }
    const values = expression.args.map((argument) => evaluateExpr(argument, context));
    if (values.some((value) => value.status === 'unavailable')) return { status: 'unavailable' };
    const truths = values.map((value): LogicalTruth => value.status === 'known' && typeof value.value === 'boolean' ? value.value : logicalUnknown);
    const result = expression.op === 'and' ? logicalAnd(truths) : logicalOr(truths);
    return result === logicalUnknown ? values.some((value) => value.status === 'indeterminate') ? { status: 'indeterminate' } : { status: 'unknown' } : known(result);
  }
  if (expression.kind === 'arithmetic') {
    const left = evaluateExpr(expression.left, context);
    const right = evaluateExpr(expression.right, context);
    const propagated = propagate(left, right);
    if (propagated !== undefined) return propagated;
    if (left.status !== 'known' || right.status !== 'known' || typeof left.value !== 'number' || typeof right.value !== 'number') return { status: 'unknown' };
    if ((expression.op === 'divide' || expression.op === 'modulo') && right.value === 0) return { status: 'unknown' };
    const value = expression.op === 'add' ? left.value + right.value : expression.op === 'subtract' ? left.value - right.value : expression.op === 'multiply' ? left.value * right.value : expression.op === 'divide' ? left.value / right.value : left.value % right.value;
    return Number.isFinite(value) ? known(value) : { status: 'unknown' };
  }
  if (expression.kind === 'string') {
    const args = expression.args.map((argument) => evaluateExpr(argument, context));
    if (args.some((value) => value.status === 'unavailable')) return { status: 'unavailable' };
    if (args.some((value) => value.status === 'indeterminate')) return { status: 'indeterminate' };
    if (args.some((value) => value.status !== 'known' || typeof value.value !== 'string')) return { status: 'unknown' };
    const strings = args.map((value) => (value as { readonly status: 'known'; readonly value: string }).value);
    return known(expression.op === 'concat' ? strings.join('') : expression.op === 'lower' ? (strings[0] ?? '').toLowerCase() : expression.op === 'upper' ? (strings[0] ?? '').toUpperCase() : Array.from(strings[0] ?? '').length);
  }
  if (expression.kind === 'array') {
    const values = expression.items.map((item) => evaluateExpr(item, context));
    if (values.some((value) => value.status === 'unavailable')) return { status: 'unavailable' };
    if (values.some((value) => value.status === 'indeterminate')) return { status: 'indeterminate' };
    if (values.some((value) => value.status !== 'known')) return { status: 'unknown' };
    return known(values.map((value) => (value as { readonly status: 'known'; readonly value: JsonValue }).value));
  }
  if (expression.kind === 'record') {
    const fields = projectFields(expression.fields, context);
    return Object.values(fields).some((value) => containsLogicalUnknown(value)) ? { status: 'unknown' } : known(fields as JsonValue);
  }
  if (expression.kind === 'case') {
    for (const branch of expression.branches) {
      const condition = evaluateExpr(branch.when, context);
      if (condition.status === 'unavailable' || condition.status === 'indeterminate') return condition;
      if (condition.status === 'known' && condition.value === true) return evaluateExpr(branch.then, context);
    }
    return evaluateExpr(expression.otherwise, context);
  }
  if (expression.kind === 'coalesce') {
    for (const argument of expression.args) {
      const value = evaluateExpr(argument, context);
      if (value.status === 'unavailable' || value.status === 'indeterminate') return value;
      if (value.status === 'unknown') return value;
      if (value.status === 'known' && value.value !== null) return value;
    }
    return known(null);
  }
  if (expression.kind === 'subquery') {
    if (context.query === undefined) return { status: 'unavailable' };
    const child: QueryContext = {
      relations: context.query.relations,
      parameters: context.parameters,
      functions: context.functions,
      issues: context.issues,
      recursions: context.query.recursions,
      ...(context.query.basis === undefined ? {} : { basis: context.query.basis }),
      ...(context.query.membershipRevision === undefined ? {} : { membershipRevision: context.query.membershipRevision }),
      outer: context.row,
      unavailable: false
    };
    const result = evaluateNode(expression.query, child);
    if (child.unavailable) { context.query.unavailable = true; return { status: 'unavailable' }; }
    if (result.completeness === 'unknown') return { status: 'indeterminate' };
    if (expression.mode === 'exists') return result.rows.length > 0 ? known(true) : result.completeness === 'exact' ? known(false) : { status: 'indeterminate' };
    if (result.completeness !== 'exact') return { status: 'indeterminate' };
    if (result.rows.length !== 1) {
      context.issues.push(createIssue({ code: 'query.scalar_subquery_cardinality', phase: 'query', severity: 'error', retry: 'after_input', details: { rows: result.rows.length } }));
      return { status: 'unknown' };
    }
    const record = visibleRow(result.rows[0] as ScopedRow);
    const values = Object.values(record);
    if (values.length !== 1) {
      context.issues.push(createIssue({ code: 'query.scalar_subquery_cardinality', phase: 'query', severity: 'error', retry: 'after_input', details: { fields: values.length } }));
      return { status: 'unknown' };
    }
    return values[0] === logicalUnknown ? { status: 'unknown' } : known(values[0] as JsonValue);
  }
  if (expression.kind === 'call') {
    const fn = context.functions.get(capabilityKey(expression.capability));
    if (fn === undefined) {
      context.issues.push(createIssue({ code: 'query.capability_unavailable', retry: 'after_capability', requiredCapabilities: [expression.capability] }));
      return { status: 'unavailable' };
    }
    const args = expression.args.map((argument) => evaluateExpr(argument, context));
    if (args.some((value) => value.status === 'unavailable')) return { status: 'unavailable' };
    if (args.some((value) => value.status !== 'known')) return { status: 'unknown' };
    try {
      return known(fn(args.map((value) => (value as { readonly status: 'known'; readonly value: JsonValue }).value)));
    } catch (error) {
      context.issues.push(createIssue({ code: 'query.function_failed', phase: 'query', severity: 'error', retry: 'after_input', requiredCapabilities: [expression.capability], details: { error: error instanceof Error ? error.name : typeof error } }));
      return { status: 'unavailable' };
    }
  }
  return { status: 'unknown' };
};

const exprContext = (row: ScopedRow, context: QueryContext): EvalContext => ({ row, parameters: context.parameters, functions: context.functions, issues: context.issues, query: context });
const known = (value: JsonValue): ExpressionResult => ({ status: 'known', value });
const propagate = (...values: readonly ExpressionResult[]): ExpressionResult | undefined => values.some((value) => value.status === 'unavailable') ? { status: 'unavailable' } : values.some((value) => value.status === 'indeterminate') ? { status: 'indeterminate' } : values.some((value) => value.status === 'unknown') ? { status: 'unknown' } : undefined;
const expressionJson = (result: ExpressionResult): JsonValue => result.status === 'known' ? result.value : null;

const projectFields = (fields: Readonly<Record<string, Expr>>, context: EvalContext): QueryRecord => {
  const output: Record<string, QueryLogicalValue> = {};
  for (const [name, expression] of Object.entries(fields)) {
    const result = evaluateExpr(expression, context);
    if (result.status === 'known') output[name] = result.value;
    else if (result.status === 'unknown') output[name] = logicalUnknown;
    else if ((result.status === 'unavailable' || result.status === 'indeterminate') && context.query !== undefined) context.query.unavailable = true;
  }
  return output;
};

const mapProjection = (inner: NodeResult, alias: string, project: (row: ScopedRow) => QueryRecord, context: QueryContext): NodeResult => {
  const rows = inner.rows.map((row, index) => ({ scope: { [alias]: project(row) }, provenance: { [alias]: { relationId: 'select', occurrence: resultKey(row) + ':select:' + index } } }));
  return context.unavailable ? { rows: [], completeness: 'unknown' } : { rows, completeness: inner.completeness };
};

const visibleRow = (row: ScopedRow): QueryRecord => {
  const aliases = Object.keys(row.scope);
  if (aliases.length === 1) return row.scope[aliases[0] as string] ?? {};
  return row.scope as unknown as QueryRecord;
};

const resultKey = (row: ScopedRow): string => Object.entries(row.provenance).sort(([left], [right]) => left.localeCompare(right)).map(([alias, provenance]) => alias + '=' + provenance.occurrence).join('|');
const renameFields = (record: QueryRecord, fields: Readonly<Record<string, string>>): QueryRecord => Object.fromEntries(Object.entries(record).map(([name, value]) => [fields[name] ?? name, value]));
const omitFields = (record: QueryRecord, fields: ReadonlySet<string>): QueryRecord => Object.fromEntries(Object.entries(record).filter(([name]) => !fields.has(name)));
const uniqueRows = (rows: readonly ScopedRow[]): Map<string, ScopedRow> => new Map(rows.map((row) => [canonicalizeQueryValue(visibleRow(row)), row]));
const compareOrder = (left: ScopedRow, right: ScopedRow, terms: readonly OrderTerm[], context: QueryContext): number => {
  for (const term of terms) {
    const leftValue = evaluateExpr(term.value, exprContext(left, context));
    const rightValue = evaluateExpr(term.value, exprContext(right, context));
    if (leftValue.status === 'unavailable' || leftValue.status === 'indeterminate' || rightValue.status === 'unavailable' || rightValue.status === 'indeterminate') context.unavailable = true;
    const comparison = compareOrderedExpressions(leftValue, rightValue, term);
    if (comparison !== 0) return comparison;
  }
  return resultKey(left).localeCompare(resultKey(right));
};

const compareRowToCursor = (row: ScopedRow, terms: readonly OrderTerm[], cursor: QueryCursor, context: QueryContext): number => {
  for (let index = 0; index < terms.length; index += 1) {
    const term = terms[index] as OrderTerm;
    const rowValue = evaluateExpr(term.value, exprContext(row, context));
    if (rowValue.status === 'unavailable' || rowValue.status === 'indeterminate') context.unavailable = true;
    const cursorValue = known(cursor.order[index] ?? null);
    const comparison = compareOrderedExpressions(rowValue, cursorValue, term);
    if (comparison !== 0) return comparison;
  }
  return resultKey(row).localeCompare(cursor.resultKey);
};

const compareOrderedExpressions = (left: ExpressionResult, right: ExpressionResult, term: OrderTerm): number => {
  const leftRank = left.status === 'missing' ? 2 : left.status !== 'known' || left.value === null ? 1 : 0;
  const rightRank = right.status === 'missing' ? 2 : right.status !== 'known' || right.value === null ? 1 : 0;
  if (leftRank !== rightRank) {
    if (leftRank > 0 && rightRank > 0) return leftRank < rightRank ? -1 : 1;
    const specialIsLeft = leftRank > 0;
    return term.nulls === 'first' ? (specialIsLeft ? -1 : 1) : (specialIsLeft ? 1 : -1);
  }
  if (leftRank > 0 || left.status !== 'known' || right.status !== 'known') return 0;
  const comparison = compareJsonValuesTotal(left.value, right.value);
  return term.direction === 'asc' ? comparison : -comparison;
};

const compareJsonValues = (left: JsonValue, right: JsonValue): number | undefined => {
  if (left === null || right === null) return left === right ? 0 : left === null ? -1 : 1;
  if (typeof left === 'number' && typeof right === 'number') return left < right ? -1 : left > right ? 1 : 0;
  if (typeof left === 'string' && typeof right === 'string') return left < right ? -1 : left > right ? 1 : 0;
  if (typeof left === 'boolean' && typeof right === 'boolean') return left === right ? 0 : left ? 1 : -1;
  if (typeof left === 'object' && typeof right === 'object') return canonicalizeJson(left) < canonicalizeJson(right) ? -1 : canonicalizeJson(left) > canonicalizeJson(right) ? 1 : 0;
  return undefined;
};

const compareJsonValuesTotal = (left: JsonValue, right: JsonValue): number => {
  const comparable = compareJsonValues(left, right);
  if (comparable !== undefined) return comparable;
  const leftCanonical = canonicalizeJson(left);
  const rightCanonical = canonicalizeJson(right);
  return leftCanonical < rightCanonical ? -1 : leftCanonical > rightCanonical ? 1 : 0;
};

const containsLogicalUnknown = (value: QueryLogicalValue): boolean => {
  if (value === logicalUnknown) return true;
  if (Array.isArray(value)) return value.some(containsLogicalUnknown);
  if (value !== null && typeof value === 'object') return Object.values(value).some(containsLogicalUnknown);
  return false;
};

/** Canonical internal equality key; tags keep logical unknown disjoint from every JSON value. */
const canonicalizeQueryValue = (value: QueryLogicalValue): string => {
  if (value === logicalUnknown) return 'u';
  if (Array.isArray(value)) return 'a[' + value.map(canonicalizeQueryValue).join(',') + ']';
  if (value !== null && typeof value === 'object') {
    const record = value as Readonly<Record<string, QueryLogicalValue>>;
    return 'o{' + Object.keys(record).sort().map((key) => JSON.stringify(key) + ':' + canonicalizeQueryValue(record[key] as QueryLogicalValue)).join(',') + '}';
  }
  return 'j' + canonicalizeJson(value);
};

const nonMonotoneUnknown = (context: QueryContext, operator: string): NodeResult => {
  context.issues.push(createIssue({ code: 'query.parameter_invalid', phase: 'query', severity: 'error', retry: 'after_refresh', details: { reason: 'incomplete_non_monotone', operator } }));
  return { rows: [], completeness: 'unknown' };
};

export const createQueryMaintenanceStrategy = <Snapshot extends { readonly relations: readonly RelationInput[] }>(parameters?: Readonly<Record<string, JsonValue>>, functions?: FunctionRegistry): FullRecomputeStrategy<QueryNode, QueryRecord, Snapshot, unknown> => {
  return new FullRecomputeStrategy((plan, snapshot) => evaluateQuery({ root: plan.query, relations: snapshot.relations, ...(parameters === undefined ? {} : { parameters }), ...(functions === undefined ? {} : { functions }) }));
};
