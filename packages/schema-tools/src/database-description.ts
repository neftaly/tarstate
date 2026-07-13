import {
  canonicalizeJson,
  defaultArtifactParseBudget,
  isContentHash,
  safeParseJsonText,
  safeParseJsonValue,
  sha256Json,
  TarstateParseError,
  type ArtifactParseBudget,
  type ArtifactRef,
  type CapabilityRef,
  type ContentHash,
  type JsonValue,
  type ParseResult,
  type ValueDeclaration
} from '@tarstate/core';
import { schemaToolsFailure, schemaToolsIssue } from './internal-issues.js';

export type DatabaseDescriptionBasis = {
  readonly dataset: { readonly datasetId: string; readonly revision: number };
  readonly attachments: readonly { readonly attachmentId: string; readonly sourceId: string; readonly basis: JsonValue }[];
};

export const supportedDatabaseCommandIds = [
  'tarstate.command.commit',
  'tarstate.command.non_atomic_batch',
  'tarstate.command.simulate',
  'tarstate.command.set_presence',
  'tarstate.command.source_lifecycle',
  'tarstate.command.governance'
] as const;

export type SupportedDatabaseCommandId = typeof supportedDatabaseCommandIds[number];

export type DatabaseDescription = {
  readonly kind: 'tarstate.database-description';
  readonly formatVersion: 1;
  readonly databaseFingerprint: ContentHash;
  readonly registryFingerprint: ContentHash;
  readonly basis: DatabaseDescriptionBasis;
  readonly datasets: readonly {
    readonly datasetId: string;
    readonly revision: number;
    readonly state: 'open' | 'settled';
    readonly attachmentIds: readonly string[];
  }[];
  readonly relations: readonly {
    readonly schema: ArtifactRef;
    readonly relationId: string;
    readonly localName: string;
    readonly attachmentId: string;
    readonly readable: boolean;
    readonly editCapabilities: readonly CapabilityRef[];
    readonly missingCapabilities: readonly CapabilityRef[];
  }[];
  readonly commands: readonly {
    readonly id: SupportedDatabaseCommandId;
    readonly input: ValueDeclaration;
    readonly resultKind: string;
    readonly resultVersion: number;
  }[];
  readonly capabilityImplications: readonly {
    readonly provided: CapabilityRef;
    readonly implies: CapabilityRef;
  }[];
  readonly issueCodeCatalog: ArtifactRef;
};

export type DatabaseDescriptionSnapshot = Omit<DatabaseDescription, 'kind' | 'formatVersion' | 'databaseFingerprint'>;

export type DatabaseDescriptionSnapshotProvider = {
  /** Unknown is intentional: provider output is validated before it crosses the tooling boundary. */
  readonly getDatabaseDescriptionSnapshot: () => unknown;
};

export type DatabaseDescriptionBudget = ArtifactParseBudget & {
  readonly maxDatasets: number;
  readonly maxRelations: number;
  readonly maxCommands: number;
  readonly maxCapabilities: number;
  readonly maxAttachmentReferences: number;
};

export const defaultDatabaseDescriptionBudget: DatabaseDescriptionBudget = {
  ...defaultArtifactParseBudget,
  maxBytes: 2 * 1024 * 1024,
  maxDatasets: 1_000,
  maxRelations: 100_000,
  maxCommands: 64,
  maxCapabilities: 100_000,
  maxAttachmentReferences: 100_000
};

