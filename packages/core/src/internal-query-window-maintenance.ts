import type { ScopedRow } from './internal-query-evaluation-context.js';
import type { QueryExpressionResult } from './internal-query-expression.js';
import { compareOrderedExpressions } from './internal-query-ordering.js';
import { sealOwnedQueryLogicalContainer, sealOwnedQueryScope } from './internal-query-ownership.js';
import { queryValueEqual } from './internal-query-values.js';
import type { Expr, OrderTerm, QueryLogicalValue, WindowExpr } from './query-model.js';
import { comparePortableStrings } from './portable-order.js';
import type { JsonValue } from './value.js';

export type WindowMaintenancePosition = {
  readonly partitionKey: string;
  readonly orderValues: readonly QueryExpressionResult[];
  readonly orderSignature: string;
  readonly rankSignature: string;
  readonly sortedIndex: number;
  readonly outputIndex: number;
};

export type WindowMaintenanceLayout = {
  readonly positions: ReadonlyMap<string, WindowMaintenancePosition>;
  readonly partitions: ReadonlyMap<string, readonly number[]>;
};

export type WindowMaintenanceLayouts = ReadonlyMap<string, WindowMaintenanceLayout>;

export type WindowPartitionState = {
  readonly members: readonly ScopedRow[];
  readonly outputs: readonly ScopedRow[];
};

export type EvaluatedWindowKeys = Pick<WindowMaintenancePosition, 'partitionKey' | 'orderValues' | 'orderSignature' | 'rankSignature'>;

export const windowSpecificationKey = (window: WindowExpr): string => canonicalizeJson({
  partitionBy: window.partitionBy ?? [],
  orderBy: window.orderBy
} as unknown as JsonValue);

export const windowSpecificationReferencesFields = (
  window: WindowExpr,
  alias: string,
  fields: ReadonlySet<string>
): boolean => {
  const visit = (value: unknown): boolean => {
    if (Array.isArray(value)) return value.some(visit);
    if (value === null || typeof value !== 'object') return false;
    const candidate = value as Readonly<Record<string, unknown>>;
    if (candidate.kind === 'field'
      && candidate.alias === alias
      && typeof candidate.name === 'string'
      && fields.has(candidate.name)) {
      return true;
    }
    return Object.values(candidate).some(visit);
  };
  return visit(window.partitionBy ?? []) || visit(window.orderBy);
};

type WindowLayoutTransition = {
  readonly layouts: WindowMaintenanceLayouts;
  readonly affectedPartitionKeys: ReadonlySet<string>;
};

const compareWindowPositions = (
  leftIndex: number,
  rightIndex: number,
  rows: readonly ScopedRow[],
  positions: ReadonlyMap<string, WindowMaintenancePosition>,
  window: WindowExpr
): number => {
  const leftRow = rows[leftIndex] as ScopedRow;
  const rightRow = rows[rightIndex] as ScopedRow;
  const left = positions.get(leftRow.identity);
  const right = positions.get(rightRow.identity);
  if (left === undefined || right === undefined) return 0;
  return compareWindowRows(left, right, rows, window.orderBy);
};

export const compareWindowRows = (
  left: { readonly outputIndex: number; readonly orderValues: readonly QueryExpressionResult[] },
  right: { readonly outputIndex: number; readonly orderValues: readonly QueryExpressionResult[] },
  rows: readonly ScopedRow[],
  terms: readonly OrderTerm[]
): number => {
  for (let index = 0; index < terms.length; index += 1) {
    const comparison = compareOrderedExpressions(
      left.orderValues[index] as QueryExpressionResult,
      right.orderValues[index] as QueryExpressionResult,
      terms[index] as OrderTerm
    );
    if (comparison !== 0) return comparison;
  }
  return comparePortableStrings(
    (rows[left.outputIndex] as ScopedRow).identity,
    (rows[right.outputIndex] as ScopedRow).identity
  );
};

const insertionIndex = (
  sorted: readonly number[],
  candidate: number,
  rows: readonly ScopedRow[],
  positions: ReadonlyMap<string, WindowMaintenancePosition>,
  window: WindowExpr
): number => {
  let low = 0;
  let high = sorted.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (compareWindowPositions(candidate, sorted[middle] as number, rows, positions, window) < 0) high = middle;
    else low = middle + 1;
  }
  return low;
};

