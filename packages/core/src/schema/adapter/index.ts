/** Pure storage-mapping primitives for source adapter implementors. */
import type { Issue, ParseResult } from '../../issues.js';
import { assertCompiledStorageMapping } from '../../internal-semantic-provenance.js';
import {
  extractMappedStorageCandidatesInternal,
  mappingIssueInternal,
  projectMappedStorageCandidateInternal,
  type BoundRow,
  type CompiledStorageMapping,
  type MappedStorageOccurrence,
  type ProjectStorageOptions
} from '../../mapping.js';
import {
  parseProjectedRelationCandidates,
  parseRelationCandidates,
  type RelationId
} from '../../schema.js';

export type { MappedStorageOccurrence } from '../../mapping.js';

/** Inspect one mapped collection without parsing or projecting its rows. */
export const inspectMappedStorageOccurrences = (
  binding: CompiledStorageMapping,
  snapshot: unknown,
  relationId: RelationId,
  sourceId?: string
): {
  readonly occurrences: readonly MappedStorageOccurrence[];
  readonly issues: readonly Issue[];
  readonly completeness: 'exact' | 'unknown';
} => {
  assertCompiledStorageMapping(binding);
  const compiled = binding.relations.get(relationId);
  if (compiled === undefined) {
    return {
      occurrences: Object.freeze([]),
      issues: Object.freeze([mappingIssueInternal(
        'mapping.relation_missing',
        [],
        { relationId },
        undefined,
        sourceId,
        relationId
      )]),
      completeness: 'unknown'
    };
  }
  const inspected = extractMappedStorageCandidatesInternal(
    snapshot,
    compiled.mapping.collection,
    relationId,
    sourceId
  );
  return {
    occurrences: inspected.candidates,
    issues: inspected.issues,
    completeness: inspected.complete ? 'exact' : 'unknown'
  };
};

/**
 * Project and parse one inspected occurrence. Duplicate keys remain a
 * relation-level responsibility for the adapter coordinating incremental work.
 */
export const projectMappedStorageOccurrence = (
  binding: CompiledStorageMapping,
  relationId: RelationId,
  occurrence: MappedStorageOccurrence,
  options: ProjectStorageOptions = {}
): ParseResult<BoundRow> => {
  assertCompiledStorageMapping(binding);
  const compiled = binding.relations.get(relationId);
  if (compiled === undefined) {
    return {
      success: false,
      issues: [mappingIssueInternal(
        'mapping.relation_missing',
        [],
        { relationId },
        undefined,
        options.sourceId,
        relationId
      )]
    };
  }
  const projected = projectMappedStorageCandidateInternal(
    occurrence,
    compiled,
    relationId,
    options
  );
  if (!projected.success) return projected;
  const candidate = { value: projected.value, locator: occurrence.locator };
  const selectedFields = options.fieldsByRelation?.get(relationId);
  const context = options.sourceId === undefined
    ? {}
    : { sourceId: options.sourceId };
  const parsed = selectedFields === undefined
    ? parseRelationCandidates(
        binding.schema,
        compiled.relation,
        [candidate],
        options.registry,
        context
      )
    : parseProjectedRelationCandidates(
        binding.schema,
        compiled.relation,
        [candidate],
        selectedFields,
        options.registry,
        context
      );
  const row = parsed.rows[0];
  if (row === undefined
    || parsed.completeness !== 'exact'
    || parsed.issues.length > 0) {
    return {
      success: false,
      issues: parsed.issues.length > 0
        ? parsed.issues
        : [mappingIssueInternal(
            'mapping.candidate_invalid',
            occurrence.absolutePath,
            { relationId, locator: occurrence.locator },
            undefined,
            options.sourceId,
            relationId
          )]
    };
  }
  return {
    success: true,
    value: Object.freeze({
      row: row.row,
      key: row.key,
      locator: Object.freeze({ ...occurrence.locator })
    }),
    issues: []
  };
};
