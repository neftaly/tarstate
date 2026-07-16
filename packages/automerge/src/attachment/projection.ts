import type * as Automerge from '@automerge/automerge';
import type {
  AttachmentTransactionRow,
  ReadyAttachmentPreparation
} from '@tarstate/core/attachment/adapter';
import type { Issue } from '@tarstate/core';
import type { RelationInput } from '@tarstate/core/query/model';
import {
  checkCurrentConstraints,
  type ConstraintCheck,
  type SourceConstraint
} from '@tarstate/core/schema';
import type {
  ProjectionResult,
  SourceBasis,
  SourceLifecycleState,
  SourceSnapshot,
  WritableLogicalState
} from '@tarstate/core/source';
import type { AutomergeMappedStorageBinding, AutomergeMappedStorageRow } from '../adapter/mapped-storage.js';
import { samePortableJson } from '../shared/portable-json.js';
import type { AutomergeAttachmentResult, AutomergeAttachmentSnapshot } from './model.js';

export type AutomergeAttachmentProjection = {
  readonly mapped: ProjectionResult<AutomergeMappedStorageRow>;
  readonly logicalState: WritableLogicalState;
  readonly constraints: ConstraintCheck;
  readonly issues: readonly Issue[];
};

export type AutomergeAttachmentProjector<T extends object> = {
  readonly project: (snapshot: SourceSnapshot<Automerge.Doc<T>>) => AutomergeAttachmentProjection;
};

/** Canonical pure logical projection shared by live rows and database mounting. */
export const createAutomergeAttachmentProjector = <T extends object>(input: {
  readonly binding: AutomergeMappedStorageBinding<T>;
  readonly constraints: readonly SourceConstraint<WritableLogicalState>[];
}): AutomergeAttachmentProjector<T> => {
  let previous: {
    readonly basis: SourceBasis;
    readonly mapped: ReturnType<typeof input.binding.project>;
    readonly projection: AutomergeAttachmentProjection;
  } | undefined;
  return Object.freeze({
    project: (snapshot) => {
      const mapped = input.binding.project(snapshot);
      if (previous?.mapped === mapped
        && (input.constraints.length === 0 || samePortableJson(previous.basis, snapshot.basis))) {
        return previous.projection;
      }
      const projection = deriveAttachmentProjection(mapped, input.constraints, snapshot.basis);
      previous = { basis: snapshot.basis, mapped, projection };
      return projection;
    }
  });
};

export const attachmentSnapshot = <T extends object>(
  sourceSnapshot: SourceSnapshot<Automerge.Doc<T>>,
  projector: AutomergeAttachmentProjector<T>,
  logicalRows: WeakMap<object, readonly AttachmentTransactionRow[]>
): AutomergeAttachmentSnapshot => {
  if (sourceSnapshot.state !== 'ready') {
    return unavailableAttachmentSnapshot(sourceSnapshot);
  }
  const projection = projector.project(sourceSnapshot);
  let rows = logicalRows.get(projection.mapped);
  if (rows === undefined) {
    rows = Object.freeze(projection.mapped.rows.map(({ relationId, fields }) => Object.freeze({ relationId, fields })));
    logicalRows.set(projection.mapped, rows);
  }
  const issues = Object.freeze([...sourceSnapshot.issues, ...projection.issues]);
  return Object.freeze({ state: 'open', current: Object.freeze({
    readiness: attachmentReadiness(
      sourceSnapshot.state,
      projection.mapped.completeness,
      projection.constraints.blockingIssues,
      issues
    ),
    rows,
    completeness: projection.mapped.completeness,
    freshness: sourceSnapshot.freshness,
    basis: sourceSnapshot.basis,
    sourceState: sourceSnapshot.state,
    issues
  }) });
};

