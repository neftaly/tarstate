import { performance } from 'node:perf_hooks';
import { afterAll, bench, describe } from 'vitest';
import { createDb, q, transact, type Db } from '@tarstate/core/db';
import {
  index as materializedIndex,
  mat,
  type MaterializedIndex,
  type MaterializedHashIndex,
  type MaterializedUniqueIndex
} from '@tarstate/core/materialization';
import {
  and,
  as,
  asc,
  eq,
  field,
  from,
  hash,
  join,
  pipe,
  project,
  sort,
  uniqueIndex,
  value,
  where,
  type Query
} from '@tarstate/core/query';
import { defineSchema, numberField, optional, relation, stringField, type FieldSpec } from '@tarstate/core/schema';
import { updateByKey } from '@tarstate/core/write';

type AssetKind = 'gltf' | 'glb' | 'bin' | 'svg' | 'image' | 'texture' | 'manifest';
type AssetFile = {
  readonly path: string;
  readonly directory: string;
  readonly name: string;
  readonly extension: string;
  readonly mediaType: string;
  readonly kind: AssetKind;
  readonly packageId: string;
  readonly byteLength: number;
  readonly sha256: string;
  readonly contentRef: string;
  readonly inlineText?: string;
  readonly lastAccessedAt?: number;
};
type AssetDependency = {
  readonly id: string;
  readonly fromPath: string;
  readonly toPath: string;
  readonly kind: string;
  readonly ordinal: number;
};
type Fixture = {
  readonly files: readonly AssetFile[];
  readonly dependencies: readonly AssetDependency[];
  readonly hotPaths: readonly string[];
  readonly svgPaths: readonly string[];
  readonly gltfPaths: readonly string[];
  readonly directories: readonly string[];
  readonly packageIds: readonly string[];
};
type RequestKind = 'file' | 'directory' | 'dependencies' | 'manifest';
type RequestOp = {
  readonly kind: RequestKind;
  readonly index: number;
};
type ProbeMode = 'array-query' | 'materialized-index' | 'oracle' | 'inline-svg' | 'write-edge';
type ProbeMetric = {
  readonly probe: string;
  readonly mode: ProbeMode;
  samples: number;
  requests: number;
  rowsRead: number;
  bytesRepresented: number;
  writes: number;
  heapNetBytes: number;
  heapPositiveBytes: number;
  maxHeapPositiveBytes: number;
  elapsedMs: number;
  sampleMs: number[];
  maxSampleMs: number;
};
type QuerySet = {
  readonly file: readonly Query<unknown>[];
  readonly inlineFile: readonly Query<unknown>[];
  readonly directory: readonly Query<unknown>[];
  readonly dependencies: readonly Query<unknown>[];
  readonly manifest: readonly Query<unknown>[];
};
type OracleIndex = {
  readonly byPath: ReadonlyMap<string, AssetFile>;
  readonly byDirectory: ReadonlyMap<string, readonly AssetFile[]>;
  readonly depsByFromPath: ReadonlyMap<string, readonly AssetFile[]>;
  readonly manifestByPackage: ReadonlyMap<string, readonly AssetFile[]>;
};
type AssetIndexSet = {
  readonly byPath: MaterializedUniqueIndex<AssetFile, string>;
  readonly byDirectory: MaterializedHashIndex<AssetFile, string>;
  readonly depsByFromPath: MaterializedHashIndex<AssetDependency, string>;
  readonly manifestByPackage: MaterializedHashIndex<AssetFile, string>;
};

const PACKAGE_COUNT = 18;
const GLTF_PER_PACKAGE = 48;
const SVG_PER_PACKAGE = 72;
const PAGE_TEXTURES_PER_PACKAGE = 160;
const HOT_REQUEST_COUNT = 240;
const SAMPLE_REQUESTS = 12;
const BENCH_OPTIONS = {
  time: 100,
  iterations: 5,
  warmupTime: 20,
  warmupIterations: 1
};

