import client from 'prom-client';
import type { Request, RequestHandler, Response } from 'express';

const KNOWN_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);

export interface Metrics {
  registry: client.Registry;
  httpMiddleware: RequestHandler;
}

export interface MetricsOptions {
  /** Collect Node.js process metrics (CPU, memory, event loop lag, GC). */
  collectDefaultMetrics?: boolean;
}

/**
 * Labels are restricted to the HTTP method, the matched route *pattern* (never the raw URL)
 * and the status code, which keeps time-series cardinality bounded.
 */
export function routeLabel(req: Request, res: Response): string {
  const explicit: unknown = res.locals.routeLabel;
  if (typeof explicit === 'string') return explicit;
  const routePath: unknown = (req.route as { path?: unknown } | undefined)?.path;
  if (typeof routePath !== 'string') return 'unmatched';
  const prefix: unknown = res.locals.routePrefix;
  const label = `${typeof prefix === 'string' ? prefix : req.baseUrl}${routePath}`;
  return label.length > 1 && label.endsWith('/') ? label.slice(0, -1) : label || '/';
}

/**
 * Mount in front of a router: `app.use('/products', captureRoutePrefix, router)`.
 * Express restores `req.baseUrl` when an error leaves the router, so by the time the response
 * finishes the prefix would be lost and failed requests would get a different route label.
 */
export const captureRoutePrefix: RequestHandler = (req, res, next) => {
  res.locals.routePrefix = req.baseUrl;
  next();
};

export function createMetrics(service: string, options: MetricsOptions = {}): Metrics {
  const registry = new client.Registry();
  registry.setDefaultLabels({ service });

  if (options.collectDefaultMetrics ?? true) {
    client.collectDefaultMetrics({ register: registry });
  }

  const labelNames = ['method', 'route', 'status_code'] as const;

  const requestsTotal = new client.Counter({
    name: 'http_requests_total',
    help: 'Total number of HTTP requests handled',
    labelNames,
    registers: [registry],
  });

  const requestDuration = new client.Histogram({
    name: 'http_request_duration_seconds',
    help: 'HTTP request duration in seconds',
    labelNames,
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
    registers: [registry],
  });

  const httpMiddleware: RequestHandler = (req, res, next) => {
    const stopTimer = requestDuration.startTimer();
    res.on('finish', () => {
      const labels = {
        method: KNOWN_METHODS.has(req.method) ? req.method : 'OTHER',
        route: routeLabel(req, res),
        status_code: String(res.statusCode),
      };
      requestsTotal.inc(labels);
      stopTimer(labels);
    });
    next();
  };

  return { registry, httpMiddleware };
}
