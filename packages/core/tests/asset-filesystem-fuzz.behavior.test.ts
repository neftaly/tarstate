import { describe, expect, it } from 'vitest';
import { createDb, q, tryTransact, type Db } from '@tarstate/core/db';
import { and, as, asc, eq, from, join, pipe, project, sort, value, where } from '@tarstate/core/query';
import {
  booleanField,
  defineSchema,
  idField,
  jsonField,
  nullable,
  numberField,
  optional,
  relation,
  stringField,
  type FieldSpec
} from '@tarstate/core/schema';
import { fromObjectSource } from '@tarstate/core/source';
import { deleteByKey, deleteExact, insert, replaceAll, updateByKey, type WritePatch } from '@tarstate/core/write';
import { chooseSeeded, createSeededRandom } from './fuzz-helpers.js';

type AssetKind = 'svg' | 'gltf' | 'bin' | 'json';
type AssetDependencyKind = 'buffer' | 'svg-texture' | 'manifest' | 'preview' | 'schema' | 'sibling';
type AssetRef = {
  readonly assetId: string;
  readonly kind: AssetDependencyKind;
  readonly ordinal: number;
};
type AssetMetadata = {
  readonly tags: readonly string[];
  readonly bytes: number;
  readonly variant: string;
  readonly source: 'inline' | 'external';
};
type AssetRow = {
  readonly id: string;
  readonly path: string;
  readonly dir: string;
  readonly basename: string;
  readonly packageId: string;
  readonly kind: AssetKind;
  readonly pathSegments: readonly string[];
  readonly refs: readonly AssetRef[];
  readonly metadata: AssetMetadata;
  readonly contentInline?: string | null;
  readonly blobRef?: string;
  readonly deleted: boolean;
};
type AssetDependencyRow = {
  readonly id: string;
  readonly fromAssetId: string;
  readonly fromPath: string;
  readonly toAssetId: string;
  readonly toPath: string;
  readonly kind: AssetDependencyKind;
  readonly ordinal: number;
};
type AssetListingRow = {
  readonly id: string;
  readonly path: string;
  readonly basename: string;
  readonly packageId: string;
  readonly kind: AssetKind;
  readonly refs: readonly AssetRef[];
};
type ManifestListingRow = {
  readonly id: string;
  readonly path: string;
  readonly basename: string;
  readonly packageId: string;
  readonly refs: readonly AssetRef[];
  readonly metadata: AssetMetadata;
};
type DependencyExpansionRow = {
  readonly fromAssetId: string;
  readonly fromPath: string;
  readonly toAssetId: string;
  readonly toPath: string;
  readonly dependencyKind: AssetDependencyKind;
  readonly ordinal: number;
  readonly targetKind: AssetKind;
  readonly targetPackageId: string;
};

type Random = {
  readonly int: (exclusiveMax: number) => number;
  readonly bool: (probability?: number) => boolean;
  readonly pick: <Value>(values: readonly Value[]) => Value;
};

const assetSchema = defineSchema({
  assets: relation<AssetRow>({
    key: 'id',
    fields: {
      id: idField('asset'),
      path: stringField(),
      dir: stringField(),
      basename: stringField(),
      packageId: stringField(),
      kind: stringField() as FieldSpec<AssetKind>,
      pathSegments: jsonField() as FieldSpec<readonly string[]>,
      refs: jsonField() as FieldSpec<readonly AssetRef[]>,
      metadata: jsonField() as FieldSpec<AssetMetadata>,
      contentInline: optional(nullable(stringField())),
      blobRef: optional(stringField()),
      deleted: booleanField()
    }
  }),
  assetDependencies: relation<AssetDependencyRow>({
    key: 'id',
    fields: {
      id: idField('assetDependency'),
      fromAssetId: stringField(),
      fromPath: stringField(),
      toAssetId: stringField(),
      toPath: stringField(),
      kind: stringField() as FieldSpec<AssetDependencyKind>,
      ordinal: numberField()
    }
  })
});

