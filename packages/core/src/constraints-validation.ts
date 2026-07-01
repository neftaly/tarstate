import type { TarstateDiagnostic } from './diagnostics.js';
import { evaluate, type EvaluateOptions } from './evaluate.js';
import { not as notPredicate, where } from './query.js';
import type { RelationRef } from './schema.js';
import { asRelationSource, type RelationSourceInput } from './source-input.js';
import type { RelationSource } from './source.js';
import {
  attachedConstraintsFor,
  constraintDataList
} from './constraints-attachment.js';
import type {
  CheckConstraintData,
  ConstraintData,
  ConstraintSet,
  ForeignKeyConstraintData,
  QueryForeignKeyConstraintData,
  QueryRequiredConstraintData,
  QueryUniqueConstraintData,
  RequiredConstraintData,
  UniqueConstraintData
} from './constraints.js';

export type ConstraintValidationInput = ConstraintSet | readonly ConstraintData[];

export type ConstraintValidationResult = {
  readonly kind: 'constraintValidation';
  readonly valid: boolean;
  readonly diagnostics: readonly TarstateDiagnostic[];
};

export type ConstraintValidationOptions = EvaluateOptions;

type ConstraintValidationContext = {
  readonly source: RelationSource;
  readonly diagnostics: TarstateDiagnostic[];
  readonly rowCache: Map<string, readonly unknown[]>;
};

/** Validate declared constraints by scanning a read-only relation source. */
export async function validateConstraints(
  source: RelationSource,
  input: ConstraintValidationInput,
  options: ConstraintValidationOptions = {}
): Promise<ConstraintValidationResult> {
  const diagnostics: TarstateDiagnostic[] = [];
  const context: ConstraintValidationContext = {
    source,
    diagnostics,
    rowCache: new Map()
  };

  for (const constraint of constraintDataList(input)) {
    switch (constraint.op) {
      case 'req':
        await validateRequired(context, constraint);
        break;
      case 'unique':
        await validateUnique(context, constraint);
        break;
      case 'fk':
        await validateForeignKey(context, constraint);
        break;
      case 'check':
        await validateCheck(context, constraint, options);
        break;
    }
  }

  return {
    kind: 'constraintValidation',
    valid: diagnostics.length === 0,
    diagnostics
  };
}

/** Validate constraints attached to a DB/source object. */
export async function validateAttachedConstraints(
  input: RelationSourceInput,
  options: ConstraintValidationOptions = {}
): Promise<ConstraintValidationResult> {
  const constraints = attachedConstraintsFor(input);

  if (constraints.length === 0) {
    return {
      kind: 'constraintValidation',
      valid: true,
      diagnostics: []
    };
  }

  return validateConstraints(asRelationSource(input), constraints, options);
}

async function validateRequired(
  context: ConstraintValidationContext,
  constraint: RequiredConstraintData | QueryRequiredConstraintData
): Promise<void> {
  if (!hasRelation(constraint)) {
    context.diagnostics.push(unsupportedQueryConstraintDiagnostic(constraint));
    return;
  }

  const rows = await readRows(context, constraint.relation);

  for (const row of rows) {
    const record = rowRecord(row, constraint.relation, context.diagnostics);

    if (record === undefined) {
      continue;
    }

    if (!Object.hasOwn(record, constraint.field) || record[constraint.field] === undefined) {
      context.diagnostics.push({
        code: 'invalid_row',
        message: constraint.message ?? `required field ${constraint.field} is missing in relation ${constraint.relation.name}`,
        relation: constraint.relation.name,
        field: constraint.field,
        detail: constraintDetail(constraint)
      });
    }
  }
}

async function validateUnique(
  context: ConstraintValidationContext,
  constraint: UniqueConstraintData | QueryUniqueConstraintData
): Promise<void> {
  if (!hasRelation(constraint)) {
    context.diagnostics.push(unsupportedQueryConstraintDiagnostic(constraint));
    return;
  }

  const rows = await readRows(context, constraint.relation);
  const seen = new Set<string>();

  for (const row of rows) {
    const record = rowRecord(row, constraint.relation, context.diagnostics);

    if (record === undefined) {
      continue;
    }

    const values = fieldValues(record, constraint.fields);
    const key = keyString(values);

    if (seen.has(key)) {
      context.diagnostics.push({
        code: 'duplicate_key',
        message: constraint.message ?? `duplicate unique key ${key} in relation ${constraint.relation.name}`,
        relation: constraint.relation.name,
        key,
        ...singleField(constraint.fields),
        detail: { ...constraintDetail(constraint), fields: constraint.fields, values }
      });
      continue;
    }

    seen.add(key);
  }
}

