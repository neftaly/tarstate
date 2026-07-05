import { afterAll, bench, describe } from 'vitest';
import {
  canonicalSchemaManifest,
  hydrateSchemaManifest,
  stringifyCanonicalSchemaManifest,
  toSchemaManifest,
  type HydrateSchemaManifestResult,
  type HydratedSchema,
  type SchemaManifestV1,
  type ToSchemaManifestOptions
} from '@tarstate/core/schema';
import { makeSchemaManifestFuzzCase, type SchemaManifestFuzzCase } from '../tests/schema-manifest-fuzz-fixtures.js';

const BENCH_OPTIONS = {
  time: 150,
  iterations: 8,
  warmupTime: 30,
  warmupIterations: 2
};

const schemaBenchmarkProfiles = [
  { label: 'small', seed: 8_191, relationCount: 6, fieldsPerRelation: 5 },
  { label: 'medium', seed: 16_381, relationCount: 32, fieldsPerRelation: 8 },
  { label: 'large', seed: 32_749, relationCount: 96, fieldsPerRelation: 10 }
] as const;
const benchmarkMetrics: SchemaBenchmarkMetric[] = [];
let benchmarkSink = 0;

type SchemaBenchmarkMetric = {
  readonly profile: string;
  readonly stage: string;
  readonly relations: number;
  readonly fields: number;
  readonly canonicalBytes: number;
};

describe('core schema manifest pipeline', () => {
  for (const profile of schemaBenchmarkProfiles) {
    const fuzzCase = makeSchemaManifestFuzzCase(profile.seed, profile.relationCount, profile.fieldsPerRelation);
    const canonical = canonicalSchemaManifest(fuzzCase.manifest);
    const canonicalText = stringifyCanonicalSchemaManifest(canonical);
    const hydrated = hydrateBenchmarkSchema(canonical, fuzzCase);
    const sharedMetric = {
      profile: profile.label,
      relations: Object.keys(canonical.relations).length,
      fields: Object.values(canonical.relations).reduce((total, relation) => total + Object.keys(relation.fields).length, 0),
      canonicalBytes: canonicalText.length
    };

    describe(profile.label, () => {
      bench('canonicalize', recordBenchmarkMetric({ ...sharedMetric, stage: 'canonicalize' }, () => {
        consumeManifest(canonicalSchemaManifest(fuzzCase.manifest));
      }), BENCH_OPTIONS);

      bench('canonical stringify', recordBenchmarkMetric({ ...sharedMetric, stage: 'canonical stringify' }, () => {
        benchmarkSink += stringifyCanonicalSchemaManifest(fuzzCase.manifest).length;
      }), BENCH_OPTIONS);

      bench('hydrate collect', recordBenchmarkMetric({ ...sharedMetric, stage: 'hydrate collect' }, () => {
        const result = hydrateSchemaManifest(canonical, {
          diagnosticMode: 'collect',
          codecs: fuzzCase.runtimeCodecs
        }) as HydrateSchemaManifestResult;
        if (result.schema === undefined || result.diagnostics.length > 0) throw new Error('benchmark hydration failed');
        consumeHydratedSchema(result.schema);
      }), BENCH_OPTIONS);

      bench('export hydrated', recordBenchmarkMetric({ ...sharedMetric, stage: 'export hydrated' }, () => {
        consumeManifest(toSchemaManifest(
          hydrated,
          manifestExportOptions(canonical.schemaId, canonical.metadata, canonical.codecs)
        ));
      }), BENCH_OPTIONS);
    });
  }
});

afterAll(() => {
  if (benchmarkMetrics.length === 0) return;
  console.table(benchmarkMetrics);
  if (benchmarkSink < 0) throw new Error('unreachable benchmark sink');
});

function hydrateBenchmarkSchema(manifest: SchemaManifestV1, fuzzCase: SchemaManifestFuzzCase): HydratedSchema {
  const result = hydrateSchemaManifest(manifest, {
    diagnosticMode: 'collect',
    codecs: fuzzCase.runtimeCodecs
  }) as HydrateSchemaManifestResult;
  if (result.schema === undefined || result.diagnostics.length > 0) throw new Error('benchmark hydration failed');
  return result.schema;
}

function recordBenchmarkMetric(metric: SchemaBenchmarkMetric, fn: () => void): () => void {
  benchmarkMetrics.push(metric);
  return fn;
}

function consumeManifest(manifest: SchemaManifestV1): void {
  benchmarkSink += Object.keys(manifest.relations).length;
  benchmarkSink += Object.values(manifest.relations).reduce((total, relation) => total + Object.keys(relation.fields).length, 0);
}

function consumeHydratedSchema(schema: HydratedSchema): void {
  benchmarkSink += Object.keys(schema).length;
  benchmarkSink += Object.values(schema).reduce((total, relation) => total + Object.keys(relation.fields).length, 0);
}

function manifestExportOptions(
  schemaId: string,
  metadata: ToSchemaManifestOptions['metadata'],
  codecs: ToSchemaManifestOptions['codecs']
): ToSchemaManifestOptions {
  return {
    schemaId,
    ...(metadata === undefined ? {} : { metadata }),
    ...(codecs === undefined ? {} : { codecs })
  };
}
