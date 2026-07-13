import { createIssue, TarstateParseError, type Issue, type ParseResult } from './issues.js';
import { assertUnicodeScalarString, canonicalizeJsonValue, compareUnicodeScalars } from './internal-canonical-json.js';
import { detachAndFreezeJsonValue, freezeOwnedJsonValue } from './internal-owned-json.js';
import { stringTupleKey } from './internal-string-key.js';
import { defaultValueParseBudget, safeParseJsonValue, type JsonValue, type ValueParseBudget } from './value.js';

export const artifactKinds = ['schema', 'query', 'transaction', 'constraint-set', 'storage-mapping', 'schema-lens', 'issue-code-catalog'] as const;
export type ArtifactKind = typeof artifactKinds[number];
export type ContentHash = `sha256:${string}`;

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

export const defaultArtifactParseBudget: ArtifactParseBudget = {
  ...defaultValueParseBudget,
  maxBytes: 8 * 1024 * 1024,
  maxDependencies: 10_000
};

const hashPattern = /^sha256:[0-9a-f]{64}$/;
const forbiddenKeys = new Set(['__proto__', 'constructor', 'prototype']);

export const isContentHash = (value: unknown): value is ContentHash => typeof value === 'string' && hashPattern.test(value);

export const canonicalizeJson = canonicalizeJsonValue;

export const sha256Bytes = async (bytes: Uint8Array): Promise<ContentHash> => {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', Uint8Array.from(bytes).buffer);
  return `sha256:${[...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')}`;
};

export const sha256Json = (value: JsonValue): Promise<ContentHash> => sha256Bytes(new TextEncoder().encode(canonicalizeJson(value)));

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
  const byteLength = new TextEncoder().encode(text).byteLength;
  if (byteLength > budget.maxBytes) return { success: false, issues: [createIssue({ code: 'artifact.budget_exceeded', retry: 'after_input', details: { budget: 'maxBytes', limit: budget.maxBytes } })] };
  try {
    return { success: true, value: new DuplicateAwareJsonParser(text, budget).parse(), issues: [] };
  } catch (error) {
    const issue = error instanceof JsonTextIssue ? error.issue : createIssue({ code: 'artifact.invalid_json', retry: 'after_input' });
    return { success: false, issues: [issue] };
  }
};

class JsonTextIssue extends Error {
  constructor(readonly issue: Issue) { super(issue.code); }
}

class DuplicateAwareJsonParser {
  readonly #text: string;
  readonly #budget: ArtifactParseBudget;
  #position = 0;
  #totalMembers = 0;

