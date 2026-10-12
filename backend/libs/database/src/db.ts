import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Client, Pool, PoolClient, QueryResultRow, types } from 'pg';
import { config } from '@app/common';

// BIGINT (int8) and COUNT(*) come back from pg as strings by default. All our
// money values fit comfortably in Number.MAX_SAFE_INTEGER (9e15 paise), so
// parse them as numbers. NUMERIC (e.g. AVG) is parsed as float for analytics only.
types.setTypeParser(20, (v) => parseInt(v, 10));
types.setTypeParser(1700, (v) => parseFloat(v));

export interface Migration {
  id: string;
  sql: string;
}

export interface DbOptions {
  database: string;
  migrations: Migration[];
}

export const DB_OPTIONS = Symbol('DB_OPTIONS');

export type Queryable = Pool | PoolClient;

const MIGRATION_LOCK_KEY = 72_400_001;
const RETRYABLE_SQLSTATES = new Set(['40001', '40P01']); // serialization_failure, deadlock_detected

@Injectable()
export class Db implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('Db');
  readonly pool: Pool;

  constructor(@Inject(DB_OPTIONS) private readonly opts: DbOptions) {
    this.pool = new Pool({
      host: config.db.host,
      port: config.db.port,
      user: config.db.user,
      password: config.db.password,
      database: opts.database,
      max: config.db.poolMax,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: config.db.connectTimeoutMs,
      application_name: `payforge-${opts.database}`,
    });
    this.pool.on('error', (err) => this.logger.error(`Idle client error: ${err.message}`));
  }

  async onModuleInit(): Promise<void> {
    await this.ensureDatabaseExists();
    await this.migrate();
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool.end().catch(() => undefined);
  }

  async query<T extends QueryResultRow = QueryResultRow>(sql: string, params: unknown[] = [], client: Queryable = this.pool) {
    return client.query<T>(sql, params);
  }

  async one<T extends QueryResultRow = QueryResultRow>(sql: string, params: unknown[] = [], client: Queryable = this.pool): Promise<T | null> {
    const { rows } = await client.query<T>(sql, params);
    return rows[0] ?? null;
  }

  async many<T extends QueryResultRow = QueryResultRow>(sql: string, params: unknown[] = [], client: Queryable = this.pool): Promise<T[]> {
    const { rows } = await client.query<T>(sql, params);
    return rows;
  }

  /**
   * Runs `fn` inside a transaction. Serialization failures and deadlocks are
   * retried with a small jittered backoff, which is the documented way to use
   * SERIALIZABLE isolation correctly.
   */
  async tx<T>(fn: (client: PoolClient) => Promise<T>, isolation: 'read committed' | 'repeatable read' | 'serializable' = 'read committed'): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      const client = await this.pool.connect();
      try {
        await client.query(`BEGIN ISOLATION LEVEL ${isolation.toUpperCase()}`);
        const result = await fn(client);
        await client.query('COMMIT');
        return result;
      } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined);
        const code = (err as { code?: string }).code;
        if (code && RETRYABLE_SQLSTATES.has(code) && attempt < 4) {
          await new Promise((r) => setTimeout(r, 10 * attempt + Math.random() * 20));
          continue;
        }
        throw err;
      } finally {
        client.release();
      }
    }
  }

  /** Database-per-service: each service creates (if needed) and owns its own database. */
  private async ensureDatabaseExists(): Promise<void> {
    let admin: Client;
    for (let attempt = 1; ; attempt++) {
      // A pg Client cannot be reused after a failed connect, so build a fresh one per attempt.
      admin = new Client({
        host: config.db.host,
        port: config.db.port,
        user: config.db.user,
        password: config.db.password,
        database: 'postgres',
      });
      try {
        await admin.connect();
        break;
      } catch (err) {
        await admin.end().catch(() => undefined);
        if (attempt >= 30) throw err;
        this.logger.warn(`Postgres not reachable yet (${(err as Error).message}); retrying...`);
        await new Promise((r) => setTimeout(r, 1_000));
      }
    }
    try {
      const exists = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [this.opts.database]);
      if (!exists.rowCount) {
        await admin.query(`CREATE DATABASE "${this.opts.database.replace(/"/g, '')}"`).catch((err: { code?: string }) => {
          if (err.code !== '42P04') throw err; // duplicate_database: another instance won the race
        });
        this.logger.log(`Created database ${this.opts.database}`);
      }
    } finally {
      await admin.end();
    }
  }

  /** Forward-only SQL migrations, applied once each, serialised across instances with an advisory lock. */
  private async migrate(): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);
      await client.query(
        'CREATE TABLE IF NOT EXISTS schema_migrations (id text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())',
      );
      const { rows } = await client.query<{ id: string }>('SELECT id FROM schema_migrations');
      const applied = new Set(rows.map((r) => r.id));
      for (const migration of this.opts.migrations) {
        if (applied.has(migration.id)) continue;
        await client.query('BEGIN');
        try {
          await client.query(migration.sql);
          await client.query('INSERT INTO schema_migrations (id) VALUES ($1)', [migration.id]);
          await client.query('COMMIT');
          this.logger.log(`Applied migration ${migration.id}`);
        } catch (err) {
          await client.query('ROLLBACK');
          throw new Error(`Migration ${migration.id} failed: ${(err as Error).message}`);
        }
      }
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY]).catch(() => undefined);
      client.release();
    }
  }
}
