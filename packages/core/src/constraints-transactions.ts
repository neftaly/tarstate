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
  _constraintsOrOptions?: ConstraintValidationInput | ConstraintValidationOptions,
  _options: ConstraintValidationOptions = {}
): Promise<DbTransactionResult> {
  return tryTransact(db, patches);
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
  const result = await tryTransactConstrained(db, patches, constraintsOrOptions as ConstraintValidationInput, options);

  if (result.diagnostics.length > 0) {
    throw new DbConstraintTransactionError(result);
  }

  return result.db;
}
