import * as Automerge from '@automerge/automerge';
import {
  canonicalizeJson,
  createIssue,
  isContentHash,
  type ArtifactRef,
  type CapabilityRef,
  type DocumentDeclaration,
  type GovernanceCommand,
  type GovernanceConstraintSection,
  type GovernanceSection,
  type GovernanceSourceAdapter,
  type GovernanceStorageSection,
  type Issue,
  type JsonValue
} from '@tarstate/core';
import { automergeIssueDeclarations } from './issues.js';
import { conflictsAt, normalizeAutomergeValue } from './projection.js';
import { automergeMetadataProperty } from './reserved.js';
import {
  AutomergeSourceRuntime,
  automergeBasis,
  exactAutomergeBasisEqual,
  type AutomergeBasis
} from './source.js';

export { automergeMetadataProperty, isAutomergeReservedRootProperty } from './reserved.js';

export type AutomergeMetadataStorageV1 = {
  readonly storageSchema: ArtifactRef;
  readonly projection: DocumentDeclaration['projection'];
};

export type AutomergeMetadataV1 = {
  readonly formatVersion: 1;
  readonly storage: AutomergeMetadataStorageV1;
  readonly constraints?: DocumentDeclaration['constraints'];
};

export type AutomergeMetadataDocumentStatus = 'absent' | 'valid' | 'malformed' | 'name-collision' | 'conflict';

export type AutomergeMetadataConflictAlternative = {
  readonly scope: 'root' | 'storage' | 'constraints';
  readonly changeHash: string;
  readonly value: JsonValue;
  readonly section?: GovernanceSection;
};

export type TrustedAutomergeMetadataOverride = {
  readonly declaration: DocumentDeclaration;
  readonly classifyNameCollisionAsApplicationData?: boolean;
  readonly constraintActivationComplete?: boolean;
};

export type AutomergeMetadataReadResult = {
  readonly status: AutomergeMetadataDocumentStatus | 'out-of-band';
  readonly documentStatus: AutomergeMetadataDocumentStatus;
  readonly origin: 'none' | 'document' | 'out-of-band';
  readonly declaration?: DocumentDeclaration;
  readonly writable: boolean;
  readonly alternatives: readonly AutomergeMetadataConflictAlternative[];
  readonly raw?: JsonValue;
  readonly issues: readonly Issue[];
};

/** Total metadata reader. It never chooses an Automerge conflict winner. */
export const readAutomergeMetadata = <T extends object>(
  doc: Automerge.Doc<T>,
  options: { readonly sourceId?: string; readonly trustedOutOfBand?: TrustedAutomergeMetadataOverride } = {}
): AutomergeMetadataReadResult => {
  try {
    const root = doc as unknown as Record<string, unknown>;
    const rootAlternatives = conflictEntries(root, automergeMetadataProperty);
    if (rootAlternatives.length > 1) {
      return withOverride(conflictResult('root', rootAlternatives, options.sourceId), options.trustedOutOfBand, options.sourceId);
    }
    if (!Object.hasOwn(root, automergeMetadataProperty)) {
      return withOverride(baseResult('absent'), options.trustedOutOfBand, options.sourceId);
    }
    const rawValue = root[automergeMetadataProperty];
    const raw = normalizeAutomergeValue(rawValue);
    if (!isRecord(raw)) {
      return withOverride(problemResult('name-collision', raw, metadataIssue('automerge.metadata_name_collision', options.sourceId)), options.trustedOutOfBand, options.sourceId);
    }
    const recognized = Object.hasOwn(raw, 'formatVersion') || Object.hasOwn(raw, 'storage') || Object.hasOwn(raw, 'constraints');
    if (!recognized) {
      return withOverride(problemResult('name-collision', raw, metadataIssue('automerge.metadata_name_collision', options.sourceId)), options.trustedOutOfBand, options.sourceId);
    }
    if (!isRecord(rawValue)) {
      return withOverride(problemResult('malformed', raw, metadataIssue('automerge.metadata_malformed', options.sourceId)), options.trustedOutOfBand, options.sourceId);
    }
    const storageAlternatives = conflictEntries(rawValue, 'storage');
    const constraintAlternatives = conflictEntries(rawValue, 'constraints');
    if (storageAlternatives.length > 1 || constraintAlternatives.length > 1) {
      const alternatives = [
        ...materializeConflictAlternatives('storage', storageAlternatives),
        ...materializeConflictAlternatives('constraints', constraintAlternatives)
      ];
      const result: AutomergeMetadataReadResult = {
        ...baseResult('conflict'),
        alternatives,
        raw,
        issues: [metadataIssue('automerge.metadata_conflict', options.sourceId, { scopes: [...new Set(alternatives.map(({ scope }) => scope))] })]
      };
      return withOverride(result, options.trustedOutOfBand, options.sourceId);
    }
    const parsed = parseMetadataCarrier(raw);
    if (parsed === undefined) {
      return withOverride(problemResult('malformed', raw, metadataIssue('automerge.metadata_malformed', options.sourceId)), options.trustedOutOfBand, options.sourceId);
    }
    return {
      status: 'valid',
      documentStatus: 'valid',
      origin: 'document',
      declaration: declarationFromCarrier(parsed),
      writable: true,
      alternatives: Object.freeze([]),
      raw,
      issues: Object.freeze([])
    };
  } catch (error) {
    return withOverride(problemResult('malformed', undefined, metadataIssue('automerge.metadata_malformed', options.sourceId, { error: error instanceof Error ? error.name : typeof error })), options.trustedOutOfBand, options.sourceId);
  }
};

