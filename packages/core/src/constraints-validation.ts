import type { Db } from './db.js';
import type { TarstateDiagnostic } from './diagnostics.js';
import { evaluate, validateRelationRow, type EvaluateOptions } from './evaluate.js';
import {
  queryKey,
  type ExprData,
  type NullSortOrder,
  type OptionalProjection,
  type PredicateData,
  type ProjectionData,
  type Query,
  type QueryData,
  type SortData
} from './query.js';
import type { RelationRef } from './schema.js';
import type { RelationSource } from './source.js';
import type { RelationSourceInput } from './source-input.js';
import type { ConstraintData, ConstraintSet } from './constraints.js';
import { attachedConstraintsFor, constraintDataList } from './constraints-attachment.js';
import { asRelationSource } from './source-input.js';
import { stableKey } from './identity.js';

export type ConstraintValidationInput = ConstraintSet | readonly ConstraintData[];

export type ConstraintValidationResult = {
  readonly kind: 'constraintValidation';
  readonly valid: boolean;
  readonly diagnostics: readonly TarstateDiagnostic[];
};

export type ConstraintValidationOptions = EvaluateOptions;

export async function validateConstraints(
  source: RelationSourceInput,
  input: ConstraintValidationInput,
  options: ConstraintValidationOptions = {}
): Promise<ConstraintValidationResult> {
  const constraints = constraintDataList(input);
  const diagnostics: TarstateDiagnostic[] = [];
  const relationSource = asRelationSource(source);
  const validationOptions = isDbInput(source) ? syncEvaluateOptions(source, options) : options;

  for (const constraint of constraints) {
    diagnostics.push(...await validateConstraint(relationSource, constraint, validationOptions));
  }

  return { kind: 'constraintValidation', valid: diagnostics.length === 0, diagnostics };
}

export async function validateAttachedConstraints(
  input: RelationSourceInput,
  options: ConstraintValidationOptions = {}
): Promise<ConstraintValidationResult> {
  const constraints = attachedConstraintsFor(input);
  return validateConstraints(input, constraints, options);
}

export function validateAttachedConstraintsSync(
  db: Db,
  options: ConstraintValidationOptions = {}
): ConstraintValidationResult {
  return validateConstraintsSync(db, attachedConstraintsFor(db), options);
}

export function validateConstraintsSync(
  db: Db,
  input: ConstraintValidationInput,
  options: ConstraintValidationOptions = {}
): ConstraintValidationResult {
  const constraints = constraintDataList(input);
  const diagnostics = constraints.flatMap((constraint) => validateConstraintSync(db, constraint, options));
  return { kind: 'constraintValidation', valid: diagnostics.length === 0, diagnostics };
}

async function validateConstraint(
  source: RelationSource,
  constraint: ConstraintData,
  options: ConstraintValidationOptions
): Promise<readonly TarstateDiagnostic[]> {
  const cascadeDiagnostics = validateCascadeSupport(constraint);
  if (cascadeDiagnostics.length > 0) {
    return cascadeDiagnostics;
  }

  switch (constraint.op) {
    case 'req':
      return 'relation' in constraint
        ? validateRequired(await rowsFor(source, constraint.relation), constraint.relation.name, constraint.field)
        : validateRequired(await queryRowsFor(source, constraint.query, options), queryRelationName(constraint.query), constraint.field);
    case 'unique':
      return 'relation' in constraint
        ? validateUnique(await rowsFor(source, constraint.relation), constraint.relation.name, constraint.fields)
        : 'expressions' in constraint
          ? validateUniqueExpressions(
              await queryRowsFor(source, constraint.query, options),
              queryRelationName(constraint.query),
              constraint.expressions,
              options
            )
          : validateUnique(await queryRowsFor(source, constraint.query, options), queryRelationName(constraint.query), constraint.fields);
    case 'fk':
      return 'relation' in constraint && !('data' in constraint.target)
        ? validateForeignKey(
            await rowsFor(source, constraint.relation),
            await rowsFor(source, constraint.target),
            constraint.relation.name,
            constraint.fields,
            constraint.targetFields,
            constraint.optional
          )
        : validateQueryForeignKey(source, constraint, options);
    case 'check':
      return constraint.query === undefined
        ? []
        : validateCheck(await queryRowsFor(source, constraint.query, options), constraint.predicate, queryRelationName(constraint.query), options);
  }
}

