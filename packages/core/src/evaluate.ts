import type { TarstateDiagnostic } from './diagnostics.js';
import type { Query } from './query.js';
import type { RelationSource } from './source.js';

export type QueryResult<Row> = {
  readonly rows: readonly Row[];
  readonly diagnostics: readonly TarstateDiagnostic[];
};

export type EvaluateFunction = (...args: readonly unknown[]) => unknown;
export type EvaluateFunctions = Readonly<Record<string, EvaluateFunction>>;
export type EvaluateEnv = Readonly<Record<string, unknown>>;
export type EvaluateOptions = {
  readonly functions?: EvaluateFunctions;
  readonly env?: EvaluateEnv;
};

export async function evaluate<Row>(
  _source: RelationSource,
  _query: Query<Row>,
  _options: EvaluateOptions = {}
): Promise<QueryResult<Row>> {
  return { rows: [], diagnostics: [] };
}