const schema = defineSchema({
  assetFiles: relation<AssetFile>({
    key: 'path',
    fields: {
      path: stringField(),
      directory: stringField(),
      name: stringField(),
      extension: stringField(),
      mediaType: stringField(),
      kind: stringField() as FieldSpec<AssetKind>,
      packageId: stringField(),
      byteLength: numberField(),
      sha256: stringField(),
      contentRef: stringField(),
      inlineText: optional(stringField()),
      lastAccessedAt: optional(numberField())
    }
  }),
  assetDependencies: relation<AssetDependency>({
    key: 'id',
    fields: {
      id: stringField(),
      fromPath: stringField(),
      toPath: stringField(),
      kind: stringField(),
      ordinal: numberField()
    }
  })
});

const file = as(schema.assetFiles, 'file');
const dependency = as(schema.assetDependencies, 'dependency');
const dependencyTarget = as(schema.assetFiles, 'dependencyTarget');
const assetFileRows = pipe(
  from(file),
  project({
    path: file.path,
    directory: file.directory,
    name: file.$.name,
    extension: file.extension,
    mediaType: file.mediaType,
    kind: file.$.kind,
    packageId: file.packageId,
    byteLength: file.byteLength,
    sha256: file.sha256,
    contentRef: file.contentRef
  })
) as Query<AssetFile>;
const dependencyRows = pipe(
  from(dependency),
  project({
    id: dependency.id,
    fromPath: dependency.fromPath,
    toPath: dependency.toPath,
    kind: dependency.$.kind,
    ordinal: dependency.ordinal
  })
) as Query<AssetDependency>;
const filesByPathIndex = pipe(assetFileRows, uniqueIndex(field<string>('row', 'path')));
const filesByDirectoryIndex = pipe(assetFileRows, sort(asc(field<string>('row', 'name'))), hash(field<string>('row', 'directory')));
const dependenciesByFromPathIndex = pipe(dependencyRows, sort(asc(field<number>('row', 'ordinal'))), hash(field<string>('row', 'fromPath')));
const manifestsByPackageIndex = pipe(
  assetFileRows,
  where(eq(field<AssetKind>('row', 'kind'), value('manifest'))),
  hash(field<string>('row', 'packageId'))
);
const fixture = makeFixture();
const refDb = createDb({
  assetFiles: fixture.files.map((row) => withoutInlineText(row)),
  assetDependencies: fixture.dependencies
});
const inlineDb = createDb({
  assetFiles: fixture.files,
  assetDependencies: fixture.dependencies
});
const indexedDb = mat(refDb, filesByPathIndex, filesByDirectoryIndex, dependenciesByFromPathIndex, manifestsByPackageIndex);
const assetIndexes = makeAssetIndexes(indexedDb);
const oracle = makeOracle(fixture);
const queries = makeQueries(fixture);
const requestMix = makeRequestMix();
const metrics: ProbeMetric[] = [];
let sink = 0;

assertRequestPathParity();

describe('asset filesystem hot paths for Probability/Royal-shaped packages', () => {
  bench('tarstate array query request mix', tarstateRequestProbe(refDb, queries, 'tarstate array query request mix', 'array-query'), BENCH_OPTIONS);
  bench('tarstate declared materialized index handle request mix', materializedRequestProbe('tarstate declared materialized index handle request mix'), BENCH_OPTIONS);
  bench('prebuilt map request oracle', oracleRequestProbe('prebuilt map request oracle'), BENCH_OPTIONS);
  bench('inline SVG projection stress edge', tarstateSvgInlineProbe(), BENCH_OPTIONS);
  bench('per-request access write stress edge', writeEdgeProbe(), BENCH_OPTIONS);
});

