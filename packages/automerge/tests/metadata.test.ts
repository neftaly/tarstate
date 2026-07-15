import { readFileSync, readdirSync } from 'node:fs';
import * as Automerge from '@automerge/automerge';
import {
  GovernanceCoordinator,
  type GovernanceCommand,
  type GovernanceSection
} from '@tarstate/core/transactions';
import type { DocumentDeclaration } from '@tarstate/core/attachment';
import { describe, expect, it } from 'vitest';
import { automergeIssueDeclarations } from '../src/issues.js';
import {
  applyAutomergeMetadataPlan,
  automergeGovernanceSourceAdapter,
  automergeMetadataProperty,
  planAutomergeMetadataMutation,
  readAutomergeMetadata
} from '../src/metadata.js';
import { AutomergeSourceRuntime, automergeBasis } from '../src/source.js';
import { AutomergeMapProjectionPlanner, snapshotAutomergeDocument } from '../src/storage-binding.js';
import { projectAutomergeFacts } from '../src/projection.js';

type MetadataDoc = {
  app?: Record<string, unknown>;
  __tarstateMetaV1?: unknown;
  __tarstateMetaV2?: unknown;
};

const actor = (digit: string): string => digit.repeat(64);
const hash = (digit: string): `sha256:${string}` => `sha256:${digit.repeat(64)}`;
const schema = (digit = 'a') => ({ id: 'urn:test:schema:' + digit, contentHash: hash(digit) });
const mapping = (digit = 'b') => ({ id: 'urn:test:mapping:' + digit, contentHash: hash(digit) });
const constraints = (digit = 'c') => ({ id: 'urn:test:constraints:' + digit, contentHash: hash(digit) });

const declaration = (schemaDigit = 'a'): DocumentDeclaration => ({
  formatVersion: 1,
  storageSchema: schema(schemaDigit),
  projection: { kind: 'storage-mapping', storageMapping: mapping() },
  constraints: { set: constraints(), mode: 'required' }
});

const carrier = (schemaDigit = 'a', extra: Record<string, unknown> = {}) => ({
  formatVersion: 1,
  storage: {
    storageSchema: schema(schemaDigit),
    projection: { kind: 'storage-mapping', storageMapping: mapping() },
    ...extra
  },
  constraints: { set: constraints(), mode: 'required', futureConstraintField: 'keep' },
  futureRootField: { keep: true }
});

const command = (
  doc: Automerge.Doc<MetadataDoc>,
  request: GovernanceCommand['request'],
  operationId = 'operation:metadata'
): GovernanceCommand => ({
  operationEpoch: 'governance:epoch:one',
  operationId,
  sourceId: 'source:metadata',
  expectedBasis: automergeBasis(doc),
  request
});

const docFrom = (value: MetadataDoc, digit = '1'): Automerge.Doc<MetadataDoc> => Automerge.from(value, { actor: actor(digit) });

