import express, { type Express } from 'express';
import { errorHandler, notFoundHandler, requestLogger } from './http.js';
import type { Logger } from './logger.js';
import { captureRoutePrefix, type Metrics } from './metrics.js';
import type { ProductRepository } from './repository.js';
import { createProductRouter } from './routes.js';

export const SERVICE_NAME = 'product-service';

export interface AppDependencies {
  repository: ProductRepository;
  /** Resolves when the database is reachable; rejects otherwise. */
  checkReadiness: () => Promise<void>;
  logger: Logger;
  metrics: Metrics;
}

export function createApp({ repository, checkReadiness, logger, metrics }: AppDependencies): Express {
  const app = express();
  app.disable('x-powered-by');

  app.use(metrics.httpMiddleware);
  app.use(requestLogger(logger));
  app.use(express.json({ limit: '16kb' }));

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', service: SERVICE_NAME, uptimeSeconds: Math.round(process.uptime()) });
  });

  app.get('/ready', async (_req, res) => {
    try {
      await checkReadiness();
      res.json({ status: 'ready', service: SERVICE_NAME, checks: { database: 'ok' } });
    } catch (err) {
      logger.warn({ reason: err instanceof Error ? err.message : String(err) }, 'readiness check failed');
      res.status(503).json({ status: 'not_ready', service: SERVICE_NAME, checks: { database: 'unavailable' } });
    }
  });

  app.get('/metrics', async (_req, res) => {
    res.set('Content-Type', metrics.registry.contentType);
    res.send(await metrics.registry.metrics());
  });

  app.use('/products', captureRoutePrefix, createProductRouter(repository));

  app.use(notFoundHandler);
  app.use(errorHandler(logger));
  return app;
}
