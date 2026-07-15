import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const coreSource = path.join(root, 'packages/core/src');
const satelliteSources = ['automerge', 'react', 'schema-tools', 'zustand']
  .map((name) => path.join(root, 'packages', name, 'src'));

const sourceFiles = (directory) => readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
  const location = path.join(directory, entry.name);
  return entry.isDirectory() ? sourceFiles(location) : location.endsWith('.ts') ? [location] : [];
});

const coreFiles = sourceFiles(coreSource);
const coreFileSet = new Set(coreFiles);
const allDependencies = new Map(coreFiles.map((file) => [file, new Set()]));
const runtimeDependencies = new Map(coreFiles.map((file) => [file, new Set()]));

const importPattern = /^\s*import\s+(type\s+)?(?:[^;]+?\s+from\s+)?['"]([^'"]+)['"]\s*;/gm;
const exportPattern = /^\s*export\s+(type\s+)?[^;]*?\s+from\s+['"]([^'"]+)['"]\s*;/gm;

const staticDependencies = (source) => [
  ...Array.from(source.matchAll(importPattern), (match) => ({ typeOnly: match[1] !== undefined, specifier: match[2] })),
  ...Array.from(source.matchAll(exportPattern), (match) => ({ typeOnly: match[1] !== undefined, specifier: match[2] }))
];

const resolveCoreDependency = (importer, specifier) => {
  if (!specifier.startsWith('.')) return undefined;
  const target = path.resolve(path.dirname(importer), specifier.replace(/\.js$/, '.ts'));
  if (!coreFileSet.has(target)) throw new Error(relative(importer) + ' imports missing core module ' + specifier);
  return target;
};

for (const file of coreFiles) {
  const source = readFileSync(file, 'utf8');
  for (const dependency of staticDependencies(source)) {
    const target = resolveCoreDependency(file, dependency.specifier);
    if (target === undefined) continue;
    allDependencies.get(file).add(target);
    if (!dependency.typeOnly) runtimeDependencies.get(file).add(target);
  }
}

const architectureGroups = new Map();
const assignArchitectureGroup = (group, names) => {
  for (const name of names) {
    const file = path.join(coreSource, name);
    if (!coreFileSet.has(file)) throw new Error('Architecture group ' + group + ' names missing module ' + name);
    if (architectureGroups.has(file)) throw new Error(name + ' belongs to multiple architecture groups');
    architectureGroups.set(file, group);
  }
};