const asset = as(assetSchema.assets, 'asset');
const dependency = as(assetSchema.assetDependencies, 'dependency');
const dependencyTarget = as(assetSchema.assets, 'dependencyTarget');
const assetsByPath = pipe(from(asset), sort(asc(asset.path), asc(asset.id)));
const dependenciesBySource = pipe(from(dependency), sort(asc(dependency.fromAssetId), asc(dependency.ordinal), asc(dependency.toAssetId)));
const ASSET_KINDS = ['bin', 'gltf', 'json', 'svg'] as const satisfies readonly AssetKind[];
const MUTATION_ACTIONS = ['insert:duplicate-path', 'insert:fresh-path', 'rename', 'deleteByKey', 'deleteExact'] as const;

const SEEDS = [0xa55e_7001, 0xa55e_7002, 0xa55e_7003] as const;
const ROWS_PER_SEED = 72;
const MUTATIONS_PER_SEED = 15;
const FULL_ASSERTION_INTERVAL = 5;
const DB_LOOKUP_SAMPLE_COUNT = 4;
const SOURCE_LOOKUP_SAMPLE_COUNT = 12;
const DEPENDENCY_SOURCE_SAMPLE_COUNT = 1;
const MANIFEST_PACKAGE_SAMPLE_COUNT = 1;

type MutationAction = typeof MUTATION_ACTIONS[number];
type MutationResult = {
  readonly transaction: ReturnType<typeof tryTransact>;
  readonly model: ReadonlyMap<string, AssetRow>;
  readonly touchedPaths: readonly string[];
  readonly touchedDirs: readonly string[];
};
type ModelSnapshot = {
  readonly rows: readonly AssetRow[];
  readonly dependencies: readonly AssetDependencyRow[];
};

describe('asset filesystem seeded fuzz behavior', () => {
  it('covers filesystem-shaped asset lookup, listing, duplicate paths, and writes', () => {
    const exercised = new Set<string>();

    for (const seed of SEEDS) {
      const rng = createRandom(seed);
      const openingRows = seededAssetRows(seed, ROWS_PER_SEED);
      let model = modelFromRows(openingRows);
      let db: Db = createDb({ assets: modelRows(model), assetDependencies: dependencyRows(model) });

      assertSourceLookups(seed, openingRows);
      assertDbMatchesModel(db, model, `seed ${seed.toString(16)} opening`);
      assertDuplicatePathLookup(seed, db, model);

      for (let step = 0; step < MUTATIONS_PER_SEED; step += 1) {
        const action = mutationActionFor(seed, step);
        exercised.add(action);
        const label = `seed ${seed.toString(16)} step ${step} ${action}`;
        const result = applyMutation(db, model, rng, seed, step, action);

        expect(result.transaction.committed, label).toBe(true);
        expect(result.transaction.diagnostics, label).toEqual([]);

        db = result.transaction.db;
        model = result.model;
        assertMutationLookups(db, model, label, result.touchedPaths, result.touchedDirs);
        if (shouldRunFullAssertions(step)) {
          assertDbMatchesModel(db, model, label);
        }
      }
    }

    expect([...exercised].sort()).toEqual([...MUTATION_ACTIONS].sort());
  });
});

function mutationActionFor(seed: number, step: number): MutationAction {
  return MUTATION_ACTIONS[(seed + step) % MUTATION_ACTIONS.length] ?? MUTATION_ACTIONS[0];
}

function shouldRunFullAssertions(step: number): boolean {
  return (step + 1) % FULL_ASSERTION_INTERVAL === 0 || step === MUTATIONS_PER_SEED - 1;
}

function createRandom(seed: number): Random {
  const next = createSeededRandom(seed);
  const int = (exclusiveMax: number): number => {
    if (exclusiveMax <= 0) throw new Error('cannot choose from an empty range');
    return Math.floor(next() * exclusiveMax);
  };
  return {
    int,
    bool: (probability = 0.5) => next() < probability,
    pick: <Value>(values: readonly Value[]): Value => chooseSeeded(next, values)
  };
}

function seededAssetRows(seed: number, count: number): readonly AssetRow[] {
  const rng = createRandom(seed);
  const rows: AssetRow[] = [];

  for (let index = 0; index < count; index += 1) {
    const duplicatePath = rows.length > 0 && rng.bool(0.14);
    const path = duplicatePath
      ? rng.pick(rows).path
      : randomPath(rng, seed, index);
    rows.push(assetRow(seed, index, path, rng));
  }

  return withGeneratedRefs(rows, createRandom(seed ^ 0x6d_65_70));
}

