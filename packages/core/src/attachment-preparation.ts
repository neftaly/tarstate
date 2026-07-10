import {
  safeParseArtifactText,
  safeParseArtifactValue,
  type Artifact,
  type ArtifactRef
} from './artifacts.js';
import type { AttachmentProjection, SourceSnapshot } from './database.js';
import { createIssue, type CapabilityRef, type Issue, type ParseResult } from './issues.js';
import { projectStorage, type BindingProjection, type CompiledStorageMapping } from './mapping.js';
import type { SourceBasis } from './maintenance.js';
import type { DocumentDeclaration } from './receipts.js';
import type { CapabilityRegistry } from './registry.js';
import { prepareSchema, type PreparedSchema } from './schema.js';
import {
  safeParseConstraintSetArtifact,
  safePrepareConstraintSetArtifact,
  safePrepareStorageMappingArtifact
} from './semantic-artifact-parsers.js';
import type { ProjectionResult, StorageBinding } from './source-protocol.js';
import type { SourceConstraint } from './constraints.js';
import type { JsonValue } from './value.js';

const attachmentPreparationBrand: unique symbol = Symbol('tarstate.attachment-preparation');

export type RawBootstrapDeclaration =
  | { readonly status: 'absent' }
  | { readonly status: 'ready'; readonly declaration: unknown }
  | { readonly status: 'malformed' | 'conflicted'; readonly issues?: readonly Issue[] };

export type AttachmentArtifactResolver = (reference: ArtifactRef) => unknown;

export type AttachmentConstraintQuery<State> = (
  query: JsonValue,
  state: State,
  basis: SourceBasis
) => {
  readonly rows: readonly { readonly subject: JsonValue; readonly evidence?: JsonValue; readonly details?: JsonValue }[];
  readonly completeness: 'exact' | 'lower-bound' | 'unknown';
  readonly issues: readonly Issue[];
};

export type ReadyAttachmentPreparation<Storage = unknown, Projection = unknown, ConstraintState = Storage> = {
  readonly state: 'ready';
  readonly origin: 'bootstrap' | 'out-of-band' | 'manual-read-only';
  readonly writable: boolean;
  readonly schemaViewIds: readonly string[];
  readonly declaration?: DocumentDeclaration;
  readonly schema?: PreparedSchema;
  readonly mapping?: CompiledStorageMapping;
  readonly constraints: readonly SourceConstraint<ConstraintState>[];
  readonly issues: readonly Issue[];
  readonly project: (snapshot: SourceSnapshot<Storage>) => AttachmentProjection<Projection>;
  readonly [attachmentPreparationBrand]: true;
};

export type UnavailableAttachmentPreparation = {
  readonly state: 'unavailable';
  readonly issues: readonly Issue[];
  readonly [attachmentPreparationBrand]: true;
};

export type AttachmentPreparationResult<Storage = unknown, Projection = unknown, ConstraintState = Storage> =
  | ReadyAttachmentPreparation<Storage, Projection, ConstraintState>
  | UnavailableAttachmentPreparation;

export type PrepareDatabaseAttachmentInput<State = unknown> = {
  readonly sourceId: string;
  readonly bootstrap: RawBootstrapDeclaration;
  readonly outOfBandDeclaration?: unknown;
  readonly resolveArtifact: AttachmentArtifactResolver;
  readonly registry: CapabilityRegistry;
  readonly evaluateConstraintQuery?: AttachmentConstraintQuery<State>;
  readonly resolveStorageBinding?: (reference: CapabilityRef) => StorageBinding<unknown, unknown> | undefined;
};

/**
 * Effect-isolated preparation shell: host I/O enters only through the artifact
 * resolver; semantic derivation is pure and no source handle or catalog mutates.
 */
