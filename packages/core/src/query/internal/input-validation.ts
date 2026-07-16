import { createIssue, type Issue } from '../../issues.js';
import { relationInputKey } from './relations.js';
import type { RelationInput } from '../model.js';
import type { JsonValue } from '../../value.js';

/** Validates attachment and occurrence identity before evaluation or state admission. */
export const validateRelationInputs = (
  inputs: readonly RelationInput[],
  mode: 'query' | 'incremental'
): readonly Issue[] => {
  const identities = new Set<string>();
  const issues: Issue[] = [];
  for (const input of inputs) {
    const identity = relationInputKey(input);
    if (identities.has(identity)) {
      issues.push(mode === 'incremental'
        ? incrementalQueryIssue('query.incremental_relation_ambiguous', {
            relationId: input.relation.relationId,
            attachmentId: input.attachmentId ?? null
          })
        : createIssue({
            code: 'query.input_identity_invalid',
            relationId: input.relation.relationId,
            details: {
              reason: 'duplicate_attachment_input',
              attachmentId: input.attachmentId ?? null
            }
          }));
      continue;
    }
    identities.add(identity);
    const invalidOccurrenceIds = input.occurrenceIds !== undefined
      && (
        input.occurrenceIds.length !== input.rows.length
        || new Set(input.occurrenceIds).size !== input.occurrenceIds.length
      );
    if ((mode === 'incremental' && input.rows.length > 0 && input.occurrenceIds === undefined)
      || invalidOccurrenceIds) {
      issues.push(mode === 'incremental'
        ? incrementalQueryIssue('query.incremental_identity_invalid', {
            relationId: input.relation.relationId,
            attachmentId: input.attachmentId ?? null
          })
        : createIssue({
            code: 'query.input_identity_invalid',
            relationId: input.relation.relationId,
            details: {
              reason: 'invalid_occurrence_ids',
              attachmentId: input.attachmentId ?? null
            }
          }));
    }
  }
  return issues;
};

const incrementalQueryIssue = (code: string, details: JsonValue): Issue => createIssue({
  code,
  retry: 'after_input',
  details
});
