import { createApp } from '../src/app.js';
import { createLogger } from '../src/logger.js';
import { createMetrics } from '../src/metrics.js';
import type { ProductClient, ProductLookup, ProductSummary } from '../src/product-client.js';
import type { NewOrder, Order, OrderRepository, Pagination } from '../src/repository.js';

export class InMemoryOrderRepository implements OrderRepository {
  orders: Order[] = [];
  failWith: Error | null = null;

  list({ limit, offset }: Pagination): Promise<Order[]> {
    if (this.failWith) return Promise.reject(this.failWith);
    return Promise.resolve([...this.orders].reverse().slice(offset, offset + limit));
  }

  findById(id: number): Promise<Order | null> {
    if (this.failWith) return Promise.reject(this.failWith);
    return Promise.resolve(this.orders.find((o) => o.id === id) ?? null);
  }

  create(input: NewOrder): Promise<Order> {
    if (this.failWith) return Promise.reject(this.failWith);
    const order: Order = {
      id: this.orders.length + 1,
      ...input,
      totalCents: input.quantity * input.unitPriceCents,
      status: 'CREATED',
      createdAt: new Date('2026-01-01T00:00:00.000Z').toISOString(),
    };
    this.orders.push(order);
    return Promise.resolve(order);
  }
}

/** Fake product-service client: returns known products or throws a configured error. */
export class FakeProductClient implements ProductClient {
  error: Error | null = null;
  calls: { id: number; requestId: string | undefined }[] = [];

  constructor(private readonly products: ProductSummary[]) {}

  getProduct(id: number, requestId?: string): Promise<ProductLookup> {
    this.calls.push({ id, requestId });
    if (this.error) return Promise.reject(this.error);
    const product = this.products.find((p) => p.id === id);
    return Promise.resolve(product ? { found: true, product } : { found: false });
  }
}

export function buildTestApp(options: { ready?: boolean } = {}) {
  const repository = new InMemoryOrderRepository();
  const productClient = new FakeProductClient([{ id: 1, sku: 'KB-001', name: 'Keyboard', priceCents: 8999 }]);
  const app = createApp({
    repository,
    productClient,
    checkReadiness: () => (options.ready === false ? Promise.reject(new Error('timeout')) : Promise.resolve()),
    logger: createLogger('order-service-test', 'silent'),
    metrics: createMetrics('order-service-test', { collectDefaultMetrics: false }),
  });
  return { app, repository, productClient };
}
