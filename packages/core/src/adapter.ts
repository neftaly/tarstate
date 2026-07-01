import type { TarstateDiagnostic } from './diagnostics.js';
import { composeSources, isRelationSource } from './source.js';
import type { RelationRef } from './schema.js';
import type { MaybePromise, RelationSource } from './source.js';
import type { WritePatch } from './write.js';
import { stubDiagnostic } from './stub.js';

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
  result: RelationApplyResult<Version>,
  patchCount: number
): RelationApplyResult<Version> {
  if (result.status === 'rejected') {
    return {
      ...result,
      patches: patchCount,
      applied: 0,
      deltas: []
    };
  }

  return { ...result, patches: patchCount };
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

  const relationSource = composeSources(...sources);
  return {
    rows: relationSource.rows,
    ...(relationSource.relationNames === undefined ? {} : { relationNames: relationSource.relationNames }),
    ...(relationSource.lookup === undefined ? {} : { lookup: relationSource.lookup }),
    ...(relationSource.rangeLookup === undefined ? {} : { rangeLookup: relationSource.rangeLookup }),
    ...(relationSource.diagnostics === undefined ? {} : { diagnostics: relationSource.diagnostics }),
    ...(sources.some((candidate) => candidate.version !== undefined)
      ? {
          version: async () => {
            const versions: unknown[] = [];
            for (const candidate of sources) {
              versions.push(await candidate.version?.());
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
    apply: (patches) => Promise.resolve(rejectedResult(patches.length, 'composed runtime apply is stubbed'))
  };
}

function rejectedResult<Version>(patches: number, message: string, detail?: unknown): RelationApplyResult<Version> {
  return {
    status: 'rejected',
    patches,
    applied: 0,
    deltas: [],
    diagnostics: [{ ...stubDiagnostic('adapter'), message, ...(detail === undefined ? {} : { detail }) }]
  };
}

function versionDiagnostic(detail: unknown): TarstateDiagnostic {
  return {
    code: 'source_error',
    message: 'adapter source version failed',
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
