#!/usr/bin/env node
// Disposable PostgreSQL for integration tests (CI and local).
//
// - One container per run, named dpp-it-<run id> and labelled dpp.ci.run=<run id>.
// - Same image as docker-compose.yml and the same init script (infra/postgres/init), copied in with
//   `docker cp` instead of a bind mount, so it also works when the Docker daemon is remote
//   (e.g. the Docker-in-Docker sidecar of the Jenkins agent).
// - Data lives on tmpfs: no volume is created, nothing survives the run.
// - Passwords are random per run and handed to Docker through environment variables only,
//   never as command-line arguments.
//
// CLI (backstop cleanup, e.g. from a Jenkins `post` block):
//   CI_RUN_ID=<id> node scripts/ci/ephemeral-postgres.mjs cleanup
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import net from 'node:net';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { repoRoot, run } from './lib.mjs';

const LABEL = 'dpp.ci.run';
const READY_TIMEOUT_MS = 90_000;
const PULL_ATTEMPTS = 3;

/** Docker-safe identifier derived from CI_RUN_ID (Jenkins BUILD_TAG) or a random value. */
export function resolveRunId(raw = process.env.CI_RUN_ID) {
  const source = raw && raw.trim() !== '' ? raw : `local-${randomBytes(4).toString('hex')}`;
  const id = source
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, '-')
    .replace(/^[^a-z0-9]+/, '')
    .slice(-48);
  if (id === '') throw new Error('CI_RUN_ID does not contain any usable characters');
  return id;
}

function postgresImage() {
  const compose = readFileSync(resolve(repoRoot, 'docker-compose.yml'), 'utf8');
  const match = /^\s*image:\s*(postgres:\S+)\s*$/m.exec(compose);
  if (!match) throw new Error('Could not find the postgres image in docker-compose.yml');
  return match[1];
}

/** Host the tests should connect to: the Docker daemon's host when DOCKER_HOST is tcp://..., else loopback. */
function databaseHost() {
  if (process.env.INTEGRATION_DB_HOST) return process.env.INTEGRATION_DB_HOST;
  const dockerHost = process.env.DOCKER_HOST ?? '';
  if (dockerHost.startsWith('tcp://')) return new URL(dockerHost).hostname;
  return '127.0.0.1';
}

const isLoopback = (host) => ['127.0.0.1', 'localhost', '::1'].includes(host);

async function docker(args, options = {}) {
  const result = await run('docker', args, { capture: true, ...options });
  if (result.code !== 0) {
    throw new Error(`docker ${args[0]} failed (exit ${result.code}): ${result.stderr.trim()}`);
  }
  return result.stdout.trim();
}

function redact(text, secrets) {
  return secrets.reduce((out, secret) => out.split(secret).join('***'), text);
}

