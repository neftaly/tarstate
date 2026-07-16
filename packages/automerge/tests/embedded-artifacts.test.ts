import { describe, expect, it } from 'vitest';
import {
  embeddedArtifactKey,
  indexEmbeddedArtifacts
} from '../src/attachment/embedded-artifacts.js';

const artifact = {
  id: 'urn:test:embedded',
  contentHash: `sha256:${'a'.repeat(64)}`
} as const;

describe('embedded artifact indexing', () => {
  it('indexes arrays and exact ID-keyed records with the same lookup identity', () => {
    const array = indexEmbeddedArtifacts([artifact]);
    const record = indexEmbeddedArtifacts({ [artifact.id]: artifact });
    const key = embeddedArtifactKey(artifact.id, artifact.contentHash);

    expect(array.success && array.value.get(key)).toEqual(artifact);
    expect(record.success && record.value.get(key)).toEqual(artifact);
  });

  it('rejects misleading record keys and ambiguous exact duplicates', () => {
    expect(indexEmbeddedArtifacts({ 'urn:test:other': artifact })).toMatchObject({
      success: false,
      issues: [{ details: { reason: 'embedded_artifact_id_mismatch' } }]
    });
    expect(indexEmbeddedArtifacts([artifact, artifact])).toMatchObject({
      success: false,
      issues: [{ details: { reason: 'embedded_artifact_duplicate' } }]
    });
  });
});
