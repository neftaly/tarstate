import type { JsonValue, ParseResult } from '@tarstate/core';
import { schemaToolsFailure } from '../internal-issues.js';

export const artifactBuildFailure = <Value = never>(
  reason: string,
  details: JsonValue = {}
): ParseResult<Value> => schemaToolsFailure(
  'schema_tools.artifact_build_invalid',
  { reason, details }
);
