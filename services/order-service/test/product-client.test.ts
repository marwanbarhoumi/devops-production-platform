import { once } from 'node:events';
import { createServer, type RequestListener, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import {
  HttpProductClient,
  ProductServiceTimeoutError,
  ProductServiceUnavailableError,
} from '../src/product-client.js';

let server: Server | undefined;

async function startStub(handler: RequestListener): Promise<string> {
  server = createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

afterEach(async () => {
  if (server) {
    server.closeAllConnections();
    await new Promise((resolve) => server?.close(resolve));
    server = undefined;
  }
});

const product = { id: 7, sku: 'KB-001', name: 'Keyboard', priceCents: 8999 };

describe('HttpProductClient', () => {
  it('returns the product and forwards the request id', async () => {
    let seenPath = '';
    let seenRequestId: string | string[] | undefined;
    const url = await startStub((req, res) => {
      seenPath = req.url ?? '';
      seenRequestId = req.headers['x-request-id'];
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ data: product }));
    });
    const result = await new HttpProductClient(url, 1000).getProduct(7, 'req-1');
    expect(result).toEqual({ found: true, product });
    expect(seenPath).toBe('/products/7');
    expect(seenRequestId).toBe('req-1');
  });

  it('maps 404 to not found', async () => {
    const url = await startStub((_req, res) => res.writeHead(404).end('{"error":{}}'));
    await expect(new HttpProductClient(url, 1000).getProduct(7)).resolves.toEqual({ found: false });
  });

  it('throws a timeout error when product-service is slow', async () => {
    const url = await startStub((_req, res) => {
      setTimeout(() => res.end(JSON.stringify({ data: product })), 1000).unref();
    });
    await expect(new HttpProductClient(url, 100).getProduct(7)).rejects.toBeInstanceOf(ProductServiceTimeoutError);
  });

  it.each<[string, RequestListener]>([
    ['a 5xx status', (_req, res) => res.writeHead(500).end('{}')],
    ['invalid JSON', (_req, res) => res.writeHead(200).end('<html>')],
    ['an unexpected shape', (_req, res) => res.writeHead(200).end('{"data":{"id":7}}')],
    ['a mismatched id', (_req, res) => res.writeHead(200).end(JSON.stringify({ data: { ...product, id: 8 } }))],
  ])('treats %s as unavailable', async (_name, handler) => {
    const url = await startStub(handler);
    await expect(new HttpProductClient(url, 1000).getProduct(7)).rejects.toBeInstanceOf(
      ProductServiceUnavailableError,
    );
  });

  it('treats connection failures as unavailable', async () => {
    const url = await startStub((_req, res) => res.end());
    server?.close();
    server = undefined;
    await expect(new HttpProductClient(url, 1000).getProduct(7)).rejects.toBeInstanceOf(
      ProductServiceUnavailableError,
    );
  });
});
