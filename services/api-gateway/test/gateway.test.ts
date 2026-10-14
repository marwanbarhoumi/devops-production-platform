import { once } from 'node:events';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { ConfigError, loadConfig } from '../src/config.js';
import { createLogger } from '../src/logger.js';
import { createMetrics } from '../src/metrics.js';

interface Recorded {
  method: string;
  url: string;
  body: string;
  headers: IncomingMessage['headers'];
}

type Handler = (req: IncomingMessage, res: ServerResponse, recorded: Recorded) => void;

const servers: Server[] = [];

/** Starts a real HTTP server acting as a downstream service and records what it receives. */
async function startUpstream(handler: Handler): Promise<{ url: string; requests: Recorded[] }> {
  const requests: Recorded[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const recorded = {
        method: req.method ?? '',
        url: req.url ?? '',
        body: Buffer.concat(chunks).toString(),
        headers: req.headers,
      };
      requests.push(recorded);
      handler(req, res, recorded);
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  servers.push(server);
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, requests };
}

const json = (res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) =>
  res.writeHead(status, { 'content-type': 'application/json', ...headers }).end(JSON.stringify(body));

const echo: Handler = (_req, res, recorded) => json(res, 200, { data: { path: recorded.url } });

/** An address nothing listens on: bind a server, then close it. */
async function deadUrl(): Promise<string> {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;
  await new Promise((resolve) => server.close(resolve));
  return `http://127.0.0.1:${port}`;
}

function buildGateway(productServiceUrl: string, orderServiceUrl: string, upstreamTimeoutMs = 1000) {
  return createApp({
    productServiceUrl,
    orderServiceUrl,
    upstreamTimeoutMs,
    readinessTimeoutMs: 500,
    logger: createLogger('api-gateway-test', 'silent'),
    metrics: createMetrics('api-gateway-test', { collectDefaultMetrics: false }),
  });
}

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((server) => {
      server.closeAllConnections();
      return new Promise((resolve) => server.close(resolve));
    }),
  );
});

describe('routing', () => {
  it('routes /api/products to product-service, preserving path and query', async () => {
    const products = await startUpstream(echo);
    const orders = await startUpstream(echo);
    const app = buildGateway(products.url, orders.url);

    const list = await request(app).get('/api/products?limit=2');
    expect(list.status).toBe(200);
    expect(list.body.data.path).toBe('/products?limit=2');

    const one = await request(app).get('/api/products/5');
    expect(one.body.data.path).toBe('/products/5');
    expect(orders.requests).toHaveLength(0);
  });

  it('routes /api/orders to order-service and forwards body, content type and request id', async () => {
    const products = await startUpstream(echo);
    const orders = await startUpstream((_req, res) =>
      json(res, 201, { data: { id: 9 } }, { location: '/orders/9' }),
    );
    const app = buildGateway(products.url, orders.url);

    const res = await request(app)
      .post('/api/orders')
      .set('X-Request-Id', 'trace-1')
      .send({ productId: 1, quantity: 2 });

    expect(res.status).toBe(201);
    expect(res.body).toEqual({ data: { id: 9 } });
    expect(res.headers.location).toBe('/api/orders/9');
    expect(res.headers['x-request-id']).toBe('trace-1');
    const [forwarded] = orders.requests;
    expect(forwarded?.method).toBe('POST');
    expect(forwarded?.url).toBe('/orders');
    expect(JSON.parse(forwarded?.body ?? '')).toEqual({ productId: 1, quantity: 2 });
    expect(forwarded?.headers['content-type']).toContain('application/json');
    expect(forwarded?.headers['x-request-id']).toBe('trace-1');
    expect(products.requests).toHaveLength(0);
  });

  it('passes downstream error statuses and bodies through unchanged', async () => {
    const products = await startUpstream((_req, res) =>
      json(res, 404, { error: { code: 'PRODUCT_NOT_FOUND', message: 'Product 99 not found' } }),
    );
    const app = buildGateway(products.url, await deadUrl());
    const res = await request(app).get('/api/products/99');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('PRODUCT_NOT_FOUND');
  });

  it('does not forward sensitive client headers', async () => {
    const products = await startUpstream(echo);
    const app = buildGateway(products.url, await deadUrl());
    await request(app).get('/api/products').set('Cookie', 'session=abc').set('Authorization', 'Bearer x');
    expect(products.requests[0]?.headers.cookie).toBeUndefined();
    expect(products.requests[0]?.headers.authorization).toBeUndefined();
  });

  it('blocks path traversal out of the upstream prefix', async () => {
    const products = await startUpstream(echo);
    const app = buildGateway(products.url, await deadUrl());
    const res = await request(app).get('/api/products/%2e%2e/metrics');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_PATH');
    expect(products.requests).toHaveLength(0);
  });

  it('returns 404 for unknown routes and does not match prefix look-alikes', async () => {
    const app = buildGateway(await deadUrl(), await deadUrl());
    expect((await request(app).get('/api/unknown')).status).toBe(404);
    expect((await request(app).get('/api/productsfoo')).status).toBe(404);
  });
});

