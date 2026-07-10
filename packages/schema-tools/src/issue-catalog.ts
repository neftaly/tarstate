import {
  isContentHash,
  issueCatalog,
  safeParseJsonValue,
  sha256Json,
  type ArtifactRef,
  type ContentHash,
  type Issue,
  type IssuePhase,
  type IssueRetry,
  type JsonValue,
  type ParseResult,
  type ValueParseBudget
} from '@tarstate/core';

export type IssueCodeCatalogEntry = {
  readonly phase: IssuePhase;
  readonly retry: readonly IssueRetry[];
  readonly requiredCapabilityFields: readonly string[];
  readonly description?: string;
};

export type IssueCodeCatalogBody = {
  readonly codes: Readonly<Record<string, IssueCodeCatalogEntry>>;
};

export type IssueCodeCatalogArtifact = {
  readonly kind: 'issue-code-catalog';
  readonly formatVersion: 1;
  readonly id: string;
  readonly contentHash: ContentHash;
  readonly dependencies: readonly [];
  readonly body: IssueCodeCatalogBody;
};

export const createIssueCodeCatalogArtifact = async (options: {
  readonly id?: string;
  readonly descriptions?: Readonly<Record<string, string>>;
} = {}): Promise<IssueCodeCatalogArtifact> => {
  const id = options.id ?? 'urn:tarstate:issue-code-catalog:v1';
  const descriptions = options.descriptions ?? {};
  const codes: Record<string, IssueCodeCatalogEntry> = {};
  for (const [code, declaration] of [...issueCatalog.entries()].sort(([left], [right]) => compare(left, right))) {
    const description = descriptions[code];
    codes[code] = {
      phase: declaration.phase,
      retry: [...declaration.retries],
      requiredCapabilityFields: declaration.capabilityRelevant === true ? ['requiredCapabilities'] : [],
      ...(description === undefined ? {} : { description })
    };
  }
  const semantic = { kind: 'issue-code-catalog', formatVersion: 1, id, dependencies: [], body: { codes } } as unknown as JsonValue;
  return {
    kind: 'issue-code-catalog',
    formatVersion: 1,
    id,
    contentHash: await sha256Json(semantic),
    dependencies: [],
    body: { codes }
  };
};

export const issueCodeCatalogRef = (catalog: IssueCodeCatalogArtifact): ArtifactRef => ({ id: catalog.id, contentHash: catalog.contentHash });

export const safeParseIssueCodeCatalog = async (input: unknown, budget?: ValueParseBudget): Promise<ParseResult<IssueCodeCatalogArtifact>> => {
  const portable = budget === undefined ? safeParseJsonValue(input) : safeParseJsonValue(input, budget);
  if (!portable.success) return portable;
  const value = portable.value;
  if (!isRecord(value) || !exactKeys(value, ['body', 'contentHash', 'dependencies', 'formatVersion', 'id', 'kind']) || value.kind !== 'issue-code-catalog' || value.formatVersion !== 1 || typeof value.id !== 'string' || !isContentHash(value.contentHash) || !Array.isArray(value.dependencies) || value.dependencies.length !== 0 || !isRecord(value.body) || !exactKeys(value.body, ['codes']) || !isRecord(value.body.codes)) return failure('schema_tools.issue_catalog_invalid', { reason: 'shape' });
  const codes: Record<string, IssueCodeCatalogEntry> = {};
  for (const [code, candidate] of Object.entries(value.body.codes)) {
    if (!isRecord(candidate) || !exactKeys(candidate, ['phase', 'requiredCapabilityFields', 'retry'], ['description']) || !isIssuePhase(candidate.phase) || !Array.isArray(candidate.retry) || !candidate.retry.every(isIssueRetry) || !Array.isArray(candidate.requiredCapabilityFields) || !candidate.requiredCapabilityFields.every((field) => typeof field === 'string') || (candidate.description !== undefined && typeof candidate.description !== 'string')) return failure('schema_tools.issue_catalog_invalid', { reason: 'entry', code });
    codes[code] = {
      phase: candidate.phase,
      retry: candidate.retry,
      requiredCapabilityFields: candidate.requiredCapabilityFields,
      ...(candidate.description === undefined ? {} : { description: candidate.description })
    };
  }
  const catalog: IssueCodeCatalogArtifact = { kind: 'issue-code-catalog', formatVersion: 1, id: value.id, contentHash: value.contentHash, dependencies: [], body: { codes } };
  const expected = await sha256Json({ kind: catalog.kind, formatVersion: catalog.formatVersion, id: catalog.id, dependencies: [], body: catalog.body } as unknown as JsonValue);
  if (expected !== catalog.contentHash) return failure('schema_tools.issue_catalog_hash_mismatch', { expected, actual: catalog.contentHash });
  return { success: true, value: catalog, issues: [] };
};

const issuePhases: readonly IssuePhase[] = ['resolve', 'load', 'parse', 'query', 'plan', 'constraint', 'commit', 'governance', 'lifecycle', 'presence', 'sync'];
const issueRetries: readonly IssueRetry[] = ['never', 'after_input', 'after_refresh', 'after_capability', 'after_authority', 'query_outcome', 'manual_repair'];
const isIssuePhase = (value: unknown): value is IssuePhase => typeof value === 'string' && issuePhases.includes(value as IssuePhase);
const isIssueRetry = (value: unknown): value is IssueRetry => typeof value === 'string' && issueRetries.includes(value as IssueRetry);
const isRecord = (value: unknown): value is Readonly<Record<string, JsonValue>> => value !== null && typeof value === 'object' && !Array.isArray(value);
const exactKeys = (value: Readonly<Record<string, JsonValue>>, required: readonly string[], optional: readonly string[] = []): boolean => {
  const keys = Object.keys(value);
  return required.every((key) => Object.hasOwn(value, key)) && keys.every((key) => required.includes(key) || optional.includes(key));
};
const compare = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0;
const failure = (code: string, details: JsonValue): ParseResult<never> => ({ success: false, issues: [toolIssue(code, details)] });
const toolIssue = (code: string, details: JsonValue): Issue => ({ id: code + ':' + JSON.stringify(details), code, phase: 'parse', severity: 'error', retry: 'after_input', details });
