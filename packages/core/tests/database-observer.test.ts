import { describe, expect, it, vi } from 'vitest';
import {
  AttachmentCatalog,
  DatasetMembership,
  type DatabaseAttachment,
  type DatasetMember,
  type SourceSnapshot
} from '../src/database.js';
import {
  DatabaseView,
  type DatabaseEvaluation,
  type DatabaseEvaluationInput,
  type ObserverChange
} from '../src/observer.js';
import { ResourceResolver, type ResourceRef } from '../src/resolver.js';
import type { PreparedPlan } from '../src/maintenance.js';

type Row = { readonly id: number; readonly value: string };
type Query = { readonly kind: 'all' };

class TestSource {
  readonly sourceId: string;
  readonly incarnation: string;
  readonly #listeners = new Set<() => void>();
  #revision = 0;
  #state: SourceSnapshot<{ readonly rows: readonly Row[] }>['state'] = 'ready';
  #freshness: SourceSnapshot<unknown>['freshness'] = 'current';
  #rows: readonly Row[];

  constructor(sourceId: string, rows: readonly Row[]) {
    this.sourceId = sourceId;
    this.incarnation = sourceId + ':one';
    this.#rows = rows;
  }

  snapshot(): SourceSnapshot<{ readonly rows: readonly Row[] }> {
    return {
      sourceId: this.sourceId,
      operationEpoch: 'epoch:one',
      basis: { incarnation: this.incarnation, revision: this.#revision },
      state: this.#state,
      freshness: this.#freshness,
      ...(this.#state === 'ready' ? { storage: { rows: this.#rows } } : {}),
      issues: []
    };
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => { this.#listeners.delete(listener); };
  }

  publish(options: { readonly rows?: readonly Row[]; readonly state?: SourceSnapshot<unknown>['state']; readonly freshness?: SourceSnapshot<unknown>['freshness'] }): void {
    if (options.rows !== undefined) this.#rows = options.rows;
    if (options.state !== undefined) this.#state = options.state;
    if (options.freshness !== undefined) this.#freshness = options.freshness;
    this.#revision += 1;
    for (const listener of Array.from(this.#listeners)) listener();
  }

  listenerCount(): number { return this.#listeners.size; }
}

const attachment = (attachmentId: string, source: TestSource, authorityScope = 'public'): DatabaseAttachment<{ readonly rows: readonly Row[] }, readonly Row[]> => ({
  attachmentId,
  incarnation: attachmentId + ':one',
  sourceId: source.sourceId,
  source,
  authorityScope,
  writable: false,
  schemaViewIds: ['schema:rows'],
  discoveryEdges: ['edge:' + attachmentId],
  project: (snapshot) => snapshot.storage === undefined
    ? { state: snapshot.state === 'ready' ? 'failed' : snapshot.state, issues: [] }
    : { state: 'ready', value: snapshot.storage.rows, issues: [] }
});

const member = (attachmentId: string, sourceId: string, expectation: DatasetMember['expectation'] = 'required'): DatasetMember => ({
  attachmentId,
  sourceId,
  expectation,
  discoveryEdges: ['edge:' + attachmentId]
});

const plan = (datasetId = 'dataset:one', authorityFingerprint = 'authority:public'): PreparedPlan<Query> => ({
  planId: 'query:all',
  rootNodeId: 'query:all:root',
  query: { kind: 'all' },
  registryFingerprint: 'registry:one',
  authorityFingerprint,
  datasetId
});

const evaluate = ({ attachments }: DatabaseEvaluationInput<Query, readonly Row[]>): DatabaseEvaluation<Row> => {
  const rows = attachments.flatMap(({ projection }) => projection);
  return {
    rows,
    resultKeys: attachments.flatMap(({ member: inputMember, projection }) => projection.map((row) => inputMember.attachmentId + ':' + row.id)),
    completeness: 'exact',
    issues: []
  };
};

const view = (catalog: AttachmentCatalog, datasets: readonly DatasetMembership[], authorityScope = 'public', authorityFingerprint = 'authority:public') => new DatabaseView<Query, Row, readonly Row[]>({
  authorityScope,
  authorityFingerprint,
  registryFingerprint: 'registry:one',
  attachments: catalog,
  datasets,
  canRead: (viewScope, attachmentScope) => viewScope === 'admin' || viewScope === attachmentScope,
  evaluate
});

describe('database membership and observation', () => {
  it('uses exactly one dataset, deduplicates source runtimes, and preserves separate attachment authority', () => {
    const source = new TestSource('source:shared', [{ id: 1, value: 'one' }]);
    const unrelated = new TestSource('source:unrelated', [{ id: 9, value: 'outside' }]);
    const catalog = new AttachmentCatalog();
    const publicLease = catalog.attach(attachment('attachment:public', source));
    const privateLease = catalog.attach(attachment('attachment:private', source, 'private'));
    const unrelatedLease = catalog.attach(attachment('attachment:outside', unrelated));
    expect(catalog.sourceCount()).toBe(2);

    const dataset = new DatasetMembership({
      datasetId: 'dataset:one',
      state: 'settled',
      members: [member('attachment:public', source.sourceId), member('attachment:optional-missing', 'source:missing', 'optional')]
    });
    const database = view(catalog, [dataset]);
    const observer = database.observe({ plan: plan() });
    const snapshot = observer.getSnapshot();
    expect(snapshot).toMatchObject({
      state: 'open',
      current: {
        rows: [{ id: 1, value: 'one' }],
        completeness: 'exact',
        sourceStates: [
          { attachmentId: 'attachment:optional-missing', expectation: 'optional', state: 'missing' },
          { attachmentId: 'attachment:public', state: 'ready', authorized: true }
        ]
      }
    });
    expect(JSON.stringify(snapshot)).not.toContain('outside');
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.state === 'open' ? snapshot.current.rows[0] : undefined)).toBe(true);

    observer.close();
    database.close();
    publicLease.close();
    privateLease.close();
    unrelatedLease.close();
  });

  it('does not subscribe to or leak a required source denied by this authority view', () => {
    const privateSource = new TestSource('source:private', [{ id: 7, value: 'secret' }]);
    const catalog = new AttachmentCatalog();
    const lease = catalog.attach(attachment('attachment:private', privateSource, 'private'));
    const dataset = new DatasetMembership({ datasetId: 'dataset:one', state: 'settled', members: [member('attachment:private', privateSource.sourceId)] });
    const database = view(catalog, [dataset]);
    const observer = database.observe({ plan: plan() });
    expect(observer.getSnapshot()).toMatchObject({ state: 'open', current: { rows: [], completeness: 'unknown', sourceStates: [{ state: 'denied', authorized: false }] } });
    expect(privateSource.listenerCount()).toBe(0);
    expect(() => database.observe({ plan: plan('dataset:one', 'authority:admin') })).toThrow(/authority fingerprint/);
    observer.close();
    database.close();
    lease.close();
  });

  it('shares maintenance but gives each observer an independent closeable lease', () => {
    const source = new TestSource('source:one', [{ id: 1, value: 'one' }]);
    const catalog = new AttachmentCatalog();
    const attachmentLease = catalog.attach(attachment('attachment:one', source));
    const dataset = new DatasetMembership({ datasetId: 'dataset:one', state: 'settled', members: [member('attachment:one', source.sourceId)] });
    const database = view(catalog, [dataset]);
    const first = database.observe({ plan: plan(), parameters: { selected: 1 } });
    const second = database.observe({ plan: plan(), parameters: { selected: 1 } });
    expect(first).not.toBe(second);
    expect(database.activeMaintenanceCount()).toBe(1);
    expect(source.listenerCount()).toBe(1);
    expect(first.getSnapshot()).toBe(first.getSnapshot());

    const firstClosed = first.getSnapshot();
    first.close();
    expect(first.getSnapshot()).not.toBe(firstClosed);
    expect(first.getSnapshot()).toBe(first.getSnapshot());
    expect(second.getSnapshot().state).toBe('open');
    expect(source.listenerCount()).toBe(1);

    const listener = vi.fn();
    const unsubscribe = second.subscribe(listener);
    unsubscribe();
    source.publish({ rows: [{ id: 2, value: 'two' }] });
    expect(listener).not.toHaveBeenCalled();
    expect(second.getSnapshot()).toMatchObject({ state: 'open', current: { rows: [{ id: 2, value: 'two' }] } });

    second.close();
    second.close();
    expect(database.activeMaintenanceCount()).toBe(0);
    expect(source.listenerCount()).toBe(0);

    const later = database.observe({ plan: plan(), parameters: { selected: 1 } });
    expect(later.getSnapshot()).toMatchObject({ state: 'open', current: { rows: [{ id: 2, value: 'two' }] } });
    later.close();
    database.close();
    attachmentLease.close();
  });

  it('notifies on basis-only changes and emits invalidation rather than removal diffs', () => {
    const source = new TestSource('source:one', [{ id: 1, value: 'one' }]);
    const catalog = new AttachmentCatalog();
    const attachmentLease = catalog.attach(attachment('attachment:one', source));
    const dataset = new DatasetMembership({ datasetId: 'dataset:one', state: 'settled', members: [member('attachment:one', source.sourceId)] });
    const database = view(catalog, [dataset]);
    const observer = database.observe({ plan: plan() });
    const changes: ObserverChange<Row>[] = [];
    observer.subscribe((change) => { changes.push(change); });

    source.publish({ rows: [{ id: 1, value: 'one' }] });
    expect(changes[0]).toMatchObject({ kind: 'diff', diff: { added: [], removed: [], updated: [] } });
    const exactSnapshot = observer.getSnapshot();
    const exactBasis = exactSnapshot.state === 'open' ? exactSnapshot.current.basis : undefined;

    source.publish({ state: 'loading' });
    expect(changes[1]).toMatchObject({ kind: 'invalidation', snapshot: { state: 'open', current: { rows: [], resultKeys: [], completeness: 'unknown' } } });
    const invalidated = observer.getSnapshot();
    expect(invalidated).toMatchObject({ state: 'open', lastExact: { rows: [{ id: 1, value: 'one' }], freshness: 'stale', basis: exactBasis } });

    source.publish({ state: 'ready', rows: [{ id: 1, value: 'updated' }] });
    expect(changes[2]).toMatchObject({ kind: 'diff', diff: { added: [], removed: [], updated: [{ key: 'attachment:one:1', before: { value: 'one' }, after: { value: 'updated' } }] } });

    observer.close();
    database.close();
    attachmentLease.close();
  });

  it('invalidates on attachment removal and preserves occurrence identity across replacement', () => {
    const firstSource = new TestSource('source:one', [{ id: 1, value: 'one' }]);
    const catalog = new AttachmentCatalog();
    const releaseFirstSource = vi.fn();
    const firstAttachment = catalog.attach(attachment('attachment:one', firstSource), releaseFirstSource);
    const dataset = new DatasetMembership({ datasetId: 'dataset:one', state: 'settled', members: [member('attachment:one', firstSource.sourceId)] });
    const database = view(catalog, [dataset]);
    const observer = database.observe({ plan: plan() });
    const changes: ObserverChange<Row>[] = [];
    observer.subscribe((change) => { changes.push(change); });

    firstAttachment.close();
    expect(releaseFirstSource).toHaveBeenCalledOnce();
    expect(changes[0]).toMatchObject({ kind: 'invalidation' });
    expect(firstSource.listenerCount()).toBe(0);

    const replacementSource = new TestSource('source:one', [{ id: 1, value: 'replacement' }]);
    const replacementAttachment = catalog.attach(attachment('attachment:one', replacementSource));
    expect(changes[1]).toMatchObject({
      kind: 'diff',
      diff: {
        added: [],
        removed: [],
        updated: [{ key: 'attachment:one:1', before: { value: 'one' }, after: { value: 'replacement' } }]
      }
    });

    observer.close();
    database.close();
    replacementAttachment.close();
  });

  it('treats membership revision as observed evidence rather than cache identity', () => {
    const source = new TestSource('source:one', [{ id: 1, value: 'one' }]);
    const catalog = new AttachmentCatalog();
    const attachmentLease = catalog.attach(attachment('attachment:one', source));
    const dataset = new DatasetMembership({ datasetId: 'dataset:one', state: 'settled', members: [member('attachment:one', source.sourceId)] });
    const database = view(catalog, [dataset]);
    const first = database.observe({ plan: plan() });
    dataset.reopen();
    expect(first.getSnapshot()).toMatchObject({ state: 'open', current: { completeness: 'unknown', basis: { dataset: { revision: 1 } } } });
    const second = database.observe({ plan: plan() });
    expect(database.activeMaintenanceCount()).toBe(1);
    expect(second.getSnapshot()).toBe(first.getSnapshot());
    dataset.settle();
    expect(first.getSnapshot()).toMatchObject({ state: 'open', current: { completeness: 'exact', basis: { dataset: { revision: 2 } } } });
    first.close();
    second.close();
    database.close();
    attachmentLease.close();
  });

  it('queues reentrant source changes and isolates failing listeners', () => {
    const source = new TestSource('source:one', [{ id: 1, value: 'one' }]);
    const catalog = new AttachmentCatalog();
    const attachmentLease = catalog.attach(attachment('attachment:one', source));
    const dataset = new DatasetMembership({ datasetId: 'dataset:one', state: 'settled', members: [member('attachment:one', source.sourceId)] });
    const database = view(catalog, [dataset]);
    const observer = database.observe({ plan: plan() });
    const healthy = vi.fn();
    let reentered = false;
    observer.subscribe(() => { throw new Error('consumer failure'); });
    observer.subscribe(() => {
      healthy();
      if (!reentered) {
        reentered = true;
        source.publish({ rows: [{ id: 3, value: 'three' }] });
      }
    });
    source.publish({ rows: [{ id: 2, value: 'two' }] });
    expect(healthy).toHaveBeenCalledTimes(2);
    expect(observer.getSnapshot()).toMatchObject({ state: 'open', current: { rows: [{ id: 3, value: 'three' }] } });
    observer.close();
    database.close();
    attachmentLease.close();
  });
});

describe('resource resolver', () => {
  it('scopes caches by authority, follows redirects, detects cycles, and never invokes denied drivers', async () => {
    const calls = vi.fn();
    const resolver = new ResourceResolver({ authority: { permits: (scope, reference) => scope === 'admin' || !reference.uri.includes('secret') } });
    resolver.register('mem', {
      resolve: async (reference) => {
        calls(reference.uri);
        if (reference.uri === 'mem:start') return { state: 'redirect', target: { ...reference, uri: 'mem:value' } };
        if (reference.uri === 'mem:cycle-a') return { state: 'redirect', target: { ...reference, uri: 'mem:cycle-b' } };
        if (reference.uri === 'mem:cycle-b') return { state: 'redirect', target: { ...reference, uri: 'mem:cycle-a' } };
        return { state: 'ready', value: { inert: true } };
      }
    });
    const executable: ResourceRef = { uri: 'mem:start', kind: 'executable-code' };
    const first = await resolver.resolve(executable, { authorityScope: 'public' });
    const cached = await resolver.resolve(executable, { authorityScope: 'public' });
    expect(first).toBe(cached);
    expect(first).toMatchObject({ state: 'ready', redirects: ['mem:start'], value: { inert: true } });
    expect(calls).toHaveBeenCalledTimes(2);
    await resolver.resolve(executable, { authorityScope: 'admin' });
    expect(calls).toHaveBeenCalledTimes(4);

    const beforeDenied = calls.mock.calls.length;
    expect(await resolver.resolve({ uri: 'mem:secret', kind: 'data' }, { authorityScope: 'public' })).toMatchObject({ state: 'denied', issues: [{ code: 'resolver.authority_denied' }] });
    expect(calls).toHaveBeenCalledTimes(beforeDenied);
    expect(await resolver.resolve({ uri: 'mem:cycle-a', kind: 'data' }, { authorityScope: 'admin' })).toMatchObject({ state: 'failed', issues: [{ code: 'resolver.cycle' }] });
  });
});
