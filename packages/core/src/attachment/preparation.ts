import {
  safeParseArtifactText,
  safeParseArtifactValue,
  type Artifact,
  type ArtifactKind,
  type ArtifactRef
} from '../artifacts.js';
import type { ExactArtifactResolution, ExactArtifactResolver } from '../artifact-resolver.js';
import type { AttachmentProjection, DocumentDeclaration } from './model.js';
import { createIssue, type CapabilityRef, type Issue, type ParseResult } from '../issues.js';
import { detachAndFreezeJsonValue } from '../internal-owned-json.js';
import { adoptDocumentDeclaration } from '../internal-document-declaration.js';
import { ownedReadonlyMap } from '../internal-owned-map.js';
import { stringTupleKey } from '../internal-string-key.js';
import { comparePortableStrings } from '../portable-order.js';
import { projectStorage, type BindingProjection, type CompiledStorageMapping } from '../mapping.js';
import type { CapabilityRegistry } from '../registry.js';
import { prepareSchema, type PreparedSchema } from '../schema.js';
import {
  safeParseConstraintSetArtifact
} from '../semantic-constraint-artifact.js';
import { prepareParsedConstraintSetArtifact } from '../internal-constraint-set-preparation.js';
import { safePrepareStorageMappingArtifact } from '../semantic-storage-mapping-artifact.js';
import type { ProjectionResult, StorageBinding } from '../source-protocol.js';
import type { SourceBasis, SourceSnapshot } from '../source-state.js';
import type { SourceConstraint } from '../constraints.js';
import type { JsonValue } from '../value.js';

const attachmentPreparationBrand: unique symbol = Symbol('tarstate.attachment-preparation');

export type RawBootstrapDeclaration =
  | { readonly status: 'absent' }
  | { readonly status: 'ready'; readonly declaration: unknown }
  | { readonly status: 'malformed' | 'conflicted'; readonly issues?: readonly Issue[] };

export type AttachmentArtifactResolver = (reference: ArtifactRef, expectedKind?: ArtifactKind) => unknown;

/** Adapts lifecycle-rich exact resolution without collapsing its issues. */
export const exactArtifactAttachmentResolver = (
  resolver: ExactArtifactResolver,
  options: { readonly authorityScope: string; readonly signal?: AbortSignal }
): AttachmentArtifactResolver => (reference, expectedKind) => resolver.resolve({
  expectedKind: expectedKind ?? 'schema',
  reference,
  authorityScope: options.authorityScope,
  ...(options.signal === undefined ? {} : { signal: options.signal })
});

export type AttachmentConstraintQuery<State> = (
  query: JsonValue,
  state: State,
  basis: SourceBasis
) => {
  readonly rows: readonly { readonly subject: JsonValue; readonly evidence?: JsonValue; readonly details?: JsonValue }[];
  readonly completeness: 'exact' | 'lower-bound' | 'unknown';
  readonly issues: readonly Issue[];
};

export type AttachmentConstraintQueryFactory<State> = (input: {
  readonly schemaView: ArtifactRef;
  readonly relationIds: readonly string[];
  readonly registry: CapabilityRegistry;
}) => AttachmentConstraintQuery<State>;

export type PreparedAttachmentRelation = {
  readonly relationId: string;
  readonly keyFields: readonly string[];
  readonly replaceableFields: readonly string[];
};

export type ReadyAttachmentPreparation<Storage = unknown, Projection = unknown, ConstraintState = Storage> = {
  readonly state: 'ready';
  readonly origin: 'bootstrap' | 'out-of-band' | 'manual-read-only';
  readonly writable: boolean;
  readonly schemaViewIds: readonly string[];
  readonly declaration?: DocumentDeclaration;
  readonly schema?: PreparedSchema;
  readonly mapping?: CompiledStorageMapping;
  readonly relations: ReadonlyMap<string, PreparedAttachmentRelation>;
  readonly constraints: readonly SourceConstraint<ConstraintState>[];
  readonly artifactResolutions: readonly ExactArtifactResolution[];
  readonly issues: readonly Issue[];
  readonly project: (snapshot: SourceSnapshot<Storage>) => AttachmentProjection<Projection>;
  readonly [attachmentPreparationBrand]: true;
};

