import type { TarstateDiagnostic } from './diagnostics.js';
import type { EvaluateOptions } from './evaluate.js';
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
  source: RelationSource,
  input: ConstraintValidationInput,
  _options: ConstraintValidationOptions = {}
): Promise<ConstraintValidationResult> {
  const constraints = constraintDataList(input);
  const diagnostics: TarstateDiagnostic[] = [];

  for (const constraint of constraints) {
    diagnostics.push(...await validateConstraint(source, constraint));
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

async function validateConstraint(
  source: RelationSource,
  constraint: ConstraintData
): Promise<readonly TarstateDiagnostic[]> {
  switch (constraint.op) {
    case 'req':
      return 'relation' in constraint
        ? validateRequired(await rowsFor(source, constraint.relation), constraint.relation.name, constraint.field)
        : [];
    case 'unique':
      return 'relation' in constraint
        ? validateUnique(await rowsFor(source, constraint.relation), constraint.relation.name, constraint.fields)
        : [];
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
        : [];
    case 'check':
      return [];
  }
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