function validateConstraintSync(
  db: Db,
  constraint: ConstraintData,
  options: ConstraintValidationOptions
): readonly TarstateDiagnostic[] {
  const cascadeDiagnostics = validateCascadeSupport(constraint);
  if (cascadeDiagnostics.length > 0) {
    return cascadeDiagnostics;
  }

  switch (constraint.op) {
    case 'req':
      return 'relation' in constraint
        ? validateRequired(db.data[constraint.relation.name] ?? [], constraint.relation.name, constraint.field)
        : validateRequired(queryRowsForSync(db, constraint.query, options), queryRelationName(constraint.query), constraint.field);
    case 'unique':
      return 'relation' in constraint
        ? validateUnique(db.data[constraint.relation.name] ?? [], constraint.relation.name, constraint.fields)
        : 'expressions' in constraint
          ? validateUniqueExpressions(
              queryRowsForSync(db, constraint.query, options),
              queryRelationName(constraint.query),
              constraint.expressions,
              syncEvaluateOptions(db, options)
            )
          : validateUnique(queryRowsForSync(db, constraint.query, options), queryRelationName(constraint.query), constraint.fields);
    case 'fk':
      return 'relation' in constraint && !('data' in constraint.target)
        ? validateForeignKey(
            db.data[constraint.relation.name] ?? [],
            db.data[constraint.target.name] ?? [],
            constraint.relation.name,
            constraint.fields,
            constraint.targetFields,
            constraint.optional
          )
        : validateQueryForeignKeySync(db, constraint, options);
    case 'check':
      return constraint.query === undefined
        ? []
        : validateCheck(
            queryRowsForSync(db, constraint.query, options),
            constraint.predicate,
            queryRelationName(constraint.query),
            syncEvaluateOptions(db, options)
          );
  }
}

async function queryRowsFor<Row>(
  source: RelationSource,
  query: Query<Row>,
  options: ConstraintValidationOptions
): Promise<readonly Row[]> {
  const result = await evaluate(source, query, options);
  return result.diagnostics.length === 0
    ? result.rows
    : [...diagnosticRows(result.diagnostics), ...result.rows] as readonly Row[];
}

async function validateQueryForeignKey(
  source: RelationSource,
  constraint: Extract<ConstraintData, { readonly op: 'fk' }>,
  options: ConstraintValidationOptions
): Promise<readonly TarstateDiagnostic[]> {
  if (!('query' in constraint)) {
    return [];
  }

  const sourceRows = await queryRowsFor(source, constraint.query, options);
  const targetRows = 'data' in constraint.target
    ? await queryRowsFor(source, constraint.target, options)
    : await rowsFor(source, constraint.target);
  return validateForeignKey(
    sourceRows,
    targetRows,
    queryRelationName(constraint.query),
    constraint.fields,
    constraint.targetFields,
    constraint.optional
  );
}

function validateQueryForeignKeySync(
  db: Db,
  constraint: Extract<ConstraintData, { readonly op: 'fk' }>,
  options: ConstraintValidationOptions
): readonly TarstateDiagnostic[] {
  if (!('query' in constraint)) {
    return [];
  }

  const sourceRows = queryRowsForSync(db, constraint.query, options);
  const targetRows = 'data' in constraint.target
    ? queryRowsForSync(db, constraint.target, options)
    : db.data[constraint.target.name] ?? [];
  return validateForeignKey(
    sourceRows,
    targetRows,
    queryRelationName(constraint.query),
    constraint.fields,
    constraint.targetFields,
    constraint.optional
  );
}

async function rowsFor(source: RelationSource, relation: { readonly name: string }): Promise<readonly unknown[]> {
  try {
    return await source.rows(relation as Parameters<RelationSource['rows']>[0]);
  } catch (error) {
    return [{
      __tarstateDiagnostic: {
        code: 'source_error',
        message: error instanceof Error ? error.message : String(error),
        relation: relation.name,
        detail: error
      } satisfies TarstateDiagnostic
    }];
  }
}

function validateRequired(
  rows: readonly unknown[],
  relation: string,
  field: string
): readonly TarstateDiagnostic[] {
  return rows.flatMap((row) => {
    if (diagnosticRow(row)) return [row.__tarstateDiagnostic];
    const value = isRecord(row) ? row[field] : undefined;
    return value === undefined
      ? [constraintDiagnostic('constraint_req', `required field ${field} is missing`, relation, field, rowKey(row), {
          error: 'required-field-violation',
          relvar: relation,
          field,
          row,
          clause: { op: 'req', field }
        })]
      : [];
  });
}

function validateUnique(
  rows: readonly unknown[],
  relation: string,
  fields: readonly string[]
): readonly TarstateDiagnostic[] {
  const seen = new Map<string, unknown>();
  const diagnostics: TarstateDiagnostic[] = [];

  for (const row of rows) {
    if (diagnosticRow(row)) {
      diagnostics.push(row.__tarstateDiagnostic);
      continue;
    }

    const values = valuesFor(row, fields);
    if (values.some((value) => value === undefined || value === null)) {
      continue;
    }

    const key = stableKeyValue(values);
    if (seen.has(key)) {
      const previous = seen.get(key);
      diagnostics.push(constraintDiagnostic(
        'constraint_unique',
        `unique constraint failed for ${fields.join(',')}`,
        relation,
        fields.join(','),
        displayKey(values),
        {
          error: 'unique-key-violation',
          relvar: relation,
          fields,
          values,
          oldRow: previous,
          newRow: row,
          rows: [previous, row],
          clause: { op: 'unique', fields }
        }
      ));
    } else {
      seen.set(key, row);
    }
  }

  return diagnostics;
}