function assetRow(seed: number, index: number, path: string, rng: Random): AssetRow {
  const segments = path.split('/');
  const basename = segments.at(-1) ?? path;
  const kind = kindForBasename(basename);
  const external = rng.bool(0.45) || kind === 'bin';
  const bytes = rng.bool(0.18) ? 24_000 + rng.int(18_000) : 128 + rng.int(2_048);
  const metadata = {
    tags: [kind, rng.pick(['token', 'sprite', 'mesh', 'icon', 'board', 'sheet'] as const)],
    bytes,
    variant: `v${rng.int(7)}-${seed.toString(16)}`,
    source: external ? 'external' : 'inline'
  } satisfies AssetMetadata;

  return {
    id: `asset-${seed.toString(16)}-${index}`,
    path,
    dir: segments.slice(0, -1).join('/'),
    basename,
    packageId: packageIdForSegments(segments),
    kind,
    pathSegments: segments,
    refs: [],
    metadata,
    ...(external
      ? { blobRef: `blob://${seed.toString(16)}/${index}/${bytes}` }
      : { contentInline: inlineContent(kind, basename, bytes) }),
    deleted: false
  };
}

function randomPath(rng: Random, seed: number, index: number): string {
  const roots = ['assets', 'royal', 'probability', 'packages', 'public'] as const;
  const dirs = [
    'icons',
    'textures',
    'models',
    'sets/alpha',
    'sets/beta',
    'weird names',
    'unicode-like-u2603',
    'nested/[draft]',
    'spaces and #hash',
    'query?safe'
  ] as const;
  const stems = [
    'king',
    'queen',
    'die-6',
    'probability curve',
    'token#gold',
    'mesh.final',
    'board@2x',
    'white space',
    'package',
    `seed-${seed.toString(16)}-${index}`
  ] as const;
  const extensions = ['svg', 'gltf', 'glb', 'bin', 'json'] as const;
  const depth = 1 + rng.int(3);
  const middle = Array.from({ length: depth }, () => rng.pick(dirs));
  return [rng.pick(roots), ...middle, `${rng.pick(stems)}.${rng.pick(extensions)}`].join('/');
}

function inlineContent(kind: AssetKind, basename: string, bytes: number): string {
  if (kind === 'svg') {
    return `<svg viewBox="0 0 10 10"><title>${basename}</title><path d="M0 0h10v10H0z"/></svg>`;
  }
  if (kind === 'gltf') {
    return JSON.stringify({ asset: { version: '2.0' }, scenes: [{ name: basename }], buffers: [{ byteLength: bytes }] });
  }
  return `{"name":${JSON.stringify(basename)},"padding":"${'x'.repeat(Math.min(bytes, 4096))}"}`;
}

function kindForBasename(basename: string): AssetKind {
  if (basename.endsWith('.svg')) return 'svg';
  if (basename.endsWith('.gltf') || basename.endsWith('.glb')) return 'gltf';
  if (basename.endsWith('.bin')) return 'bin';
  return 'json';
}

function assertSourceLookups(seed: number, rows: readonly AssetRow[]): void {
  const source = fromObjectSource({ assets: rows });
  const sampleRows = rows.slice(0, SOURCE_LOOKUP_SAMPLE_COUNT);
  const samplePaths = uniqueValues(sampleRows.map((row) => row.path));
  const sampleDirs = uniqueValues(sampleRows.map((row) => row.dir));

  expect(source.rows(assetSchema.assets), `seed ${seed.toString(16)} source rows`).toEqual(rows);

  for (const path of samplePaths) {
    expect(source.lookup?.({ relation: assetSchema.assets, field: 'path', value: path }), `source lookup path ${path}`)
      .toEqual(rows.filter((row) => row.path === path));
  }

  for (const dir of sampleDirs) {
    expect(source.lookup?.({ relation: assetSchema.assets, field: 'dir', value: dir }), `source list dir ${dir}`)
      .toEqual(rows.filter((row) => row.dir === dir));
  }

  expect(source.lookup?.({ relation: assetSchema.assets, field: 'path', value: `missing://${seed.toString(16)}` }))
    .toEqual([]);
}

