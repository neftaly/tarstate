import { AttachmentCatalog, DatasetMembership, type DatasetMember } from '../database.js';
import type {
  DatabaseSourceLinkFollower,
  NormalizedFollowSourceLinks
} from './follow-source-links.js';
import { createIncrementalDatabaseQueryMaintenance } from '../internal-observer-query-maintenance.js';
import { runObserverCleanups, type ObserverDiagnosticReporter } from '../observer-diagnostics.js';
import { DatabaseView, type ObserverChange, type ObserverSnapshot, type QueryObserver } from '../observer.js';
import type { PreparedPlanParameters, PreparedPlanRow } from '../query/authoring.js';
import type { PreparedPlan } from '../query/plan-contract.js';
import type { QueryNode, QueryRecord, RelationInput } from '../query/model.js';
import type { JsonValue } from '../value.js';
import type { DatabaseSourceLink } from './source-link-graph.js';
import { parseObservationParameters } from '../internal-observer-values.js';
import { assertPreparedPlan } from '../query/internal/prepared-plan.js';
import type {
  DatabaseSourceMountLease,
  MountableDatabaseSource,
  OpenLinkedDatabaseSource
} from './source-mount.js';

export type { DatabaseSourceLink } from './source-link-graph.js';
export type {
  DatabaseSourceMountLease,
  DatabaseSourceMountOptions,
  MountableDatabaseSource,
  OpenLinkedDatabaseSource,
  OpenLinkedDatabaseSourceRequest
} from './source-mount.js';

export type UnresolvedDatabaseSource = {
  readonly attachmentId: string;
  readonly sourceId: string;
};

type DatabaseQuerySourceOptions = {
  /** Defaults to required. */
  readonly expectation?: 'required' | 'optional';
  readonly discoveryEdges?: readonly string[];
};

/** A mountable source or explicit evidence that a known source is unavailable. */
export type DatabaseQuerySource = DatabaseQuerySourceOptions & (
  | { readonly source: MountableDatabaseSource; readonly unresolved?: never }
  | { readonly source?: never; readonly unresolved: UnresolvedDatabaseSource }
);

type NormalizedDatabaseQuerySource = {
  readonly expectation: 'required' | 'optional';
  readonly discoveryEdges: readonly string[];
} & (
  | { readonly kind: 'mountable'; readonly source: MountableDatabaseSource }
  | { readonly kind: 'unresolved'; readonly attachmentId: string; readonly sourceId: string }
);

export type DatabaseQueryReadContext = {
  readonly queryAuthorityScope: string;
  readonly sourceAuthorityScope: string;
  readonly attachmentId: string;
};

type SessionRow<Plan> = [PreparedPlanRow<Plan>] extends [never]
  ? QueryRecord
  : PreparedPlanRow<Plan>;

type SessionParameters<Plan> = [PreparedPlanParameters<Plan>] extends [never]
  ? Readonly<Record<string, JsonValue>>
  : PreparedPlanParameters<Plan>;

type SessionParameterOptions<Plan> = [PreparedPlanParameters<Plan>] extends [never]
  ? { readonly parameters?: Readonly<Record<string, JsonValue>> }
  : keyof SessionParameters<Plan> extends never
    ? { readonly parameters?: SessionParameters<Plan> }
    : { readonly parameters: SessionParameters<Plan> };

type SourceLinkPlan<Plan extends PreparedPlan<QueryNode>> = [PreparedPlanRow<Plan>] extends [never]
  ? Plan
  : PreparedPlanRow<Plan> extends DatabaseSourceLink
    ? Plan
    : never;

export type FollowDatabaseSourceLinksOptions<
  LinkPlan extends PreparedPlan<QueryNode> = PreparedPlan<QueryNode>
> = {
  /** Query rows describe links from an attached source to another source. */
  readonly plan: SourceLinkPlan<LinkPlan>;
  /** Host-owned source opening; Tarstate owns mounting, cancellation, and cleanup. */
  readonly openSource: OpenLinkedDatabaseSource;
} & SessionParameterOptions<LinkPlan>;

export type OpenDatabaseQueryOptions<
  Plan extends PreparedPlan<QueryNode>,
  LinkPlan extends PreparedPlan<QueryNode> = PreparedPlan<QueryNode>
> = {
  readonly sources: readonly DatabaseQuerySource[];
  readonly plan: Plan;
  readonly queryAuthorityScope: string;
  /** Defaults to allowing only sources with the same authority scope. */
  readonly canRead?: (context: DatabaseQueryReadContext) => boolean;
  readonly allowPartial?: boolean;
  readonly onDiagnostic?: ObserverDiagnosticReporter;
  /** Repeatedly follows query-produced source links until the reachable set settles. */
  readonly followSourceLinks?: FollowDatabaseSourceLinksOptions<LinkPlan>;
} & SessionParameterOptions<Plan>;

/** One owned query lifecycle over mounted or unresolved sources and incremental maintenance. */
export type DatabaseQuerySession<Row> = QueryObserver<Row>;

