import type { AttachmentProjection } from './attachment/model.js';
import type { DatabaseAttachment, DatasetMember, DatasetSnapshot } from './database-model.js';
import type { Issue } from './issues.js';
import type { AvailableQueryAttachment } from './observer-maintenance-contracts.js';
import type { SourceSnapshot } from './source-state.js';

export type CapturedMember<Projection> = {
  readonly member: DatasetMember;
  readonly attachment?: DatabaseAttachment<unknown, Projection>;
  readonly snapshot?: SourceSnapshot<unknown>;
  readonly projection?: AttachmentProjection<Projection>;
  readonly authorized: boolean;
  readonly sourceMismatch?: boolean;
  readonly captureIssues?: readonly Issue[];
};

export type EvaluationSnapshot<Projection> = {
  readonly identity: object;
  readonly dataset: DatasetSnapshot;
  readonly members: readonly CapturedMember<Projection>[];
  readonly available: readonly AvailableQueryAttachment<Projection>[];
};

/**
 * Pure capture assembly. The caller performs authority, snapshot, and
 * projection effects; this function only reuses and freezes their evidence.
 */
export const assembleEvaluationSnapshot = <Projection>(input: {
  readonly dataset: DatasetSnapshot;
  readonly candidates: readonly CapturedMember<Projection>[];
  readonly previous?: EvaluationSnapshot<Projection>;
}): EvaluationSnapshot<Projection> => {
  const previousMembers = input.previous?.members;
  const membersRemainAligned = previousMembers?.length === input.candidates.length
    && input.candidates.every((candidate, index) => previousMembers[index]?.member.attachmentId === candidate.member.attachmentId);
  const previousMembersById = membersRemainAligned || previousMembers === undefined
    ? undefined
    : new Map(previousMembers.map((candidate) => [candidate.member.attachmentId, candidate]));
  const members = Object.freeze(input.candidates.map((candidate, index) => {
    const previous = membersRemainAligned ? previousMembers?.[index] : previousMembersById?.get(candidate.member.attachmentId);
    return previous !== undefined && sameCapturedMember(previous, candidate)
      ? previous
      : Object.freeze(candidate);
  }));
  const previousAvailable = input.previous?.available;
  let previousAvailableIndex = 0;
  let previousAvailableById: ReadonlyMap<string, AvailableQueryAttachment<Projection>> | undefined;
  const available: AvailableQueryAttachment<Projection>[] = [];
  for (const candidate of members) {
    if (candidate.attachment === undefined
      || candidate.snapshot === undefined
      || candidate.projection?.state !== 'ready') {
      continue;
    }
    let previous = previousAvailable?.[previousAvailableIndex];
    if (previous?.member.attachmentId === candidate.member.attachmentId) previousAvailableIndex += 1;
    else {
      previousAvailableById ??= new Map((previousAvailable ?? []).map((available) => [available.member.attachmentId, available]));
      previous = previousAvailableById.get(candidate.member.attachmentId);
    }
    if (previous?.member === candidate.member
      && previous.attachment === candidate.attachment
      && previous.snapshot === candidate.snapshot
      && previous.projection === candidate.projection.value) {
      available.push(previous);
      continue;
    }
    available.push(Object.freeze({
      member: candidate.member,
      attachment: candidate.attachment,
      snapshot: candidate.snapshot,
      projection: candidate.projection.value
    }));
  }
  Object.freeze(available);
  return Object.freeze({
    identity: Object.freeze({}),
    dataset: input.dataset,
    members,
    available
  });
};

const sameCapturedMember = <Projection>(
  left: CapturedMember<Projection>,
  right: CapturedMember<Projection>
): boolean => left.member === right.member
  && left.attachment === right.attachment
  && left.snapshot === right.snapshot
  && left.projection === right.projection
  && left.authorized === right.authorized
  && left.sourceMismatch === right.sourceMismatch
  && left.captureIssues === right.captureIssues;
