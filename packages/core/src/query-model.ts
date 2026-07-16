import type { ArtifactRef } from './artifacts.js';
import type { CapabilityRef, Issue } from './issues.js';
import type { PreparedPlan } from './query-plan-contract.js';
import type { JsonValue, LogicalUnknown } from './value.js';

/** `lower-bound` contains only proven rows; `unknown` withdraws the current row assertion. */
export type Completeness = 'exact' | 'lower-bound' | 'unknown';
export type QueryLogicalValue = null | boolean | number | string | LogicalUnknown | readonly QueryLogicalValue[] | { readonly [key: string]: QueryLogicalValue };
export type QueryRecord = Readonly<Record<string, QueryLogicalValue>>;

export type RelationUse = { readonly schemaView: ArtifactRef; readonly relationId: string };
export type RelationInput = {
  readonly relation: RelationUse;
  readonly rows: readonly QueryRecord[];
  /** Stable base-row occurrence identities within this attachment input. */
  readonly occurrenceIds?: readonly string[];
  readonly completeness: Completeness;
  readonly sourceId?: string;
  readonly attachmentId?: string;
  readonly basis?: JsonValue;
};

export type QueryFunction = (args: readonly JsonValue[]) => JsonValue;
/** Key with `capabilityRefKey`; legacy NUL-delimited keys remain accepted for NUL-free references. */
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

/** Portable relational query AST with bag semantics and hidden occurrence identity. Recursive bodies must be monotone with exactly one structural recursion reference. Unmatched left-join fields are missing, never synthesized as null. */
export type QueryNode =
  | { readonly kind: 'from'; readonly relation: RelationUse; readonly alias: string }
  | { readonly kind: 'values'; readonly alias: string; readonly rows: readonly Readonly<Record<string, JsonValue>>[] }
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

/** Basis-bound seek position. Cursors reject basis or dataset-membership drift. */
export type QueryCursor = {
  readonly order: readonly JsonValue[];
  readonly resultKey: string;
  readonly basis: JsonValue;
  readonly membershipRevision: number;
  readonly mode: 'live';
};

export type QueryRequest = {
  /** A portable query or a prepared query from the same public preparation API. */
  readonly root: QueryNode | PreparedPlan<QueryNode>;
  readonly relations: readonly RelationInput[];
  readonly parameters?: Readonly<Record<string, JsonValue>>;
  readonly functions?: FunctionRegistry;
  readonly basis?: JsonValue;
  readonly membershipRevision?: number;
  readonly executionBudget?: QueryExecutionBudget;
};

/**
 * Optional deterministic work limit. One unit is charged for each expression
 * node, visited scan-operator input, join candidate, sort comparison, recursion
 * iteration/admission, and output row produced by an evaluated physical node.
 * The counter resets for each evaluation, update, or pooled attachment.
 * `maxWorkUnits` must be a nonnegative safe integer; zero permits no charged
 * work. Omission preserves unlimited execution.
 */
export type QueryExecutionBudget = { readonly maxWorkUnits: number };

declare const preparedExpressionBrand: unique symbol;
/** Owned expression syntax accepted by the prepared scalar evaluator. */
export type PreparedExpression = {
  readonly [preparedExpressionBrand]: true;
  readonly expression: Expr;
};

/** Pure query result. `resultKeys` are stable occurrence identities and grant no write authority. */
export type QueryResult = {
  readonly rows: readonly QueryRecord[];
  readonly resultKeys: readonly string[];
  readonly completeness: Completeness;
  readonly issues: readonly Issue[];
};
