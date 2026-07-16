import type { Issue } from '../../issues.js';
import type { QueryContext, ScopedRow } from './evaluation-context.js';
import {
  buildIndexedRows,
  equijoinFields,
  indexKey,
  joinLeftRow,
  OverlayJoinPositions,
  OverlayRowIndex,
  resultKey,
  type EquijoinExpressions,
  type JoinPositionBucket
} from './evaluator.js';
import { withMaintenanceEvent, type MaterializedQueryNode } from './maintenance-model.js';
import type { Expr, QueryNode } from '../model.js';
import type { QueryMaintenanceFallbackReason } from '../incremental-model.js';

export const incrementallyMaterializeJoinWith = (
  node: Extract<QueryNode, { readonly kind: 'join' }>,
  materializedNodes: ReadonlyMap<QueryNode, MaterializedQueryNode>,
  previous: MaterializedQueryNode | undefined,
  fallback: () => MaterializedQueryNode,
  contextFor: (issues: Issue[]) => QueryContext
): MaterializedQueryNode => {
  const equality = equijoinFields(node);
  const left = materializedNodes.get(node.left);
  const right = materializedNodes.get(node.right);
  if (equality === undefined || previous?.join === undefined || left === undefined || right === undefined || left.unavailable || right.unavailable || left.issues.length > 0 || right.issues.length > 0 || left.result.completeness === 'unknown' || right.result.completeness === 'unknown') {
    const reason: QueryMaintenanceFallbackReason = equality === undefined
      ? 'unsupported_expression'
      : left === undefined || right === undefined || left.unavailable || right.unavailable || left.result.completeness === 'unknown' || right.result.completeness === 'unknown'
        ? 'input_unavailable'
        : 'state_unavailable';
    return withMaintenanceEvent(fallback(), { operator: 'join', strategy: 'fallback', affectedUnitCount: left?.result.rows.length ?? 0, reason });
  }
  if ((node.join === 'anti' || node.join === 'left') && right.result.completeness !== 'exact') return withMaintenanceEvent(fallback(), { operator: 'join', strategy: 'fallback', affectedUnitCount: left.result.rows.length, reason: 'input_unavailable' });
  const issues: Issue[] = [];
  const context = contextFor(issues);
  const rightUnchanged = previous.join.rightInputs.length === right.result.rows.length && previous.join.rightInputs.every((row, index) => row === right.result.rows[index]);
  const stableRightChanges = right.stableChangedPositions !== undefined
    && previous.join.rightInputs.length === right.result.rows.length;
  const sparseRightChanges = stableRightChanges
    && (right.stableChangedPositions?.length ?? 0) <= Math.max(32, Math.floor(right.result.rows.length / 4));
  const rightIndex = rightUnchanged && previous.join.rightIndex !== undefined
    ? previous.join.rightIndex
    : sparseRightChanges && previous.join.rightIndex !== undefined
      ? updateIndexedRows(previous.join.rightIndex, previous.join.rightInputs, right.result.rows, right.stableChangedPositions ?? [], equality.right, context)
      : buildIndexedRows(right.result.rows, equality.right, context);
  const stableLeftChanges = left.stableChangedPositions !== undefined
    && previous.join.leftInputs.length === left.result.rows.length;
  const sparseLeftChanges = stableLeftChanges
    && (left.stableChangedPositions?.length ?? 0) <= Math.max(32, Math.floor(left.result.rows.length / 4));
  const retainedLeftPositions = previous.join.leftPositionsByKey;
  if (rightUnchanged && previous.join.rightIndex !== undefined && sparseLeftChanges && retainedLeftPositions !== undefined) {
    const affectedPositions = [...new Set(left.stableChangedPositions ?? [])].sort((first, second) => first - second);
    const leftPositionsByKey = updateLeftJoinPositions(retainedLeftPositions, previous.join.leftInputs, left.result.rows, affectedPositions, equality.left, context);
    const segments = previous.join.segments.slice();
    let widthsStable = true;
    for (const position of affectedPositions) {
      const row = left.result.rows[position];
      if (row === undefined) return withMaintenanceEvent(fallback(), { operator: 'join', strategy: 'fallback', affectedUnitCount: affectedPositions.length, reason: 'unstable_layout' });
      const leftKey = indexKey(equality.left, row, context);
      const segment = joinLeftRow(node, row, leftKey === undefined ? [] : rightIndex.get(leftKey) ?? [], true, context);
      segments[position] = segment;
      if (segment.length !== previous.join.widths[position]) widthsStable = false;
    }
    if (context.state.unavailable || issues.length > 0) return withMaintenanceEvent(fallback(), { operator: 'join', strategy: 'fallback', affectedUnitCount: affectedPositions.length, reason: 'evaluation_unavailable' });
    const compactionCount = leftPositionsByKey !== retainedLeftPositions && leftPositionsByKey instanceof OverlayJoinPositions && leftPositionsByKey.compacted ? 1 : 0;
    if (widthsStable) {
      const output = previous.result.rows.slice();
      const changedOutputPositions: number[] = [];
      let identitiesStable = true;
      for (const position of affectedPositions) {
        const offset = previous.join.outputOffsets[position] as number;
        const segment = segments[position] as readonly ScopedRow[];
        for (let relative = 0; relative < segment.length; relative += 1) {
          const outputPosition = offset + relative;
          const replacement = segment[relative] as ScopedRow;
          identitiesStable = identitiesStable && resultKey(previous.result.rows[outputPosition] as ScopedRow) === resultKey(replacement);
          output[outputPosition] = replacement;
          changedOutputPositions.push(outputPosition);
        }
      }
      return withMaintenanceEvent({
        result: { rows: output, completeness: left.result.completeness === 'exact' && right.result.completeness === 'exact' ? 'exact' : 'lower-bound' },
        issues: [],
        unavailable: false,
        ...(identitiesStable ? { stableChangedPositions: changedOutputPositions } : {}),
        join: {
          leftInputs: left.result.rows,
          rightInputs: right.result.rows,
          segments,
          rightIndex,
          leftPositionsByKey,
          outputOffsets: previous.join.outputOffsets,
          widths: previous.join.widths
        }
      }, { operator: 'join', strategy: 'selective', affectedUnitCount: affectedPositions.length, compactionCount });
    }
    const layout = flattenJoinSegments(segments);
    return withMaintenanceEvent({
      result: { rows: layout.rows, completeness: left.result.completeness === 'exact' && right.result.completeness === 'exact' ? 'exact' : 'lower-bound' },
      issues: [],
      unavailable: false,
      join: {
        leftInputs: left.result.rows,
        rightInputs: right.result.rows,
        segments,
        rightIndex,
        leftPositionsByKey,
        outputOffsets: layout.outputOffsets,
        widths: layout.widths
      }
    }, { operator: 'join', strategy: 'selective', affectedUnitCount: affectedPositions.length, compactionCount });
  }
  const affectedRightKeys = rightUnchanged
    ? new Set<string>()
    : sparseRightChanges
      ? changedExpressionKeysAtPositions(previous.join.rightInputs, right.result.rows, right.stableChangedPositions ?? [], equality.right, context)
      : changedExpressionKeys(previous.join.rightInputs, right.result.rows, equality.right, context);
  const leftUnchanged = previous.join.leftInputs === left.result.rows
    || previous.join.leftInputs.length === left.result.rows.length
      && previous.join.leftInputs.every((row, index) => row === left.result.rows[index]);
  const selectivelyAffectedLeftPositions = leftUnchanged && sparseRightChanges && retainedLeftPositions !== undefined
    ? affectedJoinPositions(affectedRightKeys, retainedLeftPositions)
    : undefined;
  if (selectivelyAffectedLeftPositions !== undefined) {
    const leftPositionsByKey = retainedLeftPositions as ReadonlyMap<string, number | readonly number[]>;
    const affectedPositions = selectivelyAffectedLeftPositions;
    const segments = previous.join.segments.slice();
    let widthsStable = true;
    for (const position of affectedPositions) {
      const row = left.result.rows[position];
      if (row === undefined) return withMaintenanceEvent(fallback(), { operator: 'join', strategy: 'fallback', affectedUnitCount: affectedPositions.length, reason: 'unstable_layout' });
      const leftKey = indexKey(equality.left, row, context);
      const segment = joinLeftRow(node, row, leftKey === undefined ? [] : rightIndex.get(leftKey) ?? [], true, context);
      segments[position] = segment;
      if (segment.length !== previous.join.widths[position]) widthsStable = false;
    }
    if (context.state.unavailable || issues.length > 0) return withMaintenanceEvent(fallback(), { operator: 'join', strategy: 'fallback', affectedUnitCount: affectedPositions.length, reason: 'evaluation_unavailable' });
    if (widthsStable) {
      const output = previous.result.rows.slice();
      const changedOutputPositions: number[] = [];
      let identitiesStable = true;
      for (const position of affectedPositions) {
        const offset = previous.join.outputOffsets[position] as number;
        const segment = segments[position] as readonly ScopedRow[];
        for (let relative = 0; relative < segment.length; relative += 1) {
          const outputPosition = offset + relative;
          const replacement = segment[relative] as ScopedRow;
          identitiesStable = identitiesStable && resultKey(previous.result.rows[outputPosition] as ScopedRow) === resultKey(replacement);
          output[outputPosition] = replacement;
          changedOutputPositions.push(outputPosition);
        }
      }
      return withMaintenanceEvent({
        result: { rows: output, completeness: left.result.completeness === 'exact' && right.result.completeness === 'exact' ? 'exact' : 'lower-bound' },
        issues: [],
        unavailable: false,
        ...(identitiesStable ? { stableChangedPositions: changedOutputPositions } : {}),
        join: {
          leftInputs: left.result.rows,
          rightInputs: right.result.rows,
          segments,
          rightIndex,
          leftPositionsByKey,
          outputOffsets: previous.join.outputOffsets,
          widths: previous.join.widths
        }
      }, { operator: 'join', strategy: 'selective', affectedUnitCount: affectedPositions.length, compactionCount: rightIndex !== previous.join.rightIndex && rightIndex instanceof OverlayRowIndex && rightIndex.compacted ? 1 : 0 });
    }
    const layout = flattenJoinSegments(segments);
    return withMaintenanceEvent({
      result: { rows: layout.rows, completeness: left.result.completeness === 'exact' && right.result.completeness === 'exact' ? 'exact' : 'lower-bound' },
      issues: [],
      unavailable: false,
      join: {
        leftInputs: left.result.rows,
        rightInputs: right.result.rows,
        segments,
        rightIndex,
        leftPositionsByKey,
        outputOffsets: layout.outputOffsets,
        widths: layout.widths
      }
    }, { operator: 'join', strategy: 'selective', affectedUnitCount: affectedPositions.length, compactionCount: rightIndex !== previous.join.rightIndex && rightIndex instanceof OverlayRowIndex && rightIndex.compacted ? 1 : 0 });
  }
  const segments: (readonly ScopedRow[])[] = [];
  const leftPositionsByKey = new Map<string, number | number[]>();
  let previousPositions: ReadonlyMap<string, number> | undefined;
  for (let index = 0; index < left.result.rows.length; index += 1) {
    const row = left.result.rows[index] as ScopedRow;
    const identity = resultKey(row);
    const aligned = previous.join.leftInputs[index];
    let previousIndex = index;
    if (aligned === undefined || resultKey(aligned) !== identity) {
      previousPositions ??= new Map(previous.join.leftInputs.map((input, position) => [resultKey(input), position]));
      previousIndex = previousPositions.get(identity) ?? -1;
    }
    const previousInput = previous.join.leftInputs[previousIndex];
    const leftKey = indexKey(equality.left, row, context);
    if (leftKey !== undefined) appendJoinPosition(leftPositionsByKey, leftKey, index);
    const retained = previousInput === row && (leftKey === undefined || !affectedRightKeys.has(leftKey)) ? previous.join.segments[previousIndex] : undefined;
    const segment = retained ?? joinLeftRow(node, row, leftKey === undefined ? [] : rightIndex.get(leftKey) ?? [], true, context);
    segments.push(segment);
  }
  if (context.state.unavailable || issues.length > 0) return withMaintenanceEvent(fallback(), { operator: 'join', strategy: 'fallback', affectedUnitCount: left.result.rows.length, reason: 'evaluation_unavailable' });
  const layout = flattenJoinSegments(segments);
  return withMaintenanceEvent({
    result: { rows: layout.rows, completeness: left.result.completeness === 'exact' && right.result.completeness === 'exact' ? 'exact' : 'lower-bound' },
    issues: [],
    unavailable: false,
    join: {
      leftInputs: left.result.rows,
      rightInputs: right.result.rows,
      segments,
      rightIndex,
      leftPositionsByKey,
      outputOffsets: layout.outputOffsets,
      widths: layout.widths
    }
  }, { operator: 'join', strategy: 'full', affectedUnitCount: left.result.rows.length, compactionCount: rightIndex !== previous.join.rightIndex && rightIndex instanceof OverlayRowIndex && rightIndex.compacted ? 1 : 0 });
};

