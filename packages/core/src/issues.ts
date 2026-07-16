import { ownedReadonlyMap } from './internal-owned-map.js';
import { stringTupleKey } from './internal-string-key.js';
import { comparePortableStrings } from './portable-order.js';

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

/** Collision-free registry key for a capability reference. */
export const capabilityRefKey = (ref: CapabilityRef): string =>
  stringTupleKey(ref.id, ref.version, ref.contractHash);

/** Stable, portable diagnostic with an explicit phase and retry policy. */
export type Issue = {
  readonly id: string;
  readonly code: string;
  readonly severity: IssueSeverity;
  readonly phase: IssuePhase;
  readonly sourceId?: string;
  readonly relationId?: string;
  /** Portable row or locator identity; copied and frozen by `createIssue`. */
  readonly key?: unknown;
  /** Portable diagnostic path; copied and frozen by `createIssue`. */
  readonly path?: readonly unknown[];
  readonly operationId?: string;
  readonly requiredCapabilities?: readonly CapabilityRef[];
  readonly retry?: IssueRetry;
  /** Portable diagnostic context; copied and frozen by `createIssue`. Non-portable host values are programmer errors. */
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
  ['binding.edit_handling_conflict', 'plan', 'error', ['after_input']],
  ['binding.edit_handling_invalid', 'plan', 'error', ['after_input']],
  ['binding.edit_unhandled', 'plan', 'error', ['after_input']],
  ['binding.footprint_out_of_bounds', 'plan', 'error', ['after_input']],
  ['binding.footprint_relation_unknown', 'plan', 'error', ['after_input']],
  ['binding.plan_failed', 'plan', 'error', ['after_input']],
  ['binding.stage_failed', 'plan', 'error', ['after_input']],
  ['binding.write_footprint_overlap', 'plan', 'error', ['after_input']],
  ['capability.missing', 'resolve', 'error', ['after_capability']],
  ['capability.registry_conflict', 'governance', 'error', ['after_capability']],
  ['capability.registry_cycle', 'governance', 'error', ['after_capability']],
  ['constraint.evaluation_failed', 'constraint', 'error', ['after_refresh']],
  ['constraint.indeterminate', 'constraint', 'error', ['after_refresh', 'manual_repair']],
  ['constraint.delete_restricted', 'constraint', 'error', ['after_input']],
  ['constraint.query_indeterminate', 'constraint', 'error', ['after_refresh']],
  ['constraint.referential_budget_exceeded', 'constraint', 'error', ['after_input']],
  ['constraint.referential_action_invalid', 'constraint', 'error', ['after_input']],
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
  ['lens.path_budget_exceeded', 'plan', 'error', ['after_input']],
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
  ['mapping.source_metadata_unavailable', 'query', 'error', ['after_refresh']],
  ['observer.attachment_missing', 'load', 'error', ['after_refresh']],
  ['observer.authority_denied', 'query', 'error', ['after_authority']],
  ['observer.source_link_invalid', 'query', 'error', ['after_input']],
  ['observer.source_link_budget_exceeded', 'query', 'warning', ['after_input']],
  ['observer.linked_source_resolution_failed', 'load', 'error', ['after_refresh']],
  ['observer.linked_source_unavailable', 'load', 'error', ['after_refresh']],
  ['observer.evaluation_failed', 'query', 'error', ['after_refresh']],
  ['observer.membership_open', 'load', 'error', ['after_refresh']],
  ['observer.membership_source_mismatch', 'load', 'error', ['after_refresh']],
  ['observer.projection_unavailable', 'query', 'error', ['after_refresh']],
  ['operation.durable_lookup_unavailable', 'commit', 'error', ['query_outcome']],
  ['operation.ledger_complete_failed', 'commit', 'error', ['query_outcome']],
  ['operation.ledger_unavailable', 'commit', 'error', ['query_outcome']],
  ['operation.outcome_pending', 'commit', 'error', ['query_outcome']],
  ['query.capability_unavailable', 'query', 'error', ['after_capability']],
  ['query.alias_missing', 'query', 'error', ['after_input']],
  ['query.artifact_invalid', 'parse', 'error', ['after_input']],
  ['query.cursor_stale', 'query', 'error', ['after_refresh']],
  ['query.input_identity_invalid', 'query', 'error', ['after_input']],
  ['query.incremental_identity_invalid', 'query', 'error', ['after_refresh']],
  ['query.incremental_relation_ambiguous', 'query', 'error', ['after_refresh']],
  ['query.incremental_session_input_changed', 'query', 'error', ['after_input']],
  ['query.function_failed', 'query', 'error', ['after_input']],
  ['query.parameter_invalid', 'query', 'error', ['after_input']],
  ['query.recursion_budget_exceeded', 'query', 'error', ['after_input']],
  ['query.execution_budget_exceeded', 'query', 'error', ['after_input']],
  ['query.recursion_non_monotone', 'query', 'error', ['after_input']],
  ['query.recursion_reference_missing', 'query', 'error', ['after_input']],
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
  ['transaction.delta_invalid', 'plan', 'error', ['after_input']],
  ['transaction.delta_input_ambiguous', 'plan', 'error', ['after_input']],
  ['transaction.delta_key_missing', 'plan', 'error', ['after_input']],
  ['transaction.delta_target_ambiguous', 'plan', 'error', ['manual_repair']],
  ['transaction.delta_target_missing', 'plan', 'error', ['after_refresh']],
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
  ['transaction.staged_basis_unavailable', 'plan', 'error', ['after_refresh']],
  ['transaction.upsert_conflict', 'plan', 'error', ['after_input']],
  ['transaction.upsert_input_ambiguous', 'plan', 'error', ['after_input']],
  ['transaction.upsert_key_missing', 'plan', 'error', ['after_input']],
  ['transaction.upsert_key_unavailable', 'plan', 'error', ['after_input']],
  ['transaction.upsert_target_ambiguous', 'plan', 'error', ['manual_repair']],
  ['transaction.unexpected_failure', 'commit', 'error', ['after_refresh']]
] as const satisfies readonly (readonly [string, IssuePhase, IssueSeverity, readonly IssueRetry[]])[];