function assertDbMatchesModel(db: Db, model: ReadonlyMap<string, AssetRow>, label: string): void {
  const snapshot = modelSnapshot(model);
  expect(q(db, assetsByPath), label).toEqual(snapshot.rows);
  expect(q(db, dependenciesBySource), `${label} dependencies`).toEqual(snapshot.dependencies);

  for (const path of sampleExistingPaths(snapshot.rows, DB_LOOKUP_SAMPLE_COUNT)) {
    expect(q(db, pathQuery(path)), `${label} path ${path}`).toEqual(modelRowsByPath(snapshot.rows, path));
  }

  for (const dir of sampleExistingDirs(snapshot.rows, DB_LOOKUP_SAMPLE_COUNT)) {
    expect(q(db, dirQuery(dir)), `${label} dir ${dir}`).toEqual(modelRowsByDir(snapshot.rows, dir));
  }

  assertDependencyExpansions(db, model, snapshot.dependencies, label);
  assertKindListings(db, snapshot.rows, label);
  assertManifestListings(db, snapshot.rows, label);
}

function assertDuplicatePathLookup(seed: number, db: Db, model: ReadonlyMap<string, AssetRow>): void {
  const duplicatePath = [...pathCounts(model)].find(([, count]) => count > 1)?.[0];
  expect(duplicatePath, `seed ${seed.toString(16)} duplicate path fixture`).toEqual(expect.any(String));
  if (duplicatePath === undefined) return;

  const rows = modelRows(model);
  expect(q(db, pathQuery(duplicatePath)), `seed ${seed.toString(16)} duplicate path rows`)
    .toEqual(modelRowsByPath(rows, duplicatePath));
}

function assertMissingPathLookup(db: Db, rows: readonly AssetRow[], label: string): void {
  const missingPath = `missing/${label}/asset.svg`;
  expect(modelRowsByPath(rows, missingPath), label).toEqual([]);
  expect(q(db, pathQuery(missingPath)), label).toEqual([]);
}

function assertMutationLookups(
  db: Db,
  model: ReadonlyMap<string, AssetRow>,
  label: string,
  touchedPaths: readonly string[],
  touchedDirs: readonly string[]
): void {
  const rows = modelRows(model);

  for (const path of uniqueValues(touchedPaths)) {
    expect(q(db, pathQuery(path)), `${label} touched path ${path}`).toEqual(modelRowsByPath(rows, path));
  }

  for (const dir of uniqueValues(touchedDirs)) {
    expect(q(db, dirQuery(dir)), `${label} touched dir ${dir}`).toEqual(modelRowsByDir(rows, dir));
  }

  assertMissingPathLookup(db, rows, label);
}

function applyMutation(
  db: Db,
  model: ReadonlyMap<string, AssetRow>,
  rng: Random,
  seed: number,
  step: number,
  action: MutationAction
): MutationResult {
  const next = new Map(model);
  const currentRows = [...next.values()];

  switch (action) {
    case 'insert:duplicate-path': {
      const path = rng.pick(currentRows).path;
      const row = withGeneratedRefsForRow(assetRow(seed, ROWS_PER_SEED + step, path, rng), currentRows, rng);
      next.set(row.id, row);
      return mutationResult(db, next, insert(assetSchema.assets, row), [row.path], [row.dir]);
    }
    case 'insert:fresh-path': {
      const row = withGeneratedRefsForRow(
        assetRow(seed, ROWS_PER_SEED + step, randomPath(rng, seed, ROWS_PER_SEED + step), rng),
        currentRows,
        rng
      );
      next.set(row.id, row);
      return mutationResult(db, next, insert(assetSchema.assets, row), [row.path], [row.dir]);
    }
    case 'rename': {
      const row = rng.pick(currentRows);
      const path = randomPath(rng, seed ^ 0x51_7a, ROWS_PER_SEED + step);
      const renamed = withPath(row, path);
      next.set(row.id, renamed);
      return mutationResult(
        db,
        next,
        updateByKey(assetSchema.assets, row.id, { ...pathFields(path), refs: renamed.refs }),
        [row.path, renamed.path],
        [row.dir, renamed.dir]
      );
    }
    case 'deleteByKey': {
      const row = rng.pick(currentRows);
      next.delete(row.id);
      return mutationResult(db, next, deleteByKey(assetSchema.assets, row.id), [row.path], [row.dir]);
    }
    case 'deleteExact': {
      const row = rng.pick(currentRows);
      next.delete(row.id);
      return mutationResult(db, next, deleteExact(assetSchema.assets, row), [row.path], [row.dir]);
    }
  }
}

