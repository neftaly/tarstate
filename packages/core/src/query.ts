import { canonicalizeJson, sha256Json, type ArtifactRef } from './artifacts.js';
import { createIssue, type CapabilityRef, type Issue } from './issues.js';
import { capabilityUnavailable, logicalAnd, logicalNot, logicalOr, logicalUnknown, missingValue, type EvaluationValue, type JsonValue, type LogicalTruth, type LogicalUnknown } from './value.js';
import type { PreparedPlan } from './maintenance.js';

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
  | { readonly kind: 'string'; readonly op: 'concat'; readonly args: readonly Expr[] }
  | { readonly kind: 'string'; readonly op: 'lower' | 'upper' | 'length'; readonly args: readonly [Expr] }
  | { readonly kind: 'array'; readonly items: readonly Expr[] }
  | { readonly kind: 'record'; readonly fields: Readonly<Record<string, Expr>> }
  | { readonly kind: 'case'; readonly branches: readonly { readonly when: Expr; readonly then: Expr }[]; readonly otherwise: Expr }
  | { readonly kind: 'coalesce'; readonly args: readonly Expr[] }
  | { readonly kind: 'call'; readonly capability: CapabilityRef; readonly args: readonly Expr[] }
  | { readonly kind: 'subquery'; readonly mode: 'scalar' | 'exists'; readonly query: QueryNode }
  | { readonly kind: 'is-null'; readonly value: Expr }
  | { readonly kind: 'is-missing'; readonly value: Expr }
  | { readonly kind: 'key-of'; readonly alias: string }
  | { readonly kind: 'source-of'; readonly alias: string };

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

export type QueryMaintenanceSnapshot = {
  readonly relations: readonly RelationInput[];
  readonly parameters?: Readonly<Record<string, JsonValue>>;
  readonly functions?: FunctionRegistry;
  readonly basis?: JsonValue;
  readonly membershipRevision?: number;
};

export type IncrementalQueryResultDelta = {
  readonly addedResultKeys: readonly string[];
  readonly removedResultKeys: readonly string[];
  readonly updatedResultKeys: readonly string[];
};

export type IncrementalQueryMaintenanceState = {
  readonly strategy: 'incremental-operator-graph';
  readonly revision: number;
  readonly materializedNodeCount: number;
  readonly recomputedNodeCount: number;
  readonly changedNodeCount: number;
  readonly changedRelationIds: readonly string[];
  readonly resultDelta: IncrementalQueryResultDelta;
  readonly rejectedUpdateCount: number;
};

export type IncrementalQueryResult = QueryResult & { readonly state: IncrementalQueryMaintenanceState };

export interface IncrementalQueryMaintenanceSession {
  getCurrentResult(): IncrementalQueryResult;
  updateSnapshot(snapshot: QueryMaintenanceSnapshot): IncrementalQueryResult;
  close(): void;
}

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
  readonly materializedNodes?: ReadonlyMap<QueryNode, MaterializedQueryNode>;
  readonly activeNode?: QueryNode;
  unavailable: boolean;
};