export type UnavailableAttachmentPreparation = {
  readonly state: 'unavailable';
  readonly artifactResolutions: readonly ExactArtifactResolution[];
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
  readonly createConstraintQuery?: AttachmentConstraintQueryFactory<State>;
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
  const artifactResolutions: ExactArtifactResolution[] = [];
  let writable = selected.value.writable;

  const schemaArtifact = await resolveExactArtifact(declaration.storageSchema, 'schema', input.resolveArtifact);
  if (schemaArtifact.resolution !== undefined) artifactResolutions.push(schemaArtifact.resolution);
  if (!schemaArtifact.success) return unavailable([...issues, ...schemaArtifact.issues], artifactResolutions);
  const schema = prepareSchema(schemaArtifact.value.body);
  if (!schema.success) return unavailable([...issues, ...schema.issues], artifactResolutions);
  const missingCodecs = input.registry.missing(schema.value.body.requiredCodecs ?? []);
  if (missingCodecs.length > 0) {
    writable = false;
    issues.push(...missingCodecs);
  }

  let mapping: CompiledStorageMapping | undefined;
  let project: ReadyAttachmentPreparation<unknown, BindingProjection | ProjectionResult, State>['project'];
  if (declaration.projection.kind === 'storage-mapping') {
    const mappingArtifact = await resolveExactArtifact(declaration.projection.storageMapping, 'storage-mapping', input.resolveArtifact);
    if (mappingArtifact.resolution !== undefined) artifactResolutions.push(mappingArtifact.resolution);
    if (!mappingArtifact.success) return unavailable([...issues, ...mappingArtifact.issues], artifactResolutions);
    const preparedMapping = await safePrepareStorageMappingArtifact(mappingArtifact.value, { schemaRef: declaration.storageSchema, schema: schema.value });
    if (!preparedMapping.success) return unavailable([...issues, ...preparedMapping.issues], artifactResolutions);
    mapping = preparedMapping.value.compiled;
    const requiredWriteCapabilities = mappingCapabilities(mapping);
    const missingWriteCapabilities = input.registry.missing(requiredWriteCapabilities);
    if (missingWriteCapabilities.length > 0) {
      writable = false;
      issues.push(...missingWriteCapabilities);
    }
    project = (snapshot) => {
      if (snapshot.state !== 'ready' || snapshot.storage === undefined) return { state: snapshot.state === 'ready' ? 'failed' : snapshot.state, issues: snapshot.issues };
      const value = projectStorage(preparedMapping.value.compiled, snapshot.storage, {
        registry: input.registry,
        sourceId: input.sourceId
      });
      return { state: 'ready', value, issues: value.issues };
    };
  } else {
    const missingBinding = input.registry.missing([declaration.projection.storageBinding]);
    let binding: StorageBinding<unknown, unknown> | undefined;
    if (missingBinding.length === 0) {
      try {
        binding = input.resolveStorageBinding?.(declaration.projection.storageBinding);
      } catch (error) {
        return unavailable([
          ...issues,
          preparationIssue('observer.projection_unavailable', {
            reason: 'storage_binding_resolution_failed',
            error: errorName(error)
          })
        ], artifactResolutions);
      }
    }
    if (missingBinding.length > 0 || binding === undefined) {
      return unavailable([...issues, ...missingBinding, ...(binding === undefined && missingBinding.length === 0 ? [preparationIssue('observer.projection_unavailable', { reason: 'storage_binding_unavailable' })] : [])], artifactResolutions);
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
    const evaluateConstraintQuery = input.createConstraintQuery?.({
      schemaView: declaration.storageSchema,
      relationIds: [...schema.value.relationsById.keys()],
      registry: input.registry
    });
    const constraintArtifact = await resolveExactArtifact(declaration.constraints.set, 'constraint-set', input.resolveArtifact);
    if (constraintArtifact.resolution !== undefined) artifactResolutions.push(constraintArtifact.resolution);
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
        if (missingConstraintCapabilities.length > 0 || evaluateConstraintQuery === undefined) {
          writable = false;
          issues.push(...missingConstraintCapabilities);
          if (evaluateConstraintQuery === undefined) issues.push(preparationIssue('observer.projection_unavailable', { reason: 'constraint_executor_unavailable' }));
        } else {
          const preparedConstraint = prepareParsedConstraintSetArtifact<State>(parsedConstraint.value, {
            mode: declaration.constraints.mode,
            registry: input.registry,
            evaluateQuery: evaluateConstraintQuery
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
    relations: preparedAttachmentRelations(schema.value, mapping),
    constraints,
    artifactResolutions,
    issues,
    project
  });
};

/** Branded preparation for an already-bound projection that can never write. */
export const prepareManualReadOnlyAttachment = <Storage, Projection>(input: {
  readonly schemaViewIds: readonly string[];
  readonly project: (snapshot: SourceSnapshot<Storage>) => AttachmentProjection<Projection>;
  readonly issues?: readonly Issue[];
}): ReadyAttachmentPreparation<Storage, Projection> => {
  const descriptors = ownRecordDescriptors(input, 'Manual attachment preparation');
  const schemaViewIds = requiredDataValue(descriptors, 'schemaViewIds', 'Manual attachment preparation');
  const project = requiredDataValue(descriptors, 'project', 'Manual attachment preparation');
  const issueDescriptor = descriptors.issues;
  if (issueDescriptor !== undefined && (!issueDescriptor.enumerable || !('value' in issueDescriptor))) {
    throw new TypeError('Manual attachment preparation issues must be an enumerable data property');
  }
  if (typeof project !== 'function') throw new TypeError('Manual attachment preparation project must be a function');
  return ready({
    origin: 'manual-read-only',
    writable: false,
    schemaViewIds: schemaViewIds as readonly string[],
    relations: new Map(),
    constraints: [],
    artifactResolutions: [],
    issues: issueDescriptor === undefined || issueDescriptor.value === undefined ? [] : issueDescriptor.value as readonly Issue[],
    project: project as (snapshot: SourceSnapshot<Storage>) => AttachmentProjection<Projection>
  });
};

/** Reuses validated attachment facts with the adapter's authoritative live projection. */
export const bindAttachmentProjection = <Storage, Projection, ConstraintState>(
  preparation: ReadyAttachmentPreparation<unknown, unknown, ConstraintState>,
  project: (snapshot: SourceSnapshot<Storage>) => AttachmentProjection<Projection>
): ReadyAttachmentPreparation<Storage, Projection, ConstraintState> => ready({
  origin: preparation.origin,
  writable: preparation.writable,
  schemaViewIds: preparation.schemaViewIds,
  ...(preparation.declaration === undefined ? {} : { declaration: preparation.declaration }),
  ...(preparation.schema === undefined ? {} : { schema: preparation.schema }),
  ...(preparation.mapping === undefined ? {} : { mapping: preparation.mapping }),
  relations: new Map(preparation.relations),
  constraints: preparation.constraints,
  artifactResolutions: preparation.artifactResolutions,
  issues: preparation.issues,
  project
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
  const declaration = adoptDocumentDeclaration(input);
  return declaration === undefined
    ? declarationFailure()
    : { success: true, value: declaration, issues: [] };
};

const resolveExactArtifact = async (
  reference: ArtifactRef,
  kind: string,
  resolve: AttachmentArtifactResolver
): Promise<
  | { readonly success: true; readonly value: Artifact; readonly issues: readonly Issue[]; readonly resolution?: ExactArtifactResolution }
  | { readonly success: false; readonly issues: readonly Issue[]; readonly resolution?: ExactArtifactResolution }
> => {
  let raw: unknown;
  try { raw = await resolve(reference, kind as ArtifactKind); }
  catch (error) { return { success: false, issues: [preparationIssue('artifact.dependency_mismatch', { artifactId: reference.id, error: errorName(error) })] }; }
  if (isExactArtifactResolution(raw)) {
    const resolution = raw;
    if (raw.state === 'unavailable') {
      return {
        success: false,
        resolution,
        issues: raw.issues.length > 0
          ? raw.issues
          : [preparationIssue('artifact.dependency_mismatch', { artifactId: reference.id, reason: 'all_candidates_unavailable', attempts: raw.attempts.map(({ candidateId, origin, state, freshness }) => ({ candidateId, origin, state, freshness })) })]
      };
    }
    raw = raw.artifact;
    const parsed = await safeParseArtifactValue(raw);
    if (!parsed.success) return { ...parsed, resolution };
    if (parsed.value.kind !== kind || !sameRef(parsed.value, reference)) {
      return { success: false, resolution, issues: [preparationIssue('artifact.dependency_mismatch', { artifactId: reference.id, expectedKind: kind, actualKind: parsed.value.kind })] };
    }
    return { ...parsed, resolution };
  }
  if (raw === undefined) return { success: false, issues: [preparationIssue('artifact.dependency_mismatch', { artifactId: reference.id, reason: 'missing' })] };
  const parsed = typeof raw === 'string' ? await safeParseArtifactText(raw) : await safeParseArtifactValue(raw);
  if (!parsed.success) return parsed;
  if (parsed.value.kind !== kind || !sameRef(parsed.value, reference)) {
    return { success: false, issues: [preparationIssue('artifact.dependency_mismatch', { artifactId: reference.id, expectedKind: kind, actualKind: parsed.value.kind })] };
  }
  return parsed;
};

const isExactArtifactResolution = (value: unknown): value is ExactArtifactResolution => isRecord(value)
  && (value.state === 'ready' || value.state === 'unavailable')
  && Array.isArray(value.attempts)
  && isRecord(value.reference);

const mappingCapabilities = (mapping: CompiledStorageMapping): readonly CapabilityRef[] => {
  const capabilities = new Map<string, CapabilityRef>();
  for (const { mapping: relation } of mapping.relations.values()) {
    for (const field of Object.values(relation.fields)) {
      if (field.kind === 'absent'
        || field.kind === 'source-metadata'
        || field.write.kind !== 'replace') continue;
      const ref = field.write.capability;
      capabilities.set(stringTupleKey(ref.id, ref.version, ref.contractHash), ref);
    }
  }
  return [...capabilities.values()];
};

const preparedAttachmentRelations = (
  schema: PreparedSchema,
  mapping: CompiledStorageMapping | undefined
): ReadonlyMap<string, PreparedAttachmentRelation> => new Map(
  [...schema.relationsById].map(([relationId, relation]) => {
    const mapped = mapping?.relations.get(relationId);
    const replaceableFields = mapped === undefined
      ? Object.keys(relation.declaration.fields).filter((field) => !relation.declaration.key.includes(field))
      : Object.entries(mapped.mapping.fields)
        .filter(([, field]) => field.kind !== 'absent'
          && field.kind !== 'source-metadata'
          && field.write.kind === 'replace')
        .map(([field]) => field);
    return [relationId, Object.freeze({
      relationId,
      keyFields: Object.freeze([...relation.declaration.key]),
      replaceableFields: Object.freeze(replaceableFields.sort(comparePortableStrings))
    })] as const;
  })
);

const ready = <Storage, Projection, State>(
  input: Omit<ReadyAttachmentPreparation<Storage, Projection, State>, typeof attachmentPreparationBrand | 'state'>
): ReadyAttachmentPreparation<Storage, Projection, State> => {
  const descriptors = ownRecordDescriptors(input, 'Ready attachment preparation');
  const origin = requiredDataValue(descriptors, 'origin', 'Ready attachment preparation');
  const writable = requiredDataValue(descriptors, 'writable', 'Ready attachment preparation');
  const project = requiredDataValue(descriptors, 'project', 'Ready attachment preparation');
  if ((origin !== 'bootstrap' && origin !== 'out-of-band' && origin !== 'manual-read-only') || typeof writable !== 'boolean' || typeof project !== 'function') {
    throw new TypeError('Ready attachment preparation has invalid scalar or callback fields');
  }
  const schemaViewIds = ownStringArray(requiredDataValue(descriptors, 'schemaViewIds', 'Ready attachment preparation'), 'Ready attachment preparation schemaViewIds');
  const relations = ownPreparedAttachmentRelations(requiredDataValue(descriptors, 'relations', 'Ready attachment preparation'));
  const constraints = ownArrayValues<SourceConstraint<State>>(requiredDataValue(descriptors, 'constraints', 'Ready attachment preparation'), 'Ready attachment preparation constraints');
  const artifactResolutions = ownArrayValues<ExactArtifactResolution>(requiredDataValue(descriptors, 'artifactResolutions', 'Ready attachment preparation'), 'Ready attachment preparation artifact resolutions');
  const issues = ownIssues(requiredDataValue(descriptors, 'issues', 'Ready attachment preparation'), 'Ready attachment preparation issues');
  const declaration = optionalDataValue(descriptors, 'declaration', 'Ready attachment preparation');
  const schema = optionalDataValue(descriptors, 'schema', 'Ready attachment preparation');
  const mapping = optionalDataValue(descriptors, 'mapping', 'Ready attachment preparation');
  return Object.freeze({
    state: 'ready', origin, writable, schemaViewIds, relations, constraints, artifactResolutions, issues,
    project: project as ReadyAttachmentPreparation<Storage, Projection, State>['project'],
    ...(declaration === undefined ? {} : { declaration: declaration as DocumentDeclaration }),
    ...(schema === undefined ? {} : { schema: schema as PreparedSchema }),
    ...(mapping === undefined ? {} : { mapping: mapping as CompiledStorageMapping }),
    [attachmentPreparationBrand]: true as const
  });
};

const ownPreparedAttachmentRelations = (input: unknown): ReadonlyMap<string, PreparedAttachmentRelation> => {
  if (!(input instanceof Map)) throw new TypeError('Ready attachment preparation relations must be a Map');
  const entries: [string, PreparedAttachmentRelation][] = [];
  for (const [relationId, relation] of input) {
    if (typeof relationId !== 'string' || relationId.length === 0 || !isRecord(relation) || relation.relationId !== relationId) {
      throw new TypeError('Ready attachment preparation relation identity is invalid');
    }
    const keyFields = ownStringArray(relation.keyFields, 'Ready attachment preparation relation key fields');
    const replaceableFields = ownStringArray(relation.replaceableFields, 'Ready attachment preparation relation replaceable fields');
    if (keyFields.length === 0) throw new TypeError('Ready attachment preparation relation keys must not be empty');
    entries.push([relationId, Object.freeze({ relationId, keyFields, replaceableFields })]);
  }
  return ownedReadonlyMap(entries);
};

const unavailable = (issues: readonly Issue[], artifactResolutions: readonly ExactArtifactResolution[] = []): UnavailableAttachmentPreparation => Object.freeze({
  state: 'unavailable',
  artifactResolutions: ownArrayValues<ExactArtifactResolution>(artifactResolutions, 'Unavailable attachment preparation artifact resolutions'),
  issues: ownIssues(issues, 'Unavailable attachment preparation issues'),
  [attachmentPreparationBrand]: true as const
});

const ownArrayValues = <Value>(input: unknown, label: string): readonly Value[] => {
  if (!Array.isArray(input)) throw new TypeError(label + ' must be an array');
  try {
    const descriptors = Object.getOwnPropertyDescriptors(input);
    const output: Value[] = [];
    for (let index = 0; index < input.length; index += 1) {
      const descriptor = descriptors[String(index)];
      if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) throw new TypeError(label + ' must be a dense descriptor-safe array');
      output.push(descriptor.value as Value);
    }
    return Object.freeze(output);
  } catch (error) {
    if (error instanceof TypeError && error.message.startsWith(label)) throw error;
    throw new TypeError(label + ' must be a descriptor-safe array');
  }
};

const ownStringArray = (input: unknown, label: string): readonly string[] => {
  const values = ownArrayValues<unknown>(input, label);
  if (values.some((value) => typeof value !== 'string')) throw new TypeError(label + ' must contain only strings');
  return Object.freeze([...new Set(values as readonly string[])].sort());
};

const ownIssues = (input: unknown, label: string): readonly Issue[] => {
  const parsed = detachAndFreezeJsonValue(input);
  if (!parsed.success || !Array.isArray(parsed.value)) throw new TypeError(label + ' must be descriptor-safe portable issues');
  return parsed.value as unknown as readonly Issue[];
};

const ownRecordDescriptors = (input: unknown, label: string): PropertyDescriptorMap => {
  if (!isRecord(input)) throw new TypeError(label + ' must be a record');
  try {
    const prototype = Object.getPrototypeOf(input);
    if (prototype !== Object.prototype && prototype !== null) throw new TypeError(label + ' must have a plain prototype');
    return Object.getOwnPropertyDescriptors(input);
  } catch (error) {
    if (error instanceof TypeError && error.message.startsWith(label)) throw error;
    throw new TypeError(label + ' must be descriptor-safe');
  }
};

const requiredDataValue = (descriptors: PropertyDescriptorMap, key: string, label: string): unknown => {
  const descriptor = descriptors[key];
  if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) throw new TypeError(label + ' must have an enumerable data property ' + key);
  return descriptor.value;
};

const optionalDataValue = (descriptors: PropertyDescriptorMap, key: string, label: string): unknown => {
  const descriptor = descriptors[key];
  if (descriptor === undefined) return undefined;
  if (!descriptor.enumerable || !('value' in descriptor)) throw new TypeError(label + ' property ' + key + ' must be an enumerable data property');
  return descriptor.value;
};
const declarationFailure = (): ParseResult<never> => ({ success: false, issues: [preparationIssue('artifact.invalid_envelope', { reason: 'document_declaration' })] });
const preparationIssue = (code: string, details: JsonValue): Issue => createIssue({ code, phase: 'resolve', severity: 'error', retry: code === 'capability.missing' ? 'after_capability' : 'after_refresh', details });
const sameRef = (left: ArtifactRef, right: ArtifactRef): boolean => left.id === right.id && left.contentHash === right.contentHash;
const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> => value !== null && typeof value === 'object' && !Array.isArray(value);
const errorName = (error: unknown): string => error instanceof Error ? error.name : typeof error;