const changedExpressionKeysAtPositions = (
  before: readonly ScopedRow[],
  after: readonly ScopedRow[],
  positions: readonly number[],
  expression: Expr,
  context: QueryContext
): ReadonlySet<string> => {
  const changed = new Set<string>();
  for (const position of positions) {
    const previous = before[position];
    const next = after[position];
    if (previous !== undefined) { const key = indexKey(expression, previous, context); if (key !== undefined) changed.add(key); }
    if (next !== undefined) { const key = indexKey(expression, next, context); if (key !== undefined) changed.add(key); }
  }
  return changed;
};

const updateIndexedRows = (
  previous: ReadonlyMap<string, readonly ScopedRow[]>,
  before: readonly ScopedRow[],
  after: readonly ScopedRow[],
  positions: readonly number[],
  expression: Expr,
  context: QueryContext
): ReadonlyMap<string, readonly ScopedRow[]> => {
  type IndexOperation = {
    readonly removed: ScopedRow[];
    readonly added: ScopedRow[];
    readonly replacements: Map<ScopedRow, ScopedRow>;
  };
  const operations = new Map<string, IndexOperation>();
  const operation = (key: string): IndexOperation => {
    const existing = operations.get(key);
    if (existing !== undefined) return existing;
    const created = { removed: [], added: [], replacements: new Map<ScopedRow, ScopedRow>() };
    operations.set(key, created);
    return created;
  };
  let movedBetweenKeys = false;
  for (const position of positions) {
    const previousRow = before[position];
    const nextRow = after[position];
    const previousKey = previousRow === undefined ? undefined : indexKey(expression, previousRow, context);
    const nextKey = nextRow === undefined ? undefined : indexKey(expression, nextRow, context);
    if (previousRow !== undefined && nextRow !== undefined && previousKey !== undefined && previousKey === nextKey) {
      operation(previousKey).replacements.set(previousRow, nextRow);
      continue;
    }
    movedBetweenKeys = true;
    if (previousRow !== undefined && previousKey !== undefined) operation(previousKey).removed.push(previousRow);
    if (nextRow !== undefined && nextKey !== undefined) operation(nextKey).added.push(nextRow);
  }
  const nextPositions = movedBetweenKeys ? new Map(after.map((row, index) => [row, index])) : undefined;
  const overrides = new Map<string, readonly ScopedRow[] | undefined>();
  for (const [key, { removed, added, replacements }] of operations) {
    const removedRows = new Set(removed);
    const bucket: ScopedRow[] = [];
    for (const row of previous.get(key) ?? []) {
      if (!removedRows.has(row)) bucket.push(replacements.get(row) ?? row);
    }
    bucket.push(...added);
    if (nextPositions !== undefined) {
      bucket.sort((left, right) => (nextPositions.get(left) ?? 0) - (nextPositions.get(right) ?? 0));
    }
    overrides.set(key, bucket.length === 0 ? undefined : bucket);
  }
  return new OverlayRowIndex(previous, overrides);
};

