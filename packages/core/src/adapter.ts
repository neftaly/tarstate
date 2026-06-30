import { composeSources, isRelationSource } from './source.js';
import type { TarstateDiagnostic } from './diagnostics.js';
import type { RelationDelta } from './delta.js';
import type { MaybePromise, RelationSource } from './source.js';
import type { WritePatch } from './write.js';

export type { TarstateDiagnostic } from './diagnostics.js';
export type { RelationDelta } from './delta.js';
export type { MaybePromise, RelationLookup, RelationRangeBound, RelationRangeLookup, RelationSource } from './source.js';
export type { WritePatch } from './write.js';

/** Relation source exposed by a storage adapter, with typed opaque version identity. */
export type AdapterSource<Version = unknown> = Omit<RelationSource, 'version'> & {
  readonly version?: () => MaybePromise<Version>;
};

/** Read-consistent adapter snapshot. The source should close over one backing-state version. */
export type AdapterSnapshot<Version = unknown> = {
  readonly source: AdapterSource<Version>;
  readonly version?: Version;
  readonly diagnostics?: readonly TarstateDiagnostic[];
};

/** How an apply target reflects accepted patches. */
export type RelationApplyDurability = 'durable' | 'ephemeral' | 'memory' | 'external';

/** Authoritative outcome returned after a relation patch target attempts to apply a batch. */
export type RelationApplyStatus = 'accepted' | 'partial' | 'rejected';

type RelationApplyResultBase<Version = unknown> = {
  /** Number of patches the target received. */
  readonly patches: number;
  /** Number of patch effects accepted and reflected by the target. */
  readonly applied: number;
  /** Relation-level row changes reflected by the attempt. Rejected attempts leave this empty. */
  readonly deltas: readonly RelationDelta[];
  /** Target-readable diagnostics. `status` determines whether diagnostics prevented a full apply. */
  readonly diagnostics: readonly TarstateDiagnostic[];
  /** Optional target snapshot/version after the attempt. */
  readonly version?: Version;
  /** Optional target durability/lifecycle hint. */
  readonly durability?: RelationApplyDurability;
};

/** Result for a fully accepted patch batch. */
export type RelationApplyAcceptedResult<Version = unknown> = RelationApplyResultBase<Version> & {
  readonly status: 'accepted';
  /** Whether the full patch batch was accepted. */
  readonly accepted: true;
};

/** Result for target-owned partial apply semantics. */
export type RelationApplyPartialResult<Version = unknown> = RelationApplyResultBase<Version> & {
  readonly status: 'partial';
  /** The full patch batch was not accepted; `applied` and `deltas` describe reflected effects. */
  readonly accepted: false;
};

/** Result for an all-or-nothing rejection with no reflected patch effects. */
export type RelationApplyRejectedResult<Version = unknown> = Omit<
  RelationApplyResultBase<Version>,
  'applied' | 'deltas'
> & {
  readonly status: 'rejected';
  readonly accepted: false;
  readonly applied: 0;
  readonly deltas: readonly [];
};

/** Result returned after a relation patch target attempts to apply a patch batch. */
export type RelationApplyResult<Version = unknown> =
  | RelationApplyAcceptedResult<Version>
  | RelationApplyPartialResult<Version>
  | RelationApplyRejectedResult<Version>;

/** Generic patch application function for durable, ephemeral, memory, or external targets. */
export type RelationApply<Version = unknown> = (
  patches: readonly WritePatch[]
) => MaybePromise<RelationApplyResult<Version>>;

/** Generic write-capable patch target. */
export type RelationPatchTarget<Version = unknown> = {
  readonly apply: RelationApply<Version>;
};

/** Generic relation runtime: read source plus optional patch target and host invalidation. */
export type RelationRuntime<Version = unknown> = {
  readonly source: AdapterSource<Version>;
  readonly target?: RelationPatchTarget<Version>;
  readonly snapshot?: () => AdapterSnapshot<Version>;
  readonly subscribe?: (listener: () => void) => () => void;
};

