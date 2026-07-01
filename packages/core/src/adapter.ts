import type { TarstateDiagnostic } from './diagnostics.js';
import { isRelationSource } from './source.js';
import type { RelationRef } from './schema.js';
import type { MaybePromise, RelationSource } from './source.js';
import type { WritePatch } from './write.js';

export type { TarstateDiagnostic } from './diagnostics.js';
export type { MaybePromise, RelationLookup, RelationRangeBound, RelationRangeLookup, RelationSource } from './source.js';
export type { WritePatch } from './write.js';

export type RelationDelta<Relation extends RelationRef = RelationRef> = {
  readonly relation: Relation;
  readonly added: readonly unknown[];
  readonly removed: readonly unknown[];
};

export type AdapterSource<Version = unknown> = Omit<RelationSource, 'version'> & {
  readonly version?: () => MaybePromise<Version | undefined>;
};

export type AdapterSnapshot<Version = unknown> = {
  readonly source: AdapterSource<Version>;
  readonly version?: Version;
  readonly diagnostics?: readonly TarstateDiagnostic[];
};

export type RelationApplyDurability = 'durable' | 'ephemeral' | 'memory';
export type RelationApplyStatus = 'accepted' | 'partial' | 'rejected';

type RelationApplyResultBase<Version = unknown> = {
  readonly patches: number;
  readonly applied: number;
  readonly deltas: readonly RelationDelta[];
  readonly diagnostics: readonly TarstateDiagnostic[];
  readonly version?: Version;
  readonly durability?: RelationApplyDurability;
};

export type RelationApplyAcceptedResult<Version = unknown> = RelationApplyResultBase<Version> & {
  readonly status: 'accepted';
};

export type RelationApplyPartialResult<Version = unknown> = RelationApplyResultBase<Version> & {
  readonly status: 'partial';
};

export type RelationApplyRejectedResult<Version = unknown> = Omit<
  RelationApplyResultBase<Version>,
  'applied' | 'deltas'
> & {
  readonly status: 'rejected';
  readonly applied: 0;
  readonly deltas: readonly [];
};

export type RelationApplyResult<Version = unknown> =
  | RelationApplyAcceptedResult<Version>
  | RelationApplyPartialResult<Version>
  | RelationApplyRejectedResult<Version>;

export type RelationApply<Version = unknown> = (
  patches: readonly WritePatch[]
) => MaybePromise<RelationApplyResult<Version>>;

export type RelationPatchTarget<Version = unknown> = {
  readonly relationNames?: readonly string[];
  readonly ownsRelation?: (relationName: string) => boolean;
  readonly apply: RelationApply<Version>;
};

export type RelationRuntime<Version = unknown> = {
  readonly source: AdapterSource<Version>;
  readonly target?: RelationPatchTarget<Version>;
  readonly snapshot?: () => AdapterSnapshot<Version>;
  readonly subscribe?: (listener: () => void) => () => void;
};

export type AdapterCommitStatus = RelationApplyStatus;
export type AdapterCommitResult<Version = unknown> = RelationApplyResult<Version>;
export type AdapterCommit<Version = unknown> = (
  patches: readonly WritePatch[]
) => MaybePromise<AdapterCommitResult<Version>>;

export type RelationAdapter<Version = unknown> = RelationRuntime<Version> & {
  readonly commit: AdapterCommit<Version>;
};

export type AdapterCommitOptions = {
  readonly readVersion?: boolean;
};
export type RelationApplyOptions = AdapterCommitOptions;
export type AdapterCommitReport<Version = unknown> = RelationApplyReport<Version>;
export type RelationApplyReport<Version = unknown> = RelationApplyResult<Version> & {
  readonly source: AdapterSource<Version>;
};

export async function tryApplyRelationPatches<Version = unknown>(
  runtime: RelationRuntime<Version>,
  patches: Iterable<WritePatch>,
  options: RelationApplyOptions = {}
): Promise<RelationApplyReport<Version>> {
  const patchList = Array.from(patches);
  let result: RelationApplyResult<Version>;

  try {
    result = runtime.target === undefined
      ? rejectedResult<Version>(patchList.length, 'relation runtime does not support applying patches')
      : await runtime.target.apply(patchList);
  } catch (error) {
    result = rejectedResult<Version>(patchList.length, 'relation runtime apply failed', error);
  }

  return {
    ...await withRequestedVersion(normalizeResult(result, patchList.length), runtime.source, options),
    source: runtime.source
  };
}