afterAll(() => {
  if (metrics.length === 0) return;

  console.table(metrics.map((metric) => ({
    probe: metric.probe,
    mode: metric.mode,
    samples: metric.samples,
    requests: metric.requests,
    writes: metric.writes,
    rowsPerRequest: ratio(metric.rowsRead, metric.requests),
    bytesRepresentedPerRequest: bytes(metric.bytesRepresented / Math.max(1, metric.requests)),
    heapNetPerRequest: bytes(metric.heapNetBytes / Math.max(1, metric.requests)),
    heapPositivePerRequest: bytes(metric.heapPositiveBytes / Math.max(1, metric.requests)),
    maxHeapPositiveSample: bytes(metric.maxHeapPositiveBytes),
    meanSampleMs: ms(metric.elapsedMs / Math.max(1, metric.samples)),
    p95SampleMs: ms(percentile(metric.sampleMs, 0.95)),
    maxSampleMs: ms(metric.maxSampleMs),
    usPerRequest: micros(metric.elapsedMs, metric.requests)
  })));

  console.table(ratioRows());
  console.info([
    'Asset filesystem guidance:',
    '- The array-query probe is an unindexed row-backed baseline for query-engine overhead on a Probability/Royal-shaped asset graph.',
    '- The materialized-index probe uses tarstate mat(...) plus index(...) handles over declared unique/hash queries; it is not claiming automatic q(where(...)) lookup pushdown.',
    '- The oracle is a handbuilt map lower bound for the same request rows, with parity checked at startup.',
    '- The inline SVG stress edge prices projecting body-sized strings through query results; the low-GC path should keep content in contentRef/R2/cache storage.',
    '- The write stress edge prices per-request access bookkeeping. If it is much higher, keep serving reads immutable and batch telemetry elsewhere.',
    '- bytesRepresented is not bytes copied; it is the asset payload size represented by metadata rows for throughput context.'
  ].join('\n'));
});

function tarstateRequestProbe(db: Db, querySet: QuerySet, label: string, mode: ProbeMode): () => void {
  const metric = registerMetric(label, mode);
  let cursor = 0;

  return () => {
    const startedAt = performance.now();
    const heapBefore = process.memoryUsage().heapUsed;
    let rowsRead = 0;
    let bytesRepresented = 0;

    for (let index = 0; index < SAMPLE_REQUESTS; index += 1) {
      const op = opAt(cursor);
      cursor += 1;
      const rows = q(db, queryFor(querySet, op));
      rowsRead += rows.length;
      bytesRepresented += consumeRows(rows);
    }

    record(metric, {
      elapsedMs: performance.now() - startedAt,
      heapDelta: process.memoryUsage().heapUsed - heapBefore,
      rowsRead,
      bytesRepresented,
      writes: 0
    });
  };
}

function oracleRequestProbe(label: string): () => void {
  const metric = registerMetric(label, 'oracle');
  let cursor = 0;

  return () => {
    const startedAt = performance.now();
    const heapBefore = process.memoryUsage().heapUsed;
    let rowsRead = 0;
    let bytesRepresented = 0;

    for (let index = 0; index < SAMPLE_REQUESTS; index += 1) {
      const rows = oracleRows(opAt(cursor));
      cursor += 1;
      rowsRead += rows.length;
      bytesRepresented += consumeRows(rows);
    }

    record(metric, {
      elapsedMs: performance.now() - startedAt,
      heapDelta: process.memoryUsage().heapUsed - heapBefore,
      rowsRead,
      bytesRepresented,
      writes: 0
    });
  };
}

function materializedRequestProbe(label: string): () => void {
  const metric = registerMetric(label, 'materialized-index');
  let cursor = 0;

  return () => {
    const startedAt = performance.now();
    const heapBefore = process.memoryUsage().heapUsed;
    let rowsRead = 0;
    let bytesRepresented = 0;

    for (let index = 0; index < SAMPLE_REQUESTS; index += 1) {
      const rows = materializedRows(opAt(cursor));
      cursor += 1;
      rowsRead += rows.length;
      bytesRepresented += consumeRows(rows);
    }

    record(metric, {
      elapsedMs: performance.now() - startedAt,
      heapDelta: process.memoryUsage().heapUsed - heapBefore,
      rowsRead,
      bytesRepresented,
      writes: 0
    });
  };
}

