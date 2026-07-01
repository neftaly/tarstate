import {
  DbTransactionError,
  tryTransact,
  type Db,
  type DbTransactionResult
} from './db.js';
import type { WritePatch } from './write.js';
import type {
  ConstraintValidationInput,
  ConstraintValidationOptions
} from './constraints-validation.js';
import { validateConstraints } from './constraints-validation.js';
import { attachedConstraintsFor, isConstraintAttachmentInput } from './constraints-attachment.js';

export class DbConstraintTransactionError extends DbTransactionError {
  constructor(result: DbTransactionResult) {
    super(result);
    this.name = 'DbConstraintTransactionError';
  }
}

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
  const result = tryTransact(db, patches);
  if (!result.committed) {
    return result;
  }

  const explicitConstraints = constraintsOrOptions !== undefined && isConstraintAttachmentInput(constraintsOrOptions)
    ? constraintsOrOptions
    : attachedConstraintsFor(db);
  const validationOptions = constraintsOrOptions !== undefined && !isConstraintAttachmentInput(constraintsOrOptions)
    ? constraintsOrOptions
    : options;
  const validation = await validateConstraints(result.db, explicitConstraints, validationOptions);

  return validation.valid
    ? result
    : {
        ...result,
        db,
        committed: false,
        diagnostics: [...result.diagnostics, ...validation.diagnostics]
      };
}

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
  const result = constraintsOrOptions === undefined || !isConstraintAttachmentInput(constraintsOrOptions)
    ? await tryTransactConstrained(db, patches, constraintsOrOptions)
    : await tryTransactConstrained(db, patches, constraintsOrOptions, options);

  if (result.diagnostics.length > 0) {
    throw new DbConstraintTransactionError(result);
  }

  return result.db;
}
