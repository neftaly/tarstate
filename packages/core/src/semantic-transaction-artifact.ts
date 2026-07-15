import { TarstateParseError, type ParseResult } from './issues.js';
import {
  defaultSemanticArtifactParseBudget,
  safeParseSemanticArtifact,
  type SemanticArtifactParseBudget
} from './internal-semantic-artifact-validation.js';
import { validateTransactionArtifactBody } from './internal-semantic-transaction-validation.js';
import type { Transaction } from './transaction.js';

export const safeParseTransactionArtifact = (
  input: unknown,
  budget = defaultSemanticArtifactParseBudget
): Promise<ParseResult<Transaction>> =>
  safeParseSemanticArtifact(input, 'transaction', validateTransactionArtifactBody, budget);

export const parseTransactionArtifact = async (
  input: unknown,
  budget?: SemanticArtifactParseBudget
): Promise<Transaction> => unwrap(await safeParseTransactionArtifact(input, budget));

/** Transaction execution remains source/coordinator-owned; preparation is total parsing and semantic validation. */
export const safePrepareTransactionArtifact = (
  input: unknown,
  budget?: SemanticArtifactParseBudget
): Promise<ParseResult<Transaction>> => safeParseTransactionArtifact(input, budget);

const unwrap = <Value>(result: ParseResult<Value>): Value => {
  if (!result.success) throw new TarstateParseError(result.issues);
  return result.value;
};
