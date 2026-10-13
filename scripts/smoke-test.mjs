#!/usr/bin/env node
// End-to-end smoke test against a running platform (Docker Compose or `npm run dev`).
// Everything goes through the API gateway, exactly like a real client.
//
//   npm run test:smoke                                   # default http://127.0.0.1:7000
//   GATEWAY_URL=http://localhost:7000 npm run test:smoke
import { randomUUID } from 'node:crypto';

const gateway = (process.env.GATEWAY_URL ?? 'http://127.0.0.1:7000').replace(/\/+$/, '');
let failures = 0;

async function call(method, path, body) {
  const response = await fetch(`${gateway}${path}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(10_000),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null, text, headers: response.headers };
}

function check(name, condition, detail = '') {
  if (condition) {
    console.log(`  PASS  ${name}`);
  } else {
    failures += 1;
    console.log(`  FAIL  ${name}${detail ? ` -> ${detail}` : ''}`);
  }
}

async function main() {
  console.log(`Smoke testing ${gateway}\n`);

  const health = await call('GET', '/health');
  check('gateway /health returns 200', health.status === 200, health.text);

  const ready = await call('GET', '/ready');
  check('gateway /ready returns 200 (all upstreams reachable)', ready.status === 200, ready.text);

  const list = await call('GET', '/api/products?limit=5');
  check('list products returns 200', list.status === 200, list.text);
  check('seed products are present', Array.isArray(list.body?.data) && list.body.data.length > 0, list.text);

  const sku = `SMOKE-${randomUUID().slice(0, 8).toUpperCase()}`;
  const created = await call('POST', '/api/products', { sku, name: 'Smoke Test Item', priceCents: 1250 });
  check('create product returns 201', created.status === 201, created.text);
  const productId = created.body?.data?.id;
  check('Location header is rewritten to the public path', created.headers.get('location') === `/api/products/${productId}`);

  const fetched = await call('GET', `/api/products/${productId}`);
  check('created product can be fetched', fetched.status === 200 && fetched.body?.data?.sku === sku, fetched.text);

  const duplicate = await call('POST', '/api/products', { sku, name: 'Duplicate', priceCents: 1 });
  check('duplicate SKU returns 409', duplicate.status === 409, duplicate.text);

  const invalidProduct = await call('POST', '/api/products', { sku: '', name: '', priceCents: -1 });
  check('invalid product returns 400', invalidProduct.status === 400, invalidProduct.text);

  const order = await call('POST', '/api/orders', { productId, quantity: 4 });
  check('create order returns 201', order.status === 201, order.text);
  check('order total is quantity x unit price', order.body?.data?.totalCents === 5000, order.text);

  const orders = await call('GET', '/api/orders');
  check(
    'new order appears in order list',
    orders.status === 200 && orders.body?.data?.some((o) => o.id === order.body?.data?.id),
    orders.text,
  );

  const missing = await call('POST', '/api/orders', { productId: 2_000_000_000, quantity: 1 });
  check('order for unknown product returns 422', missing.status === 422, missing.text);

  const badQuantity = await call('POST', '/api/orders', { productId, quantity: 0 });
  check('order with invalid quantity returns 400', badQuantity.status === 400, badQuantity.text);

  const unknown = await call('GET', '/api/unknown');
  check('unknown route returns 404', unknown.status === 404, unknown.text);

  const metrics = await fetch(`${gateway}/metrics`).then((r) => r.text());
  check('gateway /metrics exposes http_requests_total', metrics.includes('http_requests_total'));
  check('gateway /metrics exposes upstream metrics', metrics.includes('gateway_upstream_requests_total'));

  console.log(`\n${failures === 0 ? 'All smoke checks passed.' : `${failures} smoke check(s) failed.`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(`Smoke test aborted: ${err.message}`);
  console.error('Is the platform running? Try: docker compose up -d --build --wait');
  process.exit(1);
});
