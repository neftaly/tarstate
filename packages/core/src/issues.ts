export type IssuePhase =
  | 'resolve'
  | 'load'
  | 'parse'
  | 'query'
  | 'plan'
  | 'constraint'
  | 'commit'
  | 'governance'
  | 'lifecycle'
  | 'presence'
  | 'sync';

export type IssueRetry =
  | 'never'
  | 'after_input'
  | 'after_refresh'
  | 'after_capability'
  | 'after_authority'
  | 'query_outcome'
  | 'manual_repair';

export type IssueSeverity = 'info' | 'warning' | 'error';

export type CapabilityRef = {
  readonly id: string;
  readonly version: string;
  readonly contractHash: `sha256:${string}`;
};

export type Issue = {
  readonly id: string;
  readonly code: string;
  readonly severity: IssueSeverity;
  readonly phase: IssuePhase;
  readonly sourceId?: string;
  readonly relationId?: string;
  readonly key?: unknown;
  readonly path?: readonly unknown[];
  readonly operationId?: string;
  readonly requiredCapabilities?: readonly CapabilityRef[];
  readonly retry?: IssueRetry;
  readonly details?: unknown;
};

export type IssueDeclaration = {
  readonly code: string;
  readonly phase: IssuePhase;
  readonly severity: IssueSeverity;
  readonly retries: readonly IssueRetry[];
  readonly capabilityRelevant?: boolean;
};

