import type { ArtifactRef } from '../artifacts.js';
import { isContentHash } from '../canonical-json.js';
import type { CapabilityRef } from '../issues.js';
import { detachAndFreezeJsonValue } from '../internal-owned-json.js';
import type { DocumentDeclaration } from './model.js';

type JsonRecord = Readonly<Record<string, unknown>>;

/** Adopts an untrusted declaration once and returns an owned, normalized value. */
export const adoptDocumentDeclaration = (input: unknown): DocumentDeclaration | undefined => {
  const owned = detachAndFreezeJsonValue(input);
  if (!owned.success || !isValidDocumentDeclaration(owned.value)) return undefined;
  return ownDocumentDeclaration(owned.value);
};

/** Validation for values already adopted by an enclosing portable-data boundary. */
export const isValidDocumentDeclaration = (value: unknown): value is DocumentDeclaration => {
  if (!isRecord(value)
    || !hasOnlyKeys(value, ['formatVersion', 'storageSchema', 'projection', 'constraints'])
    || value.formatVersion !== 1) return false;
  if (!isArtifactRef(value.storageSchema) || !isValidDocumentProjection(value.projection)) {
    return false;
  }
  return value.constraints === undefined || (
    isRecord(value.constraints)
    && hasOnlyKeys(value.constraints, ['set', 'mode'])
    && isArtifactRef(value.constraints.set)
    && (value.constraints.mode === 'audit' || value.constraints.mode === 'required')
  );
};

export const isValidDocumentProjection = (
  value: unknown
): value is DocumentDeclaration['projection'] => isRecord(value) && (
  value.kind === 'storage-mapping'
    ? hasOnlyKeys(value, ['kind', 'storageMapping']) && isArtifactRef(value.storageMapping)
    : value.kind === 'storage-binding'
      && hasOnlyKeys(value, ['kind', 'storageBinding'])
      && isCapabilityRef(value.storageBinding)
);

/** Canonical semantic form used by governance hashing; transport locations are not identity. */
export const normalizeDocumentDeclaration = (
  declaration: DocumentDeclaration
): DocumentDeclaration => ({
  formatVersion: 1,
  storageSchema: normalizeArtifactRef(declaration.storageSchema),
  projection: normalizeDocumentProjection(declaration.projection),
  ...(declaration.constraints === undefined
    ? {}
    : {
        constraints: {
          set: normalizeArtifactRef(declaration.constraints.set),
          mode: declaration.constraints.mode
        }
      })
});

export const normalizeDocumentProjection = (
  projection: DocumentDeclaration['projection']
): DocumentDeclaration['projection'] => projection.kind === 'storage-mapping'
  ? { kind: 'storage-mapping', storageMapping: normalizeArtifactRef(projection.storageMapping) }
  : { kind: 'storage-binding', storageBinding: normalizeCapabilityRef(projection.storageBinding) };

const ownDocumentDeclaration = (declaration: DocumentDeclaration): DocumentDeclaration => Object.freeze({
  formatVersion: 1,
  storageSchema: ownArtifactRef(declaration.storageSchema),
  projection: declaration.projection.kind === 'storage-mapping'
    ? Object.freeze({
        kind: 'storage-mapping' as const,
        storageMapping: ownArtifactRef(declaration.projection.storageMapping)
      })
    : Object.freeze({
        kind: 'storage-binding' as const,
        storageBinding: Object.freeze({ ...declaration.projection.storageBinding })
      }),
  ...(declaration.constraints === undefined
    ? {}
    : {
        constraints: Object.freeze({
          set: ownArtifactRef(declaration.constraints.set),
          mode: declaration.constraints.mode
        })
      })
});

const ownArtifactRef = (reference: ArtifactRef): ArtifactRef => Object.freeze({
  id: reference.id,
  contentHash: reference.contentHash,
  ...(reference.locations === undefined
    ? {}
    : { locations: Object.freeze([...reference.locations]) })
});

const normalizeArtifactRef = (reference: ArtifactRef): ArtifactRef => ({
  id: reference.id,
  contentHash: reference.contentHash
});

const normalizeCapabilityRef = (reference: CapabilityRef): CapabilityRef => ({
  id: reference.id,
  version: reference.version,
  contractHash: reference.contractHash
});

const isArtifactRef = (value: unknown): value is ArtifactRef => isRecord(value)
  && hasOnlyKeys(value, ['id', 'contentHash', 'locations'])
  && nonEmptyString(value.id)
  && isContentHash(value.contentHash)
  && (
    value.locations === undefined
    || (Array.isArray(value.locations) && value.locations.every(nonEmptyString))
  );

const isCapabilityRef = (value: unknown): value is CapabilityRef => isRecord(value)
  && hasOnlyKeys(value, ['id', 'version', 'contractHash'])
  && nonEmptyString(value.id)
  && nonEmptyString(value.version)
  && isContentHash(value.contractHash);

const isRecord = (value: unknown): value is JsonRecord => value !== null
  && typeof value === 'object'
  && !Array.isArray(value);

const nonEmptyString = (value: unknown): value is string => typeof value === 'string'
  && value.length > 0;

const hasOnlyKeys = (value: JsonRecord, allowed: readonly string[]): boolean =>
  Object.keys(value).every((key) => allowed.includes(key));
