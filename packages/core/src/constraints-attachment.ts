import type { ConstraintData, ConstraintSet } from './constraints.js';

declare const constrainedDb: unique symbol;

/** Object marker for DB/source values with attached constraints. */
export type ConstrainedDb = {
  readonly [constrainedDb]?: true;
};

export type ConstraintAttachmentInput = ConstraintData | ConstraintSet | readonly ConstraintData[];

export type ConstraintAttachment = {
  readonly kind: 'constraintAttachment';
  readonly constraints: readonly ConstraintData[];
};

const constraintAttachmentsByTarget = new WeakMap<object, readonly ConstraintAttachment[]>();

/** Attach constraints to a DB/source object for lifecycle propagation and transaction enforcement. */
export function attachConstraints<Db extends object>(
  db: Db,
  input: ConstraintAttachmentInput
): Db & ConstrainedDb {
  const constraints = constraintDataList(input);

  if (constraints.length === 0) {
    return db as Db & ConstrainedDb;
  }

  constraintAttachmentsByTarget.set(db, [
    ...constraintAttachmentsFor(db),
    {
      kind: 'constraintAttachment',
      constraints
    }
  ]);

  return db as Db & ConstrainedDb;
}

/** Remove attached constraints from a DB/source object. */
export function detachConstraints<Db extends object>(db: Db): Db {
  clearConstraintAttachments(db);
  return db;
}

/** Check whether a DB/source object has constraint attachments. */
export function hasAttachedConstraints(input: unknown): input is ConstrainedDb {
  return typeof input === 'object' && input !== null && constraintAttachmentsByTarget.has(input);
}

/** Read constraint attachment metadata from a DB/source object. */
export function constraintAttachmentsFor(input: unknown): readonly ConstraintAttachment[] {
  return typeof input === 'object' && input !== null
    ? constraintAttachmentsByTarget.get(input) ?? []
    : [];
}

/** Read the flattened constraints attached to a DB/source object. */
export function attachedConstraintsFor(input: unknown): readonly ConstraintData[] {
  return constraintAttachmentsFor(input).flatMap((attachment) => attachment.constraints);
}

/** Carry constraint attachments from one lifecycle object to another. */
export function transferConstraintAttachments(previous: object, next: object): void {
  if (previous === next) {
    return;
  }

  const previousAttachments = constraintAttachmentsFor(previous);

  if (previousAttachments.length === 0) {
    return;
  }

  const nextAttachments = constraintAttachmentsFor(next);
  const seen = new Set(nextAttachments);
  const carried = previousAttachments.filter((attachment) => !seen.has(attachment));

  if (carried.length > 0) {
    constraintAttachmentsByTarget.set(next, [...nextAttachments, ...carried]);
  }
}

export function clearConstraintAttachments(input: object): void {
  constraintAttachmentsByTarget.delete(input);
}

export function isConstraintAttachmentInput(input: unknown): input is ConstraintAttachmentInput {
  return isConstraintData(input) ||
    isConstraintSet(input) ||
    (Array.isArray(input) && input.every(isConstraintData));
}

export function constraintDataList(input: ConstraintAttachmentInput): readonly ConstraintData[] {
  if (isConstraintData(input)) {
    return [input];
  }

  return isConstraintSet(input) ? input.constraints : input;
}

function isConstraintData(input: unknown): input is ConstraintData {
  const candidate = input as { readonly kind?: unknown; readonly op?: unknown };
  return isRecord(input) &&
    candidate.kind === 'constraint' &&
    (candidate.op === 'check' || candidate.op === 'fk' || candidate.op === 'req' || candidate.op === 'unique');
}

function isConstraintSet(input: unknown): input is ConstraintSet {
  const candidate = input as { readonly kind?: unknown; readonly constraints?: unknown };
  return isRecord(input) &&
    candidate.kind === 'constraintSet' &&
    Array.isArray(candidate.constraints) &&
    candidate.constraints.every(isConstraintData);
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === 'object' && input !== null && !Array.isArray(input);
}