/** Incrementally reindexes stable-identity windows from changed evaluated keys. */
export const transitionWindowLayouts = (
  specifications: ReadonlyMap<string, WindowExpr>,
  previousLayouts: WindowMaintenanceLayouts,
  rows: readonly ScopedRow[],
  changedPositions: readonly number[],
  evaluateKeys: (window: WindowExpr, row: ScopedRow) => EvaluatedWindowKeys
): WindowLayoutTransition | undefined => {
  const layouts = new Map<string, WindowMaintenanceLayout>();
  const affectedPartitionKeys = new Set<string>();
  const changedOutputIndexes = new Set(changedPositions);

  for (const [specification, window] of specifications) {
    const previous = previousLayouts.get(specification);
    if (previous === undefined) return undefined;
    const positions = new Map(previous.positions);
    const changedByPartition = new Map<string, number[]>();
    for (const outputIndex of changedPositions) {
      const row = rows[outputIndex];
      if (row === undefined) return undefined;
      const prior = previous.positions.get(row.identity);
      if (prior === undefined || prior.outputIndex !== outputIndex) return undefined;
      const keys = evaluateKeys(window, row);
      positions.set(row.identity, { ...keys, sortedIndex: -1, outputIndex });
      affectedPartitionKeys.add(prior.partitionKey);
      affectedPartitionKeys.add(keys.partitionKey);
      const additions = changedByPartition.get(keys.partitionKey) ?? [];
      additions.push(outputIndex);
      changedByPartition.set(keys.partitionKey, additions);
    }

    const partitions = new Map(previous.partitions);
    for (const partitionKey of affectedPartitionKeys) {
      const previousPartition = previous.partitions.get(partitionKey) ?? [];
      const nextPartition = previousPartition.filter((outputIndex) => !changedOutputIndexes.has(outputIndex));
      for (const outputIndex of changedByPartition.get(partitionKey) ?? []) {
        nextPartition.splice(insertionIndex(nextPartition, outputIndex, rows, positions, window), 0, outputIndex);
      }
      if (nextPartition.length === 0) partitions.delete(partitionKey);
      else partitions.set(partitionKey, nextPartition);
      for (let sortedIndex = 0; sortedIndex < nextPartition.length; sortedIndex += 1) {
        const outputIndex = nextPartition[sortedIndex] as number;
        const row = rows[outputIndex] as ScopedRow;
        const position = positions.get(row.identity);
        if (position === undefined) return undefined;
        if (position.sortedIndex !== sortedIndex || position.outputIndex !== outputIndex) {
          positions.set(row.identity, { ...position, sortedIndex, outputIndex });
        }
      }
    }
    layouts.set(specification, { positions, partitions });
  }
  return { layouts, affectedPartitionKeys };
};

export const updateWindowPartitionKeyIndex = (
  previous: ReadonlyMap<string, string>,
  changedPositions: readonly number[],
  rows: readonly ScopedRow[],
  layout: WindowMaintenanceLayout
): ReadonlyMap<string, string> | undefined => {
  const updated = new Map(previous);
  for (const outputIndex of changedPositions) {
    const row = rows[outputIndex];
    if (row === undefined) return undefined;
    const position = layout.positions.get(row.identity);
    if (position === undefined) return undefined;
    updated.set(row.identity, position.partitionKey);
  }
  return updated;
};

export const updateWindowPartitionStates = (
  previous: ReadonlyMap<string, WindowPartitionState>,
  affectedPartitionKeys: ReadonlySet<string>,
  layout: WindowMaintenanceLayout,
  inputs: readonly ScopedRow[],
  outputs: readonly ScopedRow[]
): ReadonlyMap<string, WindowPartitionState> => {
  const updated = new Map(previous);
  for (const partitionKey of affectedPartitionKeys) {
    const sortedPositions = layout.partitions.get(partitionKey);
    if (sortedPositions === undefined) {
      updated.delete(partitionKey);
      continue;
    }
    const inputPositions = [...sortedPositions].sort((left, right) => left - right);
    updated.set(partitionKey, {
      members: inputPositions.map((position) => inputs[position] as ScopedRow),
      outputs: inputPositions.map((position) => outputs[position] as ScopedRow)
    });
  }
  return updated;
};