/** Consumes an already authority-filtered shell snapshot; it performs no grant widening. */
export const describeDatabase = async (source: DatabaseDescriptionSnapshot | DatabaseDescriptionSnapshotProvider, budget: DatabaseDescriptionBudget = defaultDatabaseDescriptionBudget): Promise<DatabaseDescription> => {
  let input: unknown;
  try {
    input = isDatabaseDescriptionSnapshotProvider(source) ? source.getDatabaseDescriptionSnapshot() : source;
  } catch (error) {
    throw new TarstateParseError([schemaToolsIssue('schema_tools.database_description_unavailable', {
      reason: 'authority_filtered_snapshot_failed',
      error: error instanceof Error ? error.name : typeof error
    }, 'after_refresh')]);
  }
  if (input === undefined) throw new TarstateParseError([schemaToolsIssue('schema_tools.database_description_unavailable', { reason: 'authority_filtered_snapshot_unavailable' }, 'after_refresh')]);
  const parsedInput = safeParseDescriptionInput(input, budget);
  if (!parsedInput.success) throw new TarstateParseError(parsedInput.issues);
  const normalized = normalizeDescriptionInput(parsedInput.value);
  const provisional = { kind: 'tarstate.database-description', formatVersion: 1, ...normalized } as const;
  const portable = safeParseJsonValue(provisional, budget);
  if (!portable.success) throw new TarstateParseError(portable.issues);
  const budgetIssue = descriptionBudgetIssue(normalized, budget);
  if (budgetIssue !== undefined) throw new TarstateParseError([budgetIssue]);
  const databaseFingerprint = await sha256Json(provisional as unknown as JsonValue);
  const description = { ...provisional, databaseFingerprint };
  const validated = await safeParseDatabaseDescription(description, budget);
  if (!validated.success) throw new TarstateParseError(validated.issues);
  return validated.value;
};

/** Validates serialized JSON, semantic shape, budgets, and database fingerprint without throwing. */
export const safeParseDatabaseDescriptionText = (text: string, budget: DatabaseDescriptionBudget = defaultDatabaseDescriptionBudget): Promise<ParseResult<DatabaseDescription>> => {
  const parsed = safeParseJsonText(text, budget);
  return parsed.success ? safeParseDatabaseDescription(parsed.value, budget) : Promise.resolve(parsed);
};

/** Validates an already sealed authority-filtered description without normalizing it. */
export const safeParseDatabaseDescription = async (input: unknown, budget: DatabaseDescriptionBudget = defaultDatabaseDescriptionBudget): Promise<ParseResult<DatabaseDescription>> => {
  const portable = safeParseJsonValue(input, budget);
  if (!portable.success) return portable;
  const value = portable.value;
  if (!isRecord(value) || !exactKeys(value, ['basis', 'capabilityImplications', 'commands', 'databaseFingerprint', 'datasets', 'formatVersion', 'issueCodeCatalog', 'kind', 'registryFingerprint', 'relations']) || value.kind !== 'tarstate.database-description' || value.formatVersion !== 1 || !isContentHash(value.databaseFingerprint) || !isContentHash(value.registryFingerprint)) return schemaToolsFailure('schema_tools.database_description_invalid', { path: [], reason: 'shape' });
  const basis = parseBasis(value.basis);
  if (!basis.success) return basis;
  if (!Array.isArray(value.datasets) || !Array.isArray(value.relations) || !Array.isArray(value.commands) || !Array.isArray(value.capabilityImplications)) return schemaToolsFailure('schema_tools.database_description_invalid', { path: [], reason: 'collections' });
  const issueCodeCatalog = parseArtifactRef(value.issueCodeCatalog, ['issueCodeCatalog']);
  if (!issueCodeCatalog.success) return issueCodeCatalog;
  const datasets = parseDatasets(value.datasets);
  if (!datasets.success) return datasets;
  const relations = parseRelations(value.relations);
  if (!relations.success) return relations;
  const commands = parseCommands(value.commands);
  if (!commands.success) return commands;
  const implications = parseImplications(value.capabilityImplications);
  if (!implications.success) return implications;
  const parsed: DatabaseDescription = {
    kind: 'tarstate.database-description',
    formatVersion: 1,
    databaseFingerprint: value.databaseFingerprint,
    registryFingerprint: value.registryFingerprint,
    basis: basis.value,
    datasets: datasets.value,
    relations: relations.value,
    commands: commands.value,
    capabilityImplications: implications.value,
    issueCodeCatalog: issueCodeCatalog.value
  };
  const budgetIssue = descriptionBudgetIssue(parsed, budget);
  if (budgetIssue !== undefined) return { success: false, issues: [budgetIssue] };
  const semantic = { ...parsed, databaseFingerprint: undefined };
  const withoutFingerprint = Object.fromEntries(Object.entries(semantic).filter(([, item]) => item !== undefined)) as unknown as JsonValue;
  const expected = await sha256Json(withoutFingerprint);
  if (expected !== parsed.databaseFingerprint) return schemaToolsFailure('schema_tools.database_description_hash_mismatch', { expected, actual: parsed.databaseFingerprint });
  return { success: true, value: deepFreeze(parsed), issues: [] };
};

