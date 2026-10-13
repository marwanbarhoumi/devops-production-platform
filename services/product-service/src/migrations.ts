import type { Migration } from './db.js';

/** Arbitrary constant used for pg_advisory_lock; must differ between services sharing a server. */
export const MIGRATION_LOCK_ID = 70_010_001;

export const migrations: readonly Migration[] = [
  {
    id: 1,
    name: '001_create_products',
    sql: `
      CREATE TABLE IF NOT EXISTS products (
        id SERIAL PRIMARY KEY,
        sku VARCHAR(32) NOT NULL UNIQUE,
        name VARCHAR(120) NOT NULL,
        description TEXT,
        price_cents INTEGER NOT NULL CHECK (price_cents > 0),
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `,
  },
  {
    id: 2,
    name: '002_seed_products',
    sql: `
      INSERT INTO products (sku, name, description, price_cents) VALUES
        ('KB-001', 'Mechanical Keyboard', 'Tenkeyless keyboard with hot-swappable switches', 8999),
        ('MS-001', 'Wireless Mouse', 'Ergonomic 2.4 GHz wireless mouse', 2999),
        ('MN-027', '27-inch Monitor', '27-inch 1440p IPS monitor', 27999),
        ('HS-001', 'USB Headset', 'Noise-cancelling USB headset with microphone', 5999),
        ('DK-001', 'USB-C Dock', 'USB-C docking station with dual display output', 14999)
      ON CONFLICT (sku) DO NOTHING;
    `,
  },
];
