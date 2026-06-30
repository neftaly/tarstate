import {
  DbTransactionError,
  dbSource,
  tryTransact,
  type Db,
  type DbTransactionResult
} from './db.js';
import type { WritePatch } from './write.js';
import {
  attachedConstraintsFor,
  constraintDataList,
  isConstraintAttachmentInput,
  transferConstraintAttachments
} from './constraints-attachment.js';
import {
  validateConstraints,
  type ConstraintValidationInput,
  type ConstraintValidationOptions
} from './constraints-validation.js';
import type { ConstraintData } from './constraints.js';

/** Error thrown by `transactConstrained` when writes or constraints produce diagnostics. */
export class DbConstraintTransactionError extends DbTransactionError {
  constructor(result: DbTransactionResult) {
    super(result);
    this.name = 'DbConstraintTransactionError';
  }
}

/** Apply object-backed write patches, validate constraints, and commit only when both pass. */
export function tryTransactConstrained(
  db: Db,
  patches: Iterable<WritePatch>,
  constraints: ConstraintValidationInput,
  options?: ConstraintValidationOptions
): Promise<DbTransactionResult>;
export function tryTransactConstrained(
  db: Db,
  patches: Iterable<WritePatch>,
  options?: ConstraintValidationOptions
): Promise<DbTransactionResult>;
export async function tryTransactConstrained(
  db: Db,
  patches: Iterable<WritePatch>,
  constraintsOrOptions?: ConstraintValidationInput | ConstraintValidationOptions,
  options: ConstraintValidationOptions = {}
): Promise<DbTransactionResult> {
  const resolved = resolveConstraints(db, constraintsOrOptions, options);
  const result = tryTransact(db, patches);

  if (!result.committed) {
    return result;
  }

  if (resolved.constraints.length === 0) {
    transferConstraintAttachments(db, result.db);
    return result;
  }

  const validation = await validateConstraints(dbSource(result.db), resolved.constraints, resolved.options);

  if (validation.valid) {
    transferConstraintAttachments(db, result.db);
    return result;
  }

  return {
    db,
    patches: result.patches,
    applied: 0,
    committed: false,
    deltas: [],
    diagnostics: validation.diagnostics
  };
}

/**
 * Apply object-backed write patches with constraint validation and return the next `Db`.
 *
 * @throws DbConstraintTransactionError when writes or constraints produce diagnostics.
 */
export function transactConstrained(
  db: Db,
  patches: Iterable<WritePatch>,
  constraints: ConstraintValidationInput,
  options?: ConstraintValidationOptions
): Promise<Db>;
export function transactConstrained(
  db: Db,
  patches: Iterable<WritePatch>,
  options?: ConstraintValidationOptions
): Promise<Db>;
export async function transactConstrained(
  db: Db,
  patches: Iterable<WritePatch>,
  constraintsOrOptions?: ConstraintValidationInput | ConstraintValidationOptions,
  options?: ConstraintValidationOptions
): Promise<Db> {
  const result = isConstraintAttachmentInput(constraintsOrOptions)
    ? await tryTransactConstrained(db, patches, constraintsOrOptions, options)
    : await tryTransactConstrained(db, patches, constraintsOrOptions);

  if (result.diagnostics.length > 0) {
    throw new DbConstraintTransactionError(result);
  }

  return result.db;
}

function resolveConstraints(
  db: Db,
  constraintsOrOptions: ConstraintValidationInput | ConstraintValidationOptions | undefined,
  options: ConstraintValidationOptions
): { readonly constraints: readonly ConstraintData[]; readonly options: ConstraintValidationOptions } {
  if (isConstraintAttachmentInput(constraintsOrOptions)) {
    return {
      constraints: constraintDataList(constraintsOrOptions),
      options
    };
  }

  return {
    constraints: attachedConstraintsFor(db),
    options: constraintsOrOptions ?? {}
  };
}