const normalizeDescriptionInput = (input: DatabaseDescriptionSnapshot): DatabaseDescriptionSnapshot => ({
  registryFingerprint: input.registryFingerprint,
  basis: {
    dataset: { ...input.basis.dataset },
    attachments: [...input.basis.attachments].map((item) => ({ attachmentId: item.attachmentId, sourceId: item.sourceId, basis: item.basis })).sort((left, right) => compare(left.attachmentId, right.attachmentId) || compare(left.sourceId, right.sourceId))
  },
  datasets: [...input.datasets].map((dataset) => ({ ...dataset, attachmentIds: [...new Set(dataset.attachmentIds)].sort(compare) })).sort((left, right) => compare(left.datasetId, right.datasetId) || left.revision - right.revision),
  relations: [...input.relations].map((relation) => ({
    ...relation,
    schema: normalizeRef(relation.schema),
    editCapabilities: normalizeCapabilities(relation.editCapabilities),
    missingCapabilities: normalizeCapabilities(relation.missingCapabilities)
  })).sort((left, right) => compare(left.schema.id, right.schema.id) || compare(left.relationId, right.relationId) || compare(left.attachmentId, right.attachmentId) || compare(left.localName, right.localName)),
  commands: [...input.commands].map((command) => ({ ...command })).sort((left, right) => compare(left.id, right.id)),
  capabilityImplications: [...input.capabilityImplications].map((item) => ({ provided: normalizeCapability(item.provided), implies: normalizeCapability(item.implies) })).sort((left, right) => compare(capabilityKey(left.provided), capabilityKey(right.provided)) || compare(capabilityKey(left.implies), capabilityKey(right.implies))),
  issueCodeCatalog: normalizeRef(input.issueCodeCatalog)
});

const isDatabaseDescriptionSnapshotProvider = (value: unknown): value is DatabaseDescriptionSnapshotProvider => value !== null && typeof value === 'object' && typeof (value as { readonly getDatabaseDescriptionSnapshot?: unknown }).getDatabaseDescriptionSnapshot === 'function';

const safeParseDescriptionInput = (input: unknown, budget: DatabaseDescriptionBudget): ParseResult<DatabaseDescriptionSnapshot> => {
  const portable = safeParseJsonValue(input, budget);
  if (!portable.success) return portable;
  const value = portable.value;
  if (!isRecord(value) || !exactKeys(value, ['basis', 'capabilityImplications', 'commands', 'datasets', 'issueCodeCatalog', 'registryFingerprint', 'relations']) || !isContentHash(value.registryFingerprint)) return invalid([]);
  if (!Array.isArray(value.datasets) || !Array.isArray(value.relations) || !Array.isArray(value.commands) || !Array.isArray(value.capabilityImplications)) return invalid([], 'collections');
  const basis = parseBasis(value.basis);
  if (!basis.success) return basis;
  const datasets = parseDatasets(value.datasets, true);
  if (!datasets.success) return datasets;
  const relations = parseRelations(value.relations, true);
  if (!relations.success) return relations;
  const commands = parseCommands(value.commands);
  if (!commands.success) return commands;
  const implications = parseImplications(value.capabilityImplications);
  if (!implications.success) return implications;
  const issueCodeCatalog = parseArtifactRef(value.issueCodeCatalog, ['issueCodeCatalog'], true);
  if (!issueCodeCatalog.success) return issueCodeCatalog;
  const parsed: DatabaseDescriptionSnapshot = {
    registryFingerprint: value.registryFingerprint,
    basis: basis.value,
    datasets: datasets.value,
    relations: relations.value,
    commands: commands.value,
    capabilityImplications: implications.value,
    issueCodeCatalog: issueCodeCatalog.value
  };
  const budgetIssue = descriptionBudgetIssue(parsed, budget);
  return budgetIssue === undefined ? { success: true, value: parsed, issues: [] } : { success: false, issues: [budgetIssue] };
};

