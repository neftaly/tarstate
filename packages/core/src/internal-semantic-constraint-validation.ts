import {
  checkSemanticNameBudget as checkNameBudget,
  semanticArtifactRefKey as refKey,
  semanticInvalid as invalid,
  semanticNonEmptyString as nonEmptyString,
  semanticShape as shape,
  semanticStringArray as stringArray,
  validateSemanticArtifactRef as validateArtifactRef,
  type SemanticRecord as RecordValue,
  type SemanticValidationContext as ValidationContext
} from './internal-semantic-artifact-validation.js';
import {
  createQueryValidationState,
  reportUndeclaredCapabilities,
  validateQueryNode,
  validateUniqueCapabilities
} from './internal-semantic-query-validation.js';
import type { JsonValue } from './value.js';

export const validateConstraintSetArtifactBody = (
  context: ValidationContext,
  body: JsonValue
): boolean => {
  if (!shape(context, body, ['schemaView', 'constraints', 'requiredCapabilities'], [], ['body'])) {
    return false;
  }
  const value = body as RecordValue;
  const schema = validateArtifactRef(context, value.schemaView, ['body', 'schemaView']);
  const capabilities = validateUniqueCapabilities(
    context,
    value.requiredCapabilities,
    ['body', 'requiredCapabilities']
  );
  const state = createQueryValidationState({
    parameters: new Set(),
    schemaViews: new Map(schema === undefined ? [] : [[refKey(schema), schema]]),
    requiredCapabilities: capabilities
  });

  if (!Array.isArray(value.constraints)) {
    invalid(context, ['body', 'constraints'], 'array_required');
  } else {
    const ids = new Set<string>();
    checkNameBudget(context, value.constraints.length, ['body', 'constraints']);
    value.constraints.forEach((constraint, index) => {
      const path = ['body', 'constraints', index];
      if (!shape(
        context,
        constraint,
        ['id', 'code', 'dependencyRelations', 'violationQuery'],
        [],
        path
      )) {
        return;
      }
      const record = constraint as RecordValue;
      const id = nonEmptyString(context, record.id, [...path, 'id']);
      if (id !== undefined && ids.has(id)) {
        invalid(context, [...path, 'id'], 'duplicate_constraint_id');
      } else if (id !== undefined) {
        ids.add(id);
      }
      nonEmptyString(context, record.code, [...path, 'code']);
      stringArray(
        context,
        record.dependencyRelations,
        [...path, 'dependencyRelations'],
        true
      );
      validateQueryNode(
        context,
        record.violationQuery,
        [...path, 'violationQuery'],
        new Set(),
        state,
        0
      );
    });
  }

  reportUndeclaredCapabilities(context, state);
  return context.issues.length === 0;
};