export const prepareDatabaseAttachment = async <State = unknown>(
  input: PrepareDatabaseAttachmentInput<State>
): Promise<AttachmentPreparationResult<unknown, BindingProjection | ProjectionResult, State>> => {
  const selected = selectDeclaration(input.bootstrap, input.outOfBandDeclaration);
  if (!selected.success) return unavailable(selected.issues);
  const declaration = selected.value.declaration;
  const issues = [...selected.value.issues];
  let writable = selected.value.writable;

  const schemaArtifact = await resolveExactArtifact(declaration.storageSchema, 'schema', input.resolveArtifact);
  if (!schemaArtifact.success) return unavailable([...issues, ...schemaArtifact.issues]);
  const schema = prepareSchema(schemaArtifact.value.body);
  if (!schema.success) return unavailable([...issues, ...schema.issues]);
  const missingCodecs = input.registry.missing(schema.value.body.requiredCodecs ?? []);
  if (missingCodecs.length > 0) {
    writable = false;
    issues.push(...missingCodecs);
  }

  let mapping: CompiledStorageMapping | undefined;
  let project: ReadyAttachmentPreparation<unknown, BindingProjection | ProjectionResult, State>['project'];
  if (declaration.projection.kind === 'storage-mapping') {
    const mappingArtifact = await resolveExactArtifact(declaration.projection.storageMapping, 'storage-mapping', input.resolveArtifact);
    if (!mappingArtifact.success) return unavailable([...issues, ...mappingArtifact.issues]);
    const preparedMapping = await safePrepareStorageMappingArtifact(mappingArtifact.value, { schemaRef: declaration.storageSchema, schema: schema.value });
    if (!preparedMapping.success) return unavailable([...issues, ...preparedMapping.issues]);
    mapping = preparedMapping.value.compiled;
    const requiredWriteCapabilities = mappingCapabilities(mapping);
    const missingWriteCapabilities = input.registry.missing(requiredWriteCapabilities);
    if (missingWriteCapabilities.length > 0) {
      writable = false;
      issues.push(...missingWriteCapabilities);
    }
    project = (snapshot) => {
      if (snapshot.state !== 'ready' || snapshot.storage === undefined) return { state: snapshot.state === 'ready' ? 'failed' : snapshot.state, issues: snapshot.issues };
      const value = projectStorage(preparedMapping.value.compiled, snapshot.storage, input.registry, input.sourceId);
      return { state: 'ready', value, issues: value.issues };
    };
  } else {
    const missingBinding = input.registry.missing([declaration.projection.storageBinding]);
    const binding = missingBinding.length === 0 ? input.resolveStorageBinding?.(declaration.projection.storageBinding) : undefined;
    if (missingBinding.length > 0 || binding === undefined) {
      return unavailable([...issues, ...missingBinding, ...(binding === undefined && missingBinding.length === 0 ? [preparationIssue('observer.projection_unavailable', { reason: 'storage_binding_unavailable' })] : [])]);
    }
    project = (snapshot) => {
      if (snapshot.state !== 'ready') return { state: snapshot.state, issues: snapshot.issues };
      try {
        const value = binding.project(snapshot);
        return { state: 'ready', value, issues: value.issues };
      } catch (error) {
        return { state: 'failed', issues: [preparationIssue('observer.projection_unavailable', { reason: 'storage_binding_failed', error: errorName(error) })] };
      }
    };
  }

  let constraints: readonly SourceConstraint<State>[] = [];
  if (declaration.constraints !== undefined) {
    const constraintArtifact = await resolveExactArtifact(declaration.constraints.set, 'constraint-set', input.resolveArtifact);
    if (!constraintArtifact.success) {
      writable = false;
      issues.push(...constraintArtifact.issues);
    } else {
      const parsedConstraint = await safeParseConstraintSetArtifact(constraintArtifact.value);
      if (!parsedConstraint.success) {
        writable = false;
        issues.push(...parsedConstraint.issues);
      } else if (!sameRef(parsedConstraint.value.body.schemaView, declaration.storageSchema)) {
        writable = false;
        issues.push(preparationIssue('artifact.dependency_mismatch', { dependency: 'constraint.schemaView' }));
      } else {
        const missingConstraintCapabilities = input.registry.missing(parsedConstraint.value.body.requiredCapabilities);
        if (missingConstraintCapabilities.length > 0 || input.evaluateConstraintQuery === undefined) {
          writable = false;
          issues.push(...missingConstraintCapabilities);
          if (input.evaluateConstraintQuery === undefined) issues.push(preparationIssue('observer.projection_unavailable', { reason: 'constraint_executor_unavailable' }));
        } else {
          const preparedConstraint = await safePrepareConstraintSetArtifact<State>(parsedConstraint.value, {
            mode: declaration.constraints.mode,
            registry: input.registry,
            evaluateQuery: input.evaluateConstraintQuery
          });
          if (preparedConstraint.success) constraints = preparedConstraint.value.constraints;
          else {
            writable = false;
            issues.push(...preparedConstraint.issues);
          }
        }
      }
    }
  }

  return ready({
    origin: selected.value.origin,
    writable,
    schemaViewIds: [declaration.storageSchema.id],
    declaration,
    schema: schema.value,
    ...(mapping === undefined ? {} : { mapping }),
    constraints,
    issues,
    project
  });
};