describe('downstream failure handling', () => {
  it('returns 503 when the downstream service is unreachable', async () => {
    const app = buildGateway(await deadUrl(), await deadUrl());
    const res = await request(app).get('/api/products');
    expect(res.status).toBe(503);
    expect(res.body.error).toMatchObject({ code: 'UPSTREAM_UNAVAILABLE', message: 'product-service is unavailable' });
  });

  it('returns 504 when the downstream service exceeds the timeout', async () => {
    const orders = await startUpstream((_req, res) => {
      setTimeout(() => json(res, 200, { data: [] }), 1000).unref();
    });
    const app = buildGateway(await deadUrl(), orders.url, 100);
    const res = await request(app).get('/api/orders');
    expect(res.status).toBe(504);
    expect(res.body.error.code).toBe('UPSTREAM_TIMEOUT');
  });

  it('returns 502 when the downstream response is not valid JSON', async () => {
    const products = await startUpstream((_req, res) =>
      res.writeHead(200, { 'content-type': 'text/html' }).end('<html>oops</html>'),
    );
    const app = buildGateway(products.url, await deadUrl());
    const res = await request(app).get('/api/products');
    expect(res.status).toBe(502);
    expect(res.body.error.code).toBe('BAD_GATEWAY');
  });

  it('returns 502 when the downstream responds with a redirect', async () => {
    const products = await startUpstream((_req, res) => res.writeHead(302, { location: 'http://evil.test' }).end());
    const app = buildGateway(products.url, await deadUrl());
    const res = await request(app).get('/api/products');
    expect(res.status).toBe(502);
    expect(res.headers.location).toBeUndefined();
  });

  it('records upstream outcomes and bounded route labels in metrics', async () => {
    const products = await startUpstream(echo);
    const app = buildGateway(products.url, await deadUrl());
    await request(app).get('/api/products/1');
    await request(app).get('/api/products/2');
    await request(app).get('/api/orders');
    const res = await request(app).get('/metrics');
    expect(res.text).toContain('gateway_upstream_requests_total{upstream="product-service",outcome="success"');
    expect(res.text).toContain('gateway_upstream_requests_total{upstream="order-service",outcome="unavailable"');
    expect(res.text).toContain('route="/api/products",status_code="200"');
    expect(res.text).not.toContain('route="/api/products/1"');
  });
});

describe('health and readiness', () => {
  it('GET /health always reports ok', async () => {
    const app = buildGateway(await deadUrl(), await deadUrl());
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'ok', service: 'api-gateway' });
  });

  it('GET /ready is 200 when all upstreams are healthy', async () => {
    const healthy: Handler = (_req, res) => json(res, 200, { status: 'ok' });
    const app = buildGateway((await startUpstream(healthy)).url, (await startUpstream(healthy)).url);
    const res = await request(app).get('/ready');
    expect(res.status).toBe(200);
    expect(res.body.checks).toEqual({ 'product-service': 'ok', 'order-service': 'ok' });
  });

  it('GET /ready is 503 and identifies the failing upstream', async () => {
    const healthy: Handler = (_req, res) => json(res, 200, { status: 'ok' });
    const app = buildGateway((await startUpstream(healthy)).url, await deadUrl());
    const res = await request(app).get('/ready');
    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({
      status: 'not_ready',
      checks: { 'product-service': 'ok', 'order-service': 'unavailable' },
    });
  });
});

describe('loadConfig', () => {
  const env = { PRODUCT_SERVICE_URL: 'http://product-service:7001/', ORDER_SERVICE_URL: 'https://orders.example//' };

  it('removes trailing slashes from upstream URLs', () => {
    const config = loadConfig(env);
    expect(config.PRODUCT_SERVICE_URL).toBe('http://product-service:7001');
    expect(config.ORDER_SERVICE_URL).toBe('https://orders.example');
  });

  it('rejects non-HTTP upstream URLs', () => {
    expect(() => loadConfig({ ...env, ORDER_SERVICE_URL: 'ftp://orders' })).toThrow(ConfigError);
  });
});