function validateUniqueExpressions(
  rows: readonly unknown[],
  relation: string,
  expressions: readonly ExprData[],
  options: ConstraintValidationOptions
): readonly TarstateDiagnostic[] {
  const seen = new Map<string, unknown>();
  const diagnostics: TarstateDiagnostic[] = [];
  const expressionLabel = displayExpressions(expressions);

  for (const row of rows) {
    if (diagnosticRow(row)) {
      diagnostics.push(row.__tarstateDiagnostic);
      continue;
    }

    const expressionDiagnostics: TarstateDiagnostic[] = [];
    const values = expressions.map((expression) =>
      exprValue(row, expression, {
        options,
        diagnostics: expressionDiagnostics,
        relation
      })
    );

    if (expressionDiagnostics.length > 0) {
      diagnostics.push(...expressionDiagnostics);
      continue;
    }

    if (values.some((value) => value === undefined || value === null)) {
      continue;
    }

    const key = stableKeyValue(values);
    if (seen.has(key)) {
      const previous = seen.get(key);
      diagnostics.push(constraintDiagnostic(
        'constraint_unique',
        `unique constraint failed for ${expressionLabel}`,
        relation,
        expressionLabel,
        displayKey(values),
        {
          error: 'unique-key-violation',
          relvar: relation,
          expressions,
          values,
          oldRow: previous,
          newRow: row,
          rows: [previous, row],
          clause: { op: 'unique', expressions }
        }
      ));
    } else {
      seen.set(key, row);
    }
  }

  return diagnostics;
}

function validateForeignKey(
  sourceRows: readonly unknown[],
  targetRows: readonly unknown[],
  relation: string,
  fields: readonly string[],
  targetFields: readonly string[],
  optional: boolean
): readonly TarstateDiagnostic[] {
  const targetKeys = new Set(targetRows.filter((row) => !diagnosticRow(row)).map((row) =>
    stableKeyValue(valuesFor(row, targetFields))
  ));
  const diagnostics: TarstateDiagnostic[] = [];

  for (const row of sourceRows) {
    if (diagnosticRow(row)) {
      diagnostics.push(row.__tarstateDiagnostic);
      continue;
    }

    const values = valuesFor(row, fields);
    if (optional && values.some((value) => value === undefined || value === null)) {
      continue;
    }

    if (!targetKeys.has(stableKeyValue(values))) {
      diagnostics.push(constraintDiagnostic(
        'constraint_fk',
        `foreign key target is missing for ${fields.join(',')}`,
        relation,
        fields.join(','),
        optional && fields.length === 1 ? rowKey(row) : displayKey(values),
        {
          error: 'foreign-key-violation',
          relvar: relation,
          fields,
          targetFields,
          values,
          row,
          rows: targetRows,
          clause: { op: 'fk', fields, targetFields, optional }
        }
      ));
    }
  }

  return diagnostics;
}

function validateCheck(
  rows: readonly unknown[],
  predicate: PredicateData,
  relation = 'query',
  options: ConstraintValidationOptions = {}
): readonly TarstateDiagnostic[] {
  return rows.flatMap((row) => {
    if (diagnosticRow(row)) return [row.__tarstateDiagnostic];
    const expressionDiagnostics: TarstateDiagnostic[] = [];
    const passed = evaluatePredicate(row, predicate, {
      options,
      diagnostics: expressionDiagnostics,
      relation
    });

    if (expressionDiagnostics.length > 0) {
      return expressionDiagnostics;
    }

    return passed
      ? []
      : [constraintDiagnostic('constraint_check', 'check constraint failed', relation, '', rowKey(row), {
          error: 'check-violation',
          relvar: relation,
          row,
          clause: predicate
        })];
  });
}

function validateCascadeSupport(constraint: ConstraintData): readonly TarstateDiagnostic[] {
  if (constraint.op !== 'fk' || constraint.cascade === undefined || constraint.cascade === false) {
    return [];
  }

  const supportedMode = constraint.cascade === true || constraint.cascade === 'delete';
  const directRelationFk = 'relation' in constraint && !('data' in constraint.target);
  if (supportedMode && directRelationFk) {
    return [];
  }

  return [constraintDiagnostic(
    'constraint_fk_cascade_unsupported',
    supportedMode
      ? 'foreign key cascade is only supported for direct relation foreign keys'
      : `unsupported foreign key cascade mode ${String(constraint.cascade)}`,
    constraintRelationName(constraint),
    constraint.op === 'fk' ? constraint.fields.join(',') : '',
    undefined,
    {
      kind: constraint.op,
      relation: constraintRelationName(constraint),
      target: constraint.op === 'fk' ? constraintTargetName(constraint) : undefined,
      fields: constraint.op === 'fk' ? constraint.fields : undefined,
      targetFields: constraint.op === 'fk' ? constraint.targetFields : undefined,
      cascade: constraint.op === 'fk' ? constraint.cascade : undefined
    }
  )];
}