const parseBasis = (value: unknown): ParseResult<DatabaseDescriptionBasis> => {
  if (!isRecord(value) || !exactKeys(value, ['attachments', 'dataset']) || !isRecord(value.dataset) || !exactKeys(value.dataset, ['datasetId', 'revision']) || typeof value.dataset.datasetId !== 'string' || !isRevision(value.dataset.revision) || !Array.isArray(value.attachments)) return invalid(['basis']);
  const attachments: DatabaseDescriptionBasis['attachments'][number][] = [];
  const identities = new Set<string>();
  for (let index = 0; index < value.attachments.length; index += 1) {
    const item = value.attachments[index];
    if (!isRecord(item) || !exactKeys(item, ['attachmentId', 'basis', 'sourceId']) || typeof item.attachmentId !== 'string' || item.attachmentId.length === 0 || typeof item.sourceId !== 'string' || item.sourceId.length === 0) return invalid(['basis', 'attachments', index]);
    const identity = stringTupleKey(item.attachmentId, item.sourceId);
    if (identities.has(identity)) return invalid(['basis', 'attachments', index], 'duplicate');
    identities.add(identity);
    attachments.push({ attachmentId: item.attachmentId, sourceId: item.sourceId, basis: item.basis as JsonValue });
  }
  return { success: true, value: { dataset: { datasetId: value.dataset.datasetId, revision: value.dataset.revision }, attachments }, issues: [] };
};

const parseDatasets = (values: readonly JsonValue[], acceptNormalizableInput = false): ParseResult<DatabaseDescription['datasets']> => {
  const output: DatabaseDescription['datasets'][number][] = [];
  const identities = new Set<string>();
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (!isRecord(value) || !exactKeys(value, ['attachmentIds', 'datasetId', 'revision', 'state']) || typeof value.datasetId !== 'string' || value.datasetId.length === 0 || !isRevision(value.revision) || (value.state !== 'open' && value.state !== 'settled') || !Array.isArray(value.attachmentIds) || !value.attachmentIds.every((item) => typeof item === 'string' && item.length > 0)) return invalid(['datasets', index]);
    const identity = stringTupleKey(value.datasetId, String(value.revision));
    if (identities.has(identity) || (!acceptNormalizableInput && new Set(value.attachmentIds).size !== value.attachmentIds.length)) return invalid(['datasets', index], 'duplicate');
    identities.add(identity);
    output.push({ datasetId: value.datasetId, revision: value.revision, state: value.state, attachmentIds: value.attachmentIds });
  }
  return { success: true, value: output, issues: [] };
};

const parseRelations = (values: readonly JsonValue[], acceptNormalizableInput = false): ParseResult<DatabaseDescription['relations']> => {
  const output: DatabaseDescription['relations'][number][] = [];
  const identities = new Set<string>();
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (!isRecord(value) || !exactKeys(value, ['attachmentId', 'editCapabilities', 'localName', 'missingCapabilities', 'readable', 'relationId', 'schema']) || typeof value.attachmentId !== 'string' || value.attachmentId.length === 0 || typeof value.localName !== 'string' || value.localName.length === 0 || typeof value.relationId !== 'string' || value.relationId.length === 0 || typeof value.readable !== 'boolean' || !Array.isArray(value.editCapabilities) || !Array.isArray(value.missingCapabilities)) return invalid(['relations', index]);
    const schema = parseArtifactRef(value.schema, ['relations', index, 'schema'], acceptNormalizableInput);
    if (!schema.success) return schema;
    const editCapabilities = parseCapabilities(value.editCapabilities, ['relations', index, 'editCapabilities'], acceptNormalizableInput);
    if (!editCapabilities.success) return editCapabilities;
    const missingCapabilities = parseCapabilities(value.missingCapabilities, ['relations', index, 'missingCapabilities'], acceptNormalizableInput);
    if (!missingCapabilities.success) return missingCapabilities;
    const identity = stringTupleKey(schema.value.id, schema.value.contentHash, value.relationId, value.attachmentId);
    if (identities.has(identity)) return invalid(['relations', index], 'duplicate');
    identities.add(identity);
    output.push({ schema: schema.value, relationId: value.relationId, localName: value.localName, attachmentId: value.attachmentId, readable: value.readable, editCapabilities: editCapabilities.value, missingCapabilities: missingCapabilities.value });
  }
  return { success: true, value: output, issues: [] };
};

