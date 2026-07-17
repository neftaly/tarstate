import type { Expr, OrderTerm, QueryNode } from '../model.js';

/** Structural children maintained as independent incremental graph nodes. */
export const directQueryChildren = (node: QueryNode): readonly QueryNode[] => {
  if (node.kind === 'join' || node.kind === 'set') return [node.left, node.right];
  if (node.kind === 'where' || node.kind === 'select' || node.kind === 'with-fields'
    || node.kind === 'rename' || node.kind === 'omit' || node.kind === 'unnest'
    || node.kind === 'aggregate' || node.kind === 'distinct' || node.kind === 'order'
    || node.kind === 'slice' || node.kind === 'window' || node.kind === 'seek') {
    return [node.input];
  }
  // Recursion owns a cyclic local fixpoint and is one incremental operator.
  return [];
};

/**
 * Visits syntax owned by one physical node, including complete expression
 * subqueries. Literal and values payloads remain opaque application data.
 */
export const visitLocalQuerySyntax = (
  root: QueryNode,
  visitNode: (candidate: QueryNode) => void,
  visitExpression?: (candidate: Expr) => void
): void => visitQuerySyntax(root, false, visitNode, visitExpression);

/** Visits a complete query without interpreting portable data as syntax. */
export const visitFullQuerySyntax = (
  root: QueryNode,
  visitNode: (candidate: QueryNode) => void,
  visitExpression?: (candidate: Expr) => void
): void => visitQuerySyntax(root, true, visitNode, visitExpression);

const visitQuerySyntax = (
  root: QueryNode,
  includeStructuralChildren: boolean,
  visitNode: (candidate: QueryNode) => void,
  visitExpressionNode?: (candidate: Expr) => void
): void => {
  const visited = new Set<QueryNode>();
  const visitQuery = (node: QueryNode, includeChildren: boolean): void => {
    if (visited.has(node)) return;
    visited.add(node);
    visitNode(node);

    const visitExpression = (expression: Expr): void => {
      visitExpressionNode?.(expression);
      if (expression.kind === 'literal'
        || expression.kind === 'parameter'
        || expression.kind === 'field'
        || expression.kind === 'key-of'
        || expression.kind === 'source-of') return;
      if (expression.kind === 'subquery') {
        visitQuery(expression.query, true);
        return;
      }
      if (expression.kind === 'compare' || expression.kind === 'arithmetic') {
        visitExpression(expression.left);
        visitExpression(expression.right);
        return;
      }
      if (expression.kind === 'is-null' || expression.kind === 'is-missing') {
        visitExpression(expression.value);
        return;
      }
      if (expression.kind === 'boolean') {
        if (expression.op === 'not') visitExpression(expression.arg);
        else for (const argument of expression.args) visitExpression(argument);
        return;
      }
      if (expression.kind === 'case') {
        for (const branch of expression.branches) {
          visitExpression(branch.when);
          visitExpression(branch.then);
        }
        visitExpression(expression.otherwise);
        return;
      }
      if (expression.kind === 'record') {
        for (const field of Object.values(expression.fields)) visitExpression(field);
        return;
      }
      const expressions = expression.kind === 'array' ? expression.items : expression.args;
      for (const argument of expressions) visitExpression(argument);
    };
    const visitOrder = (terms: readonly OrderTerm[]): void => {
      for (const term of terms) visitExpression(term.value);
    };

    if (node.kind === 'join') {
      if (node.on !== undefined) visitExpression(node.on);
    } else if (node.kind === 'where') visitExpression(node.predicate);
    else if (node.kind === 'select' || node.kind === 'with-fields') {
      for (const expression of Object.values(node.fields)) visitExpression(expression);
    } else if (node.kind === 'unnest') visitExpression(node.expression);
    else if (node.kind === 'aggregate') {
      for (const expression of Object.values(node.groupBy)) visitExpression(expression);
      for (const measure of Object.values(node.measures)) {
        if (measure.value !== undefined) visitExpression(measure.value);
        if (measure.orderBy !== undefined) visitOrder(measure.orderBy);
      }
    } else if (node.kind === 'order') visitOrder(node.by);
    else if (node.kind === 'window') {
      for (const field of Object.values(node.fields)) {
        if (field.value !== undefined) visitExpression(field.value);
        if (field.partitionBy !== undefined) {
          for (const expression of field.partitionBy) visitExpression(expression);
        }
        visitOrder(field.orderBy);
      }
    } else if (node.kind === 'seek') visitOrder(node.by);
    else if (node.kind === 'recursive') {
      visitQuery(node.seed, true);
      visitQuery(node.step, true);
      for (const expression of node.key) visitExpression(expression);
    }

    if (includeChildren) {
      for (const child of directQueryChildren(node)) visitQuery(child, true);
    }
  };
  visitQuery(root, includeStructuralChildren);
};