const declarations = [
  ['artifact.budget_exceeded', 'parse', 'error', ['after_input']],
  ['artifact.cycle', 'parse', 'error', ['after_input']],
  ['artifact.dependency_ambiguous', 'resolve', 'error', ['after_input']],
  ['artifact.dependency_mismatch', 'parse', 'error', ['after_input']],
  ['artifact.duplicate_member', 'parse', 'error', ['after_input']],
  ['artifact.hash_mismatch', 'parse', 'error', ['after_input']],
  ['artifact.hostile_shape', 'parse', 'error', ['after_input']],
  ['artifact.invalid_envelope', 'parse', 'error', ['after_input']],
  ['artifact.invalid_hash', 'parse', 'error', ['after_input']],
  ['artifact.invalid_json', 'parse', 'error', ['after_input']],
  ['artifact.unsupported_value', 'parse', 'error', ['after_input']],
  ['binding.footprint_out_of_bounds', 'plan', 'error', ['after_input']],
  ['binding.footprint_relation_unknown', 'plan', 'error', ['after_input']],
  ['binding.write_footprint_overlap', 'plan', 'error', ['after_input']],
  ['capability.missing', 'resolve', 'error', ['after_capability']],
  ['capability.registry_conflict', 'governance', 'error', ['after_capability']],
  ['capability.registry_cycle', 'governance', 'error', ['after_capability']],
  ['constraint.evaluation_failed', 'constraint', 'error', ['after_refresh']],
  ['constraint.indeterminate', 'constraint', 'error', ['after_refresh', 'manual_repair']],
  ['constraint.delete_restricted', 'constraint', 'error', ['after_input']],
  ['constraint.query_indeterminate', 'constraint', 'error', ['after_refresh']],
  ['constraint.referential_budget_exceeded', 'constraint', 'error', ['after_input']],
  ['constraint-set.artifact_invalid', 'parse', 'error', ['after_input']],
  ['lens.capability_unavailable', 'query', 'error', ['after_capability']],
  ['lens.field_ambiguous', 'parse', 'error', ['after_input']],
  ['lens.field_not_writable', 'plan', 'error', ['after_input']],
  ['lens.invalid', 'parse', 'error', ['after_input']],
  ['lens.inverse_ambiguous', 'plan', 'error', ['after_input']],
  ['lens.lookup_ambiguous', 'query', 'error', ['after_input']],
  ['lens.lookup_arity', 'parse', 'error', ['after_input']],
  ['lens.lookup_missing', 'query', 'error', ['after_input']],
  ['lens.lookup_result_missing', 'query', 'error', ['after_input']],
  ['lens.lossy_reverse', 'plan', 'error', ['after_input']],
  ['lens.lossy_value', 'query', 'warning', ['after_input']],
  ['lens.metadata_conflict', 'plan', 'error', ['manual_repair']],
  ['lens.path_ambiguous', 'plan', 'error', ['after_input']],
  ['lens.path_missing', 'plan', 'error', ['after_input']],
  ['lens.relation_invalid', 'parse', 'error', ['after_input']],
  ['lens.relation_missing', 'query', 'error', ['after_input']],
  ['lens.step_invalid', 'parse', 'error', ['after_input']],
  ['lens.unmapped_value', 'query', 'error', ['after_input']],
  ['lifecycle.adapter_failed', 'lifecycle', 'error', ['after_refresh']],
  ['lifecycle.authority_denied', 'governance', 'error', ['after_authority']],
  ['lifecycle.authority_failed', 'governance', 'error', ['after_authority']],
  ['lifecycle.cancelled', 'lifecycle', 'error', ['never']],
  ['lifecycle.command_invalid', 'lifecycle', 'error', ['after_input']],
  ['lifecycle.expected_basis_stale', 'lifecycle', 'error', ['after_refresh']],
  ['lifecycle.expected_basis_unavailable', 'lifecycle', 'error', ['after_refresh']],
  ['lifecycle.operation_epoch_expired', 'lifecycle', 'error', ['never']],
  ['lifecycle.operation_id_ambiguous', 'commit', 'error', ['never']],
  ['lifecycle.outcome_unavailable', 'commit', 'error', ['query_outcome']],
  ['lifecycle.outcome_unknown', 'lifecycle', 'error', ['query_outcome']],
  ['lifecycle.preflight_failed', 'lifecycle', 'error', ['after_refresh']],
  ['lifecycle.source_id_invalid', 'lifecycle', 'error', ['after_input']],
  ['mapping.candidate_invalid', 'parse', 'error', ['after_input']],
  ['mapping.capability_unavailable', 'plan', 'error', ['after_capability']],
  ['mapping.collection_absent', 'query', 'error', ['after_refresh']],
  ['mapping.collection_invalid', 'parse', 'error', ['after_input']],
  ['mapping.field_invalid', 'parse', 'error', ['after_input']],
  ['mapping.field_read_only', 'plan', 'error', ['after_input']],
  ['mapping.field_unmapped', 'plan', 'error', ['after_input']],
  ['mapping.invalid', 'parse', 'error', ['after_input']],
  ['mapping.key_invalid', 'parse', 'error', ['after_input']],
  ['mapping.keys_invalid', 'parse', 'error', ['after_input']],
  ['mapping.locator_invalid', 'plan', 'error', ['after_refresh']],
  ['mapping.locator_stale', 'plan', 'error', ['after_refresh']],
  ['mapping.map_key_mismatch', 'parse', 'error', ['after_input']],
  ['mapping.path_invalid', 'parse', 'error', ['after_input']],
  ['mapping.rekey_required', 'plan', 'error', ['after_input']],
  ['mapping.relation_invalid', 'parse', 'error', ['after_input']],
  ['mapping.relation_missing', 'query', 'error', ['after_input']],
  ['observer.attachment_missing', 'load', 'error', ['after_refresh']],
  ['observer.authority_denied', 'query', 'error', ['after_authority']],
  ['observer.evaluation_failed', 'query', 'error', ['after_refresh']],
  ['observer.membership_open', 'load', 'error', ['after_refresh']],
  ['observer.membership_source_mismatch', 'load', 'error', ['after_refresh']],
  ['observer.projection_unavailable', 'query', 'error', ['after_refresh']],
  ['operation.durable_lookup_unavailable', 'commit', 'error', ['query_outcome']],
  ['operation.ledger_complete_failed', 'commit', 'error', ['query_outcome']],
  ['operation.ledger_unavailable', 'commit', 'error', ['query_outcome']],
  ['operation.outcome_pending', 'commit', 'error', ['query_outcome']],
  ['query.capability_unavailable', 'query', 'error', ['after_capability']],
  ['query.artifact_invalid', 'parse', 'error', ['after_input']],
  ['query.cursor_stale', 'query', 'error', ['after_refresh']],
  ['query.input_identity_invalid', 'query', 'error', ['after_input']],
  ['query.function_failed', 'query', 'error', ['after_input']],
  ['query.parameter_invalid', 'query', 'error', ['after_input']],
  ['query.recursion_budget_exceeded', 'query', 'error', ['after_input']],
  ['query.recursion_non_monotone', 'query', 'error', ['after_input']],
  ['query.scalar_subquery_cardinality', 'query', 'error', ['after_input']],
  ['governance.adapter_evidence_invalid', 'governance', 'error', ['after_refresh', 'query_outcome']],
  ['governance.adapter_failed', 'governance', 'error', ['after_refresh']],
  ['governance.authority_denied', 'governance', 'error', ['after_authority']],
  ['governance.authority_failed', 'governance', 'error', ['after_authority']],
  ['governance.cancelled', 'governance', 'error', ['never']],
  ['governance.command_invalid', 'governance', 'error', ['after_input']],
  ['governance.expected_basis_stale', 'governance', 'error', ['after_refresh']],
  ['governance.operation_epoch_expired', 'governance', 'error', ['never']],
  ['governance.operation_id_ambiguous', 'governance', 'error', ['never']],
  ['governance.outcome_unavailable', 'governance', 'error', ['query_outcome']],
  ['governance.outcome_unknown', 'governance', 'error', ['query_outcome']],
  ['governance.preflight_failed', 'governance', 'error', ['after_refresh']],
  ['governance.repair_selection_invalid', 'governance', 'error', ['after_input']],
  ['governance.source_unavailable', 'resolve', 'error', ['after_refresh']],
  ['presence.accept_failed', 'presence', 'error', ['after_refresh']],
  ['presence.command_invalid', 'presence', 'error', ['after_input']],
  ['receipt.invalid', 'parse', 'error', ['after_input']],
  ['receipt.sequence_step_duplicate', 'commit', 'error', ['after_input']],
  ['receipt.sequence_step_unknown', 'commit', 'error', ['query_outcome']],
  ['receipt.unknown_kind_version', 'parse', 'warning', ['never']],
  ['resolver.authority_denied', 'resolve', 'error', ['after_authority']],
  ['resolver.cycle', 'resolve', 'error', ['after_input']],
  ['resolver.failed', 'resolve', 'error', ['after_refresh']],
  ['resolver.integrity_mismatch', 'resolve', 'error', ['after_input']],
  ['resolver.redirect_budget_exceeded', 'resolve', 'error', ['after_input']],
  ['resolver.scheme_unsupported', 'resolve', 'error', ['after_input']],
  ['schema.bytes_invalid', 'parse', 'error', ['after_input']],
  ['schema.candidate_invalid', 'parse', 'error', ['after_input']],
  ['schema.codec_failed', 'parse', 'error', ['after_input']],
  ['schema.codec_unavailable', 'parse', 'error', ['after_capability']],
  ['schema.duplicate_key', 'parse', 'error', ['manual_repair']],
  ['schema.enum_value', 'parse', 'error', ['after_input']],
  ['schema.field_invalid', 'parse', 'error', ['after_input']],
  ['schema.field_missing', 'parse', 'error', ['after_input']],
  ['schema.instant_invalid', 'parse', 'error', ['after_input']],
  ['schema.instant_precision', 'parse', 'error', ['after_input']],
  ['schema.integer_invalid', 'parse', 'error', ['after_input']],
  ['schema.invalid', 'parse', 'error', ['after_input']],
  ['schema.key_arity', 'parse', 'error', ['after_input']],
  ['schema.key_invalid', 'parse', 'error', ['after_input']],
  ['schema.null_not_allowed', 'parse', 'error', ['after_input']],
  ['schema.ref_arity', 'parse', 'error', ['after_input']],
  ['schema.ref_target_missing', 'parse', 'error', ['after_input']],
  ['schema.relation_id_duplicate', 'parse', 'error', ['after_input']],
  ['schema.relation_invalid', 'parse', 'error', ['after_input']],
  ['schema.relation_missing', 'parse', 'error', ['after_input']],
  ['schema.required_codecs_invalid', 'parse', 'error', ['after_input']],
  ['schema-lens.artifact_invalid', 'parse', 'error', ['after_input']],
  ['schema.scalar_type', 'parse', 'error', ['after_input']],
  ['source.closed', 'lifecycle', 'error', ['never']],
  ['source.hydration_failed', 'load', 'error', ['after_refresh']],
  ['source.not_ready', 'load', 'error', ['after_refresh']],
  ['storage-mapping.artifact_invalid', 'parse', 'error', ['after_input']],
  ['transaction.artifact_unavailable', 'resolve', 'error', ['after_refresh']],
  ['transaction.artifact_invalid', 'parse', 'error', ['after_input']],
  ['transaction.attachment_unavailable', 'resolve', 'error', ['after_refresh']],
  ['transaction.authority_denied', 'commit', 'error', ['after_authority']],
  ['transaction.cancelled', 'commit', 'error', ['never']],
  ['transaction.batch_step_id_duplicate', 'commit', 'error', ['after_input']],
  ['transaction.batch_step_outcome_unknown', 'commit', 'error', ['query_outcome']],
  ['transaction.capability_unavailable', 'resolve', 'error', ['after_capability']],
  ['transaction.conflict_changed', 'commit', 'error', ['after_refresh']],
  ['transaction.conflict_observation_stale', 'plan', 'error', ['after_refresh']],
  ['transaction.conflict_requires_resolution', 'plan', 'error', ['after_input']],
  ['transaction.conflict_selection_invalid', 'plan', 'error', ['after_input']],
  ['transaction.cross_source_access', 'plan', 'error', ['after_input']],
  ['transaction.edit_type_mismatch', 'plan', 'error', ['after_input']],
  ['transaction.expected_basis_stale', 'commit', 'error', ['after_refresh']],
  ['transaction.expression_indeterminate', 'plan', 'error', ['after_input']],
  ['transaction.guard_failed', 'plan', 'error', ['after_input']],
  ['transaction.insert_query_failed', 'query', 'error', ['after_input']],
  ['transaction.insert_query_incomplete', 'query', 'error', ['after_refresh']],
  ['transaction.insert_query_row_invalid', 'query', 'error', ['after_input']],
  ['transaction.operation_epoch_expired', 'commit', 'error', ['never']],
  ['transaction.operation_id_ambiguous', 'commit', 'error', ['never']],
  ['transaction.outcome_unavailable', 'commit', 'error', ['query_outcome']],
  ['transaction.parameter_missing', 'plan', 'error', ['after_input']],
  ['transaction.returning_failed', 'query', 'error', ['after_refresh']],
  ['transaction.returning_name_duplicate', 'parse', 'error', ['after_input']],
  ['transaction.rekey_collision', 'plan', 'error', ['after_input']],
  ['transaction.rekey_key_invalid', 'plan', 'error', ['after_input']],
  ['transaction.rekey_referenced', 'plan', 'error', ['after_input']],
  ['transaction.rekey_target_ambiguous', 'plan', 'error', ['manual_repair']],
  ['transaction.schema_view_unavailable', 'resolve', 'error', ['after_refresh']],
  ['transaction.statement_invalid', 'parse', 'error', ['after_input']],
  ['transaction.upsert_conflict', 'plan', 'error', ['after_input']],
  ['transaction.upsert_input_ambiguous', 'plan', 'error', ['after_input']],
  ['transaction.upsert_key_missing', 'plan', 'error', ['after_input']],
  ['transaction.upsert_key_unavailable', 'plan', 'error', ['after_input']],
  ['transaction.upsert_target_ambiguous', 'plan', 'error', ['manual_repair']],
  ['transaction.unexpected_failure', 'commit', 'error', ['after_refresh']]
] as const satisfies readonly (readonly [string, IssuePhase, IssueSeverity, readonly IssueRetry[]])[];