function tarstateSvgInlineProbe(): () => void {
  const metric = registerMetric('inline SVG payload projection edge', 'inline-svg');
  let cursor = 0;

  return () => {
    const startedAt = performance.now();
    const heapBefore = process.memoryUsage().heapUsed;
    let rowsRead = 0;
    let bytesRepresented = 0;

    for (let index = 0; index < SAMPLE_REQUESTS; index += 1) {
      const query = queries.inlineFile[cursor % queries.inlineFile.length];
      if (query === undefined) throw new Error('inline SVG query set is empty');
      cursor += 1;
      const rows = q(inlineDb, query);
      rowsRead += rows.length;
      bytesRepresented += consumeRows(rows);
    }

    record(metric, {
      elapsedMs: performance.now() - startedAt,
      heapDelta: process.memoryUsage().heapUsed - heapBefore,
      rowsRead,
      bytesRepresented,
      writes: 0
    });
  };
}

function writeEdgeProbe(): () => void {
  const metric = registerMetric('per-request access bookkeeping write edge', 'write-edge');
  let db = refDb;
  let cursor = 0;

  return () => {
    const startedAt = performance.now();
    const heapBefore = process.memoryUsage().heapUsed;
    let rowsRead = 0;
    let bytesRepresented = 0;
    let writes = 0;

    for (let index = 0; index < SAMPLE_REQUESTS; index += 1) {
      const op = opAt(cursor);
      cursor += 1;
      const rows = q(db, queryFor(queries, op));
      rowsRead += rows.length;
      bytesRepresented += consumeRows(rows);
      const path = firstPath(rows);
      if (path === undefined) continue;
      db = transact(db, updateByKey(schema.assetFiles, path, { lastAccessedAt: cursor }));
      writes += 1;
    }

    record(metric, {
      elapsedMs: performance.now() - startedAt,
      heapDelta: process.memoryUsage().heapUsed - heapBefore,
      rowsRead,
      bytesRepresented,
      writes
    });
  };
}

function makeQueries(input: Fixture): QuerySet {
  return {
    file: input.hotPaths.map((path) => fileQuery(path, false)),
    inlineFile: input.svgPaths.slice(0, HOT_REQUEST_COUNT).map((path) => fileQuery(path, true)),
    directory: input.directories.map(directoryQuery),
    dependencies: input.gltfPaths.map(dependencyQuery),
    manifest: input.packageIds.map(manifestQuery)
  };
}

function fileQuery(path: string, inlineBody: boolean): Query<unknown> {
  return pipe(
    from(file),
    where(eq(file.path, value(path))),
    project({
      path: file.path,
      mediaType: file.mediaType,
      byteLength: file.byteLength,
      sha256: file.sha256,
      contentRef: file.contentRef,
      ...(inlineBody ? { inlineText: file.inlineText } : {})
    })
  ) as Query<unknown>;
}

function directoryQuery(directory: string): Query<unknown> {
  return pipe(
    from(file),
    where(eq(file.directory, value(directory))),
    sort(asc(file.$.name)),
    project({
      path: file.path,
      name: file.$.name,
      kind: file.$.kind,
      mediaType: file.mediaType,
      byteLength: file.byteLength,
      contentRef: file.contentRef
    })
  ) as Query<unknown>;
}

function dependencyQuery(fromPath: string): Query<unknown> {
  return pipe(
    from(dependency),
    where(eq(dependency.fromPath, value(fromPath))),
    join(from(dependencyTarget), eq(dependency.toPath, dependencyTarget.path)),
    sort(asc(dependency.ordinal)),
    project({
      path: dependencyTarget.path,
      kind: dependencyTarget.$.kind,
      mediaType: dependencyTarget.mediaType,
      byteLength: dependencyTarget.byteLength,
      contentRef: dependencyTarget.contentRef
    })
  ) as Query<unknown>;
}

function manifestQuery(packageId: string): Query<unknown> {
  return pipe(
    from(file),
    where(and(
      eq(file.packageId, value(packageId)),
      eq(file.$.kind, value('manifest'))
    )),
    project({
      path: file.path,
      mediaType: file.mediaType,
      byteLength: file.byteLength,
      contentRef: file.contentRef
    })
  ) as Query<unknown>;
}

