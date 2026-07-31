import { createIssue, TarstateParseError, type Issue, type ParseResult } from './issues.js';
import {
  isContentHash,
  sha256Json,
  type ContentHash
} from './canonical-json.js';
import { compareUnicodeScalars } from './internal-canonical-json.js';
import { detachAndFreezeJsonValue, freezeOwnedJsonValue } from './internal-owned-json.js';
import { stringTupleKey } from './internal-string-key.js';
import { defaultValueParseBudget, safeParseJsonValue, type JsonValue, type ValueParseBudget } from './value.js';

export {
  canonicalizeJson,
  isContentHash,
  sha256Bytes,
  sha256Json
} from './canonical-json.js';
export type { ContentHash } from './canonical-json.js';

export const artifactKinds = Object.freeze(['schema', 'query', 'transaction', 'constraint-set', 'storage-mapping', 'schema-lens', 'issue-code-catalog'] as const);
export type ArtifactKind = typeof artifactKinds[number];

export type ArtifactRef = {
  readonly id: string;
  readonly contentHash: ContentHash;
  readonly locations?: readonly string[];
};

export type Artifact<Body extends JsonValue = JsonValue> = {
  readonly kind: ArtifactKind;
  readonly formatVersion: 1;
  readonly id: string;
  readonly contentHash: ContentHash;
  readonly dependencies: readonly ArtifactRef[];
  readonly body: Body;
};

export type ArtifactParseBudget = ValueParseBudget & {
  readonly maxBytes: number;
  readonly maxDependencies: number;
};

export const defaultArtifactParseBudget: ArtifactParseBudget = Object.freeze({
  ...defaultValueParseBudget,
  maxBytes: 8 * 1024 * 1024,
  maxDependencies: 10_000
});

const jsonNumberPattern = /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/y;
const forbiddenKeys = new Set(['__proto__', 'constructor', 'prototype']);

export const normalizeArtifactRef = (ref: ArtifactRef): ArtifactRef => ({ id: ref.id, contentHash: ref.contentHash });

export const normalizeDependencies = (dependencies: readonly ArtifactRef[]): ParseResult<readonly ArtifactRef[]> => {
  const byId = new Map<string, ContentHash>();
  const byPair = new Map<string, ArtifactRef>();
  for (const dependency of dependencies) {
    if (typeof dependency.id !== 'string' || dependency.id.length === 0 || !isContentHash(dependency.contentHash)) {
      return { success: false, issues: [createIssue({ code: 'artifact.invalid_envelope', retry: 'after_input', details: { member: 'dependencies' } })] };
    }
    const previousHash = byId.get(dependency.id);
    if (previousHash !== undefined && previousHash !== dependency.contentHash) {
      return { success: false, issues: [createIssue({ code: 'artifact.dependency_ambiguous', retry: 'after_input', details: { id: dependency.id, hashes: [previousHash, dependency.contentHash].sort(compareUnicodeScalars) } })] };
    }
    byId.set(dependency.id, dependency.contentHash);
    byPair.set(stringTupleKey(dependency.id, dependency.contentHash), normalizeArtifactRef(dependency));
  }
  return {
    success: true,
    value: [...byPair.values()].sort((left, right) => compareUnicodeScalars(left.id, right.id) || compareUnicodeScalars(left.contentHash, right.contentHash)),
    issues: []
  };
};

export const artifactSemanticValue = <Body extends JsonValue>(artifact: Omit<Artifact<Body>, 'contentHash'> | Artifact<Body>): JsonValue => {
  const normalized = normalizeDependencies(artifact.dependencies);
  if (!normalized.success) throw new TarstateParseError(normalized.issues);
  return {
    kind: artifact.kind,
    formatVersion: artifact.formatVersion,
    id: artifact.id,
    dependencies: normalized.value.map((dependency) => ({ id: dependency.id, contentHash: dependency.contentHash })),
    body: artifact.body
  };
};

export const sealArtifact = async <Body extends JsonValue>(input: {
  readonly kind: ArtifactKind;
  readonly id?: string;
  readonly dependencies?: readonly ArtifactRef[];
  readonly body: Body;
}): Promise<Artifact<Body>> => {
  const dependencies = normalizeDependencies(input.dependencies ?? []);
  if (!dependencies.success) throw new TarstateParseError(dependencies.issues);
  const body = detachAndFreezeJsonValue(input.body);
  if (!body.success) throw new TarstateParseError(body.issues);
  const ownedDependencies = Object.freeze(dependencies.value.map((dependency) => Object.freeze(dependency)));
  let id = input.id;
  if (id === undefined) {
    const bodyHash = await sha256Json({ kind: input.kind, formatVersion: 1, dependencies: ownedDependencies.map(normalizeArtifactRef), body: body.value });
    id = 'urn:tarstate:inline:sha256:' + bodyHash.slice('sha256:'.length);
  } else if (id.startsWith('urn:tarstate:inline:')) {
    throw new TarstateParseError([createIssue({ code: 'artifact.invalid_envelope', retry: 'after_input', details: { member: 'id', reason: 'reserved_inline_namespace' } })]);
  }
  const withoutHash = { kind: input.kind, formatVersion: 1 as const, id, dependencies: ownedDependencies, body: body.value as Body };
  const contentHash = await sha256Json(artifactSemanticValue(withoutHash));
  return Object.freeze({ ...withoutHash, contentHash });
};

