import type { RequestHandler } from 'express';
import client from 'prom-client';
import { requestIdOf } from './http.js';
import type { Logger } from './logger.js';

export interface Upstream {
  /** Logical name used in logs, metrics and error messages, e.g. "product-service". */
  name: string;
  /** Base URL of the upstream service, without a trailing slash. */
  baseUrl: string;
  /** Public path prefix on the gateway, e.g. "/api/products". */
  publicPrefix: string;
  /** Path prefix on the upstream service, e.g. "/products". */
  upstreamPrefix: string;
}

type Outcome = 'success' | 'timeout' | 'unavailable' | 'invalid_response' | 'rejected';

export interface UpstreamMetrics {
  requests: client.Counter<'upstream' | 'outcome'>;
  duration: client.Histogram<'upstream' | 'outcome'>;
}

export function createUpstreamMetrics(registry: client.Registry): UpstreamMetrics {
  return {
    requests: new client.Counter({
      name: 'gateway_upstream_requests_total',
      help: 'Requests proxied to upstream services, by upstream and outcome',
      labelNames: ['upstream', 'outcome'] as const,
      registers: [registry],
    }),
    duration: new client.Histogram({
      name: 'gateway_upstream_request_duration_seconds',
      help: 'Latency of upstream calls made by the gateway',
      labelNames: ['upstream', 'outcome'] as const,
      buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
      registers: [registry],
    }),
  };
}

const FORWARDED_REQUEST_HEADERS = ['accept', 'content-type', 'accept-language'] as const;
const FORWARDED_RESPONSE_HEADERS = ['cache-control', 'retry-after'] as const;

interface ProxyOptions {
  upstream: Upstream;
  timeoutMs: number;
  logger: Logger;
  metrics: UpstreamMetrics;
  fetchImpl?: typeof fetch;
}

function errorBody(code: string, message: string, requestId: string | undefined) {
  return { error: { code, message, requestId } };
}

/**
 * Minimal reverse proxy built on fetch so that timeouts, error mapping and response validation
 * are explicit. Upstream responses must be JSON (or empty); anything else is reported as 502.
 */
export function createProxy({ upstream, timeoutMs, logger, metrics, fetchImpl = fetch }: ProxyOptions): RequestHandler {
  return async (req, res) => {
    res.locals.routeLabel = upstream.publicPrefix;
    const requestId = requestIdOf(res);
    const stopTimer = metrics.duration.startTimer({ upstream: upstream.name });
    const record = (outcome: Outcome): void => {
      metrics.requests.inc({ upstream: upstream.name, outcome });
      stopTimer({ outcome });
    };

    // req.url is relative to the mount point. Resolve it and make sure the result cannot escape
    // the upstream prefix (e.g. "/api/products/../metrics").
    const suffix = req.url === '/' || req.url.startsWith('/?') ? req.url.slice(1) : req.url;
    const target = new URL(`${upstream.baseUrl}${upstream.upstreamPrefix}${suffix}`);
    const inScope =
      target.pathname === upstream.upstreamPrefix || target.pathname.startsWith(`${upstream.upstreamPrefix}/`);
    if (!inScope) {
      record('rejected');
      res.status(400).json(errorBody('INVALID_PATH', 'Request path is not allowed', requestId));
      return;
    }

    const headers: Record<string, string> = {};
    for (const name of FORWARDED_REQUEST_HEADERS) {
      const value = req.headers[name];
      if (typeof value === 'string') headers[name] = value;
    }
    if (requestId) headers['x-request-id'] = requestId;
    headers['x-forwarded-for'] = req.socket.remoteAddress ?? 'unknown';

    const hasBody = !['GET', 'HEAD'].includes(req.method) && Buffer.isBuffer(req.body) && req.body.length > 0;
    const signal = AbortSignal.timeout(timeoutMs);

    let status: number;
    let text: string;
    let upstreamHeaders: Headers;
    try {
      const response = await fetchImpl(target, {
        method: req.method,
        headers,
        body: hasBody ? (req.body as Buffer) : undefined,
        signal,
        redirect: 'manual',
      });
      status = response.status;
      upstreamHeaders = response.headers;
      text = await response.text();
    } catch (err) {
      if (signal.aborted) {
        record('timeout');
        logger.warn({ upstream: upstream.name, timeoutMs, requestId }, 'upstream request timed out');
        res.status(504).json(errorBody('UPSTREAM_TIMEOUT', `${upstream.name} did not respond in time`, requestId));
        return;
      }
      record('unavailable');
      logger.warn(
        { upstream: upstream.name, requestId, reason: err instanceof Error ? err.message : String(err) },
        'upstream request failed',
      );
      res.status(503).json(errorBody('UPSTREAM_UNAVAILABLE', `${upstream.name} is unavailable`, requestId));
      return;
    }

    let body: unknown = undefined;
    if (text.length > 0) {
      try {
        body = JSON.parse(text);
      } catch {
        body = undefined;
      }
    }
    const validStatus = status >= 200 && status <= 599 && !(status >= 300 && status < 400);
    if (!validStatus || (text.length > 0 && body === undefined)) {
      record('invalid_response');
      logger.error({ upstream: upstream.name, status, requestId }, 'upstream returned an invalid response');
      res.status(502).json(errorBody('BAD_GATEWAY', `${upstream.name} returned an invalid response`, requestId));
      return;
    }

    record('success');
    for (const name of FORWARDED_RESPONSE_HEADERS) {
      const value = upstreamHeaders.get(name);
      if (value) res.setHeader(name, value);
    }
    const location = upstreamHeaders.get('location');
    if (location?.startsWith(upstream.upstreamPrefix)) {
      res.setHeader('location', `${upstream.publicPrefix}${location.slice(upstream.upstreamPrefix.length)}`);
    }
    if (body === undefined) {
      res.status(status).end();
    } else {
      res.status(status).json(body);
    }
  };
}
