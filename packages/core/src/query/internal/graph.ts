import { canonicalizeJsonValue as canonicalizeJson } from '../../internal-canonical-json.js';
import { relationKey } from './relations.js';
import type { AggregateExpr, Expr, OrderTerm, QueryNode, WindowExpr } from '../model.js';
import type { JsonValue } from '../../value.js';
import { directQueryChildren, visitLocalQuerySyntax } from './syntax-walk.js';

export { directQueryChildren } from './syntax-walk.js';

export type InternedPooledNode = { readonly id: number; readonly key: string; readonly node: QueryNode };

export class NonPoolableQueryError extends TypeError {
  readonly code = 'query.pool.nonpoolable';
}

/** Validates the deliberately conservative syntax accepted by pooled DAGs. */
export const assertPoolableQuery = (root: QueryNode): void => {
  const visiting = new Set<object>();
  const visited = new Set<object>();
  const visitObject = (value: object, children: () => void): void => {
    if (visited.has(value)) return;
    if (visiting.has(value)) throw new NonPoolableQueryError('Pooled query graphs must be acyclic');
    visiting.add(value);
    children();
    visiting.delete(value);
    visited.add(value);
  };
  const visitList = <Value extends object>(values: readonly Value[], visit: (value: Value) => void): void => visitObject(values, () => {
    for (const value of values) visit(value);
  });
  const visitExpressions = (values: Readonly<Record<string, Expr>>): void => visitObject(values, () => {
    for (const expression of Object.values(values)) visitExpression(expression);
  });
  const visitOrder = (terms: readonly OrderTerm[]): void => visitList(terms, (term) => visitObject(term, () => visitExpression(term.value)));
  const visitExpression = (expression: Expr): void => visitObject(expression, () => {
    if (expression.kind === 'literal' || expression.kind === 'parameter' || expression.kind === 'field' || expression.kind === 'key-of' || expression.kind === 'source-of') return;
    if (expression.kind === 'subquery') throw new NonPoolableQueryError('Pooled query graphs do not support subquery');
    if (expression.kind === 'compare' || expression.kind === 'arithmetic') { visitExpression(expression.left); visitExpression(expression.right); return; }
    if (expression.kind === 'is-null' || expression.kind === 'is-missing') { visitExpression(expression.value); return; }
    if (expression.kind === 'boolean') {
      if (expression.op === 'not') visitExpression(expression.arg);
      else visitList(expression.args, visitExpression);
      return;
    }
    if (expression.kind === 'case') {
      visitList(expression.branches, (branch) => visitObject(branch, () => { visitExpression(branch.when); visitExpression(branch.then); }));
      visitExpression(expression.otherwise);
      return;
    }
    if (expression.kind === 'record') { visitExpressions(expression.fields); return; }
    visitList(expression.kind === 'array' ? expression.items : expression.args, visitExpression);
  });
  const visitAggregate = (aggregate: AggregateExpr): void => visitObject(aggregate, () => {
    if (aggregate.value !== undefined) visitExpression(aggregate.value);
    if (aggregate.orderBy !== undefined) visitOrder(aggregate.orderBy);
  });
  const visitWindow = (window: WindowExpr): void => visitObject(window, () => {
    if (window.value !== undefined) visitExpression(window.value);
    if (window.partitionBy !== undefined) visitList(window.partitionBy, visitExpression);
    visitOrder(window.orderBy);
  });
  const visitQuery = (node: QueryNode): void => visitObject(node, () => {
    if (node.kind === 'seek' || node.kind === 'recursive' || node.kind === 'recursion-ref') {
      throw new NonPoolableQueryError('Pooled query graphs do not support ' + node.kind);
    }
    if (node.kind === 'from' || node.kind === 'values') return;
    if (node.kind === 'join' || node.kind === 'set') {
      visitQuery(node.left);
      visitQuery(node.right);
      if (node.kind === 'join' && node.on !== undefined) visitExpression(node.on);
      return;
    }
    visitQuery(node.input);
    if (node.kind === 'where') visitExpression(node.predicate);
    else if (node.kind === 'select' || node.kind === 'with-fields') visitExpressions(node.fields);
    else if (node.kind === 'unnest') visitExpression(node.expression);
    else if (node.kind === 'aggregate') {
      visitExpressions(node.groupBy);
      visitObject(node.measures, () => { for (const measure of Object.values(node.measures)) visitAggregate(measure); });
    } else if (node.kind === 'order') visitOrder(node.by);
    else if (node.kind === 'window') visitObject(node.fields, () => { for (const window of Object.values(node.fields)) visitWindow(window); });
  });
  visitQuery(root);
};