type ConstraintExpressionState = {
  readonly options: ConstraintValidationOptions;
  readonly diagnostics: TarstateDiagnostic[];
  readonly relation: string;
  readonly evaluateSubquery?: (expr: Extract<ExprData, { readonly op: 'subquery' }>, row: Record<string, unknown>) => unknown;
  readonly evaluateAggregate?: (expr: Extract<ExprData, { readonly op: 'aggregateCall' }>, row: Record<string, unknown>) => unknown;
};

function evaluatePredicate(
  row: unknown,
  predicate: PredicateData,
  state: ConstraintExpressionState
): boolean {
  switch (predicate.op) {
    case 'eq':
      return Object.is(exprValue(row, predicate.left, state), exprValue(row, predicate.right, state));
    case 'neq':
      return !Object.is(exprValue(row, predicate.left, state), exprValue(row, predicate.right, state));
    case 'lt':
      return compareValues(exprValue(row, predicate.left, state), exprValue(row, predicate.right, state)) < 0;
    case 'lte':
      return compareValues(exprValue(row, predicate.left, state), exprValue(row, predicate.right, state)) <= 0;
    case 'gt':
      return compareValues(exprValue(row, predicate.left, state), exprValue(row, predicate.right, state)) > 0;
    case 'gte':
      return compareValues(exprValue(row, predicate.left, state), exprValue(row, predicate.right, state)) >= 0;
    case 'and':
      return predicate.predicates.every((item) => evaluatePredicate(row, item, state));
    case 'or':
      return predicate.predicates.some((item) => evaluatePredicate(row, item, state));
    case 'not':
      return !evaluatePredicate(row, predicate.predicate, state);
  }
}

function exprValue(row: unknown, expr: ExprData, state: ConstraintExpressionState): unknown {
  switch (expr.op) {
    case 'value':
      return expr.value;
    case 'env':
      return state.options.env?.[expr.name];
    case 'call': {
      const fn = state.options.functions?.[expr.name];
      if (fn === undefined) {
        pushUnsupportedExpressionDiagnostic(state, unsupportedExpressionDiagnostic(
          `function ${expr.name} is not available for constraint validation`,
          state.relation,
          expr
        ));
        return undefined;
      }

      const args = expr.args.map((arg) => exprValue(row, arg, state));
      const value = fn(...args);
      if (isPromiseLike(value)) {
        pushUnsupportedExpressionDiagnostic(state, unsupportedExpressionDiagnostic(
          `function ${expr.name} returned a Promise and cannot be validated synchronously`,
          state.relation,
          expr
        ));
        return undefined;
      }

      return value;
    }
    case 'hostCall':
      if (expr.fn === undefined) {
        pushUnsupportedExpressionDiagnostic(state, unsupportedExpressionDiagnostic(
          `host function ${expr.name} is not available for constraint validation`,
          state.relation,
          expr
        ));
        return undefined;
      }

      try {
        const args = expr.args.map((arg) => exprValue(row, arg, state));
        const value = expr.fn(...args);
        if (isPromiseLike(value)) {
          pushUnsupportedExpressionDiagnostic(state, unsupportedExpressionDiagnostic(
            `host function ${expr.name} returned a Promise and cannot be validated synchronously`,
            state.relation,
            expr
          ));
          return undefined;
        }

        return value;
      } catch {
        pushUnsupportedExpressionDiagnostic(state, unsupportedExpressionDiagnostic(
          `host function ${expr.name} failed during constraint validation`,
          state.relation,
          expr
        ));
        return undefined;
      }
    case 'field': {
      return readField(asRecord(row), expr.alias, expr.field);
    }
    case 'tuple':
      return expr.items.map((item) => exprValue(row, item, state));
    case 'subquery':
      if (state.evaluateSubquery !== undefined) {
        return state.evaluateSubquery(expr, asRecord(row));
      }
      pushUnsupportedExpressionDiagnostic(state, unsupportedExpressionDiagnostic(
        'subquery expressions are only supported inside query validation',
        state.relation,
        expr
      ));
      return undefined;
    case 'aggregateCall':
      if (state.evaluateAggregate !== undefined) {
        return state.evaluateAggregate(expr, asRecord(row));
      }
      pushUnsupportedExpressionDiagnostic(state, unsupportedExpressionDiagnostic(
        'aggregate expressions are only supported inside aggregate query validation',
        state.relation,
        expr
      ));
      return undefined;
  }
}

function compareValues(left: unknown, right: unknown): number {
  if (Object.is(left, right)) return 0;
  if (left === undefined || left === null) return -1;
  if (right === undefined || right === null) return 1;
  if ((typeof left === 'number' && typeof right === 'number') || (typeof left === 'string' && typeof right === 'string')) {
    return left < right ? -1 : 1;
  }
  return stableKey(left) < stableKey(right) ? -1 : 1;
}

function valuesFor(row: unknown, fields: readonly string[]): readonly unknown[] {
  return fields.map((field) => isRecord(row) ? row[field] : undefined);
}