const parseCommands = (values: readonly JsonValue[]): ParseResult<DatabaseDescription['commands']> => {
  const output: DatabaseDescription['commands'][number][] = [];
  const ids = new Set<string>();
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (!isRecord(value) || !exactKeys(value, ['id', 'input', 'resultKind', 'resultVersion']) || typeof value.id !== 'string' || !supportedDatabaseCommandIds.includes(value.id as SupportedDatabaseCommandId) || typeof value.resultKind !== 'string' || !isRevision(value.resultVersion) || !isValueDeclaration(value.input) || ids.has(value.id)) return invalid(['commands', index]);
    ids.add(value.id);
    output.push({ id: value.id as SupportedDatabaseCommandId, input: value.input, resultKind: value.resultKind, resultVersion: value.resultVersion });
  }
  return { success: true, value: output, issues: [] };
};

const parseImplications = (values: readonly JsonValue[]): ParseResult<DatabaseDescription['capabilityImplications']> => {
  const output: DatabaseDescription['capabilityImplications'][number][] = [];
  const identities = new Set<string>();
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (!isRecord(value) || !exactKeys(value, ['implies', 'provided'])) return invalid(['capabilityImplications', index]);
    const provided = parseCapability(value.provided, ['capabilityImplications', index, 'provided']);
    if (!provided.success) return provided;
    const implies = parseCapability(value.implies, ['capabilityImplications', index, 'implies']);
    if (!implies.success) return implies;
    const identity = stringTupleKey(capabilityKey(provided.value), capabilityKey(implies.value));
    if (identities.has(identity)) return invalid(['capabilityImplications', index], 'duplicate');
    identities.add(identity);
    output.push({ provided: provided.value, implies: implies.value });
  }
  return { success: true, value: output, issues: [] };
};

const parseCapabilities = (values: readonly JsonValue[], path: readonly JsonValue[], allowDuplicates = false): ParseResult<readonly CapabilityRef[]> => {
  const output: CapabilityRef[] = [];
  const identities = new Set<string>();
  for (let index = 0; index < values.length; index += 1) {
    const parsed = parseCapability(values[index] as JsonValue, [...path, index]);
    if (!parsed.success) return parsed;
    const identity = capabilityKey(parsed.value);
    if (!allowDuplicates && identities.has(identity)) return invalid([...path, index], 'duplicate');
    identities.add(identity);
    output.push(parsed.value);
  }
  return { success: true, value: output, issues: [] };
};

const parseCapability = (value: unknown, path: readonly JsonValue[]): ParseResult<CapabilityRef> => isRecord(value) && exactKeys(value, ['contractHash', 'id', 'version']) && typeof value.id === 'string' && value.id.length > 0 && typeof value.version === 'string' && value.version.length > 0 && isContentHash(value.contractHash)
  ? { success: true, value: { id: value.id, version: value.version, contractHash: value.contractHash }, issues: [] }
  : invalid(path);

const parseArtifactRef = (value: unknown, path: readonly JsonValue[], allowLocations = false): ParseResult<ArtifactRef> => isRecord(value) && exactKeys(value, ['contentHash', 'id'], allowLocations ? ['locations'] : []) && typeof value.id === 'string' && value.id.length > 0 && isContentHash(value.contentHash) && (value.locations === undefined || (Array.isArray(value.locations) && value.locations.every((location) => typeof location === 'string')))
  ? { success: true, value: { id: value.id, contentHash: value.contentHash }, issues: [] }
  : invalid(path);

