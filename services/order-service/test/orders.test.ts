import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../src/config.js';
import { ProductServiceTimeoutError, ProductServiceUnavailableError } from '../src/product-client.js';
import { buildTestApp } from './helpers.js';

describe('POST /orders', () => {
  it('creates an order after validating the product', async () => {
    const { app, productClient } = buildTestApp();
    const res = await request(app).post('/orders').set('X-Request-Id', 'req-42').send({ productId: 1, quantity: 3 });
    expect(res.status).toBe(201);
    expect(res.headers.location).toBe('/orders/1');
    expect(res.body.data).toMatchObject({
      id: 1,
      productId: 1,
      productSku: 'KB-001',
      quantity: 3,
      unitPriceCents: 8999,
      totalCents: 26997,
      status: 'CREATED',
    });
    expect(productClient.calls).toEqual([{ id: 1, requestId: 'req-42' }]);
  });

  it('returns 422 when the product does not exist and stores nothing', async () => {
    const { app, repository } = buildTestApp();
    const res = await request(app).post('/orders').send({ productId: 999, quantity: 1 });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('PRODUCT_NOT_FOUND');
    expect(repository.orders).toHaveLength(0);
  });

  it.each([
    [{ productId: 1, quantity: 0 }, 'quantity'],
    [{ productId: 1, quantity: -2 }, 'quantity'],
    [{ productId: 1, quantity: 1.5 }, 'quantity'],
    [{ productId: 1, quantity: 1001 }, 'quantity'],
    [{ productId: 1, quantity: '2' }, 'quantity'],
    [{ productId: 0, quantity: 1 }, 'productId'],
    [{ productId: 'abc', quantity: 1 }, 'productId'],
    [{ quantity: 1 }, 'productId'],
  ])('rejects invalid input %j', async (body, field) => {
    const { app, productClient } = buildTestApp();
    const res = await request(app).post('/orders').send(body);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect((res.body.error.details as { field: string }[]).map((d) => d.field)).toContain(field);
    expect(productClient.calls).toHaveLength(0);
  });

  it('returns 504 when product-service times out', async () => {
    const { app, productClient, repository } = buildTestApp();
    productClient.error = new ProductServiceTimeoutError(2000);
    const res = await request(app).post('/orders').send({ productId: 1, quantity: 1 });
    expect(res.status).toBe(504);
    expect(res.body.error.code).toBe('PRODUCT_SERVICE_TIMEOUT');
    expect(repository.orders).toHaveLength(0);
  });

  it('returns 503 when product-service is unavailable', async () => {
    const { app, productClient } = buildTestApp();
    productClient.error = new ProductServiceUnavailableError('connect ECONNREFUSED 10.0.0.5:7001');
    const res = await request(app).post('/orders').send({ productId: 1, quantity: 1 });
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('PRODUCT_SERVICE_UNAVAILABLE');
    expect(JSON.stringify(res.body)).not.toContain('ECONNREFUSED');
  });

  it('returns a generic 500 on database errors', async () => {
    const { app, repository } = buildTestApp();
    repository.failWith = new Error('relation "orders" does not exist');
    const res = await request(app).post('/orders').send({ productId: 1, quantity: 1 });
    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe('INTERNAL_ERROR');
    expect(JSON.stringify(res.body)).not.toContain('relation');
  });

  it('counts created orders and lookup failures in metrics', async () => {
    const { app } = buildTestApp();
    await request(app).post('/orders').send({ productId: 1, quantity: 1 });
    await request(app).post('/orders').send({ productId: 404, quantity: 1 });
    const metrics = await request(app).get('/metrics');
    expect(metrics.text).toMatch(/orders_created_total\{service="order-service-test"\} 1/);
    expect(metrics.text).toContain('order_product_lookup_failures_total{reason="not_found"');
  });

  it('labels successful and failed requests with the same route pattern', async () => {
    const { app } = buildTestApp();
    await request(app).post('/orders').send({ productId: 1, quantity: 1 });
    await request(app).post('/orders').send({ productId: 404, quantity: 1 });
    const metrics = await request(app).get('/metrics');
    expect(metrics.text).toContain('method="POST",route="/orders",status_code="201"');
    expect(metrics.text).toContain('method="POST",route="/orders",status_code="422"');
    expect(metrics.text).not.toContain('route="/"');
  });
});

describe('GET /orders', () => {
  it('lists orders newest first', async () => {
    const { app } = buildTestApp();
    await request(app).post('/orders').send({ productId: 1, quantity: 1 });
    await request(app).post('/orders').send({ productId: 1, quantity: 2 });
    const res = await request(app).get('/orders');
    expect(res.status).toBe(200);
    expect((res.body.data as { id: number }[]).map((o) => o.id)).toEqual([2, 1]);
    expect(res.body.pagination).toEqual({ limit: 50, offset: 0, count: 2 });
  });

  it('gets a single order and returns 404/400 appropriately', async () => {
    const { app } = buildTestApp();
    await request(app).post('/orders').send({ productId: 1, quantity: 1 });
    expect((await request(app).get('/orders/1')).status).toBe(200);
    expect((await request(app).get('/orders/2')).body.error.code).toBe('ORDER_NOT_FOUND');
    expect((await request(app).get('/orders/x')).body.error.code).toBe('INVALID_ID');
  });
});

describe('operational endpoints', () => {
  it('reports health and readiness', async () => {
    const { app } = buildTestApp();
    expect((await request(app).get('/health')).body).toMatchObject({ status: 'ok', service: 'order-service' });
    expect((await request(app).get('/ready')).status).toBe(200);
  });

  it('reports not ready when the database is down', async () => {
    const { app } = buildTestApp({ ready: false });
    const res = await request(app).get('/ready');
    expect(res.status).toBe(503);
    expect(res.body.checks).toEqual({ database: 'unavailable' });
  });
});

describe('loadConfig', () => {
  const env = {
    DB_HOST: 'localhost',
    DB_NAME: 'orders_db',
    DB_USER: 'order_svc',
    DB_PASSWORD: 'pw',
    PRODUCT_SERVICE_URL: 'http://product-service:7001/',
  };

  it('normalises the product-service URL', () => {
    expect(loadConfig(env).PRODUCT_SERVICE_URL).toBe('http://product-service:7001');
  });

  it('rejects a missing or invalid product-service URL', () => {
    expect(() => loadConfig({ ...env, PRODUCT_SERVICE_URL: 'ftp://x' })).toThrow(ConfigError);
    expect(() => loadConfig({ ...env, PRODUCT_SERVICE_URL: undefined })).toThrow(/PRODUCT_SERVICE_URL/);
  });
});