function compareSortValues(
  left: unknown,
  right: unknown,
  direction: 'asc' | 'desc',
  nulls: NullSortOrder | undefined
): number {
  const leftNull = left === null || left === undefined;
  const rightNull = right === null || right === undefined;
  if (leftNull || rightNull) {
    if (leftNull && rightNull) return 0;
    const nullOrder = nulls ?? 'last';
    return leftNull === (nullOrder === 'first') ? -1 : 1;
  }

  const comparison = compareValues(left, right);
  return direction === 'asc' ? comparison : -comparison;
}

function syncEvaluateOptions(db: Db, options: ConstraintValidationOptions): ConstraintValidationOptions {
  return {
    ...options,
    env: { ...db.env, ...options.env }
  };
}

function expressionState(state: SyncQueryState): ConstraintExpressionState {
  return {
    options: state.options,
    diagnostics: state.diagnostics,
    relation: state.relation,
    evaluateSubquery: (expr, row) => {
      const rows = evaluateQueryDataSync(expr.query, state, row);
      return expr.mode === 'many' ? rows : rows[0];
    },
    evaluateAggregate: (expr, row) => evaluateAggregateSync(expr, [row], state)
  };
}

type SyncEvalContext = Record<string, unknown>;
type SyncQueryState = {
  readonly db: Db;
  readonly relations: Record<string, RelationRef>;
  readonly options: ConstraintValidationOptions;
  readonly diagnostics: TarstateDiagnostic[];
  readonly relation: string;
};

function queryRowsForSync<Row>(
  db: Db,
  query: Query<Row>,
  options: ConstraintValidationOptions = {}
): readonly Row[] {
  const state: SyncQueryState = {
    db,
    relations: query.relations,
    options: syncEvaluateOptions(db, options),
    diagnostics: [],
    relation: queryRelationName(query)
  };
  const rows = evaluateQueryDataSync(query.data, state);
  return state.diagnostics.length === 0
    ? rows as readonly Row[]
    : [...diagnosticRows(state.diagnostics), ...rows] as readonly Row[];
}

function evaluateQueryDataSync(
  data: QueryData,
  state: SyncQueryState,
  outerRow: SyncEvalContext = {}
): readonly SyncEvalContext[] {
  switch (data.op) {
    case 'from':
      return relationRowsSync(data.relation, data.alias, state, outerRow);
    case 'lookup':
      return lookupRowsSync(data, state, outerRow);
    case 'constRows':
      return data.rows.map((row) => ({ ...outerRow, ...row }));
    case 'where':
      return evaluateQueryDataSync(data.input, state, outerRow)
        .filter((row) => evaluatePredicate(row, data.predicate, expressionState(state)));
    case 'hash':
    case 'btree':
    case 'keyBy':
      return evaluateQueryDataSync(data.input, state, outerRow);
    case 'join':
      return joinRowsSync(data.kind, data.left, data.right, data.on, state, outerRow);
    case 'project':
      return evaluateQueryDataSync(data.input, state, outerRow)
        .map((row) => projectRowSync(row, data.projection, state));
    case 'extend':
      return evaluateQueryDataSync(data.input, state, outerRow)
        .map((row) => ({ ...row, ...projectRowSync(row, data.projection, state) }));
    case 'expand':
      return expandRowsSync(data.input, data.collection, data.alias, data.fields, state, outerRow);
    case 'without':
      return evaluateQueryDataSync(data.input, state, outerRow).map((row) => {
        const output = { ...row };
        for (const field of data.fields) {
          delete output[field];
        }
        return output;
      });
    case 'sort':
      return sortRowsSync(evaluateQueryDataSync(data.input, state, outerRow), data.order, state);
    case 'limit': {
      const offset = data.offset ?? 0;
      return evaluateQueryDataSync(data.input, state, outerRow).slice(offset, offset + data.count);
    }
    case 'sortLimit':
      return sortRowsSync(evaluateQueryDataSync(data.input, state, outerRow), data.order, state).slice(0, data.count);
    case 'union':
      return setUnionSync(data.inputs.map((input) => evaluateQueryDataSync(input, state, outerRow)));
    case 'intersection':
      return setIntersectionSync(data.inputs.map((input) => evaluateQueryDataSync(input, state, outerRow)));
    case 'difference':
      return setDifferenceSync(
        evaluateQueryDataSync(data.left, state, outerRow),
        evaluateQueryDataSync(data.right, state, outerRow)
      );
    case 'rename':
      return evaluateQueryDataSync(data.input, state, outerRow).map((row) => renameRow(row, data.fields));
    case 'qualify':
      return evaluateQueryDataSync(data.input, state, outerRow).map((row) => ({ [data.alias]: row }));
    case 'aggregate':
      return aggregateRowsSync(
        evaluateQueryDataSync(data.input, state, outerRow),
        data.groupBy,
        data.aggregates,
        state
      );
  }
}

