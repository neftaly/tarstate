import type { Artifact, ParseResult } from '@tarstate/core';
import {
  artifactReferenceEdges,
  missingArtifactReference,
  type ArtifactReferenceEdge
} from './references.js';

export const indexArtifacts = (
  artifacts: readonly Artifact[]
): ReadonlyMap<string, Artifact> => {
  const byId = new Map<string, Artifact>();
  for (const artifact of artifacts) byId.set(artifact.id, artifact);
  return byId;
};

export const selectArtifactClosure = (
  roots: readonly ArtifactReferenceEdge[],
  rootOwner: string,
  byId: ReadonlyMap<string, Artifact>
): ParseResult<Readonly<Record<string, Artifact>>> => {
  const selected = new Map<string, Artifact>();
  const pending = roots.map((edge) => ({ edge, owner: rootOwner }));
  while (pending.length > 0) {
    const next = pending.pop();
    if (next === undefined) break;
    const missing = missingArtifactReference(
      next.edge.ref,
      byId,
      next.owner,
      next.edge.kind
    );
    if (missing !== undefined) return missing;
    const resolved = byId.get(next.edge.ref.id);
    if (resolved === undefined || selected.has(resolved.id)) continue;
    selected.set(resolved.id, resolved);
    const references = artifactReferenceEdges(resolved);
    if (!references.success) return references;
    for (const edge of references.value) {
      pending.push({ edge, owner: resolved.id });
    }
  }
  const entries = [...selected.entries()].sort(compareEntries);
  return {
    success: true,
    value: Object.freeze(Object.fromEntries(entries)),
    issues: []
  };
};

const compareEntries = (
  [left]: readonly [string, Artifact],
  [right]: readonly [string, Artifact]
): number => left < right ? -1 : left > right ? 1 : 0;