/** Authoritative outcome returned after an adapter attempts to commit a patch batch. */
export type AdapterCommitStatus = 'committed' | 'partial' | 'rejected';

type AdapterCommitResultBase<Version = unknown> = {
  /** Number of patches the adapter received. */
  readonly patches: number;
  /** Number of patch effects accepted and reflected in the backing store. */
  readonly applied: number;
  /** Relation-level row changes reflected by the commit attempt. Rejected commits leave this empty. */
  readonly deltas: readonly RelationDelta[];
  /** Adapter-readable diagnostics. `status` determines whether diagnostics prevented a full commit. */
  readonly diagnostics: readonly TarstateDiagnostic[];
  /** Optional adapter snapshot/version after the commit attempt. */
  readonly version?: Version;
};

/** Result for a fully accepted patch batch. */
export type AdapterCommittedResult<Version = unknown> = AdapterCommitResultBase<Version> & {
  readonly status: 'committed';
  /** Whether the full patch batch was accepted. */
  readonly committed: true;
};

/** Result for adapter-owned partial commit semantics. */
export type AdapterPartialCommitResult<Version = unknown> = AdapterCommitResultBase<Version> & {
  readonly status: 'partial';
  /** The full patch batch was not accepted; `applied` and `deltas` describe reflected effects. */
  readonly committed: false;
};

/** Result for an all-or-nothing rejection with no reflected patch effects. */
export type AdapterRejectedCommitResult<Version = unknown> = Omit<
  AdapterCommitResultBase<Version>,
  'applied' | 'deltas'
> & {
  readonly status: 'rejected';
  readonly committed: false;
  readonly applied: 0;
  readonly deltas: readonly [];
};

/** Result returned after an adapter attempts to commit a patch batch. */
export type AdapterCommitResult<Version = unknown> =
  | AdapterCommittedResult<Version>
  | AdapterPartialCommitResult<Version>
  | AdapterRejectedCommitResult<Version>;

/** Adapter commit function for translating write patches into a backing store. */
export type AdapterCommit<Version = unknown> = (
  patches: readonly WritePatch[]
) => MaybePromise<AdapterCommitResult<Version>>;

/** Minimal read/write contract expected from storage adapters. */
export type RelationAdapter<Version = unknown> = RelationRuntime<Version> & {
  readonly commit: AdapterCommit<Version>;
};

/** Options for the adapter commit helper. */
export type AdapterCommitOptions = {
  /** Read `adapter.source.version()` when the commit result omits a version. Defaults to true. */
  readonly readVersion?: boolean;
};

export type RelationApplyOptions = AdapterCommitOptions;

/** Normalized adapter commit result paired with the source that reflects the commit attempt. */
export type AdapterCommitReport<Version = unknown> = AdapterCommitResult<Version> & {
  readonly source: AdapterSource<Version>;
};

/** Normalized relation apply result paired with the source that reflects the apply attempt. */
export type RelationApplyReport<Version = unknown> = RelationApplyResult<Version> & {
  readonly source: AdapterSource<Version>;
};

/** Convert an adapter commit outcome into the equivalent relation target apply outcome. */
export function relationApplyResultFromAdapterCommit<Version = unknown>(
  result: AdapterCommitResult<Version>
): RelationApplyResult<Version> {
  const base = {
    patches: result.patches,
    diagnostics: result.diagnostics,
    ...versionProperty(result.version)
  };

  switch (result.status) {
    case 'committed':
      return {
        ...base,
        status: 'accepted',
        accepted: true,
        applied: result.applied,
        deltas: result.deltas
      };
    case 'partial':
      return {
        ...base,
        status: 'partial',
        accepted: false,
        applied: result.applied,
        deltas: result.deltas
      };
    case 'rejected':
      return {
        ...base,
        status: 'rejected',
        accepted: false,
        applied: 0,
        deltas: [] as const
      };
  }
}

