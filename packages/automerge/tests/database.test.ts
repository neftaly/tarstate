import * as Automerge from '@automerge/automerge';
import { Repo } from '@automerge/automerge-repo';
import { builtInCapabilityRefs } from '@tarstate/core/capabilities';
import { sealConstraintSet } from '@tarstate/core/artifacts/constraint-set';
import { createAttachmentTextIntentService } from '@tarstate/core/attachment/text-intent-adapter';
import type {
  CommitReceipt,
  DatabaseTransactionSnapshot
} from '@tarstate/core/transactions';
import {
  AttachmentCatalog,
  type AttachmentLease,
  type DatabaseAttachmentInput
} from '@tarstate/core/database';
import {
  openDatabaseQuery,
  type OwnedDatabaseSource
} from '@tarstate/core/database/session';
import type { QueryNode } from '@tarstate/core/query/model';
import { prepareQuery } from '@tarstate/core/query/prepare';
import {
  relationLiteral,
  sealSchema,
  sealStorageMapping,
  type RelationStorageMapping
} from '@tarstate/core/schema';
import { describe, expect, it, vi } from 'vitest';
import {
  openAutomergeDatabase,
  type OpenAutomergeDatabaseOptions
} from '../src/index.js';
import { createLiveAutomergeDatabase } from '../src/database/live.js';

type TaskDocument = {
  tasks: Record<string, { id: string; title: string; unknownPhysicalField?: string }>;
};

type FileDocument = {
  '@patchpit': { type: string };
  content: Uint8Array;
};

type TitledFileDocument = FileDocument & { name: string };

type OrderedTaskDocument = {
  tasks: { id: string; title: string }[];
};

type SourceIdentityTaskDocument = {
  tasks?: { title: string }[];
};

type CompositeFileDocument =
  | { id: 'file'; textContent: string }
  | { files: { contentKind: 'text'; id: 'file'; textContent: string }[] }
  | { files: Record<string, { contentKind: 'text'; textContent: string }> };

type CompositeFileMappingKind = 'singleton-literal-field' | 'array-fields' | 'object-map-field';