const updateLeftJoinPositions = (
  previous: ReadonlyMap<string, JoinPositionBucket>,
  before: readonly ScopedRow[],
  after: readonly ScopedRow[],
  positions: readonly number[],
  expression: Expr,
  context: QueryContext
): ReadonlyMap<string, JoinPositionBucket> => {
  const operations = new Map<string, { readonly removed: number[]; readonly added: number[] }>();
  const operation = (key: string): { readonly removed: number[]; readonly added: number[] } => {
    const existing = operations.get(key);
    if (existing !== undefined) return existing;
    const created = { removed: [], added: [] };
    operations.set(key, created);
    return created;
  };
  for (const position of positions) {
    const previousRow = before[position];
    const nextRow = after[position];
    const previousKey = previousRow === undefined ? undefined : indexKey(expression, previousRow, context);
    const nextKey = nextRow === undefined ? undefined : indexKey(expression, nextRow, context);
    if (previousKey === nextKey) continue;
    if (previousKey !== undefined) operation(previousKey).removed.push(position);
    if (nextKey !== undefined) operation(nextKey).added.push(position);
  }
  const overrides = new Map<string, JoinPositionBucket | undefined>();
  for (const [key, { removed, added }] of operations) {
    const removedPositions = new Set(removed);
    const bucket = [...joinPositionBucket(previous.get(key))].filter((position) => !removedPositions.has(position));
    bucket.push(...added);
    bucket.sort((left, right) => left - right);
    overrides.set(key, bucket.length === 0 ? undefined : bucket.length === 1 ? bucket[0] : bucket);
  }
  return overrides.size === 0 ? previous : new OverlayJoinPositions(previous, overrides);
};

