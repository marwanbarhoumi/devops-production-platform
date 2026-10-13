import { createApp, SERVICE_NAME } from './app.js';
import { ConfigError, loadConfig, type Config } from './config.js';
import { checkDatabase, createPool, runMigrations, withRetry } from './db.js';
import { createLogger } from './logger.js';
import { createMetrics } from './metrics.js';
import { MIGRATION_LOCK_ID, migrations } from './migrations.js';
import { HttpProductClient } from './product-client.js';
import { PgOrderRepository } from './repository.js';

function readConfig(): Config {
  try {
    return loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      createLogger(SERVICE_NAME).fatal({ issues: err.issues }, 'invalid configuration, exiting');
      process.exit(1);
    }
    throw err;
  }
}

async function main(): Promise<void> {
  const config = readConfig();
  const logger = createLogger(SERVICE_NAME, config.LOG_LEVEL);

  const pool = createPool(
    {
      host: config.DB_HOST,
      port: config.DB_PORT,
      database: config.DB_NAME,
      user: config.DB_USER,
      password: config.DB_PASSWORD,
      maxConnections: config.DB_POOL_MAX,
      statementTimeoutMs: config.DB_STATEMENT_TIMEOUT_MS,
      applicationName: SERVICE_NAME,
    },
    logger,
  );

  await withRetry(() => runMigrations(pool, migrations, logger, MIGRATION_LOCK_ID), {
    attempts: 10,
    delayMs: 2000,
    logger,
    description: 'database migration',
  });

  const app = createApp({
    repository: new PgOrderRepository(pool),
    productClient: new HttpProductClient(config.PRODUCT_SERVICE_URL, config.PRODUCT_SERVICE_TIMEOUT_MS),
    checkReadiness: () => checkDatabase(pool),
    logger,
    metrics: createMetrics(SERVICE_NAME),
  });

  const server = app.listen(config.PORT, () => {
    logger.info({ port: config.PORT, productServiceUrl: config.PRODUCT_SERVICE_URL }, `${SERVICE_NAME} listening`);
  });
  server.on('error', (err) => {
    logger.fatal({ err }, 'HTTP server error');
    process.exit(1);
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'shutting down');
    setTimeout(() => {
      logger.error('graceful shutdown timed out, forcing exit');
      process.exit(1);
    }, 10_000).unref();
    server.close(() => {
      pool
        .end()
        .then(() => process.exit(0))
        .catch(() => process.exit(1));
    });
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err: unknown) => {
  createLogger(SERVICE_NAME).fatal({ err }, 'failed to start');
  process.exit(1);
});
