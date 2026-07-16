import { describe, expect, it, vi } from 'vitest';
import type { AttachmentCatalog, ObservableSource, SourceSnapshot } from '../src/database/index.js';
import {
  openDatabaseQuery,
  type DatabaseSourceMountLease,
  type MountableDatabaseSource,
  type OpenLinkedDatabaseSourceRequest
} from '../src/database/query-session.js';
import { prepareManualReadOnlyAttachment } from '../src/attachment/preparation.js';
import { prepareQuery, type QueryNode, type QueryRecord, type RelationInput, type RelationUse } from '../src/query/index.js';
import { relationLiteral, sealSchema } from '../src/schema/index.js';

type Storage = {
  readonly links: readonly QueryRecord[];
  readonly items: readonly QueryRecord[];
};

const deferred = <Value>() => {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((complete) => { resolve = complete; });
  return { promise, resolve };
};

const createMutableSource = (input: {
  readonly sourceId: string;
  readonly attachmentId: string;
  readonly scope?: string;
  readonly storage: Storage;
  readonly relations: {
    readonly links: ReturnType<typeof relationLiteral>;
    readonly items: ReturnType<typeof relationLiteral>;
  };
}) => {
  let storage = input.storage;
  let revision = 0;
  const listeners = new Set<() => void>();
  const close = vi.fn();
  const source: ObservableSource<Storage> = {
    sourceId: input.sourceId,
    snapshot: (): SourceSnapshot<Storage> => ({
      sourceId: input.sourceId,
      operationEpoch: `epoch:${input.sourceId}`,
      basis: { incarnation: `incarnation:${input.sourceId}`, revision },
      state: 'ready',
      freshness: 'current',
      storage,
      issues: []
    }),
    subscribe: (listener) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    }
  };
  const mountable: MountableDatabaseSource = {
    mount: (catalog: AttachmentCatalog, options = {}) => {
      const lease = catalog.attach({
        attachmentId: input.attachmentId,
        incarnation: `attachment:${input.sourceId}:one`,
        sourceId: input.sourceId,
        source,
        authorityScope: input.scope ?? 'scope:test',
        discoveryEdges: options.discoveryEdges ?? [],
        preparation: prepareManualReadOnlyAttachment<Storage, readonly RelationInput[]>({
          schemaViewIds: [input.relations.links.schemaView.id],
          project: (snapshot) => ({
            state: 'ready',
            value: [
              {
                relation: input.relations.links,
                rows: snapshot.storage?.links ?? [],
                occurrenceIds: (snapshot.storage?.links ?? []).map((_row, index) => `${input.sourceId}:link:${index}`),
                completeness: 'exact',
                sourceId: input.sourceId,
                attachmentId: input.attachmentId,
                basis: snapshot.basis
              },
              {
                relation: input.relations.items,
                rows: snapshot.storage?.items ?? [],
                occurrenceIds: (snapshot.storage?.items ?? []).map((_row, index) => `${input.sourceId}:item:${index}`),
                completeness: 'exact',
                sourceId: input.sourceId,
                attachmentId: input.attachmentId,
                basis: snapshot.basis
              }
            ],
            issues: []
          })
        })
      });
      return {
        attachmentId: input.attachmentId,
        sourceId: input.sourceId,
        discoveryEdges: options.discoveryEdges ?? [],
        close: () => {
          close();
          lease.close();
        }
      };
    }
  };
  return {
    source: mountable,
    close,
    replace(next: Storage): void {
      storage = next;
      revision += 1;
      for (const listener of Array.from(listeners)) listener();
    }
  };
};

const setup = async () => {
  const schema = await sealSchema({ body: { relations: {
    links: {
      relationId: 'test.source_link',
      key: ['linkId'],
      fields: {
        linkId: { type: { kind: 'string' } },
        originSourceId: { type: { kind: 'string' } },
        targetSourceId: { type: { kind: 'string' } },
        expectation: { type: { kind: 'string' } }
      }
    },
    items: {
      relationId: 'test.item',
      key: ['id'],
      fields: {
        id: { type: { kind: 'string' } }
      }
    }
  } } });
  const links = relationLiteral(schema, 'links');
  const items = relationLiteral(schema, 'items');
  const select = (relation: RelationUse, fields: readonly string[]): QueryNode => ({
    kind: 'select',
    input: { kind: 'from', relation, alias: 'row' },
    alias: 'result',
    fields: Object.fromEntries(fields.map((name) => [name, { kind: 'field', alias: 'row', name }]))
  });
  const common = {
    registryFingerprint: 'registry:test',
    authorityFingerprint: 'authority:test',
    datasetId: 'dataset:test'
  } as const;
  const linkPlan = await prepareQuery({
    root: select(links, ['linkId', 'originSourceId', 'targetSourceId', 'expectation']),
    ...common
  });
  const itemPlan = await prepareQuery({ root: select(items, ['id']), ...common });
  return { relations: { links, items }, linkPlan, itemPlan };
};