function tcpReachable(host, port) {
  return new Promise((resolvePromise) => {
    const socket = net.connect({ host, port, timeout: 2000 });
    socket.once('connect', () => {
      socket.destroy();
      resolvePromise(true);
    });
    socket.once('timeout', () => {
      socket.destroy();
      resolvePromise(false);
    });
    socket.once('error', () => resolvePromise(false));
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Pulls the image unless it is already present. Retries because a registry download can be cut off
 * mid-layer ("short read ... unexpected EOF"); layers that completed are kept between attempts.
 */
async function ensureImage(image, log) {
  if ((await run('docker', ['image', 'inspect', image], { capture: true })).code === 0) return;
  for (let attempt = 1; ; attempt++) {
    log(`[ephemeral-postgres] pulling ${image} (attempt ${attempt}/${PULL_ATTEMPTS})`);
    const result = await run('docker', ['pull', '--quiet', image], { capture: true });
    if (result.code === 0) return;
    const reason = result.stderr.trim().split('\n').pop();
    if (attempt >= PULL_ATTEMPTS) throw new Error(`docker pull ${image} failed ${attempt} times: ${reason}`);
    log(`[ephemeral-postgres] pull failed (${reason}); retrying in ${attempt * 5}s`);
    await sleep(attempt * 5000);
  }
}

/** Removes every container created for the given run id (and their anonymous volumes). */
export async function cleanupRun(runId) {
  const ids = (await docker(['ps', '-aq', '--filter', `label=${LABEL}=${runId}`])).split(/\s+/).filter(Boolean);
  if (ids.length === 0) return 0;
  await docker(['rm', '--force', '--volumes', ...ids]);
  return ids.length;
}

/**
 * Starts a disposable PostgreSQL with the per-service databases and roles from infra/postgres/init.
 * Returns connection details for the tests and an idempotent `stop()`.
 */
export async function startEphemeralPostgres({ runId = resolveRunId(), log = console.log } = {}) {
  const name = `dpp-it-${runId}`;
  const host = databaseHost();
  const bindAddress = isLoopback(host) ? '127.0.0.1' : '0.0.0.0';
  const secrets = {
    POSTGRES_PASSWORD: randomBytes(24).toString('base64url'),
    PRODUCT_DB_PASSWORD: randomBytes(24).toString('base64url'),
    ORDER_DB_PASSWORD: randomBytes(24).toString('base64url'),
  };
  const image = postgresImage();

  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    const removed = await cleanupRun(runId);
    log(`[ephemeral-postgres] removed ${removed} container(s) for run ${runId}`);
  };

  // A previous attempt with the same run id (e.g. a Jenkins replay) may have left a container behind.
  await cleanupRun(runId);
  await ensureImage(image, log);

  log(`[ephemeral-postgres] starting ${name} (${image}), published on ${bindAddress}:<random port>`);
  try {
    await docker(
      [
        'create',
        '--name', name,
        '--label', `${LABEL}=${runId}`,
        '--label', 'dpp.ci.purpose=integration-db',
        '--env', 'POSTGRES_USER=postgres',
        '--env', 'POSTGRES_PASSWORD',
        '--env', 'PRODUCT_DB_PASSWORD',
        '--env', 'ORDER_DB_PASSWORD',
        '--tmpfs', '/var/lib/postgresql/data:rw',
        '--memory', '512m',
        '--publish', `${bindAddress}::5432`,
        image,
      ],
      { env: { ...process.env, ...secrets } },
    );
    await docker(['cp', `${resolve(repoRoot, 'infra/postgres/init')}/.`, `${name}:/docker-entrypoint-initdb.d/`]);
    await docker(['start', name]);

    // pg_isready over TCP: during initialisation the entrypoint runs a temporary server that only
    // listens on the Unix socket, so TCP readiness means the init scripts have finished.
    const deadline = Date.now() + READY_TIMEOUT_MS;
    for (;;) {
      const state = await docker(['inspect', '--format', '{{.State.Running}}', name]);
      if (state !== 'true') throw new Error('PostgreSQL container exited during startup');
      const probe = await run('docker', ['exec', name, 'pg_isready', '-h', '127.0.0.1', '-U', 'postgres', '-q'], {
        capture: true,
      });
      if (probe.code === 0) break;
      if (Date.now() > deadline) throw new Error(`PostgreSQL not ready after ${READY_TIMEOUT_MS / 1000}s`);
      await sleep(1000);
    }

    const mapping = await docker(['port', name, '5432/tcp']);
    const port = Number(/:(\d+)\s*$/m.exec(mapping.split('\n')[0] ?? '')?.[1]);
    if (!Number.isInteger(port)) throw new Error(`Could not determine the published port from "${mapping}"`);

    while (!(await tcpReachable(host, port))) {
      if (Date.now() > deadline) throw new Error(`PostgreSQL is not reachable at ${host}:${port} from this machine`);
      await sleep(1000);
    }
    log(`[ephemeral-postgres] ready at ${host}:${port}`);

    return {
      host,
      port,
      productDb: { name: 'products_db', user: 'product_svc', password: secrets.PRODUCT_DB_PASSWORD },
      orderDb: { name: 'orders_db', user: 'order_svc', password: secrets.ORDER_DB_PASSWORD },
      stop,
    };
  } catch (err) {
    const logs = await run('docker', ['logs', '--tail', '40', name], { capture: true });
    if (logs.code === 0) {
      console.error('[ephemeral-postgres] last container log lines (secrets redacted):');
      console.error(redact(`${logs.stdout}${logs.stderr}`, Object.values(secrets)));
    }
    await stop().catch(() => undefined);
    throw err;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const command = process.argv[2];
  if (command !== 'cleanup') {
    console.error('Usage: CI_RUN_ID=<id> node scripts/ci/ephemeral-postgres.mjs cleanup');
    process.exit(2);
  }
  if (!process.env.CI_RUN_ID) {
    console.error('Refusing to clean up without CI_RUN_ID: only containers of one specific run are ever removed.');
    process.exit(2);
  }
  const runId = resolveRunId();
  const removed = await cleanupRun(runId);
  console.log(`[ephemeral-postgres] cleanup for run ${runId}: removed ${removed} container(s)`);
}
