import { performance } from 'node:perf_hooks';
import { runGoldenConformanceWorkloads } from '../packages/core/dist/golden-workloads.js';

const requestedIterations = Number.parseInt(process.env.TARSTATE_BENCH_ITERATIONS ?? '250', 10);
const iterations = Number.isSafeInteger(requestedIterations) && requestedIterations > 0 ? requestedIterations : 250;
const requestedBudget = Number(process.env.TARSTATE_BENCH_BUDGET_MS ?? 50);
const budgetPerIterationMs = Number.isFinite(requestedBudget) && requestedBudget > 0 ? requestedBudget : 50;

for (let index = 0; index < 10; index += 1) runGoldenConformanceWorkloads();
const started = performance.now();
let traces = [];
for (let index = 0; index < iterations; index += 1) traces = runGoldenConformanceWorkloads();
const elapsedMs = performance.now() - started;
const perIterationMs = elapsedMs / iterations;

process.stdout.write(JSON.stringify({
  benchmark: 'tarstate-v1-coarse-golden-workloads',
  fixtureStatus: traces.map(({ label, fixtureStatus }) => ({ label, fixtureStatus })),
  iterations,
  totalMs: Number(elapsedMs.toFixed(3)),
  perIterationMs: Number(perIterationMs.toFixed(3)),
  budgetPerIterationMs,
  withinBudget: perIterationMs <= budgetPerIterationMs,
  node: process.version
}, null, 2) + '\n');

if (perIterationMs > budgetPerIterationMs) process.exitCode = 1;