function queryFor(querySet: QuerySet, op: RequestOp): Query<unknown> {
  switch (op.kind) {
    case 'file':
      return item(querySet.file, op.index % querySet.file.length, 'file query');
    case 'directory':
      return item(querySet.directory, op.index % querySet.directory.length, 'directory query');
    case 'dependencies':
      return item(querySet.dependencies, op.index % querySet.dependencies.length, 'dependency query');
    case 'manifest':
      return item(querySet.manifest, op.index % querySet.manifest.length, 'manifest query');
  }
}

function oracleRows(op: RequestOp): readonly AssetFile[] {
  switch (op.kind) {
    case 'file': {
      const row = oracle.byPath.get(item(fixture.hotPaths, op.index % fixture.hotPaths.length, 'hot path'));
      return row === undefined ? [] : [row];
    }
    case 'directory':
      return oracle.byDirectory.get(item(fixture.directories, op.index % fixture.directories.length, 'directory')) ?? [];
    case 'dependencies':
      return oracle.depsByFromPath.get(item(fixture.gltfPaths, op.index % fixture.gltfPaths.length, 'gltf path')) ?? [];
    case 'manifest':
      return oracle.manifestByPackage.get(item(fixture.packageIds, op.index % fixture.packageIds.length, 'package id')) ?? [];
  }
}

function materializedRows(op: RequestOp): readonly AssetFile[] {
  switch (op.kind) {
    case 'file': {
      const row = assetIndexes.byPath.get(item(fixture.hotPaths, op.index % fixture.hotPaths.length, 'hot path'));
      return row === undefined ? [] : [row];
    }
    case 'directory':
      return assetIndexes.byDirectory.lookup(item(fixture.directories, op.index % fixture.directories.length, 'directory'));
    case 'dependencies':
      return assetIndexes.depsByFromPath.lookup(item(fixture.gltfPaths, op.index % fixture.gltfPaths.length, 'gltf path'))
        .flatMap((row) => {
          const target = assetIndexes.byPath.get(row.toPath);
          return target === undefined ? [] : [target];
        });
    case 'manifest':
      return assetIndexes.manifestByPackage.lookup(item(fixture.packageIds, op.index % fixture.packageIds.length, 'package id'));
  }
}

function makeRequestMix(): readonly RequestOp[] {
  return Array.from({ length: HOT_REQUEST_COUNT }, (_, index): RequestOp => {
    if (index % 17 === 0) return { kind: 'manifest', index };
    if (index % 7 === 0) return { kind: 'dependencies', index };
    if (index % 5 === 0) return { kind: 'directory', index };
    return { kind: 'file', index };
  });
}

function makeFixture(): Fixture {
  const files: AssetFile[] = [];
  const dependencies: AssetDependency[] = [];
  const hotPaths: string[] = [];
  const svgPaths: string[] = [];
  const gltfPaths: string[] = [];
  const directories = new Set<string>();
  const packageIds = Array.from({ length: PACKAGE_COUNT }, (_, index) => `package-${index}`);

  for (const packageId of packageIds) {
    const manifest = addFile(files, packageId, `${packageRoot(packageId)}/package.json`, 'manifest', 1_200);
    hotPaths.push(manifest.path);

    for (let index = 0; index < GLTF_PER_PACKAGE; index += 1) {
      const sceneRoot = `${packageRoot(packageId)}/models/scene-${index}`;
      const gltf = addFile(files, packageId, `${sceneRoot}/scene-${index}.gltf`, 'gltf', 8_000 + index * 41);
      const bin = addFile(files, packageId, `${sceneRoot}/scene-${index}.bin`, 'bin', 180_000 + index * 2_048);
      const cardSvg = addFile(files, packageId, `${sceneRoot}/scene-${index}-card.svg`, 'svg', 5_000 + index * 13, svgPayload(index));
      const textureA = addFile(files, packageId, `${sceneRoot}/texture-${index}-albedo.ktx2`, 'texture', 96_000 + index * 257);
      const textureN = addFile(files, packageId, `${sceneRoot}/texture-${index}-normal.ktx2`, 'texture', 88_000 + index * 251);
      const preview = addFile(files, packageId, `${sceneRoot}/preview-${index}.png`, 'image', 22_000 + index * 97);

      gltfPaths.push(gltf.path);
      svgPaths.push(cardSvg.path);
      hotPaths.push(gltf.path, cardSvg.path, preview.path);
      dependencies.push(
        dep(gltf, bin, 'buffer', 0),
        dep(gltf, textureA, 'texture', 1),
        dep(gltf, textureN, 'texture', 2),
        dep(gltf, cardSvg, 'svg-texture', 3),
        dep(gltf, preview, 'preview', 4)
      );
    }

    for (let index = 0; index < SVG_PER_PACKAGE; index += 1) {
      const path = `${packageRoot(packageId)}/cards/card-${index}.svg`;
      const row = addFile(files, packageId, path, 'svg', 3_000 + index * 17, svgPayload(index + 1_000));
      svgPaths.push(row.path);
      if (index % 4 === 0) hotPaths.push(row.path);
    }

    for (let index = 0; index < PAGE_TEXTURES_PER_PACKAGE; index += 1) {
      const mip = index % 5;
      const x = index % 16;
      const y = Math.floor(index / 16);
      const row = addFile(
        files,
        packageId,
        `${packageRoot(packageId)}/virtual-textures/pages/mip-${mip}/x${x}-y${y}.ktx2`,
        'texture',
        32_000 + mip * 4_096
      );
      if (index % 23 === 0) hotPaths.push(row.path);
    }
  }

  for (const row of files) directories.add(row.directory);

  return {
    files,
    dependencies,
    hotPaths: hotPaths.slice(0, HOT_REQUEST_COUNT),
    svgPaths,
    gltfPaths: gltfPaths.slice(0, HOT_REQUEST_COUNT),
    directories: Array.from(directories).slice(0, HOT_REQUEST_COUNT),
    packageIds
  };
}

