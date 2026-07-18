import { createIssue, type ParseResult } from '../issues.js';
import type { JsonValue } from '../value.js';

/** Indexes an owned embedded artifact collection by exact id and content hash. */
export const indexEmbeddedArtifacts = (
  input: JsonValue
): ParseResult<ReadonlyMap<string, JsonValue>> => {
  if (!Array.isArray(input) && !isRecord(input)) return failure('embedded_artifacts_collection_required');
  try {
    const candidates: readonly JsonValue[] = Array.isArray(input)
      ? input
      : Object.entries(input).map(([id, artifact]) => {
          if (!isRecord(artifact) || artifact.id !== id) {
            throw new EmbeddedArtifactError('embedded_artifact_id_mismatch');
          }
          return artifact as JsonValue;
        });
    const artifacts = new Map<string, JsonValue>();
    for (const candidate of candidates) {
      if (!isRecord(candidate)
        || typeof candidate.id !== 'string'
        || typeof candidate.contentHash !== 'string') continue;
      const key = embeddedArtifactKey(candidate.id, candidate.contentHash);
      if (artifacts.has(key)) return failure('embedded_artifact_duplicate');
      artifacts.set(key, candidate as JsonValue);
    }
    return { success: true, value: artifacts, issues: [] };
  } catch (error) {
    if (error instanceof EmbeddedArtifactError) return failure(error.message);
    throw error;
  }
};

export const embeddedArtifactKey = (id: string, contentHash: string): string =>
  id + '\0' + contentHash;

class EmbeddedArtifactError extends Error {}

const failure = (reason: string): ParseResult<never> => ({
  success: false,
  issues: [createIssue({
    code: 'artifact.invalid_envelope',
    retry: 'after_input',
    details: { reason }
  })]
});

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
