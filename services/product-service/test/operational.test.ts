import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../src/config.js';
import { buildTestApp } from './helpers.js';

describe('operational endpoints', () => {
  it('GET /health reports liveness', async () => {
    const { app } = buildTestApp();
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'ok', service: 'product-service' });
  });

  it('GET /ready returns 200 when the database is reachable', async () => {
    const { app } = buildTestApp();
    const res = await request(app).get('/ready');
    expect(res.status).toBe(200);
    expect(res.body.checks).toEqual({ database: 'ok' });
  });

  it('GET /ready returns 503 without leaking error details', async () => {
    const { app } = buildTestApp({ ready: false });
    const res = await request(app).get('/ready');
    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ status: 'not_ready', checks: { database: 'unavailable' } });
    expect(JSON.stringify(res.body)).not.toContain('ECONNREFUSED');
  });

  it('GET /metrics exposes HTTP metrics labelled by route pattern', async () => {
    const { app } = buildTestApp();
    await request(app).get('/products/1');
    await request(app).get('/products/2');
    await request(app).get('/does-not-exist');
    const res = await request(app).get('/metrics');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/plain');
    expect(res.text).toContain('http_requests_total{method="GET",route="/products/:id",status_code="200"');
    expect(res.text).toContain('route="unmatched",status_code="404"');
    expect(res.text).toContain('http_request_duration_seconds_bucket');
    expect(res.text).not.toContain('route="/products/1"');
  });

  it('keeps the full route label when a request fails inside the router', async () => {
    const { app } = buildTestApp();
    await request(app).get('/products/999999');
    await request(app).get('/products/abc');
    await request(app).post('/products').send({ sku: '' });
    await request(app).get('/products');
    const res = await request(app).get('/metrics');
    expect(res.text).toContain('route="/products/:id",status_code="404"');
    expect(res.text).toContain('route="/products/:id",status_code="400"');
    expect(res.text).toContain('method="POST",route="/products",status_code="400"');
    expect(res.text).toContain('method="GET",route="/products",status_code="200"');
    expect(res.text).not.toContain('route="/:id"');
    expect(res.text).not.toContain('route="/products/"');
  });

  it('propagates a valid X-Request-Id and generates one otherwise', async () => {
    const { app } = buildTestApp();
    const withId = await request(app).get('/health').set('X-Request-Id', 'abc-123');
    expect(withId.headers['x-request-id']).toBe('abc-123');
    const invalid = await request(app).get('/health').set('X-Request-Id', 'bad id with spaces');
    expect(invalid.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('returns JSON 404 for unknown routes', async () => {
    const { app } = buildTestApp();
    const res = await request(app).get('/nope');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });
});

describe('loadConfig', () => {
  const baseEnv = { DB_HOST: 'localhost', DB_NAME: 'products_db', DB_USER: 'product_svc', DB_PASSWORD: 's3cret' };

  it('applies defaults', () => {
    const config = loadConfig(baseEnv);
    expect(config.PORT).toBe(7001);
    expect(config.DB_PORT).toBe(5432);
  });

  it('reports missing variables without exposing values', () => {
    try {
      loadConfig({ ...baseEnv, DB_HOST: undefined, PORT: 'not-a-port' });
      expect.unreachable('loadConfig should throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      const issues = (err as ConfigError).issues.join(' ');
      expect(issues).toContain('DB_HOST');
      expect(issues).toContain('PORT');
      expect(issues).not.toContain('s3cret');
    }
  });
});
