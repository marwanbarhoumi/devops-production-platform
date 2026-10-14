#!/usr/bin/env node
// Container images of the three services: build, scan, publish, clean up.
// Runs against the Docker daemon in DOCKER_HOST (in Jenkins: the Docker-in-Docker sidecar).
//
//   node scripts/ci/images.mjs build     # docker build + OCI labels; writes reports/images/manifest.json
//   node scripts/ci/images.mjs scan      # Trivy vulnerabilities/secrets + CycloneDX SBOM per image (policy: trivy-scan.mjs)
//   node scripts/ci/images.mjs push      # pushes every tag; needs a prior `docker login` (Jenkinsfile)
//   node scripts/ci/images.mjs cleanup   # removes this build's tags from the daemon
//
// Tags (immutable, never "latest"):
//   <IMAGE_PREFIX>/<service>:<git sha, 12 chars>        e.g. .../api-gateway:5cb002204bb2
//   <IMAGE_PREFIX>/<service>:<version>-<git sha, 7>     e.g. .../api-gateway:0.1.0-5cb0022  (version: service package.json)
// IMAGE_PREFIX defaults to ghcr.io/marwanbarhoumi/devops-production-platform.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { repoRoot, run, serviceName, workspaces } from './lib.mjs';
import { scanImage } from './trivy-scan.mjs';

const imagesDir = resolve(repoRoot, 'reports/images');
const manifestFile = resolve(imagesDir, 'manifest.json');
const sbomDir = resolve(repoRoot, 'reports/sbom');
const prefix = (process.env.IMAGE_PREFIX ?? 'ghcr.io/marwanbarhoumi/devops-production-platform').replace(/\/+$/, '');

async function capture(command, args) {
  const result = await run(command, args, { capture: true });
  if (result.code !== 0) throw new Error(`${command} ${args[0]} failed (exit ${result.code}): ${result.stderr.trim()}`);
  return result.stdout.trim();
}

async function mustRun(command, args) {
  const { code } = await run(command, args);
  if (code !== 0) throw new Error(`${command} ${args.slice(0, 2).join(' ')} failed (exit ${code})`);
}

function readManifest() {
  if (!existsSync(manifestFile)) throw new Error('reports/images/manifest.json not found: run "images.mjs build" first');
  return JSON.parse(readFileSync(manifestFile, 'utf8'));
}

async function build() {
  const sha = process.env.GIT_COMMIT || (await capture('git', ['rev-parse', 'HEAD']));
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error(`unexpected git commit "${sha}"`);
  const created = new Date().toISOString();
  const images = [];
  for (const workspace of workspaces()) {
    const service = serviceName(workspace);
    const { version } = JSON.parse(readFileSync(resolve(repoRoot, workspace, 'package.json'), 'utf8'));
    const tags = [`${prefix}/${service}:${sha.slice(0, 12)}`, `${prefix}/${service}:${version}-${sha.slice(0, 7)}`];
    console.log(`\n=== Image: ${service} (${tags.join(', ')}) ===`);
    await mustRun('docker', [
      'build',
      '--file', `${workspace}/Dockerfile`,
      '--label', `org.opencontainers.image.title=${service}`,
      '--label', `org.opencontainers.image.version=${version}`,
      '--label', `org.opencontainers.image.revision=${sha}`,
      '--label', `org.opencontainers.image.created=${created}`,
      '--label', 'org.opencontainers.image.source=https://github.com/marwanbarhoumi/devops-production-platform',
      '--label', `dpp.ci.run=${process.env.CI_RUN_ID ?? 'local'}`,
      ...tags.flatMap((tag) => ['--tag', tag]),
      '.',
    ]);
    const id = await capture('docker', ['image', 'inspect', '--format', '{{.Id}}', tags[0]]);
    const size = Number(await capture('docker', ['image', 'inspect', '--format', '{{.Size}}', tags[0]]));
    images.push({ service, version, revision: sha, tags, id, sizeMB: Math.round(size / 1e6) });
  }
  mkdirSync(imagesDir, { recursive: true });
  writeFileSync(manifestFile, `${JSON.stringify({ prefix, images }, null, 2)}\n`);
  for (const image of images) console.log(`[images] built ${image.tags[0]} (${image.sizeMB} MB)`);
}

async function scan() {
  const { images } = readManifest();
  let blocking = 0;
  // Every image is scanned before failing, so one build shows all findings.
  for (const image of images) blocking += await scanImage(image.tags[0], image.service, sbomDir);
  if (blocking > 0) {
    console.error(`ERROR: ${blocking} image finding(s) break the security policy. Reports: reports/trivy/image-*.json`);
    process.exit(1);
  }
  console.log('[images] all images passed the security policy; SBOMs in reports/sbom/');
}

async function push() {
  const manifest = readManifest();
  for (const image of manifest.images) {
    for (const tag of image.tags) await mustRun('docker', ['push', '--quiet', tag]);
    const digests = JSON.parse(await capture('docker', ['image', 'inspect', '--format', '{{json .RepoDigests}}', image.tags[0]]));
    image.digest = digests.find((d) => d.startsWith(`${prefix}/${image.service}@`));
    console.log(`[images] published ${image.tags.join(', ')} -> ${image.digest ?? 'digest unknown'}`);
  }
  writeFileSync(resolve(imagesDir, 'published.json'), `${JSON.stringify(manifest, null, 2)}\n`);
}

async function cleanup() {
  if (!existsSync(manifestFile)) return;
  const tags = readManifest().images.flatMap((image) => image.tags);
  // Base layers and the build cache stay, so the next build is fast.
  const { code } = await run('docker', ['image', 'rm', '--force', ...tags], { capture: true });
  console.log(`[images] cleanup: ${code === 0 ? `removed ${tags.length} tag(s)` : 'nothing to remove'}`);
  await run('docker', ['image', 'prune', '--force'], { capture: true });
}

const commands = { build, scan, push, cleanup };
const command = commands[process.argv[2]];
if (!command) {
  console.error('Usage: node scripts/ci/images.mjs build|scan|push|cleanup');
  process.exit(2);
}
try {
  await command();
} catch (err) {
  console.error(`ERROR: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