describe('database source links', () => {
  it('opens a changing reachable graph to a fixed point without transient readiness', async () => {
    const { relations, linkPlan, itemPlan } = await setup();
    const root = createMutableSource({
      sourceId: 'root',
      attachmentId: 'attachment:root',
      relations,
      storage: {
        links: [{ linkId: 'root-child', originSourceId: 'root', targetSourceId: 'child', expectation: 'required' }],
        items: [{ id: 'root-item' }]
      }
    });
    const child = createMutableSource({
      sourceId: 'child',
      attachmentId: 'attachment:child',
      relations,
      storage: {
        links: [{ linkId: 'child-file', originSourceId: 'child', targetSourceId: 'file', expectation: 'required' }],
        items: [{ id: 'child-item' }]
      }
    });
    const file = createMutableSource({
      sourceId: 'file',
      attachmentId: 'attachment:file',
      relations,
      storage: { links: [], items: [{ id: 'file-item' }] }
    });
    const late = createMutableSource({
      sourceId: 'late',
      attachmentId: 'attachment:late',
      relations,
      storage: { links: [], items: [{ id: 'late-item' }] }
    });
    const childOpening = deferred<MountableDatabaseSource | undefined>();
    const fileOpening = deferred<MountableDatabaseSource | undefined>();
    const lateOpening = deferred<MountableDatabaseSource | undefined>();
    const openSource = vi.fn((request: OpenLinkedDatabaseSourceRequest) => {
      if (request.sourceId === 'child') return childOpening.promise;
      if (request.sourceId === 'file') return fileOpening.promise;
      if (request.sourceId === 'late') return lateOpening.promise;
      return undefined;
    });

    const session = await openDatabaseQuery({
      sources: [{ source: root.source }],
      plan: itemPlan,
      queryAuthorityScope: 'scope:test',
      followSourceLinks: { plan: linkPlan, openSource }
    });

    expect(session.getSnapshot()).toMatchObject({
      state: 'open',
      current: {
        readiness: 'incomplete',
        sourceStates: expect.arrayContaining([
          expect.objectContaining({ sourceId: 'child', state: 'loading' })
        ])
      }
    });
    expect(openSource).toHaveBeenCalledWith(expect.objectContaining({
      sourceId: 'child'
    }));

    childOpening.resolve(child.source);
    await vi.waitFor(() => expect(openSource).toHaveBeenCalledWith(expect.objectContaining({ sourceId: 'file' })));
    expect(session.getSnapshot()).toMatchObject({ state: 'open', current: { readiness: 'incomplete' } });

    fileOpening.resolve(file.source);
    await vi.waitFor(() => expect(session.getSnapshot()).toMatchObject({
      state: 'open',
      current: {
        readiness: 'ready',
        rows: expect.arrayContaining([{ id: 'root-item' }, { id: 'child-item' }, { id: 'file-item' }])
      }
    }));

    const readiness: string[] = [];
    const unsubscribe = session.subscribe((change) => {
      if (change.snapshot.state === 'open') readiness.push(change.snapshot.current.readiness);
    });
    root.replace({
      links: [
        { linkId: 'root-child', originSourceId: 'root', targetSourceId: 'child', expectation: 'required' },
        { linkId: 'root-late', originSourceId: 'root', targetSourceId: 'late', expectation: 'required' }
      ],
      items: [{ id: 'root-item' }]
    });

    expect(readiness.at(0)).toBe('incomplete');
    expect(session.getSnapshot()).toMatchObject({ state: 'open', current: { readiness: 'incomplete' } });
    lateOpening.resolve(late.source);
    await vi.waitFor(() => expect(session.getSnapshot()).toMatchObject({
      state: 'open',
      current: {
        readiness: 'ready',
        rows: expect.arrayContaining([{ id: 'late-item' }])
      }
    }));

    readiness.length = 0;
    root.replace({ links: [], items: [{ id: 'root-item' }] });
    await vi.waitFor(() => expect(session.getSnapshot()).toMatchObject({
      state: 'open',
      current: { readiness: 'ready', rows: [{ id: 'root-item' }] }
    }));
    expect(child.close).toHaveBeenCalledOnce();
    expect(file.close).toHaveBeenCalledOnce();
    expect(late.close).toHaveBeenCalledOnce();

    unsubscribe();
    session.close();
    expect(root.close).toHaveBeenCalledOnce();
    expect(child.close).toHaveBeenCalledOnce();
    expect(file.close).toHaveBeenCalledOnce();
    expect(late.close).toHaveBeenCalledOnce();
  });

  it('deduplicates source opens, retains cycles, and aborts obsolete work', async () => {
    const { relations, linkPlan, itemPlan } = await setup();
    const root = createMutableSource({
      sourceId: 'root',
      attachmentId: 'attachment:root',
      relations,
      storage: {
        links: [
          { linkId: 'root-child-a', originSourceId: 'root', targetSourceId: 'child', expectation: 'optional' },
          { linkId: 'root-child-b', originSourceId: 'root', targetSourceId: 'child', expectation: 'required' }
        ],
        items: []
      }
    });
    const childOpening = deferred<MountableDatabaseSource | undefined>();
    let childRequest: OpenLinkedDatabaseSourceRequest | undefined;
    const session = await openDatabaseQuery({
      sources: [{ source: root.source }],
      plan: itemPlan,
      queryAuthorityScope: 'scope:test',
      followSourceLinks: {
        plan: linkPlan,
        openSource: (request) => {
          childRequest = request;
          return childOpening.promise;
        }
      }
    });

    expect(childRequest).toMatchObject({
      sourceId: 'child'
    });
    root.replace({ links: [], items: [] });
    await vi.waitFor(() => expect(childRequest?.signal.aborted).toBe(true));

    const stale = createMutableSource({
      sourceId: 'child',
      attachmentId: 'attachment:child',
      relations,
      storage: {
        links: [{ linkId: 'child-root', originSourceId: 'child', targetSourceId: 'root', expectation: 'required' }],
        items: []
      }
    });
    childOpening.resolve(stale.source);
    await Promise.resolve();
    await Promise.resolve();
    expect(stale.close).not.toHaveBeenCalled();
    expect(session.getSnapshot()).toMatchObject({ state: 'open', current: { readiness: 'ready' } });

    session.close();
    expect(root.close).toHaveBeenCalledOnce();
  });

  it('keeps unavailable and failed linked sources distinct', async () => {
    const { relations, linkPlan, itemPlan } = await setup();
    const root = createMutableSource({
      sourceId: 'root',
      attachmentId: 'attachment:root',
      relations,
      storage: {
        links: [
          { linkId: 'missing', originSourceId: 'root', targetSourceId: 'missing', expectation: 'required' },
          { linkId: 'failed', originSourceId: 'root', targetSourceId: 'failed', expectation: 'required' }
        ],
        items: []
      }
    });
    const session = await openDatabaseQuery({
      sources: [{ source: root.source }],
      plan: itemPlan,
      queryAuthorityScope: 'scope:test',
      followSourceLinks: {
        plan: linkPlan,
        openSource: ({ sourceId }) => {
          if (sourceId === 'missing') return undefined;
          throw new Error('offline');
        }
      }
    });

    await vi.waitFor(() => expect(session.getSnapshot()).toMatchObject({
      state: 'open',
      current: {
        readiness: 'invalid',
        sourceStates: expect.arrayContaining([
          expect.objectContaining({
            sourceId: 'missing',
            state: 'missing',
            issues: expect.arrayContaining([expect.objectContaining({ code: 'observer.linked_source_unavailable' })])
          }),
          expect.objectContaining({
            sourceId: 'failed',
            state: 'failed',
            issues: expect.arrayContaining([expect.objectContaining({ code: 'observer.linked_source_resolution_failed' })])
          })
        ])
      }
    }));

    session.close();
  });

  it('publishes invalid link evidence and recovers when the source rows are repaired', async () => {
    const { relations, linkPlan, itemPlan } = await setup();
    const root = createMutableSource({
      sourceId: 'root',
      attachmentId: 'attachment:root',
      relations,
      storage: {
        links: [{ linkId: 'broken', originSourceId: 'root', expectation: 'required' }],
        items: [{ id: 'root-item' }]
      }
    });
    const openSource = vi.fn();
    const session = await openDatabaseQuery({
      sources: [{ source: root.source }],
      plan: itemPlan,
      queryAuthorityScope: 'scope:test',
      followSourceLinks: { plan: linkPlan, openSource }
    });

    expect(session.getSnapshot()).toMatchObject({
      state: 'open',
      current: {
        readiness: 'invalid',
        issues: expect.arrayContaining([
          expect.objectContaining({ code: 'observer.source_link_invalid' })
        ])
      }
    });
    expect(openSource).not.toHaveBeenCalled();

    root.replace({ links: [], items: [{ id: 'root-item' }] });
    await vi.waitFor(() => expect(session.getSnapshot()).toMatchObject({
      state: 'open',
      current: { readiness: 'ready', rows: [{ id: 'root-item' }] }
    }));
    session.close();
  });

  it('keeps authority denial distinct and never follows links from denied sources', async () => {
    const { relations, linkPlan, itemPlan } = await setup();
    const root = createMutableSource({
      sourceId: 'root',
      attachmentId: 'attachment:root',
      relations,
      storage: {
        links: [{ linkId: 'private', originSourceId: 'root', targetSourceId: 'private', expectation: 'required' }],
        items: []
      }
    });
    const privateSource = createMutableSource({
      sourceId: 'private',
      attachmentId: 'attachment:private',
      scope: 'scope:private',
      relations,
      storage: {
        links: [{ linkId: 'private-hidden', originSourceId: 'private', targetSourceId: 'hidden', expectation: 'required' }],
        items: [{ id: 'private-item' }]
      }
    });
    const openSource = vi.fn(({ sourceId }: OpenLinkedDatabaseSourceRequest) =>
      sourceId === 'private' ? privateSource.source : undefined);
    const session = await openDatabaseQuery({
      sources: [{ source: root.source }],
      plan: itemPlan,
      queryAuthorityScope: 'scope:test',
      followSourceLinks: { plan: linkPlan, openSource }
    });

    await vi.waitFor(() => expect(session.getSnapshot()).toMatchObject({
      state: 'open',
      current: {
        readiness: 'incomplete',
        sourceStates: expect.arrayContaining([
          expect.objectContaining({ sourceId: 'private', state: 'denied', authorized: false })
        ])
      }
    }));
    expect(openSource).toHaveBeenCalledTimes(1);
    expect(openSource).not.toHaveBeenCalledWith(expect.objectContaining({ sourceId: 'hidden' }));

    session.close();
    expect(privateSource.close).toHaveBeenCalledOnce();
  });

  it('closes a mount that finishes after its link is removed', async () => {
    const { relations, linkPlan, itemPlan } = await setup();
    const root = createMutableSource({
      sourceId: 'root',
      attachmentId: 'attachment:root',
      relations,
      storage: {
        links: [{ linkId: 'slow', originSourceId: 'root', targetSourceId: 'slow', expectation: 'required' }],
        items: []
      }
    });
    const slow = createMutableSource({
      sourceId: 'slow',
      attachmentId: 'attachment:slow',
      relations,
      storage: { links: [], items: [] }
    });
    const finishMount = deferred<void>();
    let mountedLease: DatabaseSourceMountLease | undefined;
    const slowMount: MountableDatabaseSource = {
      mount: async (catalog, options) => {
        mountedLease = await slow.source.mount(catalog, options);
        await finishMount.promise;
        return mountedLease;
      }
    };
    const session = await openDatabaseQuery({
      sources: [{ source: root.source }],
      plan: itemPlan,
      queryAuthorityScope: 'scope:test',
      followSourceLinks: { plan: linkPlan, openSource: () => slowMount }
    });
    await vi.waitFor(() => expect(mountedLease).toBeDefined());

    root.replace({ links: [], items: [] });
    finishMount.resolve();

    await vi.waitFor(() => expect(slow.close).toHaveBeenCalledOnce());
    expect(session.getSnapshot()).toMatchObject({ state: 'open', current: { readiness: 'ready' } });
    session.close();
    expect(slow.close).toHaveBeenCalledOnce();
  });
});
