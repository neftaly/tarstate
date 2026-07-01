import type { Db } from './db.js';
import type { TarstateDiagnostic } from './diagnostics.js';
import { evaluate, type EvaluateOptions } from './evaluate.js';
import {
  queryKey,
  type ExprData,
  type OptionalProjection,
  type PredicateData,
  type ProjectionData,
  type Query,
  type QueryData,
  type SortData
} from './query.js';
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

  for (const constraint of constraints) {
    diagnostics.push(...await validateConstraint(relationSource, constraint, options));
  }

  return { kind: 'constraintValidation', valid: diagnostics.length === 0, diagnostics };
}

export async function validateAttachedConstraints(
  input: RelationSourceInput,
  options: ConstraintValidationOptions = {}
): Promise<ConstraintValidationResult> {
  const constraints = attachedConstraintsFor(input);
  return validateConstraints(asRelationSource(input), constraints, options);
}

export function validateAttachedConstraintsSync(db: Db): ConstraintValidationResult {
  return validateConstraintsSync(db, attachedConstraintsFor(db));
}

export function validateConstraintsSync(
  db: Db,
  input: ConstraintValidationInput
): ConstraintValidationResult {
  const constraints = constraintDataList(input);
  const diagnostics = constraints.flatMap((constraint) => validateConstraintSync(db, constraint));
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
        : validateCheck(await queryRowsFor(source, constraint.query, options), constraint.predicate, queryRelationName(constraint.query));
  }
}

