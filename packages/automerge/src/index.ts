import type * as Automerge from '@automerge/automerge';
import type {
  AdapterCommitResult,
  AdapterSnapshot,
  AdapterSource,
  RelationAdapter,
  RelationPatchTarget,
  TarstateDiagnostic
} from '@tarstate/core/adapter';
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
  DocumentShape extends Record<string, unknown> = Record<string, unknown>
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

export type AutomergeMapAdapter<
  DocumentShape extends Record<string, unknown> = Record<string, unknown>
> = RelationAdapter<Automerge.Heads> & {
  readonly relations: readonly AutomergeMapRelation[];
  readonly getDoc: () => Automerge.Doc<DocumentShape>;
  readonly setDoc: (doc: Automerge.Doc<DocumentShape>) => void;
  readonly snapshot: () => AdapterSnapshot<Automerge.Heads>;
  readonly target: RelationPatchTarget<Automerge.Heads>;
  readonly subscribe: (listener: () => void) => () => void;
};

export function automergeMapAdapter<
  DocumentShape extends Record<string, unknown> = Record<string, unknown>
>(options: AutomergeMapAdapterOptions<DocumentShape>): AutomergeMapAdapter<DocumentShape> {
  let currentDoc = options.doc;
  const listeners = new Set<() => void>();
  const relationNames = options.relations.map((relation) => relation.relation.name);
  const source = automergeMapSource(() => currentDoc, { relations: options.relations });
  const commit = (patches: readonly WritePatch[]): AdapterCommitResult<Automerge.Heads> => ({
    status: 'rejected',
    patches: patches.length,
    applied: 0,
    deltas: [],
    diagnostics: [stubDiagnostic()],
    version: []
  });
  const target: RelationPatchTarget<Automerge.Heads> = {
    relationNames,
    ownsRelation: (relationName) => relationNames.includes(relationName),
    apply: (patches) => ({ ...commit(patches), durability: 'durable' })
  };

  return {
    relations: options.relations.map((relation) => ({ relation: relation.relation, path: [...relation.path] })),
    source,
    target,
    commit,
    getDoc: () => currentDoc,
    setDoc: (doc) => {
      currentDoc = doc;
      for (const listener of listeners) listener();
    },
    snapshot: () => ({ source, version: [] }),
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    }
  };
}

export function automergeMapSource<
  DocumentShape extends Record<string, unknown> = Record<string, unknown>
>(
  _docOrGetDoc: Automerge.Doc<DocumentShape> | (() => Automerge.Doc<DocumentShape>),
  options: AutomergeMapSourceOptions
): AutomergeMapSource {
  return {
    relationNames: options.relations.map((relation) => relation.relation.name),
    rows: () => [],
    lookup: () => undefined,
    rangeLookup: () => undefined,
    version: () => [],
    diagnostics: () => [stubDiagnostic()]
  };
}

function stubDiagnostic(): TarstateDiagnostic {
  return {
    code: 'source_error',
    message: 'automerge implementation has been removed; regenerate this API implementation'
  };
}