export type AutomergeMetadataMutation =
  | { readonly kind: 'set-root'; readonly value: JsonValue }
  | { readonly kind: 'set-section'; readonly section: 'storage' | 'constraints'; readonly value: JsonValue };

export type AutomergeMetadataMutationPlan = {
  readonly outcome: 'planned';
  readonly beforeBasis: AutomergeBasis;
  readonly action: GovernanceCommand['request']['action'];
  readonly mutation: AutomergeMetadataMutation;
  readonly issues: readonly Issue[];
};

export type AutomergeMetadataPlanResult =
  | AutomergeMetadataMutationPlan
  | { readonly outcome: 'rejected'; readonly beforeBasis: AutomergeBasis; readonly issues: readonly Issue[] };

export const planAutomergeMetadataMutation = <T extends object>(
  doc: Automerge.Doc<T>,
  command: GovernanceCommand,
  options: { readonly governanceAuthorized: boolean }
): AutomergeMetadataPlanResult => {
  const beforeBasis = automergeBasis(doc);
  if (!options.governanceAuthorized) return rejectedPlan(beforeBasis, metadataIssue('automerge.metadata_governance_required', command.sourceId));
  const expected = parseAutomergeBasis(command.expectedBasis);
  if (expected === undefined || !exactAutomergeBasisEqual(beforeBasis, expected)) {
    return rejectedPlan(beforeBasis, metadataIssue('automerge.metadata_expected_basis_stale', command.sourceId, { expected: command.expectedBasis, actual: beforeBasis }));
  }
  const current = readAutomergeMetadata(doc, { sourceId: command.sourceId });
  if (command.request.action === 'initialize_declaration') {
    if (current.documentStatus !== 'absent') return rejectedPlan(beforeBasis, ...current.issues, metadataIssue('automerge.metadata_governance_required', command.sourceId, { action: 'initialize_requires_absence', state: current.documentStatus }));
    const carrier = carrierFromDeclaration(command.request.declaration);
    if (carrier === undefined) return rejectedPlan(beforeBasis, metadataIssue('automerge.metadata_malformed', command.sourceId, { origin: 'governance_command' }));
    return planned(beforeBasis, command.request.action, { kind: 'set-root', value: carrier as unknown as JsonValue });
  }
  if (command.request.action === 'activate_constraints') {
    if (current.documentStatus !== 'valid') return rejectedPlan(beforeBasis, ...current.issues, metadataIssue('automerge.metadata_repair_unsupported', command.sourceId, { action: 'activation_requires_valid_declaration' }));
    const existing = isRecord(current.raw) && isRecord(current.raw.constraints) ? current.raw.constraints : {};
    const value = { ...cloneJson(existing as JsonValue) as Record<string, JsonValue>, ...constraintWire(command.request.activation) } as unknown as JsonValue;
    return planned(beforeBasis, command.request.action, { kind: 'set-section', section: 'constraints', value });
  }
  if (current.documentStatus !== 'conflict') return rejectedPlan(beforeBasis, ...current.issues, metadataIssue('automerge.metadata_repair_unsupported', command.sourceId, { action: 'repair_requires_conflict', state: current.documentStatus }));
  if (current.alternatives.some(({ scope }) => scope === 'root')) {
    return rejectedPlan(beforeBasis, metadataIssue('automerge.metadata_repair_unsupported', command.sourceId, { reason: 'root_alternatives_not_bound_by_section_command' }));
  }
  const repair = command.request;
  if (repair.action !== 'repair_declaration') return rejectedPlan(beforeBasis, metadataIssue('automerge.metadata_repair_unsupported', command.sourceId));
  const scopedAlternatives = current.alternatives.filter(({ scope }) => scope === repair.section);
  if (scopedAlternatives.some(({ section }) => section === undefined)) {
    return rejectedPlan(beforeBasis, metadataIssue('automerge.metadata_repair_unsupported', command.sourceId, { reason: 'malformed_alternative_cannot_be_bound', section: repair.section }));
  }
  const observed = scopedAlternatives
    .filter(({ section }) => section !== undefined)
    .map(({ section }) => normalizeSection(section!));
  const requested = repair.alternatives.map(normalizeSection);
  if (!samePortableSet(observed, requested) || !requested.some((section) => samePortable(section, normalizeSection(repair.selected)))) {
    return rejectedPlan(beforeBasis, metadataIssue('automerge.metadata_repair_alternatives_changed', command.sourceId, { section: repair.section }));
  }
  const selected = normalizeSection(repair.selected);
  const selectedAlternative = current.alternatives.find(({ scope, section }) => scope === selected.kind && section !== undefined && samePortable(normalizeSection(section), selected));
  if (selectedAlternative === undefined) return rejectedPlan(beforeBasis, metadataIssue('automerge.metadata_repair_alternatives_changed', command.sourceId));
  return planned(beforeBasis, command.request.action, { kind: 'set-section', section: selected.kind, value: selectedAlternative.value });
};