describe('standard Automerge database', () => {
  it('does not build a full logical snapshot until a snapshot consumer asks for one', () => {
    const sourceSnapshot = vi.fn(() => ({
      sourceId: 'source:test',
      operationEpoch: 'epoch:test',
      basis: { kind: 'test', revision: 1 },
      state: 'ready',
      freshness: 'current',
      storage: Automerge.from({ value: 'ready' }),
      issues: []
    } as const));
    const project = vi.fn(() => ({
      mapped: Object.freeze({ rows: Object.freeze([]), completeness: 'exact' as const, issues: Object.freeze([]) }),
      logicalState: Object.freeze({ rows: Object.freeze([]) }),
      constraints: Object.freeze({ blockingIssues: Object.freeze([]), auditIssues: Object.freeze([]) }),
      issues: Object.freeze([])
    }));
    const database = createLiveAutomergeDatabase({
      attachmentId: 'attachment:test',
      incarnation: 'incarnation:test',
      authorityScope: 'scope:test',
      transactions: { transact: vi.fn(), simulate: vi.fn() },
      preparation: {},
      source: {
        sourceId: 'source:test',
        snapshot: sourceSnapshot,
        subscribe: vi.fn(() => () => undefined),
        close: vi.fn()
      },
      projector: { project }
    } as unknown as Parameters<typeof createLiveAutomergeDatabase<{ value: string }>>[0]);

    expect(sourceSnapshot).not.toHaveBeenCalled();
    expect(project).not.toHaveBeenCalled();
    expect(database.getSnapshot()).toMatchObject({ state: 'open', current: { readiness: 'ready' } });
    expect(sourceSnapshot).toHaveBeenCalledOnce();
    expect(project).toHaveBeenCalledOnce();
    database.close();
  });

  it('rejects invalid database identities before reading metadata', async () => {
    const repo = new Repo();
    const handle = repo.create<TaskDocument>({ tasks: {} });

    await expect(openAutomergeDatabase({
      handle,
      declaration: null,
      embeddedArtifacts: null,
      authorityScope: ''
    })).rejects.toThrow('authorityScope must be a non-empty string');
    await expect(openAutomergeDatabase({
      handle,
      declaration: null,
      embeddedArtifacts: null,
      authorityScope: 'scope:test',
      attachmentId: ''
    })).rejects.toThrow('attachmentId must be a non-empty string');

    await repo.shutdown();
  });

  it('opens embedded artifacts and exposes only logical transactions and lifecycle', async () => {
    const fixture = await openTaskDatabase();
    expect(Object.keys(fixture.database).sort()).toEqual([
      'capabilities', 'close', 'getSnapshot', 'mount', 'openTextIntent', 'simulate', 'subscribe', 'transact'
    ]);
    expect(fixture.database.capabilities(fixture.tasks)).toMatchObject({
      relationId: 'tasks',
      keyFields: ['id'],
      fields: { title: {
        replace: { concurrency: 'replay-transform' },
        textSplice: { indexUnit: 'utf16-code-unit', concurrency: 'merge-captured-intent' }
      } }
    });
    const initial = fixture.database.getSnapshot();
    expect(initial).toMatchObject({
      state: 'open',
      current: { readiness: 'ready', completeness: 'exact', rows: [{ relationId: 'tasks', fields: { id: 'first', title: 'First' } }] }
    });
    expect(fixture.database.getSnapshot()).toBe(initial);
    const listener = vi.fn();
    const unsubscribe = fixture.database.subscribe(listener);
    await expect(fixture.database.transact(
      { kind: 'rename-task', id: 'first' },
      (snapshot) => snapshot.withRows(
        fixture.tasks,
        snapshot.rows(fixture.tasks).map((row) => ({ ...row, title: 'Renamed' }))
      )
    )).resolves.toMatchObject({ outcome: 'committed' });
    expect(fixture.handle.doc()?.tasks.first?.title).toBe('Renamed');
    expect(listener).toHaveBeenCalled();
    unsubscribe();

    const catalog = new AttachmentCatalog();
    const lease = fixture.database.mount(catalog, { discoveryEdges: ['embedded'] });
    expect(lease).toMatchObject({
      attachmentId: fixture.handle.url,
      sourceId: fixture.handle.url,
      discoveryEdges: ['embedded']
    });
    expect('attachment' in lease).toBe(false);
    expect(catalog.list()).toHaveLength(1);

    const closeListener = vi.fn();
    fixture.database.subscribe(closeListener);
    fixture.database.close();
    expect(closeListener).toHaveBeenCalledOnce();
    expect(fixture.database.getSnapshot()).toEqual({ state: 'closed' });
    expect(catalog.list()).toHaveLength(0);
    await fixture.repo.shutdown();
  });

  it('authors native text splices from the observed basis and merges later text changes', async () => {
    const fixture = await openTaskDatabase();
    const observed = fixture.database.getSnapshot();
    if (observed.state !== 'open' || observed.current.readiness !== 'ready') throw new Error('Expected ready database');
    const observedBasis = observed.current.basis;

    fixture.handle.change((draft) => {
      Automerge.splice(draft, ['tasks', 'first', 'title'], 5, 0, '!');
      draft.tasks.first!.unknownPhysicalField = 'preserved';
    });

    const transform = (snapshot: DatabaseTransactionSnapshot) => {
      const spliced = snapshot.spliceText(
        fixture.tasks,
        ['first'],
        'title',
        { index: 0, deleteCount: 0, insert: 'New ' }
      );
      expect(Object.isFrozen(spliced.rows(fixture.tasks))).toBe(true);
      return spliced;
    };
    const simulation = await fixture.database.simulate(
      { kind: 'prefix-title' },
      transform,
      { observedBasis }
    );
    expect(simulation).toMatchObject({
      outcome: 'would-commit',
      beforeBasis: observedBasis,
      stagedState: { rows: [expect.objectContaining({ fields: { id: 'first', title: 'New First' } })] }
    });
    expect(fixture.handle.doc()?.tasks.first?.title).toBe('First!');

    const receipt = await fixture.database.transact(
      { kind: 'prefix-title' },
      transform,
      { observedBasis }
    );
    expect(receipt).toMatchObject({
      outcome: 'committed',
      evaluationBasis: observedBasis,
      integrationBasis: expect.any(Object)
    });
    expect(receipt.outcome === 'committed' && receipt.integrationBasis).not.toEqual(observedBasis);
    expect(fixture.handle.doc()?.tasks.first?.title).toBe('New First!');
    expect(fixture.handle.doc()?.tasks.first?.unknownPhysicalField).toBe('preserved');
    fixture.database.close();
    await fixture.repo.shutdown();
  });

  it('composes dependent text segments before one multiplayer publication', async () => {
    const fixture = await openTaskDatabase({ initialTitle: 'ab' });
    const observed = fixture.database.getSnapshot();
    if (observed.state !== 'open' || observed.current.readiness !== 'ready') {
      throw new Error('Expected ready database');
    }
    expect(fixture.database.capabilities(fixture.tasks).fields.title?.textSplice)
      .toMatchObject({ dependentComposition: 'retained-cross-publication' });
    const opened = await fixture.database.openTextIntent({
      observedBasis: observed.current.basis
    });
    if (!opened.success) throw new Error(JSON.stringify(opened.issues));
    const session = opened.value;

    const first = session.append(
      { kind: 'insert-local-text', value: 'XY' },
      (snapshot) => snapshot.spliceText(
        fixture.tasks,
        ['first'],
        'title',
        { index: 2, deleteCount: 0, insert: 'XY' }
      )
    );
    const second = session.append(
      { kind: 'replace-dependent-local-text', value: 'Z' },
      (snapshot) => snapshot.spliceText(
        fixture.tasks,
        ['first'],
        'title',
        { index: 3, deleteCount: 1, insert: 'Z' }
      )
    );

    expect(first).toMatchObject({ status: 'pending' });
    expect(second).toMatchObject({ status: 'pending' });
    expect(session.getSnapshot().current.rows(fixture.tasks))
      .toEqual([{ id: 'first', title: 'abXZ' }]);
    expect(fixture.handle.doc()?.tasks.first?.title).toBe('ab');

    fixture.handle.change((draft) => {
      Automerge.splice(draft, ['tasks', 'first', 'title'], 0, 0, 'R');
    });
    expect(session.getSnapshot()).toMatchObject({ state: 'ready', freshness: 'stale' });

    const receipt = await session.publish();
    expect(receipt).toMatchObject({ outcome: 'committed' });
    expect(session.getSnapshot()).toMatchObject({
      state: 'ready',
      segments: [{ status: 'committed' }, { status: 'committed' }]
    });
    expect(fixture.handle.doc()?.tasks.first?.title).toBe('RabXZ');

    session.close();
    fixture.database.close();
    await fixture.repo.shutdown();
  });

  it('retains accepted dependent text after rejecting a later invalid segment', async () => {
    const fixture = await openTaskDatabase({ initialTitle: 'abcd' });
    const observed = fixture.database.getSnapshot();
    if (observed.state !== 'open' || observed.current.readiness !== 'ready') {
      throw new Error('Expected ready database');
    }
    const opened = await fixture.database.openTextIntent({ observedBasis: observed.current.basis });
    if (!opened.success) throw new Error(JSON.stringify(opened.issues));
    const session = opened.value;

    session.append({ kind: 'first' }, (snapshot) => snapshot.spliceText(
      fixture.tasks,
      ['first'],
      'title',
      { index: 2, deleteCount: 0, insert: 'X' }
    ));
    const rejected = session.append({ kind: 'invalid' }, (snapshot) => snapshot.spliceText(
      fixture.tasks,
      ['first'],
      'title',
      { index: 99, deleteCount: 0, insert: 'lost' }
    ));
    expect(rejected).toMatchObject({
      status: 'rejected',
      issues: [expect.objectContaining({ code: 'transaction.delta_invalid' })]
    });
    expect(session.getSnapshot().current.rows(fixture.tasks))
      .toEqual([{ id: 'first', title: 'abXcd' }]);

    session.append({ kind: 'second' }, (snapshot) => snapshot.spliceText(
      fixture.tasks,
      ['first'],
      'title',
      { index: 3, deleteCount: 0, insert: 'Y' }
    ));
    await expect(session.publish()).resolves.toMatchObject({ outcome: 'committed' });
    expect(session.getSnapshot().segments.map(({ status }) => status))
      .toEqual(['committed', 'rejected', 'committed']);
    expect(fixture.handle.doc()?.tasks.first?.title).toBe('abXYcd');

    session.close();
    fixture.database.close();
    await fixture.repo.shutdown();
  });

  it('accepts a dependent suffix while its causal prefix is publishing', async () => {
    const fixture = await openTaskDatabase({ initialTitle: 'ab' });
    const observed = fixture.database.getSnapshot();
    if (observed.state !== 'open' || observed.current.readiness !== 'ready') {
      throw new Error('Expected ready database');
    }
    const opened = await fixture.database.openTextIntent({
      observedBasis: observed.current.basis
    });
    if (!opened.success) throw new Error(JSON.stringify(opened.issues));
    const session = opened.value;

    session.append({ kind: 'prefix' }, (snapshot) => snapshot.spliceText(
      fixture.tasks,
      ['first'],
      'title',
      { index: 2, deleteCount: 0, insert: 'X' }
    ));
    const prefixPublication = session.publish();
    expect(session.getSnapshot().state).toBe('publishing');
    session.append({ kind: 'dependent-suffix' }, (snapshot) => snapshot.spliceText(
      fixture.tasks,
      ['first'],
      'title',
      { index: 3, deleteCount: 0, insert: 'Y' }
    ));
    expect(session.publish()).toBe(prefixPublication);
    fixture.handle.change((draft) => {
      Automerge.splice(draft, ['tasks', 'first', 'title'], 0, 0, 'R');
    });

    await expect(prefixPublication).resolves.toMatchObject({ outcome: 'committed' });
    expect(session.getSnapshot()).toMatchObject({
      state: 'ready',
      freshness: 'stale',
      segments: [{ status: 'committed' }, { status: 'pending' }]
    });
    expect(session.getSnapshot().current.rows(fixture.tasks))
      .toEqual([{ id: 'first', title: 'abXY' }]);
    expect(fixture.handle.doc()?.tasks.first?.title).toBe('RabX');

    await expect(session.publish()).resolves.toMatchObject({ outcome: 'committed' });
    expect(session.getSnapshot().segments.map(({ status }) => status))
      .toEqual(['committed', 'committed']);
    expect(fixture.handle.doc()?.tasks.first?.title).toBe('RabXY');

    session.close();
    fixture.database.close();
    await fixture.repo.shutdown();
  });

  it('suspends a dependent suffix when its prefix publication outcome is unknown', async () => {
    const fixture = await openTaskDatabase({ initialTitle: 'ab' });
    const observed = fixture.database.getSnapshot();
    if (observed.state !== 'open' || observed.current.readiness !== 'ready') {
      throw new Error('Expected ready database');
    }
    const basis = observed.current.basis;
    const unknownReceipt = {
      kind: 'commit',
      receiptVersion: 1,
      operationEpoch: 'epoch:unknown',
      operationId: 'operation:unknown',
      transactionHash: '0'.repeat(64),
      intentHash: '1'.repeat(64),
      attachmentId: 'attachment:unknown',
      attachmentFingerprint: '2'.repeat(64),
      sourceId: 'source:unknown',
      statementResults: [],
      issues: [],
      outcome: 'unknown',
      beforeBasis: basis,
      durability: 'unknown'
    } as CommitReceipt;
    const service = createAttachmentTextIntentService({
      transactions: fixture.database,
      source: {
        sourceId: 'source:unknown',
        snapshot: () => ({
          sourceId: 'source:unknown',
          operationEpoch: 'epoch:unknown',
          basis,
          state: 'ready',
          freshness: 'current',
          storage: {},
          issues: []
        }),
        subscribe: () => () => undefined
      },
      publication: {
        openBranch: () => ({}),
        publish: async () => ({ receipt: unknownReceipt })
      }
    });
    const opened = await service.openTextIntent({ observedBasis: basis });
    if (!opened.success) throw new Error(JSON.stringify(opened.issues));
    const session = opened.value;
    session.append({ kind: 'prefix' }, (snapshot) => snapshot.spliceText(
      fixture.tasks,
      ['first'],
      'title',
      { index: 2, deleteCount: 0, insert: 'X' }
    ));
    const prefixPublication = session.publish();
    session.append({ kind: 'dependent-suffix' }, (snapshot) => snapshot.spliceText(
      fixture.tasks,
      ['first'],
      'title',
      { index: 3, deleteCount: 0, insert: 'Y' }
    ));

    await expect(prefixPublication).resolves.toBe(unknownReceipt);
    expect(session.getSnapshot()).toMatchObject({
      state: 'unknown',
      segments: [{ status: 'unknown' }, { status: 'unknown' }]
    });
    await expect(session.publish()).rejects.toThrow('not publishable');
    expect(fixture.handle.doc()?.tasks.first?.title).toBe('ab');

    session.close();
    fixture.database.close();
    await fixture.repo.shutdown();
  });

  it('cancels and closes an unpublished text composition idempotently', async () => {
    const fixture = await openTaskDatabase({ initialTitle: 'abcd' });
    const observed = fixture.database.getSnapshot();
    if (observed.state !== 'open' || observed.current.readiness !== 'ready') {
      throw new Error('Expected ready database');
    }
    const opened = await fixture.database.openTextIntent({ observedBasis: observed.current.basis });
    if (!opened.success) throw new Error(JSON.stringify(opened.issues));
    const session = opened.value;
    session.append({ kind: 'unpublished' }, (snapshot) => snapshot.spliceText(
      fixture.tasks,
      ['first'],
      'title',
      { index: 0, deleteCount: 0, insert: 'local' }
    ));

    session.cancel();
    session.cancel();
    expect(session.getSnapshot()).toMatchObject({
      state: 'cancelled',
      segments: [{ status: 'cancelled' }]
    });
    await expect(session.publish()).rejects.toThrow('not publishable');
    expect(fixture.handle.doc()?.tasks.first?.title).toBe('abcd');
    session.close();
    session.close();
    expect(session.getSnapshot().state).toBe('closed');

    fixture.database.close();
    await fixture.repo.shutdown();
  });

  it('cancels both an unpublished prefix and descendants queued during publication', async () => {
    const fixture = await openTaskDatabase({ initialTitle: 'ab' });
    const observed = fixture.database.getSnapshot();
    if (observed.state !== 'open' || observed.current.readiness !== 'ready') {
      throw new Error('Expected ready database');
    }
    const opened = await fixture.database.openTextIntent({ observedBasis: observed.current.basis });
    if (!opened.success) throw new Error(JSON.stringify(opened.issues));
    const session = opened.value;
    session.append({ kind: 'prefix' }, (snapshot) => snapshot.spliceText(
      fixture.tasks,
      ['first'],
      'title',
      { index: 2, deleteCount: 0, insert: 'X' }
    ));
    const publication = session.publish();
    session.append({ kind: 'descendant' }, (snapshot) => snapshot.spliceText(
      fixture.tasks,
      ['first'],
      'title',
      { index: 3, deleteCount: 0, insert: 'Y' }
    ));

    session.cancel();

    await expect(publication).resolves.toMatchObject({ outcome: 'rejected' });
    expect(session.getSnapshot()).toMatchObject({
      state: 'cancelled',
      segments: [{ status: 'cancelled' }, { status: 'cancelled' }]
    });
    expect(fixture.handle.doc()?.tasks.first?.title).toBe('ab');

    session.close();
    fixture.database.close();
    await fixture.repo.shutdown();
  });

  it('rejects every pending dependent segment when merged candidate constraints fail', async () => {
    const fixture = await openTaskDatabase({
      constrained: true,
      initialTitle: 'Allowe',
      allowedTitles: ['Allowe', 'Allowed']
    });
    const observed = fixture.database.getSnapshot();
    if (observed.state !== 'open' || observed.current.readiness !== 'ready') {
      throw new Error('Expected ready database');
    }
    const opened = await fixture.database.openTextIntent({ observedBasis: observed.current.basis });
    if (!opened.success) throw new Error(JSON.stringify(opened.issues));
    const session = opened.value;
    session.append({ kind: 'complete-allowed' }, (snapshot) => snapshot.spliceText(
      fixture.tasks,
      ['first'],
      'title',
      { index: 6, deleteCount: 0, insert: 'd' }
    ));
    const publication = session.publish();
    session.append({ kind: 'dependent-descendant' }, (snapshot) => snapshot.spliceText(
      fixture.tasks,
      ['first'],
      'title',
      { index: 7, deleteCount: 0, insert: '!' }
    ));
    fixture.handle.change((draft) => {
      Automerge.splice(draft, ['tasks', 'first', 'title'], 0, 6, 'Forbidde');
    });

    const receipt = await publication;
    expect(receipt).toMatchObject({ outcome: 'rejected' });
    expect(session.getSnapshot()).toMatchObject({
      state: 'rejected',
      segments: [{ status: 'rejected' }, { status: 'rejected' }]
    });
    expect(fixture.handle.doc()?.tasks.first?.title).toBe('Forbidde');

    session.close();
    fixture.database.close();
    await fixture.repo.shutdown();
  });

  it.each([
    ['literal and stored keys', 'singleton-literal-field'],
    ['two stored keys', 'array-fields'],
    ['map-key and stored keys', 'object-map-field']
  ] as const)('preserves declared composite-key order for %s', async (_label, mappingKind) => {
    const fixture = await openCompositeFileDatabase(mappingKind);
    const observed = fixture.database.getSnapshot();
    if (observed.state !== 'open' || observed.current.readiness !== 'ready') throw new Error('Expected ready database');
    expect(fixture.schema.body.relations.files.key).toEqual(['id', 'contentKind']);
    expect(fixture.database.capabilities(fixture.files).keyFields).toEqual(['id', 'contentKind']);
    const transform = (snapshot: DatabaseTransactionSnapshot) => snapshot.spliceText(
      fixture.files,
      ['file', 'text'],
      'textContent',
      { index: 0, deleteCount: 0, insert: 'New ' }
    );

    const simulation = await fixture.database.simulate(
      { kind: 'prefix-file-content' },
      transform,
      { observedBasis: observed.current.basis }
    );
    expect(simulation.issues).toEqual([]);
    expect(simulation).toMatchObject({
      outcome: 'would-commit',
      stagedState: { rows: [expect.objectContaining({
        fields: { contentKind: 'text', id: 'file', textContent: 'New First' }
      })] }
    });
    await expect(fixture.database.transact(
      { kind: 'prefix-file-content' },
      transform,
      { observedBasis: observed.current.basis }
    )).resolves.toMatchObject({ outcome: 'committed' });
    expect(fixture.readText()).toBe('New First');

    fixture.database.close();
    await fixture.repo.shutdown();
  });

  it('requires observed-basis evidence and rejects unsafe UTF-16 splices before publication', async () => {
    const fixture = await openTaskDatabase({ initialTitle: 'A😀B' });
    const withoutBasis = await fixture.database.transact(
      { kind: 'unsafe-unbound-splice' },
      (snapshot) => snapshot.spliceText(
        fixture.tasks,
        ['first'],
        'title',
        { index: 0, deleteCount: 0, insert: 'x' }
      )
    );
    expect(withoutBasis).toMatchObject({
      outcome: 'rejected',
      issues: expect.arrayContaining([expect.objectContaining({
        code: 'transaction.expected_basis_stale',
        details: expect.objectContaining({ reason: 'observed_basis_required_for_position_sensitive_intent' })
      })])
    });

    const observed = fixture.database.getSnapshot();
    if (observed.state !== 'open' || observed.current.readiness !== 'ready') throw new Error('Expected ready database');
    const splitSurrogate = await fixture.database.transact(
      { kind: 'split-surrogate' },
      (snapshot) => snapshot.spliceText(
        fixture.tasks,
        ['first'],
        'title',
        { index: 2, deleteCount: 0, insert: 'x' }
      ),
      { observedBasis: observed.current.basis }
    );
    expect(splitSurrogate).toMatchObject({ outcome: 'rejected' });
    expect(fixture.handle.doc()?.tasks.first?.title).toBe('A😀B');

    const malformedInsertion = await fixture.database.transact(
      { kind: 'malformed-surrogate' },
      (snapshot) => snapshot.spliceText(
        fixture.tasks,
        ['first'],
        'title',
        { index: 1, deleteCount: 2, insert: '\uD800' }
      ),
      { observedBasis: observed.current.basis }
    );
    expect(malformedInsertion).toMatchObject({ outcome: 'rejected' });
    expect(fixture.handle.doc()?.tasks.first?.title).toBe('A😀B');

    const validEmojiReplacement = await fixture.database.transact(
      { kind: 'replace-emoji' },
      (snapshot) => snapshot.spliceText(
        fixture.tasks,
        ['first'],
        'title',
        { index: 1, deleteCount: 2, insert: '🙂' }
      ),
      { observedBasis: observed.current.basis }
    );
    expect(validEmojiReplacement).toMatchObject({ outcome: 'committed' });
    expect(fixture.handle.doc()?.tasks.first?.title).toBe('A🙂B');
    fixture.database.close();
    await fixture.repo.shutdown();
  });

  it('validates the reconciled candidate before publishing a captured splice', async () => {
    const fixture = await openTaskDatabase({
      constrained: true,
      allowedTitles: ['First', 'Firstn', 'Forbidde']
    });
    const observed = fixture.database.getSnapshot();
    if (observed.state !== 'open' || observed.current.readiness !== 'ready') throw new Error('Expected ready database');
    fixture.handle.change((draft) => {
      Automerge.splice(draft, ['tasks', 'first', 'title'], 0, 5, 'Forbidde');
    });

    const receipt = await fixture.database.transact(
      { kind: 'complete-forbidden-title' },
      (snapshot) => snapshot.spliceText(
        fixture.tasks,
        ['first'],
        'title',
        { index: 5, deleteCount: 0, insert: 'n' }
      ),
      { observedBasis: observed.current.basis }
    );

    expect(receipt).toMatchObject({
      outcome: 'rejected',
      evaluationBasis: observed.current.basis,
      issues: expect.arrayContaining([expect.objectContaining({ code: 'test.task_invalid' })])
    });
    expect(fixture.handle.doc()?.tasks.first?.title).toBe('Forbidde');
    fixture.database.close();
    await fixture.repo.shutdown();
  });

  it('rejects a captured splice when another player deletes its target', async () => {
    const fixture = await openTaskDatabase();
    const observed = fixture.database.getSnapshot();
    if (observed.state !== 'open' || observed.current.readiness !== 'ready') throw new Error('Expected ready database');
    fixture.handle.change((draft) => { delete draft.tasks.first; });

    const receipt = await fixture.database.transact(
      { kind: 'edit-deleted-task' },
      (snapshot) => snapshot.spliceText(
        fixture.tasks,
        ['first'],
        'title',
        { index: 0, deleteCount: 0, insert: 'x' }
      ),
      { observedBasis: observed.current.basis }
    );

    expect(receipt).toMatchObject({
      outcome: 'rejected',
      issues: expect.arrayContaining([expect.objectContaining({
        code: 'transaction.expected_basis_stale',
        details: expect.objectContaining({ reason: 'captured_text_target_unavailable' })
      })])
    });
    expect(fixture.handle.doc()?.tasks.first).toBeUndefined();
    fixture.database.close();
    await fixture.repo.shutdown();
  });

  it('finishes closing after a mounted lease reports a cleanup failure', async () => {
    const fixture = await openTaskDatabase();
    const catalog = new ThrowingLeaseCatalog();
    await fixture.database.mount(catalog);
    const closeListener = vi.fn();
    fixture.database.subscribe(closeListener);

    expect(() => fixture.database.close()).toThrow('lease cleanup failed');
    expect(fixture.database.getSnapshot()).toEqual({ state: 'closed' });
    expect(closeListener).toHaveBeenCalledOnce();
    expect(catalog.list()).toEqual([]);
    expect(() => fixture.database.close()).not.toThrow();
    await fixture.repo.shutdown();
  });

  it('transfers an opened linked database lifetime while keeping the root caller-owned', async () => {
    const child = await openTaskDatabase();
    const root = await openTaskDatabase({ initialTitle: child.handle.url });
    const taskRelation = {
      schemaView: reference(root.schema),
      relationId: 'tasks'
    };
    const common = {
      registryFingerprint: 'registry:test',
      authorityFingerprint: 'authority:test',
      datasetId: 'workspace'
    } as const;
    const linkPlan = await prepareQuery({
      ...common,
      root: {
        kind: 'select',
        input: {
          kind: 'where',
          input: { kind: 'from', relation: taskRelation, alias: 'task' },
          predicate: {
            kind: 'compare',
            op: 'eq',
            left: { kind: 'field', alias: 'task', name: 'title' },
            right: { kind: 'literal', value: child.handle.url }
          }
        },
        alias: 'link',
        fields: {
          linkId: { kind: 'field', alias: 'task', name: 'id' },
          originSourceId: { kind: 'source-of', alias: 'task' },
          targetSourceId: { kind: 'field', alias: 'task', name: 'title' },
          expectation: { kind: 'literal', value: 'required' }
        }
      } satisfies QueryNode
    });
    const itemPlan = await prepareQuery({
      ...common,
      root: {
        kind: 'select',
        input: { kind: 'from', relation: taskRelation, alias: 'task' },
        alias: 'item',
        fields: { id: { kind: 'field', alias: 'task', name: 'id' } }
      }
    });
    const openSource = vi.fn((): OwnedDatabaseSource => child.database);
    const session = await openDatabaseQuery({
      sources: [{ source: root.database }],
      plan: itemPlan,
      queryAuthorityScope: 'scope:test',
      followSourceLinks: { plan: linkPlan, openSource }
    });

    await vi.waitFor(() => expect(openSource).toHaveBeenCalledOnce());
    expect(child.database.getSnapshot()).toMatchObject({ state: 'open' });

    await expect(root.database.transact(
      { kind: 'remove-link' },
      (snapshot) => snapshot.withRows(root.tasks, [])
    )).resolves.toMatchObject({ outcome: 'committed' });
    await vi.waitFor(() => expect(child.database.getSnapshot()).toEqual({ state: 'closed' }));

    session.close();
    expect(root.database.getSnapshot()).toMatchObject({ state: 'open' });
    root.database.close();
    await child.repo.shutdown();
    await root.repo.shutdown();
  });

  it('opens and updates a native-byte root singleton through the standard database API', async () => {
    const schema = await sealSchema({ id: 'urn:test:file:schema', body: {
      relations: {
        file: {
          relationId: 'file',
          key: ['id'],
          fields: {
            id: { type: { kind: 'string', values: ['content'] } },
            content: { type: { kind: 'bytes' } }
          }
        }
      }
    } });
    const mapping = await sealStorageMapping({ id: 'urn:test:file:mapping', body: {
      schema: reference(schema),
      model: 'json-tree-v1',
      relations: {
        file: {
          collection: { kind: 'singleton', path: [], absent: 'invalid' },
          keys: { id: { kind: 'literal', value: 'content' } },
          fields: {
            content: { path: ['content'], write: { replace: builtInCapabilityRefs.fieldReplace } }
          }
        }
      }
    } });
    const repo = new Repo();
    const handle = repo.create<FileDocument>({
      '@patchpit': { type: 'file-content' },
      content: new Uint8Array([1, 2, 3])
    });
    const opened = await openAutomergeDatabase({
      handle,
      declaration: {
        formatVersion: 1,
        storageSchema: reference(schema),
        projection: { kind: 'storage-mapping', storageMapping: reference(mapping) }
      },
      embeddedArtifacts: [schema, mapping],
      authorityScope: 'scope:test'
    });
    if (!opened.success) throw new Error(JSON.stringify(opened.issues));
    expect(opened.value.getSnapshot()).toMatchObject({
      state: 'open',
      current: {
        readiness: 'ready',
        rows: [{ fields: { id: 'content', content: { type: 'bytes', value: 'AQID' } } }]
      }
    });
    const file = relationLiteral(schema, 'file');
    await expect(opened.value.transact(
      { kind: 'replace-content' },
      (snapshot) => snapshot.withRows(
        file,
        snapshot.rows(file).map((row) => ({
          ...row,
          content: { kind: 'tarstate.value', type: 'bytes', value: 'BAU' }
        }))
      )
    )).resolves.toMatchObject({ outcome: 'committed' });
    expect([...(handle.doc()?.content ?? [])]).toEqual([4, 5]);
    expect(handle.doc()?.['@patchpit']).toEqual({ type: 'file-content' });
    opened.value.close();
    await repo.shutdown();
  });

  it('keeps a title-only query exact without projecting conflicted binary content', async () => {
    const schema = await sealSchema({ id: 'urn:test:titled-file:schema', body: {
      relations: { file: {
        relationId: 'titled-file',
        key: ['id'],
        fields: {
          id: { type: { kind: 'string', values: ['file'] } },
          name: { type: { kind: 'string' } },
          content: { type: { kind: 'bytes' } }
        }
      } }
    } });
    const mapping = await sealStorageMapping({ id: 'urn:test:titled-file:mapping', body: {
      schema: reference(schema),
      model: 'json-tree-v1',
      relations: { 'titled-file': {
        collection: { kind: 'singleton', path: [], absent: 'invalid' },
        keys: { id: { kind: 'literal', value: 'file' } },
        fields: {
          name: { path: ['name'], write: {} },
          content: { path: ['content'], write: { replace: builtInCapabilityRefs.fieldReplace } }
        }
      } }
    } });
    const repo = new Repo();
    const handle = repo.create<TitledFileDocument>({
      '@patchpit': { type: 'file-content' },
      name: 'large.bin',
      content: new Uint8Array(1024 * 1024)
    });
    const opened = await openAutomergeDatabase({
      handle,
      declaration: {
        formatVersion: 1,
        storageSchema: reference(schema),
        projection: { kind: 'storage-mapping', storageMapping: reference(mapping) }
      },
      embeddedArtifacts: [schema, mapping],
      authorityScope: 'scope:test'
    });
    if (!opened.success) throw new Error(JSON.stringify(opened.issues));
    const plan = await prepareQuery({
      root: {
        kind: 'select',
        input: {
          kind: 'from',
          relation: { schemaView: reference(schema), relationId: 'titled-file' },
          alias: 'file'
        },
        alias: 'title',
        fields: { title: { kind: 'field', alias: 'file', name: 'name' } }
      },
      registryFingerprint: 'registry:test',
      authorityFingerprint: 'authority:test',
      datasetId: 'files'
    });
    const query = await openDatabaseQuery({
      sources: [{ source: opened.value }],
      plan,
      queryAuthorityScope: 'scope:test'
    });
    expect(query.getSnapshot()).toMatchObject({
      state: 'open',
      current: { readiness: 'ready', completeness: 'exact', rows: [{ title: 'large.bin' }] }
    });

    const contentPlan = await prepareQuery({
      root: {
        kind: 'select',
        input: {
          kind: 'from',
          relation: { schemaView: reference(schema), relationId: 'titled-file' },
          alias: 'file'
        },
        alias: 'content',
        fields: { content: { kind: 'field', alias: 'file', name: 'content' } }
      },
      registryFingerprint: 'registry:test',
      authorityFingerprint: 'authority:test',
      datasetId: 'files'
    });
    const contentQuery = await openDatabaseQuery({
      sources: [{ source: opened.value }],
      plan: contentPlan,
      queryAuthorityScope: 'scope:test'
    });
    expect(contentQuery.getSnapshot()).toMatchObject({
      state: 'open',
      current: { readiness: 'ready', completeness: 'exact', rows: [{ content: { type: 'bytes' } }] }
    });
    handle.change((draft) => {
      draft.content = new Uint8Array([9]);
    });
    expect(contentQuery.getSnapshot()).toMatchObject({
      state: 'open',
      current: { readiness: 'ready', completeness: 'exact', rows: [{ content: { value: 'CQ' } }] }
    });
    expect(query.getSnapshot()).toMatchObject({
      state: 'open',
      current: { readiness: 'ready', completeness: 'exact', rows: [{ title: 'large.bin' }] }
    });
    contentQuery.close();

    const base = handle.doc()!;
    const left = Automerge.change(Automerge.clone(base, { actor: 'a'.repeat(64) }), (draft) => {
      draft.content = new Uint8Array([1]);
    });
    const right = Automerge.change(Automerge.clone(base, { actor: 'b'.repeat(64) }), (draft) => {
      draft.content = new Uint8Array([2]);
    });
    handle.update(() => Automerge.merge(left, right));
    expect(query.getSnapshot()).toMatchObject({
      state: 'open',
      current: { readiness: 'ready', completeness: 'exact', rows: [{ title: 'large.bin' }] }
    });
    expect(opened.value.getSnapshot()).toMatchObject({
      state: 'open',
      current: { readiness: 'incomplete', completeness: 'unknown', rows: [] }
    });

    query.close();
    opened.value.close();
    await repo.shutdown();
  });

  it('opens and updates an explicitly keyed array through the standard database API', async () => {
    const schema = await sealSchema({ id: 'urn:test:ordered-task:schema', body: {
      relations: { tasks: {
        relationId: 'ordered-tasks',
        key: ['id'],
        fields: {
          id: { type: { kind: 'string' } },
          title: { type: { kind: 'string' } }
        }
      } }
    } });
    const mapping = await sealStorageMapping({ id: 'urn:test:ordered-task:mapping', body: {
      schema: reference(schema),
      model: 'json-tree-v1',
      relations: { 'ordered-tasks': {
        collection: { kind: 'array', path: ['tasks'], absent: 'creatable' },
        keys: { id: { kind: 'field', path: ['id'] } },
        fields: {
          title: { path: ['title'], write: { replace: builtInCapabilityRefs.fieldReplace } }
        }
      } }
    } });
    const repo = new Repo();
    const handle = repo.create<OrderedTaskDocument>({
      tasks: [{ id: 'first', title: 'First' }, { id: 'second', title: 'Second' }]
    });
    const opened = await openAutomergeDatabase({
      handle,
      declaration: {
        formatVersion: 1,
        storageSchema: reference(schema),
        projection: { kind: 'storage-mapping', storageMapping: reference(mapping) }
      },
      embeddedArtifacts: [schema, mapping],
      authorityScope: 'scope:test'
    });
    if (!opened.success) throw new Error(JSON.stringify(opened.issues));
    const tasks = relationLiteral(schema, 'tasks');
    await expect(opened.value.transact(
      { kind: 'replace-ordered-tasks' },
      (snapshot) => snapshot.withRows(tasks, [
        ...snapshot.rows(tasks).filter(({ id }) => id !== 'first'),
        { id: 'third', title: 'Third' }
      ])
    )).resolves.toMatchObject({ outcome: 'committed' });
    expect(handle.doc()?.tasks).toEqual([
      { id: 'second', title: 'Second' },
      { id: 'third', title: 'Third' }
    ]);
    opened.value.close();
    await repo.shutdown();
  });

  it('inserts a source-identity keyed row and returns its committed logical key', async () => {
    const fixture = await openSourceIdentityTaskDatabase({ collectionPresent: false });

    await expect(fixture.database.simulate(
      { kind: 'invalid-generated-task' },
      (snapshot) => snapshot.insertWithGeneratedKey(
        fixture.tasks,
        'invalid',
        { title: 'Invalid', position: 0 }
      )
    )).resolves.toMatchObject({
      outcome: 'rejected',
      issues: [{ details: { reason: 'source_generated_field_supplied', field: 'position' } }]
    });
    await expect(fixture.database.simulate(
      { kind: 'duplicate-generated-token' },
      (snapshot) => snapshot
        .insertWithGeneratedKey(fixture.tasks, 'duplicate', { title: 'First' })
        .insertWithGeneratedKey(fixture.tasks, 'duplicate', { title: 'Second' })
    )).resolves.toMatchObject({
      outcome: 'rejected',
      issues: [{ details: { reason: 'insertion_token_duplicate' } }]
    });

    const simulated = await fixture.database.simulate(
      { kind: 'preview-generated-task', token: 'preview' },
      (snapshot) => snapshot.insertWithGeneratedKey(
        fixture.tasks,
        'preview',
        { title: 'Preview' }
      )
    );
    expect(simulated).toMatchObject({
      outcome: 'would-commit',
      statementResults: [{ inserted: 1, logicallyChanged: 1 }]
    });
    expect('generatedKeys' in simulated).toBe(false);
    expect(fixture.handle.doc()?.tasks).toBeUndefined();

    const receipt = await fixture.database.transact(
      { kind: 'insert-generated-task', token: 'local' },
      (snapshot) => snapshot.insertWithGeneratedKey(
        fixture.tasks,
        'local',
        { title: 'Local' }
      )
    );

    expect(receipt).toMatchObject({
      outcome: 'committed',
      generatedKeys: [{ relationId: 'source-identity-tasks', token: 'local' }]
    });
    const inserted = fixture.handle.doc()?.tasks?.[0];
    const objectId = inserted === undefined ? null : Automerge.getObjectId(inserted);
    expect(receipt.generatedKeys).toEqual([{
      relationId: 'source-identity-tasks',
      token: 'local',
      key: [objectId]
    }]);
    expect(fixture.database.getSnapshot()).toMatchObject({
      state: 'open',
      current: {
        rows: [{
          relationId: 'source-identity-tasks',
          fields: { id: objectId, title: 'Local', position: 0 }
        }]
      }
    });

    fixture.database.close();
    await fixture.repo.shutdown();
  });

  it('replays a generated-key insert after a player edit without duplicating it', async () => {
    const fixture = await openSourceIdentityTaskDatabase();
    const started = deferred();
    const resume = deferred();
    let calls = 0;
    const pending = fixture.database.transact(
      { kind: 'insert-generated-task-after-player-change', token: 'local' },
      async (snapshot) => {
        calls += 1;
        if (calls === 1) {
          started.resolve();
          await resume.promise;
        }
        return snapshot.insertWithGeneratedKey(fixture.tasks, 'local', { title: 'Local' });
      }
    );

    await started.promise;
    const remote = Automerge.change(
      Automerge.clone(fixture.handle.doc()!, { actor: 'b'.repeat(64) }),
      (draft) => { draft.tasks!.push({ title: 'Remote' }); }
    );
    fixture.handle.update((current) => Automerge.merge(current, remote));
    resume.resolve();

    const receipt = await pending;
    expect(receipt).toMatchObject({ outcome: 'committed' });
    expect(calls).toBe(2);
    expect(fixture.handle.doc()?.tasks?.map(({ title }) => title).sort()).toEqual(['Local', 'Remote']);
    const local = fixture.handle.doc()?.tasks?.find(({ title }) => title === 'Local');
    const localObjectId = local === undefined ? null : Automerge.getObjectId(local);
    expect(receipt.generatedKeys).toEqual([{
      relationId: 'source-identity-tasks',
      token: 'local',
      key: [localObjectId]
    }]);

    fixture.database.close();
    await fixture.repo.shutdown();
  });

  it('accepts embedded artifact maps and runs standard logical constraints without host plumbing', async () => {
    const fixture = await openTaskDatabase({ artifactMap: true, constrained: true });
    const mounted = await mountTaskDatabase(fixture);

    await expect(fixture.database.transact(
      { kind: 'rename-task', id: 'first' },
      (snapshot) => snapshot.withRows(
        fixture.tasks,
        snapshot.rows(fixture.tasks).map((row) => ({ ...row, title: 'Constrained' }))
      )
    )).resolves.toMatchObject({ outcome: 'committed' });
    expect(fixture.handle.doc()?.tasks.first?.title).toBe('Constrained');
    await expect(fixture.database.transact(
      { kind: 'rename-task', id: 'first' },
      (snapshot) => snapshot.withRows(
        fixture.tasks,
        snapshot.rows(fixture.tasks).map((row) => ({ ...row, title: 'Forbidden' }))
      )
    )).resolves.toMatchObject({ outcome: 'rejected', issues: [{ code: 'test.task_invalid' }] });
    expect(fixture.handle.doc()?.tasks.first?.title).toBe('Constrained');

    const changed = vi.fn();
    fixture.database.subscribe(changed);
    mergePlayerChange(fixture.handle, '8', (draft) => {
      draft.tasks.first!.title = 'Forbidden';
    });
    expect(changed).toHaveBeenCalled();
    expect(fixture.database.getSnapshot()).toMatchObject({
      state: 'open',
      current: {
        readiness: 'invalid',
        completeness: 'exact',
        issues: [{ code: 'test.task_invalid', severity: 'error' }]
      }
    });
    const invalidMounted = mounted.observer.getSnapshot();
    expect(invalidMounted).toMatchObject({
      state: 'open',
      current: {
        readiness: 'invalid',
        completeness: 'unknown',
        rows: []
      }
    });
    expect(invalidMounted.state === 'open' && invalidMounted.current.issues).toContainEqual(
      expect.objectContaining({ code: 'test.task_invalid', severity: 'error' })
    );

    let repairCalls = 0;
    await expect(fixture.database.transact(
      { kind: 'repair-task', id: 'first' },
      (snapshot) => {
        repairCalls += 1;
        return snapshot.withRows(
          fixture.tasks,
          snapshot.rows(fixture.tasks).map((row) => ({ ...row, title: 'Repaired' }))
        );
      }
    )).resolves.toMatchObject({ outcome: 'committed' });
    expect(repairCalls).toBe(1);
    expect(fixture.database.getSnapshot()).toMatchObject({
      state: 'open', current: { readiness: 'ready', issues: [] }
    });
    expect(mounted.observer.getSnapshot()).toMatchObject({
      state: 'open', current: { readiness: 'ready', completeness: 'exact' }
    });

    mounted.close();
    fixture.database.close();
    await fixture.repo.shutdown();
  });

  it('reports an initially invalid constrained document and permits a final-state repair', async () => {
    const fixture = await openTaskDatabase({ constrained: true, initialTitle: 'Forbidden' });
    expect(fixture.database.getSnapshot()).toMatchObject({
      state: 'open', current: { readiness: 'invalid', issues: [{ code: 'test.task_invalid' }] }
    });

    await expect(fixture.database.transact(
      { kind: 'repair-task', id: 'first' },
      (snapshot) => snapshot.withRows(
        fixture.tasks,
        snapshot.rows(fixture.tasks).map((row) => ({ ...row, title: 'Valid' }))
      )
    )).resolves.toMatchObject({ outcome: 'committed' });
    expect(fixture.database.getSnapshot()).toMatchObject({
      state: 'open', current: { readiness: 'ready', rows: [{ fields: { title: 'Valid' } }] }
    });

    fixture.database.close();
    await fixture.repo.shutdown();
  });

  it('mounts through dataset authority into a recursive source-aware database query', async () => {
    const fixture = await openTaskDatabase();
    const mounted = await mountTaskDatabase(fixture);

    expect(mounted.observer.getSnapshot()).toMatchObject({
      state: 'open',
      current: {
        readiness: 'ready',
        completeness: 'exact',
        rows: [{ id: 'first', source: fixture.handle.url }]
      }
    });

    mounted.close();
    fixture.database.close();
    expect(mounted.observer.getSnapshot()).toEqual({ state: 'closed' });
    await fixture.repo.shutdown();
  });

  it('replays across repeated player syncs and preserves every disjoint row', async () => {
    const fixture = await openTaskDatabase();
    const started = [deferred(), deferred()];
    const resume = [deferred(), deferred()];
    let calls = 0;
    const pending = fixture.database.transact(
      { kind: 'repeated-player-sync', id: 'first' },
      async (snapshot) => {
        const call = calls;
        calls += 1;
        if (call < started.length) {
          started[call]!.resolve();
          await resume[call]!.promise;
        }
        return snapshot.withRows(
          fixture.tasks,
          snapshot.rows(fixture.tasks).map((row) => row.id === 'first'
            ? { ...row, title: `Local after ${row.title}` }
            : row)
        );
      }
    );

    await started[0]!.promise;
    mergePlayerChange(fixture.handle, '3', (draft) => {
      draft.tasks.first!.title = 'Remote one';
      draft.tasks.second = { id: 'second', title: 'Second player row' };
    });
    resume[0]!.resolve();
    await started[1]!.promise;
    mergePlayerChange(fixture.handle, '4', (draft) => {
      draft.tasks.first!.title = 'Remote two';
      draft.tasks.third = { id: 'third', title: 'Third player row' };
    });
    resume[1]!.resolve();

    await expect(pending).resolves.toMatchObject({ outcome: 'committed' });
    expect(calls).toBe(3);
    expect(fixture.handle.doc()?.tasks).toEqual({
      first: { id: 'first', title: 'Local after Remote two' },
      second: { id: 'second', title: 'Second player row' },
      third: { id: 'third', title: 'Third player row' }
    });

    fixture.database.close();
    await fixture.repo.shutdown();
  });

  it('does not resurrect a row deleted by another player during authoring', async () => {
    const fixture = await openTaskDatabase();
    const started = deferred();
    const resume = deferred();
    let calls = 0;
    const pending = fixture.database.transact(
      { kind: 'rename-if-present', id: 'first' },
      async (snapshot) => {
        calls += 1;
        if (calls === 1) {
          started.resolve();
          await resume.promise;
        }
        return snapshot.withRows(
          fixture.tasks,
          snapshot.rows(fixture.tasks).map((row) => row.id === 'first'
            ? { ...row, title: 'Local rename' }
            : row)
        );
      }
    );

    await started.promise;
    mergePlayerChange(fixture.handle, '5', (draft) => {
      delete draft.tasks.first;
      draft.tasks.second = { id: 'second', title: 'Preserved' };
    });
    resume.resolve();

    await expect(pending).resolves.toMatchObject({ outcome: 'committed' });
    expect(calls).toBe(2);
    expect(fixture.handle.doc()?.tasks).toEqual({
      second: { id: 'second', title: 'Preserved' }
    });

    fixture.database.close();
    await fixture.repo.shutdown();
  });

  it('rejects mapped same-field conflicts without selecting a winner or invoking the transform', async () => {
    const fixture = await openTaskDatabase();
    const base = fixture.handle.doc()!;
    const left = Automerge.change(Automerge.clone(base, { actor: '6'.repeat(64) }), (draft) => {
      draft.tasks.first!.title = 'Left';
    });
    const right = Automerge.change(Automerge.clone(base, { actor: '7'.repeat(64) }), (draft) => {
      draft.tasks.first!.title = 'Right';
    });
    fixture.handle.update(() => Automerge.merge(left, right));
    let calls = 0;

    const receipt = await fixture.database.transact(
      { kind: 'must-not-select-conflict', id: 'first' },
      (snapshot) => {
        calls += 1;
        return snapshot;
      }
    );

    expect(receipt).toMatchObject({ outcome: 'rejected' });
    expect(receipt.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'automerge.conflict_observed', path: ['tasks', 'first', 'title'] })
    ]));
    expect(calls).toBe(0);
    const conflictTitles = Object.values(Automerge.getConflicts(fixture.handle.doc()!.tasks.first!, 'title') ?? {});
    expect(conflictTitles.every((title) => typeof title === 'string')).toBe(true);
    expect(conflictTitles.filter((title): title is string => typeof title === 'string')
      .sort((left, right) => left.localeCompare(right)))
      .toEqual(['Left', 'Right']);

    fixture.database.close();
    await fixture.repo.shutdown();
  });

  it('rejects a conflicted native declaration before constructing source machinery', async () => {
    let left = Automerge.from({ metadata: { declaration: { formatVersion: 1 } } }, { actor: '1'.repeat(64) });
    let right = Automerge.clone(left, { actor: '2'.repeat(64) });
    left = Automerge.change(left, (draft) => { draft.metadata.declaration.formatVersion = 2; });
    right = Automerge.change(right, (draft) => { draft.metadata.declaration.formatVersion = 3; });
    const declaration = Automerge.merge(left, right).metadata.declaration;
    const repo = new Repo();
    const handle = repo.create<TaskDocument>({ tasks: {} });

    await expect(openAutomergeDatabase({
      handle,
      declaration,
      embeddedArtifacts: [],
      authorityScope: 'scope:test'
    })).resolves.toMatchObject({
      success: false,
      issues: [{ code: 'automerge.value_conflicted', path: ['formatVersion'] }]
    });

    await repo.shutdown();
  });
});

