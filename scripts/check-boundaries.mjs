import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const coreSource = path.join(root, 'packages/core/src');
const satelliteSources = ['automerge', 'react', 'schema-tools', 'zustand'].map((name) => path.join(root, 'packages', name, 'src'));

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
const inlineImportPattern = /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g;

const staticDependencies = (source) => [
  ...Array.from(source.matchAll(importPattern), (match) => ({ typeOnly: match[1] !== undefined, specifier: match[2] })),
  ...Array.from(source.matchAll(exportPattern), (match) => ({ typeOnly: match[1] !== undefined, specifier: match[2] })),
  ...Array.from(source.matchAll(inlineImportPattern), (match) => ({ typeOnly: true, specifier: match[1] }))
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
  'canonical-json.ts',
  'capability-model.ts',
  'internal-canonical-json.ts',
  'internal-frozen-analysis.ts',
  'internal-json-equality.ts',
  'internal-numeric-boundary.ts',
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
assignArchitectureGroup('source-contract', ['attachment/model.ts', 'logical-edit.ts', 'source-protocol.ts', 'source-state.ts']);
assignArchitectureGroup('schema', [
  'codec.ts',
  'constraints.ts',
  'internal-document-declaration.ts',
  'internal-semantic-provenance.ts',
  'lens.ts',
  'mapping.ts',
  'schema-authoring.ts',
  'schema.ts'
]);
assignArchitectureGroup('query-model', [
  'query/incremental-model.ts',
  'query/internal/syntax-walk.ts',
  'query/model.ts',
  'query/plan-contract.ts'
]);
assignArchitectureGroup('query-batch', [
  'query/internal/prepared-expression.ts',
  'query/internal/prepared-plan.ts',
  'query/internal/equality.ts',
  'query/internal/evaluation-context.ts',
  'query/internal/evaluator.ts',
  'query/internal/expression.ts',
  'query/internal/graph.ts',
  'query/internal/input-validation.ts',
  'query/internal/ordering.ts',
  'query/internal/ownership.ts',
  'query/internal/relations.ts',
  'query/internal/values.ts',
  'query/internal/window-maintenance.ts',
  'query/authoring.ts',
  'query/builder.ts',
  'query/evaluate.ts',
  'query/plan.ts',
  'query/prepare.ts',
  'query/typed-plan.ts'
]);
assignArchitectureGroup('query-incremental', [
  'query/internal/dependency.ts',
  'query/internal/aggregate-maintenance.ts',
  'query/internal/join-maintenance.ts',
  'query/internal/maintenance-diagnostics.ts',
  'query/internal/maintenance-engine.ts',
  'query/internal/maintenance-model.ts',
  'query/internal/maintenance-transition.ts',
  'query/internal/pool-publication.ts',
  'maintenance.ts',
  'query/incremental.ts',
  'query/maintenance-diff.ts'
]);
assignArchitectureGroup('transaction-model', [
  'database/transaction.ts',
  'internal-transaction-expression.ts',
  'receipts.ts',
  'relation-delta-authoring.ts',
  'transaction-authoring.ts',
  'transaction.ts'
]);
assignArchitectureGroup('semantic-artifact', [
  'constraint-artifact.ts',
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
assignArchitectureGroup('attachment-runtime', [
  'attachment/logical-constraint-query.ts',
  'attachment/preparation.ts',
  'attachment/transaction-snapshot.ts',
  'attachment/transaction-service.ts'
]);
assignArchitectureGroup('observer-contract', ['database-model.ts', 'observer-maintenance-contracts.ts']);
assignArchitectureGroup('observer', [
  'database.ts',
  'external-store.ts',
  'internal-observer-capture-core.ts',
  'internal-observer-dataset-capture.ts',
  'internal-observer-maintenance-frame.ts',
  'internal-observer-values.ts',
  'observer.ts'
]);
assignArchitectureGroup('observer-incremental', ['internal-observer-maintenance-frames.ts', 'internal-observer-query-maintenance.ts']);
assignArchitectureGroup('database-session', [
  'database/follow-source-links.ts',
  'database/query-session.ts',
  'database/source-link-graph.ts',
  'database/source-mount.ts'
]);
assignArchitectureGroup('system', ['system-relations.ts']);
assignArchitectureGroup('composition', [
  'golden-workloads.ts',
  'index.ts',
  'query.ts',
  'root.ts',
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
  'attachment-runtime': ['foundation', 'capability', 'artifact-resolution', 'source-contract', 'schema', 'query-model', 'query-batch', 'transaction-model', 'semantic-artifact', 'transaction-runtime'],
  'observer-contract': ['foundation', 'source-contract', 'query-model'],
  'observer': ['foundation', 'capability', 'source-contract', 'schema', 'query-model', 'query-batch', 'attachment-runtime', 'observer-contract'],
  'observer-incremental': ['foundation', 'query-model', 'query-batch', 'query-incremental', 'observer-contract', 'observer'],
  'database-session': ['foundation', 'source-contract', 'query-model', 'query-batch', 'observer-contract', 'observer', 'observer-incremental'],
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
  'capabilities/index.ts': ['foundation', 'capability'],
  'artifacts/index.ts': ['foundation', 'capability', 'artifact-resolution'],
  'source/index.ts': ['foundation', 'source-contract'],
  'attachment/index.ts': ['foundation', 'source-contract'],
  'attachment/adapter/index.ts': ['foundation', 'capability', 'artifact-resolution', 'source-contract', 'schema', 'query-model', 'query-batch', 'transaction-model', 'semantic-artifact', 'transaction-runtime', 'attachment-runtime'],
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
  'database/observer/index.ts': ['foundation', 'source-contract', 'schema', 'query-model', 'query-batch', 'attachment-runtime', 'observer-contract', 'observer'],
  'database/session/index.ts': ['foundation', 'source-contract', 'schema', 'query-model', 'query-batch', 'query-incremental', 'attachment-runtime', 'observer-contract', 'observer', 'observer-incremental', 'database-session'],
  'database/incremental/index.ts': ['foundation', 'source-contract', 'schema', 'query-model', 'query-batch', 'query-incremental', 'observer-contract', 'observer', 'observer-incremental'],
  'database/external-store/index.ts': ['foundation', 'capability', 'source-contract', 'schema', 'query-model', 'query-batch', 'attachment-runtime', 'observer-contract', 'observer'],
  'database/index.ts': ['foundation', 'capability', 'source-contract', 'schema', 'query-model', 'query-batch', 'transaction-model', 'transaction-runtime', 'attachment-runtime', 'observer-contract', 'observer', 'system'],
  'schema/index.ts': ['foundation', 'capability', 'source-contract', 'schema'],
  'transactions/index.ts': ['foundation', 'capability', 'source-contract', 'schema', 'query-model', 'query-batch', 'transaction-model', 'semantic-artifact', 'transaction-runtime']
}));

const publicDeclarationPolicyAdditions = new Map(Object.entries({
  'database/index.ts': ['artifact-resolution', 'semantic-artifact'],
  'database/observer/index.ts': ['capability', 'artifact-resolution', 'semantic-artifact'],
  'database/session/index.ts': ['capability', 'artifact-resolution', 'semantic-artifact']
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
  'attachment/model.ts': ['artifacts.ts', 'issues.ts', 'source-protocol.ts', 'source-state.ts'],
  'internal-semantic-provenance.ts': ['internal-provenance-registry.ts'],
  'logical-edit.ts': ['issues.ts', 'value.ts'],
  'query/incremental-model.ts': ['query/model.ts', 'query/plan-contract.ts', 'value.ts'],
  'query/model.ts': ['artifacts.ts', 'issues.ts', 'query/plan-contract.ts', 'value.ts'],
  'query/plan-contract.ts': [],
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
  'attachment/preparation.ts': ['semantic-artifact-parsers.ts', 'semantic-query-artifact.ts', 'semantic-schema-lens-artifact.ts', 'semantic-transaction-artifact.ts'],
  'internal-semantic-schema-lens-validation.ts': ['internal-semantic-query-validation.ts'],
  'internal-semantic-storage-mapping-validation.ts': ['internal-semantic-query-validation.ts'],
  'observer.ts': ['internal-observer-query-maintenance.ts', 'query/incremental.ts'],
  'query/evaluate.ts': ['internal-observer-query-maintenance.ts', 'query/incremental.ts'],
  'query/prepare.ts': ['internal-observer-query-maintenance.ts', 'query/internal/evaluator.ts', 'query/internal/expression.ts', 'query/incremental.ts']
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

const coreManifest = JSON.parse(readFileSync(path.join(root, 'packages/core/package.json'), 'utf8'));
const publicCoreSpecifiers = new Set(Object.keys(coreManifest.exports).map((specifier) => (
  specifier === '.' ? '@tarstate/core' : '@tarstate/core/' + specifier.slice(2)
)));

for (const satelliteSource of satelliteSources) {
  for (const file of sourceFiles(satelliteSource)) {
    const source = readFileSync(file, 'utf8');
    for (const dependency of staticDependencies(source)) {
      if (dependency.specifier === '@tarstate/core' || dependency.specifier.startsWith('@tarstate/core/')) {
        if (!publicCoreSpecifiers.has(dependency.specifier)) {
          throw new Error(relative(file) + ' imports non-public core module ' + dependency.specifier);
        }
        continue;
      }
      if (dependency.specifier.startsWith('@tarstate/')) {
        throw new Error(relative(file) + ' couples satellite packages through ' + dependency.specifier);
      }
    }
  }
}

for (const name of ['mutation-store.ts', 'optimistic-store.ts', 'query-store.ts']) {
  const file = path.join(root, 'packages/react/src', name);
  const source = readFileSync(file, 'utf8');
  if (/\bclass\s|\bthis\./.test(source)) {
    throw new Error('React store state machines must keep transitions in closure-based shells: ' + relative(file));
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