assignArchitectureGroup('foundation', [
  'artifacts.ts',
  'built-in-capability-declarations.ts',
  'capability-model.ts',
  'internal-canonical-json.ts',
  'internal-owned-json.ts',
  'internal-owned-map.ts',
  'observer-diagnostics.ts',
  'internal-pipe.ts',
  'internal-provenance-registry.ts',
  'internal-seal.ts',
  'internal-string-key.ts',
  'issues.ts',
  'portable-order.ts',
  'value.ts'
]);
assignArchitectureGroup('capability', ['builtins.ts', 'host.ts', 'registry.ts', 'resolver.ts']);
assignArchitectureGroup('artifact-resolution', ['artifact-resolver.ts']);
assignArchitectureGroup('source-contract', ['attachment-model.ts', 'logical-edit.ts', 'source-protocol.ts', 'source-state.ts']);
assignArchitectureGroup('schema', [
  'codec.ts',
  'constraint-artifact.ts',
  'constraints.ts',
  'internal-document-declaration.ts',
  'internal-semantic-provenance.ts',
  'lens.ts',
  'mapping.ts',
  'schema-authoring.ts',
  'schema.ts'
]);
assignArchitectureGroup('query-model', ['query-incremental-model.ts', 'query-model.ts', 'query-plan-contract.ts']);
assignArchitectureGroup('query-batch', [
  'internal-prepared-expression.ts',
  'internal-prepared-plan.ts',
  'internal-query-equality.ts',
  'internal-query-evaluation-context.ts',
  'internal-query-evaluator.ts',
  'internal-query-expression.ts',
  'internal-query-graph.ts',
  'internal-query-input-validation.ts',
  'internal-query-ownership.ts',
  'internal-query-relations.ts',
  'internal-query-values.ts',
  'query-authoring.ts',
  'query-builder.ts',
  'query-evaluate.ts',
  'query-plan.ts',
  'query-prepare.ts'
]);
assignArchitectureGroup('query-incremental', [
  'internal-query-aggregate-maintenance.ts',
  'internal-query-join-maintenance.ts',
  'internal-query-maintenance-diagnostics.ts',
  'internal-query-maintenance-engine.ts',
  'internal-query-maintenance-model.ts',
  'internal-query-maintenance-transition.ts',
  'maintenance.ts',
  'query-incremental.ts',
  'query-maintenance-diff.ts'
]);
assignArchitectureGroup('transaction-model', ['receipts.ts', 'relation-delta-authoring.ts', 'transaction-authoring.ts', 'transaction.ts']);
assignArchitectureGroup('semantic-artifact', [
  'internal-constraint-set-preparation.ts',
  'internal-semantic-artifact-validation.ts',
  'internal-semantic-constraint-validation.ts',
  'internal-semantic-query-validation.ts',
  'internal-semantic-schema-lens-validation.ts',
  'internal-semantic-storage-mapping-validation.ts',
  'internal-semantic-transaction-validation.ts',
  'semantic-constraint-artifact.ts',
  'semantic-query-artifact.ts',
  'semantic-schema-lens-artifact.ts',
  'semantic-storage-mapping-artifact.ts',
  'semantic-transaction-artifact.ts'
]);
assignArchitectureGroup('transaction-runtime', [
  'commit-coordinator.ts',
  'internal-coordinator-outcome.ts',
  'lifecycle-governance.ts',
  'transaction-executor.ts'
]);
assignArchitectureGroup('attachment-runtime', ['attachment-preparation.ts']);
assignArchitectureGroup('observer-contract', ['database-model.ts', 'observer-maintenance-contracts.ts']);
assignArchitectureGroup('observer', [
  'database.ts',
  'external-store.ts',
  'internal-observer-dataset-capture.ts',
  'internal-observer-maintenance-frame.ts',
  'internal-observer-values.ts',
  'observer.ts'
]);
assignArchitectureGroup('observer-incremental', ['internal-observer-maintenance-frames.ts', 'internal-observer-query-maintenance.ts']);
assignArchitectureGroup('source-runtime', ['memory-source.ts', 'memory-storage-source.ts']);
assignArchitectureGroup('system', ['system-relations.ts']);
assignArchitectureGroup('composition', [
  'golden-workloads.ts',
  'index.ts',
  'query.ts',
  'semantic-artifact-parsers.ts',
  'type-authoring.ts'
]);

for (const file of coreFiles) {
  if (path.basename(file) === 'index.ts') architectureGroups.set(file, 'composition');
  if (!architectureGroups.has(file)) throw new Error(relative(file) + ' has no architecture group');
}

const allowedArchitectureDependencies = new Map(Object.entries({
  'foundation': [],
  'capability': ['foundation'],
  'artifact-resolution': ['foundation', 'capability'],
  'source-contract': ['foundation'],
  'schema': ['foundation', 'capability', 'source-contract'],
  'query-model': ['foundation'],
  'query-batch': ['foundation', 'capability', 'schema', 'query-model'],
  'query-incremental': ['foundation', 'source-contract', 'query-model', 'query-batch'],
  'transaction-model': ['foundation', 'source-contract', 'schema', 'query-model', 'query-batch'],
  'semantic-artifact': ['foundation', 'capability', 'source-contract', 'schema', 'query-model', 'query-batch', 'transaction-model'],
  'transaction-runtime': ['foundation', 'capability', 'source-contract', 'schema', 'query-model', 'query-batch', 'transaction-model', 'semantic-artifact'],
  'attachment-runtime': ['foundation', 'capability', 'artifact-resolution', 'source-contract', 'schema', 'semantic-artifact'],
  'observer-contract': ['foundation', 'source-contract', 'query-model'],
  'observer': ['foundation', 'capability', 'source-contract', 'schema', 'query-model', 'query-batch', 'attachment-runtime', 'observer-contract'],
  'observer-incremental': ['foundation', 'query-model', 'query-batch', 'query-incremental', 'observer-contract', 'observer'],
  'source-runtime': ['foundation', 'capability', 'source-contract', 'schema', 'query-model', 'query-batch', 'transaction-model', 'semantic-artifact', 'transaction-runtime'],
  'system': ['foundation', 'source-contract', 'schema', 'query-model', 'query-batch', 'transaction-model', 'transaction-runtime'],
  'composition': [...new Set(architectureGroups.values())]
}));