function mutationResult(
  db: Db,
  model: ReadonlyMap<string, AssetRow>,
  assetPatch: WritePatch,
  touchedPaths: readonly string[],
  touchedDirs: readonly string[]
): MutationResult {
  return {
    transaction: transactAssetMutation(db, model, assetPatch),
    model,
    touchedPaths,
    touchedDirs
  };
}

function transactAssetMutation(db: Db, model: ReadonlyMap<string, AssetRow>, assetPatch: WritePatch): ReturnType<typeof tryTransact> {
  return tryTransact(db, [
    assetPatch,
    replaceAll(assetSchema.assetDependencies, dependencyRows(model))
  ]);
}

function withPath(row: AssetRow, path: string): AssetRow {
  const fields = pathFields(path);
  return { ...row, ...fields, refs: canHaveDependencies(fields.kind) ? row.refs : [] };
}

function pathFields(path: string): Pick<AssetRow, 'path' | 'dir' | 'basename' | 'packageId' | 'pathSegments' | 'kind'> {
  const pathSegments = path.split('/');
  const basename = pathSegments.at(-1) ?? path;
  return {
    path,
    dir: pathSegments.slice(0, -1).join('/'),
    basename,
    packageId: packageIdForSegments(pathSegments),
    pathSegments,
    kind: kindForBasename(basename)
  };
}

function pathQuery(path: string) {
  return pipe(
    from(asset),
    where(eq(asset.path, value(path))),
    sort(asc(asset.path), asc(asset.id))
  );
}

function dirQuery(dir: string) {
  return pipe(
    from(asset),
    where(eq(asset.dir, value(dir))),
    sort(asc(asset.path), asc(asset.id))
  );
}

function dependencyExpansionQuery(fromAssetId: string) {
  return pipe(
    from(dependency),
    where(eq(dependency.fromAssetId, value(fromAssetId))),
    join(from(dependencyTarget), eq(dependency.toAssetId, dependencyTarget.id)),
    sort(asc(dependency.ordinal), asc(dependencyTarget.path), asc(dependencyTarget.id)),
    project({
      fromAssetId: dependency.fromAssetId,
      fromPath: dependency.fromPath,
      toAssetId: dependencyTarget.id,
      toPath: dependencyTarget.path,
      dependencyKind: dependency.$.kind,
      ordinal: dependency.ordinal,
      targetKind: dependencyTarget.$.kind,
      targetPackageId: dependencyTarget.packageId
    })
  );
}

function kindListingQuery(kind: AssetKind) {
  return pipe(
    from(asset),
    where(eq(asset.$.kind, value(kind))),
    sort(asc(asset.path), asc(asset.id)),
    project({
      id: asset.id,
      path: asset.path,
      basename: asset.basename,
      packageId: asset.packageId,
      kind: asset.$.kind,
      refs: asset.refs
    })
  );
}

function manifestListingQuery(packageId: string) {
  return pipe(
    from(asset),
    where(and(
      eq(asset.packageId, value(packageId)),
      eq(asset.$.kind, value('json'))
    )),
    sort(asc(asset.path), asc(asset.id)),
    project({
      id: asset.id,
      path: asset.path,
      basename: asset.basename,
      packageId: asset.packageId,
      refs: asset.refs,
      metadata: asset.metadata
    })
  );
}

function modelFromRows(rows: readonly AssetRow[]): ReadonlyMap<string, AssetRow> {
  return new Map(rows.map((row) => [row.id, row]));
}

function modelRows(model: ReadonlyMap<string, AssetRow>): readonly AssetRow[] {
  return [...model.values()].sort(compareAssetRows);
}

function modelSnapshot(model: ReadonlyMap<string, AssetRow>): ModelSnapshot {
  const rows = modelRows(model);
  return { rows, dependencies: dependencyRowsForRows(model, rows) };
}

function modelRowsByPath(rows: readonly AssetRow[], path: string): readonly AssetRow[] {
  return rows.filter((row) => row.path === path);
}

function modelRowsByDir(rows: readonly AssetRow[], dir: string): readonly AssetRow[] {
  return rows.filter((row) => row.dir === dir);
}

function dependencyRows(model: ReadonlyMap<string, AssetRow>): readonly AssetDependencyRow[] {
  return dependencyRowsForRows(model, modelRows(model));
}

