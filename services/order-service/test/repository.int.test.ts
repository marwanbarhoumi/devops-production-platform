import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { createPool, runMigrations } from '../src/db.js';
import { createLogger } from '../src/logger.js';
import { MIGRATION_LOCK_ID, migrations } from '../src/migrations.js';
import { PgOrderRepository } from '../src/repository.js';

/** Runs against a real PostgreSQL instance. Use `npm run test:integration` from the repository root. */
describe('PgOrderRepository (integration)', () => {
  const logger = createLogger('order-service-int', 'silent');
  let pool: pg.Pool;
  let repository: PgOrderRepository;
  const createdIds: number[] = [];

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
        applicationName: 'order-service-int-test',
      },
      logger,
    );
    await runMigrations(pool, migrations, logger, MIGRATION_LOCK_ID);
    repository = new PgOrderRepository(pool);
  });

  afterAll(async () => {
    if (createdIds.length > 0) await pool.query('DELETE FROM orders WHERE id = ANY($1)', [createdIds]);
    await pool.end();
  });

  it('migrations are idempotent', async () => {
    await expect(runMigrations(pool, migrations, logger, MIGRATION_LOCK_ID)).resolves.toBe(0);
  });

  it('persists an order and computes the total in the database', async () => {
    const order = await repository.create({
      productId: 1,
      productSku: 'KB-001',
      productName: 'Mechanical Keyboard',
      quantity: 1000,
      unitPriceCents: 10_000_000,
    });
    createdIds.push(order.id);
    // 1000 * 10,000,000 exceeds INT32, proving BIGINT handling end to end.
    expect(order.totalCents).toBe(10_000_000_000);
    expect(await repository.findById(order.id)).toEqual(order);
    const listed = await repository.list({ limit: 100, offset: 0 });
    expect(listed.some((o) => o.id === order.id)).toBe(true);
  });

  it('enforces quantity constraints at the database level', async () => {
    await expect(
      repository.create({ productId: 1, productSku: 'KB-001', productName: 'x', quantity: 0, unitPriceCents: 1 }),
    ).rejects.toThrow(/check constraint/);
  });
});