type MaterializedQueryNode = {
  readonly result: NodeResult;
  readonly issues: readonly Issue[];
  readonly unavailable: boolean;
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

const evaluateNode = (node: QueryNode, context: QueryContext): NodeResult => {
  const materialized = context.outer === undefined && node !== context.activeNode ? context.materializedNodes?.get(node) : undefined;
  if (materialized !== undefined) {
    context.issues.push(...materialized.issues);
    context.unavailable = context.unavailable || materialized.unavailable;
    return materialized.result;
  }
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
  if (node.kind === 'recursion-ref') {
    const rows = context.recursions.get(node.name);
    if (rows !== undefined) return { rows, completeness: 'exact' };
    context.issues.push(createIssue({ code: 'query.recursion_reference_missing', details: { name: node.name } }));
    return { rows: [], completeness: 'unknown' };
  }
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
      const base = requiredAlias(row, node.alias, context);
      if (base === undefined) return row;
      const additions = projectFields(node.fields, exprContext(row, context));
      return { scope: { ...row.scope, [node.alias]: { ...base, ...additions } }, provenance: row.provenance };
    });
    return context.unavailable ? { rows: [], completeness: 'unknown' } : { rows, completeness: inner.completeness };
  }
  if (node.kind === 'rename') {
    const inner = evaluateNode(node.input, context);
    const rows = inner.rows.map((row) => {
      const record = requiredAlias(row, node.alias, context);
      return record === undefined ? row : { ...row, scope: { ...row.scope, [node.alias]: renameFields(record, node.fields) } };
    });
    return context.unavailable ? { rows: [], completeness: 'unknown' } : { rows, completeness: inner.completeness };
  }
  if (node.kind === 'omit') {
    const inner = evaluateNode(node.input, context);
    const rows = inner.rows.map((row) => {
      const record = requiredAlias(row, node.alias, context);
      return record === undefined ? row : { ...row, scope: { ...row.scope, [node.alias]: omitFields(record, new Set(node.fields)) } };
    });
    return context.unavailable ? { rows: [], completeness: 'unknown' } : { rows, completeness: inner.completeness };
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
        const aliasFields = requiredAlias(row, node.alias, context);
        if (aliasFields === undefined) return;
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
    if (expression.op === 'concat') return known(strings.join(''));
    const value = strings[0]!;
    return known(expression.op === 'lower' ? value.toLowerCase() : expression.op === 'upper' ? value.toUpperCase() : Array.from(value).length);
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
  return assertNever(expression);
};

const exprContext = (row: ScopedRow, context: QueryContext): EvalContext => ({ row, parameters: context.parameters, functions: context.functions, issues: context.issues, query: context });
const known = (value: JsonValue): ExpressionResult => ({ status: 'known', value });
const propagate = (...values: readonly ExpressionResult[]): ExpressionResult | undefined => values.some((value) => value.status === 'unavailable') ? { status: 'unavailable' } : values.some((value) => value.status === 'indeterminate') ? { status: 'indeterminate' } : values.some((value) => value.status === 'unknown') ? { status: 'unknown' } : undefined;
const expressionJson = (result: ExpressionResult): JsonValue => result.status === 'known' ? result.value : null;
const assertNever = (value: never): never => { throw new TypeError('Unsupported query expression: ' + String(value)); };

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
  if (aliases.length === 1) return row.scope[aliases[0] as string] as QueryRecord;
  return row.scope as unknown as QueryRecord;
};