function relationRowsSync(
  relationName: string,
  alias: string,
  state: SyncQueryState,
  outerRow: SyncEvalContext
): readonly SyncEvalContext[] {
  const relation = state.relations[relationName];
  if (relation === undefined) {
    state.diagnostics.push({
      code: 'unsupported_lookup',
      message: `relation ${relationName} is not available`,
      relation: relationName
    });
    return [];
  }

  return validRelationRowsSync(relation, state.db.data[relation.name] ?? [], state)
    .map((row) => ({ ...outerRow, [alias]: row }));
}

function lookupRowsSync(
  data: Extract<QueryData, { readonly op: 'lookup' }>,
  state: SyncQueryState,
  outerRow: SyncEvalContext
): readonly SyncEvalContext[] {
  const relation = state.relations[data.relation];
  if (relation === undefined) {
    return [];
  }

  const value = exprValue(outerRow, data.value, expressionState(state));
  return validRelationRowsSync(relation, state.db.data[relation.name] ?? [], state)
    .filter((row) => Object.is(row[data.field], value))
    .map((row) => ({ ...outerRow, [data.alias]: row }));
}

function validRelationRowsSync(
  relation: RelationRef,
  rows: readonly unknown[],
  state: SyncQueryState
): readonly SyncEvalContext[] {
  const output: SyncEvalContext[] = [];

  for (const row of rows) {
    if (!isRecord(row)) {
      state.diagnostics.push({
        code: 'invalid_row',
        message: 'row is not an object',
        relation: relation.name
      });
      continue;
    }

    const diagnostics = validateRelationRow(relation, row);
    if (diagnostics.length === 0) {
      output.push(row);
    } else {
      state.diagnostics.push(...diagnostics);
    }
  }

  return output;
}

function joinRowsSync(
  kind: 'inner' | 'left',
  leftData: QueryData,
  rightData: QueryData,
  on: PredicateData,
  state: SyncQueryState,
  outerRow: SyncEvalContext
): readonly SyncEvalContext[] {
  const left = evaluateQueryDataSync(leftData, state, outerRow);
  const right = evaluateQueryDataSync(rightData, state, outerRow);
  const output: SyncEvalContext[] = [];

  for (const leftRow of left) {
    let matched = false;

    for (const rightRow of right) {
      const merged = { ...leftRow, ...rightRow };
      if (evaluatePredicate(merged, on, expressionState(state))) {
        matched = true;
        output.push(merged);
      }
    }

    if (!matched && kind === 'left') {
      output.push(leftRow);
    }
  }

  return output;
}

function expandRowsSync(
  inputData: QueryData,
  collection: ExprData,
  alias: string | undefined,
  fields: readonly string[] | undefined,
  state: SyncQueryState,
  outerRow: SyncEvalContext
): readonly SyncEvalContext[] {
  const input = evaluateQueryDataSync(inputData, state, outerRow);
  const output: SyncEvalContext[] = [];

  for (const row of input) {
    const value = exprValue(row, collection, expressionState(state));
    if (value === null || value === undefined || !isIterable(value)) {
      continue;
    }

    for (const item of value) {
      if (alias !== undefined) {
        output.push({ ...row, [alias]: item });
      } else if (isRecord(item)) {
        output.push({ ...row, ...pickFields(item, fields) });
      }
    }
  }

  return output;
}

function projectRowSync(
  row: SyncEvalContext,
  projection: ProjectionData,
  state: SyncQueryState
): SyncEvalContext {
  const output: Record<string, unknown> = {};

  for (const [field, item] of Object.entries(projection)) {
    output[field] = exprValue(row, projectionExpr(item), expressionState(state));
  }

  return output;
}

function projectionExpr(input: ProjectionData[string]): ExprData {
  return isOptionalProjection(input) ? input.expr : input;
}

function isOptionalProjection(input: ProjectionData[string]): input is OptionalProjection {
  return isRecord(input) && 'kind' in input && input.kind === 'optionalProjection';
}

function renameRow(row: unknown, fields: Record<string, string>): Record<string, unknown> {
  const output = { ...asRecord(row) };
  for (const [from, to] of Object.entries(fields)) {
    output[to] = output[from];
    delete output[from];
  }
  return output;
}

function sortRowsSync(
  rows: readonly SyncEvalContext[],
  order: readonly SortData[],
  state: SyncQueryState
): readonly SyncEvalContext[] {
  const keyedRows = rows.map((row) => ({
    row,
    values: order.map((item) => exprValue(row, item.expr, expressionState(state)))
  }));

  return keyedRows.sort((left, right) => {
    for (let index = 0; index < order.length; index += 1) {
      const item = order[index] as SortData;
      const comparison = compareSortValues(
        left.values[index],
        right.values[index],
        item.direction,
        item.nulls
      );

      if (comparison !== 0) {
        return comparison;
      }
    }

    return 0;
  }).map((item) => item.row);
}

