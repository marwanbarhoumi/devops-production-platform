import type pg from 'pg';

export interface Product {
  id: number;
  sku: string;
  name: string;
  description: string | null;
  priceCents: number;
  createdAt: string;
}

export interface NewProduct {
  sku: string;
  name: string;
  description?: string | undefined;
  priceCents: number;
}

export interface Pagination {
  limit: number;
  offset: number;
}

export interface ProductRepository {
  list(page: Pagination): Promise<Product[]>;
  findById(id: number): Promise<Product | null>;
  create(input: NewProduct): Promise<Product>;
}

export class DuplicateSkuError extends Error {
  constructor(sku: string) {
    super(`A product with SKU ${sku} already exists`);
    this.name = 'DuplicateSkuError';
  }
}

interface ProductRow {
  id: number;
  sku: string;
  name: string;
  description: string | null;
  price_cents: number;
  created_at: Date;
}

const COLUMNS = 'id, sku, name, description, price_cents, created_at';
const UNIQUE_VIOLATION = '23505';

function toProduct(row: ProductRow): Product {
  return {
    id: row.id,
    sku: row.sku,
    name: row.name,
    description: row.description,
    priceCents: row.price_cents,
    createdAt: row.created_at.toISOString(),
  };
}

export class PgProductRepository implements ProductRepository {
  constructor(private readonly pool: pg.Pool) {}

  async list({ limit, offset }: Pagination): Promise<Product[]> {
    const { rows } = await this.pool.query<ProductRow>(
      `SELECT ${COLUMNS} FROM products ORDER BY id LIMIT $1 OFFSET $2`,
      [limit, offset],
    );
    return rows.map(toProduct);
  }

  async findById(id: number): Promise<Product | null> {
    const { rows } = await this.pool.query<ProductRow>(`SELECT ${COLUMNS} FROM products WHERE id = $1`, [id]);
    return rows[0] ? toProduct(rows[0]) : null;
  }

  async create(input: NewProduct): Promise<Product> {
    try {
      const { rows } = await this.pool.query<ProductRow>(
        `INSERT INTO products (sku, name, description, price_cents) VALUES ($1, $2, $3, $4) RETURNING ${COLUMNS}`,
        [input.sku, input.name, input.description ?? null, input.priceCents],
      );
      return toProduct(rows[0] as ProductRow);
    } catch (err) {
      if ((err as { code?: string }).code === UNIQUE_VIOLATION) throw new DuplicateSkuError(input.sku);
      throw err;
    }
  }
}