const requiredAlias = (row: ScopedRow, alias: string, context: QueryContext): QueryRecord | undefined => {
  const record = row.scope[alias];
  if (record !== undefined) return record;
  context.unavailable = true;
  if (!context.issues.some(({ code, details }) => code === 'query.alias_missing' && (details as { alias?: unknown } | undefined)?.alias === alias)) {
    context.issues.push(createIssue({ code: 'query.alias_missing', details: { alias } }));
  }
  return undefined;
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

/**
 * Opens the production stateful query-maintenance path. The pure
 * `evaluateQuery` function remains an independent semantic oracle; updates here
 * rematerialize only query nodes whose relation dependencies changed.
 */
export const openIncrementalQueryMaintenance = (
  plan: PreparedPlan<QueryNode>,
  initialSnapshot: QueryMaintenanceSnapshot
): IncrementalQueryMaintenanceSession => {
  const graph = compileQueryGraph(plan.query);
  const materialized = new Map<QueryNode, MaterializedQueryNode>();
  let acceptedSnapshot = initialSnapshot;
  let closed = false;
  let revision = 0;
  let rejectedUpdateCount = 0;

  const initialIssues = validateMaintenanceSnapshot(initialSnapshot);
  if (initialIssues.length === 0) {
    for (const node of graph.nodes) materialized.set(node, materializeQueryNode(node, initialSnapshot, materialized));
  }
  let current = maintainedQueryResult(
    initialIssues.length === 0 ? materialized.get(plan.query) : undefined,
    initialIssues,
    maintenanceState(graph.nodes.length, graph.nodes.length, graph.nodes.length, [], emptyIncrementalQueryResultDelta, revision, rejectedUpdateCount)
  );

  return {
    getCurrentResult: () => current,
    updateSnapshot: (nextSnapshot) => {
      if (closed) throw new Error('Incremental query maintenance session is closed');
      revision += 1;
      const updateIssues = validateMaintenanceUpdate(acceptedSnapshot, nextSnapshot);
      if (updateIssues.length > 0) {
        rejectedUpdateCount += 1;
        const previous = current;
        current = maintainedQueryResult(
          undefined,
          updateIssues,
          maintenanceState(graph.nodes.length, 0, 0, [], diffMaintainedResults(previous, undefined), revision, rejectedUpdateCount)
        );
        return current;
      }

      const changedRelations = changedRelationKeys(acceptedSnapshot, nextSnapshot);
      const sessionEvidenceChanged = !sameOptionalJson(acceptedSnapshot.basis, nextSnapshot.basis)
        || acceptedSnapshot.membershipRevision !== nextSnapshot.membershipRevision;
      let recomputedNodeCount = 0;
      const changedNodes = new Set<QueryNode>();
      for (const node of graph.nodes) {
        const children = graph.children.get(node) as readonly QueryNode[];
        const externalDependencies = graph.externalDependencies.get(node) as ReadonlySet<string>;
        const childChanged = children.some((child) => changedNodes.has(child));
        const externalInputChanged = [...externalDependencies].some((key) => changedRelations.has(key));
        if (!sessionEvidenceChanged && !childChanged && !externalInputChanged) continue;
        const previousNode = materialized.get(node);
        const nextNode = materializeQueryNode(node, nextSnapshot, materialized);
        materialized.set(node, nextNode);
        recomputedNodeCount += 1;
        if (previousNode === undefined || !materializedQueryNodeEqual(previousNode, nextNode)) changedNodes.add(node);
      }
      acceptedSnapshot = nextSnapshot;
      const previous = current;
      const root = materialized.get(plan.query);
      current = maintainedQueryResult(
        root,
        [],
        maintenanceState(
          graph.nodes.length,
          recomputedNodeCount,
          changedNodes.size,
          changedRelationIds(nextSnapshot, changedRelations),
          diffMaintainedResults(previous, root),
          revision,
          rejectedUpdateCount
        )
      );
      return current;
    },
    close: () => {
      if (closed) return;
      closed = true;
      materialized.clear();
    }
  };
};

type CompiledQueryGraph = {
  readonly nodes: readonly QueryNode[];
  readonly children: ReadonlyMap<QueryNode, readonly QueryNode[]>;
  readonly externalDependencies: ReadonlyMap<QueryNode, ReadonlySet<string>>;
};

const compileQueryGraph = (root: QueryNode): CompiledQueryGraph => {
  const nodes: QueryNode[] = [];
  const visited = new Set<QueryNode>();
  const visit = (node: QueryNode): void => {
    if (visited.has(node)) return;
    visited.add(node);
    for (const child of directQueryChildren(node)) visit(child);
    nodes.push(node);
  };
  visit(root);
  const children = new Map(nodes.map((node) => [node, directQueryChildren(node)]));
  const dependencies = new Map(nodes.map((node) => [node, relationDependencies(node)]));
  return {
    nodes: Object.freeze(nodes),
    children,
    externalDependencies: new Map(nodes.map((node) => {
      const childDependencies = new Set((children.get(node) ?? []).flatMap((child) => [...(dependencies.get(child) ?? [])]));
      return [node, new Set([...(dependencies.get(node) ?? [])].filter((identity) => !childDependencies.has(identity)))] as const;
    }))
  };
};

const directQueryChildren = (node: QueryNode): readonly QueryNode[] => {
  if (node.kind === 'join' || node.kind === 'set') return [node.left, node.right];
  if (node.kind === 'where' || node.kind === 'select' || node.kind === 'with-fields' || node.kind === 'rename' || node.kind === 'omit' || node.kind === 'unnest' || node.kind === 'aggregate' || node.kind === 'distinct' || node.kind === 'order' || node.kind === 'slice' || node.kind === 'window' || node.kind === 'seek') return [node.input];
  // Recursion owns a cyclic local fixpoint and is one incremental operator.
  return [];
};

const relationDependencies = (node: QueryNode): ReadonlySet<string> => {
  const dependencies = new Set<string>();
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) { for (const item of value) visit(item); return; }
    if (value === null || typeof value !== 'object') return;
    const candidate = value as Readonly<Record<string, unknown>>;
    if (candidate.kind === 'from' && isRelationUse(candidate.relation)) dependencies.add(relationKey(candidate.relation));
    for (const child of Object.values(candidate)) visit(child);
  };
  visit(node);
  return dependencies;
};