function aggregateRowsSync(
  rows: readonly SyncEvalContext[],
  groupBy: ProjectionData,
  aggregates: ProjectionData,
  state: SyncQueryState
): readonly SyncEvalContext[] {
  const groups = new Map<string, { readonly group: SyncEvalContext; readonly rows: SyncEvalContext[] }>();

  for (const row of rows) {
    const group = projectRowSync(row, groupBy, state);
    const key = stableKey(group);
    const existing = groups.get(key);
    if (existing === undefined) {
      groups.set(key, { group, rows: [row] });
    } else {
      existing.rows.push(row);
    }
  }

  if (groups.size === 0 && Object.keys(groupBy).length === 0) {
    groups.set(stableKey({}), { group: {}, rows: [] });
  }

  return Array.from(groups.values()).map(({ group, rows: groupRows }) => {
    const output: Record<string, unknown> = { ...group };
    for (const [name, item] of Object.entries(aggregates)) {
      output[name] = evaluateAggregateSync(projectionExpr(item), groupRows, state);
    }
    return output;
  });
}

function evaluateAggregateSync(
  expr: ExprData,
  rows: readonly SyncEvalContext[],
  state: SyncQueryState
): unknown {
  if (expr.op !== 'aggregateCall') {
    return exprValue(rows[0] ?? {}, expr, expressionState(state));
  }

  const values = expr.expr === undefined
    ? rows
    : rows.map((row) => exprValue(row, expr.expr as ExprData, expressionState(state)));
  const aggregateValues = expr.distinct ? distinctValues(values) : values;

  switch (expr.name) {
    case 'count':
      return expr.expr === undefined
        ? rows.length
        : aggregateValues.filter((value) => value !== null && value !== undefined).length;
    case 'sum':
      return aggregateValues.reduce<number>((total, value) => total + (typeof value === 'number' ? value : 0), 0);
    case 'avg': {
      const numbers = aggregateValues.filter((value): value is number => typeof value === 'number');
      return numbers.length === 0 ? undefined : numbers.reduce((total, value) => total + value, 0) / numbers.length;
    }
    case 'min':
      return orderedValues(aggregateValues).at(0);
    case 'max':
      return orderedValues(aggregateValues).at(-1);
    case 'any':
      return aggregateValues.some(Boolean);
    case 'notAny':
      return !aggregateValues.some(Boolean);
    case 'setConcat':
      return new Set(aggregateValues.flatMap((value) => {
        if (value instanceof Set) return Array.from(value);
        if (Array.isArray(value)) return value;
        return [value];
      }));
    case 'top':
      return [...orderedValues(aggregateValues)].reverse().slice(0, expr.count ?? 0);
    case 'bottom':
      return orderedValues(aggregateValues).slice(0, expr.count ?? 0);
    case 'topBy':
      return rowsByAggregateSync(rows, expr.expr, state, 'desc').slice(0, expr.count ?? 0);
    case 'bottomBy':
      return rowsByAggregateSync(rows, expr.expr, state, 'asc').slice(0, expr.count ?? 0);
    case 'maxBy':
      return rowsByAggregateSync(rows, expr.expr, state, 'desc').at(0);
    case 'minBy':
      return rowsByAggregateSync(rows, expr.expr, state, 'asc').at(0);
  }
}

function rowsByAggregateSync(
  rows: readonly SyncEvalContext[],
  expr: ExprData | undefined,
  state: SyncQueryState,
  direction: 'asc' | 'desc'
): readonly SyncEvalContext[] {
  if (expr === undefined) {
    return [...rows];
  }

  return rows.map((row) => ({
    row,
    value: exprValue(row, expr, expressionState(state))
  })).sort((left, right) =>
    compareSortValues(left.value, right.value, direction, 'last')
  ).map((item) => item.row);
}

function setUnionSync(inputs: readonly (readonly SyncEvalContext[])[]): readonly SyncEvalContext[] {
  const seen = new Set<string>();
  const output: SyncEvalContext[] = [];

  for (const rows of inputs) {
    for (const row of rows) {
      const key = stableKey(row);
      if (!seen.has(key)) {
        seen.add(key);
        output.push(row);
      }
    }
  }

  return output;
}

function setIntersectionSync(inputs: readonly (readonly SyncEvalContext[])[]): readonly SyncEvalContext[] {
  if (inputs.length === 0) {
    return [];
  }

  const rightKeys = inputs.slice(1).map((rows) => new Set(rows.map(stableKey)));
  const emitted = new Set<string>();
  const firstInput = inputs[0] ?? [];
  return firstInput.filter((row) => {
    const key = stableKey(row);
    if (emitted.has(key) || rightKeys.some((keys) => !keys.has(key))) {
      return false;
    }
    emitted.add(key);
    return true;
  });
}

function setDifferenceSync(
  left: readonly SyncEvalContext[],
  right: readonly SyncEvalContext[]
): readonly SyncEvalContext[] {
  const rightKeys = new Set(right.map(stableKey));
  const emitted = new Set<string>();

  return left.filter((row) => {
    const key = stableKey(row);
    if (emitted.has(key) || rightKeys.has(key)) {
      return false;
    }
    emitted.add(key);
    return true;
  });
}