export const issueCatalog: ReadonlyMap<string, IssueDeclaration> = ownedReadonlyMap(
  declarations.map(([code, phase, severity, retries]) => [code, Object.freeze({
    code,
    phase,
    severity,
    retries: Object.freeze([...retries]),
    ...(code.startsWith('capability.') || code.includes('capability_') ? { capabilityRelevant: true } : {})
  })] as const)
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
  const key = input.key === undefined ? undefined : ownIssueValue(input.key, 'key');
  const pathValue = input.path === undefined ? undefined : ownIssueValue(input.path, 'path');
  if (pathValue !== undefined && !Array.isArray(pathValue)) throw invalidIssueValue('path', 'array required');
  const path = pathValue as readonly unknown[] | undefined;
  const details = input.details === undefined ? undefined : ownIssueValue(input.details, 'details');
  const identity = stableIssueIdentity({
    code: input.code,
    sourceId: input.sourceId,
    relationId: input.relationId,
    key,
    path,
    operationId: input.operationId,
    requiredCapabilities: input.requiredCapabilities,
    details
  });
  return Object.freeze({
    id: input.code + ':' + identity,
    code: input.code,
    phase,
    severity,
    ...(input.sourceId === undefined ? {} : { sourceId: input.sourceId }),
    ...(input.relationId === undefined ? {} : { relationId: input.relationId }),
    ...(key === undefined ? {} : { key }),
    ...(path === undefined ? {} : { path }),
    ...(input.operationId === undefined ? {} : { operationId: input.operationId }),
    ...(input.requiredCapabilities === undefined ? {} : { requiredCapabilities: Object.freeze(input.requiredCapabilities.map((ref) => Object.freeze({ ...ref }))) }),
    ...(input.retry === undefined ? {} : { retry: input.retry }),
    ...(details === undefined ? {} : { details })
  });
};