export type IndexedWindowField = {
  readonly field: string;
  readonly window: WindowExpr;
  readonly layout: WindowMaintenanceLayout;
};

type WindowPartitionTransformation = {
  readonly rows: readonly ScopedRow[];
  readonly changedPositions: readonly number[];
};

/**
 * Pure physical transformation for already-indexed window partitions.
 * Expression evaluation is supplied by the evaluator shell so this module has
 * no query lifecycle, budget, issue, or cache responsibilities.
 */
export const transformWindowPartitions = (
  alias: string,
  fields: readonly IndexedWindowField[],
  affectedPartitionKeys: ReadonlySet<string>,
  inputs: readonly ScopedRow[],
  previousInputs: readonly ScopedRow[],
  previousOutputs: readonly ScopedRow[],
  evaluateLagValue: (expression: Expr, source: ScopedRow) => JsonValue
): WindowPartitionTransformation | undefined => {
  if (inputs.length !== previousInputs.length || inputs.length !== previousOutputs.length) return undefined;

  const projectedAliases: (Record<string, QueryLogicalValue> | undefined)[] = Array.from({ length: inputs.length });
  for (const { field, window, layout } of fields) {
    for (const partitionKey of affectedPartitionKeys) {
      const partition = layout.partitions.get(partitionKey);
      if (partition === undefined) continue;
      let rank = 1;
      let previousRankSignature: string | undefined;
      for (let sortedIndex = 0; sortedIndex < partition.length; sortedIndex += 1) {
        const outputIndex = partition[sortedIndex] as number;
        const input = inputs[outputIndex];
        if (input === undefined) return undefined;
        const position = layout.positions.get(input.identity);
        if (position === undefined) return undefined;
        if (previousRankSignature !== undefined && previousRankSignature !== position.rankSignature) rank = sortedIndex + 1;
        previousRankSignature = position.rankSignature;

        let value: JsonValue = window.op === 'row-number' ? sortedIndex + 1 : rank;
        if (window.op === 'lag') {
          const sourceIndex = partition[sortedIndex - (window.offset ?? 1)];
          const source = sourceIndex === undefined ? undefined : inputs[sourceIndex];
          value = source === undefined || window.value === undefined
            ? null
            : evaluateLagValue(window.value, source);
        }
        let projectedAlias = projectedAliases[outputIndex];
        if (projectedAlias === undefined) {
          const inputAlias = input.scope[alias];
          if (inputAlias === undefined) return undefined;
          projectedAlias = { ...inputAlias };
          projectedAliases[outputIndex] = projectedAlias;
        }
        projectedAlias[field] = value;
      }
    }
  }

  const rows = previousOutputs.slice();
  const changedPositions: number[] = [];
  for (let position = 0; position < projectedAliases.length; position += 1) {
    const projectedAlias = projectedAliases[position];
    if (projectedAlias === undefined) continue;
    const input = inputs[position] as ScopedRow;
    const previousOutput = previousOutputs[position] as ScopedRow;
    const inputAlias = input.scope[alias];
    const previousAlias = previousOutput.scope[alias];
    if (inputAlias === undefined || previousAlias === undefined) return undefined;

    let valuesChanged = !queryValueEqual(
      input.scope as QueryLogicalValue,
      (previousInputs[position] as ScopedRow).scope as QueryLogicalValue
    );
    if (!valuesChanged) {
      for (const { field } of fields) {
        if (!queryValueEqual(previousAlias[field] as QueryLogicalValue, projectedAlias[field] as QueryLogicalValue)) {
          valuesChanged = true;
          break;
        }
      }
    }
    if (!valuesChanged) continue;
    sealOwnedQueryLogicalContainer(Object.freeze(projectedAlias));
    const projectedScope = sealOwnedQueryScope({
      ...input.scope,
      [alias]: projectedAlias
    });
    (rows as ScopedRow[])[position] = Object.freeze({
      ...input,
      scope: projectedScope
    });
    changedPositions.push(position);
  }
  return { rows, changedPositions };
};
import { canonicalizeJson } from './artifacts.js';