async function validateForeignKey(
  context: ConstraintValidationContext,
  constraint: ForeignKeyConstraintData | QueryForeignKeyConstraintData
): Promise<void> {
  if (!hasRelation(constraint) || !hasRelationTarget(constraint)) {
    context.diagnostics.push(unsupportedQueryConstraintDiagnostic(constraint));
    return;
  }

  if (constraint.fields.length !== constraint.targetFields.length) {
    context.diagnostics.push({
      code: 'invalid_row',
      message:
        constraint.message ??
        `foreign key field count mismatch from ${constraint.relation.name} to ${constraint.target.name}`,
      relation: constraint.relation.name,
      detail: constraintDetail(constraint)
    });
    return;
  }

  const targetRows = await readRows(context, constraint.target);
  const targetKeys = new Set<string>();

  for (const row of targetRows) {
    const record = rowRecord(row, constraint.target, context.diagnostics);

    if (record !== undefined) {
      targetKeys.add(keyString(fieldValues(record, constraint.targetFields)));
    }
  }

  const rows = await readRows(context, constraint.relation);

  for (const row of rows) {
    const record = rowRecord(row, constraint.relation, context.diagnostics);

    if (record === undefined) {
      continue;
    }

    const values = fieldValues(record, constraint.fields);

    if (constraint.optional && values.some((value) => value === null || value === undefined)) {
      continue;
    }

    const key = keyString(values);

    if (!targetKeys.has(key)) {
      context.diagnostics.push({
        code: 'missing_ref',
        message:
          constraint.message ??
          `missing reference ${key} from ${constraint.relation.name} to ${constraint.target.name}`,
        relation: constraint.relation.name,
        key,
        ...singleField(constraint.fields),
        detail: {
          ...constraintDetail(constraint),
          fields: constraint.fields,
          targetRelation: constraint.target.name,
          targetFields: constraint.targetFields,
          values
        }
      });
    }
  }
}

async function validateCheck(
  context: ConstraintValidationContext,
  constraint: CheckConstraintData,
  options: ConstraintValidationOptions
): Promise<void> {
  if (constraint.query === undefined) {
    context.diagnostics.push(unsupportedCheckDiagnostic(constraint));
    return;
  }

  const failingQuery = where(notPredicate(constraint.predicate))(constraint.query);
  const result = await evaluate(context.source, failingQuery, options);
  context.diagnostics.push(...result.diagnostics);

  for (const row of result.rows) {
    context.diagnostics.push({
      code: 'invalid_row',
      message: constraint.message ?? 'check constraint failed',
      detail: {
        ...constraintDetail(constraint),
        row
      }
    });
  }
}

async function readRows(context: ConstraintValidationContext, relationRef: RelationRef): Promise<readonly unknown[]> {
  const cachedRows = context.rowCache.get(relationRef.name);

  if (cachedRows !== undefined) {
    return cachedRows;
  }

  try {
    const rows = rowsArray(await context.source.rows(relationRef));
    context.rowCache.set(relationRef.name, rows);
    return rows;
  } catch (error) {
    context.diagnostics.push({
      code: 'source_error',
      message: `source rows failed for relation ${relationRef.name}`,
      relation: relationRef.name,
      detail: error
    });
    context.rowCache.set(relationRef.name, []);
    return [];
  }
}

function rowsArray(rows: Iterable<unknown>): readonly unknown[] {
  return Array.isArray(rows) ? rows : Array.from(rows);
}

function rowRecord(
  row: unknown,
  relationRef: RelationRef,
  diagnostics: TarstateDiagnostic[]
): Record<string, unknown> | undefined {
  if (isRecord(row)) {
    return row;
  }

  diagnostics.push({
    code: 'invalid_row',
    message: `row for relation ${relationRef.name} is not an object`,
    relation: relationRef.name,
    detail: row
  });
  return undefined;
}

function fieldValues(row: Record<string, unknown>, fields: readonly string[]): readonly unknown[] {
  return fields.map((field) => row[field]);
}

function keyString(values: readonly unknown[]): string {
  return JSON.stringify(values);
}

function singleField(fields: readonly string[]): Pick<TarstateDiagnostic, 'field'> {
  const [field] = fields;
  return fields.length === 1 && field !== undefined ? { field } : {};
}

function constraintDetail(constraint: ConstraintData): Record<string, unknown> {
  return {
    op: constraint.op,
    ...(constraint.name === undefined ? {} : { name: constraint.name })
  };
}

function unsupportedCheckDiagnostic(constraint: CheckConstraintData): TarstateDiagnostic {
  return {
    code: 'unsupported_lookup',
    message:
      constraint.message ??
      'check constraints cannot be validated until checks carry relation metadata or a relation-bound query',
    detail: {
      ...constraintDetail(constraint),
      predicate: constraint.predicate
    }
  };
}

function unsupportedQueryConstraintDiagnostic(
  constraint: QueryRequiredConstraintData | QueryUniqueConstraintData | QueryForeignKeyConstraintData
): TarstateDiagnostic {
  return {
    code: 'unsupported_lookup',
    message: `query-bound ${constraint.op} constraints are descriptor-only until query materialized constraint enforcement is implemented`,
    detail: {
      ...constraintDetail(constraint),
      queryBound: true
    }
  };
}

function hasRelation(constraint: unknown): constraint is { readonly relation: RelationRef } {
  return isRecord(constraint) && isRecord(constraint.relation) && constraint.relation.kind === 'relation';
}

function hasRelationTarget(constraint: unknown): constraint is { readonly target: RelationRef } {
  return isRecord(constraint) && isRecord(constraint.target) && constraint.target.kind === 'relation';
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === 'object' && input !== null && !Array.isArray(input);
}