function dependencyRowsForRows(model: ReadonlyMap<string, AssetRow>, assetRows: readonly AssetRow[]): readonly AssetDependencyRow[] {
  const rows: AssetDependencyRow[] = [];

  for (const row of assetRows) {
    rows.push(...dependencyRowsForSource(model, row));
  }

  return rows.sort(compareDependencyRows);
}

function modelDependencyExpansion(
  model: ReadonlyMap<string, AssetRow>,
  dependencies: readonly AssetDependencyRow[],
  fromAssetId: string
): readonly DependencyExpansionRow[] {
  return dependencies
    .filter((row) => row.fromAssetId === fromAssetId)
    .map((row) => {
      const target = model.get(row.toAssetId);
      if (target === undefined) throw new Error(`dependency target missing from model: ${row.toAssetId}`);
      return {
        fromAssetId: row.fromAssetId,
        fromPath: row.fromPath,
        toAssetId: target.id,
        toPath: target.path,
        dependencyKind: row.kind,
        ordinal: row.ordinal,
        targetKind: target.kind,
        targetPackageId: target.packageId
      } satisfies DependencyExpansionRow;
    })
    .sort(compareDependencyExpansionRows);
}

function modelKindListing(rows: readonly AssetRow[], kind: AssetKind): readonly AssetListingRow[] {
  return rows
    .filter((row) => row.kind === kind)
    .map((row) => ({
      id: row.id,
      path: row.path,
      basename: row.basename,
      packageId: row.packageId,
      kind: row.kind,
      refs: row.refs
    }));
}

function modelManifestListing(rows: readonly AssetRow[], packageId: string): readonly ManifestListingRow[] {
  return rows
    .filter((row) => row.packageId === packageId && row.kind === 'json')
    .map((row) => ({
      id: row.id,
      path: row.path,
      basename: row.basename,
      packageId: row.packageId,
      refs: row.refs,
      metadata: row.metadata
    }));
}

function assertDependencyExpansions(
  db: Db,
  model: ReadonlyMap<string, AssetRow>,
  dependencies: readonly AssetDependencyRow[],
  label: string
): void {
  const sources = sampleDependencySources(model, dependencies, DEPENDENCY_SOURCE_SAMPLE_COUNT);
  expect(sources.length, `${label} dependency source fixture`).toBeGreaterThan(0);

  for (const source of sources) {
    expect(q(db, dependencyExpansionQuery(source.id)), `${label} dependencies for ${source.id}`)
      .toEqual(modelDependencyExpansion(model, dependencies, source.id));
  }

  expect(q(db, dependencyExpansionQuery(`missing-${label}`)), `${label} missing dependency source`).toEqual([]);
}

function assertKindListings(db: Db, rows: readonly AssetRow[], label: string): void {
  for (const kind of ASSET_KINDS) {
    expect(q(db, kindListingQuery(kind)), `${label} kind ${kind}`).toEqual(modelKindListing(rows, kind));
  }
}

function assertManifestListings(db: Db, rows: readonly AssetRow[], label: string): void {
  const packageIds = sampleManifestPackages(rows, MANIFEST_PACKAGE_SAMPLE_COUNT);
  expect(packageIds.length, `${label} manifest package fixture`).toBeGreaterThan(0);

  for (const packageId of packageIds) {
    expect(q(db, manifestListingQuery(packageId)), `${label} manifest ${packageId}`)
      .toEqual(modelManifestListing(rows, packageId));
  }

  expect(q(db, manifestListingQuery(`missing-${label}`)), `${label} missing manifest package`).toEqual([]);
}

function sampleExistingPaths(rows: readonly AssetRow[], count: number): readonly string[] {
  return uniqueValues(rows.map((row) => row.path)).slice(0, count);
}

function sampleExistingDirs(rows: readonly AssetRow[], count: number): readonly string[] {
  return uniqueValues(rows.map((row) => row.dir)).slice(0, count);
}

function sampleDependencySources(
  model: ReadonlyMap<string, AssetRow>,
  dependencies: readonly AssetDependencyRow[],
  count: number
): readonly AssetRow[] {
  return [...new Set(dependencies.map((row) => row.fromAssetId))]
    .map((assetId) => model.get(assetId))
    .filter((row): row is AssetRow => row !== undefined)
    .sort(compareAssetRows)
    .slice(0, count);
}