export const openDatabaseQuery = async <
  Plan extends PreparedPlan<QueryNode>,
  LinkPlan extends PreparedPlan<QueryNode> = PreparedPlan<QueryNode>
>(
  options: OpenDatabaseQueryOptions<Plan, LinkPlan>
): Promise<DatabaseQuerySession<SessionRow<Plan>>> => {
  if (typeof options.queryAuthorityScope !== 'string' || options.queryAuthorityScope.length === 0) {
    throw new TypeError('queryAuthorityScope must be a non-empty string');
  }
  assertPreparedPlan(options.plan);
  const parameters = parseObservationParameters(options.parameters ?? {});
  let sourceLinks: {
    readonly runtime: typeof import('./follow-source-links.js');
    readonly options: NormalizedFollowSourceLinks;
  } | undefined;
  if (options.followSourceLinks !== undefined) {
    const runtime = await import('./follow-source-links.js');
    sourceLinks = {
      runtime,
      options: runtime.normalizeFollowSourceLinks(options.followSourceLinks, options.plan)
    };
  }
  const sources = normalizeDatabaseQuerySources(options.sources);
  const catalog = new AttachmentCatalog(
    options.onDiagnostic === undefined ? {} : { onDiagnostic: options.onDiagnostic }
  );
  const leases: DatabaseSourceMountLease[] = [];
  let database: DatabaseView<QueryNode, QueryRecord, readonly RelationInput[]> | undefined;
  let observer: QueryObserver<SessionRow<Plan>> | undefined;
  let sourceLinkDatabase: DatabaseView<QueryNode, QueryRecord, readonly RelationInput[]> | undefined;
  let sourceLinkObserver: QueryObserver<QueryRecord> | undefined;
  let sourceLinkFollower: DatabaseSourceLinkFollower | undefined;

  try {
    const members: DatasetMember[] = [];
    for (const member of sources) {
      if (member.kind === 'unresolved') {
        members.push({
          attachmentId: member.attachmentId,
          sourceId: member.sourceId,
          expectation: member.expectation,
          discoveryEdges: member.discoveryEdges
        });
        continue;
      }
      const lease = await member.source.mount(catalog, {
        discoveryEdges: member.discoveryEdges
      });
      leases.push(lease);
      if (catalog.get(lease.attachmentId)?.sourceId !== lease.sourceId) {
        throw new TypeError('Mounted database source does not identify its catalog attachment');
      }
      members.push({
        attachmentId: lease.attachmentId,
        sourceId: lease.sourceId,
        expectation: member.expectation,
        discoveryEdges: lease.discoveryEdges
      } as const);
    }

    const membership = new DatasetMembership({
      datasetId: options.plan.datasetId,
      state: 'settled',
      members,
      ...(options.onDiagnostic === undefined ? {} : { onDiagnostic: options.onDiagnostic })
    });
    const createDatabase = (datasetMembership = membership): DatabaseView<QueryNode, QueryRecord, readonly RelationInput[]> =>
      new DatabaseView({
        authorityScope: options.queryAuthorityScope,
        authorityFingerprint: options.plan.authorityFingerprint,
        registryFingerprint: options.plan.registryFingerprint,
        attachments: catalog,
        datasets: [datasetMembership],
        canRead: (queryAuthorityScope, sourceAuthorityScope, attachmentId) => {
          if (options.canRead === undefined) {
            return queryAuthorityScope === sourceAuthorityScope;
          }
          return options.canRead({ queryAuthorityScope, sourceAuthorityScope, attachmentId });
        },
        createQueryMaintenance: createIncrementalDatabaseQueryMaintenance(),
        ...(options.onDiagnostic === undefined ? {} : { onDiagnostic: options.onDiagnostic })
      });
    if (sourceLinks !== undefined) {
      const sourceLinkMembership = new DatasetMembership({
        datasetId: options.plan.datasetId,
        state: 'settled',
        members: membership.snapshot().members.map((member) => ({
          ...member,
          expectation: 'optional'
        })),
        ...(options.onDiagnostic === undefined ? {} : { onDiagnostic: options.onDiagnostic })
      });
      sourceLinkDatabase = createDatabase(sourceLinkMembership);
      const openedSourceLinkObserver = sourceLinkDatabase.observe({
        plan: sourceLinks.options.plan,
        parameters: sourceLinks.options.parameters,
        allowPartial: true
      }) as QueryObserver<QueryRecord>;
      sourceLinkObserver = openedSourceLinkObserver;
      sourceLinkFollower = sourceLinks.runtime.followDatabaseSourceLinks({
        observer: openedSourceLinkObserver,
        catalog,
        membership,
        sourceLinkMembership,
        rootMembers: membership.snapshot().members,
        openSource: sourceLinks.options.openSource,
        ...(options.onDiagnostic === undefined ? {} : { onDiagnostic: options.onDiagnostic })
      });
    }
    database = createDatabase();
    observer = database.observe({
      plan: options.plan,
      parameters,
      ...(options.allowPartial === undefined ? {} : { allowPartial: options.allowPartial })
    });
  } catch (error) {
    const cleanups = [
      ...(observer === undefined ? [] : [() => observer?.close()]),
      ...(database === undefined ? [] : [() => database?.close()]),
      ...(sourceLinkFollower === undefined ? [] : [() => sourceLinkFollower?.close()]),
      ...(sourceLinkObserver === undefined ? [] : [() => sourceLinkObserver?.close()]),
      ...(sourceLinkDatabase === undefined ? [] : [() => sourceLinkDatabase?.close()]),
      ...[...leases].reverse().map((lease) => () => lease.close())
    ];
    runObserverCleanups(
      cleanups,
      { component: 'database-view', operation: 'open-database-query-rollback' },
      options.onDiagnostic
    );
    throw error;
  }

  const openedObserver = observer;
  const openedDatabase = database;
  const openedSourceLinkFollower = sourceLinkFollower;
  const openedSourceLinkObserver = sourceLinkObserver;
  const openedSourceLinkDatabase = sourceLinkDatabase;
  let closed = false;
  return Object.freeze({
    getSnapshot: (): ObserverSnapshot<SessionRow<Plan>> => openedObserver.getSnapshot(),
    subscribe: (listener: (change: ObserverChange<SessionRow<Plan>>) => void): (() => void) =>
      openedObserver.subscribe(listener),
    close: (): void => {
      if (closed) return;
      closed = true;
      runObserverCleanups(
        [
          () => openedObserver.close(),
          () => openedDatabase.close(),
          ...(openedSourceLinkFollower === undefined ? [] : [() => openedSourceLinkFollower.close()]),
          ...(openedSourceLinkObserver === undefined ? [] : [() => openedSourceLinkObserver.close()]),
          ...(openedSourceLinkDatabase === undefined ? [] : [() => openedSourceLinkDatabase.close()]),
          ...[...leases].reverse().map((lease) => () => lease.close())
        ],
        { component: 'database-view', operation: 'close-database-query' },
        options.onDiagnostic
      );
    }
  });
};