const changedExpressionKeys = (before: readonly ScopedRow[], after: readonly ScopedRow[], expression: Expr, context: QueryContext): ReadonlySet<string> => {
  const changed = new Set<string>();
  const beforeByIdentity = new Map(before.map((row, index) => [resultKey(row), { row, index }]));
  const afterByIdentity = new Map(after.map((row, index) => [resultKey(row), { row, index }]));
  for (const identity of new Set([...beforeByIdentity.keys(), ...afterByIdentity.keys()])) {
    const previous = beforeByIdentity.get(identity);
    const next = afterByIdentity.get(identity);
    if (previous?.row === next?.row && previous?.index === next?.index) continue;
    if (previous !== undefined) { const key = indexKey(expression, previous.row, context); if (key !== undefined) changed.add(key); }
    if (next !== undefined) { const key = indexKey(expression, next.row, context); if (key !== undefined) changed.add(key); }
  }
  return changed;
};

export const indexJoinSegments = (
  node: Extract<QueryNode, { readonly kind: 'join' }>,
  leftInputs: readonly ScopedRow[],
  rightInputs: readonly ScopedRow[],
  outputs: readonly ScopedRow[],
  context: QueryContext
): NonNullable<MaterializedQueryNode['join']> => {
  const positions = new Map(leftInputs.map((row, index) => [resultKey(row), index]));
  const segments = leftInputs.map(() => [] as ScopedRow[]);
  for (const row of outputs) {
    const key = node.join === 'semi' || node.join === 'anti' ? resultKey(row) : row.origin;
    const index = key === undefined ? undefined : positions.get(key);
    if (index !== undefined) (segments[index] as ScopedRow[]).push(row);
  }
  const equality = equijoinFields(node) as EquijoinExpressions;
  const layout = joinSegmentLayout(segments);
  return {
    leftInputs,
    rightInputs,
    segments,
    rightIndex: buildIndexedRows(rightInputs, equality.right, context),
    leftPositionsByKey: buildLeftJoinPositions(leftInputs, equality.left, context),
    outputOffsets: layout.outputOffsets,
    widths: layout.widths
  };
};