export const issueCatalog: ReadonlyMap<string, IssueDeclaration> = new Map(
  declarations.map(([code, phase, severity, retries]) => [code, {
    code,
    phase,
    severity,
    retries,
    ...(code.startsWith('capability.') || code.includes('capability_') ? { capabilityRelevant: true } : {})
  }])
);

export type IssueInput = Omit<Issue, 'id' | 'phase' | 'severity'> & {
  readonly code: string;
  readonly phase?: IssuePhase;
  readonly severity?: IssueSeverity;
};

export const createIssue = (input: IssueInput): Issue => {
  const declaration = issueCatalog.get(input.code);
  const phase = input.phase ?? declaration?.phase;
  const severity = input.severity ?? declaration?.severity;
  if (phase === undefined || severity === undefined) throw new Error('Unregistered issue code requires explicit phase and severity: ' + input.code);
  const identity = stableIssueIdentity({
    code: input.code,
    sourceId: input.sourceId,
    relationId: input.relationId,
    key: input.key,
    path: input.path,
    operationId: input.operationId,
    requiredCapabilities: input.requiredCapabilities,
    details: input.details
  });
  return {
    id: input.code + ':' + identity,
    code: input.code,
    phase,
    severity,
    ...(input.sourceId === undefined ? {} : { sourceId: input.sourceId }),
    ...(input.relationId === undefined ? {} : { relationId: input.relationId }),
    ...(input.key === undefined ? {} : { key: input.key }),
    ...(input.path === undefined ? {} : { path: input.path }),
    ...(input.operationId === undefined ? {} : { operationId: input.operationId }),
    ...(input.requiredCapabilities === undefined ? {} : { requiredCapabilities: input.requiredCapabilities }),
    ...(input.retry === undefined ? {} : { retry: input.retry }),
    ...(input.details === undefined ? {} : { details: input.details })
  };
};

const stableIssueIdentity = (input: Record<string, unknown>): string => {
  const entries = Object.entries(input).filter(([, value]) => value !== undefined).sort(([left], [right]) => left.localeCompare(right));
  return JSON.stringify(Object.fromEntries(entries), (_key, value: unknown) => {
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)));
    }
    return value;
  });
};

export type ParseResult<Value> =
  | { readonly success: true; readonly value: Value; readonly issues: readonly Issue[] }
  | { readonly success: false; readonly issues: readonly Issue[] };

export class TarstateParseError extends Error {
  readonly issues: readonly Issue[];

  constructor(issues: readonly Issue[]) {
    super(issues.map((issue) => issue.code).join(', '));
    this.name = 'TarstateParseError';
    this.issues = issues;
  }
}
