import type { TarstateDiagnostic } from './diagnostics.js';
import type { EvaluateOptions } from './evaluate.js';
import type { RelationSource } from './source.js';
import type { RelationSourceInput } from './source-input.js';
import type { ConstraintData, ConstraintSet } from './constraints.js';
import { attachedConstraintsFor, constraintDataList } from './constraints-attachment.js';
import { stubDiagnostic } from './stub.js';

export type ConstraintValidationInput = ConstraintSet | readonly ConstraintData[];

export type ConstraintValidationResult = {
  readonly kind: 'constraintValidation';
  readonly valid: boolean;
  readonly diagnostics: readonly TarstateDiagnostic[];
};

export type ConstraintValidationOptions = EvaluateOptions;

export async function validateConstraints(
  _source: RelationSource,
  input: ConstraintValidationInput,
  _options: ConstraintValidationOptions = {}
): Promise<ConstraintValidationResult> {
  const constraints = constraintDataList(input);

  return {
    kind: 'constraintValidation',
    valid: constraints.length === 0,
    diagnostics: constraints.length === 0 ? [] : [stubDiagnostic('constraints')]
  };
}

export async function validateAttachedConstraints(
  input: RelationSourceInput,
  _options: ConstraintValidationOptions = {}
): Promise<ConstraintValidationResult> {
  const constraints = attachedConstraintsFor(input);

  return {
    kind: 'constraintValidation',
    valid: constraints.length === 0,
    diagnostics: constraints.length === 0 ? [] : [stubDiagnostic('constraints')]
  };
}
