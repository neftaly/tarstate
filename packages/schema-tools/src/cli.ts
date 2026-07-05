#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { emitSchemaArtifacts, type SchemaArtifactKind } from './index.js';

type CliOptions = {
  readonly manifestPath: string;
  readonly outDir: string;
  readonly artifacts?: readonly SchemaArtifactKind[];
};

const artifactAliases = {
  manifest: 'manifest',
  typescript: 'typescript',
  ts: 'typescript',
  'json-schema': 'json-schema',
  jsonSchema: 'json-schema',
  prompt: 'prompt-card',
  'prompt-card': 'prompt-card',
  promptCard: 'prompt-card',
  examples: 'examples'
} as const satisfies Readonly<Record<string, SchemaArtifactKind>>;
const artifactAliasMap: Readonly<Record<string, SchemaArtifactKind>> = artifactAliases;

export async function runCli(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  const options = parseCliOptions(argv);
  const manifestText = await readFile(options.manifestPath, 'utf8');
  const manifest = JSON.parse(manifestText) as unknown;
  const artifactSet = emitSchemaArtifacts(manifest, options.artifacts === undefined ? {} : { artifacts: options.artifacts });
  for (const artifact of artifactSet.artifacts) {
    const outputPath = path.join(options.outDir, artifact.path);
    await mkdir(path.dirname(outputPath), { recursive: true });
    await writeFile(outputPath, artifact.content, 'utf8');
  }
}

function parseCliOptions(argv: readonly string[]): CliOptions {
  if (argv.length === 0 || argv.includes('--help') || argv.includes('-h')) throw new CliUsage(helpText(), 0);
  const [command, manifestPath, ...rest] = argv;
  if (command !== 'generate') throw new CliUsage(`Unknown command "${command ?? ''}".\n\n${helpText()}`, 1);
  if (manifestPath === undefined || manifestPath.startsWith('-')) throw new CliUsage(`Missing manifest path.\n\n${helpText()}`, 1);

  let outDir = '.tarstate/schema';
  let artifacts: readonly SchemaArtifactKind[] | undefined;
  for (let index = 0; index < rest.length; index += 1) {
    const item = rest[index];
    switch (item) {
      case '--out':
      case '-o': {
        const value = rest[index + 1];
        if (value === undefined) throw new CliUsage(`Missing value for ${item}.`, 1);
        outDir = value;
        index += 1;
        break;
      }
      case '--artifacts': {
        const value = rest[index + 1];
        if (value === undefined) throw new CliUsage('Missing value for --artifacts.', 1);
        artifacts = parseArtifacts(value);
        index += 1;
        break;
      }
      default:
        throw new CliUsage(`Unknown option "${item ?? ''}".\n\n${helpText()}`, 1);
    }
  }

  return artifacts === undefined ? { manifestPath, outDir } : { manifestPath, outDir, artifacts };
}

function parseArtifacts(input: string): readonly SchemaArtifactKind[] {
  return input.split(',').map((item) => {
    const key = item.trim();
    const artifact = artifactAliasMap[key];
    if (artifact === undefined) throw new CliUsage(`Unknown artifact "${key}".`, 1);
    return artifact;
  });
}

function helpText(): string {
  return [
    'Usage:',
    '  tarstate-schema generate <schema.manifest.json> --out .tarstate/schema --artifacts manifest,typescript,json-schema,prompt-card,examples'
  ].join('\n');
}

class CliUsage extends Error {
  readonly exitCode: number;

  constructor(message: string, exitCode: number) {
    super(message);
    this.name = 'CliUsage';
    this.exitCode = exitCode;
  }
}

export function isDirectCliRun(moduleUrl = import.meta.url, argvPath: string | undefined = process.argv[1]): boolean {
  if (argvPath === undefined) return false;
  return realPathOrResolvedPath(argvPath) === realPathOrResolvedPath(fileURLToPath(moduleUrl));
}

function realPathOrResolvedPath(input: string): string {
  try {
    return realpathSync(input);
  } catch {
    return path.resolve(input);
  }
}

if (isDirectCliRun()) {
  runCli().catch((error: unknown) => {
    if (error instanceof CliUsage) {
      const output = error.exitCode === 0 ? console.log : console.error;
      output(error.message);
      process.exitCode = error.exitCode;
      return;
    }
    console.error(error);
    process.exitCode = 1;
  });
}