/** Apply patches through a generic runtime target and normalize the result envelope. */
export async function tryApplyRelationPatches<Version = unknown>(
  runtime: RelationRuntime<Version>,
  patches: Iterable<WritePatch>,
  options: RelationApplyOptions = {}
): Promise<RelationApplyReport<Version>> {
  const patchList = Array.from(patches);
  const result = await applyRelationPatchesSafely(runtime.target, patchList);
  const versionedResult =
    options.readVersion === false ? result : await applyResultWithSourceVersion(runtime.source, result);

  return { ...versionedResult, source: runtime.source };
}

/** Compose independent relation runtimes into one read/write runtime. */
export function composeRelationRuntimes(
  ...runtimes: readonly RelationRuntime[]
): RelationRuntime<readonly unknown[]> {
  const source = composeAdapterSources(runtimes.map((runtime) => runtime.source));
  const targetRuntimes = runtimes.filter((runtime) => runtime.target !== undefined);

  return {
    source,
    ...(targetRuntimes.length === 0
      ? {}
      : { target: composedRelationPatchTarget(runtimes) }),
    snapshot: () => composedRuntimeSnapshot(runtimes),
    ...(runtimes.some((runtime) => runtime.subscribe !== undefined)
      ? { subscribe: composedRuntimeSubscribe(runtimes) }
      : {})
  };
}

/** Commit patches through an adapter and normalize the adapter-level result envelope. */
export async function tryCommitAdapter<Version = unknown>(
  adapter: RelationAdapter<Version>,
  patches: Iterable<WritePatch>,
  options: AdapterCommitOptions = {}
): Promise<AdapterCommitReport<Version>> {
  const patchList = Array.from(patches);
  const result = await commitAdapterSafely(adapter, patchList);
  const versionedResult =
    options.readVersion === false ? result : await resultWithSourceVersion(adapter.source, result);

  return { ...versionedResult, source: adapter.source };
}

/** Runtime guard for adapter-like objects. */
export function isRelationAdapter(input: unknown): input is RelationAdapter {
  if (!isRecord(input)) {
    return false;
  }

  return isRelationSource(input.source) && typeof input.commit === 'function';
}

/** Runtime guard for relation runtimes. */
export function isRelationRuntime(input: unknown): input is RelationRuntime {
  if (!isRecord(input) || !isRelationSource(input.source)) {
    return false;
  }

  const target = input.target;
  return target === undefined || (isRecord(target) && typeof target.apply === 'function');
}

function composedRuntimeSnapshot(runtimes: readonly RelationRuntime[]): AdapterSnapshot<readonly unknown[]> {
  const snapshots: AdapterSnapshot[] = runtimes.map((runtime) => runtime.snapshot?.() ?? { source: runtime.source });
  const versions = snapshots.map((snapshot) => snapshot.version);
  const allVersionsKnown = versions.every((version) => version !== undefined);
  const diagnostics = snapshots.flatMap((snapshot) => snapshot.diagnostics ?? []);

  return {
    source: composeAdapterSources(snapshots.map((snapshot) => snapshot.source)),
    ...(allVersionsKnown ? { version: versions } : {}),
    ...(diagnostics.length === 0 ? {} : { diagnostics })
  };
}

function composeAdapterSources(sources: readonly AdapterSource[]): AdapterSource<readonly unknown[]> {
  return {
    ...composeSources(...sources),
    version: async () => Promise.all(sources.map(async (source) => source.version?.()))
  };
}

function composedRuntimeSubscribe(
  runtimes: readonly RelationRuntime[]
): (listener: () => void) => () => void {
  return (listener) => {
    const unsubscribe = runtimes.flatMap((runtime) => {
      const unsubscribeRuntime = runtime.subscribe?.(listener);
      return unsubscribeRuntime === undefined ? [] : [unsubscribeRuntime];
    });

    return () => {
      for (const item of unsubscribe) {
        item();
      }
    };
  };
}

function composedRelationPatchTarget(
  runtimes: readonly RelationRuntime[]
): RelationPatchTarget<readonly unknown[]> {
  return {
    apply: async (patches) => applyComposedRelationPatches(runtimes, patches)
  };
}

