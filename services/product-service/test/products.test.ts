import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { buildTestApp, InMemoryProductRepository } from './helpers.js';

describe('GET /products', () => {
  it('lists products with pagination metadata', async () => {
    const { app } = buildTestApp();
    const res = await request(app).get('/products');
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(2);
    expect(res.body.data[0]).toMatchObject({ id: 1, sku: 'KB-001', name: 'Keyboard', priceCents: 8999 });
    expect(res.body.pagination).toEqual({ limit: 50, offset: 0, count: 2 });
  });

  it('honours limit and offset', async () => {
    const { app } = buildTestApp();
    const res = await request(app).get('/products?limit=1&offset=1');
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].sku).toBe('MS-001');
  });

  it('rejects an out-of-range limit', async () => {
    const { app } = buildTestApp();
    const res = await request(app).get('/products?limit=1000');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });
});

describe('GET /products/:id', () => {
  it('returns a product by id', async () => {
    const { app } = buildTestApp();
    const res = await request(app).get('/products/2');
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ id: 2, sku: 'MS-001', description: null });
  });

  it('returns 404 for an unknown product', async () => {
    const { app } = buildTestApp();
    const res = await request(app).get('/products/999');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('PRODUCT_NOT_FOUND');
  });

  it.each(['abc', '0', '-1', '1.5', '99999999999'])('returns 400 for invalid id %s', async (id) => {
    const { app } = buildTestApp();
    const res = await request(app).get(`/products/${id}`);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_ID');
  });
});

describe('POST /products', () => {
  const valid = { sku: 'ab-123', name: '  Laptop Stand ', description: 'Aluminium', priceCents: 3999 };

  it('creates a product and normalises input', async () => {
    const { app } = buildTestApp();
    const res = await request(app).post('/products').send(valid);
    expect(res.status).toBe(201);
    expect(res.headers.location).toBe('/products/3');
    expect(res.body.data).toMatchObject({ id: 3, sku: 'AB-123', name: 'Laptop Stand', priceCents: 3999 });
  });

  it('returns field-level validation errors', async () => {
    const { app } = buildTestApp();
    const res = await request(app).post('/products').send({ sku: 'x', name: '', priceCents: -5 });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    const fields = (res.body.error.details as { field: string }[]).map((d) => d.field);
    expect(fields).toEqual(expect.arrayContaining(['sku', 'name', 'priceCents']));
  });

  it('rejects non-integer prices and unknown fields', async () => {
    const { app } = buildTestApp();
    const res = await request(app).post('/products').send({ ...valid, priceCents: 10.5, admin: true });
    expect(res.status).toBe(400);
    const fields = (res.body.error.details as { field: string }[]).map((d) => d.field);
    expect(fields).toContain('priceCents');
  });

  it('rejects malformed JSON', async () => {
    const { app } = buildTestApp();
    const res = await request(app).post('/products').set('Content-Type', 'application/json').send('{"sku":');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_JSON');
  });

  it('returns 409 for a duplicate SKU', async () => {
    const { app } = buildTestApp();
    const res = await request(app).post('/products').send({ ...valid, sku: 'kb-001' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('SKU_ALREADY_EXISTS');
  });

  it('hides internal error details from clients', async () => {
    const repository = new InMemoryProductRepository();
    repository.failWith = new Error('password authentication failed for user "product_svc"');
    const { app } = buildTestApp({ repository });
    const res = await request(app).post('/products').send(valid);
    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe('INTERNAL_ERROR');
    expect(JSON.stringify(res.body)).not.toContain('password');
  });
});
