import { canonicalizeJson } from '../canonical-json.js';
import { checkCurrentConstraints, type ConstraintCheck, type SourceConstraint } from '../constraints.js';
import type { Issue } from '../issues.js';
import { samePortableJson } from '../internal-json-equality.js';
import type { ProjectionResult, WritableLogicalRow, WritableLogicalState } from '../logical-edit.js';
import type { RelationInput } from '../query/model.js';
import type { SourceBasis, SourceLifecycleState, SourceSnapshot } from '../source-state.js';
import type { StorageBinding } from '../source-protocol.js';
import type { JsonValue } from '../value.js';
import type { LogicalProjectionDemand } from '../query/projection-demand.js';
import type { AttachmentProjection } from './model.js';
import { selectStorageProjection } from './projection-selection.js';

export type MappedAttachmentProjection<Row extends WritableLogicalRow> = {
  readonly mapped: ProjectionResult<Row>;
  readonly logicalState: WritableLogicalState;
  readonly constraints: ConstraintCheck;
  readonly issues: readonly Issue[];
};

export type MappedAttachmentProjector<Storage, Row extends WritableLogicalRow> = {
  readonly project: (
    snapshot: SourceSnapshot<Storage>,
    relationIds?: ReadonlySet<string>,
    fieldsByRelation?: ReadonlyMap<string, ReadonlySet<string>>
  ) => MappedAttachmentProjection<Row>;
};

export type MappedDatabaseResult = {
  readonly readiness: 'ready' | 'incomplete' | 'invalid';
  readonly rows: readonly MappedLogicalRelationRow[];
  readonly completeness: 'exact' | 'unknown';
  readonly freshness: SourceSnapshot<unknown>['freshness'];
  readonly basis: SourceBasis;
  readonly sourceState: SourceLifecycleState;
  readonly issues: readonly Issue[];
};

export type MappedLogicalRelationRow = {
  readonly relationId: string;
  readonly fields: Readonly<Record<string, JsonValue>>;
};

export type MappedDatabaseSnapshot =
  | { readonly state: 'open'; readonly current: MappedDatabaseResult }
  | { readonly state: 'closed' };

/** Constraint-aware logical projection shared by mapped source adapters. */
export const createMappedAttachmentProjector = <Storage, Command, Row extends WritableLogicalRow>(input: {
  readonly binding: StorageBinding<Storage, Command, Row>;
  readonly constraints: readonly SourceConstraint<WritableLogicalState>[];
}): MappedAttachmentProjector<Storage, Row> => {
  let previous: {
    readonly basis: SourceBasis;
    readonly mapped: ProjectionResult<Row>;
    readonly projection: MappedAttachmentProjection<Row>;
  } | undefined;
  return Object.freeze({
    project: (snapshot, relationIds, fieldsByRelation) => {
      const mapped = input.constraints.length === 0
        ? input.binding.project(snapshot, relationIds, fieldsByRelation)
        : input.binding.project(snapshot);
      if (previous?.mapped === mapped
        && (input.constraints.length === 0 || samePortableJson(previous.basis, snapshot.basis))) {
        return previous.projection;
      }
      const projection = deriveProjection(mapped, input.constraints, snapshot.basis);
      previous = { basis: snapshot.basis, mapped, projection };
      return projection;
    }
  });
};

