import type { Migration } from './db.js';

/** Arbitrary constant used for pg_advisory_lock; must differ between services sharing a server. */
export const MIGRATION_LOCK_ID = 70_020_001;

/**
 * product_id is intentionally not a foreign key: products live in another service's database.
 * Product data needed for the order (SKU, name, price) is snapshotted at creation time.
 */
export const migrations: readonly Migration[] = [
  {
    id: 1,
    name: '001_create_orders',
    sql: `
      CREATE TABLE IF NOT EXISTS orders (
        id SERIAL PRIMARY KEY,
        product_id INTEGER NOT NULL CHECK (product_id > 0),
        product_sku VARCHAR(32) NOT NULL,
        product_name VARCHAR(120) NOT NULL,
        quantity INTEGER NOT NULL CHECK (quantity BETWEEN 1 AND 1000),
        unit_price_cents INTEGER NOT NULL CHECK (unit_price_cents > 0),
        total_cents BIGINT NOT NULL CHECK (total_cents > 0),
        status VARCHAR(20) NOT NULL DEFAULT 'CREATED',
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS idx_orders_product_id ON orders (product_id);
    `,
  },
];