const normalizeDatabaseQuerySources = (input: unknown): readonly NormalizedDatabaseQuerySource[] => {
  if (!Array.isArray(input)) throw new TypeError('sources must be an array');
  const sources: NormalizedDatabaseQuerySource[] = [];
  for (let index = 0; index < input.length; index += 1) {
    const label = `sources[${index}]`;
    const candidate = input[index];
    if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) {
      throw new TypeError(`${label} must be an object`);
    }
    const member = candidate as {
      readonly source?: unknown;
      readonly unresolved?: unknown;
      readonly expectation?: unknown;
      readonly discoveryEdges?: unknown;
    };
    const source = member.source;
    const unresolved = member.unresolved;
    if ((source === undefined) === (unresolved === undefined)) {
      throw new TypeError(`${label} must provide exactly one of source or unresolved`);
    }
    const expectation = member.expectation ?? 'required';
    if (expectation !== 'required' && expectation !== 'optional') {
      throw new TypeError(`${label}.expectation must be required or optional`);
    }
    const discoveryEdges = normalizeStringArray(
      member.discoveryEdges ?? [],
      `${label}.discoveryEdges`
    );
    if (source !== undefined) {
      if (source === null || (typeof source !== 'object' && typeof source !== 'function')
        || typeof (source as { readonly mount?: unknown }).mount !== 'function') {
        throw new TypeError(`${label}.source must provide a mount function`);
      }
      sources.push({
        kind: 'mountable',
        source: source as MountableDatabaseSource,
        expectation,
        discoveryEdges
      });
      continue;
    }
    if (unresolved === null || typeof unresolved !== 'object' || Array.isArray(unresolved)) {
      throw new TypeError(`${label}.unresolved must be an object`);
    }
    const { attachmentId, sourceId } = unresolved as {
      readonly attachmentId?: unknown;
      readonly sourceId?: unknown;
    };
    if (typeof attachmentId !== 'string' || attachmentId.length === 0
      || typeof sourceId !== 'string' || sourceId.length === 0) {
      throw new TypeError(`${label}.unresolved IDs must be non-empty strings`);
    }
    sources.push({
      kind: 'unresolved',
      attachmentId,
      sourceId,
      expectation,
      discoveryEdges
    });
  }
  return sources;
};

const normalizeStringArray = (input: unknown, label: string): readonly string[] => {
  if (!Array.isArray(input)) throw new TypeError(`${label} must be an array of strings`);
  const values: string[] = [];
  const valueCount = input.length;
  for (let index = 0; index < valueCount; index += 1) {
    if (!Object.hasOwn(input, index)) {
      throw new TypeError(`${label} must be a dense array of strings`);
    }
    const value = input[index];
    if (typeof value !== 'string') throw new TypeError(`${label} must be a dense array of strings`);
    values.push(value);
  }
  return Object.freeze([...new Set(values)].sort());
};
