import express, { type Express } from 'express';
import { errorHandler, notFoundHandler, requestLogger } from './http.js';
import type { Logger } from './logger.js';
import type { Metrics } from './metrics.js';
import { createProxy, createUpstreamMetrics, type Upstream } from './proxy.js';

export const SERVICE_NAME = 'api-gateway';

export interface AppDependencies {
  productServiceUrl: string;
  orderServiceUrl: string;
  upstreamTimeoutMs: number;
  readinessTimeoutMs: number;
  logger: Logger;
  metrics: Metrics;
  fetchImpl?: typeof fetch;
}

export function createApp(deps: AppDependencies): Express {
  const { logger, metrics, fetchImpl = fetch } = deps;
  const upstreams: Upstream[] = [
    { name: 'product-service', baseUrl: deps.productServiceUrl, publicPrefix: '/api/products', upstreamPrefix: '/products' },
    { name: 'order-service', baseUrl: deps.orderServiceUrl, publicPrefix: '/api/orders', upstreamPrefix: '/orders' },
  ];
  const upstreamMetrics = createUpstreamMetrics(metrics.registry);

  const app = express();
  app.disable('x-powered-by');

  app.use(metrics.httpMiddleware);
  app.use(requestLogger(logger));

  app.get('/', (_req, res) => {
    res.json({ service: SERVICE_NAME, routes: upstreams.map((u) => u.publicPrefix) });
  });

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', service: SERVICE_NAME, uptimeSeconds: Math.round(process.uptime()) });
  });

  // The gateway has no state of its own; it is ready when it can reach every upstream's liveness endpoint.
  app.get('/ready', async (_req, res) => {
    const results = await Promise.all(
      upstreams.map(async (upstream) => {
        try {
          const response = await fetchImpl(`${upstream.baseUrl}/health`, {
            signal: AbortSignal.timeout(deps.readinessTimeoutMs),
          });
          await response.body?.cancel();
          return [upstream.name, response.ok ? 'ok' : 'unavailable'] as const;
        } catch {
          return [upstream.name, 'unavailable'] as const;
        }
      }),
    );
    const checks = Object.fromEntries(results);
    const ready = results.every(([, state]) => state === 'ok');
    if (!ready) logger.warn({ checks }, 'readiness check failed');
    res.status(ready ? 200 : 503).json({ status: ready ? 'ready' : 'not_ready', service: SERVICE_NAME, checks });
  });

  app.get('/metrics', async (_req, res) => {
    res.set('Content-Type', metrics.registry.contentType);
    res.send(await metrics.registry.metrics());
  });

  const rawBody = express.raw({ type: () => true, limit: '64kb' });
  for (const upstream of upstreams) {
    app.use(
      upstream.publicPrefix,
      rawBody,
      createProxy({ upstream, timeoutMs: deps.upstreamTimeoutMs, logger, metrics: upstreamMetrics, fetchImpl }),
    );
  }

  app.use(notFoundHandler);
  app.use(errorHandler(logger));
  return app;
}
