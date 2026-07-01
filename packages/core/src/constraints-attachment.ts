import type { ConstraintData, ConstraintSet } from './constraints.js';

declare const constrainedDb: unique symbol;

export type ConstrainedDb = {
  readonly [constrainedDb]: true;
};

export type ConstraintAttachmentInput = ConstraintData | ConstraintSet | readonly ConstraintData[];

export type ConstraintAttachment = {
  readonly kind: 'constraintAttachment';
  readonly constraints: readonly ConstraintData[];
};

const constrainedDbs = new WeakSet<object>();
const constraintAttachments = new WeakMap<object, readonly ConstraintAttachment[]>();

export function attachConstraints<Db extends object>(
  db: Db,
  input: ConstraintAttachmentInput
): Db & ConstrainedDb {
  const nextAttachment: ConstraintAttachment = {
    kind: 'constraintAttachment',
    constraints: constraintDataList(input)
  };
  constrainedDbs.add(db);
  constraintAttachments.set(db, [...constraintAttachmentsFor(db), nextAttachment]);
  return db as Db & ConstrainedDb;
}

export function detachConstraints<Db extends object>(db: Db): Db {
  constrainedDbs.delete(db);
  constraintAttachments.delete(db);
  return db;
}

export function hasAttachedConstraints(input: unknown): input is ConstrainedDb {
  return isObject(input) && constrainedDbs.has(input);
}

export function constraintAttachmentsFor(input: unknown): readonly ConstraintAttachment[] {
  return isObject(input) ? constraintAttachments.get(input) ?? [] : [];
}

export function attachedConstraintsFor(input: unknown): readonly ConstraintData[] {
  return constraintAttachmentsFor(input).flatMap((attachment) => attachment.constraints);
}

export function transferConstraintAttachments(previous: object, next: object): void {
  const attachments = constraintAttachments.get(previous);
  if (attachments === undefined) {
    return;
  }
  constrainedDbs.add(next);
  constraintAttachments.set(next, attachments);
}

export function clearConstraintAttachments(input: object): void {
  constrainedDbs.delete(input);
  constraintAttachments.delete(input);
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
  return isRecord(input) && input.kind === 'constraint';
}

function isConstraintSet(input: unknown): input is ConstraintSet {
  return isRecord(input) && input.kind === 'constraintSet' && Array.isArray(input.constraints);
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === 'object' && input !== null && !Array.isArray(input);
}

function isObject(input: unknown): input is object {
  return typeof input === 'object' && input !== null;
}