const isRelationUse = (value: unknown): value is RelationUse => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as { readonly schemaView?: unknown; readonly relationId?: unknown };
  return typeof candidate.relationId === 'string' && candidate.schemaView !== null && typeof candidate.schemaView === 'object';
};

const materializeQueryNode = (
  node: QueryNode,
  snapshot: QueryMaintenanceSnapshot,
  materializedNodes: ReadonlyMap<QueryNode, MaterializedQueryNode>
): MaterializedQueryNode => {
  const issues: Issue[] = [];
  const context: QueryContext = {
    relations: new Map(snapshot.relations.map((input) => [relationKey(input.relation), input])),
    parameters: snapshot.parameters ?? {},
    functions: snapshot.functions ?? new Map(),
    issues,
    recursions: new Map(),
    ...(snapshot.basis === undefined ? {} : { basis: snapshot.basis }),
    ...(snapshot.membershipRevision === undefined ? {} : { membershipRevision: snapshot.membershipRevision }),
    materializedNodes,
    activeNode: node,
    unavailable: false
  };
  const result = evaluateNode(node, context);
  return { result, issues: deduplicateQueryIssues(issues), unavailable: context.unavailable };
};

const maintainedQueryResult = (
  root: MaterializedQueryNode | undefined,
  additionalIssues: readonly Issue[],
  state: IncrementalQueryMaintenanceState
): IncrementalQueryResult => {
  const issues = deduplicateQueryIssues([...(root?.issues ?? []), ...additionalIssues]);
  if (root === undefined || root.unavailable || root.result.completeness === 'unknown') {
    return { rows: [], resultKeys: [], completeness: 'unknown', issues, state };
  }
  return {
    rows: root.result.rows.map(visibleRow),
    resultKeys: root.result.rows.map(resultKey),
    completeness: root.result.completeness,
    issues,
    state
  };
};

const maintenanceState = (
  materializedNodeCount: number,
  recomputedNodeCount: number,
  changedNodeCount: number,
  changedRelationIds: readonly string[],
  resultDelta: IncrementalQueryResultDelta,
  revision: number,
  rejectedUpdateCount: number
): IncrementalQueryMaintenanceState => ({
  strategy: 'incremental-operator-graph',
  revision,
  materializedNodeCount,
  recomputedNodeCount,
  changedNodeCount,
  changedRelationIds,
  resultDelta,
  rejectedUpdateCount
});

const emptyIncrementalQueryResultDelta: IncrementalQueryResultDelta = Object.freeze({ addedResultKeys: [], removedResultKeys: [], updatedResultKeys: [] });

const materializedQueryNodeEqual = (left: MaterializedQueryNode, right: MaterializedQueryNode): boolean => {
  if (left.unavailable !== right.unavailable || left.result.completeness !== right.result.completeness) return false;
  if (left.issues.length !== right.issues.length || left.issues.some((issue, index) => issue.id !== right.issues[index]?.id)) return false;
  if (left.result.rows.length !== right.result.rows.length) return false;
  return left.result.rows.every((row, index) => scopedRowIdentity(row) === scopedRowIdentity(right.result.rows[index] as ScopedRow));
};

