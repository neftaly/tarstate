import type { Db } from './db.js';
import type { TarstateDiagnostic } from './diagnostics.js';
import { evaluate, type EvaluateOptions } from './evaluate.js';
import type { ExprData, PredicateData, Query } from './query.js';
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
  switch (constraint.op) {
    case 'req':
      return 'relation' in constraint
        ? validateRequired(await rowsFor(source, constraint.relation), constraint.relation.name, constraint.field)
        : validateRequired(await queryRowsFor(source, constraint.query, options), 'query', constraint.field);
    case 'unique':
      return 'relation' in constraint
        ? validateUnique(await rowsFor(source, constraint.relation), constraint.relation.name, constraint.fields)
        : validateUnique(await queryRowsFor(source, constraint.query, options), 'query', constraint.fields);
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
        : validateCheck(await queryRowsFor(source, constraint.query, options), constraint.predicate);
  }
}

function validateConstraintSync(db: Db, constraint: ConstraintData): readonly TarstateDiagnostic[] {
  switch (constraint.op) {
    case 'req':
      return 'relation' in constraint
        ? validateRequired(db.data[constraint.relation.name] ?? [], constraint.relation.name, constraint.field)
        : [];
    case 'unique':
      return 'relation' in constraint
        ? validateUnique(db.data[constraint.relation.name] ?? [], constraint.relation.name, constraint.fields)
        : [];
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
        : [];
    case 'check':
      return [];
  }
}

async function queryRowsFor<Row>(
  source: RelationSource,
  query: Query<Row>,
  options: ConstraintValidationOptions
): Promise<readonly Row[]> {
  return (await evaluate(source, query, options)).rows;
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
  return validateForeignKey(sourceRows, targetRows, 'query', constraint.fields, constraint.targetFields, constraint.optional);
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
      ? [constraintDiagnostic('constraint_req', `required field ${field} is missing`, relation, field, rowKey(row))]
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
      diagnostics.push(constraintDiagnostic(
        'constraint_unique',
        `unique constraint failed for ${fields.join(',')}`,
        relation,
        fields.join(','),
        displayKey(values)
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
        optional && fields.length === 1 ? rowKey(row) : displayKey(values)
      ));
    }
  }

  return diagnostics;
}

function validateCheck(
  rows: readonly unknown[],
  predicate: PredicateData
): readonly TarstateDiagnostic[] {
  return rows.flatMap((row) => evaluatePredicate(row, predicate)
    ? []
    : [constraintDiagnostic('constraint_check', 'check constraint failed', 'query', '', rowKey(row))]);
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
  key: string | undefined
): TarstateDiagnostic {
  return {
    code,
    message,
    relation,
    field,
    ...(key === undefined ? {} : { key })
  } as TarstateDiagnostic;
}

function diagnosticRow(input: unknown): input is { readonly __tarstateDiagnostic: TarstateDiagnostic } {
  return isRecord(input) && '__tarstateDiagnostic' in input;
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === 'object' && input !== null;
}