const reference = (artifact: { readonly id: string; readonly contentHash: `sha256:${string}` }) => ({
  id: artifact.id,
  contentHash: artifact.contentHash
});

class ThrowingLeaseCatalog extends AttachmentCatalog {
  override attach<Storage, Projection>(
    input: DatabaseAttachmentInput<Storage, Projection>,
    releaseSource?: () => void
  ): AttachmentLease<Storage, Projection> {
    const lease = super.attach(input, releaseSource);
    return {
      attachment: lease.attachment,
      close: () => {
        lease.close();
        throw new Error('lease cleanup failed');
      }
    };
  }
}

const openTaskDatabase = async (options: {
  readonly artifactMap?: boolean;
  readonly allowedTitles?: readonly string[];
  readonly constrained?: boolean;
  readonly initialTitle?: string;
} = {}) => {
  const schema = await sealSchema({ id: 'urn:test:open-automerge:schema', body: {
    relations: { tasks: {
      relationId: 'tasks',
      key: ['id'],
      fields: {
        id: { type: { kind: 'string' } },
        title: { type: { kind: 'string' } }
      }
    } }
  } });
  const mapping = await sealStorageMapping({ id: 'urn:test:open-automerge:mapping', body: {
    schema: reference(schema),
    model: 'json-tree-v1',
    relations: { tasks: {
      collection: { kind: 'object-map', path: ['tasks'], absent: 'creatable' },
      keys: { id: { kind: 'map-key', mirrorPath: ['id'], onMismatch: 'reject' } },
      fields: {
        title: { path: ['title'], write: {
          replace: builtInCapabilityRefs.fieldReplace,
          textSplice: builtInCapabilityRefs.textSplice
        } }
      }
    } }
  } });
  const constraint = options.constrained === true
    ? await sealConstraintSet({ id: 'urn:test:open-automerge:constraints', body: {
        schemaView: reference(schema),
        constraints: [{
          id: 'task-validity',
          code: 'test.task_invalid',
          dependencyRelations: ['tasks'],
          violationQuery: {
            kind: 'select',
            input: {
              kind: 'where',
              input: { kind: 'from', relation: { schemaView: reference(schema), relationId: 'tasks' }, alias: 'task' },
              predicate: options.allowedTitles === undefined
                ? {
                    kind: 'compare',
                    op: 'eq',
                    left: { kind: 'field', alias: 'task', name: 'title' },
                    right: { kind: 'literal', value: 'Forbidden' }
                  }
                : {
                    kind: 'boolean',
                    op: 'and',
                    args: options.allowedTitles.map((title) => ({
                      kind: 'compare' as const,
                      op: 'ne' as const,
                      left: { kind: 'field' as const, alias: 'task', name: 'title' },
                      right: { kind: 'literal' as const, value: title }
                    }))
                  }
            },
            alias: 'violation',
            fields: {
              subject: {
                kind: 'record',
                fields: {
                  relationId: { kind: 'literal', value: 'tasks' },
                  key: { kind: 'field', alias: 'task', name: 'id' }
                }
              }
            }
          }
        }],
        requiredCapabilities: []
      } })
    : undefined;
  const repo = new Repo();
  const handle = repo.create<TaskDocument>({
    tasks: { first: { id: 'first', title: options.initialTitle ?? 'First' } }
  });
  const declaration: OpenAutomergeDatabaseOptions<TaskDocument, readonly string[]>['declaration'] = {
    formatVersion: 1,
    storageSchema: reference(schema),
    projection: { kind: 'storage-mapping', storageMapping: reference(mapping) },
    ...(constraint === undefined ? {} : { constraints: { set: reference(constraint), mode: 'required' as const } })
  };
  const artifacts = [schema, mapping, ...(constraint === undefined ? [] : [constraint])];
  const opened = await openAutomergeDatabase({
    handle,
    declaration,
    embeddedArtifacts: options.artifactMap === true
      ? Object.fromEntries(artifacts.map((artifact) => [artifact.id, artifact]))
      : artifacts,
    authorityScope: 'scope:test'
  });
  if (!opened.success) {
    await repo.shutdown();
    throw new Error(JSON.stringify(opened.issues));
  }
  return { database: opened.value, handle, repo, schema, tasks: relationLiteral(schema, 'tasks') };
};