export const databaseProjection = <T extends object>(input: {
  readonly projector: AutomergeAttachmentProjector<T>;
  readonly schemaView: { readonly id: string; readonly contentHash: `sha256:${string}` };
  readonly relationIds: readonly string[];
  readonly sourceId: string;
  readonly attachmentId: string;
}): ReadyAttachmentPreparation<Automerge.Doc<T>, readonly RelationInput[]>['project'] => {
  const values = new WeakMap<object, readonly RelationInput[]>();
  return (snapshot) => {
    if (snapshot.state !== 'ready') return { state: snapshot.state, issues: snapshot.issues };
    const projection = input.projector.project(snapshot);
    if (projection.constraints.blockingIssues.length > 0) {
      return { state: 'failed', issues: projection.issues };
    }
    let relations = values.get(projection.mapped);
    if (relations === undefined) {
      relations = relationInputs({ ...input, projection: projection.mapped });
      values.set(projection.mapped, relations);
    }
    return { state: 'ready', value: relations, issues: projection.issues };
  };
};

export const sameAttachmentSnapshot = (
  left: AutomergeAttachmentSnapshot,
  right: AutomergeAttachmentSnapshot
): boolean => left.state === 'open'
  && right.state === 'open'
  && left.current.rows === right.current.rows
  && left.current.readiness === right.current.readiness
  && left.current.completeness === right.current.completeness
  && left.current.freshness === right.current.freshness
  && left.current.sourceState === right.current.sourceState
  && samePortableJson(left.current.basis, right.current.basis)
  && samePortableJson(left.current.issues, right.current.issues);

const unavailableAttachmentSnapshot = <T>(
  snapshot: SourceSnapshot<T>
): AutomergeAttachmentSnapshot => Object.freeze({ state: 'open', current: Object.freeze({
  readiness: snapshot.state === 'loading' ? 'incomplete' : 'invalid',
  rows: Object.freeze([]),
  completeness: 'unknown',
  freshness: snapshot.freshness,
  basis: snapshot.basis,
  sourceState: snapshot.state,
  issues: snapshot.issues
}) });

const attachmentReadiness = (
  sourceState: SourceLifecycleState,
  completeness: 'exact' | 'unknown',
  blockingConstraintIssues: readonly Issue[],
  issues: readonly Issue[]
): AutomergeAttachmentResult['readiness'] => {
  if (sourceState !== 'ready' && sourceState !== 'loading') return 'invalid';
  if (blockingConstraintIssues.length > 0) return 'invalid';
  if (issues.some(({ severity }) => severity === 'error')) return 'invalid';
  return sourceState === 'ready' && completeness === 'exact' ? 'ready' : 'incomplete';
};

const relationInputs = (input: {
  readonly projection: ProjectionResult<AutomergeMappedStorageRow>;
  readonly schemaView: { readonly id: string; readonly contentHash: `sha256:${string}` };
  readonly relationIds: readonly string[];
  readonly sourceId: string;
  readonly attachmentId: string;
}): readonly RelationInput[] => {
  const rows = new Map(input.relationIds.map((relationId) => [relationId, [] as AutomergeMappedStorageRow[]]));
  for (const row of input.projection.rows) rows.get(row.relationId)?.push(row);
  return Object.freeze(input.relationIds.map((relationId) => {
    const relationRows = rows.get(relationId) ?? [];
    return Object.freeze({
      relation: Object.freeze({ schemaView: input.schemaView, relationId }),
      rows: Object.freeze(relationRows.map(({ fields }) => fields)),
      occurrenceIds: Object.freeze(relationRows.map(({ locator }) => locator.rowIncarnation)),
      completeness: input.projection.completeness,
      sourceId: input.sourceId,
      attachmentId: input.attachmentId
    });
  }));
};

const emptyConstraintCheck: ConstraintCheck = Object.freeze({
  blockingIssues: Object.freeze([]),
  auditIssues: Object.freeze([])
});

const deriveAttachmentProjection = (
  mapped: ProjectionResult<AutomergeMappedStorageRow>,
  constraintsToCheck: readonly SourceConstraint<WritableLogicalState>[],
  basis: SourceBasis
): AutomergeAttachmentProjection => {
  const logicalState: WritableLogicalState = Object.freeze({ rows: mapped.rows });
  const constraints = mapped.completeness === 'exact' && constraintsToCheck.length > 0
    ? checkCurrentConstraints({ constraints: constraintsToCheck, state: logicalState, basis })
    : emptyConstraintCheck;
  return Object.freeze({
    mapped,
    logicalState,
    constraints,
    issues: Object.freeze([
      ...mapped.issues,
      ...constraints.blockingIssues,
      ...constraints.auditIssues
    ])
  });
};