const scopedRowIdentity = (row: ScopedRow): string => resultKey(row) + '\u0000' + canonicalizeQueryValue(visibleRow(row));

const validateMaintenanceSnapshot = (snapshot: QueryMaintenanceSnapshot): readonly Issue[] => {
  const identities = new Set<string>();
  const issues: Issue[] = [];
  for (const input of snapshot.relations) {
    const identity = relationKey(input.relation);
    if (identities.has(identity)) {
      issues.push(incrementalQueryIssue('query.incremental_relation_ambiguous', { relationId: input.relation.relationId }));
      continue;
    }
    identities.add(identity);
    if (input.occurrenceIds !== undefined && (input.occurrenceIds.length !== input.rows.length || new Set(input.occurrenceIds).size !== input.occurrenceIds.length)) {
      issues.push(incrementalQueryIssue('query.incremental_identity_invalid', { relationId: input.relation.relationId }));
    }
  }
  return issues;
};

const validateMaintenanceUpdate = (previous: QueryMaintenanceSnapshot, next: QueryMaintenanceSnapshot): readonly Issue[] => {
  const issues = [...validateMaintenanceSnapshot(next)];
  if (!sameOptionalJson(previous.parameters, next.parameters) || !sameFunctionRegistry(previous.functions, next.functions)) {
    issues.push(incrementalQueryIssue('query.incremental_session_input_changed', { reason: 'parameters_or_functions' }));
    return issues;
  }
  const previousRelations = uniqueRelationMap(previous.relations);
  const nextRelations = uniqueRelationMap(next.relations);
  if (previousRelations === undefined || nextRelations === undefined) return issues;
  const identities = new Set([...previousRelations.keys(), ...nextRelations.keys()]);
  for (const identity of identities) {
    const before = previousRelations.get(identity);
    const after = nextRelations.get(identity);
    if (before === undefined || after === undefined) {
      const candidate = before ?? after;
      if (candidate !== undefined && candidate.rows.length > 0 && candidate.occurrenceIds === undefined && candidate.completeness !== 'unknown') {
        issues.push(incrementalQueryIssue('query.incremental_identity_invalid', { relationId: candidate.relation.relationId, reason: 'relation_membership_changed' }));
      }
      continue;
    }
    if (relationRowsEqual(before, after) || before.completeness === 'unknown' || after.completeness === 'unknown') continue;
    if (before.occurrenceIds === undefined || after.occurrenceIds === undefined) {
      issues.push(incrementalQueryIssue('query.incremental_identity_invalid', { relationId: before.relation.relationId, reason: 'changed_rows_require_occurrence_ids' }));
    }
  }
  return deduplicateQueryIssues(issues);
};

const uniqueRelationMap = (relations: readonly RelationInput[]): ReadonlyMap<string, RelationInput> | undefined => {
  const output = new Map<string, RelationInput>();
  for (const relation of relations) {
    const identity = relationKey(relation.relation);
    if (output.has(identity)) return undefined;
    output.set(identity, relation);
  }
  return output;
};

const changedRelationKeys = (previous: QueryMaintenanceSnapshot, next: QueryMaintenanceSnapshot): ReadonlySet<string> => {
  const before = uniqueRelationMap(previous.relations) ?? new Map();
  const after = uniqueRelationMap(next.relations) ?? new Map();
  const changed = new Set<string>();
  for (const identity of new Set([...before.keys(), ...after.keys()])) {
    const left = before.get(identity);
    const right = after.get(identity);
    if (left === undefined || right === undefined || !relationInputEqual(left, right)) changed.add(identity);
  }
  return changed;
};