type CompiledQueryGraph = {
  readonly nodes: readonly QueryNode[];
  readonly children: ReadonlyMap<QueryNode, readonly QueryNode[]>;
  readonly externalDependencies: ReadonlyMap<QueryNode, ReadonlySet<string>>;
  readonly sessionEvidenceDependencies: ReadonlyMap<QueryNode, boolean>;
};

/** Compiles structural children separately from embedded expression dependencies. */
export const compileQueryGraph = (root: QueryNode): CompiledQueryGraph => {
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
  const externalDependencies = new Map<QueryNode, ReadonlySet<string>>();
  const sessionEvidenceDependencies = new Map<QueryNode, boolean>();
  for (const node of nodes) {
    const dependencies = new Set<string>();
    let containsSeek = false;
    visitLocalQuerySyntax(node, (candidate) => {
      if (candidate.kind === 'from') dependencies.add(relationKey(candidate.relation));
      else if (candidate.kind === 'seek') containsSeek = true;
    });
    externalDependencies.set(node, dependencies);
    sessionEvidenceDependencies.set(node, containsSeek);
  }
  return {
    nodes: Object.freeze(nodes),
    children,
    externalDependencies,
    sessionEvidenceDependencies
  };
};

export const containsNamedCall = (expression: Expr): boolean => expressionContains(expression, 'call');
export const containsSubquery = (expression: Expr): boolean => expressionContains(expression, 'subquery');

const expressionContains = (expression: Expr, kind: 'call' | 'subquery'): boolean => {
  if (expression.kind === kind) return true;
  if (expression.kind === 'literal' || expression.kind === 'parameter' || expression.kind === 'field' || expression.kind === 'key-of' || expression.kind === 'source-of' || expression.kind === 'subquery') return false;
  if (expression.kind === 'call') return expression.args.some((value) => expressionContains(value, kind));
  if (expression.kind === 'compare' || expression.kind === 'arithmetic') return expressionContains(expression.left, kind) || expressionContains(expression.right, kind);
  if (expression.kind === 'is-null' || expression.kind === 'is-missing') return expressionContains(expression.value, kind);
  if (expression.kind === 'boolean') return expression.op === 'not' ? expressionContains(expression.arg, kind) : expression.args.some((value) => expressionContains(value, kind));
  if (expression.kind === 'case') return expression.branches.some(({ when, then }) => expressionContains(when, kind) || expressionContains(then, kind)) || expressionContains(expression.otherwise, kind);
  if (expression.kind === 'record') return Object.values(expression.fields).some((value) => expressionContains(value, kind));
  const expressions = expression.kind === 'array' ? expression.items : expression.args;
  return expressions.some((value) => expressionContains(value, kind));
};

export const internPooledQueryNode = (
  node: QueryNode,
  interned: Map<string, InternedPooledNode>,
  byNode: Map<QueryNode, InternedPooledNode>,
  created: InternedPooledNode[],
  nextId: () => number
): QueryNode => {
  let canonical: QueryNode;
  let key: string;
  if (node.kind === 'join' || node.kind === 'set') {
    const left = internPooledQueryNode(node.left, interned, byNode, created, nextId);
    const right = internPooledQueryNode(node.right, interned, byNode, created, nextId);
    canonical = Object.freeze({ ...node, left, right });
    const { left: _left, right: _right, ...payload } = canonical;
    key = canonicalizeJson(['binary', payload, (byNode.get(left) as InternedPooledNode).id, (byNode.get(right) as InternedPooledNode).id] as unknown as JsonValue);
  } else if (node.kind === 'where' || node.kind === 'select' || node.kind === 'with-fields' || node.kind === 'rename' || node.kind === 'omit' || node.kind === 'unnest' || node.kind === 'aggregate' || node.kind === 'distinct' || node.kind === 'order' || node.kind === 'slice' || node.kind === 'window') {
    const child = internPooledQueryNode(node.input, interned, byNode, created, nextId);
    canonical = Object.freeze({ ...node, input: child });
    const { input: _input, ...payload } = canonical;
    key = canonicalizeJson(['unary', payload, (byNode.get(child) as InternedPooledNode).id] as unknown as JsonValue);
  } else {
    canonical = node;
    key = canonicalizeJson(['leaf', canonical] as unknown as JsonValue);
  }
  const existing = interned.get(key);
  if (existing !== undefined) return existing.node;
  const identity = { id: nextId(), key, node: canonical };
  interned.set(key, identity);
  byNode.set(canonical, identity);
  created.push(identity);
  return canonical;
};
