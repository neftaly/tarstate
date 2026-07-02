import * as Automerge from '@automerge/automerge';
import type {
  AdapterSnapshot,
  AdapterSource,
  RelationPatchTarget,
  RelationRuntime,
  TarstateDiagnostic
} from '@tarstate/core/adapter';
import { composeRelationRuntimes } from '@tarstate/core/adapter';
import type { RelationRef } from '@tarstate/core/schema';
import type { WritePatch } from '@tarstate/core/write';

export type AutomergeMapPath = readonly string[];

export type AutomergeMapRelation<Relation extends RelationRef = RelationRef> = {
  readonly relation: Relation;
  readonly path: AutomergeMapPath;
};

export type AutomergeMapStorageCodec = 'map-v1';

export type AutomergeMapStorageOptions = {
  readonly codec?: AutomergeMapStorageCodec;
};

export type AutomergeMapAdapterOptions<
  DocumentShape extends object = Record<string, unknown>
> = {
  readonly doc: Automerge.Doc<DocumentShape>;
  readonly relations: readonly AutomergeMapRelation[];
  readonly onDocChange?: (doc: Automerge.Doc<DocumentShape>) => void;
  readonly changeMessage?: string | ((patches: readonly WritePatch[]) => string | undefined);
  readonly storage?: AutomergeMapStorageOptions;
};

export type AutomergeMapSourceOptions = {
  readonly relations: readonly AutomergeMapRelation[];
};

export type AutomergeMapSource = AdapterSource<Automerge.Heads>;
export type AutomergeRuntimeVersion<RuntimeVersion = unknown> =
  | Automerge.Heads
  | readonly (Automerge.Heads | RuntimeVersion)[];

export type AutomergeMapAdapter<
  DocumentShape extends object = Record<string, unknown>
> = RelationRuntime<Automerge.Heads> & {
  readonly relations: readonly AutomergeMapRelation[];
  readonly getDoc: () => Automerge.Doc<DocumentShape>;
  readonly setDoc: (doc: Automerge.Doc<DocumentShape>) => void;
  readonly snapshot: () => AdapterSnapshot<Automerge.Heads>;
  readonly target: RelationPatchTarget<Automerge.Heads>;
  readonly subscribe: (listener: () => void) => () => void;
};

export type AutomergeRelationRuntimeMetadata =
  | {
      readonly relation: RelationRef;
      readonly relations?: never;
    }
  | {
      readonly relation?: never;
      readonly relations: readonly (RelationRef | AutomergeMapRelation)[];
    };

export type AutomergeRelationRuntime<Version = unknown> =
  RelationRuntime<Version> & AutomergeRelationRuntimeMetadata;

export type AutomergeMapRuntimeOptions<
  DocumentShape extends object = Record<string, unknown>,
  RuntimeVersion = unknown
> = AutomergeMapAdapterOptions<DocumentShape> & {
  readonly runtimes?: readonly AutomergeRelationRuntime<RuntimeVersion>[];
};

export type AutomergeMapRuntime<
  DocumentShape extends object = Record<string, unknown>,
  RuntimeVersion = unknown
> = RelationRuntime<AutomergeRuntimeVersion<RuntimeVersion>> & {
  readonly kind: 'automergeMapRuntime';
  readonly adapter: AutomergeMapAdapter<DocumentShape>;
  readonly relations: readonly RelationRef[];
};

export function automergeMapSource<
  DocumentShape extends object = Record<string, unknown>
>(
  doc: Automerge.Doc<DocumentShape>,
  options: AutomergeMapSourceOptions
): AutomergeMapSource {
  void doc;
  const relationNames = relationNamesFor(options.relations);

  return {
    relationNames,
    rows: () => [],
    lookup: () => [],
    rangeLookup: () => [],
    version: () => Automerge.getHeads(doc),
    diagnostics: () => [stubDiagnostic('automerge map source is not implemented')]
  };
}

export function automergeMapAdapter<
  DocumentShape extends object = Record<string, unknown>
