import { createApp } from '../src/app.js';
import { createLogger } from '../src/logger.js';
import { createMetrics } from '../src/metrics.js';
import {
  DuplicateSkuError,
  type NewProduct,
  type Pagination,
  type Product,
  type ProductRepository,
} from '../src/repository.js';

export class InMemoryProductRepository implements ProductRepository {
  private products: Product[] = [];
  private nextId = 1;
  failWith: Error | null = null;

  constructor(seed: NewProduct[] = []) {
    for (const item of seed) this.insert(item);
  }

  private insert(input: NewProduct): Product {
    const product: Product = {
      id: this.nextId++,
      sku: input.sku,
      name: input.name,
      description: input.description ?? null,
      priceCents: input.priceCents,
      createdAt: new Date('2026-01-01T00:00:00.000Z').toISOString(),
    };
    this.products.push(product);
    return product;
  }

  list({ limit, offset }: Pagination): Promise<Product[]> {
    if (this.failWith) return Promise.reject(this.failWith);
    return Promise.resolve(this.products.slice(offset, offset + limit));
  }

  findById(id: number): Promise<Product | null> {
    if (this.failWith) return Promise.reject(this.failWith);
    return Promise.resolve(this.products.find((p) => p.id === id) ?? null);
  }

  create(input: NewProduct): Promise<Product> {
    if (this.failWith) return Promise.reject(this.failWith);
    if (this.products.some((p) => p.sku === input.sku)) return Promise.reject(new DuplicateSkuError(input.sku));
    return Promise.resolve(this.insert(input));
  }
}

export function buildTestApp(options: { repository?: ProductRepository; ready?: boolean } = {}) {
  const repository =
    options.repository ??
    new InMemoryProductRepository([
      { sku: 'KB-001', name: 'Keyboard', description: 'Mechanical', priceCents: 8999 },
      { sku: 'MS-001', name: 'Mouse', priceCents: 2999 },
    ]);
  const app = createApp({
    repository,
    checkReadiness: () =>
      options.ready === false ? Promise.reject(new Error('connect ECONNREFUSED')) : Promise.resolve(),
    logger: createLogger('product-service-test', 'silent'),
    metrics: createMetrics('product-service-test', { collectDefaultMetrics: false }),
  });
  return { app, repository };
}
