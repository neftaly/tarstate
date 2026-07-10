import { sealArtifact, type Artifact, type ArtifactRef, type ContentHash } from './artifacts.js';
import type { CapabilityRef, Issue } from './issues.js';
import type { SourceBasis } from './maintenance.js';
import type { JsonValue } from './value.js';

/** Portable expression subset used by source-local writes. */
export type WriteExpression =
  | { readonly kind: 'literal'; readonly value: JsonValue }
  | { readonly kind: 'parameter'; readonly name: string }
  | { readonly kind: 'field'; readonly alias: string; readonly name: string }
  | { readonly kind: 'compare'; readonly op: 'eq' | 'ne' | 'lt' | 'lte' | 'gt' | 'gte'; readonly left: WriteExpression; readonly right: WriteExpression }
  | { readonly kind: 'boolean'; readonly op: 'and' | 'or'; readonly args: readonly WriteExpression[] }
  | { readonly kind: 'boolean'; readonly op: 'not'; readonly arg: WriteExpression };

export type WriteRelation = {
  readonly relationId: string;
  readonly schemaView: ArtifactRef;
};

export type WriteTarget = {
  readonly relation: WriteRelation;
  readonly alias: string;
  readonly where?: WriteExpression;
};

export type FieldEdit =
  | { readonly kind: 'edit.replace'; readonly value: WriteExpression }
  | { readonly kind: 'edit.counter-increment'; readonly amount: WriteExpression }
  | { readonly kind: 'edit.text-splice'; readonly index: WriteExpression; readonly deleteCount: WriteExpression; readonly insert: WriteExpression }
  | { readonly kind: 'edit.list-splice'; readonly index: WriteExpression; readonly deleteCount: WriteExpression; readonly values: readonly WriteExpression[]; readonly requires: CapabilityRef }
  | { readonly kind: 'edit.conflict-resolve'; readonly observed: readonly JsonValue[]; readonly value: WriteExpression }
  | { readonly kind: 'extension'; readonly capability: CapabilityRef; readonly payload: JsonValue };

export type WriteStatement =
  | { readonly kind: 'statement.insert'; readonly relation: WriteRelation; readonly rows: readonly Readonly<Record<string, WriteExpression>>[] }
  | { readonly kind: 'statement.update'; readonly target: WriteTarget; readonly edits: Readonly<Record<string, FieldEdit>> }
  | { readonly kind: 'statement.delete'; readonly target: WriteTarget }
  | { readonly kind: 'statement.rekey'; readonly target: WriteTarget; readonly key: Readonly<Record<string, WriteExpression>>; readonly references: 'source-local-declared' | 'reject-if-referenced'; readonly requires: CapabilityRef }
  | { readonly kind: 'statement.move'; readonly target: WriteTarget; readonly parent: WriteExpression; readonly requires: CapabilityRef }
  | { readonly kind: 'extension'; readonly capability: CapabilityRef; readonly payload: JsonValue };

export type TransactionGuard =
  | { readonly kind: 'guard.affected-count'; readonly statementIndex: number; readonly count: 'matched' | 'logicallyChanged' | 'inserted' | 'deleted'; readonly op: 'eq' | 'gte' | 'lte'; readonly value: number }
  | { readonly kind: 'guard.query'; readonly root: JsonValue; readonly expect: 'exists' | 'empty' }
  | { readonly kind: 'extension'; readonly capability: CapabilityRef; readonly payload: JsonValue };

export type TransactionBody = {
  readonly schemaView: ArtifactRef;
  readonly parameters: Readonly<Record<string, JsonValue>>;
  readonly statements: readonly WriteStatement[];
  readonly guards: readonly TransactionGuard[];
  readonly returning?: readonly { readonly name: string; readonly root: JsonValue }[];
  readonly requiredCapabilities: readonly CapabilityRef[];
};

export type Transaction = Artifact & { readonly kind: 'transaction'; readonly body: TransactionBody };

/** Host-only attempt fields select a source attachment; bound values remain in Transaction.body. */
export type TransactionAttempt = {
  readonly operationEpoch: string;
  readonly operationId: string;
  readonly attachmentId: string;
  readonly transaction: Transaction | ArtifactRef;
  readonly expectedBasis?: SourceBasis;
  readonly signal?: AbortSignal;
};

export type SemanticEditOutcome = {
  readonly edit: 'move' | 'rekey' | 'counter' | 'text' | 'list' | 'custom';
  readonly mechanism: CapabilityRef;
  readonly preservationLosses: readonly string[];
};

export type StatementResult = {
  readonly statementIndex: number;
  readonly matched: number;
  readonly logicallyChanged: number;
  readonly inserted: number;
  readonly deleted: number;
  readonly editOutcomes: readonly SemanticEditOutcome[];
  readonly issues: readonly Issue[];
};

export type ReturningResult = {
  readonly name: string;
  readonly rows: readonly unknown[];
  readonly resultKeys: readonly string[];
  readonly sourceId: string;
  readonly basis: SourceBasis;
  readonly issues: readonly Issue[];
};

export type CommitReceipt = {
  readonly kind: 'commit';
  readonly receiptVersion: 1;
  readonly operationEpoch: string;
  readonly operationId: string;
  readonly transactionHash: ContentHash;
  readonly intentHash: ContentHash;
  readonly attachmentId: string;
  readonly attachmentFingerprint: ContentHash;
  readonly sourceId: string;
  readonly outcome: 'committed' | 'rejected' | 'unknown';
  readonly beforeBasis?: SourceBasis;
  readonly afterBasis?: SourceBasis;
  readonly statementResults: readonly StatementResult[];
  readonly returning?: readonly ReturningResult[];
  readonly issues: readonly Issue[];
  readonly durability?: 'memory' | 'local' | 'persisted' | 'unknown';
};

export type SimulationReceipt = Omit<CommitReceipt, 'kind' | 'outcome' | 'durability'> & {
  readonly kind: 'simulation';
  readonly outcome: 'would-commit' | 'rejected';
  readonly stagedState?: unknown;
};

export const sealTransaction = async (input: {
  readonly id?: string;
  readonly dependencies?: readonly ArtifactRef[];
  readonly body: TransactionBody;
}): Promise<Transaction> => sealArtifact({
  kind: 'transaction',
  ...(input.id === undefined ? {} : { id: input.id }),
  ...(input.dependencies === undefined ? {} : { dependencies: input.dependencies }),
  body: input.body as unknown as JsonValue
}) as Promise<Transaction>;

export const emptyStatementResult = (statementIndex: number): StatementResult => ({
  statementIndex,
  matched: 0,
  logicallyChanged: 0,
  inserted: 0,
  deleted: 0,
  editOutcomes: [],
  issues: []
});
