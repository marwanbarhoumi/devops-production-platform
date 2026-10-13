#!/usr/bin/env node
// Runs all three services locally with hot reload (tsx watch), using PostgreSQL from Docker Compose.
//
//   docker compose up -d postgres --wait
//   npm run dev
//
// Stop any Compose-managed application containers first so ports 7000-7002 are free:
//   docker compose stop api-gateway order-service product-service
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const envFile = new URL('../.env', import.meta.url);

if (!existsSync(envFile)) {
  console.error('Missing .env file. Create it from .env.example first (see README).');
  process.exit(1);
}
process.loadEnvFile(envFile);

const shared = {
  NODE_ENV: 'development',
  LOG_LEVEL: process.env.LOG_LEVEL ?? 'info',
  DB_HOST: '127.0.0.1',
  DB_PORT: process.env.POSTGRES_HOST_PORT ?? '15432',
};

const services = [
  {
    name: 'product-service',
    env: { PORT: '7001', DB_NAME: 'products_db', DB_USER: 'product_svc', DB_PASSWORD: process.env.PRODUCT_DB_PASSWORD },
  },
  {
    name: 'order-service',
    env: {
      PORT: '7002',
      DB_NAME: 'orders_db',
      DB_USER: 'order_svc',
      DB_PASSWORD: process.env.ORDER_DB_PASSWORD,
      PRODUCT_SERVICE_URL: 'http://127.0.0.1:7001',
    },
  },
  {
    name: 'api-gateway',
    env: { PORT: '7000', PRODUCT_SERVICE_URL: 'http://127.0.0.1:7001', ORDER_SERVICE_URL: 'http://127.0.0.1:7002' },
  },
];

const children = services.map(({ name, env }) => {
  const child = spawn('npm', ['run', 'dev', '--workspace', `services/${name}`], {
    cwd: root,
    stdio: 'inherit',
    shell: process.platform === 'win32',
    env: { ...process.env, ...shared, ...env },
  });
  child.on('exit', (code) => {
    if (code !== 0 && code !== null) console.error(`[dev] ${name} exited with code ${code}`);
  });
  return child;
});

const stop = () => {
  for (const child of children) child.kill('SIGTERM');
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