export const mappedDatabaseSnapshot = <Storage, Row extends WritableLogicalRow>(
  sourceSnapshot: SourceSnapshot<Storage>,
  projector: MappedAttachmentProjector<Storage, Row>,
  logicalRows: WeakMap<object, readonly MappedLogicalRelationRow[]>
): MappedDatabaseSnapshot => {
  if (sourceSnapshot.state !== 'ready') return unavailableSnapshot(sourceSnapshot);
  const projection = projector.project(sourceSnapshot);
  let rows = logicalRows.get(projection.mapped);
  if (rows === undefined) {
    rows = Object.freeze(projection.mapped.rows.map(({ relationId, fields }) => Object.freeze({
      relationId,
      fields
    })));
    logicalRows.set(projection.mapped, rows);
  }
  const issues = Object.freeze([...sourceSnapshot.issues, ...projection.issues]);
  return Object.freeze({
    state: 'open',
    current: Object.freeze({
      readiness: databaseReadiness(
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
    })
  });
};

export const createMappedDatabaseProjection = <Storage, Row extends WritableLogicalRow>(input: {
  readonly projector: MappedAttachmentProjector<Storage, Row>;
  readonly schemaView: { readonly id: string; readonly contentHash: `sha256:${string}` };
  readonly relationIds: readonly string[];
  readonly sourceId: string;
  readonly attachmentId: string;
  readonly occurrenceId: (row: Row) => string;
}): ((
  snapshot: SourceSnapshot<Storage>,
  demand?: LogicalProjectionDemand
) => AttachmentProjection<readonly RelationInput[]>) => {
  const values = new WeakMap<object, Map<string, readonly RelationInput[]>>();
  return (snapshot, demand?: LogicalProjectionDemand) => {
    if (snapshot.state !== 'ready') return { state: snapshot.state, issues: snapshot.issues };
    const selection = selectStorageProjection(demand, input.schemaView, input.relationIds);
    const selectedRelationIds = selection === undefined
      ? input.relationIds
      : [...selection.relationIds];
    const projection = input.projector.project(
      snapshot,
      selection?.relationIds,
      selection?.fieldsByRelation
    );
    if (projection.constraints.blockingIssues.length > 0) {
      return { state: 'failed', issues: projection.issues };
    }
    const selectionKey = canonicalizeJson(selectedRelationIds);
    let bySelection = values.get(projection.mapped);
    let relations = bySelection?.get(selectionKey);
    if (relations === undefined) {
      relations = relationInputs({
        ...input,
        relationIds: selectedRelationIds,
        projection: projection.mapped
      });
      bySelection ??= new Map();
      bySelection.set(selectionKey, relations);
      values.set(projection.mapped, bySelection);
    }
    return { state: 'ready', value: relations, issues: projection.issues };
  };
};

export const sameMappedDatabaseSnapshot = (
  left: MappedDatabaseSnapshot,
  right: MappedDatabaseSnapshot
): boolean => left.state === 'open'
  && right.state === 'open'
  && left.current.rows === right.current.rows
  && left.current.readiness === right.current.readiness
  && left.current.completeness === right.current.completeness
  && left.current.freshness === right.current.freshness
  && left.current.sourceState === right.current.sourceState
  && samePortableJson(left.current.basis, right.current.basis)
  && samePortableJson(left.current.issues, right.current.issues);

const relationInputs = <Row extends WritableLogicalRow>(input: {
  readonly projection: ProjectionResult<Row>;
  readonly schemaView: { readonly id: string; readonly contentHash: `sha256:${string}` };
  readonly relationIds: readonly string[];
  readonly sourceId: string;
  readonly attachmentId: string;
  readonly occurrenceId: (row: Row) => string;
}): readonly RelationInput[] => {
  const rows = new Map<string, Row[]>();
  for (const relationId of input.relationIds) rows.set(relationId, []);
  for (const row of input.projection.rows) rows.get(row.relationId)?.push(row);
  return Object.freeze(input.relationIds.map((relationId) => {
    const relationRows = rows.get(relationId) ?? [];
    return Object.freeze({
      relation: Object.freeze({ schemaView: input.schemaView, relationId }),
      rows: Object.freeze(relationRows.map(({ fields }) => fields)),
      occurrenceIds: Object.freeze(relationRows.map(input.occurrenceId)),
      completeness: input.projection.completeness,
      sourceId: input.sourceId,
      attachmentId: input.attachmentId
    });
  }));
};

const unavailableSnapshot = <Storage>(
  snapshot: SourceSnapshot<Storage>
): MappedDatabaseSnapshot => Object.freeze({
  state: 'open',
  current: Object.freeze({
    readiness: snapshot.state === 'loading' ? 'incomplete' : 'invalid',
    rows: Object.freeze([]),
    completeness: 'unknown',
    freshness: snapshot.freshness,
    basis: snapshot.basis,
    sourceState: snapshot.state,
    issues: snapshot.issues
  })
});

const databaseReadiness = (
  sourceState: SourceLifecycleState,
  completeness: 'exact' | 'unknown',
  blockingConstraintIssues: readonly Issue[],
  issues: readonly Issue[]
): MappedDatabaseResult['readiness'] => {
  if (sourceState !== 'ready' && sourceState !== 'loading') return 'invalid';
  if (blockingConstraintIssues.length > 0) return 'invalid';
  if (issues.some(({ severity }) => severity === 'error')) return 'invalid';
  return sourceState === 'ready' && completeness === 'exact' ? 'ready' : 'incomplete';
};

const deriveProjection = <Row extends WritableLogicalRow>(
  mapped: ProjectionResult<Row>,
  constraintsToCheck: readonly SourceConstraint<WritableLogicalState>[],
  basis: SourceBasis
): MappedAttachmentProjection<Row> => {
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

const emptyConstraintCheck: ConstraintCheck = Object.freeze({
  blockingIssues: Object.freeze([]),
  auditIssues: Object.freeze([])
});
