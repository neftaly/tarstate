import { AttachmentCatalog, DatasetMembership, type DatasetMember } from '../database.js';
import { createIncrementalDatabaseQueryMaintenance } from '../internal-observer-query-maintenance.js';
import { runObserverCleanups, type ObserverDiagnosticReporter } from '../observer-diagnostics.js';
import { DatabaseView, type ObserverChange, type ObserverSnapshot, type QueryObserver } from '../observer.js';
import type { PreparedPlanParameters, PreparedPlanRow } from '../query/authoring.js';
import type { PreparedPlan } from '../query/plan-contract.js';
import type { QueryNode, QueryRecord, RelationInput } from '../query/model.js';
import type { JsonValue } from '../value.js';

export type DatabaseSourceMountOptions = {
  readonly discoveryEdges?: readonly string[];
};

export type DatabaseSourceMountLease = {
  readonly attachmentId: string;
  readonly sourceId: string;
  readonly discoveryEdges: readonly string[];
  readonly close: () => void;
};

/** Minimal structural protocol shared by official and application database sources. */
export type MountableDatabaseSource = {
  readonly mount: (
    catalog: AttachmentCatalog,
    options?: DatabaseSourceMountOptions
  ) => DatabaseSourceMountLease | Promise<DatabaseSourceMountLease>;
};

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

export type OpenDatabaseQueryOptions<Plan extends PreparedPlan<QueryNode>> = {
  readonly sources: readonly DatabaseQuerySource[];
  readonly plan: Plan;
  readonly queryAuthorityScope: string;
  /** Defaults to allowing only sources with the same authority scope. */
  readonly canRead?: (context: DatabaseQueryReadContext) => boolean;
  readonly allowPartial?: boolean;
  readonly onDiagnostic?: ObserverDiagnosticReporter;
} & SessionParameterOptions<Plan>;

/** One owned query lifecycle over mounted or unresolved sources and incremental maintenance. */
export type DatabaseQuerySession<Row> = QueryObserver<Row>;

export const openDatabaseQuery = async <Plan extends PreparedPlan<QueryNode>>(
  options: OpenDatabaseQueryOptions<Plan>
): Promise<DatabaseQuerySession<SessionRow<Plan>>> => {
  if (typeof options.queryAuthorityScope !== 'string' || options.queryAuthorityScope.length === 0) {
    throw new TypeError('queryAuthorityScope must be a non-empty string');
  }
  const catalog = new AttachmentCatalog(
    options.onDiagnostic === undefined ? {} : { onDiagnostic: options.onDiagnostic }
  );
  const leases: DatabaseSourceMountLease[] = [];
  let database: DatabaseView<QueryNode, QueryRecord, readonly RelationInput[]> | undefined;
  let observer: QueryObserver<SessionRow<Plan>> | undefined;

  try {
    const members: DatasetMember[] = [];
    for (const member of options.sources) {
      if (member.unresolved !== undefined) {
        if (member.unresolved.attachmentId.length === 0 || member.unresolved.sourceId.length === 0) {
          throw new TypeError('Unresolved database source IDs must not be empty');
        }
        members.push({
          attachmentId: member.unresolved.attachmentId,
          sourceId: member.unresolved.sourceId,
          expectation: member.expectation ?? 'required',
          discoveryEdges: member.discoveryEdges ?? []
        });
        continue;
      }
      const lease = await member.source.mount(catalog, {
        discoveryEdges: member.discoveryEdges ?? []
      });
      leases.push(lease);
      if (catalog.get(lease.attachmentId)?.sourceId !== lease.sourceId) {
        throw new TypeError('Mounted database source does not identify its catalog attachment');
      }
      members.push({
        attachmentId: lease.attachmentId,
        sourceId: lease.sourceId,
        expectation: member.expectation ?? 'required',
        discoveryEdges: lease.discoveryEdges
      } as const);
    }

    const membership = new DatasetMembership({
      datasetId: options.plan.datasetId,
      state: 'settled',
      members,
      ...(options.onDiagnostic === undefined ? {} : { onDiagnostic: options.onDiagnostic })
    });
    database = new DatabaseView({
      authorityScope: options.queryAuthorityScope,
      authorityFingerprint: options.plan.authorityFingerprint,
      registryFingerprint: options.plan.registryFingerprint,
      attachments: catalog,
      datasets: [membership],
      canRead: (queryAuthorityScope, sourceAuthorityScope, attachmentId) => {
        if (options.canRead === undefined) {
          return queryAuthorityScope === sourceAuthorityScope;
        }
        return options.canRead({ queryAuthorityScope, sourceAuthorityScope, attachmentId });
      },
      createQueryMaintenance: createIncrementalDatabaseQueryMaintenance(),
      ...(options.onDiagnostic === undefined ? {} : { onDiagnostic: options.onDiagnostic })
    });
    observer = database.observe({
      plan: options.plan,
      parameters: (options.parameters ?? {}) as Readonly<Record<string, JsonValue>>,
      ...(options.allowPartial === undefined ? {} : { allowPartial: options.allowPartial })
    });
  } catch (error) {
    const cleanups = [
      ...(observer === undefined ? [] : [() => observer?.close()]),
      ...(database === undefined ? [] : [() => database?.close()]),
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
          ...[...leases].reverse().map((lease) => () => lease.close())
        ],
        { component: 'database-view', operation: 'close-database-query' },
        options.onDiagnostic
      );
    }
  });
};