describe('Automerge bootstrap metadata', () => {
  it('totally distinguishes absence, valid declarations, malformed declarations, and name collisions', () => {
    expect(readAutomergeMetadata(docFrom({}))).toMatchObject({ status: 'absent', documentStatus: 'absent', origin: 'none', writable: false, issues: [] });
    expect(readAutomergeMetadata(docFrom({ __tarstateMetaV1: carrier() }))).toMatchObject({
      status: 'valid', documentStatus: 'valid', origin: 'document', writable: true,
      declaration: { storageSchema: schema(), constraints: { mode: 'required' } }
    });
    expect(readAutomergeMetadata(docFrom({ __tarstateMetaV1: { formatVersion: 1, storage: { nope: true } } }))).toMatchObject({
      status: 'malformed', writable: false, issues: [{ code: 'automerge.metadata_malformed' }]
    });
    expect(readAutomergeMetadata(docFrom({ __tarstateMetaV1: { applicationOwned: true } }))).toMatchObject({
      status: 'name-collision', writable: false, issues: [{ code: 'automerge.metadata_name_collision' }]
    });
    expect(() => readAutomergeMetadata(new Proxy({} as Automerge.Doc<MetadataDoc>, { getOwnPropertyDescriptor: () => { throw new Error('hostile'); } }))).not.toThrow();
  });

  it('uses trusted out-of-band declarations without bypassing malformed or conflicted metadata', () => {
    const trusted = { declaration: declaration() };
    expect(readAutomergeMetadata(docFrom({}), { trustedOutOfBand: trusted })).toMatchObject({
      status: 'out-of-band', documentStatus: 'absent', origin: 'out-of-band', writable: true
    });
    const collision = docFrom({ __tarstateMetaV1: { app: true } });
    expect(readAutomergeMetadata(collision, { trustedOutOfBand: trusted })).toMatchObject({
      status: 'out-of-band', documentStatus: 'name-collision', writable: false, issues: [{ code: 'automerge.metadata_name_collision' }, { code: 'automerge.metadata_override_read_only' }]
    });
    expect(readAutomergeMetadata(collision, {
      trustedOutOfBand: { ...trusted, classifyNameCollisionAsApplicationData: true, constraintActivationComplete: true }
    })).toMatchObject({ status: 'out-of-band', documentStatus: 'name-collision', writable: true });
    const malformed = docFrom({ __tarstateMetaV1: { formatVersion: 1, storage: 'bad' } });
    expect(readAutomergeMetadata(malformed, { trustedOutOfBand: trusted })).toMatchObject({
      status: 'out-of-band', documentStatus: 'malformed', writable: false, issues: [{ code: 'automerge.metadata_malformed' }, { code: 'automerge.metadata_override_read_only' }]
    });
  });

  it('preserves every root and section conflict alternative and never guesses a winner', () => {
    const base = docFrom({ __tarstateMetaV1: carrier() });
    let left = Automerge.clone(base, { actor: actor('2') });
    let right = Automerge.clone(base, { actor: actor('3') });
    left = Automerge.change(left, (draft) => {
      (draft.__tarstateMetaV1 as { storage: unknown }).storage = carrier('d', { selectedUnknown: 'left' }).storage;
    });
    right = Automerge.change(right, (draft) => {
      (draft.__tarstateMetaV1 as { storage: unknown }).storage = carrier('e', { selectedUnknown: 'right' }).storage;
    });
    const merged = Automerge.merge(left, right);
    const read = readAutomergeMetadata(merged, { trustedOutOfBand: { declaration: declaration() } });
    expect(read).toMatchObject({ status: 'out-of-band', documentStatus: 'conflict', origin: 'out-of-band', writable: false });
    expect(read.alternatives).toHaveLength(2);
    expect(read.alternatives.map(({ scope }) => scope)).toEqual(['storage', 'storage']);
    expect(read.alternatives.every(({ changeHash, value, section }) => changeHash.length > 0 && value !== undefined && section?.kind === 'storage')).toBe(true);

    const empty = docFrom({});
    let rootLeft = Automerge.clone(empty, { actor: actor('4') });
    let rootRight = Automerge.clone(empty, { actor: actor('5') });
    rootLeft = Automerge.change(rootLeft, (draft) => { draft.__tarstateMetaV1 = carrier('d'); });
    rootRight = Automerge.change(rootRight, (draft) => { draft.__tarstateMetaV1 = carrier('e'); });
    const rootRead = readAutomergeMetadata(Automerge.merge(rootLeft, rootRight));
    expect(rootRead).toMatchObject({ status: 'conflict', origin: 'none', writable: false, issues: [{ code: 'automerge.metadata_conflict' }] });
    expect(rootRead.alternatives).toHaveLength(2);
    expect(rootRead.alternatives.every(({ scope }) => scope === 'root')).toBe(true);
    expect(rootRead).not.toHaveProperty('declaration');
  });

  it('initializes only an absent exact basis with governance authority and preserves future sibling keys', () => {
    const initial = docFrom({ app: { keep: true }, __tarstateMetaV2: { future: true } });
    const initialize = command(initial, { action: 'initialize_declaration', declaration: declaration() });
    expect(planAutomergeMetadataMutation(initial, initialize, { governanceAuthorized: false })).toMatchObject({
      outcome: 'rejected', issues: [{ code: 'automerge.metadata_governance_required' }]
    });
    const plan = planAutomergeMetadataMutation(initial, initialize, { governanceAuthorized: true });
    expect(plan.outcome).toBe('planned');
    if (plan.outcome !== 'planned') return;
    const concurrent = Automerge.change(Automerge.clone(initial, { actor: actor('8') }), (draft) => { draft.app = { changed: true }; });
    const applied = applyAutomergeMetadataPlan(initial, plan);
    expect(applied.outcome).toBe('committed');
    expect(readAutomergeMetadata(applied.doc)).toMatchObject({ status: 'valid', declaration: declaration() });
    expect(applied.doc).toMatchObject({ app: { keep: true }, __tarstateMetaV2: { future: true } });

    const stale = applyAutomergeMetadataPlan(concurrent, plan);
    expect(stale).toMatchObject({ outcome: 'rejected', issues: [{ code: 'automerge.metadata_expected_basis_stale' }] });
  });

  it('repairs only the exact observed section alternative and preserves selected unknown fields', () => {
    const base = docFrom({ __tarstateMetaV1: carrier() });
    let left = Automerge.clone(base, { actor: actor('6') });
    let right = Automerge.clone(base, { actor: actor('7') });
    left = Automerge.change(left, (draft) => { (draft.__tarstateMetaV1 as { storage: unknown }).storage = carrier('d', { selectedUnknown: 'left' }).storage; });
    right = Automerge.change(right, (draft) => { (draft.__tarstateMetaV1 as { storage: unknown }).storage = carrier('e', { selectedUnknown: 'right' }).storage; });
    const merged = Automerge.merge(left, right);
    const read = readAutomergeMetadata(merged);
    const alternatives = read.alternatives.flatMap(({ section }) => section === undefined ? [] : [section]);
    const selected = alternatives.find((section) => section.kind === 'storage' && section.storageSchema.id.endsWith(':d'));
    if (selected === undefined) throw new Error('selected repair alternative missing');
    const repair = command(merged, { action: 'repair_declaration', section: 'storage', alternatives, selected });
    const plan = planAutomergeMetadataMutation(merged, repair, { governanceAuthorized: true });
    expect(plan.outcome).toBe('planned');
    if (plan.outcome !== 'planned') return;
    const changedAlternatives = alternatives.map((section, index): GovernanceSection => index === 0 && section.kind === 'storage'
      ? { ...section, storageSchema: schema('f') }
      : section);
    expect(planAutomergeMetadataMutation(merged, command(merged, { action: 'repair_declaration', section: 'storage', alternatives: changedAlternatives, selected: changedAlternatives[0]! }), { governanceAuthorized: true })).toMatchObject({
      outcome: 'rejected', issues: [{ code: 'automerge.metadata_repair_alternatives_changed' }]
    });
    const applied = applyAutomergeMetadataPlan(merged, plan);
    expect(applied.outcome).toBe('committed');
    const repaired = readAutomergeMetadata(applied.doc);
    expect(repaired).toMatchObject({ status: 'valid', declaration: { storageSchema: { id: expect.stringContaining(':d') } } });
    expect((repaired.raw as { storage: { selectedUnknown: string } }).storage.selectedUnknown).toBe('left');
  });

  it('replaces a complete constraint section while preserving unknown old-reader fields', () => {
    const initial = docFrom({ __tarstateMetaV1: carrier(), __tarstateMetaV2: { formatVersion: 2, opaque: true } });
    const activate = command(initial, {
      action: 'activate_constraints',
      activation: { kind: 'constraints', set: constraints('d'), mode: 'audit' }
    });
    const plan = planAutomergeMetadataMutation(initial, activate, { governanceAuthorized: true });
    expect(plan.outcome).toBe('planned');
    if (plan.outcome !== 'planned') return;
    const applied = applyAutomergeMetadataPlan(initial, plan);
    expect(applied.outcome).toBe('committed');
    const read = readAutomergeMetadata(applied.doc);
    expect(read).toMatchObject({ status: 'valid', declaration: { constraints: { set: constraints('d'), mode: 'audit' } } });
    expect(read.raw).toMatchObject({ futureRootField: { keep: true }, constraints: { futureConstraintField: 'keep' } });
    expect(applied.doc.__tarstateMetaV2).toEqual({ formatVersion: 2, opaque: true });
  });

  it('runs initialization through the core governance coordinator and emits exact basis evidence', async () => {
    const runtime = new AutomergeSourceRuntime({ sourceId: 'source:metadata', doc: docFrom({}) });
    const coordinator = new GovernanceCoordinator({ authorityViewFingerprint: hash('9'), authorize: () => ({ allowed: true }) });
    coordinator.registerSource(runtime.sourceId, 'governance:epoch:one', automergeGovernanceSourceAdapter(runtime));
    const receipt = await coordinator.execute(command(runtime.snapshot().storage, { action: 'initialize_declaration', declaration: declaration() }, 'operation:coordinated'));
    expect(receipt).toMatchObject({
      kind: 'governance', action: 'initialize_declaration', outcome: 'committed', durability: 'memory',
      beforeBasis: { kind: 'automerge-heads' }, afterBasis: { kind: 'automerge-heads' }, selectedArtifactHashes: [schema().contentHash, mapping().contentHash, constraints().contentHash].sort()
    });
    expect(readAutomergeMetadata(runtime.snapshot().storage).status).toBe('valid');
    const stale: GovernanceCommand = {
      ...command(runtime.snapshot().storage, {
        action: 'activate_constraints',
        activation: { kind: 'constraints', set: constraints('d'), mode: 'audit' }
      }, 'operation:stale'),
      expectedBasis: receipt.beforeBasis!
    };
    const staleReceipt = await coordinator.execute(stale);
    expect(staleReceipt).toMatchObject({ outcome: 'rejected', issues: [{ code: 'governance.expected_basis_stale' }] });
    expect(await coordinator.execute(stale)).toBe(staleReceipt);
  });

  it('keeps reserved metadata out of bindings and facts and rejects direct writes', () => {
    const doc = docFrom({ app: { value: 'visible' }, __tarstateMetaV1: carrier(), __tarstateMetaV2: { future: true } });
    const binding = new AutomergeMapProjectionPlanner<MetadataDoc, Readonly<Record<string, import('@tarstate/core').JsonValue>>>({
      relationId: 'relation:root', collectionPath: [], missingCollection: 'invalid', keySource: 'map-key'
    });
    const snapshot = snapshotAutomergeDocument('source:metadata', doc);
    expect(binding.project(snapshot).rows.map(({ key }) => key[0])).toEqual(['app']);
    expect(binding.plan(snapshot, [{ kind: 'replace', path: [automergeMetadataProperty, 'storage'], value: {} }])).toMatchObject({
      commands: [], issues: [{ code: 'automerge.reserved_metadata_write' }]
    });
    expect(binding.plan(snapshot, [{ kind: 'replace', path: ['__tarstateMetaV2'], value: {} }])).toMatchObject({
      commands: [], issues: [{ code: 'automerge.reserved_metadata_write' }]
    });
    const facts = projectAutomergeFacts(doc);
    expect(facts.properties.some(({ path }) => typeof path[0] === 'string' && path[0].startsWith('__tarstateMetaV'))).toBe(false);
    expect(facts.objects.some(({ path }) => typeof path[0] === 'string' && path[0].startsWith('__tarstateMetaV'))).toBe(false);
  });

  it('publishes a unique declaration for every emitted public Automerge issue code', () => {
    const sourceDirectory = new URL('../src/', import.meta.url);
    const patterns = [/(?:code|issueCode):\s*['"](automerge\.[a-z0-9_.-]+)['"]/g, /metadataIssue\(\s*['"](automerge\.[a-z0-9_.-]+)['"]/g];
    const emitted = new Set<string>();
    for (const file of readdirSync(sourceDirectory).filter((name) => name.endsWith('.ts') && name !== 'issues.ts')) {
      const text = readFileSync(new URL(file, sourceDirectory), 'utf8');
      for (const pattern of patterns) for (const match of text.matchAll(pattern)) if (match[1] !== undefined) emitted.add(match[1]);
    }
    const declarations = automergeIssueDeclarations.map(({ code }) => code);
    expect(new Set(declarations).size).toBe(declarations.length);
    expect([...emitted].filter((code) => !declarations.includes(code))).toEqual([]);
  });
});