async function applyComposedRelationPatches(
  runtimes: readonly RelationRuntime[],
  patches: readonly WritePatch[]
): Promise<RelationApplyResult<readonly unknown[]>> {
  const routing = routeRelationPatches(runtimes, patches);

  if (routing.diagnostics.length > 0) {
    return {
      status: 'rejected',
      accepted: false,
      patches: patches.length,
      applied: 0,
      deltas: [],
      diagnostics: routing.diagnostics
    };
  }

  const results: RelationApplyResult[] = [];

  for (const [runtimeIndex, routedPatches] of routing.patchesByRuntime) {
    const runtime = runtimes[runtimeIndex] as RelationRuntime;
    results.push(await applyRelationPatchesSafely(runtime.target, routedPatches));
  }

  return composeRelationApplyResults(patches.length, results);
}

function routeRelationPatches(
  runtimes: readonly RelationRuntime[],
  patches: readonly WritePatch[]
): {
  readonly patchesByRuntime: ReadonlyMap<number, readonly WritePatch[]>;
  readonly diagnostics: readonly TarstateDiagnostic[];
} {
  const targetIndexes = runtimes.flatMap((runtime, index) => (runtime.target === undefined ? [] : [index]));
  const mutablePatchesByRuntime = new Map<number, WritePatch[]>();
  const diagnostics: TarstateDiagnostic[] = [];

  for (const patch of patches) {
    const runtimeIndex = routeRelationPatch(runtimes, targetIndexes, patch);

    if (runtimeIndex === undefined) {
      diagnostics.push(noRelationPatchTargetDiagnostic(patch));
      continue;
    }

    const runtimePatches = mutablePatchesByRuntime.get(runtimeIndex);
    if (runtimePatches === undefined) {
      mutablePatchesByRuntime.set(runtimeIndex, [patch]);
    } else {
      runtimePatches.push(patch);
    }
  }

  return { patchesByRuntime: mutablePatchesByRuntime, diagnostics };
}

function routeRelationPatch(
  runtimes: readonly RelationRuntime[],
  targetIndexes: readonly number[],
  patch: WritePatch
): number | undefined {
  if (targetIndexes.length === 1) {
    const index = targetIndexes[0] as number;
    const names = runtimes[index]?.source.relationNames;
    return names === undefined || names.includes(patch.relation.name) ? index : undefined;
  }

  const explicitMatches = targetIndexes.filter((index) =>
    runtimes[index]?.source.relationNames?.includes(patch.relation.name) === true
  );

  return explicitMatches.length === 1 ? explicitMatches[0] : undefined;
}

function noRelationPatchTargetDiagnostic(patch: WritePatch): TarstateDiagnostic {
  return {
    code: 'source_error',
    message: `no unambiguous relation runtime target owns relation ${patch.relation.name}`,
    relation: patch.relation.name
  };
}

function composeRelationApplyResults(
  patchCount: number,
  results: readonly RelationApplyResult[]
): RelationApplyResult<readonly unknown[]> {
  const applied = results.reduce((total, result) => total + result.applied, 0);
  const deltas = results.flatMap((result) => result.deltas);
  const diagnostics = results.flatMap((result) => result.diagnostics);
  const allAccepted = results.every((result) => result.status === 'accepted');

  if (allAccepted) {
    return {
      status: 'accepted',
      accepted: true,
      patches: patchCount,
      applied,
      deltas,
      diagnostics
    };
  }

  if (applied > 0 || deltas.length > 0 || results.some((result) => result.status === 'partial')) {
    return {
      status: 'partial',
      accepted: false,
      patches: patchCount,
      applied,
      deltas,
      diagnostics
    };
  }

  return {
    status: 'rejected',
    accepted: false,
    patches: patchCount,
    applied: 0,
    deltas: [],
    diagnostics
  };
}

function relationTargetUnavailableResult<Version>(patchCount: number): RelationApplyResult<Version> {
  return {
    status: 'rejected',
    accepted: false,
    patches: patchCount,
    applied: 0,
    deltas: [],
    diagnostics: [
      {
        code: 'source_error',
        message: 'relation runtime does not support applying patches'
      }
    ]
  };
}