const buildLeftJoinPositions = (
  rows: readonly ScopedRow[],
  expression: Expr,
  context: QueryContext
): ReadonlyMap<string, number | readonly number[]> => {
  const positions = new Map<string, number | number[]>();
  for (const [position, row] of rows.entries()) {
    const key = indexKey(expression, row, context);
    if (key === undefined) continue;
    appendJoinPosition(positions, key, position);
  }
  return positions;
};

const appendJoinPosition = (positions: Map<string, number | number[]>, key: string, position: number): void => {
  const existing = positions.get(key);
  if (existing === undefined) positions.set(key, position);
  else if (typeof existing === 'number') positions.set(key, [existing, position]);
  else existing.push(position);
};

const joinPositionBucket = (bucket: number | readonly number[] | undefined): readonly number[] =>
  bucket === undefined ? [] : typeof bucket === 'number' ? [bucket] : bucket;

const affectedJoinPositions = (
  keys: ReadonlySet<string>,
  positions: ReadonlyMap<string, JoinPositionBucket>
): readonly number[] => {
  if (keys.size === 0) return [];
  if (keys.size === 1) return joinPositionBucket(positions.get(keys.values().next().value as string));
  const affected = new Set<number>();
  for (const key of keys) for (const position of joinPositionBucket(positions.get(key))) affected.add(position);
  return [...affected].sort((left, right) => left - right);
};

const flattenJoinSegments = (segments: readonly (readonly ScopedRow[])[]): {
  readonly rows: readonly ScopedRow[];
  readonly outputOffsets: readonly number[];
  readonly widths: readonly number[];
} => {
  const rows: ScopedRow[] = [];
  const outputOffsets: number[] = [];
  const widths: number[] = [];
  for (const segment of segments) {
    outputOffsets.push(rows.length);
    widths.push(segment.length);
    rows.push(...segment);
  }
  return { rows, outputOffsets, widths };
};

const joinSegmentLayout = (segments: readonly (readonly ScopedRow[])[]): {
  readonly outputOffsets: readonly number[];
  readonly widths: readonly number[];
} => {
  const outputOffsets: number[] = [];
  const widths: number[] = [];
  let offset = 0;
  for (const segment of segments) {
    outputOffsets.push(offset);
    widths.push(segment.length);
    offset += segment.length;
  }
  return { outputOffsets, widths };
};