function validateConstraintSync(db: Db, constraint: ConstraintData): readonly TarstateDiagnostic[] {
  const cascadeDiagnostics = validateCascadeSupport(constraint);
  if (cascadeDiagnostics.length > 0) {
    return cascadeDiagnostics;
  }

  switch (constraint.op) {
    case 'req':
      return 'relation' in constraint
        ? validateRequired(db.data[constraint.relation.name] ?? [], constraint.relation.name, constraint.field)
        : validateRequired(queryRowsForSync(db, constraint.query), queryRelationName(constraint.query), constraint.field);
    case 'unique':
      return 'relation' in constraint
        ? validateUnique(db.data[constraint.relation.name] ?? [], constraint.relation.name, constraint.fields)
        : validateUnique(queryRowsForSync(db, constraint.query), queryRelationName(constraint.query), constraint.fields);
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
        : validateQueryForeignKeySync(db, constraint);
    case 'check':
      return constraint.query === undefined
        ? []
        : validateCheck(queryRowsForSync(db, constraint.query), constraint.predicate, queryRelationName(constraint.query));
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
  constraint: Extract<ConstraintData, { readonly op: 'fk' }>
): readonly TarstateDiagnostic[] {
  if (!('query' in constraint)) {
    return [];
  }

  const sourceRows = queryRowsForSync(db, constraint.query);
  const targetRows = 'data' in constraint.target
    ? queryRowsForSync(db, constraint.target)
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
  relation = 'query'
): readonly TarstateDiagnostic[] {
  return rows.flatMap((row) => {
    if (diagnosticRow(row)) return [row.__tarstateDiagnostic];
    return evaluatePredicate(row, predicate)
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

function evaluatePredicate(row: unknown, predicate: PredicateData): boolean {
  switch (predicate.op) {
    case 'eq':
      return Object.is(exprValue(row, predicate.left), exprValue(row, predicate.right));
    case 'neq':
      return !Object.is(exprValue(row, predicate.left), exprValue(row, predicate.right));
    case 'lt':
      return compareValues(exprValue(row, predicate.left), exprValue(row, predicate.right)) < 0;
    case 'lte':
      return compareValues(exprValue(row, predicate.left), exprValue(row, predicate.right)) <= 0;
    case 'gt':
      return compareValues(exprValue(row, predicate.left), exprValue(row, predicate.right)) > 0;
    case 'gte':
      return compareValues(exprValue(row, predicate.left), exprValue(row, predicate.right)) >= 0;
    case 'and':
      return predicate.predicates.every((item) => evaluatePredicate(row, item));
    case 'or':
      return predicate.predicates.some((item) => evaluatePredicate(row, item));
    case 'not':
      return !evaluatePredicate(row, predicate.predicate);
  }
}

function exprValue(row: unknown, expr: ExprData): unknown {
  switch (expr.op) {
    case 'value':
      return expr.value;
    case 'field': {
      const aliased = isRecord(row) ? row[expr.alias] : undefined;
      return isRecord(aliased) ? aliased[expr.field] : isRecord(row) ? row[expr.field] : undefined;
    }
    case 'tuple':
      return expr.items.map((item) => exprValue(row, item));
    default:
      return undefined;
  }
}

function compareValues(left: unknown, right: unknown): number {
  if (left === right) return 0;
  if (left === undefined || left === null) return -1;
  if (right === undefined || right === null) return 1;
  return left < right ? -1 : 1;
}

function valuesFor(row: unknown, fields: readonly string[]): readonly unknown[] {
  return fields.map((field) => isRecord(row) ? row[field] : undefined);
}

function queryRowsForSync<Row>(db: Db, query: Query<Row>): readonly Row[] {
  return evaluateQueryDataSync(db, query.data, query) as readonly Row[];
}

function evaluateQueryDataSync(db: Db, data: QueryData, query: Query): readonly unknown[] {
  switch (data.op) {
    case 'from': {
      const relation = query.relations[data.relation];
      return relation === undefined
        ? []
        : (db.data[relation.name] ?? []).filter(isRecord).map((row) => ({ [data.alias]: row }));
    }
    case 'lookup': {
      const relation = query.relations[data.relation];
      if (relation === undefined) return [];
      const value = exprValue({}, data.value);
      return (db.data[relation.name] ?? [])
        .filter((row) => isRecord(row) && Object.is(row[data.field], value))
        .map((row) => ({ [data.alias]: row }));
    }
    case 'constRows':
      return data.rows;
    case 'where': {
      const rows = evaluateQueryDataSync(db, data.input, query);
      return hasDiagnosticRows(rows) ? rows : rows.filter((row) => evaluatePredicate(row, data.predicate));
    }
    case 'hash':
    case 'btree':
    case 'keyBy':
      return evaluateQueryDataSync(db, data.input, query);
    case 'select': {
      const rows = evaluateQueryDataSync(db, data.input, query);
      return hasDiagnosticRows(rows) ? rows : rows.map((row) => projectRow(row, data.projection));
    }
    case 'extend': {
      const rows = evaluateQueryDataSync(db, data.input, query);
      return hasDiagnosticRows(rows) ? rows : rows.map((row) => ({ ...asRecord(row), ...projectRow(row, data.projection) }));
    }
    case 'without': {
      const rows = evaluateQueryDataSync(db, data.input, query);
      return hasDiagnosticRows(rows) ? rows : rows.map((row) => {
        const output = { ...asRecord(row) };
        for (const field of data.fields) {
          delete output[field];
        }
        return output;
      });
    }
    case 'sort': {
      const rows = evaluateQueryDataSync(db, data.input, query);
      return hasDiagnosticRows(rows) ? rows : sortRows(rows, data.order);
    }
    case 'limit': {
      const rows = evaluateQueryDataSync(db, data.input, query);
      return hasDiagnosticRows(rows) ? rows : rows.slice(data.offset ?? 0, (data.offset ?? 0) + data.count);
    }
    case 'sortLimit': {
      const rows = evaluateQueryDataSync(db, data.input, query);
      return hasDiagnosticRows(rows) ? rows : sortRows(rows, data.order).slice(0, data.count);
    }
    case 'rename': {
      const rows = evaluateQueryDataSync(db, data.input, query);
      return hasDiagnosticRows(rows) ? rows : rows.map((row) => renameRow(row, data.fields));
    }
    case 'qualify': {
      const rows = evaluateQueryDataSync(db, data.input, query);
      return hasDiagnosticRows(rows) ? rows : rows.map((row) => ({ [data.alias]: row }));
    }
    default:
      return [diagnosticRowFor({
        code: 'constraint_query_sync_unsupported',
        message: `query op ${(data as { readonly op: string }).op} cannot be validated synchronously`,
        relation: queryRelationName(query),
        detail: { op: (data as { readonly op: string }).op }
      })];
  }
}

function projectRow(row: unknown, projection: ProjectionData): Record<string, unknown> {
  return Object.fromEntries(Object.entries(projection).map(([field, item]) => [
    field,
    exprValue(row, projectionExpr(item))
  ]));
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

function sortRows(rows: readonly unknown[], order: readonly SortData[]): readonly unknown[] {
  return [...rows].sort((left, right) => {
    for (const item of order) {
      const compared = compareValues(exprValue(left, item.expr), exprValue(right, item.expr));
      if (compared !== 0) {
        return item.direction === 'desc' ? -compared : compared;
      }
    }
    return 0;
  });
}

function stableKeyValue(values: readonly unknown[]): string {
  return stableKey(values.length === 1 ? values[0] : values);
}

function displayKey(values: readonly unknown[]): string {
  return values.length === 1 ? String(values[0]) : JSON.stringify(values);
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

function diagnosticRow(input: unknown): input is { readonly __tarstateDiagnostic: TarstateDiagnostic } {
  return isRecord(input) && '__tarstateDiagnostic' in input;
}

function hasDiagnosticRows(rows: readonly unknown[]): boolean {
  return rows.some(diagnosticRow);
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === 'object' && input !== null;
}