export type AppliedAutomergeMetadataMutation<T extends object> = {
  readonly outcome: 'committed' | 'rejected';
  readonly doc: Automerge.Doc<T>;
  readonly beforeBasis: AutomergeBasis;
  readonly afterBasis: AutomergeBasis;
  readonly issues: readonly Issue[];
};

export const applyAutomergeMetadataPlan = <T extends object>(
  doc: Automerge.Doc<T>,
  plan: AutomergeMetadataMutationPlan
): AppliedAutomergeMetadataMutation<T> => {
  const actual = automergeBasis(doc);
  if (!exactAutomergeBasisEqual(actual, plan.beforeBasis)) {
    const issue = metadataIssue('automerge.metadata_expected_basis_stale', undefined, { expected: plan.beforeBasis, actual });
    return { outcome: 'rejected', doc, beforeBasis: actual, afterBasis: actual, issues: [issue] };
  }
  try {
    const changed = Automerge.change(doc, { message: 'tarstate governance metadata mutation', time: 0 }, (draft) => {
      const root = draft as unknown as Record<string, unknown>;
      if (plan.mutation.kind === 'set-root') root[automergeMetadataProperty] = cloneJson(plan.mutation.value);
      else {
        const metadata = root[automergeMetadataProperty];
        if (!isRecord(metadata)) throw new Error('Metadata root changed after planning');
        metadata[plan.mutation.section] = cloneJson(plan.mutation.value);
      }
    });
    return { outcome: 'committed', doc: changed, beforeBasis: actual, afterBasis: automergeBasis(changed), issues: [] };
  } catch (error) {
    const issue = metadataIssue('automerge.metadata_repair_unsupported', undefined, { error: error instanceof Error ? error.message : String(error) });
    return { outcome: 'rejected', doc, beforeBasis: actual, afterBasis: actual, issues: [issue] };
  }
};

/** Core governance adapter; authority and operation receipts remain core-owned. */
export const automergeGovernanceSourceAdapter = <T extends object>(runtime: AutomergeSourceRuntime<T>): GovernanceSourceAdapter => ({
  snapshotBasis: () => runtime.snapshot().basis,
  apply: ({ command, context }) => {
    const snapshot = runtime.snapshot();
    const plan = planAutomergeMetadataMutation(snapshot.storage, command, { governanceAuthorized: true });
    if (plan.outcome === 'rejected') return { outcome: 'rejected', beforeBasis: plan.beforeBasis, afterBasis: plan.beforeBasis, issues: plan.issues };
    const applied = applyAutomergeMetadataPlan(snapshot.storage, plan);
    if (applied.outcome === 'rejected') return { outcome: 'rejected', beforeBasis: applied.beforeBasis, afterBasis: applied.afterBasis, issues: applied.issues };
    context.markMutationPossible();
    runtime.replace(applied.doc);
    return { outcome: 'committed', beforeBasis: applied.beforeBasis, afterBasis: applied.afterBasis, durability: 'memory', issues: [] };
  }
});

const conflictResult = (scope: 'root', entries: readonly (readonly [string, unknown])[], sourceId?: string): AutomergeMetadataReadResult => ({
  ...baseResult('conflict'),
  alternatives: Object.freeze(entries.map(([changeHash, value]) => {
    const normalized = normalizeAutomergeValue(value);
    return { scope, changeHash, value: normalized } satisfies AutomergeMetadataConflictAlternative;
  })),
  issues: [metadataIssue('automerge.metadata_conflict', sourceId, { scopes: [scope] })]
});

