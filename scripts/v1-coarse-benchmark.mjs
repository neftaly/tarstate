import { performance } from 'node:perf_hooks';
import { runGoldenConformanceWorkloads } from '../packages/core/dist/index.js';

const iterations = Math.max(1, Number.parseInt(process.env.TARSTATE_BENCH_ITERATIONS ?? '250', 10));

for (let index = 0; index < 10; index += 1) runGoldenConformanceWorkloads();
const started = performance.now();
let traces = [];
for (let index = 0; index < iterations; index += 1) traces = runGoldenConformanceWorkloads();
const elapsedMs = performance.now() - started;

process.stdout.write(JSON.stringify({
  benchmark: 'tarstate-v1-coarse-golden-workloads',
  fixtureStatus: traces.map(({ label, fixtureStatus }) => ({ label, fixtureStatus })),
  iterations,
  totalMs: Number(elapsedMs.toFixed(3)),
  perIterationMs: Number((elapsedMs / iterations).toFixed(3)),
  node: process.version
}, null, 2) + '\n');
