import { sealArtifact, type Artifact, type ArtifactKind, type ArtifactRef } from './artifacts.js';
import type { JsonValue } from './value.js';

export type TypedArtifact<Kind extends ArtifactKind, Body> = Omit<Artifact, 'body' | 'kind'> & { readonly kind: Kind; readonly body: Body };
export type TypedArtifactInput<Body> = { readonly id?: string; readonly dependencies?: readonly ArtifactRef[]; readonly body: Body };

export const sealTypedArtifact = <Kind extends ArtifactKind, Body>(kind: Kind, input: TypedArtifactInput<Body>): Promise<TypedArtifact<Kind, Body>> => sealArtifact({
  kind,
  ...(input.id === undefined ? {} : { id: input.id }),
  ...(input.dependencies === undefined ? {} : { dependencies: input.dependencies }),
  body: input.body as JsonValue
}) as Promise<TypedArtifact<Kind, Body>>;