const openSourceIdentityTaskDatabase = async (
  options: { readonly collectionPresent?: boolean } = {}
) => {
  const schema = await sealSchema({ id: 'urn:test:source-identity-task:schema', body: {
    relations: { tasks: {
      relationId: 'source-identity-tasks',
      key: ['id'],
      fields: {
        id: { type: { kind: 'string' } },
        title: { type: { kind: 'string' } },
        position: { type: { kind: 'number' } }
      }
    } }
  } });
  const mapping = await sealStorageMapping({ id: 'urn:test:source-identity-task:mapping', body: {
    schema: reference(schema),
    model: 'json-tree-v1',
    relations: { 'source-identity-tasks': {
      collection: { kind: 'array', path: ['tasks'], absent: 'creatable' },
      keys: { id: { kind: 'source-metadata', value: 'collection-element-identity' } },
      fields: {
        title: { path: ['title'], write: { replace: builtInCapabilityRefs.fieldReplace } },
        position: { kind: 'source-metadata', value: 'collection-position' }
      }
    } }
  } });
  const repo = new Repo();
  const handle = repo.create<SourceIdentityTaskDocument>(
    options.collectionPresent === false ? {} : { tasks: [] }
  );
  const opened = await openAutomergeDatabase({
    handle,
    declaration: {
      formatVersion: 1,
      storageSchema: reference(schema),
      projection: { kind: 'storage-mapping', storageMapping: reference(mapping) }
    },
    embeddedArtifacts: [schema, mapping],
    authorityScope: 'scope:test'
  });
  if (!opened.success) {
    await repo.shutdown();
    throw new Error(JSON.stringify(opened.issues));
  }
  return {
    database: opened.value,
    handle,
    repo,
    tasks: relationLiteral(schema, 'tasks')
  };
};