for (const [file, dependencies] of allDependencies) {
  const group = architectureGroups.get(file);
  if (group === 'composition') continue;
  const allowed = new Set([group, ...(allowedArchitectureDependencies.get(group) ?? [])]);
  for (const dependency of dependencies) {
    const dependencyGroup = architectureGroups.get(dependency);
    if (!allowed.has(dependencyGroup)) {
      throw new Error(relative(file) + ' crosses architecture direction ' + group + ' -> ' + dependencyGroup + ' via ' + relative(dependency));
    }
  }
}

const publicRuntimePolicies = new Map(Object.entries({
  'foundation/index.ts': ['foundation'],
  'capabilities/index.ts': ['foundation', 'capability'],
  'artifacts/index.ts': ['foundation', 'capability', 'artifact-resolution'],
  'source/index.ts': ['foundation', 'source-contract'],
  'attachment/index.ts': ['foundation', 'source-contract'],
  'attachment/prepare/index.ts': ['foundation', 'capability', 'artifact-resolution', 'source-contract', 'schema', 'query-model', 'query-batch', 'semantic-artifact', 'attachment-runtime'],
  'query/model/index.ts': ['foundation', 'query-model'],
  'query/prepare/index.ts': ['foundation', 'capability', 'schema', 'query-model', 'query-batch'],
  'query/authoring/index.ts': ['foundation', 'capability', 'schema', 'query-model', 'query-batch'],
  'query/evaluate/index.ts': ['foundation', 'capability', 'schema', 'query-model', 'query-batch'],
  'query/incremental/index.ts': ['foundation', 'capability', 'schema', 'query-model', 'query-batch', 'query-incremental'],
  'artifacts/query/index.ts': ['foundation', 'capability', 'schema', 'query-model', 'query-batch', 'semantic-artifact'],
  'artifacts/transaction/index.ts': ['foundation', 'capability', 'source-contract', 'schema', 'query-model', 'query-batch', 'transaction-model', 'semantic-artifact'],
  'artifacts/constraint-set/index.ts': ['foundation', 'capability', 'source-contract', 'schema', 'query-model', 'query-batch', 'semantic-artifact'],
  'artifacts/storage-mapping/index.ts': ['foundation', 'capability', 'source-contract', 'schema', 'semantic-artifact'],
  'artifacts/schema-lens/index.ts': ['foundation', 'capability', 'source-contract', 'schema', 'semantic-artifact'],
  'artifacts/semantic/index.ts': ['foundation', 'capability', 'source-contract', 'schema', 'query-model', 'query-batch', 'transaction-model', 'semantic-artifact'],
  'database/observer/index.ts': ['foundation', 'source-contract', 'schema', 'query-model', 'query-batch', 'attachment-runtime', 'observer-contract', 'observer'],
  'database/incremental/index.ts': ['foundation', 'source-contract', 'schema', 'query-model', 'query-batch', 'query-incremental', 'observer-contract', 'observer', 'observer-incremental'],
  'database/external-store/index.ts': ['foundation', 'capability', 'source-contract', 'schema', 'query-model', 'query-batch', 'attachment-runtime', 'observer-contract', 'observer'],
  'schema/index.ts': ['foundation', 'capability', 'source-contract', 'schema'],
  'transactions/index.ts': ['foundation', 'capability', 'source-contract', 'schema', 'query-model', 'query-batch', 'transaction-model', 'semantic-artifact', 'transaction-runtime']
}));

const publicDeclarationPolicyAdditions = new Map(Object.entries({
  'database/observer/index.ts': ['capability', 'artifact-resolution', 'semantic-artifact']
}));

for (const [entryName, allowedGroups] of publicRuntimePolicies) {
  const entry = path.join(coreSource, entryName);
  const runtimeAllowed = new Set(['composition', ...allowedGroups]);
  for (const file of dependencyClosure(entry, runtimeDependencies)) {
    const group = architectureGroups.get(file);
    if (!runtimeAllowed.has(group)) {
      throw new Error(entryName + ' runtime closure reaches forbidden architecture group ' + group + ' via ' + relative(file));
    }
  }
  const declarationAllowed = new Set([
    ...runtimeAllowed,
    ...(publicDeclarationPolicyAdditions.get(entryName) ?? [])
  ]);
  for (const file of dependencyClosure(entry, allDependencies)) {
    const group = architectureGroups.get(file);
    if (!declarationAllowed.has(group)) {
      throw new Error(entryName + ' declaration closure reaches forbidden architecture group ' + group + ' via ' + relative(file));
    }
  }
}

