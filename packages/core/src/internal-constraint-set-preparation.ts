import { compileSourceConstraints, type ConstraintSetArtifact } from './constraint-artifact.js';
import type { SourceConstraint } from './constraints.js';
import { createIssue, type Issue, type ParseResult } from './issues.js';
import type { CapabilityRegistry } from './registry.js';
import type { SourceBasis } from './source-state.js';
import type { JsonValue } from './value.js';

export type ConstraintSetPreparationOptions<State> = {
  readonly mode: 'audit' | 'required';
  /** Required executor capabilities must be present before a set can become active. */
  readonly registry?: CapabilityRegistry;
  readonly evaluateQuery: (query: JsonValue, state: State, basis: SourceBasis) => {
    readonly rows: readonly {
      readonly subject: JsonValue;
      readonly evidence?: JsonValue;
      readonly details?: JsonValue;
    }[];
    readonly completeness: 'exact' | 'lower-bound' | 'unknown';
    readonly issues: readonly Issue[];
  };
};

/** Pure compilation for an artifact that has already crossed the semantic parse boundary. */
export const prepareParsedConstraintSetArtifact = <State>(
  artifact: ConstraintSetArtifact,
  options: ConstraintSetPreparationOptions<State>
): ParseResult<{
  readonly artifact: ConstraintSetArtifact;
  readonly constraints: readonly SourceConstraint<State>[];
}> => {
  const missing = options.registry === undefined
    ? artifact.body.requiredCapabilities.map((required) => createIssue({
        code: 'capability.missing',
        retry: 'after_capability',
        requiredCapabilities: [required]
      }))
    : options.registry.missing(artifact.body.requiredCapabilities);

  if (missing.length > 0) return { success: false, issues: missing };

  return {
    success: true,
    value: {
      artifact,
      constraints: compileSourceConstraints({
        set: artifact,
        mode: options.mode,
        evaluateQuery: options.evaluateQuery
      })
    },
    issues: []
  };
};