const materializeConflictAlternatives = (
  scope: 'storage' | 'constraints',
  entries: readonly (readonly [string, unknown])[]
): readonly AutomergeMetadataConflictAlternative[] => Object.freeze(entries.map(([changeHash, value]) => {
  const normalized = normalizeAutomergeValue(value);
  const section = scope === 'storage' ? parseStorageSection(normalized) : parseConstraintSection(normalized);
  return { scope, changeHash, value: normalized, ...(section === undefined ? {} : { section }) };
}));

const withOverride = (
  document: AutomergeMetadataReadResult,
  override: TrustedAutomergeMetadataOverride | undefined,
  sourceId?: string
): AutomergeMetadataReadResult => {
  if (override === undefined || document.documentStatus === 'valid') return document;
  const carrier = carrierFromDeclaration(override.declaration);
  if (carrier === undefined) return { ...document, issues: [...document.issues, metadataIssue('automerge.metadata_malformed', sourceId, { origin: 'out-of-band' })] };
  const writable = document.documentStatus === 'absent' || (
    document.documentStatus === 'name-collision' &&
    override.classifyNameCollisionAsApplicationData === true &&
    override.constraintActivationComplete === true
  );
  return {
    ...document,
    status: 'out-of-band',
    origin: 'out-of-band',
    declaration: declarationFromCarrier(carrier),
    writable,
    issues: writable ? document.issues : [...document.issues, metadataIssue('automerge.metadata_override_read_only', sourceId, { documentStatus: document.documentStatus })]
  };
};

const baseResult = (status: AutomergeMetadataDocumentStatus): AutomergeMetadataReadResult => ({
  status,
  documentStatus: status,
  origin: 'none',
  writable: false,
  alternatives: Object.freeze([]),
  issues: Object.freeze([])
});

const problemResult = (status: 'malformed' | 'name-collision', raw: JsonValue | undefined, issue: Issue): AutomergeMetadataReadResult => ({
  ...baseResult(status),
  ...(raw === undefined ? {} : { raw }),
  issues: [issue]
});

const conflictEntries = (owner: object, property: string): readonly (readonly [string, unknown])[] => {
  return conflictsAt(owner, property);
};

const parseMetadataCarrier = (value: unknown): AutomergeMetadataV1 | undefined => {
  if (!isRecord(value) || value.formatVersion !== 1) return undefined;
  const storage = parseStorageWire(value.storage);
  if (storage === undefined) return undefined;
  if (value.constraints !== undefined) {
    const constraints = parseConstraintWire(value.constraints);
    if (constraints === undefined) return undefined;
    return { formatVersion: 1, storage, constraints };
  }
  return { formatVersion: 1, storage };
};

const parseStorageWire = (value: unknown): AutomergeMetadataStorageV1 | undefined => {
  if (!isRecord(value)) return undefined;
  const storageSchema = parseArtifactRef(value.storageSchema);
  const projection = parseProjection(value.projection);
  return storageSchema === undefined || projection === undefined ? undefined : { storageSchema, projection };
};

const parseConstraintWire = (value: unknown): DocumentDeclaration['constraints'] | undefined => {
  if (!isRecord(value) || (value.mode !== 'audit' && value.mode !== 'required')) return undefined;
  const set = parseArtifactRef(value.set);
  return set === undefined ? undefined : { set, mode: value.mode };
};

const parseStorageSection = (value: unknown): GovernanceStorageSection | undefined => {
  const storage = parseStorageWire(value);
  return storage === undefined ? undefined : { kind: 'storage', ...storage };
};

const parseConstraintSection = (value: unknown): GovernanceConstraintSection | undefined => {
  const constraints = parseConstraintWire(value);
  return constraints === undefined ? undefined : { kind: 'constraints', ...constraints };
};

const parseProjection = (value: unknown): DocumentDeclaration['projection'] | undefined => {
  if (!isRecord(value)) return undefined;
  if (value.kind === 'storage-mapping') {
    const storageMapping = parseArtifactRef(value.storageMapping);
    return storageMapping === undefined ? undefined : { kind: value.kind, storageMapping };
  }
  if (value.kind === 'storage-binding') {
    const storageBinding = parseCapabilityRef(value.storageBinding);
    return storageBinding === undefined ? undefined : { kind: value.kind, storageBinding };
  }
  return undefined;
};