/** Branded preparation for an already-bound projection that can never write. */
export const prepareManualReadOnlyAttachment = <Storage, Projection>(input: {
  readonly schemaViewIds: readonly string[];
  readonly project: (snapshot: SourceSnapshot<Storage>) => AttachmentProjection<Projection>;
  readonly issues?: readonly Issue[];
}): ReadyAttachmentPreparation<Storage, Projection> => ready({
  origin: 'manual-read-only',
  writable: false,
  schemaViewIds: [...new Set(input.schemaViewIds)].sort(),
  constraints: [],
  issues: input.issues ?? [],
  project: input.project
});

const selectDeclaration = (
  bootstrap: RawBootstrapDeclaration,
  outOfBand: unknown
): ParseResult<{ readonly declaration: DocumentDeclaration; readonly origin: 'bootstrap' | 'out-of-band'; readonly writable: boolean; readonly issues: readonly Issue[] }> => {
  const bootstrapIssues = bootstrap.status === 'malformed' || bootstrap.status === 'conflicted'
    ? bootstrap.issues ?? [preparationIssue('artifact.invalid_envelope', { bootstrapStatus: bootstrap.status })]
    : [];
  if (bootstrap.status === 'ready') {
    const parsed = parseDocumentDeclaration(bootstrap.declaration);
    if (parsed.success) return { success: true, value: { declaration: parsed.value, origin: 'bootstrap', writable: true, issues: [] }, issues: [] };
    if (outOfBand === undefined) return parsed;
    const override = parseDocumentDeclaration(outOfBand);
    return override.success
      ? { success: true, value: { declaration: override.value, origin: 'out-of-band', writable: false, issues: parsed.issues }, issues: [] }
      : { success: false, issues: [...parsed.issues, ...override.issues] };
  }
  if (outOfBand !== undefined) {
    const parsed = parseDocumentDeclaration(outOfBand);
    return parsed.success
      ? { success: true, value: { declaration: parsed.value, origin: 'out-of-band', writable: bootstrap.status === 'absent', issues: bootstrapIssues }, issues: [] }
      : { success: false, issues: [...bootstrapIssues, ...parsed.issues] };
  }
  return { success: false, issues: bootstrapIssues.length > 0 ? bootstrapIssues : [preparationIssue('artifact.invalid_envelope', { reason: 'declaration_absent' })] };
};

