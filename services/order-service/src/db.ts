import pg from 'pg';
import type { Logger } from './logger.js';

export interface DatabaseConfig {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  maxConnections: number;
  statementTimeoutMs: number;
  applicationName: string;
}

export function createPool(config: DatabaseConfig, logger: Logger): pg.Pool {
  const pool = new pg.Pool({
    host: config.host,
    port: config.port,
    database: config.database,
    user: config.user,
    password: config.password,
    max: config.maxConnections,
    application_name: config.applicationName,
    statement_timeout: config.statementTimeoutMs,
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 30_000,
  });
  // Errors on idle clients (e.g. database restart) must not crash the process.
  pool.on('error', (err) => logger.error({ err: { message: err.message } }, 'idle database client error'));
  return pool;
}

export async function checkDatabase(pool: pg.Pool): Promise<void> {
  await pool.query('SELECT 1');
}

export interface Migration {
  id: number;
  name: string;
  sql: string;
}

/**
 * Applies pending migrations in order, each inside its own transaction.
 * A session-level advisory lock serialises concurrent starts (e.g. several replicas).
 */
export async function runMigrations(
  pool: pg.Pool,
  migrations: readonly Migration[],
  logger: Logger,
  lockId: number,
): Promise<number> {
  const client = await pool.connect();
  let appliedCount = 0;
  try {
    await client.query('SELECT pg_advisory_lock($1)', [lockId]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    const { rows } = await client.query<{ id: number }>('SELECT id FROM schema_migrations');
    const applied = new Set(rows.map((row) => row.id));

    for (const migration of [...migrations].sort((a, b) => a.id - b.id)) {
      if (applied.has(migration.id)) continue;
      await client.query('BEGIN');
      try {
        await client.query(migration.sql);
        await client.query('INSERT INTO schema_migrations (id, name) VALUES ($1, $2)', [migration.id, migration.name]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      }
      appliedCount += 1;
      logger.info({ migration: migration.name }, 'applied database migration');
    }
    return appliedCount;
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [lockId]).catch(() => undefined);
    client.release();
  }
}

export async function withRetry<T>(
  operation: () => Promise<T>,
  options: { attempts: number; delayMs: number; logger: Logger; description: string },
): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await operation();
    } catch (err) {
      if (attempt >= options.attempts) throw err;
      const message = err instanceof Error ? err.message : String(err);
      options.logger.warn({ attempt, maxAttempts: options.attempts, reason: message }, `${options.description} failed, retrying`);
      await new Promise((resolve) => setTimeout(resolve, options.delayMs));
    }
  }
}