function distinctValues(values: readonly unknown[]): readonly unknown[] {
  const seen = new Set<string>();
  const output: unknown[] = [];

  for (const value of values) {
    const key = stableKey(value);
    if (!seen.has(key)) {
      seen.add(key);
      output.push(value);
    }
  }

  return output;
}

function orderedValues(values: readonly unknown[]): readonly unknown[] {
  return [...values]
    .filter((value) => value !== null && value !== undefined)
    .sort(compareValues);
}

function stableKeyValue(values: readonly unknown[]): string {
  return stableKey(values.length === 1 ? values[0] : values);
}

function displayKey(values: readonly unknown[]): string {
  return values.length === 1 ? String(values[0]) : JSON.stringify(values);
}

function displayExpressions(expressions: readonly ExprData[]): string {
  return expressions.length === 1
    ? expressionDescription(expressions[0] as ExprData)
    : expressions.map((expression) => expressionDescription(expression)).join(',');
}

function expressionDescription(expression: ExprData): string {
  switch (expression.op) {
    case 'field':
      return `${expression.alias}.${expression.field}`;
    case 'env':
      return `env.${expression.name}`;
    case 'call':
    case 'hostCall':
      return `${expression.name}(...)`;
    case 'tuple':
      return `tuple(${expression.items.map((item) => expressionDescription(item)).join(',')})`;
    case 'aggregateCall':
      return `${expression.name}(...)`;
    case 'subquery':
      return `subquery:${expression.mode}`;
    case 'value':
      return 'value';
  }
}

function rowKey(row: unknown): string | undefined {
  if (!isRecord(row)) return undefined;
  if ('id' in row) return String(row.id);
  return stableKey(row);
}

function constraintDiagnostic(
  code: string,
  message: string,
  relation: string,
  field: string,
  key: string | undefined,
  detail?: unknown
): TarstateDiagnostic {
  return {
    code,
    message,
    relation,
    field,
    ...(key === undefined ? {} : { key }),
    ...(detail === undefined ? {} : { detail })
  } satisfies TarstateDiagnostic;
}

function diagnosticRows(diagnostics: readonly TarstateDiagnostic[]): readonly { readonly __tarstateDiagnostic: TarstateDiagnostic }[] {
  return diagnostics.map(diagnosticRowFor);
}

function diagnosticRowFor(diagnostic: TarstateDiagnostic): { readonly __tarstateDiagnostic: TarstateDiagnostic } {
  return { __tarstateDiagnostic: diagnostic };
}

function unsupportedExpressionDiagnostic(
  message: string,
  relation: string,
  expression: ExprData
): TarstateDiagnostic {
  return constraintDiagnostic(
    'unsupported_expression',
    message,
    relation,
    expressionDescription(expression),
    undefined,
    {
      error: 'constraint-expression-sync-unsupported',
      expression
    }
  );
}

function pushUnsupportedExpressionDiagnostic(
  state: ConstraintExpressionState,
  diagnostic: TarstateDiagnostic
): void {
  const duplicate = state.diagnostics.some((item) =>
    item.code === diagnostic.code &&
    item.message === diagnostic.message &&
    item.relation === diagnostic.relation &&
    item.field === diagnostic.field
  );
  if (!duplicate) {
    state.diagnostics.push(diagnostic);
  }
}

function queryRelationName(query: Query): string {
  return queryKey(query);
}

function constraintRelationName(constraint: ConstraintData): string {
  if ('relation' in constraint) return constraint.relation.name;
  if ('query' in constraint) return queryRelationName(constraint.query);
  return 'query';
}

function constraintTargetName(constraint: Extract<ConstraintData, { readonly op: 'fk' }>): string {
  return 'data' in constraint.target ? queryRelationName(constraint.target) : constraint.target.name;
}

function asRecord(input: unknown): Record<string, unknown> {
  return isRecord(input) ? input : {};
}

function readField(row: Record<string, unknown>, alias: string, field: string): unknown {
  const aliased = row[alias];

  if (isRecord(aliased)) {
    return aliased[field];
  }

  if (aliased !== undefined && field === 'value') {
    return aliased;
  }

  return row[field];
}

function pickFields(row: Record<string, unknown>, fields: readonly string[] | undefined): Record<string, unknown> {
  if (fields === undefined) {
    return row;
  }

  return Object.fromEntries(fields.map((field) => [field, row[field]]));
}

function diagnosticRow(input: unknown): input is { readonly __tarstateDiagnostic: TarstateDiagnostic } {
  return isRecord(input) && '__tarstateDiagnostic' in input;
}

function isPromiseLike(input: unknown): input is PromiseLike<unknown> {
  return isRecord(input) && typeof input.then === 'function';
}

function isIterable(input: unknown): input is Iterable<unknown> {
  return typeof input === 'object' &&
    input !== null &&
    typeof (input as { readonly [Symbol.iterator]?: unknown })[Symbol.iterator] === 'function';
}

function isDbInput(input: unknown): input is Db {
  return typeof input === 'object' && input !== null && 'data' in input && 'env' in input;
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === 'object' && input !== null && !Array.isArray(input);
}
