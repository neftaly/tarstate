import { describe, expect, it, vi } from 'vitest';
import {
  AttachmentCatalog,
  DatasetMembership,
  type DatabaseAttachment,
  type DatabaseAttachmentInput,
  type DatasetMember,
  type SourceSnapshot
} from '../src/database.js';
import { prepareManualReadOnlyAttachment } from '../src/attachment/preparation.js';
import {
  createDatabaseView,
  type DatabaseView,
  type MaintainedDatabaseQueryResult,
  type DatabaseQueryMaintenanceInput,
  type CreateDatabaseQueryMaintenance,
  type ObserverChange,
  type QueryObserver
} from '../src/observer.js';
import { createIncrementalDatabaseQueryMaintenance } from '@tarstate/core/database/incremental';
import type { QueryNode, QueryRecord, RelationInput } from '../src/query.js';
import type { PreparedPlan } from '../src/maintenance.js';
import { sealPreparedPlan } from '../src/query/internal/prepared-plan.js';
import type { JsonValue } from '../src/value.js';

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
  #subscriptionCount = 0;
  #snapshotCount = 0;
  #unsubscribeCount = 0;
  #subscriptionFailures = 0;
  #unsubscribeFailures = 0;
  #snapshotFailures = 0;

  constructor(sourceId: string, rows: readonly Row[]) {
    this.sourceId = sourceId;
    this.incarnation = sourceId + ':one';
    this.#rows = rows;
  }

  snapshot(): SourceSnapshot<{ readonly rows: readonly Row[] }> {
    this.#snapshotCount += 1;
    if (this.#snapshotFailures > 0) {
      this.#snapshotFailures -= 1;
      throw new Error('snapshot failed');
    }
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
    if (this.#subscriptionFailures > 0) {
      this.#subscriptionFailures -= 1;
      throw new Error('subscription failed');
    }
    this.#subscriptionCount += 1;
    this.#listeners.add(listener);
    return () => {
      this.#unsubscribeCount += 1;
      if (this.#unsubscribeFailures > 0) {
        this.#unsubscribeFailures -= 1;
        throw new Error('unsubscribe failed');
      }
      this.#listeners.delete(listener);
    };
  }

  publish(options: { readonly rows?: readonly Row[]; readonly state?: SourceSnapshot<unknown>['state']; readonly freshness?: SourceSnapshot<unknown>['freshness'] }): void {
    if (options.rows !== undefined) this.#rows = options.rows;
    if (options.state !== undefined) this.#state = options.state;
    if (options.freshness !== undefined) this.#freshness = options.freshness;
    this.#revision += 1;
    for (const listener of Array.from(this.#listeners)) listener();
  }

  notify(): void {
    for (const listener of Array.from(this.#listeners)) listener();
  }

  listenerCount(): number { return this.#listeners.size; }
  subscriptionCount(): number { return this.#subscriptionCount; }
  snapshotCount(): number { return this.#snapshotCount; }
  unsubscribeCount(): number { return this.#unsubscribeCount; }
  failSubscriptions(count = 1): void { this.#subscriptionFailures = count; }
  failUnsubscribes(count = 1): void { this.#unsubscribeFailures = count; }
  failSnapshots(count = 1): void { this.#snapshotFailures = count; }
}

const attachment = (attachmentId: string, source: TestSource, authorityScope = 'public'): DatabaseAttachmentInput<{ readonly rows: readonly Row[] }, readonly Row[]> => ({
  attachmentId,
  incarnation: attachmentId + ':one',
  sourceId: source.sourceId,
  source,
  authorityScope,
  discoveryEdges: ['edge:' + attachmentId],
  preparation: prepareManualReadOnlyAttachment({
    schemaViewIds: ['schema:rows'],
    project: (snapshot) => snapshot.storage === undefined
      ? { state: snapshot.state === 'ready' ? 'failed' : snapshot.state, issues: [] }
      : { state: 'ready', value: snapshot.storage.rows, issues: [] }
  })
});

const member = (attachmentId: string, sourceId: string, expectation: DatasetMember['expectation'] = 'required'): DatasetMember => ({
  attachmentId,
  sourceId,
  expectation,
  discoveryEdges: ['edge:' + attachmentId]
});

const plan = (datasetId = 'dataset:one', authorityFingerprint = 'authority:public'): PreparedPlan<Query> => sealPreparedPlan({
  planId: 'query:all',
  rootNodeId: 'query:all:root',
  query: { kind: 'all' },
  registryFingerprint: 'registry:one',
  authorityFingerprint,
  datasetId
});

const evaluate = ({ attachments }: DatabaseQueryMaintenanceInput<Query, readonly Row[]>): MaintainedDatabaseQueryResult<Row> => {
  const rows = attachments.flatMap(({ projection }) => projection);
  return {
    rows,
    resultKeys: attachments.flatMap(({ member: inputMember, projection }) => projection.map((row) => inputMember.attachmentId + ':' + row.id)),
    completeness: 'exact',
    issues: []
  };
};

const createMaintenance = (evaluation: typeof evaluate): import('../src/observer.js').CreateDatabaseQueryMaintenance<Query, Row, readonly Row[]> => ({ initialInput }) => {
  let current = evaluation(initialInput);
  return {
    getCurrentResult: () => current,
    updateInput: (input) => {
      current = evaluation(input as DatabaseQueryMaintenanceInput<Query, readonly Row[]>);
      return current;
    },
    close: () => undefined
  };
};

const view = (catalog: AttachmentCatalog, datasets: readonly DatasetMembership[], authorityScope = 'public', authorityFingerprint = 'authority:public', evaluation = evaluate, onDiagnostic?: import('../src/observer-diagnostics.js').ObserverDiagnosticReporter) => createDatabaseView<Query, Row, readonly Row[]>({
  authorityScope,
  authorityFingerprint,
  registryFingerprint: 'registry:one',
  attachments: catalog,
  datasets,
  canRead: (viewScope, attachmentScope) => viewScope === 'admin' || viewScope === attachmentScope,
  createQueryMaintenance: createMaintenance(evaluation),
  ...(onDiagnostic === undefined ? {} : { onDiagnostic })
});

const querySchemaView = { id: 'urn:test:observer-schema', contentHash: `sha256:${'a'.repeat(64)}` } as const;

const relationalAttachment = (attachmentId: string, source: TestSource, onNormalize?: () => void): DatabaseAttachmentInput<{ readonly rows: readonly Row[] }, readonly RelationInput[]> => ({
  attachmentId,
  incarnation: attachmentId + ':one',
  sourceId: source.sourceId,
  source,
  authorityScope: 'public',
  discoveryEdges: ['edge:' + attachmentId],
  preparation: prepareManualReadOnlyAttachment({
    schemaViewIds: [querySchemaView.id],
    project: (snapshot) => snapshot.storage === undefined
      ? { state: snapshot.state === 'ready' ? 'failed' : snapshot.state, issues: [] }
      : (() => {
          const relation: RelationInput = {
            relation: { schemaView: querySchemaView, relationId: 'test.rows' },
            rows: snapshot.storage.rows,
            occurrenceIds: snapshot.storage.rows.map(({ id }) => 'row:' + id),
            completeness: 'exact',
            sourceId: source.sourceId,
            attachmentId,
            basis: snapshot.basis
          };
          const observable = onNormalize === undefined ? relation : new Proxy(relation, {
            ownKeys: (target) => {
              onNormalize();
              return Reflect.ownKeys(target);
            }
          });
          return {
            state: 'ready',
            value: [observable],
            issues: []
          };
        })()
  })
});

const relationalPlan = (): PreparedPlan<QueryNode> => sealPreparedPlan({
  planId: 'query:incremental-observer',
  rootNodeId: 'query:incremental-observer:root',
  query: {
    kind: 'where',
    input: { kind: 'from', relation: { schemaView: querySchemaView, relationId: 'test.rows' }, alias: 'row' },
    predicate: { kind: 'compare', op: 'gte', left: { kind: 'field', alias: 'row', name: 'id' }, right: { kind: 'literal', value: 2 } }
  },
  registryFingerprint: 'registry:one',
  authorityFingerprint: 'authority:public',
  datasetId: 'dataset:one'
});

describe('database membership and observation', () => {
  it('keeps database view methods safe when passed or destructured', () => {
    const dataset = new DatasetMembership({ datasetId: 'dataset:one', state: 'settled' });
    const database = view(new AttachmentCatalog(), [dataset]);
    const { observe, getActiveMaintenanceCount, close } = database;
    const observer = observe({ plan: plan() });

    expect(getActiveMaintenanceCount()).toBe(1);
    observer.close();
    close();
    expect(() => observe({ plan: plan() })).toThrow('Database view is closed');
  });

  it('keeps maintenance factory calls source-compatible without a runtime identity', () => {
    const dataset = new DatasetMembership({ datasetId: 'dataset:one', state: 'settled' });
    const initialInput: DatabaseQueryMaintenanceInput<Query, readonly Row[]> = {
      query: { kind: 'all' }, parameters: {}, dataset: dataset.snapshot(), attachments: []
    };
    const custom: CreateDatabaseQueryMaintenance<Query, Row, readonly Row[]> = createMaintenance(evaluate);
    const customSession = custom({ plan: plan(), initialInput });
    expect(customSession.getCurrentResult()).toMatchObject({ rows: [], completeness: 'exact' });
    customSession.close();

    const builtIn = createIncrementalDatabaseQueryMaintenance();
    const builtInSession = builtIn({
      plan: relationalPlan(),
      initialInput: { query: relationalPlan().query, parameters: {}, dataset: dataset.snapshot(), attachments: [] }
    });
    expect(builtInSession.getCurrentResult()).toMatchObject({ completeness: 'unknown' });
    builtInSession.close();

    const catalog = new AttachmentCatalog();
    const customView = view(catalog, [dataset]);
    const observer = customView.observe({ plan: plan() });
    dataset.replaceMembers([], 'settled');
    expect(customView.getQueryMaintenanceReuseDiagnostics()).toEqual({
      computedFrameDeltaCount: 0, reusedFrameDeltaCount: 0
    });
    observer.close();
    customView.close();
  });

  it('reopens maintenance after a transient factory construction failure', () => {
    const source = new TestSource('source:transient-maintenance', [{ id: 1, value: 'one' }]);
    const catalog = new AttachmentCatalog();
    const attachmentLease = catalog.attach(attachment('attachment:transient-maintenance', source));
    const dataset = new DatasetMembership({
      datasetId: 'dataset:one', state: 'settled', members: [member('attachment:transient-maintenance', source.sourceId)]
    });
    const working = createMaintenance(evaluate);
    let factoryCalls = 0;
    const database = createDatabaseView<Query, Row, readonly Row[]>({
      authorityScope: 'public', authorityFingerprint: 'authority:public', registryFingerprint: 'registry:one',
      attachments: catalog, datasets: [dataset], canRead: () => true,
      createQueryMaintenance: (input) => {
        factoryCalls += 1;
        if (factoryCalls === 1) throw new Error('temporarily unavailable');
        return working(input);
      }
    });
    const observer = database.observe({ plan: plan() });
    expect(observer.getSnapshot()).toMatchObject({ state: 'open', current: { readiness: 'invalid', completeness: 'unknown' } });

    source.publish({ rows: [{ id: 2, value: 'recovered' }] });
    expect(factoryCalls).toBe(2);
    expect(observer.getSnapshot()).toMatchObject({ state: 'open', current: {
      readiness: 'ready', completeness: 'exact', rows: [{ id: 2, value: 'recovered' }]
    } });
    observer.close();
    database.close();
    attachmentLease.close();
  });

  it('does not resnapshot or reproject unchanged sources during another source refresh', () => {
    const firstSource = new TestSource('source:projection-cache:first', [{ id: 1, value: 'one' }]);
    const secondSource = new TestSource('source:projection-cache:second', [{ id: 2, value: 'two' }]);
    const firstInput = attachment('attachment:projection-cache:first', firstSource);
    const secondInput = attachment('attachment:projection-cache:second', secondSource);
    const firstProject = vi.fn(firstInput.preparation.project);
    const secondProject = vi.fn(secondInput.preparation.project);
    const catalog = new AttachmentCatalog();
    const firstLease = catalog.attach({ ...firstInput, preparation: { ...firstInput.preparation, project: firstProject } });
    const secondLease = catalog.attach({ ...secondInput, preparation: { ...secondInput.preparation, project: secondProject } });
    const dataset = new DatasetMembership({
      datasetId: 'dataset:one',
      state: 'settled',
      members: [
        member(firstInput.attachmentId, firstSource.sourceId),
        member(secondInput.attachmentId, secondSource.sourceId)
      ]
    });
    const database = view(catalog, [dataset]);
    const observer = database.observe({ plan: plan() });
    expect(firstProject).toHaveBeenCalledOnce();
    expect(secondProject).toHaveBeenCalledOnce();
    expect(firstSource.snapshotCount()).toBe(1);
    expect(secondSource.snapshotCount()).toBe(1);

    firstSource.publish({ rows: [{ id: 1, value: 'changed' }] });
    expect(firstProject).toHaveBeenCalledTimes(2);
    expect(secondProject).toHaveBeenCalledOnce();
    expect(firstSource.snapshotCount()).toBe(2);
    expect(secondSource.snapshotCount()).toBe(1);
    expect(observer.getSnapshot()).toMatchObject({ current: { rows: [
      { id: 1, value: 'changed' },
      { id: 2, value: 'two' }
    ] } });

    observer.close();
    database.close();
    secondLease.close();
    firstLease.close();
  });

  it('rejects ambiguous database dataset identities', () => {
    const catalog = new AttachmentCatalog();
    const first = new DatasetMembership({ datasetId: 'dataset:one', state: 'settled' });
    const second = new DatasetMembership({ datasetId: 'dataset:one', state: 'settled' });
    expect(() => view(catalog, [first, second])).toThrow(/different dataset membership/);
  });

  it('fails closed when a source snapshot claims a different source identity', () => {
    const source = new TestSource('source:expected', [{ id: 1, value: 'must-not-project' }]);
    const base = attachment('attachment:snapshot-mismatch', source);
    const project = vi.fn(base.preparation.project);
    const mismatchedSource = {
      sourceId: source.sourceId,
      snapshot: (): SourceSnapshot<{ readonly rows: readonly Row[] }> => ({ ...source.snapshot(), sourceId: 'source:other' }),
      subscribe: (listener: () => void) => source.subscribe(listener)
    };
    const catalog = new AttachmentCatalog();
    const attachmentLease = catalog.attach({ ...base, source: mismatchedSource, preparation: { ...base.preparation, project } });
    const dataset = new DatasetMembership({
      datasetId: 'dataset:one', state: 'settled', members: [member('attachment:snapshot-mismatch', source.sourceId)]
    });
    const database = view(catalog, [dataset]);
    const observer = database.observe({ plan: plan() });

    expect(project).not.toHaveBeenCalled();
    expect(observer.getSnapshot()).toMatchObject({ state: 'open', current: {
      readiness: 'incomplete', rows: [], completeness: 'unknown',
      basis: { attachments: [] },
      sourceStates: [{ state: 'missing', issues: [{ code: 'observer.membership_source_mismatch' }] }]
    } });
    observer.close();
    database.close();
    attachmentLease.close();
  });

  it('rolls back a partially constructed dataset capture runtime', () => {
    const firstSource = new TestSource('source:subscription-first', []);
    const failingSource = new TestSource('source:subscription-failing', []);
    failingSource.failSubscriptions();
    const catalog = new AttachmentCatalog();
    const firstLease = catalog.attach(attachment('attachment:a-first', firstSource));
    const failingLease = catalog.attach(attachment('attachment:b-failing', failingSource));
    const dataset = new DatasetMembership({
      datasetId: 'dataset:one', state: 'settled',
      members: [member('attachment:a-first', firstSource.sourceId), member('attachment:b-failing', failingSource.sourceId)]
    });
    const database = view(catalog, [dataset]);

    expect(() => database.observe({ plan: plan() })).toThrow('subscription failed');
    expect(firstSource.listenerCount()).toBe(0);
    expect(database.getActiveMaintenanceCount()).toBe(0);
    database.close();
    failingLease.close();
    firstLease.close();
  });

  it('closes maintenance and capture ownership when observation construction fails', () => {
    const source = new TestSource('source:construction-failure', [{ id: 1, value: 'one' }]);
    const catalog = new AttachmentCatalog();
    const attachmentLease = catalog.attach(attachment('attachment:construction-failure', source));
    const dataset = new DatasetMembership({ datasetId: 'dataset:one', state: 'settled', members: [member('attachment:construction-failure', source.sourceId)] });
    const close = vi.fn();
    const database = createDatabaseView<Query, Row, readonly Row[]>({
      authorityScope: 'public', authorityFingerprint: 'authority:public', registryFingerprint: 'registry:one',
      attachments: catalog, datasets: [dataset], canRead: () => true,
      createQueryMaintenance: () => ({ getCurrentResult: () => { throw new Error('current failed'); }, updateInput: evaluate, close })
    });

    expect(() => database.observe({ plan: plan() })).toThrow('current failed');
    expect(close).toHaveBeenCalledOnce();
    expect(source.listenerCount()).toBe(0);
    expect(database.getActiveMaintenanceCount()).toBe(0);
    database.close();
    attachmentLease.close();
  });

  it('rejects duplicate attachment IDs whose authority view or projection differs', () => {
    const source = new TestSource('source:one', []);
    const catalog = new AttachmentCatalog();
    const firstInput = attachment('attachment:one', source);
    const first = catalog.attach(firstInput);
    const duplicate = catalog.attach(firstInput);
    expect(duplicate.attachment).toBe(first.attachment);
    expect(() => catalog.attach({
      ...firstInput,
      preparation: { ...firstInput.preparation, writable: !firstInput.preparation.writable }
    })).toThrow(/different live attachment/);
    expect(() => catalog.attach(attachment('attachment:one', source))).toThrow(/different live attachment/);
    duplicate.close();
    first.close();
  });

  it('owns and freezes attachment schema views and discovery edges', () => {
    const source = new TestSource('source:owned-attachment-metadata', []);
    const schemaViewIds = ['schema:owned'];
    const discoveryEdges = ['edge:owned'];
    const base = attachment('attachment:owned-metadata', source);
    const catalog = new AttachmentCatalog();
    const lease = catalog.attach({
      ...base,
      discoveryEdges,
      preparation: { ...base.preparation, schemaViewIds }
    });

    schemaViewIds.push('schema:mutated');
    discoveryEdges.push('edge:mutated');
    expect(lease.attachment.schemaViewIds).toEqual(['schema:owned']);
    expect(lease.attachment.discoveryEdges).toEqual(['edge:owned']);
    expect(Object.isFrozen(lease.attachment.schemaViewIds)).toBe(true);
    expect(Object.isFrozen(lease.attachment.discoveryEdges)).toBe(true);
    lease.close();
  });

  it('removes an attachment lease even when source release throws', () => {
    const source = new TestSource('source:throwing-release', []);
    const catalog = new AttachmentCatalog();
    const lease = catalog.attach(attachment('attachment:throwing-release', source), () => {
      throw new Error('source release failed');
    });

    expect(() => lease.close()).toThrow('source release failed');
    expect(catalog.get('attachment:throwing-release')).toBeUndefined();
    expect(catalog.sourceCount()).toBe(0);

    const replacement = catalog.attach(attachment('attachment:throwing-release', source));
    replacement.close();
  });

  it('publishes membership only when its semantic state changes', () => {
    const dataset = new DatasetMembership({ datasetId: 'dataset:one', state: 'open' });
    const listener = vi.fn();
    dataset.subscribe(listener);
    const open = dataset.snapshot();
    expect(dataset.reopen()).toBe(open);
    expect(listener).not.toHaveBeenCalled();

    const settled = dataset.settle();
    expect(settled.revision).toBe(1);
    expect(dataset.settle()).toBe(settled);
    expect(listener).toHaveBeenCalledTimes(1);

    const reopened = dataset.reopen();
    expect(reopened.revision).toBe(2);
    expect(dataset.reopen()).toBe(reopened);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('reports contained membership and catalog listener failures without starving peers', () => {
    const diagnostics = vi.fn();
    const dataset = new DatasetMembership({ datasetId: 'dataset:diagnostics', onDiagnostic: diagnostics });
    const catalog = new AttachmentCatalog({ onDiagnostic: diagnostics });
    const source = new TestSource('source:diagnostics', []);
    const healthyDataset = vi.fn();
    const healthyCatalog = vi.fn();
    dataset.subscribe(() => { throw new Error('membership listener failed'); });
    dataset.subscribe(healthyDataset);
    catalog.subscribe(() => { throw new Error('catalog listener failed'); });
    catalog.subscribe(healthyCatalog);

    dataset.settle();
    const lease = catalog.attach(attachment('attachment:diagnostics', source));

    expect(healthyDataset).toHaveBeenCalledOnce();
    expect(healthyCatalog).toHaveBeenCalledOnce();
    expect(diagnostics.mock.calls.map(([diagnostic]) => diagnostic)).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'listener_error', component: 'dataset-membership', operation: 'publish' }),
      expect.objectContaining({ kind: 'listener_error', component: 'attachment-catalog', operation: 'publish' })
    ]));
    lease.close();
  });

  it('withdraws adapter results whose occurrence identities are not unique', () => {
    const source = new TestSource('source:duplicates', [{ id: 1, value: 'one' }, { id: 2, value: 'two' }]);
    const catalog = new AttachmentCatalog();
    const lease = catalog.attach(attachment('attachment:duplicates', source));
    const dataset = new DatasetMembership({ datasetId: 'dataset:one', state: 'settled', members: [member('attachment:duplicates', source.sourceId)] });
    const database = view(catalog, [dataset], 'public', 'authority:public', (input) => {
      const result = evaluate(input);
      return { ...result, resultKeys: result.rows.map(() => 'duplicate') };
    });
    const observer = database.observe({ plan: plan() });
    expect(observer.getSnapshot()).toMatchObject({ state: 'open', current: {
      rows: [],
      resultKeys: [],
      completeness: 'unknown',
      issues: expect.arrayContaining([expect.objectContaining({ code: 'observer.evaluation_failed', details: { reason: 'invalid_result_identity' } })])
    } });
    observer.close();
    database.close();
    lease.close();
  });

  it('routes observer updates through the incremental query-maintenance factory', () => {
    const source = new TestSource('source:incremental', [{ id: 1, value: 'one' }, { id: 2, value: 'two' }]);
    const catalog = new AttachmentCatalog();
    const attachmentLease = catalog.attach(relationalAttachment('attachment:incremental', source));
    const dataset = new DatasetMembership({ datasetId: 'dataset:one', state: 'settled', members: [member('attachment:incremental', source.sourceId)] });
    const database = createDatabaseView<QueryNode, QueryRecord, readonly RelationInput[]>({
      authorityScope: 'public',
      authorityFingerprint: 'authority:public',
      registryFingerprint: 'registry:one',
      attachments: catalog,
      datasets: [dataset],
      canRead: () => true,
      createQueryMaintenance: createIncrementalDatabaseQueryMaintenance()
    });
    const observer = database.observe({ plan: relationalPlan() });
    const initial = observer.getSnapshot();
    expect(initial).toMatchObject({ state: 'open', current: { rows: [{ id: 2, value: 'two' }] } });
    const initialKey = initial.state === 'open' ? initial.current.resultKeys[0] : undefined;
    const changes: ObserverChange<QueryRecord>[] = [];
    observer.subscribe((change) => changes.push(change));

    source.publish({ rows: [{ id: 2, value: 'updated' }, { id: 3, value: 'three' }] });
    expect(observer.getSnapshot()).toMatchObject({ state: 'open', current: { rows: [{ id: 2, value: 'updated' }, { id: 3, value: 'three' }], resultKeys: [initialKey, expect.any(String)] } });
    expect(changes[0]).toMatchObject({ kind: 'diff', diff: {
      added: [{ row: { id: 3, value: 'three' } }], removed: [],
      updated: [{ key: initialKey, before: { id: 2, value: 'two' }, after: { id: 2, value: 'updated' } }]
    } });
    source.publish({ rows: [{ id: 4, value: 'four' }, { id: 2, value: 'updated again' }, { id: 5, value: 'five' }] });
    expect(changes[1]).toMatchObject({ kind: 'diff', diff: {
      added: [{ row: { id: 4, value: 'four' } }, { row: { id: 5, value: 'five' } }],
      removed: [{ row: { id: 3, value: 'three' } }],
      updated: [{ key: initialKey, before: { id: 2, value: 'updated' }, after: { id: 2, value: 'updated again' } }]
    } });
    const changed = observer.getSnapshot();
    source.notify();
    expect(observer.getSnapshot()).toBe(changed);
    expect(changes).toHaveLength(2);

    source.publish({ state: 'failed', freshness: 'none' });
    expect(observer.getSnapshot()).toMatchObject({
      state: 'open',
      current: { readiness: 'incomplete', rows: [], resultKeys: [], completeness: 'unknown', sourceStates: [{ state: 'failed' }] },
      lastExact: { rows: [{ id: 4, value: 'four' }, { id: 2, value: 'updated again' }, { id: 5, value: 'five' }], freshness: 'stale' }
    });

    source.publish({ state: 'ready', freshness: 'current', rows: [{ id: 4, value: 'recovered' }] });
    expect(observer.getSnapshot()).toMatchObject({ state: 'open', current: { rows: [{ id: 4, value: 'recovered' }], resultKeys: [expect.any(String)], completeness: 'exact' } });

    observer.close();
    database.close();
    attachmentLease.close();
  });

  it('shares owned capture evidence across distinct roots and isolates successive frames', () => {
    const source = new TestSource('source:shared-evidence', [{ id: 1, value: 'one' }, { id: 2, value: 'two' }, { id: 3, value: 'three' }]);
    const catalog = new AttachmentCatalog();
    const attachmentLease = catalog.attach(relationalAttachment('attachment:shared-evidence', source));
    const dataset = new DatasetMembership({ datasetId: 'dataset:one', state: 'settled', members: [member('attachment:shared-evidence', source.sourceId)] });
    const database = createDatabaseView<QueryNode, QueryRecord, readonly RelationInput[]>({
      authorityScope: 'public',
      authorityFingerprint: 'authority:public',
      registryFingerprint: 'registry:one',
      attachments: catalog,
      datasets: [dataset],
      canRead: () => true,
      createQueryMaintenance: createIncrementalDatabaseQueryMaintenance()
    });
    const first = database.observe({ plan: relationalPlan() });
    const second = database.observe({ plan: sealPreparedPlan({
      ...relationalPlan(),
      planId: 'query:shared-evidence:second',
      rootNodeId: 'query:shared-evidence:second:root',
      query: {
        kind: 'where',
        input: { kind: 'from', relation: { schemaView: querySchemaView, relationId: 'test.rows' }, alias: 'row' },
        predicate: { kind: 'compare', op: 'gte', left: { kind: 'field', alias: 'row', name: 'id' }, right: { kind: 'literal', value: 3 } }
      }
    }) });
    const initialFirst = first.getSnapshot();
    const initialSecond = second.getSnapshot();
    if (initialFirst.state !== 'open' || initialSecond.state !== 'open') throw new Error('expected open observers');
    expect(initialFirst.current).not.toBe(initialSecond.current);
    expect(initialFirst.current.rows).not.toBe(initialSecond.current.rows);
    expect(initialFirst.current.rows).toHaveLength(2);
    expect(initialSecond.current.rows).toHaveLength(1);
    expect(initialFirst.current.basis).toBe(initialSecond.current.basis);
    expect(initialFirst.current.sourceStates).toBe(initialSecond.current.sourceStates);
    expect(initialFirst.current.issues).not.toBe(initialSecond.current.issues);

    source.publish({ rows: [{ id: 1, value: 'one' }, { id: 2, value: 'updated' }, { id: 4, value: 'four' }] });
    const updatedFirst = first.getSnapshot();
    const updatedSecond = second.getSnapshot();
    if (updatedFirst.state !== 'open' || updatedSecond.state !== 'open') throw new Error('expected updated observers');
    expect(updatedFirst.current.basis).toBe(updatedSecond.current.basis);
    expect(updatedFirst.current.sourceStates).toBe(updatedSecond.current.sourceStates);
    expect(updatedFirst.current.basis).not.toBe(initialFirst.current.basis);
    expect(updatedFirst.current.sourceStates).not.toBe(initialFirst.current.sourceStates);
    expect(initialFirst.current.basis.attachments[0]?.basis).toMatchObject({ revision: 0 });
    expect(updatedFirst.current.basis.attachments[0]?.basis).toMatchObject({ revision: 1 });

    source.publish({ state: 'loading' });
    const invalidFirst = first.getSnapshot();
    const invalidSecond = second.getSnapshot();
    if (invalidFirst.state !== 'open' || invalidSecond.state !== 'open') throw new Error('expected invalidated observers');
    expect(invalidFirst.current.sourceStates).toBe(invalidSecond.current.sourceStates);
    expect(invalidFirst.lastExact?.sourceStates).toBe(updatedFirst.current.sourceStates);
    expect(invalidSecond.lastExact?.sourceStates).toBe(updatedSecond.current.sourceStates);
    expect(invalidFirst.lastExact?.basis).toBe(updatedFirst.current.basis);
    expect(Object.isFrozen(invalidFirst.lastExact)).toBe(true);

    first.close();
    second.close();
    database.close();
    attachmentLease.close();
  });

  it('detaches observed queries and does not alias different semantics with reused plan IDs', () => {
    const source = new TestSource('source:plan-identity', [{ id: 2, value: 'two' }, { id: 3, value: 'three' }]);
    const catalog = new AttachmentCatalog();
    const attachmentLease = catalog.attach(relationalAttachment('attachment:plan-identity', source));
    const dataset = new DatasetMembership({ datasetId: 'dataset:one', state: 'settled', members: [member('attachment:plan-identity', source.sourceId)] });
    const threshold = { kind: 'literal' as const, value: 2 };
    const mutableQuery: QueryNode = {
      kind: 'where',
      input: { kind: 'from', relation: { schemaView: querySchemaView, relationId: 'test.rows' }, alias: 'row' },
      predicate: { kind: 'compare', op: 'gte', left: { kind: 'field', alias: 'row', name: 'id' }, right: threshold }
    };
    const reusedIdentityPlan = sealPreparedPlan({ ...relationalPlan(), query: mutableQuery });
    const database = createDatabaseView<QueryNode, QueryRecord, readonly RelationInput[]>({
      authorityScope: 'public', authorityFingerprint: 'authority:public', registryFingerprint: 'registry:one',
      attachments: catalog, datasets: [dataset], canRead: () => true, createQueryMaintenance: createIncrementalDatabaseQueryMaintenance()
    });

    const first = database.observe({ plan: reusedIdentityPlan });
    threshold.value = 3;
    const second = database.observe({ plan: reusedIdentityPlan });

    expect(first.getSnapshot()).toMatchObject({ state: 'open', current: { rows: [{ id: 2, value: 'two' }, { id: 3, value: 'three' }] } });
    expect(second.getSnapshot()).toMatchObject({ state: 'open', current: { rows: [{ id: 3, value: 'three' }] } });
    expect(database.getActiveMaintenanceCount()).toBe(2);
    first.close();
    second.close();
    database.close();
    attachmentLease.close();
  });

  it('rejects non-portable and prototype-polluting observation parameters before caching', () => {
    const catalog = new AttachmentCatalog();
    const dataset = new DatasetMembership({ datasetId: 'dataset:one', state: 'settled' });
    const database = view(catalog, [dataset]);
    const polluted = JSON.parse('{"__proto__":{"admin":true}}') as Readonly<Record<string, JsonValue>>;

    expect(() => database.observe({ plan: plan(), parameters: { when: new Date(0) } as unknown as Readonly<Record<string, JsonValue>> }))
      .toThrow(/portable record.*artifact\.hostile_shape/);
    expect(() => database.observe({ plan: plan(), parameters: polluted }))
      .toThrow(/portable record.*artifact\.hostile_shape/);
    expect(database.getActiveMaintenanceCount()).toBe(0);
    expect(({} as { admin?: boolean }).admin).toBeUndefined();
    database.close();
  });

  it('pools cloned common prefixes, advances the physical DAG once, and evicts it on close', () => {
    const source = new TestSource('source:pooled', [{ id: 1, value: 'one' }, { id: 2, value: 'two' }]);
    const catalog = new AttachmentCatalog();
    let normalizationCount = 0;
    const attachmentLease = catalog.attach(relationalAttachment('attachment:pooled', source, () => { normalizationCount += 1; }));
    const dataset = new DatasetMembership({ datasetId: 'dataset:one', state: 'settled', members: [member('attachment:pooled', source.sourceId)] });
    const commonPrefix = (): QueryNode => ({
      kind: 'where',
      input: { kind: 'from', relation: { schemaView: querySchemaView, relationId: 'test.rows' }, alias: 'row' },
      predicate: { kind: 'compare', op: 'gte', left: { kind: 'field', alias: 'row', name: 'id' }, right: { kind: 'literal', value: 1 } }
    });
    const ids: QueryNode = { kind: 'select', input: commonPrefix(), alias: 'result', fields: { id: { kind: 'field', alias: 'row', name: 'id' } } };
    const values: QueryNode = { kind: 'select', input: commonPrefix(), alias: 'result', fields: { value: { kind: 'field', alias: 'row', name: 'value' } } };
    const factory = createIncrementalDatabaseQueryMaintenance();
    const database = createDatabaseView<QueryNode, QueryRecord, readonly RelationInput[]>({
      authorityScope: 'public', authorityFingerprint: 'authority:public', registryFingerprint: 'registry:one',
      attachments: catalog, datasets: [dataset], canRead: () => true, createQueryMaintenance: factory
    });
    const first = database.observe({ plan: sealPreparedPlan({ ...relationalPlan(), planId: 'query:ids', rootNodeId: 'query:ids:root', query: ids }) });
    const second = database.observe({ plan: sealPreparedPlan({ ...relationalPlan(), planId: 'query:values', rootNodeId: 'query:values:root', query: values }) });

    expect(normalizationCount).toBe(1);
    expect(database.getQueryMaintenanceDiagnostics()).toEqual([expect.objectContaining({
      runtimeIdentity: expect.stringMatching(/^cohort:\d+$/),
      activeRootCount: 2,
      physicalNodeCount: 4,
      sharedPhysicalNodeCount: 2
    })]);
    source.publish({ rows: [{ id: 2, value: 'changed' }, { id: 3, value: 'three' }] });
    expect(normalizationCount).toBe(2);
    expect(first.getSnapshot()).toMatchObject({ state: 'open', current: { rows: [{ id: 2 }, { id: 3 }] } });
    expect(second.getSnapshot()).toMatchObject({ state: 'open', current: { rows: [{ value: 'changed' }, { value: 'three' }] } });
    expect(database.getQueryMaintenanceDiagnostics()).toEqual([expect.objectContaining({
      revision: 1,
      lastUpdatedPhysicalNodeCount: 4,
      lastChangedPhysicalNodeCount: 4
    })]);

    first.close();
    expect(database.getQueryMaintenanceDiagnostics()).toEqual([expect.objectContaining({
      activeRootCount: 1,
      physicalNodeCount: 3,
      lastCollectedPhysicalNodeCount: 1
    })]);
    second.close();
    expect(database.getQueryMaintenanceDiagnostics()).toEqual([]);
    database.close();
    attachmentLease.close();
  });

  it('opens a usable private observer when observe is called during a pooled update', () => {
    const source = new TestSource('source:reentrant-observe', [{ id: 1, value: 'one' }, { id: 2, value: 'two' }]);
    const catalog = new AttachmentCatalog();
    const attachmentLease = catalog.attach(relationalAttachment('attachment:reentrant-observe', source));
    const dataset = new DatasetMembership({
      datasetId: 'dataset:one', state: 'settled', members: [member('attachment:reentrant-observe', source.sourceId)]
    });
    const callable = { id: 'urn:test:observe-during-update', version: '1', contractHash: `sha256:${'d'.repeat(64)}` } as const;
    const functionKey = callable.id + '\u0000' + callable.version + '\u0000' + callable.contractHash;
    let database: DatabaseView<QueryNode, QueryRecord>;
    let late: QueryObserver<QueryRecord> | undefined;
    let openLate = false;
    const functions = new Map([[functionKey, (args: readonly JsonValue[]) => {
      if (openLate) {
        openLate = false;
        late = database.observe({
          plan: sealPreparedPlan({ ...relationalPlan(), planId: 'query:opened-during-update', rootNodeId: 'query:opened-during-update:root' })
        });
      }
      return args[0] ?? null;
    }]]);
    database = createDatabaseView<QueryNode, QueryRecord, readonly RelationInput[]>({
      authorityScope: 'public', authorityFingerprint: 'authority:public', registryFingerprint: 'registry:one',
      attachments: catalog, datasets: [dataset], canRead: () => true,
      createQueryMaintenance: createIncrementalDatabaseQueryMaintenance(functions)
    });
    const active = database.observe({
      plan: sealPreparedPlan({
        ...relationalPlan(),
        planId: 'query:reentrant-trigger',
        rootNodeId: 'query:reentrant-trigger:root',
        query: {
          kind: 'select',
          input: { kind: 'from', relation: { schemaView: querySchemaView, relationId: 'test.rows' }, alias: 'row' },
          alias: 'result',
          fields: { value: { kind: 'call', capability: callable, args: [{ kind: 'field', alias: 'row', name: 'value' }] } }
        }
      })
    });

    openLate = true;
    source.publish({ rows: [{ id: 2, value: 'changed' }, { id: 3, value: 'three' }] });
    expect(late?.getSnapshot()).toMatchObject({
      state: 'open', current: { completeness: 'exact', rows: [{ id: 2, value: 'changed' }, { id: 3, value: 'three' }] }
    });

    source.publish({ rows: [{ id: 4, value: 'later' }] });
    expect(late?.getSnapshot()).toMatchObject({
      state: 'open', current: { completeness: 'exact', rows: [{ id: 4, value: 'later' }] }
    });
    late?.close();
    active.close();
    database.close();
    attachmentLease.close();
  });

  it('keeps first-cohort bookkeeping stable when observation reenters during attachment', () => {
    const source = new TestSource('source:reentrant-first-attach', [{ id: 2, value: 'two' }]);
    const catalog = new AttachmentCatalog();
    const attachmentLease = catalog.attach(relationalAttachment('attachment:reentrant-first-attach', source));
    const dataset = new DatasetMembership({ datasetId: 'dataset:one', state: 'settled', members: [member('attachment:reentrant-first-attach', source.sourceId)] });
    const callable = { id: 'urn:test:observe-during-first-attach', version: '1', contractHash: `sha256:${'9'.repeat(64)}` } as const;
    const functionKey = callable.id + '\u0000' + callable.version + '\u0000' + callable.contractHash;
    let database: DatabaseView<QueryNode, QueryRecord>;
    let late: QueryObserver<QueryRecord> | undefined;
    let openLate = true;
    const functions = new Map([[functionKey, (args: readonly JsonValue[]) => {
      if (openLate) {
        openLate = false;
        late = database.observe({ plan: sealPreparedPlan({ ...relationalPlan(), planId: 'query:first-attach-late', rootNodeId: 'query:first-attach-late:root' }) });
      }
      return args[0] ?? null;
    }]]);
    database = createDatabaseView<QueryNode, QueryRecord, readonly RelationInput[]>({
      authorityScope: 'public', authorityFingerprint: 'authority:public', registryFingerprint: 'registry:one',
      attachments: catalog, datasets: [dataset], canRead: () => true,
      createQueryMaintenance: createIncrementalDatabaseQueryMaintenance(functions)
    });
    const active = database.observe({
      plan: sealPreparedPlan({
        ...relationalPlan(), planId: 'query:first-attach-active', rootNodeId: 'query:first-attach-active:root',
        query: {
          kind: 'select', input: { kind: 'from', relation: { schemaView: querySchemaView, relationId: 'test.rows' }, alias: 'row' }, alias: 'result',
          fields: { value: { kind: 'call', capability: callable, args: [{ kind: 'field', alias: 'row', name: 'value' }] } }
        }
      })
    });

    expect(late?.getSnapshot()).toMatchObject({ state: 'open', current: { rows: [{ id: 2, value: 'two' }] } });
    expect(database.getQueryMaintenanceDiagnostics()).toEqual([expect.objectContaining({ activeRootCount: 1 })]);
    source.publish({ rows: [{ id: 2, value: 'two' }] });
    expect(active.getSnapshot()).toMatchObject({ state: 'open', current: { rows: [{ value: 'two' }] } });
    expect(late?.getSnapshot()).toMatchObject({ state: 'open', current: { rows: [{ id: 2, value: 'two' }] } });
    late?.close();
    active.close();
    database.close();
    attachmentLease.close();
  });

  it('reuses one relation delta across parameter cohorts, identical frames, membership changes, and reorder', () => {
    const source = new TestSource('source:parameter-frames', [{ id: 2, value: 'two' }]);
    const secondary = new TestSource('source:parameter-frames-secondary', [{ id: 3, value: 'three' }]);
    const catalog = new AttachmentCatalog();
    let normalizationCount = 0;
    const attachmentLease = catalog.attach(relationalAttachment('attachment:parameter-frames', source, () => { normalizationCount += 1; }));
    const secondaryLease = catalog.attach(relationalAttachment('attachment:parameter-frames-secondary', secondary, () => { normalizationCount += 1; }));
    const primaryMember = member('attachment:parameter-frames', source.sourceId);
    const secondaryMember = member('attachment:parameter-frames-secondary', secondary.sourceId);
    const dataset = new DatasetMembership({ datasetId: 'dataset:one', state: 'settled', members: [primaryMember, secondaryMember] });
    const database = createDatabaseView<QueryNode, QueryRecord, readonly RelationInput[]>({
      authorityScope: 'public', authorityFingerprint: 'authority:public', registryFingerprint: 'registry:one',
      attachments: catalog, datasets: [dataset], canRead: () => true,
      createQueryMaintenance: createIncrementalDatabaseQueryMaintenance()
    });
    const first = database.observe({ plan: relationalPlan(), parameters: { selected: 1 } });
    const second = database.observe({
      plan: sealPreparedPlan({ ...relationalPlan(), planId: 'query:parameter-frame-two', rootNodeId: 'query:parameter-frame-two:root' }),
      parameters: { selected: 2 }
    });
    const third = database.observe({
      plan: sealPreparedPlan({ ...relationalPlan(), planId: 'query:parameter-frame-three', rootNodeId: 'query:parameter-frame-three:root' }),
      parameters: { selected: 3 }
    });

    expect(normalizationCount).toBe(2);
    expect(database.getQueryMaintenanceReuseDiagnostics()).toEqual({ computedFrameDeltaCount: 0, reusedFrameDeltaCount: 0 });
    source.publish({ rows: [{ id: 2, value: 'changed' }] });
    expect(database.getQueryMaintenanceReuseDiagnostics()).toEqual({ computedFrameDeltaCount: 1, reusedFrameDeltaCount: 2 });

    // A distinct capture with identical portable input is still a fresh,
    // reusable frame transition.
    source.notify();
    expect(database.getQueryMaintenanceReuseDiagnostics()).toEqual({ computedFrameDeltaCount: 1, reusedFrameDeltaCount: 2 });

    dataset.replaceMembers([secondaryMember, primaryMember], 'settled');
    // Membership is canonicalized, so a pure declaration reorder is a no-op.
    expect(database.getQueryMaintenanceReuseDiagnostics()).toEqual({ computedFrameDeltaCount: 1, reusedFrameDeltaCount: 2 });
    dataset.replaceMembers([primaryMember], 'settled');
    expect(database.getQueryMaintenanceReuseDiagnostics()).toEqual({ computedFrameDeltaCount: 2, reusedFrameDeltaCount: 4 });
    for (const observer of [first, second, third]) {
      expect(observer.getSnapshot()).toMatchObject({ state: 'open', current: { rows: [{ id: 2, value: 'changed' }], completeness: 'exact' } });
    }
    first.close();
    second.close();
    third.close();
    database.close();
    attachmentLease.close();
    secondaryLease.close();
  });

  it('bounds live-frame parameter snapshots with deterministic LRU eviction while sessions remain correct', () => {
    const source = new TestSource('source:parameter-lru', [{ id: 2, value: 'initial' }]);
    const catalog = new AttachmentCatalog();
    const attachmentLease = catalog.attach(relationalAttachment('attachment:parameter-lru', source));
    const dataset = new DatasetMembership({ datasetId: 'dataset:one', state: 'settled', members: [member('attachment:parameter-lru', source.sourceId)] });
    const database = createDatabaseView<QueryNode, QueryRecord, readonly RelationInput[]>({
      authorityScope: 'public', authorityFingerprint: 'authority:public', registryFingerprint: 'registry:one',
      attachments: catalog, datasets: [dataset], canRead: () => true,
      createQueryMaintenance: createIncrementalDatabaseQueryMaintenance()
    });
    const observe = (cohort: number, suffix: string) => database.observe({
      plan: sealPreparedPlan({ ...relationalPlan(), planId: `query:parameter-lru:${suffix}`, rootNodeId: `query:parameter-lru:${suffix}:root` }),
      parameters: { cohort }
    });
    const observers = Array.from({ length: 256 }, (_, index) => observe(index, String(index)));
    // Refresh key zero, then insert a new key. Deterministic Map-order LRU
    // eviction removes key one; requesting it again must safely recompute.
    const refreshed = observe(0, 'refresh-zero');
    const overflow = observe(256, 'overflow');
    const recomputed = observe(1, 'recomputed-one');

    expect(refreshed.getSnapshot()).toMatchObject({ state: 'open', current: { rows: [{ id: 2, value: 'initial' }] } });
    expect(recomputed.getSnapshot()).toMatchObject({ state: 'open', current: { rows: [{ id: 2, value: 'initial' }] } });
    source.publish({ rows: [{ id: 2, value: 'changed' }] });
    for (const observer of [observers[0], observers[1], observers[255], refreshed, overflow, recomputed]) {
      expect(observer?.getSnapshot()).toMatchObject({ state: 'open', current: { rows: [{ id: 2, value: 'changed' }] } });
    }

    observers.forEach((observer) => observer.close());
    refreshed.close();
    overflow.close();
    recomputed.close();
    database.close();
    attachmentLease.close();
  });

  it('detaches a reused relation delta from source-owned nested row values', () => {
    const source = new TestSource('source:parameter-detached-delta', [{ id: 2, value: 'initial' }]);
    const catalog = new AttachmentCatalog();
    const attachmentLease = catalog.attach(relationalAttachment('attachment:parameter-detached-delta', source));
    const dataset = new DatasetMembership({
      datasetId: 'dataset:one', state: 'settled', members: [member('attachment:parameter-detached-delta', source.sourceId)]
    });
    const callable = { id: 'urn:test:mutate-source-after-delta', version: '1', contractHash: `sha256:${'7'.repeat(64)}` } as const;
    const functionKey = callable.id + '\u0000' + callable.version + '\u0000' + callable.contractHash;
    const nextPayload = { label: 'detached' };
    let mutateDuringUpdate = false;
    const functions = new Map([[functionKey, (args: readonly JsonValue[]) => {
      if (mutateDuringUpdate) {
        mutateDuringUpdate = false;
        nextPayload.label = 'mutated-by-first-cohort';
      }
      return args[0] ?? null;
    }]]);
    const mutatingPlan = sealPreparedPlan<QueryNode>({
      ...relationalPlan(), planId: 'query:parameter-detached-mutating', rootNodeId: 'query:parameter-detached-mutating:root',
      query: {
        kind: 'select', input: { kind: 'from', relation: { schemaView: querySchemaView, relationId: 'test.rows' }, alias: 'row' }, alias: 'result',
        fields: { value: { kind: 'call', capability: callable, args: [{ kind: 'field', alias: 'row', name: 'value' }] } }
      }
    });
    const database = createDatabaseView<QueryNode, QueryRecord, readonly RelationInput[]>({
      authorityScope: 'public', authorityFingerprint: 'authority:public', registryFingerprint: 'registry:one',
      attachments: catalog, datasets: [dataset], canRead: () => true,
      createQueryMaintenance: createIncrementalDatabaseQueryMaintenance(functions)
    });
    // Capture consumers retain registration order, so the mutating cohort is
    // the first physical application and the reader consumes the cached delta.
    const first = database.observe({ plan: mutatingPlan, parameters: { cohort: 1 } });
    const second = database.observe({
      plan: sealPreparedPlan({ ...relationalPlan(), planId: 'query:parameter-detached-reader', rootNodeId: 'query:parameter-detached-reader:root' }),
      parameters: { cohort: 2 }
    });

    mutateDuringUpdate = true;
    source.publish({ rows: [{ id: 2, value: nextPayload } as unknown as Row] });

    expect(nextPayload.label).toBe('mutated-by-first-cohort');
    expect(database.getQueryMaintenanceReuseDiagnostics()).toEqual({ computedFrameDeltaCount: 1, reusedFrameDeltaCount: 1 });
    expect(second.getSnapshot()).toMatchObject({
      state: 'open', current: { rows: [{ id: 2, value: { label: 'detached' } }], completeness: 'exact' }
    });
    first.close();
    second.close();
    database.close();
    attachmentLease.close();
  });

  it('adopts occurrence identity once before parameter cohorts reuse an accepted frame delta', () => {
    const source = new TestSource('source:parameter-rejected-delta', [{ id: 2, value: 'accepted' }]);
    const catalog = new AttachmentCatalog();
    let rejectAcceptedIdentity = false;
    let acceptedIdentityReads = 0;
    const attachmentId = 'attachment:parameter-rejected-delta';
    const attachmentLease = catalog.attach({
      ...relationalAttachment(attachmentId, source),
      preparation: prepareManualReadOnlyAttachment({
        schemaViewIds: [querySchemaView.id],
        project: (snapshot: SourceSnapshot<{ readonly rows: readonly Row[] }>) => {
          if (snapshot.storage === undefined) return { state: snapshot.state === 'ready' ? 'failed' as const : snapshot.state, issues: [] };
          const occurrenceIds = snapshot.storage.rows.map(({ id }) => 'row:' + id);
          const observedIds = snapshot.storage.rows[0]?.id === 2
            ? new Proxy(occurrenceIds, {
                get: (target, property, receiver) => {
                  if (property === '0' && rejectAcceptedIdentity) {
                    acceptedIdentityReads += 1;
                    if (acceptedIdentityReads % 3 === 0) return 'row:stale';
                  }
                  return Reflect.get(target, property, receiver);
                }
              })
            : occurrenceIds;
          return { state: 'ready' as const, value: [{
            relation: { schemaView: querySchemaView, relationId: 'test.rows' },
            rows: snapshot.storage.rows, occurrenceIds: observedIds, completeness: 'exact' as const,
            sourceId: source.sourceId, attachmentId, basis: snapshot.basis
          }], issues: [] };
        }
      })
    });
    const dataset = new DatasetMembership({
      datasetId: 'dataset:one', state: 'settled', members: [member('attachment:parameter-rejected-delta', source.sourceId)]
    });
    const database = createDatabaseView<QueryNode, QueryRecord, readonly RelationInput[]>({
      authorityScope: 'public', authorityFingerprint: 'authority:public', registryFingerprint: 'registry:one',
      attachments: catalog, datasets: [dataset], canRead: () => true,
      createQueryMaintenance: createIncrementalDatabaseQueryMaintenance()
    });
    const first = database.observe({ plan: relationalPlan(), parameters: { cohort: 1 } });
    const second = database.observe({
      plan: sealPreparedPlan({ ...relationalPlan(), planId: 'query:parameter-rejected-delta-two', rootNodeId: 'query:parameter-rejected-delta-two:root' }),
      parameters: { cohort: 2 }
    });
    rejectAcceptedIdentity = true;
    source.publish({ rows: [{ id: 9, value: 'rejected' }] });
    expect(acceptedIdentityReads).toBe(0);
    expect(database.getQueryMaintenanceReuseDiagnostics()).toEqual({ computedFrameDeltaCount: 1, reusedFrameDeltaCount: 1 });
    expect(first.getSnapshot()).toMatchObject({ state: 'open', current: { rows: [{ id: 9, value: 'rejected' }], completeness: 'exact' } });
    expect(second.getSnapshot()).toMatchObject({ state: 'open', current: { rows: [{ id: 9, value: 'rejected' }], completeness: 'exact' } });

    rejectAcceptedIdentity = false;
    source.publish({ rows: [{ id: 4, value: 'recovered' }] });
    expect(database.getQueryMaintenanceReuseDiagnostics()).toEqual({ computedFrameDeltaCount: 2, reusedFrameDeltaCount: 2 });
    for (const observer of [first, second]) expect(observer.getSnapshot()).toMatchObject({
      state: 'open', current: { rows: [{ id: 4, value: 'recovered' }], completeness: 'exact' }
    });
    first.close();
    second.close();
    database.close();
    attachmentLease.close();
  });

  it('rejects accessor-backed occurrence identity without invoking it and recovers on the next frame', () => {
    const source = new TestSource('source:occurrence-accessor', [{ id: 2, value: 'initial' }]);
    const catalog = new AttachmentCatalog();
    let hostile = false;
    let getterCalls = 0;
    const attachmentId = 'attachment:occurrence-accessor';
    const attachmentLease = catalog.attach({
      ...relationalAttachment(attachmentId, source),
      preparation: prepareManualReadOnlyAttachment({
        schemaViewIds: [querySchemaView.id],
        project: (snapshot: SourceSnapshot<{ readonly rows: readonly Row[] }>) => {
          if (snapshot.storage === undefined) return { state: snapshot.state === 'ready' ? 'failed' as const : snapshot.state, issues: [] };
          const occurrenceIds = snapshot.storage.rows.map(({ id }) => 'row:' + id);
          if (hostile) Object.defineProperty(occurrenceIds, '0', {
            enumerable: true,
            configurable: true,
            get: () => { getterCalls += 1; return 'row:hostile'; }
          });
          return { state: 'ready' as const, value: [{
            relation: { schemaView: querySchemaView, relationId: 'test.rows' }, rows: snapshot.storage.rows,
            occurrenceIds, completeness: 'exact' as const, sourceId: source.sourceId, attachmentId, basis: snapshot.basis
          }], issues: [] };
        }
      })
    });
    const dataset = new DatasetMembership({ datasetId: 'dataset:one', state: 'settled', members: [member(attachmentId, source.sourceId)] });
    const database = createDatabaseView<QueryNode, QueryRecord, readonly RelationInput[]>({
      authorityScope: 'public', authorityFingerprint: 'authority:public', registryFingerprint: 'registry:one',
      attachments: catalog, datasets: [dataset], canRead: () => true, createQueryMaintenance: createIncrementalDatabaseQueryMaintenance()
    });
    const observer = database.observe({ plan: relationalPlan() });

    hostile = true;
    source.publish({ rows: [{ id: 2, value: 'hostile' }] });
    expect(getterCalls).toBe(0);
    expect(observer.getSnapshot()).toMatchObject({ state: 'open', current: { rows: [], completeness: 'unknown' } });

    hostile = false;
    source.publish({ rows: [{ id: 3, value: 'recovered' }] });
    expect(observer.getSnapshot()).toMatchObject({ state: 'open', current: { rows: [{ id: 3, value: 'recovered' }], completeness: 'exact' } });
    observer.close();
    database.close();
    attachmentLease.close();
  });

  it('safely closes the last pooled observer from a query function during update', () => {
    const source = new TestSource('source:self-closing-query', [{ id: 1, value: 'one' }]);
    const catalog = new AttachmentCatalog();
    const attachmentLease = catalog.attach(relationalAttachment('attachment:self-closing-query', source));
    const dataset = new DatasetMembership({ datasetId: 'dataset:one', state: 'settled', members: [member('attachment:self-closing-query', source.sourceId)] });
    const callable = { id: 'urn:test:self-closing-query', version: '1', contractHash: `sha256:${'c'.repeat(64)}` } as const;
    const functionKey = callable.id + '\u0000' + callable.version + '\u0000' + callable.contractHash;
    let closeDuringCall = false;
    let closeObserver = (): void => undefined;
    const functions = new Map([[functionKey, (args: readonly JsonValue[]) => {
      if (closeDuringCall) {
        closeDuringCall = false;
        closeObserver();
      }
      return args[0] ?? null;
    }]]);
    const query: QueryNode = {
      kind: 'select',
      input: { kind: 'from', relation: { schemaView: querySchemaView, relationId: 'test.rows' }, alias: 'row' },
      alias: 'result',
      fields: { value: { kind: 'call', capability: callable, args: [{ kind: 'field', alias: 'row', name: 'value' }] } }
    };
    const database = createDatabaseView<QueryNode, QueryRecord, readonly RelationInput[]>({
      authorityScope: 'public', authorityFingerprint: 'authority:public', registryFingerprint: 'registry:one',
      attachments: catalog, datasets: [dataset], canRead: () => true,
      createQueryMaintenance: createIncrementalDatabaseQueryMaintenance(functions)
    });
    const observer = database.observe({ plan: sealPreparedPlan({ ...relationalPlan(), planId: 'query:self-closing', rootNodeId: 'query:self-closing:root', query }) });
    closeObserver = () => observer.close();
    closeDuringCall = true;

    expect(() => source.publish({ rows: [{ id: 2, value: 'two' }] })).not.toThrow();
    expect(observer.getSnapshot()).toEqual({ state: 'closed' });
    expect(database.getActiveMaintenanceCount()).toBe(0);
    expect(database.getQueryMaintenanceDiagnostics()).toEqual([]);
    expect(source.listenerCount()).toBe(0);
    database.close();
    attachmentLease.close();
  });

  it('detaches projected getter values before maintaining sibling and late roots', () => {
    const source = new TestSource('source:cohort-transition-failure', [{ id: 2, value: 'initial' }]);
    const catalog = new AttachmentCatalog();
    const attachmentLease = catalog.attach(relationalAttachment('attachment:cohort-transition-failure', source));
    const dataset = new DatasetMembership({ datasetId: 'dataset:one', state: 'settled', members: [member('attachment:cohort-transition-failure', source.sourceId)] });
    const failingQuery: QueryNode = {
      kind: 'select', input: { kind: 'from', relation: { schemaView: querySchemaView, relationId: 'test.rows' }, alias: 'row' }, alias: 'result',
      fields: { value: { kind: 'field', alias: 'row', name: 'value' } }
    };
    const database = createDatabaseView<QueryNode, QueryRecord, readonly RelationInput[]>({
      authorityScope: 'public', authorityFingerprint: 'authority:public', registryFingerprint: 'registry:one',
      attachments: catalog, datasets: [dataset], canRead: () => true,
      createQueryMaintenance: createIncrementalDatabaseQueryMaintenance()
    });
    const failing = database.observe({ plan: sealPreparedPlan({ ...relationalPlan(), planId: 'query:cohort-failing', rootNodeId: 'query:cohort-failing:root', query: failingQuery }) });
    const sibling = database.observe({ plan: sealPreparedPlan({ ...relationalPlan(), planId: 'query:cohort-sibling', rootNodeId: 'query:cohort-sibling:root' }) });

    let valueReads = 0;
    const transientRow: Row = { id: 3, get value() {
      valueReads += 1;
      return 'detached-frame';
    } };
    source.publish({ rows: [transientRow] });
    const late = database.observe({ plan: sealPreparedPlan({ ...relationalPlan(), planId: 'query:cohort-late', rootNodeId: 'query:cohort-late:root' }) });
    expect(valueReads).toBeGreaterThan(0);
    expect(failing.getSnapshot()).toMatchObject({ state: 'open', current: { rows: [{ value: 'detached-frame' }], completeness: 'exact' } });
    for (const observer of [sibling, late]) expect(observer.getSnapshot()).toMatchObject({
      state: 'open', current: { rows: [{ id: 3, value: 'detached-frame' }], completeness: 'exact' }
    });

    source.notify();
    expect(failing.getSnapshot()).toMatchObject({ state: 'open', current: { rows: [{ value: 'detached-frame' }], completeness: 'exact' } });
    expect(sibling.getSnapshot()).toMatchObject({ state: 'open', current: { rows: [{ id: 3, value: 'detached-frame' }], completeness: 'exact' } });
    expect(late.getSnapshot()).toMatchObject({ state: 'open', current: { rows: [{ id: 3, value: 'detached-frame' }], completeness: 'exact' } });

    source.publish({ rows: [{ id: 2, value: 'initial' }] });
    expect(failing.getSnapshot()).toMatchObject({ state: 'open', current: { rows: [{ value: 'initial' }], completeness: 'exact' } });
    expect(sibling.getSnapshot()).toMatchObject({ state: 'open', current: { rows: [{ id: 2, value: 'initial' }], completeness: 'exact' } });
    expect(late.getSnapshot()).toMatchObject({ state: 'open', current: { rows: [{ id: 2, value: 'initial' }], completeness: 'exact' } });

    source.publish({ rows: [{ id: 4, value: 'recovered-frame' }] });
    expect(failing.getSnapshot()).toMatchObject({ state: 'open', current: { rows: [{ value: 'recovered-frame' }], completeness: 'exact' } });
    expect(sibling.getSnapshot()).toMatchObject({ state: 'open', current: { rows: [{ id: 4, value: 'recovered-frame' }], completeness: 'exact' } });
    expect(late.getSnapshot()).toMatchObject({ state: 'open', current: { rows: [{ id: 4, value: 'recovered-frame' }], completeness: 'exact' } });
    failing.close();
    sibling.close();
    late.close();
    database.close();
    attachmentLease.close();
  });

  it('isolates pooled maintenance by full parameters and dataset runtime', () => {
    const source = new TestSource('source:isolated', [{ id: 1, value: 'one' }]);
    const catalog = new AttachmentCatalog();
    const attachmentLease = catalog.attach(relationalAttachment('attachment:isolated', source));
    const firstDataset = new DatasetMembership({ datasetId: 'dataset:one', state: 'settled', members: [member('attachment:isolated', source.sourceId)] });
    const secondDataset = new DatasetMembership({ datasetId: 'dataset:two', state: 'settled', members: [member('attachment:isolated', source.sourceId)] });
    const database = createDatabaseView<QueryNode, QueryRecord, readonly RelationInput[]>({
      authorityScope: 'public', authorityFingerprint: 'authority:public', registryFingerprint: 'registry:one',
      attachments: catalog, datasets: [firstDataset, secondDataset], canRead: () => true,
      createQueryMaintenance: createIncrementalDatabaseQueryMaintenance()
    });
    const first = database.observe({ plan: relationalPlan(), parameters: { selected: 1 } });
    const second = database.observe({ plan: sealPreparedPlan({ ...relationalPlan(), planId: 'query:param-two', rootNodeId: 'query:param-two:root' }), parameters: { selected: 2 } });
    const third = database.observe({ plan: sealPreparedPlan({ ...relationalPlan(), planId: 'query:dataset-two', rootNodeId: 'query:dataset-two:root', datasetId: 'dataset:two' }), parameters: { selected: 1 } });

    const diagnostics = database.getQueryMaintenanceDiagnostics();
    expect(diagnostics).toHaveLength(3);
    expect(diagnostics.map(({ runtimeIdentity }) => runtimeIdentity)).toEqual([
      expect.stringMatching(/^cohort:\d+$/), expect.stringMatching(/^cohort:\d+$/), expect.stringMatching(/^cohort:\d+$/)
    ]);
    expect(new Set(diagnostics.map(({ runtimeIdentity }) => runtimeIdentity)).size).toBe(3);
    expect(diagnostics.every(({ activeRootCount, physicalNodeCount }) => activeRootCount === 1 && physicalNodeCount === 2)).toBe(true);

    first.close();
    second.close();
    third.close();
    database.close();
    attachmentLease.close();
  });

  it('keeps excluded query graphs on private maintenance sessions', () => {
    const source = new TestSource('source:private', [{ id: 1, value: 'one' }]);
    const catalog = new AttachmentCatalog();
    const attachmentLease = catalog.attach(relationalAttachment('attachment:private', source));
    const dataset = new DatasetMembership({ datasetId: 'dataset:one', state: 'settled', members: [member('attachment:private', source.sourceId)] });
    const query: QueryNode = {
      kind: 'where',
      input: { kind: 'from', relation: { schemaView: querySchemaView, relationId: 'test.rows' }, alias: 'row' },
      predicate: { kind: 'subquery', mode: 'exists', query: { kind: 'values', alias: 'constant', rows: [{ value: true }] } }
    };
    const database = createDatabaseView<QueryNode, QueryRecord, readonly RelationInput[]>({
      authorityScope: 'public', authorityFingerprint: 'authority:public', registryFingerprint: 'registry:one',
      attachments: catalog, datasets: [dataset], canRead: () => true,
      createQueryMaintenance: createIncrementalDatabaseQueryMaintenance()
    });
    const observer = database.observe({ plan: sealPreparedPlan({ ...relationalPlan(), planId: 'query:subquery', rootNodeId: 'query:subquery:root', query }) });
    expect(observer.getSnapshot()).toMatchObject({ state: 'open', current: { rows: [{ id: 1, value: 'one' }] } });
    expect(database.getQueryMaintenanceDiagnostics()).toEqual([]);

    source.publish({ rows: [{ id: 2, value: 'two' }] });
    expect(observer.getSnapshot()).toMatchObject({ state: 'open', current: { rows: [{ id: 2, value: 'two' }] } });
    observer.close();
    database.close();
    attachmentLease.close();
  });

  it('shares physical maintenance across allowPartial policy variants', () => {
    const source = new TestSource('source:partial', [{ id: 2, value: 'proven' }]);
    const catalog = new AttachmentCatalog();
    const partialAttachment: DatabaseAttachmentInput<{ readonly rows: readonly Row[] }, readonly RelationInput[]> = {
      attachmentId: 'attachment:partial', incarnation: 'attachment:partial:one', sourceId: source.sourceId, source,
      authorityScope: 'public', discoveryEdges: ['edge:attachment:partial'],
      preparation: prepareManualReadOnlyAttachment({
        schemaViewIds: [querySchemaView.id],
        project: (snapshot) => snapshot.storage === undefined
          ? { state: snapshot.state === 'ready' ? 'failed' : snapshot.state, issues: [] }
          : {
              state: 'ready',
              value: [{
                relation: { schemaView: querySchemaView, relationId: 'test.rows' },
                rows: snapshot.storage.rows,
                occurrenceIds: snapshot.storage.rows.map(({ id }) => 'row:' + id),
                completeness: 'lower-bound', sourceId: source.sourceId,
                attachmentId: 'attachment:partial', basis: snapshot.basis
              }],
              issues: []
            }
      })
    };
    const attachmentLease = catalog.attach(partialAttachment);
    const dataset = new DatasetMembership({ state: 'open', datasetId: 'dataset:one', members: [member('attachment:partial', source.sourceId)] });
    const database = createDatabaseView<QueryNode, QueryRecord, readonly RelationInput[]>({
      authorityScope: 'public', authorityFingerprint: 'authority:public', registryFingerprint: 'registry:one',
      attachments: catalog, datasets: [dataset], canRead: () => true,
      createQueryMaintenance: createIncrementalDatabaseQueryMaintenance()
    });
    const conservative = database.observe({ plan: relationalPlan() });
    const partial = database.observe({ plan: relationalPlan(), allowPartial: true });

    expect(conservative.getSnapshot()).toMatchObject({ state: 'open', current: { rows: [], completeness: 'unknown' } });
    expect(partial.getSnapshot()).toMatchObject({ state: 'open', current: { rows: [{ id: 2, value: 'proven' }], completeness: 'lower-bound' } });
    expect(database.getQueryMaintenanceDiagnostics()).toEqual([expect.objectContaining({
      activeRootCount: 2,
      physicalNodeCount: 2,
      sharedPhysicalNodeCount: 2
    })]);

    conservative.close();
    partial.close();
    database.close();
    attachmentLease.close();
  });

  it('keeps direct factory sessions private without database capture metadata', () => {
    const source = new TestSource('source:divergent', [{ id: 2, value: 'two' }]);
    const catalog = new AttachmentCatalog();
    const attachmentLease = catalog.attach(relationalAttachment('attachment:divergent', source));
    const dataset = new DatasetMembership({ datasetId: 'dataset:one', state: 'settled', members: [member('attachment:divergent', source.sourceId)] });
    const input = (row: Row): DatabaseQueryMaintenanceInput<QueryNode, readonly RelationInput[]> => ({
      query: relationalPlan().query,
      parameters: {},
      dataset: dataset.snapshot(),
      attachments: [{
        member: member('attachment:divergent', source.sourceId),
        attachment: attachmentLease.attachment as unknown as DatabaseAttachment<unknown, readonly RelationInput[]>,
        snapshot: source.snapshot(),
        projection: [{
          relation: { schemaView: querySchemaView, relationId: 'test.rows' },
          rows: [row], occurrenceIds: ['row:' + row.id], completeness: 'exact',
          sourceId: source.sourceId, attachmentId: 'attachment:divergent', basis: source.snapshot().basis
        }]
      }]
    });
    const factory = createIncrementalDatabaseQueryMaintenance();
    const first = factory({ plan: relationalPlan(), initialInput: input({ id: 2, value: 'two' }) });
    const second = factory({
      plan: sealPreparedPlan({ ...relationalPlan(), planId: 'query:divergent', rootNodeId: 'query:divergent:root' }),
      initialInput: input({ id: 9, value: 'private' })
    });

    expect(first.getCurrentResult().rows).toEqual([{ id: 2, value: 'two' }]);
    expect(second.getCurrentResult().rows).toEqual([{ id: 9, value: 'private' }]);
    expect(() => first.updateInput({ ...input({ id: 2, value: 'two' }), parameters: { changed: true } })).toThrow('parameters, functions, and execution budget are fixed');
    const hostile = { id: 2 } as Row;
    Object.defineProperty(hostile, 'value', { enumerable: true, get: () => { throw new Error('next row failed'); } });
    expect(() => first.updateInput(input(hostile))).toThrow('next row failed');
    expect(first.updateInput(input({ id: 2, value: 'two' })).rows).toEqual([{ id: 2, value: 'two' }]);
    second.close();
    first.close();
    attachmentLease.close();
  });

  it('isolates and recovers malformed direct factory input', () => {
    const original: Row = { id: 2, value: 'accepted' };
    const acceptedRows: Row[] = [original];
    const source = new TestSource('source:rejected-recovery', acceptedRows);
    const catalog = new AttachmentCatalog();
    const attachmentLease = catalog.attach(relationalAttachment('attachment:rejected-recovery', source));
    const dataset = new DatasetMembership({ datasetId: 'dataset:one', state: 'settled', members: [member('attachment:rejected-recovery', source.sourceId)] });
    const input = (rows: readonly Row[], occurrenceIds: readonly string[] = ['row:stable']): DatabaseQueryMaintenanceInput<QueryNode, readonly RelationInput[]> => ({
      query: relationalPlan().query,
      parameters: {},
      dataset: dataset.snapshot(),
      attachments: [{
        member: member('attachment:rejected-recovery', source.sourceId),
        attachment: attachmentLease.attachment as unknown as DatabaseAttachment<unknown, readonly RelationInput[]>,
        snapshot: source.snapshot(),
        projection: [{
          relation: { schemaView: querySchemaView, relationId: 'test.rows' },
          rows, occurrenceIds, completeness: 'exact',
          sourceId: source.sourceId, attachmentId: 'attachment:rejected-recovery', basis: source.snapshot().basis
        }]
      }]
    });
    const factory = createIncrementalDatabaseQueryMaintenance();
    const first = factory({ plan: relationalPlan(), initialInput: input(acceptedRows, []) });
    const second = factory({
      plan: sealPreparedPlan({ ...relationalPlan(), planId: 'query:recovery-second', rootNodeId: 'query:recovery-second:root' }),
      initialInput: input(acceptedRows)
    });
    expect(first.getCurrentResult()).toMatchObject({ completeness: 'unknown' });
    expect(second.getCurrentResult()).toMatchObject({ rows: [original], completeness: 'exact' });

    expect(() => first.updateInput({ ...input(acceptedRows), parameters: { changed: true } })).toThrow('parameters, functions, and execution budget are fixed');
    expect(first.getCurrentResult()).toMatchObject({ completeness: 'unknown' });
    expect(first.updateInput(input(acceptedRows))).toMatchObject({ rows: [original], completeness: 'exact' });
    expect(second.getCurrentResult()).toMatchObject({ rows: [original], completeness: 'exact' });
    first.close();
    second.close();
    attachmentLease.close();
  });

  it('recovers a malformed late private root with fixed session parameters', () => {
    const accepted = [{ id: 2, value: 'accepted' }];
    const source = new TestSource('source:late-rejected', accepted);
    const catalog = new AttachmentCatalog();
    const attachmentLease = catalog.attach(relationalAttachment('attachment:late-rejected', source));
    const dataset = new DatasetMembership({ datasetId: 'dataset:one', state: 'settled', members: [member('attachment:late-rejected', source.sourceId)] });
    const database = createDatabaseView<QueryNode, QueryRecord, readonly RelationInput[]>({
      authorityScope: 'public', authorityFingerprint: 'authority:public', registryFingerprint: 'registry:one',
      attachments: catalog, datasets: [dataset], canRead: () => true,
      createQueryMaintenance: createIncrementalDatabaseQueryMaintenance()
    });
    const first = database.observe({ plan: relationalPlan() });
    source.publish({ rows: [{ id: 9, value: 'duplicate-a' }, { id: 9, value: 'duplicate-b' }] });
    expect(first.getSnapshot()).toMatchObject({ state: 'open', current: { completeness: 'unknown' } });

    const late = database.observe({ plan: sealPreparedPlan({ ...relationalPlan(), planId: 'query:late-rejected', rootNodeId: 'query:late-rejected:root' }) });
    expect(late.getSnapshot()).toMatchObject({ state: 'open', current: { completeness: 'unknown' } });
    expect(database.getQueryMaintenanceDiagnostics()).toEqual([expect.objectContaining({ activeRootCount: 1 })]);

    source.publish({ rows: accepted });
    expect(first.getSnapshot()).toMatchObject({ state: 'open', current: { rows: accepted, completeness: 'exact' } });
    expect(late.getSnapshot()).toMatchObject({ state: 'open', current: { rows: accepted, completeness: 'exact' } });
    first.close();
    late.close();
    database.close();
    attachmentLease.close();
  });

  it('keeps an initially malformed frame private so it can recover', () => {
    const source = new TestSource('source:initially-malformed', [
      { id: 9, value: 'duplicate-a' },
      { id: 9, value: 'duplicate-b' }
    ]);
    const catalog = new AttachmentCatalog();
    const attachmentLease = catalog.attach(relationalAttachment('attachment:initially-malformed', source));
    const dataset = new DatasetMembership({
      datasetId: 'dataset:one', state: 'settled', members: [member('attachment:initially-malformed', source.sourceId)]
    });
    const database = createDatabaseView<QueryNode, QueryRecord, readonly RelationInput[]>({
      authorityScope: 'public', authorityFingerprint: 'authority:public', registryFingerprint: 'registry:one',
      attachments: catalog, datasets: [dataset], canRead: () => true,
      createQueryMaintenance: createIncrementalDatabaseQueryMaintenance()
    });
    const observer = database.observe({ plan: relationalPlan() });

    expect(observer.getSnapshot()).toMatchObject({ state: 'open', current: { rows: [], completeness: 'unknown' } });
    expect(database.getQueryMaintenanceDiagnostics()).toEqual([]);
    source.publish({ rows: [{ id: 2, value: 'recovered' }] });
    expect(observer.getSnapshot()).toMatchObject({ state: 'open', current: {
      rows: [{ id: 2, value: 'recovered' }], completeness: 'exact'
    } });
    observer.close();
    database.close();
    attachmentLease.close();
  });

  it('unions the same relation from two real attachments with source provenance', () => {
    const personal = new TestSource('source:personal', [{ id: 1, value: 'personal' }]);
    const shared = new TestSource('source:shared', [{ id: 1, value: 'shared' }]);
    const catalog = new AttachmentCatalog();
    const personalLease = catalog.attach(relationalAttachment('attachment:personal', personal));
    const sharedLease = catalog.attach(relationalAttachment('attachment:shared', shared));
    const dataset = new DatasetMembership({
      datasetId: 'dataset:one',
      state: 'settled',
      members: [member('attachment:personal', personal.sourceId), member('attachment:shared', shared.sourceId)]
    });
    const query: QueryNode = {
      kind: 'select',
      alias: 'result',
      input: { kind: 'from', relation: { schemaView: querySchemaView, relationId: 'test.rows' }, alias: 'row' },
      fields: {
        id: { kind: 'field', alias: 'row', name: 'id' },
        value: { kind: 'field', alias: 'row', name: 'value' },
        source: { kind: 'source-of', alias: 'row' }
      }
    };
    const database = createDatabaseView<QueryNode, QueryRecord, readonly RelationInput[]>({
      authorityScope: 'public',
      authorityFingerprint: 'authority:public',
      registryFingerprint: 'registry:one',
      attachments: catalog,
      datasets: [dataset],
      canRead: () => true,
      createQueryMaintenance: createIncrementalDatabaseQueryMaintenance()
    });
    const observer = database.observe({ plan: sealPreparedPlan({ ...relationalPlan(), query }) });
    const initial = observer.getSnapshot();
    expect(initial).toMatchObject({ state: 'open', current: { rows: [
      { id: 1, value: 'personal', source: 'source:personal' },
      { id: 1, value: 'shared', source: 'source:shared' }
    ] } });
    const initialKeys = initial.state === 'open' ? initial.current.resultKeys : [];
    expect(new Set(initialKeys).size).toBe(2);

    shared.publish({ rows: [{ id: 1, value: 'shared updated' }] });
    const updated = observer.getSnapshot();
    expect(updated).toMatchObject({ state: 'open', current: { rows: [
      { id: 1, value: 'personal', source: 'source:personal' },
      { id: 1, value: 'shared updated', source: 'source:shared' }
    ], resultKeys: initialKeys } });

    dataset.replaceMembers([member('attachment:personal', personal.sourceId)], 'settled');
    expect(observer.getSnapshot()).toMatchObject({ state: 'open', current: {
      rows: [{ id: 1, value: 'personal', source: 'source:personal' }],
      resultKeys: [initialKeys[0]]
    } });

    observer.close();
    database.close();
    sharedLease.close();
    personalLease.close();
  });

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

  it('captures one source snapshot for multiple authorized attachments', () => {
    const source = new TestSource('source:shared-capture', [{ id: 1, value: 'one' }]);
    const catalog = new AttachmentCatalog();
    const firstLease = catalog.attach(attachment('attachment:first', source));
    const secondLease = catalog.attach(attachment('attachment:second', source));
    const dataset = new DatasetMembership({
      datasetId: 'dataset:one',
      state: 'settled',
      members: [member('attachment:first', source.sourceId), member('attachment:second', source.sourceId)]
    });
    const database = view(catalog, [dataset]);
    const observer = database.observe({ plan: plan() });

    expect(source.snapshotCount()).toBe(1);
    expect(observer.getSnapshot()).toMatchObject({ state: 'open', current: { rows: [{ id: 1 }, { id: 1 }] } });
    observer.close();
    database.close();
    secondLease.close();
    firstLease.close();
  });

  it('turns one optional projection failure into evidence without starving healthy attachments', () => {
    const healthySource = new TestSource('source:healthy-projection', [{ id: 1, value: 'healthy' }]);
    const failingSource = new TestSource('source:failing-projection', [{ id: 2, value: 'bad' }]);
    const catalog = new AttachmentCatalog();
    const healthyLease = catalog.attach(attachment('attachment:healthy-projection', healthySource));
    const failingInput = attachment('attachment:failing-projection', failingSource);
    const failingLease = catalog.attach({
      ...failingInput,
      preparation: prepareManualReadOnlyAttachment({
        schemaViewIds: ['schema:rows'],
        project: () => { throw new Error('projection failed'); }
      })
    });
    const dataset = new DatasetMembership({
      datasetId: 'dataset:one', state: 'settled',
      members: [member('attachment:failing-projection', failingSource.sourceId, 'optional'), member('attachment:healthy-projection', healthySource.sourceId)]
    });
    const database = view(catalog, [dataset]);
    const observer = database.observe({ plan: plan() });

    expect(observer.getSnapshot()).toMatchObject({ state: 'open', current: {
      readiness: 'ready', rows: [{ id: 1, value: 'healthy' }], completeness: 'exact',
      sourceStates: expect.arrayContaining([expect.objectContaining({ attachmentId: 'attachment:failing-projection', state: 'failed' })]),
      issues: expect.arrayContaining([expect.objectContaining({ code: 'observer.evaluation_failed', details: expect.objectContaining({ reason: 'attachment_projection_failed' }) })])
    } });
    observer.close();
    database.close();
    failingLease.close();
    healthyLease.close();
  });

  it('classifies a required ready-source projection failure as invalid', () => {
    const source = new TestSource('source:required-invalid-projection', [{ id: 1, value: 'bad' }]);
    const catalog = new AttachmentCatalog();
    const input = attachment('attachment:required-invalid-projection', source);
    const lease = catalog.attach({
      ...input,
      preparation: prepareManualReadOnlyAttachment({
        schemaViewIds: ['schema:rows'],
        project: () => { throw new Error('projection failed'); }
      })
    });
    const dataset = new DatasetMembership({
      datasetId: 'dataset:one', state: 'settled',
      members: [member(input.attachmentId, source.sourceId)]
    });
    const database = view(catalog, [dataset]);
    const observer = database.observe({ plan: plan() });

    expect(observer.getSnapshot()).toMatchObject({ state: 'open', current: {
      readiness: 'invalid', rows: [], completeness: 'unknown',
      sourceStates: [{ attachmentId: input.attachmentId, state: 'failed' }]
    } });
    observer.close();
    database.close();
    lease.close();
  });

  it('classifies required nonfailed projection unavailability as incomplete', () => {
    const source = new TestSource('source:required-loading-projection', [{ id: 1, value: 'pending' }]);
    const catalog = new AttachmentCatalog();
    const input = attachment('attachment:required-loading-projection', source);
    const lease = catalog.attach({
      ...input,
      preparation: prepareManualReadOnlyAttachment({
        schemaViewIds: ['schema:rows'],
        project: () => ({ state: 'loading', issues: [] })
      })
    });
    const dataset = new DatasetMembership({
      datasetId: 'dataset:one', state: 'settled',
      members: [member(input.attachmentId, source.sourceId)]
    });
    const database = view(catalog, [dataset]);
    const observer = database.observe({ plan: plan() });

    expect(observer.getSnapshot()).toMatchObject({ state: 'open', current: {
      readiness: 'incomplete', rows: [], completeness: 'unknown',
      sourceStates: [{ attachmentId: input.attachmentId, state: 'loading' }]
    } });
    observer.close();
    database.close();
    lease.close();
  });

  it('retains an unexpected frame failure for observers opened before recovery', () => {
    const source = new TestSource('source:frame-failure', [{ id: 1, value: 'one' }]);
    const catalog = new AttachmentCatalog();
    let malformed = false;
    const attachmentLease = catalog.attach({
      ...attachment('attachment:frame-failure', source),
      preparation: prepareManualReadOnlyAttachment({
        schemaViewIds: ['schema:rows'],
        project: (snapshot: SourceSnapshot<{ readonly rows: readonly Row[] }>) => {
          if (malformed) {
            return Object.defineProperty({}, 'state', { enumerable: true, get: () => { throw new Error('frame failed'); } }) as never;
          }
          return snapshot.storage === undefined
            ? { state: snapshot.state === 'ready' ? 'failed' as const : snapshot.state, issues: [] }
            : { state: 'ready' as const, value: snapshot.storage.rows, issues: [] };
        }
      })
    });
    const dataset = new DatasetMembership({ datasetId: 'dataset:one', state: 'settled', members: [member('attachment:frame-failure', source.sourceId)] });
    const database = view(catalog, [dataset]);
    const first = database.observe({ plan: plan() });

    malformed = true;
    source.notify();
    const late = database.observe({ plan: sealPreparedPlan({ ...plan(), planId: 'query:frame-failure-late', rootNodeId: 'query:frame-failure-late:root' }) });
    expect(first.getSnapshot()).toMatchObject({ state: 'open', current: { rows: [], completeness: 'unknown' } });
    expect(late.getSnapshot()).toMatchObject({ state: 'open', current: { rows: [], completeness: 'unknown' } });

    malformed = false;
    source.publish({ rows: [{ id: 2, value: 'recovered' }] });
    expect(first.getSnapshot()).toMatchObject({ state: 'open', current: { rows: [{ id: 2, value: 'recovered' }], completeness: 'exact' } });
    expect(late.getSnapshot()).toMatchObject({ state: 'open', current: { rows: [{ id: 2, value: 'recovered' }], completeness: 'exact' } });
    first.close();
    late.close();
    database.close();
    attachmentLease.close();
  });

  it('does not publish a coalesced recovery superseded by the same frame failure', () => {
    const source = new TestSource('source:coalesced-frame-failure', [{ id: 1, value: 'one' }]);
    const catalog = new AttachmentCatalog();
    let malformed = false;
    let failDuringRecovery = false;
    const attachmentLease = catalog.attach({
      ...attachment('attachment:coalesced-frame-failure', source),
      preparation: prepareManualReadOnlyAttachment({
        schemaViewIds: ['schema:rows'],
        project: (snapshot: SourceSnapshot<{ readonly rows: readonly Row[] }>) => malformed
          ? Object.defineProperty({}, 'state', { enumerable: true, get: () => { throw new Error('frame failed'); } }) as never
          : snapshot.storage === undefined
            ? { state: snapshot.state === 'ready' ? 'failed' as const : snapshot.state, issues: [] }
            : { state: 'ready' as const, value: snapshot.storage.rows, issues: [] }
      })
    });
    const dataset = new DatasetMembership({ datasetId: 'dataset:one', state: 'settled', members: [member('attachment:coalesced-frame-failure', source.sourceId)] });
    const database = view(catalog, [dataset], 'public', 'authority:public', (input) => {
      const result = evaluate(input);
      if (failDuringRecovery) {
        failDuringRecovery = false;
        malformed = true;
        source.notify();
      }
      return result;
    });
    const observer = database.observe({ plan: plan() });
    malformed = true;
    source.notify();
    const changes: ObserverChange<Row>[] = [];
    observer.subscribe((change) => { changes.push(change); });

    malformed = false;
    failDuringRecovery = true;
    source.publish({ rows: [{ id: 2, value: 'unpublished-recovery' }] });

    expect(observer.getSnapshot()).toMatchObject({ state: 'open', current: { rows: [], completeness: 'unknown' } });
    expect(changes.every(({ snapshot }) => snapshot.state === 'open' && snapshot.current.completeness === 'unknown')).toBe(true);
    malformed = false;
    source.publish({ rows: [{ id: 3, value: 'recovered' }] });
    expect(observer.getSnapshot()).toMatchObject({ state: 'open', current: { rows: [{ id: 3, value: 'recovered' }], completeness: 'exact' } });
    observer.close();
    database.close();
    attachmentLease.close();
  });

  it('contains authority failures during topology refresh and recovers on the next topology change', () => {
    const source = new TestSource('source:topology-authority', [{ id: 1, value: 'one' }]);
    const unrelated = new TestSource('source:topology-authority-unrelated', []);
    const catalog = new AttachmentCatalog();
    const sourceLease = catalog.attach(attachment('attachment:topology-authority', source));
    const dataset = new DatasetMembership({
      datasetId: 'dataset:one', state: 'settled', members: [member('attachment:topology-authority', source.sourceId)]
    });
    let authorityFails = false;
    const database = createDatabaseView<Query, Row, readonly Row[]>({
      authorityScope: 'public', authorityFingerprint: 'authority:public', registryFingerprint: 'registry:one',
      attachments: catalog, datasets: [dataset],
      canRead: () => {
        if (authorityFails) throw new Error('authority unavailable');
        return true;
      },
      createQueryMaintenance: createMaintenance(evaluate)
    });
    const observer = database.observe({ plan: plan() });

    authorityFails = true;
    const unrelatedLease = catalog.attach(attachment('attachment:topology-authority-unrelated', unrelated));
    expect(observer.getSnapshot()).toMatchObject({ state: 'open', current: {
      rows: [], completeness: 'unknown',
      issues: expect.arrayContaining([expect.objectContaining({
        code: 'observer.evaluation_failed', details: expect.objectContaining({ reason: 'authority_check_failed' })
      })])
    } });

    authorityFails = false;
    unrelatedLease.close();
    expect(observer.getSnapshot()).toMatchObject({ state: 'open', current: {
      rows: [{ id: 1, value: 'one' }], completeness: 'exact'
    } });
    observer.close();
    database.close();
    sourceLease.close();
  });

  it('isolates a malformed custom maintenance result from sibling roots', () => {
    const source = new TestSource('source:custom-stage-failure', [{ id: 1, value: 'one' }]);
    const catalog = new AttachmentCatalog();
    const attachmentLease = catalog.attach(attachment('attachment:custom-stage-failure', source));
    const dataset = new DatasetMembership({ datasetId: 'dataset:one', state: 'settled', members: [member('attachment:custom-stage-failure', source.sourceId)] });
    const factory: CreateDatabaseQueryMaintenance<Query, Row, readonly Row[]> = ({ plan: prepared, initialInput }) => {
      let current = evaluate(initialInput);
      return {
        getCurrentResult: () => current,
        updateInput: (input) => {
          if (prepared.planId === 'query:broken') {
            current = {
              get rows(): readonly Row[] { throw new Error('rows failed'); },
              resultKeys: [], completeness: 'exact', issues: []
            };
          } else current = evaluate(input);
          return current;
        },
        close: () => undefined
      };
    };
    const database = createDatabaseView<Query, Row, readonly Row[]>({
      authorityScope: 'public', authorityFingerprint: 'authority:public', registryFingerprint: 'registry:one',
      attachments: catalog, datasets: [dataset], canRead: () => true, createQueryMaintenance: factory
    });
    const broken = database.observe({ plan: sealPreparedPlan({ ...plan(), planId: 'query:broken', rootNodeId: 'query:broken:root' }) });
    const healthy = database.observe({ plan: sealPreparedPlan({ ...plan(), planId: 'query:healthy', rootNodeId: 'query:healthy:root' }) });

    source.publish({ rows: [{ id: 2, value: 'two' }] });

    expect(broken.getSnapshot()).toMatchObject({ state: 'open', current: { readiness: 'invalid', rows: [], completeness: 'unknown', issues: expect.arrayContaining([expect.objectContaining({ code: 'observer.evaluation_failed' })]) } });
    expect(healthy.getSnapshot()).toMatchObject({ state: 'open', current: { rows: [{ id: 2, value: 'two' }], completeness: 'exact' } });
    broken.close();
    healthy.close();
    database.close();
    attachmentLease.close();
  });

  it('fully adopts frozen custom maintenance rows instead of trusting their apparent immutability', () => {
    const source = new TestSource('source:custom-owned', [{ id: 1, value: 'source' }]);
    const catalog = new AttachmentCatalog();
    const attachmentLease = catalog.attach(attachment('attachment:custom-owned', source));
    const dataset = new DatasetMembership({ datasetId: 'dataset:one', state: 'settled', members: [member('attachment:custom-owned', source.sourceId)] });
    const nested = { label: 'owned' };
    const callerRow = Object.freeze({ id: 1, value: 'one', nested }) as unknown as Row;
    const database = view(catalog, [dataset], 'public', 'authority:public', () => ({
      rows: Object.freeze([callerRow]), resultKeys: Object.freeze(['custom:1']), completeness: 'exact', issues: Object.freeze([])
    }));
    const observer = database.observe({ plan: plan() });
    const snapshot = observer.getSnapshot();

    nested.label = 'mutated';

    expect(snapshot).toMatchObject({ state: 'open', current: { rows: [{ nested: { label: 'owned' } }] } });
    expect(Object.isFrozen(snapshot.state === 'open' ? (snapshot.current.rows[0] as unknown as { nested: object }).nested : undefined)).toBe(true);
    observer.close();
    database.close();
    attachmentLease.close();
  });

  it('does not transfer built-in result trust through a custom maintenance factory', () => {
    const source = new TestSource('source:replayed-trust', [{ id: 2, value: 'two' }]);
    const catalog = new AttachmentCatalog();
    const attachmentId = 'attachment:replayed-trust';
    const attachmentLease = catalog.attach(relationalAttachment(attachmentId, source));
    const dataset = new DatasetMembership({ datasetId: 'dataset:one', state: 'settled', members: [member(attachmentId, source.sourceId)] });
    const snapshot = source.snapshot();
    const attachment = catalog.get(attachmentId) as DatabaseAttachment<unknown, readonly RelationInput[]>;
    const projection: readonly RelationInput[] = [{
      relation: { schemaView: querySchemaView, relationId: 'test.rows' }, rows: snapshot.storage?.rows ?? [],
      occurrenceIds: (snapshot.storage?.rows ?? []).map(({ id }) => 'row:' + id), completeness: 'exact',
      sourceId: source.sourceId, attachmentId, basis: snapshot.basis
    }];
    const builtIn = createIncrementalDatabaseQueryMaintenance();
    const builtInSession = builtIn({
      plan: relationalPlan(),
      initialInput: {
        query: relationalPlan().query, parameters: {}, dataset: dataset.snapshot(),
        attachments: [{ member: member(attachmentId, source.sourceId), attachment, snapshot, projection }]
      }
    });
    const replayed = builtInSession.getCurrentResult();
    const replayFactory: CreateDatabaseQueryMaintenance<QueryNode, QueryRecord, readonly RelationInput[]> = () => ({
      getCurrentResult: () => replayed, updateInput: () => replayed, close: () => undefined
    });
    const database = createDatabaseView<QueryNode, QueryRecord, readonly RelationInput[]>({
      authorityScope: 'public', authorityFingerprint: 'authority:public', registryFingerprint: 'registry:one',
      attachments: catalog, datasets: [dataset], canRead: () => true, createQueryMaintenance: replayFactory
    });
    const observer = database.observe({ plan: relationalPlan() });
    const observed = observer.getSnapshot();

    expect(observed).toMatchObject({ state: 'open', current: { rows: [{ id: 2, value: 'two' }] } });
    expect(observed.state === 'open' ? observed.current.rows : undefined).not.toBe(replayed.rows);
    observer.close();
    database.close();
    builtInSession.close();
    attachmentLease.close();
  });

  it('does not subscribe to or leak a required source denied by this authority view', () => {
    const privateSource = new TestSource('source:private', [{ id: 7, value: 'secret' }]);
    const catalog = new AttachmentCatalog();
    const lease = catalog.attach(attachment('attachment:private', privateSource, 'private'));
    const dataset = new DatasetMembership({ datasetId: 'dataset:one', state: 'settled', members: [member('attachment:private', privateSource.sourceId)] });
    const database = view(catalog, [dataset]);
    const observer = database.observe({ plan: plan() });
    expect(observer.getSnapshot()).toMatchObject({ state: 'open', current: { readiness: 'incomplete', rows: [], completeness: 'unknown', sourceStates: [{ state: 'denied', authorized: false }] } });
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
    expect(database.getActiveMaintenanceCount()).toBe(1);
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
    expect(source.listenerCount()).toBe(1);
    expect(source.subscriptionCount()).toBe(1);
    expect(second.getSnapshot()).toMatchObject({ state: 'open', current: { rows: [{ id: 2, value: 'two' }] } });

    second.close();
    second.close();
    expect(database.getActiveMaintenanceCount()).toBe(0);
    expect(source.listenerCount()).toBe(0);

    const later = database.observe({ plan: plan(), parameters: { selected: 1 } });
    expect(later.getSnapshot()).toMatchObject({ state: 'open', current: { rows: [{ id: 2, value: 'two' }] } });
    later.close();
    database.close();
    attachmentLease.close();
  });

  it('shares one dataset subscription runtime across distinct query roots', () => {
    const source = new TestSource('source:one', [{ id: 1, value: 'one' }]);
    const catalog = new AttachmentCatalog();
    const attachmentLease = catalog.attach(attachment('attachment:one', source));
    const dataset = new DatasetMembership({ datasetId: 'dataset:one', state: 'settled', members: [member('attachment:one', source.sourceId)] });
    const database = view(catalog, [dataset]);
    const first = database.observe({ plan: plan() });
    const second = database.observe({ plan: sealPreparedPlan({ ...plan(), planId: 'query:other', rootNodeId: 'query:other:root' }) });

    expect(database.getActiveMaintenanceCount()).toBe(2);
    expect(source.listenerCount()).toBe(1);
    expect(source.subscriptionCount()).toBe(1);
    const unrelatedSource = new TestSource('source:unrelated-topology', []);
    const unrelatedLease = catalog.attach(attachment('attachment:unrelated-topology', unrelatedSource));
    expect(source.subscriptionCount()).toBe(1);
    unrelatedLease.close();
    expect(source.subscriptionCount()).toBe(1);

    first.close();
    expect(source.listenerCount()).toBe(1);
    source.publish({ rows: [{ id: 2, value: 'two' }] });
    expect(second.getSnapshot()).toMatchObject({ state: 'open', current: { rows: [{ id: 2, value: 'two' }] } });

    second.close();
    expect(source.listenerCount()).toBe(0);
    database.close();
    attachmentLease.close();
  });

  it('retains a failed topology unsubscribe for final cleanup retry', () => {
    const source = new TestSource('source:unsubscribe-retry', [{ id: 1, value: 'one' }]);
    const catalog = new AttachmentCatalog();
    const attachmentLease = catalog.attach(attachment('attachment:unsubscribe-retry', source));
    const dataset = new DatasetMembership({ datasetId: 'dataset:one', state: 'settled', members: [member('attachment:unsubscribe-retry', source.sourceId)] });
    const database = view(catalog, [dataset]);
    const observer = database.observe({ plan: plan() });
    source.failUnsubscribes();

    dataset.replaceMembers([], 'settled');
    expect(source.listenerCount()).toBe(1);
    expect(source.unsubscribeCount()).toBe(1);

    observer.close();
    expect(source.unsubscribeCount()).toBe(2);
    expect(source.listenerCount()).toBe(0);
    database.close();
    attachmentLease.close();
  });

  it('stages every active root before publishing observer callbacks', () => {
    const source = new TestSource('source:one', [{ id: 1, value: 'one' }]);
    const catalog = new AttachmentCatalog();
    const attachmentLease = catalog.attach(attachment('attachment:one', source));
    const dataset = new DatasetMembership({ datasetId: 'dataset:one', state: 'settled', members: [member('attachment:one', source.sourceId)] });
    const database = view(catalog, [dataset]);
    const first = database.observe({ plan: plan() });
    const second = database.observe({ plan: sealPreparedPlan({ ...plan(), planId: 'query:other', rootNodeId: 'query:other:root' }) });
    const seenFromFirstCallback: Row[][] = [];
    first.subscribe(() => {
      const snapshot = second.getSnapshot();
      if (snapshot.state === 'open') seenFromFirstCallback.push([...snapshot.current.rows]);
    });

    source.publish({ rows: [{ id: 2, value: 'two' }] });

    expect(seenFromFirstCallback).toEqual([[{ id: 2, value: 'two' }]]);
    first.close();
    second.close();
    database.close();
    attachmentLease.close();
  });

  it('stages a lease acquired for a later root during an earlier root callback', () => {
    const source = new TestSource('source:late-lease', [{ id: 1, value: 'one' }]);
    const catalog = new AttachmentCatalog();
    const attachmentLease = catalog.attach(attachment('attachment:late-lease', source));
    const dataset = new DatasetMembership({ datasetId: 'dataset:one', state: 'settled', members: [member('attachment:late-lease', source.sourceId)] });
    const database = view(catalog, [dataset]);
    const first = database.observe({ plan: plan() });
    const secondPlan = sealPreparedPlan({ ...plan(), planId: 'query:late-lease-second', rootNodeId: 'query:late-lease-second:root' });
    const second = database.observe({ plan: secondPlan });
    let late: ReturnType<typeof database.observe> | undefined;
    const lateListener = vi.fn();
    first.subscribe(() => {
      late = database.observe({ plan: secondPlan });
      late.subscribe(lateListener);
    });

    source.publish({ rows: [{ id: 2, value: 'two' }] });

    expect(lateListener).toHaveBeenCalledOnce();
    expect(late?.getSnapshot()).toBe(second.getSnapshot());
    expect(late?.getSnapshot()).toMatchObject({ state: 'open', current: { rows: [{ id: 2, value: 'two' }] } });
    first.close();
    second.close();
    late?.close();
    database.close();
    attachmentLease.close();
  });

  it('reconciles a synchronous source change caused by maintenance construction', () => {
    const source = new TestSource('source:construction-refresh', [{ id: 1, value: 'one' }]);
    const catalog = new AttachmentCatalog();
    const attachmentLease = catalog.attach(attachment('attachment:construction-refresh', source));
    const dataset = new DatasetMembership({ datasetId: 'dataset:one', state: 'settled', members: [member('attachment:construction-refresh', source.sourceId)] });
    let constructed = false;
    const factory: import('../src/observer.js').CreateDatabaseQueryMaintenance<Query, Row, readonly Row[]> = ({ initialInput }) => {
      let current = evaluate(initialInput);
      if (!constructed) {
        constructed = true;
        source.publish({ rows: [{ id: 2, value: 'two' }] });
      }
      return {
        getCurrentResult: () => current,
        updateInput: (input) => { current = evaluate(input); return current; },
        close: () => undefined
      };
    };
    const database = createDatabaseView<Query, Row, readonly Row[]>({
      authorityScope: 'public', authorityFingerprint: 'authority:public', registryFingerprint: 'registry:one',
      attachments: catalog, datasets: [dataset], canRead: () => true, createQueryMaintenance: factory
    });

    const observer = database.observe({ plan: plan() });
    expect(observer.getSnapshot()).toMatchObject({ state: 'open', current: { rows: [{ id: 2, value: 'two' }] } });
    observer.close();
    database.close();
    attachmentLease.close();
  });

  it('contains throwing maintenance cleanup and closes every observation', () => {
    const source = new TestSource('source:throwing-close', [{ id: 1, value: 'one' }]);
    const catalog = new AttachmentCatalog();
    const attachmentLease = catalog.attach(attachment('attachment:throwing-close', source));
    const dataset = new DatasetMembership({ datasetId: 'dataset:one', state: 'settled', members: [member('attachment:throwing-close', source.sourceId)] });
    const close = vi.fn(() => { throw new Error('close failed'); });
    const diagnostics = vi.fn();
    const factory: import('../src/observer.js').CreateDatabaseQueryMaintenance<Query, Row, readonly Row[]> = ({ initialInput }) => {
      let current = evaluate(initialInput);
      return { getCurrentResult: () => current, updateInput: (input) => { current = evaluate(input); return current; }, close };
    };
    const database = createDatabaseView<Query, Row, readonly Row[]>({
      authorityScope: 'public', authorityFingerprint: 'authority:public', registryFingerprint: 'registry:one',
      attachments: catalog, datasets: [dataset], canRead: () => true, createQueryMaintenance: factory,
      onDiagnostic: diagnostics
    });
    const first = database.observe({ plan: plan() });
    const second = database.observe({ plan: sealPreparedPlan({ ...plan(), planId: 'query:throwing-close-second', rootNodeId: 'query:throwing-close-second:root' }) });

    expect(() => first.close()).not.toThrow();
    expect(() => database.close()).not.toThrow();
    expect(close).toHaveBeenCalledTimes(2);
    expect(first.getSnapshot()).toEqual({ state: 'closed' });
    expect(second.getSnapshot()).toEqual({ state: 'closed' });
    expect(source.listenerCount()).toBe(0);
    expect(database.getActiveMaintenanceCount()).toBe(0);
    expect(diagnostics).toHaveBeenCalledTimes(2);
    expect(diagnostics).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'cleanup_error', component: 'database-view', operation: 'close-maintenance', error: expect.any(Error)
    }));
    attachmentLease.close();
  });

  it('retains snapshot identity when a refresh changes no observed evidence', () => {
    const source = new TestSource('source:one', [{ id: 1, value: 'one' }]);
    const catalog = new AttachmentCatalog();
    const attachmentLease = catalog.attach(attachment('attachment:one', source));
    const dataset = new DatasetMembership({ datasetId: 'dataset:one', state: 'settled', members: [member('attachment:one', source.sourceId)] });
    const database = view(catalog, [dataset]);
    const observer = database.observe({ plan: plan() });
    const initial = observer.getSnapshot();
    const listener = vi.fn();
    observer.subscribe(listener);

    source.notify();

    expect(observer.getSnapshot()).toBe(initial);
    expect(listener).not.toHaveBeenCalled();
    observer.close();
    database.close();
    attachmentLease.close();
  });

  it('diffs a coalesced nested refresh from the last published snapshot', () => {
    const source = new TestSource('source:one', [{ id: 1, value: 'one' }]);
    const catalog = new AttachmentCatalog();
    const attachmentLease = catalog.attach(attachment('attachment:one', source));
    const dataset = new DatasetMembership({ datasetId: 'dataset:one', state: 'settled', members: [member('attachment:one', source.sourceId)] });
    let publishedNestedUpdate = false;
    const database = view(catalog, [dataset], 'public', 'authority:public', (input) => {
      const result = evaluate(input);
      if (!publishedNestedUpdate && result.rows[0]?.value === 'two') {
        publishedNestedUpdate = true;
        source.publish({ rows: [{ id: 1, value: 'three' }] });
      }
      return result;
    });
    const observer = database.observe({ plan: plan() });
    const changes: ObserverChange<Row>[] = [];
    observer.subscribe((change) => { changes.push(change); });

    source.publish({ rows: [{ id: 1, value: 'two' }] });

    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({
      kind: 'diff',
      diff: { updated: [{ before: { id: 1, value: 'one' }, after: { id: 1, value: 'three' } }] }
    });
    expect(observer.getSnapshot()).toMatchObject({ state: 'open', current: { rows: [{ id: 1, value: 'three' }] } });
    observer.close();
    database.close();
    attachmentLease.close();
  });

  it('keeps distinct prepared roots in collision-safe maintenance cache entries', () => {
    const source = new TestSource('source:one', [{ id: 1, value: 'one' }]);
    const catalog = new AttachmentCatalog();
    const attachmentLease = catalog.attach(attachment('attachment:one', source));
    const dataset = new DatasetMembership({ datasetId: 'dataset:one', state: 'settled', members: [member('attachment:one', source.sourceId)] });
    const database = view(catalog, [dataset]);
    const firstPlan = sealPreparedPlan({ ...plan(), planId: 'query\u0000all', rootNodeId: 'root' });
    const secondPlan = sealPreparedPlan({ ...plan(), planId: 'query', rootNodeId: 'all\u0000root' });
    const first = database.observe({ plan: firstPlan });
    const second = database.observe({ plan: secondPlan });

    expect(database.getActiveMaintenanceCount()).toBe(2);
    expect(first.getSnapshot()).not.toBe(second.getSnapshot());

    first.close();
    second.close();
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
    expect(database.getActiveMaintenanceCount()).toBe(1);
    expect(second.getSnapshot()).toBe(first.getSnapshot());
    dataset.settle();
    expect(first.getSnapshot()).toMatchObject({ state: 'open', current: { completeness: 'exact', basis: { dataset: { revision: 2 } } } });
    first.close();
    second.close();
    database.close();
    attachmentLease.close();
  });

  it('never exposes a negative result while dataset membership remains open', () => {
    const catalog = new AttachmentCatalog();
    const dataset = new DatasetMembership({
      datasetId: 'dataset:one',
      state: 'open',
      members: [member('attachment:optional-pending', 'source:pending', 'optional')]
    });
    const negativeEvaluation = (): MaintainedDatabaseQueryResult<Row> => ({
      rows: [{ id: 99, value: 'inferred-absence' }],
      resultKeys: ['negative:99'],
      completeness: 'exact',
      issues: []
    });
    const database = view(catalog, [dataset], 'public', 'authority:public', negativeEvaluation);
    const observer = database.observe({ plan: plan() });
    expect(observer.getSnapshot()).toMatchObject({ state: 'open', current: { readiness: 'incomplete', rows: [], completeness: 'unknown', issues: expect.arrayContaining([expect.objectContaining({ code: 'observer.membership_open' })]) } });

    dataset.settle();
    expect(observer.getSnapshot()).toMatchObject({ state: 'open', current: { rows: [{ id: 99, value: 'inferred-absence' }], completeness: 'exact' } });
    observer.close();
    database.close();
  });

  it('queues reentrant source changes and isolates failing listeners', () => {
    const source = new TestSource('source:one', [{ id: 1, value: 'one' }]);
    const catalog = new AttachmentCatalog();
    const attachmentLease = catalog.attach(attachment('attachment:one', source));
    const dataset = new DatasetMembership({ datasetId: 'dataset:one', state: 'settled', members: [member('attachment:one', source.sourceId)] });
    const diagnostics = vi.fn();
    const database = view(catalog, [dataset], 'public', 'authority:public', evaluate, diagnostics);
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
    expect(diagnostics).toHaveBeenCalledTimes(2);
    expect(diagnostics).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'listener_error', component: 'query-observer', operation: 'publish', error: expect.any(Error)
    }));
    expect(observer.getSnapshot()).toMatchObject({ state: 'open', current: { rows: [{ id: 3, value: 'three' }] } });
    observer.close();
    database.close();
    attachmentLease.close();
  });
});
