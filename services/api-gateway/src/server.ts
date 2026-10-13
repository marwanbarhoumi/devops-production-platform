import { createApp, SERVICE_NAME } from './app.js';
import { ConfigError, loadConfig, type Config } from './config.js';
import { createLogger } from './logger.js';
import { createMetrics } from './metrics.js';

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

function main(): void {
  const config = readConfig();
  const logger = createLogger(SERVICE_NAME, config.LOG_LEVEL);

  const app = createApp({
    productServiceUrl: config.PRODUCT_SERVICE_URL,
    orderServiceUrl: config.ORDER_SERVICE_URL,
    upstreamTimeoutMs: config.UPSTREAM_TIMEOUT_MS,
    readinessTimeoutMs: config.READINESS_TIMEOUT_MS,
    logger,
    metrics: createMetrics(SERVICE_NAME),
  });

  const server = app.listen(config.PORT, () => {
    logger.info(
      { port: config.PORT, productServiceUrl: config.PRODUCT_SERVICE_URL, orderServiceUrl: config.ORDER_SERVICE_URL },
      `${SERVICE_NAME} listening`,
    );
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
    server.close(() => process.exit(0));
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main();
