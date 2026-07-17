import {
  defaultArtifactParseBudget,
  type Artifact,
  type ArtifactParseBudget
} from '@tarstate/core';
import type { DocumentDeclaration } from '@tarstate/core/attachment';
import type { PreparedSchema, SchemaBody } from '@tarstate/core/schema';

export type ArtifactBuildManifest = {
  /** Stable build names for every artifact in the closed bundle. */
  readonly artifacts: Readonly<Record<string, Artifact>>;
  /** Portable document declarations included beside the artifact closure. */
  readonly declarations?: Readonly<Record<string, DocumentDeclaration>>;
  /** Generated exact relation bindings, keyed by their application-facing name. */
  readonly relations?: Readonly<Record<string, {
    readonly schema: string;
    readonly relation: string;
  }>>;
};

export type ArtifactBuildBundle = {
  readonly formatVersion: 1;
  readonly artifacts: readonly Artifact[];
  readonly declarations: Readonly<Record<string, DocumentDeclaration>>;
};

export type ArtifactBuildOutputs = {
  readonly bundle: ArtifactBuildBundle;
  readonly bundleJson: string;
  readonly bindingsTypeScript: string;
};

export type ArtifactBuildBudget = ArtifactParseBudget & {
  readonly maxArtifacts: number;
  readonly maxDeclarations: number;
  readonly maxRelationBindings: number;
};

export const defaultArtifactBuildBudget: ArtifactBuildBudget = Object.freeze({
  ...defaultArtifactParseBudget,
  maxArtifacts: 10_000,
  maxDeclarations: 10_000,
  maxRelationBindings: 10_000
});

export type PreparedArtifactBuildManifest = {
  readonly artifacts: Readonly<Record<string, Artifact>>;
  readonly declarations: Readonly<Record<string, DocumentDeclaration>>;
  readonly relations: readonly PreparedRelationBinding[];
};

export type PreparedRelationBinding = {
  readonly name: string;
  readonly schemaName: string;
  readonly relationName: string;
  readonly schemaBody: SchemaBody;
  readonly schema: PreparedSchema;
};
