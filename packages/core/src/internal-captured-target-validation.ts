import { canonicalizeJson } from './canonical-json.js';
import type { WritableLogicalRow } from './logical-edit.js';
import type { WriteStatement } from './transaction.js';
import type { JsonValue } from './value.js';

/** Whether every exact keyed-delta target still identifies one projected row. */
export const capturedTargetsRemain = (
  statements: readonly WriteStatement[],
  rowsByRelation: ReadonlyMap<string, readonly WritableLogicalRow[]>,
  relationKeys: ReadonlyMap<string, readonly string[]>
): boolean => {
  const keyCountsByRelation = new Map<string, ReadonlyMap<string, number>>();
  for (const statement of statements) {
    if (statement.kind !== 'statement.keyed-delta') return false;
    const relationId = statement.relation.relationId;
    const keyFields = relationKeys.get(relationId);
    if (keyFields === undefined) return false;
    let keyCounts = keyCountsByRelation.get(relationId);
    if (keyCounts === undefined) {
      const counts = new Map<string, number>();
      for (const row of rowsByRelation.get(relationId) ?? []) {
        const fingerprint = canonicalizeJson(row.key);
        counts.set(fingerprint, (counts.get(fingerprint) ?? 0) + 1);
      }
      keyCounts = counts;
      keyCountsByRelation.set(relationId, keyCounts);
    }
    for (const change of statement.changes) {
      if (change.kind !== 'delta.update') return false;
      const key = keyFields.map((field) => {
        const expression = change.key[field];
        return expression?.kind === 'literal' ? expression.value : undefined;
      });
      if (key.some((value) => value === undefined)) return false;
      if (keyCounts.get(canonicalizeJson(key as JsonValue)) !== 1) return false;
    }
  }
  return true;
};