function addFile(
  rows: AssetFile[],
  packageId: string,
  path: string,
  kind: AssetKind,
  byteLength: number,
  inlineText?: string
): AssetFile {
  const row = {
    path,
    directory: path.slice(0, path.lastIndexOf('/')),
    name: path.slice(path.lastIndexOf('/') + 1),
    extension: extensionFor(path),
    mediaType: mediaTypeFor(kind, path),
    kind,
    packageId,
    byteLength,
    sha256: stableHash(path),
    contentRef: `r2://probability-assets/${stableHash(`${path}:${byteLength}`)}`,
    ...(inlineText === undefined ? {} : { inlineText })
  } satisfies AssetFile;
  rows.push(row);
  return row;
}

function dep(fromFile: AssetFile, toFile: AssetFile, kind: string, ordinal: number): AssetDependency {
  return {
    id: `${fromFile.path}->${ordinal}`,
    fromPath: fromFile.path,
    toPath: toFile.path,
    kind,
    ordinal
  };
}

function makeOracle(input: Fixture): OracleIndex {
  const byPath = new Map(input.files.map((row) => [row.path, withoutInlineText(row)]));
  const byDirectory = new Map<string, AssetFile[]>();
  const depsByFromPath = new Map<string, AssetFile[]>();
  const manifestByPackage = new Map<string, AssetFile[]>();

  for (const row of input.files) {
    const clean = withoutInlineText(row);
    push(byDirectory, row.directory, clean);
    if (row.kind === 'manifest') push(manifestByPackage, row.packageId, clean);
  }
  for (const rows of byDirectory.values()) rows.sort((left, right) => left.name.localeCompare(right.name));

  for (const dependencyRow of input.dependencies) {
    const target = byPath.get(dependencyRow.toPath);
    if (target !== undefined) push(depsByFromPath, dependencyRow.fromPath, target);
  }

  return { byPath, byDirectory, depsByFromPath, manifestByPackage };
}

function makeAssetIndexes(db: Db): AssetIndexSet {
  return {
    byPath: expectUniqueStringIndex(materializedIndex<AssetFile>(db, filesByPathIndex), 'path', 'path'),
    byDirectory: expectHashStringIndex(materializedIndex<AssetFile>(db, filesByDirectoryIndex), 'directory', 'directory'),
    depsByFromPath: expectHashStringIndex(materializedIndex<AssetDependency>(db, dependenciesByFromPathIndex), 'fromPath', 'dependency'),
    manifestByPackage: expectHashStringIndex(materializedIndex<AssetFile>(db, manifestsByPackageIndex), 'packageId', 'manifest')
  };
}

