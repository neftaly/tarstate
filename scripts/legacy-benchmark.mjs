import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = resolve(import.meta.dirname, '..');
const worktree = resolve(process.argv[2] ?? '/tmp/tarstate-legacy-v0');

const run = (command, args, cwd = root) => {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit' });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
};

if (!existsSync(worktree)) {
  run('git', ['worktree', 'add', '--detach', worktree, 'legacy-v0-final']);
}

run('pnpm', ['install', '--frozen-lockfile'], worktree);
run('pnpm', ['bench'], worktree);
