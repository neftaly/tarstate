import { relationDeltas } from './delta.js';
import { stableKey } from './identity.js';
import type { PredicateData, ExprData } from './query.js';
import type { RelationRef } from './schema.js';
import type { AdapterSnapshot, AdapterSource, RelationDelta, RelationRuntime } from './adapter.js';
import type { WritePatch } from './write.js';

export type MemoryRelationRuntimeOptions = {
  readonly relationNames?: readonly string[];
  readonly version?: number;
};

export function createMemoryRelationRuntime(
  input: Record<string, readonly unknown[]> = {},
  options: MemoryRelationRuntimeOptions = {}
): RelationRuntime<number> {
  let version = options.version ?? 0;
  const data = new Map<string, unknown[]>(Object.entries(input).map(([name, rows]) => [name, [...rows]]));
  const relationNames = options.relationNames ?? Object.keys(input);
  const listeners = new Set<() => void>();
  const source: AdapterSource<number> = {
    ...(relationNames.length === 0 ? {} : { relationNames }),
    rows: (relation) => [...data.get(relation.name) ?? []],
    version: () => version,
    diagnostics: () => []
  };

  return {
    source,
    target: {
      ...(relationNames.length === 0
        ? {}
        : {
            relationNames,
            ownsRelation: (relationName: string) => relationNames.includes(relationName)
          }),
      apply: (patches) => {
        const patchList = Array.from(patches);
        const deltas = new Map<string, RelationDelta>();
        let applied = 0;

        for (const patch of patchList) {
          applied += applyPatch(data, deltas, patch);
        }

        if (applied > 0) {
          version += 1;
          for (const listener of listeners) listener();
        }

        return {
          status: 'accepted',
          patches: patchList.length,
          applied,
          deltas: relationDeltas(deltas),
          diagnostics: [],
          durability: 'memory',
          version
        };
      }
    },
    snapshot: (): AdapterSnapshot<number> => ({ source, version }),
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    }
  };
}

function applyPatch(
  data: Map<string, unknown[]>,
  deltas: Map<string, RelationDelta>,
  patch: WritePatch
): number {
  const rows = rowsFor(data, patch.relation.name);

  switch (patch.op) {
    case 'insert':
      rows.push(patch.row);
      recordAdded(deltas, patch.relation, patch.row);
      return 1;
    case 'insertIgnore': {
      if (findKeyIndex(rows, patch.relation, relationKey(patch.relation, patch.row)) !== -1) return 0;
      rows.push(patch.row);
      recordAdded(deltas, patch.relation, patch.row);
      return 1;
    }
    case 'insertOrReplace': {
      const key = relationKey(patch.relation, patch.row);
      const index = findKeyIndex(rows, patch.relation, key);
      if (index === -1) {
        rows.push(patch.row);
        recordAdded(deltas, patch.relation, patch.row);
      } else {
        const before = rows[index];
        rows[index] = patch.row;
        recordRemoved(deltas, patch.relation, before);
        recordAdded(deltas, patch.relation, patch.row);
      }
      return 1;
    }
    case 'insertOrUpdate': {
      const key = relationKey(patch.relation, patch.row);
      const index = findKeyIndex(rows, patch.relation, key);
      if (index === -1) {
        rows.push(patch.row);
        recordAdded(deltas, patch.relation, patch.row);
        return 1;
      }
      return updateRow(rows, index, patch.relation, patch.update, deltas);
    }
    case 'insertOrMerge': {
      const key = relationKey(patch.relation, patch.row);
      const index = findKeyIndex(rows, patch.relation, key);
      if (index === -1) {
        rows.push(patch.row);
        recordAdded(deltas, patch.relation, patch.row);
        return 1;
      }
      const fields = patch.merge === 'provided' || patch.merge === 'all'
        ? Object.keys(patch.row)
        : patch.merge;
      const changes = Object.fromEntries(fields.flatMap((field) =>
        Object.hasOwn(patch.row, field) ? [[field, (patch.row as Record<string, unknown>)[field]]] : []
      ));
      return updateRow(rows, index, patch.relation, changes, deltas);
    }
    case 'updateByKey': {
      const index = findKeyIndex(rows, patch.relation, patch.key);
      return index === -1 ? 0 : updateRow(rows, index, patch.relation, patch.changes, deltas);
    }
    case 'update': {
      let applied = 0;
      for (let index = 0; index < rows.length; index += 1) {
        if (matchesPredicate(rows[index], patch.predicate)) {
          applied += updateRow(rows, index, patch.relation, patch.changes, deltas);
        }
      }
      return applied;
    }
    case 'deleteByKey': {
      const index = findKeyIndex(rows, patch.relation, patch.key);
      if (index === -1) return 0;
      const [removed] = rows.splice(index, 1);
      recordRemoved(deltas, patch.relation, removed);
      return 1;
    }
    case 'delete': {
      let applied = 0;
      for (let index = rows.length - 1; index >= 0; index -= 1) {
        if (matchesPredicate(rows[index], patch.predicate)) {
          const [removed] = rows.splice(index, 1);
          recordRemoved(deltas, patch.relation, removed);
          applied += 1;
        }
      }
      return applied;
    }
    case 'deleteExact': {
      const index = rows.findIndex((row) => stableKey(row) === stableKey(patch.row));
      if (index === -1) return 0;
      const [removed] = rows.splice(index, 1);
      recordRemoved(deltas, patch.relation, removed);
      return 1;
    }
    case 'replaceAll': {
      const removed = [...rows];
      rows.splice(0, rows.length, ...patch.rows);
      for (const row of removed) recordRemoved(deltas, patch.relation, row);
      for (const row of patch.rows) recordAdded(deltas, patch.relation, row);
      return stableKey(removed) === stableKey(patch.rows) ? 0 : 1;
    }
  }
}

