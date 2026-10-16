#!/usr/bin/env node
// Trivy scans with one security policy for the repository and the container images.
//
//   node scripts/ci/trivy-scan.mjs fs        # dependencies (package-lock.json), secrets, Dockerfile misconfigurations
//   (images: scripts/ci/images.mjs scan, which calls scanImage below)
//
// Each scan writes the full Trivy JSON report (every severity) and a readable table (.txt) to reports/trivy/,
// prints a summary and fails when a finding breaks the policy:
//   - vulnerabilities: HIGH or CRITICAL with a fixed version available (unfixed ones are reported only,
//     because nothing can be upgraded to remove them)
//   - secrets and misconfigurations: HIGH or CRITICAL
// Accepted risks go into .trivyignore.yaml with a reason, an expiry date and, where possible, the affected
// paths (see security/README.md).
// Secret values are never printed: only the file, line and rule.
import { mkdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { repoRoot, run } from './lib.mjs';

export const trivyReportsDir = resolve(repoRoot, process.env.TRIVY_REPORTS_DIR ?? 'reports/trivy');
const BLOCKING = new Set(['HIGH', 'CRITICAL']);
const SEVERITIES = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'UNKNOWN'];

function commonArgs() {
  const args = ['--quiet', '--ignorefile', resolve(repoRoot, '.trivyignore.yaml'), '--exit-code', '0'];
  if (process.env.TRIVY_CACHE_DIR) args.push('--cache-dir', process.env.TRIVY_CACHE_DIR);
  return args;
}

export async function trivy(args) {
  const { code } = await run('trivy', [...args.slice(0, 1), ...commonArgs(), ...args.slice(1)]);
  if (code !== 0) throw new Error(`trivy ${args[0]} exited with ${code}`);
}

/**
 * Renders a JSON report as Trivy's table format next to it (<name>.txt), without scanning again.
 * The JSON report does not record the scanners; without them Trivy omits the summary table, so a clean
 * report would render as an empty file.
 */
export async function writeTextReport(reportFile, scanners) {
  const output = reportFile.replace(/\.json$/, '.txt');
  const { code } = await run('trivy', ['convert', '--quiet', '--scanners', scanners, '--format', 'table', '--output', output, reportFile]);
  if (code !== 0) throw new Error(`trivy convert exited with ${code}`);
}

/** Applies the policy to a Trivy JSON report; prints a summary and returns the number of blocking findings. */
export function evaluate(reportFile, label) {
  const report = JSON.parse(readFileSync(reportFile, 'utf8'));
  const counts = Object.fromEntries(SEVERITIES.map((s) => [s, 0]));
  const blocking = [];
  let unfixedHigh = 0;
  for (const result of report.Results ?? []) {
    for (const v of result.Vulnerabilities ?? []) {
      counts[v.Severity] = (counts[v.Severity] ?? 0) + 1;
      if (!BLOCKING.has(v.Severity)) continue;
      if (v.FixedVersion) {
        blocking.push(`${v.Severity} ${v.VulnerabilityID} ${v.PkgName} ${v.InstalledVersion} -> ${v.FixedVersion} (${result.Target})`);
      } else {
        unfixedHigh += 1;
      }
    }
    for (const s of result.Secrets ?? []) {
      counts[s.Severity] = (counts[s.Severity] ?? 0) + 1;
      if (BLOCKING.has(s.Severity)) blocking.push(`${s.Severity} secret ${s.RuleID} at ${result.Target}:${s.StartLine}`);
    }
    for (const m of result.Misconfigurations ?? []) {
      if (m.Status !== 'FAIL') continue;
      counts[m.Severity] = (counts[m.Severity] ?? 0) + 1;
      if (BLOCKING.has(m.Severity)) blocking.push(`${m.Severity} ${m.ID} ${m.Title} (${result.Target})`);
    }
  }
  const summary = SEVERITIES.map((s) => `${s} ${counts[s]}`).join(', ');
  console.log(`[trivy] ${label}: ${summary}${unfixedHigh ? ` (${unfixedHigh} HIGH/CRITICAL without a fix: reported, not blocking)` : ''}`);
  for (const line of blocking) console.log(`[trivy]   BLOCKING ${line}`);
  return blocking.length;
}

/** Filesystem scan of the repository; returns the number of blocking findings. */
export async function scanFilesystem() {
  mkdirSync(trivyReportsDir, { recursive: true });
  const output = resolve(trivyReportsDir, 'filesystem.json');
  await trivy([
    'fs',
    '--scanners', 'vuln,secret,misconfig',
    // Dependencies are read from package-lock.json; node_modules and build output add only noise.
    '--skip-dirs', '**/node_modules',
    '--skip-dirs', '**/dist',
    '--skip-dirs', 'reports',
    '--format', 'json',
    '--output', output,
    repoRoot,
  ]);
  await writeTextReport(output, 'vuln,secret,misconfig');
  return evaluate(output, 'repository (filesystem)');
}

/**
 * Scans an image held by the Docker daemon (DOCKER_HOST): vulnerabilities and secrets, plus a
 * CycloneDX SBOM. Returns the number of blocking findings.
 */
export async function scanImage(imageRef, name, sbomDir) {
  mkdirSync(trivyReportsDir, { recursive: true });
  mkdirSync(sbomDir, { recursive: true });
  const output = resolve(trivyReportsDir, `image-${name}.json`);
  await trivy(['image', '--image-src', 'docker', '--format', 'cyclonedx', '--output', resolve(sbomDir, `${name}.cdx.json`), imageRef]);
  await trivy(['image', '--image-src', 'docker', '--scanners', 'vuln,secret', '--format', 'json', '--output', output, imageRef]);
  await writeTextReport(output, 'vuln,secret');
  return evaluate(output, `image ${imageRef}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv[2] !== 'fs') {
    console.error('Usage: node scripts/ci/trivy-scan.mjs fs');
    process.exit(2);
  }
  const blocking = await scanFilesystem();
  if (blocking > 0) {
    console.error(`ERROR: ${blocking} finding(s) break the security policy. Full report: reports/trivy/filesystem.json`);
    process.exit(1);
  }
  console.log('[trivy] repository passed the security policy.');
}
