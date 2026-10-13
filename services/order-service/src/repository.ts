import type pg from 'pg';

export type OrderStatus = 'CREATED';

export interface Order {
  id: number;
  productId: number;
  productSku: string;
  productName: string;
  quantity: number;
  unitPriceCents: number;
  totalCents: number;
  status: OrderStatus;
  createdAt: string;
}

export interface NewOrder {
  productId: number;
  productSku: string;
  productName: string;
  quantity: number;
  unitPriceCents: number;
}

export interface Pagination {
  limit: number;
  offset: number;
}

export interface OrderRepository {
  list(page: Pagination): Promise<Order[]>;
  findById(id: number): Promise<Order | null>;
  create(input: NewOrder): Promise<Order>;
}

interface OrderRow {
  id: number;
  product_id: number;
  product_sku: string;
  product_name: string;
  quantity: number;
  unit_price_cents: number;
  total_cents: string; // BIGINT is returned as a string by node-postgres
  status: OrderStatus;
  created_at: Date;
}

const COLUMNS =
  'id, product_id, product_sku, product_name, quantity, unit_price_cents, total_cents, status, created_at';

function toOrder(row: OrderRow): Order {
  return {
    id: row.id,
    productId: row.product_id,
    productSku: row.product_sku,
    productName: row.product_name,
    quantity: row.quantity,
    unitPriceCents: row.unit_price_cents,
    totalCents: Number(row.total_cents),
    status: row.status,
    createdAt: row.created_at.toISOString(),
  };
}

export class PgOrderRepository implements OrderRepository {
  constructor(private readonly pool: pg.Pool) {}

  async list({ limit, offset }: Pagination): Promise<Order[]> {
    const { rows } = await this.pool.query<OrderRow>(
      `SELECT ${COLUMNS} FROM orders ORDER BY id DESC LIMIT $1 OFFSET $2`,
      [limit, offset],
    );
    return rows.map(toOrder);
  }

  async findById(id: number): Promise<Order | null> {
    const { rows } = await this.pool.query<OrderRow>(`SELECT ${COLUMNS} FROM orders WHERE id = $1`, [id]);
    return rows[0] ? toOrder(rows[0]) : null;
  }

  async create(input: NewOrder): Promise<Order> {
    const { rows } = await this.pool.query<OrderRow>(
      `INSERT INTO orders (product_id, product_sku, product_name, quantity, unit_price_cents, total_cents)
       VALUES ($1, $2, $3, $4::integer, $5::integer, $4::integer::bigint * $5::integer::bigint)
       RETURNING ${COLUMNS}`,
      [input.productId, input.productSku, input.productName, input.quantity, input.unitPriceCents],
    );
    return toOrder(rows[0] as OrderRow);
  }
}
