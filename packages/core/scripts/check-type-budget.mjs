import { createRequire } from 'node:module';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = dirname(here);
const require = createRequire(import.meta.url);
const ts = require('typescript');
const outDir = mkdtempSync(join(tmpdir(), 'tarstate-type-budget-'));

const thresholds = {
  types: 75_000,
  instantiations: 150_000,
  memoryKilobytes: 300_000,
  declarationBytes: 1_000_000
};

try {
  const configPath = join(packageRoot, 'type-fixtures/tsconfig.json');
  const loaded = ts.readConfigFile(configPath, (path) => ts.sys.readFile(path));
  if (loaded.error !== undefined) throw new Error(formatDiagnostics([loaded.error]));
  const parsed = ts.parseJsonConfigFileContent(loaded.config, ts.sys, dirname(configPath), {
    outDir,
    declaration: true,
    emitDeclarationOnly: true,
    noEmit: false,
    extendedDiagnostics: true
  }, configPath);
  if (parsed.errors.length > 0) throw new Error(formatDiagnostics(parsed.errors));
  const program = ts.createProgram({ rootNames: parsed.fileNames, options: parsed.options });
  const diagnostics = ts.getPreEmitDiagnostics(program);
  const emitted = program.emit();
  const allDiagnostics = [...diagnostics, ...emitted.diagnostics];
  if (allDiagnostics.length > 0) throw new Error(`Type budget fixture failed to compile:\n${formatDiagnostics(allDiagnostics)}`);

  const declarationBytes = directoryBytes(outDir);
  const measured = {
    // These are the exact Program counters reported by `tsc --extendedDiagnostics`.
    types: program.getTypeCount(),
    instantiations: program.getInstantiationCount(),
    memoryKilobytes: Math.ceil(process.memoryUsage().heapUsed / 1024),
    declarationBytes
  };
  const failures = Object.entries(measured).filter(([name, value]) => value > thresholds[name]);
  if (failures.length > 0) {
    throw new Error(`Type budget exceeded: ${failures.map(([name, value]) => `${name}=${value} > ${thresholds[name]}`).join(', ')}`);
  }
  process.stdout.write(`${JSON.stringify({ fixture: 'core/type-fixtures/authoring-budget.ts', counterSource: 'tsc --extendedDiagnostics Program counters', measured, thresholds })}\n`);
} finally {
  rmSync(outDir, { recursive: true, force: true });
}

function directoryBytes(directory) {
  let total = 0;
  for (const name of readdirSync(directory)) {
    const path = join(directory, name);
    const stat = statSync(path);
    if (stat.isDirectory()) total += directoryBytes(path);
    else if (name.endsWith('.d.ts')) total += readFileSync(path).byteLength;
  }
  return total;
}

function formatDiagnostics(diagnostics) {
  return ts.formatDiagnosticsWithColorAndContext(diagnostics, {
    getCanonicalFileName: (fileName) => fileName,
    getCurrentDirectory: () => packageRoot,
    getNewLine: () => '\n'
  });
}