const changedRelationIds = (snapshot: QueryMaintenanceSnapshot, identities: ReadonlySet<string>): readonly string[] => {
  const byIdentity = uniqueRelationMap(snapshot.relations) ?? new Map();
  return [...new Set([...identities].map((identity) => byIdentity.get(identity)?.relation.relationId ?? identity.split('\u0000').at(-1) as string))].sort((left, right) => left.localeCompare(right));
};

const relationInputEqual = (left: RelationInput, right: RelationInput): boolean =>
  left.completeness === right.completeness
  && left.sourceId === right.sourceId
  && left.attachmentId === right.attachmentId
  && sameOptionalJson(left.basis, right.basis)
  && relationRowsEqual(left, right);

const relationRowsEqual = (left: RelationInput, right: RelationInput): boolean =>
  sameStringList(left.occurrenceIds, right.occurrenceIds)
  && left.rows.length === right.rows.length
  && left.rows.every((row, index) => canonicalizeQueryValue(row) === canonicalizeQueryValue(right.rows[index] as QueryRecord));

const sameStringList = (left: readonly string[] | undefined, right: readonly string[] | undefined): boolean =>
  left === undefined || right === undefined ? left === right : left.length === right.length && left.every((value, index) => value === right[index]);

const sameOptionalJson = (left: unknown, right: unknown): boolean => {
  if (left === undefined || right === undefined) return left === right;
  try { return canonicalizeJson(left as JsonValue) === canonicalizeJson(right as JsonValue); } catch { return false; }
};

const sameFunctionRegistry = (left: FunctionRegistry | undefined, right: FunctionRegistry | undefined): boolean => {
  if (left === right) return true;
  const leftEntries = [...(left ?? new Map()).entries()];
  const rightMap = right ?? new Map();
  return leftEntries.length === rightMap.size && leftEntries.every(([key, implementation]) => rightMap.get(key) === implementation);
};

const diffMaintainedResults = (
  previous: IncrementalQueryResult,
  nextRoot: MaterializedQueryNode | undefined
): IncrementalQueryResultDelta => {
  // Invalidation withdraws the current assertion; it does not prove removals.
  if (nextRoot === undefined || nextRoot.unavailable || nextRoot.result.completeness === 'unknown') return emptyIncrementalQueryResultDelta;
  const nextRows = nextRoot.result.rows.map(visibleRow);
  const nextKeys = nextRoot.result.rows.map(resultKey);
  const previousBuckets = resultBuckets(previous.resultKeys, previous.rows);
  const nextBuckets = resultBuckets(nextKeys, nextRows);
  const added: string[] = [];
  const removed: string[] = [];
  const updated: string[] = [];
  for (const key of new Set([...previousBuckets.keys(), ...nextBuckets.keys()])) {
    const before = previousBuckets.get(key) ?? [];
    const after = nextBuckets.get(key) ?? [];
    if (after.length > before.length) added.push(key);
    if (before.length > after.length) removed.push(key);
    if (before.length === after.length && before.some((value, index) => value !== after[index])) updated.push(key);
  }
  return { addedResultKeys: added.sort(), removedResultKeys: removed.sort(), updatedResultKeys: updated.sort() };
};

const resultBuckets = (keys: readonly string[], rows: readonly QueryRecord[]): ReadonlyMap<string, readonly string[]> => {
  const output = new Map<string, string[]>();
  keys.forEach((key, index) => {
    const values = output.get(key) ?? [];
    values.push(canonicalizeQueryValue(rows[index] as QueryRecord));
    output.set(key, values);
  });
  for (const values of output.values()) values.sort();
  return output;
};

const deduplicateQueryIssues = (issues: readonly Issue[]): readonly Issue[] => [...new Map(issues.map((issue) => [issue.id, issue])).values()];

const incrementalQueryIssue = (code: string, details: JsonValue): Issue => createIssue({
  code,
  phase: 'query',
  severity: 'error',
  retry: code === 'query.incremental_session_input_changed' ? 'after_input' : 'after_refresh',
  details
});