const forbiddenPortableKeys = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * Owns identity-bearing issue data without executing accessors. `createIssue` is
 * a throwing shell, so violations of its documented portable-value contract are
 * programmer errors rather than issues (which would recurse through this API).
 */
const ownIssueValue = (input: unknown, member: 'key' | 'path' | 'details'): unknown => {
  const ancestors = new Set<object>();
  let members = 0;
  const visit = (value: unknown, depth: number): unknown => {
    if (depth > 64) throw invalidIssueValue(member, 'maximum depth exceeded');
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) throw invalidIssueValue(member, 'number must be finite');
      return Object.is(value, -0) ? 0 : value;
    }
    if (typeof value !== 'object') throw invalidIssueValue(member, `unsupported ${typeof value}`);
    try {
      if (ancestors.has(value)) throw invalidIssueValue(member, 'cyclic value');
      if (Object.getPrototypeOf(value) !== Object.prototype && !Array.isArray(value)) throw invalidIssueValue(member, 'object must have the default prototype');
      ancestors.add(value);
      const descriptors = Object.getOwnPropertyDescriptors(value);
      const keys = Reflect.ownKeys(value);
      if (keys.some((key) => typeof key !== 'string')) throw invalidIssueValue(member, 'symbol properties are not portable');
      members += keys.length;
      if (members > 500_000) throw invalidIssueValue(member, 'maximum member count exceeded');
      if (Array.isArray(value)) {
        if (keys.some((key) => key !== 'length' && !/^(0|[1-9][0-9]*)$/.test(key as string))) throw invalidIssueValue(member, 'array properties must be indexed members');
        const length = descriptors.length?.value;
        if (!Number.isSafeInteger(length) || length < 0) throw invalidIssueValue(member, 'array length is invalid');
        const owned: unknown[] = [];
        for (let index = 0; index < length; index += 1) {
          const descriptor = descriptors[String(index)];
          if (descriptor === undefined) throw invalidIssueValue(member, 'sparse arrays are not portable');
          if (!descriptor.enumerable || !('value' in descriptor)) throw invalidIssueValue(member, 'array members must be enumerable data properties');
          owned.push(visit(descriptor.value, depth + 1));
        }
        return Object.freeze(owned);
      }
      const owned: Record<string, unknown> = {};
      for (const key of keys as string[]) {
        if (forbiddenPortableKeys.has(key)) throw invalidIssueValue(member, `property ${key} is not portable`);
        const descriptor = descriptors[key];
        if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) throw invalidIssueValue(member, 'object members must be enumerable data properties');
        Object.defineProperty(owned, key, { value: visit(descriptor.value, depth + 1), enumerable: true, configurable: false, writable: false });
      }
      return Object.freeze(owned);
    } catch (error) {
      if (error instanceof TypeError && error.message.startsWith('Invalid issue ')) throw error;
      throw invalidIssueValue(member, 'inspection failed');
    } finally {
      ancestors.delete(value);
    }
  };
  return visit(input, 0);
};

const invalidIssueValue = (member: string, reason: string): TypeError => new TypeError(`Invalid issue ${member}: ${reason}`);

const stableIssueIdentity = (input: Record<string, unknown>): string => {
  const entries = Object.entries(input).filter(([, value]) => value !== undefined).sort(([left], [right]) => comparePortableStrings(left, right));
  return JSON.stringify(Object.fromEntries(entries), (_key, value: unknown) => {
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      return Object.fromEntries(Object.entries(value).sort(([left], [right]) => comparePortableStrings(left, right)));
    }
    return value;
  });
};

/** Non-throwing validation result used at portable-data boundaries. */
export type ParseResult<Value> =
  | { readonly success: true; readonly value: Value; readonly issues: readonly Issue[] }
  | { readonly success: false; readonly issues: readonly Issue[] };

/** Throwing shell form for APIs that cannot return a `ParseResult`. */
export class TarstateParseError extends Error {
  readonly issues: readonly Issue[];

  constructor(issues: readonly Issue[]) {
    super(issues.map((issue) => issue.code).join(', '));
    this.name = 'TarstateParseError';
    this.issues = issues;
  }
}