function expectUniqueStringIndex<Row>(
  input: MaterializedIndex<Row> | undefined,
  fieldName: string,
  label: string
): MaterializedUniqueIndex<Row, string> {
  if (input?.op !== 'uniqueIndex' || input.field !== fieldName) {
    throw new Error(`missing materialized ${label} unique index`);
  }
  return input as MaterializedUniqueIndex<Row, string>;
}

function expectHashStringIndex<Row>(
  input: MaterializedIndex<Row> | undefined,
  fieldName: string,
  label: string
): MaterializedHashIndex<Row, string> {
  if (input?.op !== 'hash' || input.field !== fieldName) {
    throw new Error(`missing materialized ${label} hash index`);
  }
  return input as MaterializedHashIndex<Row, string>;
}

function assertRequestPathParity(): void {
  for (const [index, op] of requestMix.entries()) {
    const expected = pathsFor(oracleRows(op));
    assertSamePaths(expected, pathsFor(q(refDb, queryFor(queries, op))), 'array-query/oracle', index);
    assertSamePaths(expected, pathsFor(materializedRows(op)), 'materialized-index/oracle', index);
  }
}

function assertSamePaths(expected: readonly string[], actual: readonly string[], comparison: string, index: number): void {
  if (expected.join('\0') !== actual.join('\0')) {
    throw new Error(`${comparison} request mismatch at ${index}: expected ${expected.join(',')} got ${actual.join(',')}`);
  }
}

function withoutInlineText(row: AssetFile): AssetFile {
  return {
    path: row.path,
    directory: row.directory,
    name: row.name,
    extension: row.extension,
    mediaType: row.mediaType,
    kind: row.kind,
    packageId: row.packageId,
    byteLength: row.byteLength,
    sha256: row.sha256,
    contentRef: row.contentRef,
    ...(row.lastAccessedAt === undefined ? {} : { lastAccessedAt: row.lastAccessedAt })
  };
}

function push<Key, Value>(map: Map<Key, Value[]>, key: Key, value: Value): void {
  const existing = map.get(key);
  if (existing === undefined) {
    map.set(key, [value]);
  } else {
    existing.push(value);
  }
}

function opAt(cursor: number): RequestOp {
  return item(requestMix, cursor % requestMix.length, 'request op');
}

function consumeRows(rows: readonly unknown[]): number {
  let bytesRepresented = 0;
  for (const row of rows) {
    if (!isRecord(row)) continue;
    const byteLength = typeof row.byteLength === 'number' ? row.byteLength : 0;
    bytesRepresented += byteLength;
    const inlineText = typeof row.inlineText === 'string' ? row.inlineText : '';
    const pathText = typeof row.path === 'string' ? row.path : '';
    sink = (sink + byteLength + inlineText.length + pathText.length) % Number.MAX_SAFE_INTEGER;
  }
  if (sink < 0) throw new Error('unreachable benchmark sink');
  return bytesRepresented;
}

function firstPath(rows: readonly unknown[]): string | undefined {
  for (const row of rows) {
    if (isRecord(row) && typeof row.path === 'string') return row.path;
  }
  return undefined;
}

function pathsFor(rows: readonly unknown[]): readonly string[] {
  return rows.map((row) => isRecord(row) && typeof row.path === 'string' ? row.path : '<missing-path>');
}

function registerMetric(probe: string, mode: ProbeMode): ProbeMetric {
  const metric: ProbeMetric = {
    probe,
    mode,
    samples: 0,
    requests: 0,
    rowsRead: 0,
    bytesRepresented: 0,
    writes: 0,
    heapNetBytes: 0,
    heapPositiveBytes: 0,
    maxHeapPositiveBytes: 0,
    elapsedMs: 0,
    sampleMs: [],
    maxSampleMs: 0
  };
  metrics.push(metric);
  return metric;
}

