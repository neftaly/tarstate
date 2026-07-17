import {
  isContentHash,
  type Artifact,
  type ArtifactKind,
  type ArtifactRef,
  type JsonValue,
  type ParseResult
} from '@tarstate/core';
import type { DocumentDeclaration } from '@tarstate/core/attachment/declaration';
import { safeParseArtifactBuildBundle } from './bundle.js';
import { indexArtifacts, selectArtifactClosure } from './closure.js';
import { artifactBuildFailure } from './failure.js';
import {
  declarationArtifactReferences
} from './references.js';
import {
  defaultArtifactBuildBudget,
  type ArtifactBuildBudget,
  type ArtifactBuildBundle
} from './model.js';

type DeclarationNames<Input> = Input extends {
  readonly declarations: infer Declarations;
} ? Extract<keyof Declarations, string> : string;

type ArtifactOfKind<Kind extends ArtifactKind> = Artifact & { readonly kind: Kind };

export type ArtifactBundleAttachment = {
  readonly declaration: DocumentDeclaration;
  readonly artifacts: Readonly<Record<string, Artifact>>;
};

export type PreparedArtifactBundleCatalog<DeclarationName extends string = string> = {
  readonly artifact: <Kind extends ArtifactKind>(
    reference: ArtifactRef,
    expectedKind: Kind
  ) => ParseResult<ArtifactOfKind<Kind>>;
  readonly attachment: (
    name: DeclarationName
  ) => ParseResult<ArtifactBundleAttachment>;
};

/** Parses one untrusted portable bundle and exposes exact, source-neutral runtime selections. */
export const prepareArtifactBundle = async <const Input>(
  input: Input,
  budget: ArtifactBuildBudget = defaultArtifactBuildBudget
): Promise<ParseResult<PreparedArtifactBundleCatalog<DeclarationNames<Input>>>> => {
  const parsed = await safeParseArtifactBuildBundle(input, budget);
  if (!parsed.success) return parsed;
  return {
    success: true,
    value: createCatalog<DeclarationNames<Input>>(parsed.value),
    issues: []
  };
};

const createCatalog = <DeclarationName extends string>(
  bundle: ArtifactBuildBundle
): PreparedArtifactBundleCatalog<DeclarationName> => {
  const byId = indexArtifacts(bundle.artifacts);

  const artifact = <Kind extends ArtifactKind>(
    reference: ArtifactRef,
    expectedKind: Kind
  ): ParseResult<ArtifactOfKind<Kind>> => {
    const identity = parseReferenceIdentity(reference);
    if (identity === undefined) return artifactBuildFailure('artifact_lookup', {
      reference: null,
      expectedKind
    });
    const resolved = byId.get(identity.id);
    if (resolved === undefined
      || resolved.contentHash !== identity.contentHash
      || resolved.kind !== expectedKind) {
      return artifactBuildFailure('artifact_lookup', {
        reference: identity,
        expectedKind,
        ...(resolved === undefined
          ? { actual: null }
          : { actual: artifactIdentity(resolved) })
      });
    }
    return {
      success: true,
      value: resolved as ArtifactOfKind<Kind>,
      issues: []
    };
  };

  const attachment = (
    name: DeclarationName
  ): ParseResult<ArtifactBundleAttachment> => {
    if (!Object.hasOwn(bundle.declarations, name)) {
      return artifactBuildFailure('declaration_missing', { name });
    }
    const declaration = bundle.declarations[name];
    if (declaration === undefined) {
      return artifactBuildFailure('declaration_missing', { name });
    }
    const selected = selectArtifactClosure(
      declarationArtifactReferences(declaration),
      'declaration:' + name,
      byId
    );
    if (!selected.success) return selected;
    return {
      success: true,
      value: Object.freeze({
        declaration,
        artifacts: selected.value
      }),
      issues: []
    };
  };

  return Object.freeze({ artifact, attachment });
};

const parseReferenceIdentity = (
  value: unknown
): { readonly id: string; readonly contentHash: string } | undefined => {
  if (!isRecord(value)
    || typeof value.id !== 'string'
    || value.id.length === 0
    || !isContentHash(value.contentHash)) {
    return undefined;
  }
  return { id: value.id, contentHash: value.contentHash };
};

const artifactIdentity = (artifact: Artifact): JsonValue => ({
  kind: artifact.kind,
  id: artifact.id,
  contentHash: artifact.contentHash
});

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