export const safeParseArtifactText = async (text: string, budget: ArtifactParseBudget = defaultArtifactParseBudget): Promise<ParseResult<Artifact>> => {
  const parsedJson = safeParseJsonText(text, budget);
  if (!parsedJson.success) return parsedJson;
  return safeParseOwnedArtifactValue(parsedJson.value, budget);
};

export const parseArtifactText = async (text: string, budget?: ArtifactParseBudget): Promise<Artifact> => {
  const result = await safeParseArtifactText(text, budget);
  if (!result.success) throw new TarstateParseError(result.issues);
  return result.value;
};

export const safeParseArtifactValue = async (input: unknown, budget: ArtifactParseBudget = defaultArtifactParseBudget): Promise<ParseResult<Artifact>> => {
  const portable = safeParseJsonValue(input, budget);
  if (!portable.success) return portable;
  return safeParseOwnedArtifactValue(portable.value, budget);
};

const safeParseOwnedArtifactValue = async (value: JsonValue, budget: ArtifactParseBudget): Promise<ParseResult<Artifact>> => {
  if (!isRecord(value)) return invalidEnvelope('root');
  const allowed = new Set(['kind', 'formatVersion', 'id', 'contentHash', 'dependencies', 'body', 'locations']);
  if (Object.keys(value).some((key) => !allowed.has(key))) return invalidEnvelope('unknown_member');
  if (!artifactKinds.includes(value.kind as ArtifactKind) || value.formatVersion !== 1 || typeof value.id !== 'string' || value.id.length === 0 || !isContentHash(value.contentHash) || !Array.isArray(value.dependencies) || !Object.hasOwn(value, 'body')) return invalidEnvelope('shape');
  if (value.dependencies.length > budget.maxDependencies) return { success: false, issues: [createIssue({ code: 'artifact.budget_exceeded', retry: 'after_input', details: { budget: 'maxDependencies', limit: budget.maxDependencies } })] };
  const dependencies: ArtifactRef[] = [];
  for (const candidate of value.dependencies) {
    if (!isRecord(candidate) || typeof candidate.id !== 'string' || !isContentHash(candidate.contentHash) || Object.keys(candidate).some((key) => !['id', 'contentHash', 'locations'].includes(key)) || (candidate.locations !== undefined && (!Array.isArray(candidate.locations) || candidate.locations.some((location) => typeof location !== 'string')))) return invalidEnvelope('dependency');
    dependencies.push({ id: candidate.id, contentHash: candidate.contentHash, ...(candidate.locations === undefined ? {} : { locations: candidate.locations as string[] }) });
  }
  const normalized = normalizeDependencies(dependencies);
  if (!normalized.success) return normalized;
  const body = freezeOwnedJsonValue(value.body as JsonValue);
  const artifact: Artifact = Object.freeze({
    kind: value.kind as ArtifactKind,
    formatVersion: 1,
    id: value.id,
    contentHash: value.contentHash,
    dependencies: Object.freeze(normalized.value.map((dependency) => Object.freeze(dependency))),
    body
  });
  const expectedHash = await sha256Json(artifactSemanticValue(artifact));
  if (expectedHash !== artifact.contentHash) return { success: false, issues: [createIssue({ code: 'artifact.hash_mismatch', retry: 'after_input', details: { expected: expectedHash, actual: artifact.contentHash } })] };
  return { success: true, value: artifact, issues: [] };
};

export const safeParseJsonText = (text: string, budget: ArtifactParseBudget = defaultArtifactParseBudget): ParseResult<JsonValue> => {
  const byteLength = utf8ByteLength(text);
  if (byteLength > budget.maxBytes) return { success: false, issues: [createIssue({ code: 'artifact.budget_exceeded', retry: 'after_input', details: { budget: 'maxBytes', limit: budget.maxBytes } })] };
  try {
    const value = JSON.parse(text) as unknown;
    inspectJsonTextMemberNames(text);
    return safeParseJsonValue(value, budget);
  } catch (error) {
    const issue = error instanceof JsonTextIssue ? error.issue : createIssue({ code: 'artifact.invalid_json', retry: 'after_input' });
    return { success: false, issues: [issue] };
  }
};

class JsonTextIssue extends Error {
  readonly issue: Issue;

  constructor(issue: Issue) {
    super(issue.code);
    this.issue = issue;
  }
}