const openCompositeFileDatabase = async (mappingKind: CompositeFileMappingKind) => {
  const schema = await sealSchema({ id: 'urn:test:composite-file:schema', body: {
    relations: { files: {
      relationId: 'composite-files',
      key: ['id', 'contentKind'],
      fields: {
        contentKind: { type: { kind: 'string', values: ['text'] } },
        id: { type: { kind: 'string', values: ['file'] } },
        textContent: { type: { kind: 'string' } }
      }
    } }
  } });
  const textContent = { path: ['textContent'], write: {
    replace: builtInCapabilityRefs.fieldReplace,
    textSplice: builtInCapabilityRefs.textSplice
  } } as const;
  const relationMapping: RelationStorageMapping = mappingKind === 'singleton-literal-field'
    ? {
        collection: { kind: 'singleton', path: [], absent: 'invalid' },
        keys: {
          contentKind: { kind: 'literal', value: 'text' },
          id: { kind: 'field', path: ['id'] }
        },
        fields: { textContent }
      }
    : mappingKind === 'array-fields'
      ? {
          collection: { kind: 'array', path: ['files'], absent: 'creatable' },
          keys: {
            contentKind: { kind: 'field', path: ['contentKind'] },
            id: { kind: 'field', path: ['id'] }
          },
          fields: { textContent }
        }
      : {
          collection: { kind: 'object-map', path: ['files'], absent: 'creatable' },
          keys: {
            contentKind: { kind: 'field', path: ['contentKind'] },
            id: { kind: 'map-key', onMismatch: 'reject' }
          },
          fields: { textContent }
        };
  const mapping = await sealStorageMapping({ id: `urn:test:composite-file:mapping:${mappingKind}`, body: {
    schema: reference(schema),
    model: 'json-tree-v1',
    relations: { 'composite-files': relationMapping }
  } });
  const repo = new Repo();
  const document: CompositeFileDocument = mappingKind === 'singleton-literal-field'
    ? { id: 'file', textContent: 'First' }
    : mappingKind === 'array-fields'
      ? { files: [{ contentKind: 'text', id: 'file', textContent: 'First' }] }
      : { files: { file: { contentKind: 'text', textContent: 'First' } } };
  const handle = repo.create<CompositeFileDocument>(document);
  const opened = await openAutomergeDatabase({
    handle,
    declaration: {
      formatVersion: 1,
      storageSchema: reference(schema),
      projection: { kind: 'storage-mapping', storageMapping: reference(mapping) }
    },
    embeddedArtifacts: [schema, mapping],
    authorityScope: 'scope:test'
  });
  if (!opened.success) {
    await repo.shutdown();
    throw new Error(JSON.stringify(opened.issues));
  }
  const readText = (): string | undefined => {
    const current = handle.doc();
    if (current === undefined) return undefined;
    if ('textContent' in current) return current.textContent;
    if (Array.isArray(current.files)) return current.files[0]?.textContent;
    return current.files.file?.textContent;
  };
  return { database: opened.value, handle, repo, schema, files: relationLiteral(schema, 'files'), readText };
};

