import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { createPool, runMigrations } from '../src/db.js';
import { createLogger } from '../src/logger.js';
import { MIGRATION_LOCK_ID, migrations } from '../src/migrations.js';
import { DuplicateSkuError, PgProductRepository } from '../src/repository.js';

/** Runs against a real PostgreSQL instance. Use `npm run test:integration` from the repository root. */
describe('PgProductRepository (integration)', () => {
  const logger = createLogger('product-service-int', 'silent');
  let pool: pg.Pool;
  let repository: PgProductRepository;
  const createdSkus: string[] = [];

  beforeAll(async () => {
    const config = loadConfig();
    pool = createPool(
      {
        host: config.DB_HOST,
        port: config.DB_PORT,
        database: config.DB_NAME,
        user: config.DB_USER,
        password: config.DB_PASSWORD,
        maxConnections: 2,
        statementTimeoutMs: 5000,
        applicationName: 'product-service-int-test',
      },
      logger,
    );
    await runMigrations(pool, migrations, logger, MIGRATION_LOCK_ID);
    repository = new PgProductRepository(pool);
  });

  afterAll(async () => {
    if (createdSkus.length > 0) await pool.query('DELETE FROM products WHERE sku = ANY($1)', [createdSkus]);
    await pool.end();
  });

  it('migrations are idempotent', async () => {
    await expect(runMigrations(pool, migrations, logger, MIGRATION_LOCK_ID)).resolves.toBe(0);
  });

  it('contains the seed data', async () => {
    const products = await repository.list({ limit: 100, offset: 0 });
    expect(products.map((p) => p.sku)).toEqual(expect.arrayContaining(['KB-001', 'MS-001']));
  });

  it('persists and retrieves a product', async () => {
    const sku = `IT-${randomUUID().slice(0, 8).toUpperCase()}`;
    createdSkus.push(sku);
    const created = await repository.create({ sku, name: 'Integration Item', priceCents: 1234 });
    expect(created.id).toBeGreaterThan(0);
    const found = await repository.findById(created.id);
    expect(found).toEqual(created);
  });

  it('raises DuplicateSkuError on unique violation', async () => {
    await expect(repository.create({ sku: 'KB-001', name: 'Duplicate', priceCents: 1 })).rejects.toBeInstanceOf(
      DuplicateSkuError,
    );
  });

  it('returns null for missing products', async () => {
    await expect(repository.findById(2_000_000_000)).resolves.toBeNull();
  });
});