type JsonTextPath = {
  readonly parent?: JsonTextPath;
  readonly segment: string | number;
};

type JsonTextContainer =
  | {
      readonly kind: 'array';
      readonly path: JsonTextPath | undefined;
      nextIndex: number;
    }
  | {
      readonly kind: 'object';
      readonly path: JsonTextPath | undefined;
      readonly keys: Set<string>;
      pendingKey: string | undefined;
    };

/** Native parsing is stack-safe; this lexical pass retains duplicate-key evidence. */
const inspectJsonTextMemberNames = (text: string): void => {
  const containers: JsonTextContainer[] = [];
  let position = 0;
  while (position < text.length) {
    const char = text[position] as string;
    if (' \t\r\n,:'.includes(char)) {
      position += 1;
      continue;
    }
    if (char === '"') {
      const token = scanJsonString(text, position);
      position = token.end;
      const next = nextNonWhitespace(text, position);
      const container = containers.at(-1);
      if (text[next] === ':' && container?.kind === 'object') {
        const path = [...materializeTextPath(container.path), token.value];
        if (forbiddenKeys.has(token.value)) {
          throw new JsonTextIssue(createIssue({
            code: 'artifact.hostile_shape',
            retry: 'after_input',
            path,
            details: { reason: 'prototype_pollution_key' }
          }));
        }
        if (container.keys.has(token.value)) {
          throw new JsonTextIssue(createIssue({
            code: 'artifact.duplicate_member',
            retry: 'after_input',
            path,
            details: { member: token.value }
          }));
        }
        container.keys.add(token.value);
        container.pendingKey = token.value;
      } else {
        takeTextValuePath(container);
      }
      continue;
    }
    if (char === '{' || char === '[') {
      const path = takeTextValuePath(containers.at(-1));
      containers.push(char === '{'
        ? { kind: 'object', path, keys: new Set(), pendingKey: undefined }
        : { kind: 'array', path, nextIndex: 0 });
      position += 1;
      continue;
    }
    if (char === '}' || char === ']') {
      containers.pop();
      position += 1;
      continue;
    }
    takeTextValuePath(containers.at(-1));
    if (char === 't') position += 4;
    else if (char === 'f') position += 5;
    else if (char === 'n') position += 4;
    else {
      jsonNumberPattern.lastIndex = position;
      const number = jsonNumberPattern.exec(text);
      position += number?.[0].length ?? 1;
    }
  }
};

const scanJsonString = (
  text: string,
  start: number
): { readonly value: string; readonly end: number } => {
  let position = start + 1;
  while (position < text.length) {
    const code = text.charCodeAt(position);
    if (code === 0x22) {
      const end = position + 1;
      return {
        value: JSON.parse(text.slice(start, end)) as string,
        end
      };
    }
    if (code === 0x5c) position += 1;
    position += 1;
  }
  throw new SyntaxError('Unterminated JSON string');
};

const nextNonWhitespace = (text: string, start: number): number => {
  let position = start;
  while (position < text.length
    && ' \t\r\n'.includes(text[position] as string)) {
    position += 1;
  }
  return position;
};

const takeTextValuePath = (
  container: JsonTextContainer | undefined
): JsonTextPath | undefined => {
  if (container === undefined) return undefined;
  if (container.kind === 'array') {
    const path = {
      ...(container.path === undefined ? {} : { parent: container.path }),
      segment: container.nextIndex
    };
    container.nextIndex += 1;
    return path;
  }
  const key = container.pendingKey;
  container.pendingKey = undefined;
  return key === undefined
    ? container.path
    : {
        ...(container.path === undefined ? {} : { parent: container.path }),
        segment: key
      };
};

const materializeTextPath = (
  path: JsonTextPath | undefined
): readonly (string | number)[] => {
  const reversed: (string | number)[] = [];
  let current = path;
  while (current !== undefined) {
    reversed.push(current.segment);
    current = current.parent;
  }
  reversed.reverse();
  return reversed;
};

const utf8ByteLength = (text: string): number => {
  let bytes = 0;
  for (let index = 0; index < text.length; index += 1) {
    const first = text.charCodeAt(index);
    if (first <= 0x7f) bytes += 1;
    else if (first <= 0x7ff) bytes += 2;
    else if (first >= 0xd800 && first <= 0xdbff && index + 1 < text.length) {
      const second = text.charCodeAt(index + 1);
      if (second >= 0xdc00 && second <= 0xdfff) {
        bytes += 4;
        index += 1;
      } else bytes += 3;
    } else bytes += 3;
  }
  return bytes;
};

const invalidEnvelope = (reason: string): ParseResult<never> => ({ success: false, issues: [createIssue({ code: 'artifact.invalid_envelope', retry: 'after_input', details: { reason } })] });
const isRecord = (value: JsonValue): value is Readonly<Record<string, JsonValue>> => value !== null && typeof value === 'object' && !Array.isArray(value);
