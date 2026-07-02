import type * as Automerge from '@automerge/automerge';
import type {
  AdapterSnapshot,
  AdapterSource,
  ComposedRelationRuntimeVersion,
  RelationPatchTarget,
  RelationRuntime
} from '@tarstate/core/adapter';
import type { RelationRef } from '@tarstate/core/schema';
import type { WritePatch } from '@tarstate/core/write';

export type AutomergeMapPath<
  DocumentShape extends object = Record<string, unknown>
> = readonly [keyof DocumentShape & string, ...string[]];

export type AutomergeMapRelation<
  Relation extends RelationRef = RelationRef,
  DocumentShape extends object = Record<string, unknown>
> = {
  readonly relation: Relation;
  readonly path: AutomergeMapPath<DocumentShape>;
};

export type AutomergeMapStorageCodec = 'map-v1';

export type AutomergeMapStorageOptions = {
  readonly codec?: AutomergeMapStorageCodec;
};

export type AutomergeMapAdapterOptions<
  DocumentShape extends object = Record<string, unknown>
> = {
  readonly doc: Automerge.Doc<DocumentShape>;
  readonly relations: readonly AutomergeMapRelation<RelationRef, DocumentShape>[];
  readonly changeMessage?: string | ((patches: readonly WritePatch[]) => string | undefined);
  readonly storage?: AutomergeMapStorageOptions;
};

export type AutomergeMapSourceOptions<
  DocumentShape extends object = Record<string, unknown>
> = {
  readonly relations: readonly AutomergeMapRelation<RelationRef, DocumentShape>[];
};

export type AutomergeMapSource = AdapterSource<Automerge.Heads>;
export type AutomergeComposedRuntimeVersion<RuntimeVersion = unknown> =
  ComposedRelationRuntimeVersion<readonly [RelationRuntime<Automerge.Heads>, ...RelationRuntime<RuntimeVersion>[]]>;
export type AutomergeRuntimeVersion<RuntimeVersion = never> =
  [RuntimeVersion] extends [never] ? Automerge.Heads : AutomergeComposedRuntimeVersion<RuntimeVersion>;

export type AutomergeMapAdapter<
  DocumentShape extends object = Record<string, unknown>
> = RelationRuntime<Automerge.Heads> & {
  readonly relations: readonly AutomergeMapRelation<RelationRef, DocumentShape>[];
  readonly getDoc: () => Automerge.Doc<DocumentShape>;
  readonly setDoc: (doc: Automerge.Doc<DocumentShape>) => void;
  readonly snapshot: () => AdapterSnapshot<Automerge.Heads>;
  readonly target: RelationPatchTarget<Automerge.Heads>;
  readonly subscribe: (listener: () => void) => () => void;
};

export type AutomergeRelationRuntimeMetadata = {
  readonly relations: readonly RelationRef[];
};

export type AutomergeRelationRuntime<Version = unknown> =
  RelationRuntime<Version> & AutomergeRelationRuntimeMetadata;

export type AutomergeMapRuntimeOptions<
  DocumentShape extends object = Record<string, unknown>,
  RuntimeVersion = never
> = AutomergeMapAdapterOptions<DocumentShape> & {
  readonly runtimes?: readonly AutomergeRelationRuntime<RuntimeVersion>[];
};

export type AutomergeMapRuntime<
  DocumentShape extends object = Record<string, unknown>,
  RuntimeVersion = never
> = RelationRuntime<AutomergeRuntimeVersion<RuntimeVersion>> & {
  readonly kind: 'automergeMapRuntime';
  readonly adapter: AutomergeMapAdapter<DocumentShape>;
  readonly relations: readonly RelationRef[];
  readonly subscribe: (listener: () => void) => () => void;
};

export function defineAutomergeMapRelations<DocumentShape extends object>() {
  return <const Relations extends readonly AutomergeMapRelation<RelationRef, DocumentShape>[]>(
    relations: Relations
  ): Relations => relations;
}

export function automergeMapSource<
  DocumentShape extends object = Record<string, unknown>
>(
  _doc: Automerge.Doc<DocumentShape>,
  _options: AutomergeMapSourceOptions<DocumentShape>
): AutomergeMapSource {
  throwNotImplemented('automergeMapSource');
}

export function automergeMapAdapter<
  DocumentShape extends object = Record<string, unknown>
>(
  _options: AutomergeMapAdapterOptions<DocumentShape>
): AutomergeMapAdapter<DocumentShape> {
  throwNotImplemented('automergeMapAdapter');
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
  const relations: readonly RelationRef[] = isReadonlyArray(relationOrRelations)
    ? relationOrRelations.map(relationRefFor)
    : [relationOrRelations];

  return { ...runtime, relations };
}

export function createAutomergeMapRuntime<
  DocumentShape extends object = Record<string, unknown>
>(
  options: AutomergeMapAdapterOptions<DocumentShape> & { readonly runtimes?: readonly [] | undefined }
): AutomergeMapRuntime<DocumentShape>;
export function createAutomergeMapRuntime<
  DocumentShape extends object = Record<string, unknown>,
  RuntimeVersion = unknown
>(
  options: AutomergeMapAdapterOptions<DocumentShape> & {
    readonly runtimes: readonly AutomergeRelationRuntime<RuntimeVersion>[];
  }
): AutomergeMapRuntime<DocumentShape, RuntimeVersion>;
export function createAutomergeMapRuntime(_options: unknown): never {
  throwNotImplemented('createAutomergeMapRuntime');
}

function relationRefFor(input: RelationRef | AutomergeMapRelation): RelationRef {
  return isMapRelation(input) ? input.relation : input;
}

function isMapRelation(input: RelationRef | AutomergeMapRelation): input is AutomergeMapRelation {
  return 'path' in input;
}

function isReadonlyArray<Value>(input: Value | readonly Value[]): input is readonly Value[] {
  return Array.isArray(input);
}

function throwNotImplemented(surface: string): never {
  throw new Error(`${surface} is not implemented`);
}