const parseArtifactRef = (value: unknown): ArtifactRef | undefined => {
  if (!isRecord(value) || typeof value.id !== 'string' || value.id.length === 0 || !isContentHash(value.contentHash)) return undefined;
  if (value.locations !== undefined && (!Array.isArray(value.locations) || value.locations.some((location) => typeof location !== 'string'))) return undefined;
  return {
    id: value.id,
    contentHash: value.contentHash,
    ...(Array.isArray(value.locations) ? { locations: [...value.locations] as string[] } : {})
  };
};

const parseCapabilityRef = (value: unknown): CapabilityRef | undefined =>
  !isRecord(value) || typeof value.id !== 'string' || value.id.length === 0 || typeof value.version !== 'string' || value.version.length === 0 || !isContentHash(value.contractHash)
    ? undefined
    : { id: value.id, version: value.version, contractHash: value.contractHash };

const carrierFromDeclaration = (declaration: DocumentDeclaration): AutomergeMetadataV1 | undefined => parseMetadataCarrier({
  formatVersion: 1,
  storage: { storageSchema: declaration.storageSchema, projection: declaration.projection },
  ...(declaration.constraints === undefined ? {} : { constraints: declaration.constraints })
});

const declarationFromCarrier = (carrier: AutomergeMetadataV1): DocumentDeclaration => ({
  formatVersion: 1,
  storageSchema: carrier.storage.storageSchema,
  projection: carrier.storage.projection,
  ...(carrier.constraints === undefined ? {} : { constraints: carrier.constraints })
});

const constraintWire = (section: GovernanceConstraintSection): NonNullable<DocumentDeclaration['constraints']> => ({ set: section.set, mode: section.mode });

const normalizeSection = (section: GovernanceSection): GovernanceSection => section.kind === 'storage'
  ? { kind: 'storage', storageSchema: normalizeRef(section.storageSchema), projection: normalizeProjection(section.projection) }
  : { kind: 'constraints', set: normalizeRef(section.set), mode: section.mode };

const normalizeRef = (ref: ArtifactRef): ArtifactRef => ({ id: ref.id, contentHash: ref.contentHash });
const normalizeProjection = (projection: DocumentDeclaration['projection']): DocumentDeclaration['projection'] => projection.kind === 'storage-mapping'
  ? { kind: projection.kind, storageMapping: normalizeRef(projection.storageMapping) }
  : { kind: projection.kind, storageBinding: { ...projection.storageBinding } };

const planned = (beforeBasis: AutomergeBasis, action: GovernanceCommand['request']['action'], mutation: AutomergeMetadataMutation): AutomergeMetadataMutationPlan => ({ outcome: 'planned', beforeBasis, action, mutation, issues: [] });
const rejectedPlan = (beforeBasis: AutomergeBasis, ...issues: readonly Issue[]): AutomergeMetadataPlanResult => ({ outcome: 'rejected', beforeBasis, issues });

const metadataIssue = (code: `automerge.${string}`, sourceId?: string, details?: unknown): Issue => {
  const declaration = automergeIssueDeclarations.find((candidate) => candidate.code === code);
  if (declaration === undefined) throw new Error('Missing Automerge issue declaration: ' + code);
  const retry = declaration.retries[0];
  return createIssue({
    code,
    phase: declaration.phase,
    severity: declaration.severity,
    ...(retry === undefined ? {} : { retry }),
    ...(sourceId === undefined ? {} : { sourceId }),
    ...(details === undefined ? {} : { details })
  });
};

const parseAutomergeBasis = (value: unknown): AutomergeBasis | undefined => {
  if (!isRecord(value) || value.kind !== 'automerge-heads' || !Array.isArray(value.heads) || value.heads.some((head) => typeof head !== 'string')) return undefined;
  return { kind: 'automerge-heads', heads: [...new Set(value.heads as string[])].sort() };
};

const samePortableSet = (left: readonly GovernanceSection[], right: readonly GovernanceSection[]): boolean => {
  const normalizedLeft = left.map((value) => canonicalizeJson(value as unknown as JsonValue)).sort();
  const normalizedRight = right.map((value) => canonicalizeJson(value as unknown as JsonValue)).sort();
  return normalizedLeft.length === normalizedRight.length && normalizedLeft.every((value, index) => value === normalizedRight[index]);
};

const samePortable = (left: unknown, right: unknown): boolean => {
  try { return canonicalizeJson(left as JsonValue) === canonicalizeJson(right as JsonValue); } catch { return false; }
};

const cloneJson = (value: JsonValue): JsonValue => {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(cloneJson);
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, cloneJson(child)]));
};

const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