const parseDocumentDeclaration = (input: unknown): ParseResult<DocumentDeclaration> => {
  if (!isRecord(input) || input.formatVersion !== 1 || !isArtifactRef(input.storageSchema) || !isRecord(input.projection)) return declarationFailure();
  let projection: DocumentDeclaration['projection'];
  if (input.projection.kind === 'storage-mapping' && isArtifactRef(input.projection.storageMapping)) {
    projection = { kind: 'storage-mapping', storageMapping: input.projection.storageMapping };
  } else if (input.projection.kind === 'storage-binding' && isCapabilityRef(input.projection.storageBinding)) {
    projection = { kind: 'storage-binding', storageBinding: input.projection.storageBinding };
  } else return declarationFailure();
  let constraints: DocumentDeclaration['constraints'];
  if (input.constraints !== undefined) {
    if (!isRecord(input.constraints) || !isArtifactRef(input.constraints.set) || (input.constraints.mode !== 'audit' && input.constraints.mode !== 'required')) return declarationFailure();
    constraints = { set: input.constraints.set, mode: input.constraints.mode };
  }
  return {
    success: true,
    value: { formatVersion: 1, storageSchema: input.storageSchema, projection, ...(constraints === undefined ? {} : { constraints }) },
    issues: []
  };
};

const resolveExactArtifact = async (
  reference: ArtifactRef,
  kind: string,
  resolve: AttachmentArtifactResolver
): Promise<ParseResult<Artifact>> => {
  let raw: unknown;
  try { raw = await resolve(reference); }
  catch (error) { return { success: false, issues: [preparationIssue('artifact.dependency_mismatch', { artifactId: reference.id, error: errorName(error) })] }; }
  if (raw === undefined) return { success: false, issues: [preparationIssue('artifact.dependency_mismatch', { artifactId: reference.id, reason: 'missing' })] };
  const parsed = typeof raw === 'string' ? await safeParseArtifactText(raw) : await safeParseArtifactValue(raw);
  if (!parsed.success) return parsed;
  if (parsed.value.kind !== kind || !sameRef(parsed.value, reference)) {
    return { success: false, issues: [preparationIssue('artifact.dependency_mismatch', { artifactId: reference.id, expectedKind: kind, actualKind: parsed.value.kind })] };
  }
  return parsed;
};

const mappingCapabilities = (mapping: CompiledStorageMapping): readonly CapabilityRef[] => {
  const capabilities = new Map<string, CapabilityRef>();
  for (const { mapping: relation } of mapping.relations.values()) {
    for (const field of Object.values(relation.fields)) {
      if (field.write.kind !== 'replace') continue;
      const ref = field.write.capability;
      capabilities.set(ref.id + '\u0000' + ref.version + '\u0000' + ref.contractHash, ref);
    }
  }
  return [...capabilities.values()];
};

const ready = <Storage, Projection, State>(
  input: Omit<ReadyAttachmentPreparation<Storage, Projection, State>, typeof attachmentPreparationBrand | 'state'>
): ReadyAttachmentPreparation<Storage, Projection, State> => Object.freeze({ ...input, state: 'ready', [attachmentPreparationBrand]: true as const });

const unavailable = (issues: readonly Issue[]): UnavailableAttachmentPreparation => Object.freeze({ state: 'unavailable', issues: Object.freeze([...issues]), [attachmentPreparationBrand]: true as const });
const declarationFailure = (): ParseResult<never> => ({ success: false, issues: [preparationIssue('artifact.invalid_envelope', { reason: 'document_declaration' })] });
const preparationIssue = (code: string, details: JsonValue): Issue => createIssue({ code, phase: 'resolve', severity: 'error', retry: code === 'capability.missing' ? 'after_capability' : 'after_refresh', details });
const sameRef = (left: ArtifactRef, right: ArtifactRef): boolean => left.id === right.id && left.contentHash === right.contentHash;
const isArtifactRef = (value: unknown): value is ArtifactRef => isRecord(value) && typeof value.id === 'string' && /^sha256:[0-9a-f]{64}$/.test(String(value.contentHash));
const isCapabilityRef = (value: unknown): value is CapabilityRef => isRecord(value) && typeof value.id === 'string' && typeof value.version === 'string' && /^sha256:[0-9a-f]{64}$/.test(String(value.contractHash));
const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> => value !== null && typeof value === 'object' && !Array.isArray(value);
const errorName = (error: unknown): string => error instanceof Error ? error.name : typeof error;