async function applyRelationPatchesSafely<Version>(
  target: RelationPatchTarget<Version> | undefined,
  patches: readonly WritePatch[]
): Promise<RelationApplyResult<Version>> {
  if (target === undefined) {
    return relationTargetUnavailableResult(patches.length);
  }

  try {
    return normalizeRelationApplyResult(await target.apply(patches), patches.length);
  } catch (error) {
    return rejectedRelationApplyResult(patches.length, error);
  }
}

function rejectedRelationApplyResult<Version>(
  patchCount: number,
  error: unknown
): RelationApplyResult<Version> {
  return {
    status: 'rejected',
    accepted: false,
    patches: patchCount,
    applied: 0,
    deltas: [],
    diagnostics: [
      {
        code: 'source_error',
        message: 'relation patch apply failed',
        detail: error
      }
    ]
  };
}

function normalizeRelationApplyResult<Version>(
  result: RelationApplyResult<Version>,
  patchCount: number
): RelationApplyResult<Version> {
  const status = relationApplyStatus(result);
  const base = {
    patches: patchCount,
    diagnostics: relationDiagnosticsArray(result),
    ...versionProperty(result.version),
    ...durabilityProperty(result.durability)
  };

  if (status === 'rejected') {
    return {
      ...base,
      status: 'rejected',
      accepted: false,
      applied: 0,
      deltas: [] as const
    };
  }

  if (status === 'accepted') {
    return {
      ...base,
      status: 'accepted',
      accepted: true,
      applied: relationAppliedCount(result),
      deltas: relationDeltasArray(result)
    };
  }

  return {
    ...base,
    status: 'partial',
    accepted: false,
    applied: relationAppliedCount(result),
    deltas: relationDeltasArray(result)
  };
}

function relationApplyStatus(result: RelationApplyResult): RelationApplyStatus {
  const status = unsafeRelationResultValue(result, 'status');

  if (status === 'accepted' || status === 'partial' || status === 'rejected') {
    return status;
  }

  if (unsafeRelationResultValue(result, 'accepted') === true) {
    return 'accepted';
  }

  return relationAppliedCount(result) > 0 || relationDeltasArray(result).length > 0 ? 'partial' : 'rejected';
}

async function applyResultWithSourceVersion<Version>(
  source: AdapterSource<Version>,
  result: RelationApplyResult<Version>
): Promise<RelationApplyResult<Version>> {
  if (result.version !== undefined || source.version === undefined) {
    return result;
  }

  try {
    const version = await source.version();
    return version === undefined ? result : withApplyVersion(result, version);
  } catch (error) {
    return withApplyDiagnostics(result, [
      ...result.diagnostics,
      {
        code: 'source_error',
        message: 'adapter source version failed',
        detail: error
      }
    ]);
  }
}

function withApplyVersion<Version>(
  result: RelationApplyResult<Version>,
  version: Version
): RelationApplyResult<Version> {
  return { ...result, version };
}

function withApplyDiagnostics<Version>(
  result: RelationApplyResult<Version>,
  diagnostics: readonly TarstateDiagnostic[]
): RelationApplyResult<Version> {
  return { ...result, diagnostics };
}

async function commitAdapterSafely<Version>(
  adapter: RelationAdapter<Version>,
  patches: readonly WritePatch[]
): Promise<AdapterCommitResult<Version>> {
  try {
    return normalizeAdapterCommitResult(await adapter.commit(patches), patches.length);
  } catch (error) {
    return rejectedAdapterCommitResult(patches.length, error);
  }
}

function rejectedAdapterCommitResult<Version>(
  patchCount: number,
  error: unknown
): AdapterCommitResult<Version> {
  return {
    status: 'rejected',
    committed: false,
    patches: patchCount,
    applied: 0,
    deltas: [],
    diagnostics: [
      {
        code: 'source_error',
        message: 'adapter commit failed',
        detail: error
      }
    ]
  };
}