function record(
  metric: ProbeMetric,
  sample: {
    readonly elapsedMs: number;
    readonly heapDelta: number;
    readonly rowsRead: number;
    readonly bytesRepresented: number;
    readonly writes: number;
  }
): void {
  const positiveHeap = Math.max(0, sample.heapDelta);
  metric.samples += 1;
  metric.requests += SAMPLE_REQUESTS;
  metric.rowsRead += sample.rowsRead;
  metric.bytesRepresented += sample.bytesRepresented;
  metric.writes += sample.writes;
  metric.heapNetBytes += sample.heapDelta;
  metric.heapPositiveBytes += positiveHeap;
  metric.maxHeapPositiveBytes = Math.max(metric.maxHeapPositiveBytes, positiveHeap);
  metric.elapsedMs += sample.elapsedMs;
  metric.sampleMs.push(sample.elapsedMs);
  metric.maxSampleMs = Math.max(metric.maxSampleMs, sample.elapsedMs);
}

function ratioRows(): readonly {
  readonly comparison: string;
  readonly usPerRequestRatio: string;
  readonly heapPositivePerRequestRatio: string;
}[] {
  const oracleMetric = metrics.find((metric) => metric.mode === 'oracle');
  if (oracleMetric === undefined) return [];
  return metrics
    .filter((metric) => metric !== oracleMetric)
    .map((metric) => ({
      comparison: `${metric.mode}/oracle`,
      usPerRequestRatio: ratio(
        microsNumber(metric.elapsedMs, metric.requests),
        microsNumber(oracleMetric.elapsedMs, oracleMetric.requests)
      ),
      heapPositivePerRequestRatio: ratio(
        metric.heapPositiveBytes / Math.max(1, metric.requests),
        oracleMetric.heapPositiveBytes / Math.max(1, oracleMetric.requests)
      )
    }));
}

function packageRoot(packageId: string): string {
  return `/packages/${packageId}`;
}

function extensionFor(path: string): string {
  const index = path.lastIndexOf('.');
  return index === -1 ? '' : path.slice(index + 1);
}

function mediaTypeFor(kind: AssetKind, path: string): string {
  switch (kind) {
    case 'gltf':
      return 'model/gltf+json';
    case 'glb':
      return 'model/gltf-binary';
    case 'bin':
      return 'application/octet-stream';
    case 'svg':
      return 'image/svg+xml';
    case 'image':
      return path.endsWith('.png') ? 'image/png' : 'image/jpeg';
    case 'texture':
      return 'image/ktx2';
    case 'manifest':
      return 'application/json';
  }
}

function svgPayload(seed: number): string {
  const paths = Array.from({ length: 20 + seed % 9 }, (_, index) =>
    `<path d="M${index} ${seed % 17}h${10 + index}v${5 + seed % 11}z" fill="#${stableHash(`${seed}:${index}`).slice(0, 6)}"/>`);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128">${paths.join('')}</svg>`;
}

function stableHash(input: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0').repeat(8).slice(0, 64);
}

function item<Value>(values: readonly Value[], index: number, label: string): Value {
  const found = values[index];
  if (found === undefined) throw new Error(`${label} ${index} is missing`);
  return found;
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === 'object' && input !== null && !Array.isArray(input);
}

function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return item(sorted, Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p)), 'percentile');
}

function micros(elapsedMs: number, samples: number): string {
  return `${microsNumber(elapsedMs, samples).toFixed(3)}`;
}

function microsNumber(elapsedMs: number, samples: number): number {
  return samples === 0 ? 0 : elapsedMs * 1_000 / samples;
}

function ratio(numerator: number, denominator: number): string {
  if (denominator === 0) return numerator === 0 ? '0.00' : 'inf';
  return (numerator / denominator).toFixed(2);
}

function bytes(byteCount: number): string {
  const abs = Math.abs(byteCount);
  if (abs < 1_024) return `${byteCount.toFixed(0)} B`;
  if (abs < 1_048_576) return `${(byteCount / 1_024).toFixed(1)} KiB`;
  return `${(byteCount / 1_048_576).toFixed(2)} MiB`;
}

function ms(value: number): string {
  return `${value.toFixed(3)} ms`;
}
