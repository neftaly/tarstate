import type { Issue } from './issues.js';
import type { QueryExpressionRow } from './internal-query-expression.js';
import type {
  Completeness,
  FunctionRegistry,
  QueryExecutionBudget,
  QueryNode,
  QueryRecord,
  RelationInput
} from './query-model.js';
import type { JsonValue } from './value.js';

type Provenance = {
  readonly sourceId?: string;
  readonly attachmentId?: string;
  readonly relationId: string;
  readonly key?: JsonValue;
  readonly occurrence: string;
};

export type ScopedRow = QueryExpressionRow & {
  readonly scope: Readonly<Record<string, QueryRecord>>;
  readonly provenance: Readonly<Record<string, Provenance>>;
  readonly identity: string;
  readonly origin?: string;
};

export type NodeResult = { readonly rows: readonly ScopedRow[]; readonly completeness: Completeness };

/** Minimal evaluator-facing view of a maintained physical node. */
type CachedEvaluation = {
  readonly result: NodeResult;
  readonly issues: readonly Issue[];
  readonly unavailable: boolean;
};

/** Prevents the semantic evaluator from depending on operator-specific state bags. */
export interface EvaluationCache {
  resultFor(node: QueryNode): CachedEvaluation | undefined;
}

export type EvaluationEnvironment = {
  readonly relations: ReadonlyMap<string, readonly RelationInput[]>;
  readonly parameters: Readonly<Record<string, JsonValue>>;
  readonly functions: FunctionRegistry;
  readonly basis?: JsonValue;
  readonly membershipRevision?: number;
  readonly outer?: ScopedRow;
  readonly evaluationCache?: EvaluationCache;
};

export class WorkBudgetLedger {
  private used = 0;
  private exhausted = false;

  constructor(readonly limit: number) {}

  consume(units: number): boolean {
    if (this.exhausted || this.used + units > this.limit) {
      this.exhausted = true;
      return false;
    }
    this.used += units;
    return true;
  }
}

/** Per-evaluation mutable resources; never shared across accepted transitions. */
export type EvaluationRun = { readonly work?: WorkBudgetLedger };

export const createEvaluationRun = (budget: QueryExecutionBudget | undefined): EvaluationRun =>
  budget === undefined ? {} : { work: new WorkBudgetLedger(budget.maxWorkUnits) };

export type EvaluationState = {
  readonly issues: Issue[];
  readonly recursions: Map<string, readonly ScopedRow[]>;
  readonly recursionConstants: Map<QueryNode, NodeResult>;
  readonly recursionDependencies: Map<QueryNode, ReadonlySet<string>>;
  readonly joinIndexes: Map<QueryNode, ReadonlyMap<string, readonly ScopedRow[]>>;
  unavailable: boolean;
  aggregateCompactionCount: number;
  readonly work?: WorkBudgetLedger;
};

export type QueryContext = {
  readonly environment: EvaluationEnvironment;
  readonly state: EvaluationState;
};