  constructor(text: string, budget: ArtifactParseBudget) { this.#text = text; this.#budget = budget; }

  parse(): JsonValue {
    this.#skipWhitespace();
    const value = this.#value(0, []);
    this.#skipWhitespace();
    if (this.#position !== this.#text.length) this.#fail('artifact.invalid_json', [], { position: this.#position });
    return value;
  }

  #value(depth: number, path: readonly unknown[]): JsonValue {
    if (depth > this.#budget.maxDepth) this.#fail('artifact.budget_exceeded', path, { budget: 'maxDepth', limit: this.#budget.maxDepth });
    this.#skipWhitespace();
    const char = this.#text[this.#position];
    if (char === '{') return this.#object(depth, path);
    if (char === '[') return this.#array(depth, path);
    if (char === '"') return this.#string(path);
    if (char === 't' && this.#consume('true')) return true;
    if (char === 'f' && this.#consume('false')) return false;
    if (char === 'n' && this.#consume('null')) return null;
    return this.#number(path);
  }

  #object(depth: number, path: readonly unknown[]): JsonValue {
    this.#position += 1;
    this.#skipWhitespace();
    const output: Record<string, JsonValue> = {};
    const seen = new Set<string>();
    let members = 0;
    if (this.#text[this.#position] === '}') { this.#position += 1; return output; }
    while (true) {
      if (this.#text[this.#position] !== '"') this.#fail('artifact.invalid_json', path, { position: this.#position });
      const key = this.#string(path);
      if (forbiddenKeys.has(key)) this.#fail('artifact.hostile_shape', [...path, key], { reason: 'prototype_pollution_key' });
      if (seen.has(key)) this.#fail('artifact.duplicate_member', [...path, key], { member: key });
      seen.add(key);
      this.#skipWhitespace();
      if (this.#text[this.#position] !== ':') this.#fail('artifact.invalid_json', [...path, key], { position: this.#position });
      this.#position += 1;
      output[key] = this.#value(depth + 1, [...path, key]);
      members += 1;
      this.#memberBudget(members, this.#budget.maxObjectMembers, 'maxObjectMembers', path);
      this.#skipWhitespace();
      const separator = this.#text[this.#position];
      if (separator === '}') { this.#position += 1; return output; }
      if (separator !== ',') this.#fail('artifact.invalid_json', path, { position: this.#position });
      this.#position += 1;
      this.#skipWhitespace();
    }
  }

  #array(depth: number, path: readonly unknown[]): JsonValue {
    this.#position += 1;
    this.#skipWhitespace();
    const output: JsonValue[] = [];
    if (this.#text[this.#position] === ']') { this.#position += 1; return output; }
    while (true) {
      output.push(this.#value(depth + 1, [...path, output.length]));
      this.#memberBudget(output.length, this.#budget.maxArrayMembers, 'maxArrayMembers', path);
      this.#skipWhitespace();
      const separator = this.#text[this.#position];
      if (separator === ']') { this.#position += 1; return output; }
      if (separator !== ',') this.#fail('artifact.invalid_json', path, { position: this.#position });
      this.#position += 1;
    }
  }

  #string(path: readonly unknown[]): string {
    const start = this.#position;
    this.#position += 1;
    while (this.#position < this.#text.length) {
      const code = this.#text.charCodeAt(this.#position);
      if (code === 0x22) {
        this.#position += 1;
        const token = this.#text.slice(start, this.#position);
        try {
          const value = JSON.parse(token) as string;
          assertUnicodeScalarString(value);
          return value;
        } catch {
          this.#fail('artifact.invalid_json', path, { position: start });
        }
      }
      if (code < 0x20) this.#fail('artifact.invalid_json', path, { position: this.#position });
      if (code === 0x5c) {
        this.#position += 1;
        const escape = this.#text[this.#position];
        if (escape === 'u') {
          const digits = this.#text.slice(this.#position + 1, this.#position + 5);
          if (!/^[0-9a-fA-F]{4}$/.test(digits)) this.#fail('artifact.invalid_json', path, { position: this.#position });
          this.#position += 4;
        } else if (escape === undefined || !'"\\/bfnrt'.includes(escape)) this.#fail('artifact.invalid_json', path, { position: this.#position });
      }
      this.#position += 1;
    }
    this.#fail('artifact.invalid_json', path, { position: start });
  }

  #number(path: readonly unknown[]): number {
    const rest = this.#text.slice(this.#position);
    const match = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(rest);
    if (match === null) this.#fail('artifact.invalid_json', path, { position: this.#position });
    this.#position += match[0].length;
    const value = Number(match[0]);
    if (!Number.isFinite(value)) this.#fail('artifact.unsupported_value', path, { type: 'non_finite_number' });
    return Object.is(value, -0) ? 0 : value;
  }

  #consume(token: string): boolean {
    if (!this.#text.startsWith(token, this.#position)) return false;
    this.#position += token.length;
    return true;
  }

  #memberBudget(count: number, limit: number, name: string, path: readonly unknown[]): void {
    this.#totalMembers += 1;
    if (count > limit) this.#fail('artifact.budget_exceeded', path, { budget: name, limit });
    if (this.#totalMembers > this.#budget.maxTotalMembers) this.#fail('artifact.budget_exceeded', path, { budget: 'maxTotalMembers', limit: this.#budget.maxTotalMembers });
  }

  #skipWhitespace(): void {
    while (this.#position < this.#text.length && ' \t\r\n'.includes(this.#text[this.#position] as string)) this.#position += 1;
  }

  #fail(code: string, path: readonly unknown[], details?: unknown): never {
    throw new JsonTextIssue(createIssue({ code, phase: 'parse', severity: 'error', retry: 'after_input', path, ...(details === undefined ? {} : { details }) }));
  }
}

const invalidEnvelope = (reason: string): ParseResult<never> => ({ success: false, issues: [createIssue({ code: 'artifact.invalid_envelope', retry: 'after_input', details: { reason } })] });
const isRecord = (value: JsonValue): value is Readonly<Record<string, JsonValue>> => value !== null && typeof value === 'object' && !Array.isArray(value);
