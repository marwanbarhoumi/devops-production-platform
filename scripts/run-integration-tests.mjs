#!/usr/bin/env node
// Runs the database integration tests of product-service and order-service against the
// PostgreSQL container started by Docker Compose (published on 127.0.0.1:POSTGRES_HOST_PORT).
//
//   docker compose up -d postgres --wait
//   npm run test:integration
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const envFile = new URL('../.env', import.meta.url);

if (!existsSync(envFile)) {
  console.error('Missing .env file. Create it from .env.example first (see README).');
  process.exit(1);
}
process.loadEnvFile(envFile);

const dbPort = process.env.POSTGRES_HOST_PORT ?? '15432';
const suites = [
  {
    workspace: 'services/product-service',
    env: { DB_NAME: 'products_db', DB_USER: 'product_svc', DB_PASSWORD: process.env.PRODUCT_DB_PASSWORD },
  },
  {
    workspace: 'services/order-service',
    env: {
      DB_NAME: 'orders_db',
      DB_USER: 'order_svc',
      DB_PASSWORD: process.env.ORDER_DB_PASSWORD,
      PRODUCT_SERVICE_URL: 'http://127.0.0.1:7001',
    },
  },
];

let failed = false;
for (const suite of suites) {
  console.log(`\n=== Integration tests: ${suite.workspace} ===`);
  const result = spawnSync('npm', ['run', 'test:integration', '--workspace', suite.workspace], {
    cwd: root,
    stdio: 'inherit',
    shell: process.platform === 'win32',
    env: { ...process.env, LOG_LEVEL: 'silent', DB_HOST: '127.0.0.1', DB_PORT: dbPort, ...suite.env },
  });
  if (result.status !== 0) failed = true;
}

process.exit(failed ? 1 : 0);
