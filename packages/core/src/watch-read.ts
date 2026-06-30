import { evaluate, type EvaluateOptions } from './evaluate.js';
import type { Query } from './query.js';
import type { RelationRef } from './schema.js';
import type { RelationSource } from './source.js';
import type { WatchRuntimeDiagnostic, WatchTarget } from './watch.js';

export async function readWatchRows<Row>(
  source: RelationSource,
  target: WatchTarget<Row>,
  options: EvaluateOptions
): Promise<{ readonly rows: readonly Row[]; readonly diagnostics: readonly WatchRuntimeDiagnostic[] }> {
  if (isQuery(target)) {
    const result = await evaluate(source, target, options);
    return {
      rows: result.rows,
      diagnostics: result.diagnostics
    };
  }

  try {
    return {
      rows: rowsArray(await source.rows(target)) as readonly Row[],
      diagnostics: []
    };
  } catch (error) {
    return {
      rows: [],
      diagnostics: [
        {
          code: 'source_error',
          message: `source rows failed for relation ${(target as RelationRef).name}`,
          relation: (target as RelationRef).name,
          detail: error
        }
      ]
    };
  }
}

function isQuery(input: unknown): input is Query {
  return typeof input === 'object' && input !== null && 'data' in input && 'relations' in input;
}

function rowsArray(rows: Iterable<unknown>): readonly unknown[] {
  return Array.isArray(rows) ? rows : Array.from(rows);
}