const mountTaskDatabase = async (
  fixture: Awaited<ReturnType<typeof openTaskDatabase>>
) => {
  const taskRelation = { schemaView: reference(fixture.schema), relationId: 'tasks' };
  const root: QueryNode = {
    kind: 'recursive',
    name: 'reachable',
    seed: {
      kind: 'select',
      alias: 'node',
      input: { kind: 'from', relation: taskRelation, alias: 'task' },
      fields: {
        id: { kind: 'field', alias: 'task', name: 'id' },
        source: { kind: 'source-of', alias: 'task' }
      }
    },
    step: {
      kind: 'select',
      alias: 'node',
      input: { kind: 'recursion-ref', name: 'reachable' },
      fields: {
        id: { kind: 'field', alias: 'node', name: 'id' },
        source: { kind: 'field', alias: 'node', name: 'source' }
      }
    },
    key: [
      { kind: 'field', alias: 'node', name: 'id' },
      { kind: 'field', alias: 'node', name: 'source' }
    ]
  };
  const plan = await prepareQuery({
    root,
    registryFingerprint: 'registry:test',
    authorityFingerprint: 'authority:test',
    datasetId: 'workspace'
  });
  const observer = await openDatabaseQuery({
    sources: [{
      source: fixture.database,
      expectation: 'required',
      discoveryEdges: ['workspace']
    }],
    plan,
    queryAuthorityScope: 'scope:test',
    canRead: ({ queryAuthorityScope, sourceAuthorityScope }) =>
      queryAuthorityScope === sourceAuthorityScope
  });
  return {
    observer,
    close: () => observer.close()
  };
};

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
};

const mergePlayerChange = (
  handle: Awaited<ReturnType<typeof openTaskDatabase>>['handle'],
  actorDigit: string,
  change: Automerge.ChangeFn<TaskDocument>
): void => {
  const remote = Automerge.change(
    Automerge.clone(handle.doc()!, { actor: actorDigit.repeat(64) }),
    change
  );
  handle.update((current) => Automerge.merge(current, remote));
};