>(
  options: AutomergeMapAdapterOptions<DocumentShape>
): AutomergeMapAdapter<DocumentShape> {
  assertSupportedStorage(options.storage);

  let doc = options.doc;
  const listeners = new Set<() => void>();
  const relationNames = relationNamesFor(options.relations);
  const source: AutomergeMapSource = {
    relationNames,
    rows: () => [],
    lookup: () => [],
    rangeLookup: () => [],
    version: () => Automerge.getHeads(doc),
    diagnostics: () => [stubDiagnostic('automerge map adapter source is not implemented')]
  };
  const target: RelationPatchTarget<Automerge.Heads> = {
    relationNames,
    ownsRelation: (relationName) => relationNames.includes(relationName),
    apply: (patches) => ({
      status: 'rejected',
      patches: patches.length,
      applied: 0,
      deltas: [],
      diagnostics: [stubDiagnostic('automerge map adapter writes are not implemented')],
      durability: 'durable',
      version: Automerge.getHeads(doc)
    })
  };
  const notify = () => {
    for (const listener of listeners) listener();
  };

  return {
    source,
    target,
    relations: options.relations,
    getDoc: () => doc,
    setDoc: (nextDoc) => {
      doc = nextDoc;
      options.onDocChange?.(doc);
      notify();
    },
    snapshot: () => ({
      source,
      version: Automerge.getHeads(doc),
      diagnostics: [stubDiagnostic('automerge map adapter snapshot is not implemented')]
    }),
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    }
  };
}

export function withAutomergeRuntimeRelations<Version>(
  runtime: RelationRuntime<Version>,
  relation: RelationRef
): AutomergeRelationRuntime<Version>;
export function withAutomergeRuntimeRelations<Version>(
  runtime: RelationRuntime<Version>,
  relations: readonly (RelationRef | AutomergeMapRelation)[]
): AutomergeRelationRuntime<Version>;
export function withAutomergeRuntimeRelations<Version>(
  runtime: RelationRuntime<Version>,
  relationOrRelations: RelationRef | readonly (RelationRef | AutomergeMapRelation)[]
): AutomergeRelationRuntime<Version> {
  if (isReadonlyArray(relationOrRelations)) {
    return { ...runtime, relations: relationOrRelations };
  }

  return { ...runtime, relation: relationOrRelations };
}

export function createAutomergeMapRuntime<
  DocumentShape extends object = Record<string, unknown>,
  RuntimeVersion = unknown
>(
  options: AutomergeMapRuntimeOptions<DocumentShape, RuntimeVersion>
): AutomergeMapRuntime<DocumentShape, RuntimeVersion> {
  const adapter = automergeMapAdapter<DocumentShape>(options);
  const runtimes = options.runtimes ?? [];
  const runtime = runtimes.length === 0
    ? adapter as RelationRuntime<AutomergeRuntimeVersion<RuntimeVersion>>
    : composeRelationRuntimes(adapter, ...runtimes) as RelationRuntime<AutomergeRuntimeVersion<RuntimeVersion>>;
  const relations = uniqueRelations([
    ...options.relations.map((mapping) => mapping.relation),
    ...runtimes.flatMap(runtimeRelations)
  ]);

  return {
    kind: 'automergeMapRuntime',
    ...runtime,
    adapter,
    relations,
    subscribe: runtime.subscribe ?? adapter.subscribe
  };
}

function relationNamesFor(relations: readonly AutomergeMapRelation[]): readonly string[] {
  return Array.from(new Set(relations.map((mapping) => mapping.relation.name)));
}

function runtimeRelations(runtime: AutomergeRelationRuntime<unknown>): readonly RelationRef[] {
  if ('relation' in runtime && runtime.relation !== undefined) {
    return [runtime.relation];
  }

  return runtime.relations.map((relationOrMapping) =>
    isMapRelation(relationOrMapping) ? relationOrMapping.relation : relationOrMapping
  );
}

function uniqueRelations(relations: readonly RelationRef[]): readonly RelationRef[] {
  const seen = new Set<string>();
  return relations.filter((relation) => {
    if (seen.has(relation.name)) {
      return false;
    }

    seen.add(relation.name);
    return true;
  });
}

function isMapRelation(input: RelationRef | AutomergeMapRelation): input is AutomergeMapRelation {
  return 'relation' in input && 'path' in input;
}

function isReadonlyArray<Value>(input: Value | readonly Value[]): input is readonly Value[] {
  return Array.isArray(input);
}

function assertSupportedStorage(storage: AutomergeMapStorageOptions | undefined): void {
  if (storage?.codec !== undefined && storage.codec !== 'map-v1') {
    throw new Error(`unsupported Automerge storage codec: ${String(storage.codec)}`);
  }
}

function stubDiagnostic(message: string): TarstateDiagnostic {
  return {
    code: 'not_implemented',
    message
  };
}
