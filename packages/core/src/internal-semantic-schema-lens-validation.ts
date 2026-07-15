import { stringTupleKey } from './internal-string-key.js';
import {
  checkSemanticNameBudget,
  isSemanticRecord,
  semanticEnumValue,
  semanticInvalid,
  semanticNonEmptyString,
  semanticShape,
  semanticStringArray,
  validateSemanticArtifactRef,
  validateSemanticCapabilityRef,
  type SemanticRecord,
  type SemanticValidationContext
} from './internal-semantic-artifact-validation.js';
import type { JsonValue } from './value.js';

export const validateSchemaLensArtifactBody = (
  context: SemanticValidationContext,
  body: JsonValue
): boolean => {
  if (!semanticShape(context, body, ['from', 'to', 'relations'], [], ['body'])) return false;
  validateSemanticArtifactRef(context, body.from, ['body', 'from']);
  validateSemanticArtifactRef(context, body.to, ['body', 'to']);
  if (!Array.isArray(body.relations)) {
    semanticInvalid(context, ['body', 'relations'], 'array_required');
    return false;
  }
  const pairs = new Set<string>();
  checkSemanticNameBudget(context, body.relations.length, ['body', 'relations']);
  body.relations.forEach((relation, index) => {
    validateRelationLens(context, relation, ['body', 'relations', index], pairs);
  });
  return context.issues.length === 0;
};

const validateRelationLens = (
  context: SemanticValidationContext,
  input: JsonValue,
  path: readonly unknown[],
  pairs: Set<string>
): void => {
  if (!semanticShape(context, input, ['fromRelationId', 'toRelationId', 'steps'], [], path)) return;
  const from = semanticNonEmptyString(context, input.fromRelationId, [...path, 'fromRelationId']);
  const to = semanticNonEmptyString(context, input.toRelationId, [...path, 'toRelationId']);
  if (from !== undefined && to !== undefined) {
    const pair = stringTupleKey(from, to);
    if (pairs.has(pair)) semanticInvalid(context, path, 'duplicate_lens_relation');
    else pairs.add(pair);
  }
  if (!Array.isArray(input.steps)) {
    semanticInvalid(context, [...path, 'steps'], 'array_required');
    return;
  }
  input.steps.forEach((step, index) => validateLensStep(context, step, [...path, 'steps', index]));
};

const validateLensStep = (
  context: SemanticValidationContext,
  input: JsonValue,
  path: readonly unknown[]
): void => {
  if (!isSemanticRecord(input) || typeof input.kind !== 'string') {
    semanticInvalid(context, path, 'lens_step_shape');
    return;
  }
  if (input.kind === 'lens.field') {
    semanticShape(context, input, ['kind', 'from', 'to', 'write'], [], path);
    semanticNonEmptyString(context, input.from, [...path, 'from']);
    semanticNonEmptyString(context, input.to, [...path, 'to']);
    semanticEnumValue(context, input.write, ['invertible', 'read-only'], [...path, 'write']);
    return;
  }
  if (input.kind === 'lens.default') {
    semanticShape(context, input, ['kind', 'to', 'value', 'write'], [], path);
    semanticNonEmptyString(context, input.to, [...path, 'to']);
    if (input.write !== 'preserve') semanticInvalid(context, [...path, 'write'], 'default_write_policy');
    return;
  }
  if (input.kind === 'lens.hide') {
    semanticShape(context, input, ['kind', 'from', 'write'], [], path);
    semanticNonEmptyString(context, input.from, [...path, 'from']);
    if (input.write !== 'preserve') semanticInvalid(context, [...path, 'write'], 'hide_write_policy');
    return;
  }
  if (input.kind === 'lens.value-map') {
    validateValueMapStep(context, input, path);
    return;
  }
  if (input.kind === 'lens.lookup') {
    validateLookupStep(context, input, path);
    return;
  }
  if (input.kind === 'extension') {
    semanticShape(context, input, ['kind', 'capability', 'payload'], [], path);
    validateSemanticCapabilityRef(context, input.capability, [...path, 'capability']);
    return;
  }
  semanticInvalid(context, [...path, 'kind'], 'unknown_lens_step');
};

const validateValueMapStep = (
  context: SemanticValidationContext,
  step: SemanticRecord,
  path: readonly unknown[]
): void => {
  semanticShape(context, step, ['kind', 'from', 'to', 'cases', 'unmapped'], [], path);
  semanticNonEmptyString(context, step.from, [...path, 'from']);
  semanticNonEmptyString(context, step.to, [...path, 'to']);
  if (step.unmapped !== 'reject') semanticInvalid(context, [...path, 'unmapped'], 'unmapped_policy');
  if (!Array.isArray(step.cases) || step.cases.length === 0) {
    semanticInvalid(context, [...path, 'cases'], 'non_empty_array_required');
    return;
  }
  step.cases.forEach((entry, index) => {
    const entryPath = [...path, 'cases', index];
    if (semanticShape(context, entry, ['from', 'to', 'writeBack'], [], entryPath)) {
      semanticEnumValue(context, entry.writeBack, ['to-from', 'same-only', 'reject'], [...entryPath, 'writeBack']);
    }
  });
};

const validateLookupStep = (
  context: SemanticValidationContext,
  step: SemanticRecord,
  path: readonly unknown[]
): void => {
  semanticShape(
    context,
    step,
    ['kind', 'from', 'to', 'through', 'sourceFields', 'resultFields', 'onMissing', 'onAmbiguous', 'write'],
    [],
    path
  );
  semanticNonEmptyString(context, step.from, [...path, 'from']);
  semanticNonEmptyString(context, step.to, [...path, 'to']);
  validateRelationUse(context, step.through, [...path, 'through']);
  semanticStringArray(context, step.sourceFields, [...path, 'sourceFields'], true);
  semanticStringArray(context, step.resultFields, [...path, 'resultFields'], true);
  if (step.onMissing !== 'reject') semanticInvalid(context, [...path, 'onMissing'], 'lookup_missing_policy');
  if (step.onAmbiguous !== 'reject') semanticInvalid(context, [...path, 'onAmbiguous'], 'lookup_ambiguous_policy');
  semanticEnumValue(context, step.write, ['invertible', 'read-only'], [...path, 'write']);
};

const validateRelationUse = (
  context: SemanticValidationContext,
  input: JsonValue | undefined,
  path: readonly unknown[]
): void => {
  if (!semanticShape(context, input, ['schemaView', 'relationId'], [], path)) return;
  validateSemanticArtifactRef(context, input.schemaView, [...path, 'schemaView']);
  semanticNonEmptyString(context, input.relationId, [...path, 'relationId']);
};
