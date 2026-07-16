import type { IssueDeclaration, IssuePhase, IssueRetry, IssueSeverity } from '@tarstate/core';
import { comparePortableStrings } from './portable-order.js';

const declaration = (
  code: `automerge.${string}`,
  phase: IssuePhase,
  severity: IssueSeverity,
  retries: readonly IssueRetry[]
): IssueDeclaration => Object.freeze({ code, phase, severity, retries: Object.freeze([...retries]) });

/** Complete catalog fragment for every public `automerge.*` issue code. */
export const automergeIssueDeclarations: readonly IssueDeclaration[] = Object.freeze([
  declaration('automerge.collection_invalid', 'parse', 'error', ['after_refresh']),
  declaration('automerge.command_failed', 'commit', 'error', ['after_input', 'after_refresh']),
  declaration('automerge.conflict_observed', 'query', 'warning', ['manual_repair']),
  declaration('automerge.counter_edit_invalid', 'plan', 'error', ['after_input']),
  declaration('automerge.edit_parent_missing', 'plan', 'error', ['after_refresh']),
  declaration('automerge.logical_key_ambiguous', 'query', 'warning', ['manual_repair']),
  declaration('automerge.map_key_conflict', 'query', 'warning', ['manual_repair']),
  declaration('automerge.metadata_conflict', 'governance', 'error', ['manual_repair']),
  declaration('automerge.metadata_expected_basis_stale', 'governance', 'error', ['after_refresh']),
  declaration('automerge.metadata_governance_required', 'governance', 'error', ['after_authority']),
  declaration('automerge.metadata_malformed', 'parse', 'error', ['manual_repair']),
  declaration('automerge.metadata_name_collision', 'parse', 'error', ['after_authority', 'manual_repair']),
  declaration('automerge.metadata_override_read_only', 'governance', 'warning', ['manual_repair']),
  declaration('automerge.metadata_repair_alternatives_changed', 'governance', 'error', ['after_refresh']),
  declaration('automerge.metadata_repair_unsupported', 'governance', 'error', ['manual_repair']),
  declaration('automerge.projection_budget_exceeded', 'query', 'error', ['after_input']),
  declaration('automerge.reentrant_commit', 'commit', 'error', ['after_refresh']),
  declaration('automerge.reserved_metadata_write', 'plan', 'error', ['after_authority']),
  declaration('automerge.root_edit_unsupported', 'plan', 'error', ['after_input']),
  declaration('automerge.row_invalid', 'parse', 'error', ['after_input']),
  declaration('automerge.row_identity_unavailable', 'parse', 'error', ['after_refresh']),
  declaration('automerge.row_key_invalid', 'parse', 'error', ['after_input']),
  declaration('automerge.row_parser_failed', 'parse', 'error', ['after_input']),
  declaration('automerge.text_edit_invalid', 'plan', 'error', ['after_input']),
  declaration('automerge.value_conflicted', 'parse', 'error', ['manual_repair']),
  declaration('automerge.value_invalid', 'parse', 'error', ['after_input'])
].sort((left, right) => comparePortableStrings(left.code, right.code)));
