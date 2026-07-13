import { describe, expect, it, vi } from 'vitest';
import {
  CapabilityRegistry,
  HostRuntimeRegistry,
  TarstateParseError,
  artifactSemanticValue,
  builtInCapabilityDeclarations,
  builtInCapabilityRefs,
  canonicalizeJson,
  capabilityRefFor,
  capabilityUnavailable,
  createRuntimeKind,
  createIssue,
  issueCatalog,
  logicalAnd,
  logicalNot,
  logicalOr,
  logicalUnknown,
  missingValue,
  parseArtifactText,
  safeParseArtifactText,
  safeParseJsonText,
  safeParseJsonValue,
  sealArtifact,
  sha256Json,
  verifyBuiltInCapabilities,
  type CapabilityDeclaration,
  type JsonValue
} from '../src/index.js';
import { canonicalizeJsonWithCache } from '../src/internal-canonical-json.js';

const hash = (character: string) => `sha256:${character.repeat(64)}` as const;

describe('production foundation', () => {
  it('reconstructs every frozen built-in capability reference and implication', async () => {
    expect(await verifyBuiltInCapabilities()).toBe(true);
    const refs = await Promise.all(builtInCapabilityDeclarations.map(capabilityRefFor));
    expect(refs).toHaveLength(10);
    expect(builtInCapabilityDeclarations.find(({ id }) => id.endsWith('copy-relocate'))?.implies).toEqual([builtInCapabilityRefs.move]);
    expect(refs).toContainEqual(builtInCapabilityRefs.durableOperationReceipts);
  });

  it('keeps logical unknown, missing, unavailable, and the string unknown disjoint', () => {
    expect(logicalUnknown).not.toBe(missingValue);
    expect(logicalUnknown).not.toBe(capabilityUnavailable);
    expect(logicalUnknown).not.toBe('unknown');
    expect(logicalAnd([true, logicalUnknown])).toBe(logicalUnknown);
    expect(logicalAnd([false, logicalUnknown])).toBe(false);
    expect(logicalOr([false, logicalUnknown])).toBe(logicalUnknown);
    expect(logicalNot(logicalUnknown)).toBe(logicalUnknown);
  });

  it('implements the complete strong Kleene truth tables', () => {
    const values = [true, false, logicalUnknown] as const;
    const andTable = [
      [true, false, logicalUnknown],
      [false, false, false],
      [logicalUnknown, false, logicalUnknown]
    ];
    const orTable = [
      [true, true, true],
      [true, false, logicalUnknown],
      [true, logicalUnknown, logicalUnknown]
    ];
    values.forEach((left, leftIndex) => values.forEach((right, rightIndex) => {
      expect(logicalAnd([left, right])).toBe(andTable[leftIndex]?.[rightIndex]);
      expect(logicalOr([left, right])).toBe(orTable[leftIndex]?.[rightIndex]);
    }));
    expect(values.map(logicalNot)).toEqual([false, true, logicalUnknown]);
  });

  it('canonicalizes JSON deterministically and normalizes negative zero', () => {
    expect(canonicalizeJson({ z: -0, a: ['x', { b: true, a: null }] })).toBe('{"a":["x",{"a":null,"b":true}],"z":0}');
    expect(() => canonicalizeJson('\ud800')).toThrow(/Lone surrogate/);
  });

  it('memoizes canonical subtrees only inside an explicit owned-graph context', () => {
    const leaf = Object.freeze({ value: Object.freeze([1, 2, 3]) });
    const root = Object.freeze({ first: leaf, second: leaf });
    const cache = new WeakMap<object, string>();
    const canonical = canonicalizeJsonWithCache(root, cache);

    expect(canonical).toBe('{"first":{"value":[1,2,3]},"second":{"value":[1,2,3]}}');
    expect(cache.get(root)).toBe(canonical);
    expect(cache.get(leaf)).toBe('{"value":[1,2,3]}');
    expect(cache.get(leaf.value)).toBe('[1,2,3]');
    expect(canonicalizeJsonWithCache(leaf, cache)).toBe(cache.get(leaf));
    const isolated = new WeakMap<object, string>();
    expect(canonicalizeJsonWithCache(root, isolated)).toBe(canonical);
    expect(isolated.has(root)).toBe(true);
  });

  it('seals named and deterministic inline artifacts with normalized dependencies', async () => {
    const dependency = { id: 'urn:test:dep', contentHash: hash('a'), locations: ['https://one', 'package:two'] };
    const named = await sealArtifact({ kind: 'query', id: 'urn:test:query', dependencies: [dependency, dependency], body: { root: 'test' } });
    expect(named.dependencies).toEqual([{ id: dependency.id, contentHash: dependency.contentHash }]);
    expect(named.contentHash).toBe(await sha256Json(artifactSemanticValue(named)));
    const inlineA = await sealArtifact({ kind: 'query', dependencies: [dependency], body: { root: 'test' } });
    const inlineB = await sealArtifact({ kind: 'query', dependencies: [{ ...dependency, locations: ['automerge:other'] }], body: { root: 'test' } });
    expect(inlineA).toEqual(inlineB);
    expect(inlineA.id).toMatch(/^urn:tarstate:inline:sha256:[0-9a-f]{64}$/);
    await expect(sealArtifact({ kind: 'query', id: 'urn:tarstate:inline:manual', body: {} })).rejects.toBeInstanceOf(TarstateParseError);
  });

  it('detaches and freezes sealed semantic content so its hash cannot drift', async () => {
    const body = { root: { literal: ['before'] } };
    const artifact = await sealArtifact({ kind: 'query', id: 'urn:test:owned-query', body });
    const originalHash = artifact.contentHash;

    body.root.literal[0] = 'after';

    expect(artifact.body).toEqual({ root: { literal: ['before'] } });
    expect(Object.isFrozen(artifact)).toBe(true);
    expect(Object.isFrozen(artifact.body)).toBe(true);
    expect(Object.isFrozen(artifact.body.root.literal)).toBe(true);
    expect(artifact.contentHash).toBe(originalHash);
    expect(artifact.contentHash).toBe(await sha256Json(artifactSemanticValue(artifact)));
  });

  it('detects duplicate JSON members before materialization at every depth', () => {
    expect(safeParseJsonText('{"outer":{"x":1,"x":2}}')).toMatchObject({ success: false, issues: [{ code: 'artifact.duplicate_member', path: ['outer', 'x'] }] });
    expect(safeParseJsonText('{"__proto__":{}}')).toMatchObject({ success: false, issues: [{ code: 'artifact.hostile_shape' }] });
  });

  it('rejects cycles, sparse arrays, accessors, hostile prototypes, and throwing proxies', () => {
    const cycle: { self?: unknown } = {};
    cycle.self = cycle;
    expect(safeParseJsonValue(cycle)).toMatchObject({ success: false, issues: [{ code: 'artifact.cycle' }] });
    expect(safeParseJsonValue(Array(1))).toMatchObject({ success: false, issues: [{ code: 'artifact.hostile_shape' }] });
    const accessor = Object.defineProperty({}, 'value', { enumerable: true, get: () => 1 });
    expect(safeParseJsonValue(accessor)).toMatchObject({ success: false, issues: [{ code: 'artifact.hostile_shape' }] });
    expect(safeParseJsonValue(Object.create(null))).toMatchObject({ success: false, issues: [{ code: 'artifact.hostile_shape' }] });
    const hostile = new Proxy({}, { getPrototypeOf: () => { throw new Error('no'); } });
    expect(safeParseJsonValue(hostile)).toMatchObject({ success: false, issues: [{ code: 'artifact.hostile_shape' }] });
  });

  it('accepts ordinary JSON records that happen to have issue-shaped fields', () => {
    const value = { code: 'application.code', severity: 'error', nested: [{ code: 'nested.code', severity: 'warning' }] };
    expect(safeParseJsonValue(value)).toEqual({ success: true, value, issues: [] });
  });

  it('enforces text and structural budgets', () => {
    expect(safeParseJsonText('[]', { maxBytes: 1, maxDepth: 1, maxArrayMembers: 1, maxObjectMembers: 1, maxTotalMembers: 1, maxDependencies: 1 })).toMatchObject({ success: false, issues: [{ code: 'artifact.budget_exceeded' }] });
    expect(safeParseJsonText('[[0]]', { maxBytes: 10, maxDepth: 1, maxArrayMembers: 2, maxObjectMembers: 1, maxTotalMembers: 3, maxDependencies: 1 })).toMatchObject({ success: false, issues: [{ code: 'artifact.budget_exceeded' }] });
  });

  it('publishes immutable issue policy and issue envelopes', () => {
    const declaration = issueCatalog.get('source.not_ready');
    expect(declaration).toBeDefined();
    expect(() => (issueCatalog as Map<string, unknown>).set('source.not_ready', {})).toThrow();
    expect(() => Map.prototype.set.call(issueCatalog, 'source.not_ready', {})).toThrow();
    expect(Object.isFrozen(declaration)).toBe(true);
    expect(Object.isFrozen(declaration?.retries)).toBe(true);

    const issue = createIssue({ code: 'source.not_ready', sourceId: 'source:test', path: ['state'], requiredCapabilities: [builtInCapabilityRefs.fieldReplace] });
    expect(Object.isFrozen(issue)).toBe(true);
    expect(Object.isFrozen(issue.path)).toBe(true);
    expect(Object.isFrozen(issue.requiredCapabilities)).toBe(true);
  });

  it('owns identity-bearing issue payloads before generating their id', () => {
    const key = { tenant: 'one', nested: [1, { active: true }] };
    const path = ['relations', { id: 'users' }];
    const details = { reason: 'not_ready', context: { attempts: [1, 2] } };
    const issue = createIssue({ code: 'source.not_ready', key, path, details });
    const originalId = issue.id;

    key.tenant = 'two';
    key.nested[1] = { active: false };
    path[0] = 'changed';
    details.context.attempts.push(3);

    expect(issue.id).toBe(originalId);
    expect(issue.key).toEqual({ tenant: 'one', nested: [1, { active: true }] });
    expect(issue.path).toEqual(['relations', { id: 'users' }]);
    expect(issue.details).toEqual({ reason: 'not_ready', context: { attempts: [1, 2] } });
    expect(Object.isFrozen(issue.key)).toBe(true);
    expect(Object.isFrozen((issue.key as { nested: unknown[] }).nested)).toBe(true);
    expect(Object.isFrozen(issue.details)).toBe(true);
    expect(Object.isFrozen((issue.details as { context: { attempts: unknown[] } }).context.attempts)).toBe(true);
    expect(createIssue({ code: 'source.not_ready', key: { tenant: 'one', nested: [1, { active: true }] }, path: ['relations', { id: 'users' }], details: { reason: 'not_ready', context: { attempts: [1, 2] } } }).id).toBe(originalId);
  });

  it('rejects non-portable and hostile issue payloads as programmer errors', () => {
    let reads = 0;
    const hostile = Object.defineProperty({}, 'secret', { enumerable: true, get: () => { reads += 1; return 'read'; } });
    expect(() => createIssue({ code: 'source.not_ready', details: hostile })).toThrow(TypeError);
    expect(reads).toBe(0);
    expect(() => createIssue({ code: 'source.not_ready', key: new Date() })).toThrow(/Invalid issue key/);
    expect(() => createIssue({ code: 'source.not_ready', path: ['state', undefined] })).toThrow(/Invalid issue path/);
    expect(() => createIssue({ code: 'source.not_ready', details: { value: Number.NaN } })).toThrow(/Invalid issue details/);
  });

  it('round-trips artifacts and rejects hash/dependency ambiguity', async () => {
    const artifact = await sealArtifact({ kind: 'schema', id: 'urn:test:schema', body: { relations: {} } });
    const parsed = await parseArtifactText(JSON.stringify(artifact));
    expect(parsed).toEqual(artifact);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.dependencies)).toBe(true);
    expect(Object.isFrozen(parsed.body)).toBe(true);
    expect(await safeParseArtifactText(JSON.stringify({ ...artifact, contentHash: hash('f') }))).toMatchObject({ success: false, issues: [{ code: 'artifact.hash_mismatch' }] });
    await expect(sealArtifact({ kind: 'query', id: 'urn:test:ambiguous', dependencies: [{ id: 'same', contentHash: hash('1') }, { id: 'same', contentHash: hash('2') }], body: {} })).rejects.toMatchObject({ issues: [{ code: 'artifact.dependency_ambiguous' }] });
  });

  it('owns capability and source registries explicitly per host', async () => {
    const weak: CapabilityDeclaration = { kind: 'tarstate.capability-contract', formatVersion: 1, id: 'urn:test:weak', version: '1', class: 'edit', contract: { operation: 'weak' }, implies: [] };
    const weakRef = await capabilityRefFor(weak);
    const strong: CapabilityDeclaration = { kind: 'tarstate.capability-contract', formatVersion: 1, id: 'urn:test:strong', version: '1', class: 'edit', contract: { operation: 'strong' }, implies: [weakRef] };
    const registry = new CapabilityRegistry('trust:test');
    expect(await registry.registerDeclaration(weak)).toMatchObject({ success: true });
    const strongResult = await registry.registerDeclaration(strong);
    expect(strongResult).toMatchObject({ success: true });
    if (!strongResult.success) throw new Error('expected strong capability');
    registry.registerImplementation({ ref: strongResult.value, integrity: 'sha256:implementation', implementation: {} });
    expect(registry.satisfies(weakRef)).toBe(true);
    expect(await registry.fingerprint()).toMatch(/^sha256:[0-9a-f]{64}$/);

    const host = new HostRuntimeRegistry({ trustPolicyId: 'host:test' });
    const close = vi.fn();
    const identity = {};
    const kind = createRuntimeKind<{ id: number }>();
    const first = host.acquire({ sourceId: 'source:one', identity, kind, create: () => ({ runtime: { id: 1 }, close }) });
    const second = host.acquire({ sourceId: 'source:one', identity, kind, create: () => ({ runtime: { id: 2 }, close }) });
    expect(second.runtime).toBe(first.runtime);
    expect(() => host.acquire({ sourceId: 'source:one', identity: {}, kind, create: () => ({ runtime: { id: 3 }, close }) })).toThrow(/different live source/);
    expect(() => host.acquire({ sourceId: 'source:one', identity, kind: createRuntimeKind<object>(), create: () => ({ runtime: {}, close }) })).toThrow(/different runtime kind/);
    first.release();
    expect(close).not.toHaveBeenCalled();
    second.release();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('invalidates cached capability reachability after implementations and declarations change', async () => {
    const leaf: CapabilityDeclaration = { kind: 'tarstate.capability-contract', formatVersion: 1, id: 'urn:test:cache-leaf', version: '1', class: 'edit', contract: {}, implies: [] };
    const leafRef = await capabilityRefFor(leaf);
    const middle: CapabilityDeclaration = { kind: 'tarstate.capability-contract', formatVersion: 1, id: 'urn:test:cache-middle', version: '1', class: 'edit', contract: {}, implies: [leafRef] };
    const middleRef = await capabilityRefFor(middle);
    const strong: CapabilityDeclaration = { kind: 'tarstate.capability-contract', formatVersion: 1, id: 'urn:test:cache-strong', version: '1', class: 'edit', contract: {}, implies: [middleRef] };
    const strongRef = await capabilityRefFor(strong);
    const registry = new CapabilityRegistry('trust:cache-invalidation');
    await registry.registerDeclaration(leaf);
    await registry.registerDeclaration(strong);

    expect(registry.satisfies(strongRef)).toBe(false);
    expect(registry.satisfies(leafRef)).toBe(false);
    registry.registerImplementation({ ref: strongRef, integrity: 'sha256:strong', implementation: {} });
    expect(registry.satisfies(strongRef)).toBe(true);
    expect(registry.satisfies(leafRef)).toBe(false);

    await registry.registerDeclaration(middle);
    expect(registry.satisfies(leafRef)).toBe(true);
  });

  it('owns frozen capability metadata independently of registration inputs', async () => {
    const weak: CapabilityDeclaration = { kind: 'tarstate.capability-contract', formatVersion: 1, id: 'urn:test:owned-weak', version: '1', class: 'edit', contract: {}, implies: [] };
    const weakRef = await capabilityRefFor(weak);
    const declaration = { kind: 'tarstate.capability-contract', formatVersion: 1, id: 'urn:test:owned-strong', version: '1', class: 'edit', contract: { mode: 'before' }, implies: [] } as CapabilityDeclaration & { contract: { mode: string }; implies: typeof weakRef[] };
    const registry = new CapabilityRegistry('trust:owned');
    const registered = await registry.registerDeclaration(declaration);
    if (!registered.success) throw new Error('declaration registration failed');
    const implementation = { ref: registered.value, integrity: 'before', implementation: {} };
    expect(registry.registerImplementation(implementation)).toMatchObject({ success: true });
    const fingerprint = await registry.fingerprint();

    declaration.contract.mode = 'after';
    declaration.implies.push(weakRef);
    implementation.integrity = 'after';

    expect(registry.declaration(registered.value)).toMatchObject({ contract: { mode: 'before' }, implies: [] });
    expect(registry.satisfies(weakRef)).toBe(false);
    expect(registry.implementation(registered.value)?.integrity).toBe('before');
    expect(Object.isFrozen(registry.declaration(registered.value))).toBe(true);
    expect(Object.isFrozen(registry.implementation(registered.value))).toBe(true);
    expect(await registry.fingerprint()).toBe(fingerprint);
  });

  it('keeps capability behavior stable under duplicate registration', async () => {
    const declaration: CapabilityDeclaration = { kind: 'tarstate.capability-contract', formatVersion: 1, id: 'urn:test:stable-implementation', version: '1', class: 'function', contract: {}, implies: [] };
    const registry = new CapabilityRegistry('trust:stable-implementation');
    const registered = await registry.registerDeclaration(declaration);
    if (!registered.success) throw new Error('declaration registration failed');
    const implementation = () => 'first';
    const first = registry.registerImplementation({ ref: registered.value, integrity: 'sha256:stable', implementation });
    const revision = registry.revision;
    const fingerprint = await registry.fingerprint();

    expect(registry.registerImplementation({ ref: registered.value, integrity: 'sha256:stable', implementation })).toEqual(first);
    expect(registry.revision).toBe(revision);
    expect(registry.registerImplementation({ ref: registered.value, integrity: 'sha256:stable', implementation: () => 'second' }))
      .toMatchObject({ success: false, issues: [{ code: 'capability.registry_conflict', details: { reason: 'implementation_identity_changed' } }] });
    expect(registry.implementation(registered.value)?.implementation).toBe(implementation);
    expect(await registry.fingerprint()).toBe(fingerprint);
  });

  it('uses unambiguous capability keys for declarations and implementations', async () => {
    const declaration: CapabilityDeclaration = {
      kind: 'tarstate.capability-contract',
      formatVersion: 1,
      id: 'a',
      version: 'b\u0000c',
      class: 'function',
      contract: {},
      implies: []
    };
    const registry = new CapabilityRegistry('trust:unambiguous-keys');
    const registered = await registry.registerDeclaration(declaration);
    if (!registered.success) throw new Error('declaration registration failed');
    expect(registry.registerImplementation({ ref: registered.value, integrity: 'sha256:implementation', implementation: {} }))
      .toMatchObject({ success: true });
    const colliding = {
      id: 'a\u0000b',
      version: 'c',
      contractHash: registered.value.contractHash
    };

    expect(registry.declaration(colliding)).toBeUndefined();
    expect(registry.implementation(colliding)).toBeUndefined();
    expect(registry.satisfies(colliding)).toBe(false);
  });

  it('rejects malformed capability declarations instead of structurally casting them', async () => {
    const registry = new CapabilityRegistry('trust:malformed');
    expect(await registry.registerDeclaration({
      kind: 'tarstate.capability-contract', formatVersion: 1, id: '', version: '1', class: 'edit', contract: {}, implies: []
    })).toMatchObject({ success: false, issues: [{ code: 'artifact.invalid_envelope' }] });
    expect(await registry.registerDeclaration({
      kind: 'tarstate.capability-contract', formatVersion: 1, id: 'urn:test:extra', version: '1', class: 'edit', contract: {}, implies: [], extra: true
    } as unknown as CapabilityDeclaration)).toMatchObject({ success: false, issues: [{ code: 'artifact.invalid_envelope' }] });
  });

  it('keeps capability upgrades and downgrades exact rather than version-ordered', async () => {
    const v1: CapabilityDeclaration = { kind: 'tarstate.capability-contract', formatVersion: 1, id: 'urn:test:versioned', version: '1', class: 'function', contract: { operation: 'versioned-1' }, implies: [] };
    const v2: CapabilityDeclaration = { kind: 'tarstate.capability-contract', formatVersion: 1, id: 'urn:test:versioned', version: '2', class: 'function', contract: { operation: 'versioned-2' }, implies: [] };
    const v1Ref = await capabilityRefFor(v1);
    const v2Ref = await capabilityRefFor(v2);
    const upgraded = new CapabilityRegistry('trust:versions');
    await upgraded.registerDeclaration(v1);
    await upgraded.registerDeclaration(v2);
    upgraded.registerImplementation({ ref: v2Ref, integrity: 'sha256:v2', implementation: {} });
    expect(upgraded.satisfies(v2Ref)).toBe(true);
    expect(upgraded.satisfies(v1Ref)).toBe(false);

    const downgraded = new CapabilityRegistry('trust:versions');
    await downgraded.registerDeclaration(v1);
    downgraded.registerImplementation({ ref: v1Ref, integrity: 'sha256:v1', implementation: {} });
    expect(downgraded.satisfies(v1Ref)).toBe(true);
    expect(downgraded.satisfies(v2Ref)).toBe(false);
    expect(await downgraded.fingerprint()).not.toBe(await upgraded.fingerprint());
  });

  it('closes host runtimes once and cannot be resurrected by stale leases', () => {
    const host = new HostRuntimeRegistry({ trustPolicyId: 'host:closed' });
    const close = vi.fn();
    const kind = createRuntimeKind<object>();
    const lease = host.acquire({ sourceId: 'source:closed', identity: {}, kind, create: () => ({ runtime: {}, close }) });
    host.close();
    host.close();
    lease.release();
    expect(close).toHaveBeenCalledOnce();
    expect(() => host.acquire({ sourceId: 'source:new', identity: {}, kind, create: () => ({ runtime: {}, close }) })).toThrow(/closed/);
  });

  it('removes a final runtime lease even when its close callback throws', () => {
    const host = new HostRuntimeRegistry({ trustPolicyId: 'host:throwing-release' });
    const kind = createRuntimeKind<object>();
    const first = host.acquire({
      sourceId: 'source:throwing',
      identity: {},
      kind,
      create: () => ({ runtime: {}, close: () => { throw new Error('close failed'); } })
    });

    expect(() => first.release()).toThrow('close failed');
    expect(host.activeSourceIds()).toEqual([]);
    const replacement = host.acquire({
      sourceId: 'source:throwing',
      identity: {},
      kind,
      create: () => ({ runtime: { replacement: true }, close: () => undefined })
    });
    expect(replacement.runtime).toEqual({ replacement: true });
    replacement.release();
  });

  it('closes every host runtime before propagating a cleanup failure', () => {
    const host = new HostRuntimeRegistry({ trustPolicyId: 'host:throwing-close' });
    const kind = createRuntimeKind<object>();
    const laterClose = vi.fn();
    host.acquire({
      sourceId: 'source:first', identity: {}, kind,
      create: () => ({ runtime: {}, close: () => { throw new Error('first close failed'); } })
    });
    host.acquire({ sourceId: 'source:later', identity: {}, kind, create: () => ({ runtime: {}, close: laterClose }) });

    expect(() => host.close()).toThrow('first close failed');
    expect(laterClose).toHaveBeenCalledOnce();
    expect(host.activeSourceIds()).toEqual([]);
    expect(() => host.acquire({ sourceId: 'source:new', identity: {}, kind, create: () => ({ runtime: {}, close: () => undefined }) })).toThrow(/closed/);
  });

});

const _jsonValueFixture: JsonValue = { ok: true };
void _jsonValueFixture;

const hostRuntimeTypeFixture = (): void => {
  const typedHost = new HostRuntimeRegistry({ trustPolicyId: 'host:type-fixture' });
  const numberKind = createRuntimeKind<number>();
  typedHost.acquire({ sourceId: 'number', identity: {}, kind: numberKind, create: () => ({ runtime: 1, close: () => undefined }) });
  // @ts-expect-error a runtime-kind token cannot be reused for another runtime type
  typedHost.acquire({ sourceId: 'string', identity: {}, kind: numberKind, create: () => ({ runtime: 'wrong', close: () => undefined }) });
};
void hostRuntimeTypeFixture;