function rowsFor(data: Map<string, unknown[]>, relationName: string): unknown[] {
  const rows = data.get(relationName);
  if (rows !== undefined) return rows;
  const next: unknown[] = [];
  data.set(relationName, next);
  return next;
}

function updateRow(
  rows: unknown[],
  index: number,
  relation: RelationRef,
  changes: Record<string, unknown>,
  deltas: Map<string, RelationDelta>
): number {
  const before = rows[index];
  const after = { ...(isRecord(before) ? before : {}), ...changes };
  if (stableKey(before) === stableKey(after)) return 0;
  rows[index] = after;
  recordRemoved(deltas, relation, before);
  recordAdded(deltas, relation, after);
  return 1;
}

function findKeyIndex(rows: readonly unknown[], relation: RelationRef, key: unknown): number {
  const wanted = stableKey(normalizeKeyInput(key));
  return rows.findIndex((row) => stableKey(relationKey(relation, row)) === wanted);
}

function relationKey(relation: RelationRef, row: unknown): unknown {
  const fields = Array.isArray(relation.key) ? relation.key : [relation.key];
  if (!isRecord(row)) return undefined;
  return fields.length === 1 ? row[fields[0]] : fields.map((field) => row[field]);
}

function normalizeKeyInput(input: unknown): unknown {
  return Array.isArray(input) ? input : input;
}

function recordAdded(deltas: Map<string, RelationDelta>, relation: RelationRef, row: unknown): void {
  deltaFor(deltas, relation).added.push(row);
}

function recordRemoved(deltas: Map<string, RelationDelta>, relation: RelationRef, row: unknown): void {
  deltaFor(deltas, relation).removed.push(row);
}

function deltaFor(deltas: Map<string, RelationDelta>, relation: RelationRef): {
  readonly relation: RelationRef;
  readonly added: unknown[];
  readonly removed: unknown[];
} {
  const existing = deltas.get(relation.name) as ReturnType<typeof deltaFor> | undefined;
  if (existing !== undefined) return existing;
  const next = { relation, added: [], removed: [] };
  deltas.set(relation.name, next);
  return next;
}

function matchesPredicate(row: unknown, predicate: PredicateData): boolean {
  switch (predicate.op) {
    case 'eq':
      return exprValue(row, predicate.left) === exprValue(row, predicate.right);
    case 'neq':
      return exprValue(row, predicate.left) !== exprValue(row, predicate.right);
    case 'lt':
      return compare(exprValue(row, predicate.left), exprValue(row, predicate.right)) < 0;
    case 'lte':
      return compare(exprValue(row, predicate.left), exprValue(row, predicate.right)) <= 0;
    case 'gt':
      return compare(exprValue(row, predicate.left), exprValue(row, predicate.right)) > 0;
    case 'gte':
      return compare(exprValue(row, predicate.left), exprValue(row, predicate.right)) >= 0;
    case 'and':
      return predicate.predicates.every((item) => matchesPredicate(row, item));
    case 'or':
      return predicate.predicates.some((item) => matchesPredicate(row, item));
    case 'not':
      return !matchesPredicate(row, predicate.predicate);
  }
}

function exprValue(row: unknown, expr: ExprData): unknown {
  switch (expr.op) {
    case 'value':
      return expr.value;
    case 'field':
      return isRecord(row) ? row[expr.field] : undefined;
    case 'tuple':
      return expr.items.map((item) => exprValue(row, item));
    default:
      return undefined;
  }
}

function compare(left: unknown, right: unknown): number {
  if (left === right) return 0;
  return String(left) < String(right) ? -1 : 1;
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === 'object' && input !== null;
}