const isValueDeclaration = (value: unknown, depth = 0): value is ValueDeclaration => {
  if (depth > 32 || !isRecord(value) || typeof value.kind !== 'string') return false;
  if (value.kind === 'array') return exactKeys(value, ['items', 'kind']) && isValueDeclaration(value.items, depth + 1);
  if (value.kind === 'tuple') return exactKeys(value, ['items', 'kind']) && Array.isArray(value.items) && value.items.every((item) => isValueDeclaration(item, depth + 1));
  if (value.kind === 'record') return exactKeys(value, ['fields', 'kind'], ['optional']) && isRecord(value.fields) && Object.values(value.fields).every((item) => isValueDeclaration(item, depth + 1)) && (value.optional === undefined || (Array.isArray(value.optional) && value.optional.every((item) => typeof item === 'string' && Object.hasOwn(value.fields as object, item))));
  if (value.kind === 'string') return exactKeys(value, ['kind'], ['values']) && (value.values === undefined || (Array.isArray(value.values) && value.values.every((item) => typeof item === 'string')));
  if (['boolean', 'number', 'integer', 'decimal', 'bytes', 'json'].includes(value.kind)) return exactKeys(value, ['kind']);
  if (value.kind === 'instant') return exactKeys(value, ['kind', 'precision']) && ['millisecond', 'microsecond', 'nanosecond'].includes(value.precision as string);
  if (value.kind === 'ref') return exactKeys(value, ['kind', 'target']) && isRecord(value.target) && exactKeys(value.target, ['relationId']) && typeof value.target.relationId === 'string';
  return value.kind === 'custom' && exactKeys(value, ['codec', 'kind']) && parseCapability(value.codec, []).success;
};

const descriptionBudgetIssue = (value: DatabaseDescriptionSnapshot | DatabaseDescription, budget: DatabaseDescriptionBudget) => {
  const capabilityCount = value.relations.reduce((count, relation) => count + relation.editCapabilities.length + relation.missingCapabilities.length, 0) + value.capabilityImplications.length * 2;
  const attachmentCount = value.basis.attachments.length + value.datasets.reduce((count, dataset) => count + dataset.attachmentIds.length, 0);
  const byteLength = new TextEncoder().encode(canonicalizeJson(value as unknown as JsonValue)).byteLength;
  if (byteLength > budget.maxBytes) return budgetExceeded('maxBytes', budget.maxBytes);
  if (value.datasets.length > budget.maxDatasets) return budgetExceeded('maxDatasets', budget.maxDatasets);
  if (value.relations.length > budget.maxRelations) return budgetExceeded('maxRelations', budget.maxRelations);
  if (value.commands.length > budget.maxCommands) return budgetExceeded('maxCommands', budget.maxCommands);
  if (capabilityCount > budget.maxCapabilities) return budgetExceeded('maxCapabilities', budget.maxCapabilities);
  if (attachmentCount > budget.maxAttachmentReferences) return budgetExceeded('maxAttachmentReferences', budget.maxAttachmentReferences);
  return undefined;
};

const normalizeCapabilities = (refs: readonly CapabilityRef[]): readonly CapabilityRef[] => [...new Map(refs.map((ref) => [capabilityKey(ref), normalizeCapability(ref)])).values()].sort((left, right) => compare(capabilityKey(left), capabilityKey(right)));
const normalizeCapability = (ref: CapabilityRef): CapabilityRef => ({ id: ref.id, version: ref.version, contractHash: ref.contractHash });
const normalizeRef = (ref: ArtifactRef): ArtifactRef => ({ id: ref.id, contentHash: ref.contentHash });
const stringTupleKey = (...parts: readonly string[]): string => {
  let key = '';
  for (const part of parts) key += part.length + ':' + part;
  return key;
};
const capabilityKey = (ref: CapabilityRef): string => stringTupleKey(ref.id, ref.version, ref.contractHash);
const isRecord = (value: unknown): value is Readonly<Record<string, JsonValue | undefined>> => value !== null && typeof value === 'object' && !Array.isArray(value);
const exactKeys = (value: Readonly<Record<string, unknown>>, required: readonly string[], optional: readonly string[] = []): boolean => Object.keys(value).every((key) => required.includes(key) || optional.includes(key)) && required.every((key) => Object.hasOwn(value, key));
const isRevision = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const compare = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0;
const invalid = <Value = never>(path: readonly JsonValue[], reason = 'shape'): ParseResult<Value> => schemaToolsFailure('schema_tools.database_description_invalid', { path, reason });
const budgetExceeded = (name: string, limit: number) => schemaToolsIssue('artifact.budget_exceeded', { budget: name, limit });

const deepFreeze = <Value>(value: Value): Value => {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
};
