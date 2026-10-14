#!/usr/bin/env node
// Runs the database integration tests of product-service and order-service.
//
// Default: against the PostgreSQL container of the local Docker Compose stack
// (published on 127.0.0.1:POSTGRES_HOST_PORT, credentials from .env):
//   docker compose up -d postgres --wait
//   npm run test:integration
//
// --ephemeral-db (CI): starts a disposable PostgreSQL container for this run only, runs the tests,
// writes JUnit reports to reports/junit/integration/<service>.xml and always removes the container.
// Does not need .env and never touches the Compose stack or its volume:
//   npm run test:integration:ci
import { existsSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { startEphemeralPostgres } from './ci/ephemeral-postgres.mjs';
import { repoRoot, run, verifyJUnitReports } from './ci/lib.mjs';

const ephemeral = process.argv.includes('--ephemeral-db');

async function composeDatabase() {
  const envFile = resolve(repoRoot, '.env');
  if (!existsSync(envFile)) {
    console.error('Missing .env file. Create it from .env.example first (see README).');
    process.exit(1);
  }
  process.loadEnvFile(envFile);
  return {
    host: '127.0.0.1',
    port: Number(process.env.POSTGRES_HOST_PORT ?? '15432'),
    productDb: { name: 'products_db', user: 'product_svc', password: process.env.PRODUCT_DB_PASSWORD },
    orderDb: { name: 'orders_db', user: 'order_svc', password: process.env.ORDER_DB_PASSWORD },
    stop: async () => undefined,
  };
}

let db;
let exiting = false;
async function shutdown(code) {
  if (exiting) return;
  exiting = true;
  try {
    await db?.stop();
  } catch (err) {
    console.error(`ERROR: cleanup failed: ${err instanceof Error ? err.message : String(err)}`);
    code = code === 0 ? 1 : code;
  }
  process.exit(code);
}
// Jenkins sends SIGTERM when a build is aborted; make sure the database is still removed.
process.on('SIGINT', () => void shutdown(130));
process.on('SIGTERM', () => void shutdown(143));

const reportsDir = ephemeral || process.env.JUNIT_REPORTS_DIR
  ? resolve(repoRoot, process.env.JUNIT_REPORTS_DIR ?? 'reports/junit')
  : undefined;

try {
  db = ephemeral ? await startEphemeralPostgres() : await composeDatabase();
} catch (err) {
  console.error(`ERROR: could not start the integration-test database: ${err instanceof Error ? err.message : String(err)}`);
  await shutdown(1);
}

const suites = [
  {
    service: 'product-service',
    workspace: 'services/product-service',
    env: { DB_NAME: db.productDb.name, DB_USER: db.productDb.user, DB_PASSWORD: db.productDb.password },
  },
  {
    service: 'order-service',
    workspace: 'services/order-service',
    env: {
      DB_NAME: db.orderDb.name,
      DB_USER: db.orderDb.user,
      DB_PASSWORD: db.orderDb.password,
      PRODUCT_SERVICE_URL: 'http://127.0.0.1:7001',
    },
  },
];

if (reportsDir) rmSync(resolve(reportsDir, 'integration'), { recursive: true, force: true });

const failed = [];
for (const suite of suites) {
  if (exiting) break;
  console.log(`\n=== Integration tests: ${suite.service} ===`);
  const { code } = await run('npm', ['run', 'test:integration', '--workspace', suite.workspace], {
    env: {
      ...process.env,
      ...(reportsDir ? { JUNIT_REPORTS_DIR: reportsDir } : {}),
      LOG_LEVEL: 'silent',
      DB_HOST: db.host,
      DB_PORT: String(db.port),
      ...suite.env,
    },
  });
  if (code !== 0) failed.push(suite.service);
}

let reportProblems = [];
if (reportsDir) {
  reportProblems = verifyJUnitReports(suites.map((s) => resolve(reportsDir, 'integration', `${s.service}.xml`)));
  for (const problem of reportProblems) console.error(`ERROR: ${problem}`);
}
if (failed.length > 0) console.error(`ERROR: integration tests failed in: ${failed.join(', ')}`);

await shutdown(failed.length > 0 || reportProblems.length > 0 ? 1 : 0);
