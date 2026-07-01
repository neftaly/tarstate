import type { WatchRuntimeDiagnostic, WatchTarget } from './watch.js';
import type { WatchOptions } from './watch.js';
import type { RelationSource } from './source.js';

export async function readWatchRows<Row>(
  _source: RelationSource,
  _target: WatchTarget<Row>,
  _options: WatchOptions<Row>
): Promise<{ readonly rows: readonly Row[]; readonly diagnostics: readonly WatchRuntimeDiagnostic[] }> {
  return { rows: [], diagnostics: [] };
}
