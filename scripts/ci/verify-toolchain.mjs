#!/usr/bin/env node
// Prints tool versions and fails early when the build agent cannot run the pipeline.
// Required Node.js/npm versions come from "engines" in the root package.json.
// Only versions are printed: never environment variables.
//
//   node scripts/ci/verify-toolchain.mjs
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { repoRoot, run } from './lib.mjs';

const engines = JSON.parse(readFileSync(resolve(repoRoot, 'package.json'), 'utf8')).engines ?? {};

function parseVersion(text) {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(text);
  return match ? match.slice(1, 4).map(Number) : undefined;
}

function compare(a, b) {
  for (let i = 0; i < 3; i += 1) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}

/** Supports the ">=X[.Y[.Z]]" ranges used in package.json engines. */
function satisfies(version, range) {
  const match = /^>=\s*(\d+)(?:\.(\d+))?(?:\.(\d+))?$/.exec(range.trim());
  if (!match) throw new Error(`Unsupported engines range "${range}" (only ">=X.Y.Z" is supported)`);
  const minimum = [Number(match[1]), Number(match[2] ?? 0), Number(match[3] ?? 0)];
  return compare(version, minimum) >= 0;
}

const errors = [];

async function toolVersion(label, command, args) {
  try {
    const { code, stdout, stderr } = await run(command, args, { capture: true });
    if (code !== 0) {
      errors.push(`${label}: '${command} ${args.join(' ')}' exited with ${code}: ${stderr.trim().split('\n')[0] ?? ''}`);
      return undefined;
    }
    return stdout.trim();
  } catch {
    errors.push(`${label}: '${command}' was not found on PATH`);
    return undefined;
  }
}

function checkRange(label, raw, range) {
  if (raw === undefined) return;
  const version = parseVersion(raw);
  const ok = version !== undefined && (range === undefined || satisfies(version, range));
  console.log(`  ${label.padEnd(16)} ${raw.split('\n')[0]}${range ? `  (required ${range})` : ''}  ${ok ? 'OK' : 'FAIL'}`);
  if (!ok) errors.push(`${label} ${raw} does not satisfy ${range}`);
}

console.log('Toolchain:');
checkRange('node', process.version, engines.node);
checkRange('npm', await toolVersion('npm', 'npm', ['--version']), engines.npm);
checkRange('git', await toolVersion('git', 'git', ['--version']));
checkRange('docker client', await toolVersion('docker client', 'docker', ['version', '--format', '{{.Client.Version}}']));
// The integration tests start a disposable PostgreSQL container, so the daemon must be reachable.
checkRange('docker server', await toolVersion('docker daemon', 'docker', ['version', '--format', '{{.Server.Version}}']));
console.log(`  ${'platform'.padEnd(16)} ${process.platform}/${process.arch}`);

if (errors.length > 0) {
  for (const error of errors) console.error(`ERROR: ${error}`);
  console.error('The build agent is missing a required tool. See jenkins/README.md (Troubleshooting).');
  process.exit(1);
}
console.log('Toolchain OK.');
