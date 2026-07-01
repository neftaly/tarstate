import type { ConstraintData, ConstraintSet } from './constraints.js';

declare const constrainedDb: unique symbol;

export type ConstrainedDb = {
  readonly [constrainedDb]?: true;
};

export type ConstraintAttachmentInput = ConstraintData | ConstraintSet | readonly ConstraintData[];

export type ConstraintAttachment = {
  readonly kind: 'constraintAttachment';
  readonly constraints: readonly ConstraintData[];
};

export function attachConstraints<Db extends object>(
  db: Db,
  _input: ConstraintAttachmentInput
): Db & ConstrainedDb {
  return db as Db & ConstrainedDb;
}

export function detachConstraints<Db extends object>(db: Db): Db {
  return db;
}

export function hasAttachedConstraints(_input: unknown): _input is ConstrainedDb {
  return false;
}

export function constraintAttachmentsFor(_input: unknown): readonly ConstraintAttachment[] {
  return [];
}

export function attachedConstraintsFor(_input: unknown): readonly ConstraintData[] {
  return [];
}

export function transferConstraintAttachments(_previous: object, _next: object): void {}

export function clearConstraintAttachments(_input: object): void {}

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
