import { describe, expect, it, vi } from 'vitest';
import {
  CapabilityRegistry,
  FullRecomputeStrategy,
  HostRuntimeRegistry,
  TarstateParseError,
  artifactSemanticValue,
  builtInCapabilityDeclarations,
  builtInCapabilityRefs,
  canonicalizeJson,
  capabilityRefFor,
  capabilityUnavailable,
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
  type JsonValue,
  type PreparedPlan
} from '../src/index.js';

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

  it('canonicalizes JSON deterministically and normalizes negative zero', () => {
    expect(canonicalizeJson({ z: -0, a: ['x', { b: true, a: null }] })).toBe('{"a":["x",{"a":null,"b":true}],"z":0}');
    expect(() => canonicalizeJson('\ud800')).toThrow(/Lone surrogate/);
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

  it('enforces text and structural budgets', () => {
    expect(safeParseJsonText('[]', { maxBytes: 1, maxDepth: 1, maxArrayMembers: 1, maxObjectMembers: 1, maxTotalMembers: 1, maxDependencies: 1 })).toMatchObject({ success: false, issues: [{ code: 'artifact.budget_exceeded' }] });
    expect(safeParseJsonText('[[0]]', { maxBytes: 10, maxDepth: 1, maxArrayMembers: 2, maxObjectMembers: 1, maxTotalMembers: 3, maxDependencies: 1 })).toMatchObject({ success: false, issues: [{ code: 'artifact.budget_exceeded' }] });
  });

  it('round-trips artifacts and rejects hash/dependency ambiguity', async () => {
    const artifact = await sealArtifact({ kind: 'schema', id: 'urn:test:schema', body: { relations: {} } });
    expect(await parseArtifactText(JSON.stringify(artifact))).toEqual(artifact);
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
    const first = host.acquire({ sourceId: 'source:one', identity, create: () => ({ runtime: { id: 1 }, close }) });
    const second = host.acquire({ sourceId: 'source:one', identity, create: () => ({ runtime: { id: 2 }, close }) });
    expect(second.runtime).toBe(first.runtime);
    expect(() => host.acquire({ sourceId: 'source:one', identity: {}, create: () => ({ runtime: {}, close }) })).toThrow(/different live source/);
    first.release();
    expect(close).not.toHaveBeenCalled();
    second.release();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('routes full recomputation through the same maintenance session seam', () => {
    type Snapshot = { readonly rows: readonly number[] };
    const plan: PreparedPlan<string> = { planId: 'plan', rootNodeId: 'root', query: 'numbers', registryFingerprint: 'registry', authorityFingerprint: 'authority', datasetId: 'dataset' };
    const strategy = new FullRecomputeStrategy<string, number, Snapshot, unknown>((_plan, snapshot) => ({ rows: snapshot.rows, resultKeys: snapshot.rows.map(String), completeness: 'exact', issues: [] }));
    const session = strategy.open(plan, { snapshot: { rows: [1] } });
    expect(session.current().rows).toEqual([1]);
    expect(session.update({ snapshot: { rows: [2, 3] }, change: { stale: true } }).rows).toEqual([2, 3]);
    session.close();
    expect(() => session.update({ snapshot: { rows: [] } })).toThrow(/closed/);
  });
});

const _jsonValueFixture: JsonValue = { ok: true };
void _jsonValueFixture;