function normalizeAdapterCommitResult<Version>(
  result: AdapterCommitResult<Version>,
  patchCount: number
): AdapterCommitResult<Version> {
  const status = adapterCommitStatus(result);
  const base = {
    patches: patchCount,
    diagnostics: diagnosticsArray(result),
    ...versionProperty(result.version)
  };

  if (status === 'rejected') {
    return {
      ...base,
      status: 'rejected',
      committed: false,
      applied: 0,
      deltas: [] as const
    };
  }

  if (status === 'committed') {
    return {
      ...base,
      status: 'committed',
      committed: true,
      applied: appliedCount(result),
      deltas: deltasArray(result)
    };
  }

  return {
    ...base,
    status: 'partial',
    committed: false,
    applied: appliedCount(result),
    deltas: deltasArray(result)
  };
}

function adapterCommitStatus(result: AdapterCommitResult): AdapterCommitStatus {
  const status = unsafeResultValue(result, 'status');

  if (status === 'committed' || status === 'partial' || status === 'rejected') {
    return status;
  }

  if (unsafeResultValue(result, 'committed') === true) {
    return 'committed';
  }

  return appliedCount(result) > 0 || deltasArray(result).length > 0 ? 'partial' : 'rejected';
}

async function resultWithSourceVersion<Version>(
  source: AdapterSource<Version>,
  result: AdapterCommitResult<Version>
): Promise<AdapterCommitResult<Version>> {
  if (result.version !== undefined || source.version === undefined) {
    return result;
  }

  try {
    const version = await source.version();
    return version === undefined ? result : withVersion(result, version);
  } catch (error) {
    return withDiagnostics(result, [
      ...result.diagnostics,
      {
        code: 'source_error',
        message: 'adapter source version failed',
        detail: error
      }
    ]);
  }
}

function withVersion<Version>(
  result: AdapterCommitResult<Version>,
  version: Version
): AdapterCommitResult<Version> {
  return { ...result, version };
}

function withDiagnostics<Version>(
  result: AdapterCommitResult<Version>,
  diagnostics: readonly TarstateDiagnostic[]
): AdapterCommitResult<Version> {
  return { ...result, diagnostics };
}

function versionProperty<Version>(version: Version | undefined): { readonly version?: Version } {
  return version === undefined ? {} : { version };
}

function durabilityProperty(
  durability: RelationApplyDurability | undefined
): { readonly durability?: RelationApplyDurability } {
  return durability === undefined ? {} : { durability };
}

function relationAppliedCount(result: RelationApplyResult): number {
  const applied = unsafeRelationResultValue(result, 'applied');
  return typeof applied === 'number' && Number.isFinite(applied) && applied >= 0 ? applied : 0;
}

function relationDeltasArray(result: RelationApplyResult): readonly RelationDelta[] {
  const deltas = unsafeRelationResultValue(result, 'deltas');
  return Array.isArray(deltas) ? (deltas as readonly RelationDelta[]) : [];
}

function relationDiagnosticsArray(result: RelationApplyResult): readonly TarstateDiagnostic[] {
  const diagnostics = unsafeRelationResultValue(result, 'diagnostics');
  return Array.isArray(diagnostics) ? (diagnostics as readonly TarstateDiagnostic[]) : [];
}

function unsafeRelationResultValue(result: RelationApplyResult, key: string): unknown {
  return (result as Record<string, unknown>)[key];
}

function appliedCount(result: AdapterCommitResult): number {
  const applied = unsafeResultValue(result, 'applied');
  return typeof applied === 'number' && Number.isFinite(applied) && applied >= 0 ? applied : 0;
}

function deltasArray(result: AdapterCommitResult): readonly RelationDelta[] {
  const deltas = unsafeResultValue(result, 'deltas');
  return Array.isArray(deltas) ? (deltas as readonly RelationDelta[]) : [];
}

function diagnosticsArray(result: AdapterCommitResult): readonly TarstateDiagnostic[] {
  const diagnostics = unsafeResultValue(result, 'diagnostics');
  return Array.isArray(diagnostics) ? (diagnostics as readonly TarstateDiagnostic[]) : [];
}

function unsafeResultValue(result: AdapterCommitResult, key: string): unknown {
  return (result as Record<string, unknown>)[key];
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === 'object' && input !== null && !Array.isArray(input);
}