function sampleManifestPackages(rows: readonly AssetRow[], count: number): readonly string[] {
  return uniqueValues(rows
    .filter((row) => row.kind === 'json')
    .map((row) => row.packageId))
    .slice(0, count);
}

function uniqueValues<Value>(values: readonly Value[]): readonly Value[] {
  return [...new Set(values)];
}

function pathCounts(model: ReadonlyMap<string, AssetRow>): ReadonlyMap<string, number> {
  const counts = new Map<string, number>();
  for (const row of model.values()) counts.set(row.path, (counts.get(row.path) ?? 0) + 1);
  return counts;
}

function withGeneratedRefs(rows: readonly AssetRow[], rng: Random): readonly AssetRow[] {
  return rows.map((row) => withGeneratedRefsForRow(row, rows, rng));
}

function withGeneratedRefsForRow(row: AssetRow, candidates: readonly AssetRow[], rng: Random): AssetRow {
  return { ...row, refs: generatedRefsFor(row, candidates, rng) };
}

function generatedRefsFor(row: AssetRow, candidates: readonly AssetRow[], rng: Random): readonly AssetRef[] {
  if (!canHaveDependencies(row.kind)) return [];

  const available = candidates.filter((candidate) => candidate.id !== row.id);
  if (available.length === 0) return [];

  return refPlansFor(row.kind).flatMap((plan, index) => {
    const target = pickTargetForRef(plan.targetKind, available, rng);
    return target === undefined
      ? []
      : [{ assetId: target.id, kind: plan.kind, ordinal: index }];
  });
}

function pickTargetForRef(kind: AssetKind, candidates: readonly AssetRow[], rng: Random): AssetRow | undefined {
  const preferred = candidates.filter((row) => row.kind === kind);
  return rng.pick(preferred.length > 0 ? preferred : candidates);
}

function refPlansFor(kind: AssetKind): readonly { readonly kind: AssetDependencyKind; readonly targetKind: AssetKind }[] {
  switch (kind) {
    case 'gltf':
      return [
        { kind: 'buffer', targetKind: 'bin' },
        { kind: 'svg-texture', targetKind: 'svg' },
        { kind: 'manifest', targetKind: 'json' }
      ];
    case 'svg':
      return [
        { kind: 'schema', targetKind: 'json' },
        { kind: 'sibling', targetKind: 'svg' }
      ];
    case 'json':
      return [
        { kind: 'preview', targetKind: 'svg' },
        { kind: 'sibling', targetKind: 'gltf' }
      ];
    case 'bin':
      return [];
  }
}

function dependencyRowsForSource(model: ReadonlyMap<string, AssetRow>, source: AssetRow): readonly AssetDependencyRow[] {
  return activeRefsFor(source).flatMap((ref) => {
    const target = model.get(ref.assetId);
    return target === undefined
      ? []
      : [{
          id: dependencyId(source.id, ref.ordinal),
          fromAssetId: source.id,
          fromPath: source.path,
          toAssetId: target.id,
          toPath: target.path,
          kind: ref.kind,
          ordinal: ref.ordinal
        }];
  });
}

function activeRefsFor(row: AssetRow): readonly AssetRef[] {
  return canHaveDependencies(row.kind) ? row.refs : [];
}

function canHaveDependencies(kind: AssetKind): boolean {
  return kind === 'gltf' || kind === 'svg' || kind === 'json';
}

function dependencyId(fromAssetId: string, ordinal: number): string {
  return `${fromAssetId}->${ordinal}`;
}

function packageIdForSegments(segments: readonly string[]): string {
  return `${segments[0] ?? 'root'}:${segments[1] ?? 'root'}`;
}

function compareAssetRows(left: AssetRow, right: AssetRow): number {
  return left.path.localeCompare(right.path) || left.id.localeCompare(right.id);
}

function compareDependencyRows(left: AssetDependencyRow, right: AssetDependencyRow): number {
  return left.fromAssetId.localeCompare(right.fromAssetId)
    || left.ordinal - right.ordinal
    || left.toAssetId.localeCompare(right.toAssetId);
}

function compareDependencyExpansionRows(left: DependencyExpansionRow, right: DependencyExpansionRow): number {
  return left.ordinal - right.ordinal
    || left.toPath.localeCompare(right.toPath)
    || left.toAssetId.localeCompare(right.toAssetId);
}
