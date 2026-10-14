// Small helpers shared by the CI scripts. No dependencies beyond Node.js itself.
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const repoRoot = fileURLToPath(new URL('../..', import.meta.url));

/** Workspace directories (e.g. "services/product-service") as declared in the root package.json. */
export function workspaces() {
  const pkg = JSON.parse(readFileSync(resolve(repoRoot, 'package.json'), 'utf8'));
  return pkg.workspaces;
}

export function serviceName(workspace) {
  return basename(workspace);
}

/**
 * Runs a command asynchronously (so signal handlers stay responsive) and resolves with its exit code.
 * Output is streamed to this process unless `capture` is set.
 */
export function run(command, args, { env, capture = false, cwd = repoRoot } = {}) {
  // When started through npm, call npm's CLI with the current Node binary: this avoids the Windows
  // npm.cmd shim, which can only be spawned through a shell.
  const npmCli = process.env.npm_execpath;
  const viaNpmCli = command === 'npm' && npmCli && /npm-cli\.js$/.test(npmCli);
  const [file, fileArgs] = viaNpmCli ? [process.execPath, [npmCli, ...args]] : [command, args];
  const useShell = !viaNpmCli && process.platform === 'win32' && command === 'npm';
  return new Promise((resolvePromise, reject) => {
    const child = useShell
      ? spawn([file, ...fileArgs].join(' '), {
          cwd,
          env: env ?? process.env,
          stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
          shell: true,
        })
      : spawn(file, fileArgs, { cwd, env: env ?? process.env, stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit' });
    let stdout = '';
    let stderr = '';
    if (capture) {
      child.stdout.on('data', (chunk) => (stdout += chunk));
      child.stderr.on('data', (chunk) => (stderr += chunk));
    }
    child.on('error', reject);
    child.on('close', (code, signal) => resolvePromise({ code: code ?? (signal ? 1 : 0), stdout, stderr }));
  });
}

/**
 * Fails loudly when an expected JUnit report is missing or is not a JUnit document, so a crashed
 * test runner can never look like "no tests ran" in Jenkins.
 */
export function verifyJUnitReports(files) {
  const problems = [];
  for (const file of files) {
    if (!existsSync(file) || statSync(file).size === 0) {
      problems.push(`missing report: ${file}`);
      continue;
    }
    const xml = readFileSync(file, 'utf8');
    const match = /<testsuites\b[^>]*\btests="(\d+)"/.exec(xml);
    if (!match) {
      problems.push(`not a JUnit report: ${file}`);
    } else if (Number(match[1]) === 0) {
      problems.push(`report contains no tests: ${file}`);
    }
  }
  return problems;
}