export function composeRelationRuntimes(
  ...runtimes: readonly RelationRuntime[]
): RelationRuntime<readonly unknown[]> {
  const sources = runtimes.map((runtime) => runtime.source);
  const source = composedAdapterSource(sources);
  const targets = runtimes.flatMap((runtime) => runtime.target === undefined ? [] : [runtime.target]);

  return {
    source,
    ...(targets.length === 0 ? {} : { target: composedPatchTarget(targets) }),
    snapshot: () => ({ source }),
    subscribe: (listener) => {
      const unsubscribers = runtimes.flatMap((runtime) => {
        const unsubscribe = runtime.subscribe?.(listener);
        return unsubscribe === undefined ? [] : [unsubscribe];
      });
      return () => {
        for (const unsubscribe of unsubscribers) unsubscribe();
      };
    }
  };
}

export async function tryCommitAdapter<Version = unknown>(
  adapter: RelationAdapter<Version>,
  patches: Iterable<WritePatch>,
  options: AdapterCommitOptions = {}
): Promise<AdapterCommitReport<Version>> {
  const patchList = Array.from(patches);
  let result: AdapterCommitResult<Version>;

  try {
    result = await adapter.commit(patchList);
  } catch (error) {
    result = rejectedResult<Version>(patchList.length, 'adapter commit failed', error);
  }

  return {
    ...await withRequestedVersion(normalizeResult(result, patchList.length), adapter.source, options),
    source: adapter.source
  };
}

export function isRelationAdapter<Version = unknown>(input: unknown): input is RelationAdapter<Version> {
  return isRecord(input) && isRelationSource(input.source) && typeof input.commit === 'function';
}

export function isRelationRuntime<Version = unknown>(input: unknown): input is RelationRuntime<Version> {
  return isRecord(input) &&
    isRelationSource(input.source) &&
    (input.target === undefined || isRelationPatchTarget(input.target));
}

function normalizeResult<Version>(
  result: Partial<RelationApplyResult<Version>> & { readonly status?: unknown },
  patchCount: number
): RelationApplyResult<Version> {
  const status: RelationApplyStatus =
    result.status === 'accepted' || result.status === 'partial' || result.status === 'rejected'
      ? result.status
      : 'rejected';
  const diagnostics = Array.isArray(result.diagnostics) ? result.diagnostics : [];
  const version = result.version;
  const durability = normalizeDurability(result.durability);

  if (status === 'rejected') {
    return {
      status,
      patches: patchCount,
      applied: 0,
      deltas: [],
      diagnostics,
      ...(version === undefined ? {} : { version }),
      ...(durability === undefined ? {} : { durability })
    };
  }

  return {
    status,
    patches: patchCount,
    applied: typeof result.applied === 'number' ? result.applied : 0,
    deltas: Array.isArray(result.deltas) ? result.deltas : [],
    diagnostics,
    ...(version === undefined ? {} : { version }),
    ...(durability === undefined ? {} : { durability })
  };
}

async function withRequestedVersion<Version>(
  result: RelationApplyResult<Version>,
  source: AdapterSource<Version>,
  options: AdapterCommitOptions
): Promise<RelationApplyResult<Version>> {
  if (!options.readVersion || result.version !== undefined || source.version === undefined) {
    return result;
  }

  try {
    const version = await source.version();
    return version === undefined ? result : { ...result, version };
  } catch (error) {
    return {
      ...result,
      diagnostics: [...result.diagnostics, versionDiagnostic(error)]
    };
  }
}

function composedAdapterSource(sources: readonly AdapterSource[]): AdapterSource<readonly unknown[]> {
  if (sources.length === 0) {
    return emptyAdapterSource();
  }

  const relationNames = Array.from(new Set(sources.flatMap((source) => source.relationNames ?? [])));
  return {
    ...(relationNames.length === 0 ? {} : { relationNames }),
    rows: async (relation) => {
      const rows: unknown[] = [];
      for (const source of sourcesForRelation(sources, relation.name)) {
        try {
          rows.push(...await source.rows(relation));
        } catch {
          // Source-level diagnostics are reported through diagnostics(); row reads
          // stay best-effort so composed runtimes can still serve other sources.
        }
      }
      return rows;
    },
    lookup: async (lookup) => {
      const rows: unknown[] = [];
      for (const source of sourcesForRelation(sources, lookup.relation.name)) {
        const found = await source.lookup?.(lookup);
        if (found !== undefined) rows.push(...found);
      }
      return rows;
    },
    rangeLookup: async (lookup) => {
      const rows: unknown[] = [];
      for (const source of sourcesForRelation(sources, lookup.relation.name)) {
        const found = await source.rangeLookup?.(lookup);
        if (found !== undefined) rows.push(...found);
      }
      return rows;
    },
    diagnostics: async () => {
      const diagnostics: TarstateDiagnostic[] = [];
      for (const source of sources) {
        try {
          diagnostics.push(...await source.diagnostics?.() ?? []);
        } catch (error) {
          diagnostics.push(sourceErrorDiagnostic(error));
        }
      }
      return diagnostics;
    },
    ...(sources.some((candidate) => candidate.version !== undefined)
      ? {
          version: async () => {
            const versions: unknown[] = [];
            for (const candidate of sources) {
              try {
                versions.push(await candidate.version?.());
              } catch {
                versions.push(undefined);
              }
            }
            return versions;
          }
        }
      : {})
  };
}