const contractDependencies = new Map(Object.entries({
  'attachment-model.ts': ['artifacts.ts', 'issues.ts', 'source-protocol.ts', 'source-state.ts'],
  'internal-semantic-provenance.ts': ['internal-provenance-registry.ts'],
  'logical-edit.ts': ['issues.ts', 'value.ts'],
  'query-incremental-model.ts': ['query-model.ts', 'query-plan-contract.ts', 'value.ts'],
  'query-model.ts': ['artifacts.ts', 'issues.ts', 'query-plan-contract.ts', 'value.ts'],
  'query-plan-contract.ts': [],
  'source-protocol.ts': ['artifacts.ts', 'issues.ts', 'logical-edit.ts', 'source-state.ts'],
  'source-state.ts': ['issues.ts', 'value.ts']
}));

for (const [name, allowedNames] of contractDependencies) {
  const file = path.join(coreSource, name);
  const allowed = new Set(allowedNames.map((allowedName) => path.join(coreSource, allowedName)));
  for (const dependency of allDependencies.get(file) ?? []) {
    if (!allowed.has(dependency)) {
      throw new Error(name + ' crosses its contract boundary by importing ' + path.basename(dependency));
    }
  }
}

const forbiddenDirectDependencies = new Map(Object.entries({
  'attachment-preparation.ts': ['semantic-artifact-parsers.ts', 'semantic-query-artifact.ts', 'semantic-schema-lens-artifact.ts', 'semantic-transaction-artifact.ts'],
  'internal-semantic-schema-lens-validation.ts': ['internal-semantic-query-validation.ts'],
  'internal-semantic-storage-mapping-validation.ts': ['internal-semantic-query-validation.ts'],
  'observer.ts': ['internal-observer-query-maintenance.ts', 'query-incremental.ts'],
  'query-evaluate.ts': ['internal-observer-query-maintenance.ts', 'query-incremental.ts'],
  'query-prepare.ts': ['internal-observer-query-maintenance.ts', 'internal-query-evaluator.ts', 'internal-query-expression.ts', 'query-incremental.ts']
}));

for (const [name, forbiddenNames] of forbiddenDirectDependencies) {
  const file = path.join(coreSource, name);
  const forbidden = new Set(forbiddenNames.map((forbiddenName) => path.join(coreSource, forbiddenName)));
  for (const dependency of allDependencies.get(file) ?? []) {
    if (forbidden.has(dependency)) {
      throw new Error(name + ' imports forbidden higher-level module ' + path.basename(dependency));
    }
  }
}

const assertAcyclic = (name, graph) => {
  const visiting = new Set();
  const visited = new Set();
  const stack = [];
  const visit = (file) => {
    if (visited.has(file)) return;
    if (visiting.has(file)) {
      const start = stack.indexOf(file);
      const cycle = [...stack.slice(start), file].map(relative).join(' -> ');
      throw new Error(name + ' dependency cycle: ' + cycle);
    }
    visiting.add(file);
    stack.push(file);
    for (const dependency of graph.get(file)) visit(dependency);
    stack.pop();
    visiting.delete(file);
    visited.add(file);
  };
  for (const file of coreFiles) visit(file);
};

assertAcyclic('runtime', runtimeDependencies);
assertAcyclic('source/declaration', allDependencies);

for (const directory of satelliteSources) {
  for (const file of sourceFiles(directory)) {
    const source = readFileSync(file, 'utf8');
    for (const { specifier } of staticDependencies(source)) {
      if (specifier === '@tarstate/core') {
        throw new Error(relative(file) + ' imports the broad @tarstate/core root instead of an architectural subpath');
      }
    }
    if (/import\(\s*['"]@tarstate\/core['"]\s*\)/.test(source)) {
      throw new Error(relative(file) + ' type-imports the broad @tarstate/core root instead of an architectural subpath');
    }
  }
}

console.log('Verified architecture directions, source-owned public closures, acyclic dependencies, and narrow satellite imports.');

function relative(file) {
  return path.relative(root, file).replaceAll(path.sep, '/');
}

function dependencyClosure(entry, graph) {
  const seen = new Set();
  const visit = (file) => {
    if (seen.has(file)) return;
    seen.add(file);
    for (const dependency of graph.get(file) ?? []) visit(dependency);
  };
  visit(entry);
  return seen;
}