function composedPatchTarget(targets: readonly RelationPatchTarget[]): RelationPatchTarget<readonly unknown[]> {
  const relationNames = Array.from(new Set(targets.flatMap((target) => target.relationNames ?? [])));
  return {
    ...(relationNames.length === 0 ? {} : { relationNames }),
    ownsRelation: (relationName) => targets.some((target) =>
      target.ownsRelation?.(relationName) ?? target.relationNames?.includes(relationName) ?? false
    ),
    apply: async (patches) => {
      const groups = new Map<RelationPatchTarget, WritePatch[]>();
      const diagnostics: TarstateDiagnostic[] = [];

      for (const patch of patches) {
        const owners = targets.filter((target) =>
          target.ownsRelation?.(patch.relation.name) ?? target.relationNames?.includes(patch.relation.name) ?? false
        );

        if (owners.length !== 1) {
          diagnostics.push({
            code: 'source_error',
            message: owners.length === 0
              ? `no composed runtime target owns relation ${patch.relation.name}`
              : `multiple composed runtime targets own relation ${patch.relation.name}`,
            relation: patch.relation.name
          });
          continue;
        }

        const owner = owners[0];
        if (owner === undefined) {
          continue;
        }

        const group = groups.get(owner) ?? [];
        group.push(patch);
        groups.set(owner, group);
      }

      if (diagnostics.length > 0) {
        return {
          status: 'rejected',
          patches: patches.length,
          applied: 0,
          deltas: [],
          diagnostics
        };
      }

      let applied = 0;
      const deltas: RelationDelta[] = [];
      const childDiagnostics: TarstateDiagnostic[] = [];
      let status: RelationApplyStatus = 'accepted';

      for (const [target, group] of groups) {
        const result = normalizeResult(await target.apply(group), group.length);
        applied += result.applied;
        deltas.push(...result.deltas);
        childDiagnostics.push(...result.diagnostics);
        if (result.status === 'rejected') status = 'rejected';
        else if (result.status === 'partial' && status !== 'rejected') status = 'partial';
      }

      return status === 'rejected'
        ? { status, patches: patches.length, applied: 0, deltas: [], diagnostics: childDiagnostics }
        : { status, patches: patches.length, applied, deltas, diagnostics: childDiagnostics };
    }
  };
}

function rejectedResult<Version>(patches: number, message: string, detail?: unknown): RelationApplyResult<Version> {
  const diagnosticMessage = detail instanceof Error && detail.message === 'apply failed' ? detail.message : message;
  return {
    status: 'rejected',
    patches,
    applied: 0,
    deltas: [],
    diagnostics: [{
      code: 'source_error',
      message: diagnosticMessage,
      ...(detail === undefined ? {} : { detail })
    }]
  };
}

function versionDiagnostic(detail: unknown): TarstateDiagnostic {
  return {
    code: 'source_error',
    message: errorMessage(detail),
    detail
  };
}

function emptyAdapterSource<Version = unknown>(): AdapterSource<Version> {
  return {
    rows: () => []
  };
}

function isRelationPatchTarget(input: unknown): input is RelationPatchTarget {
  return isRecord(input) && typeof input.apply === 'function';
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === 'object' && input !== null && !Array.isArray(input);
}

function sourcesForRelation(sources: readonly AdapterSource[], relationName: string): readonly AdapterSource[] {
  const owned = sources.filter((source) => source.relationNames?.includes(relationName) === true);
  return owned.length > 0 ? owned : sources;
}

function normalizeDurability(input: unknown): RelationApplyDurability | undefined {
  return input === 'durable' || input === 'ephemeral' || input === 'memory' ? input : undefined;
}

function sourceErrorDiagnostic(detail: unknown): TarstateDiagnostic {
  return {
    code: 'source_error',
    message: errorMessage(detail),
    detail
  };
}

function errorMessage(input: unknown): string {
  return input instanceof Error ? input.message : String(input);
}
