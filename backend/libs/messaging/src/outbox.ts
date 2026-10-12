import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { context, propagation, ROOT_CONTEXT } from '@opentelemetry/api';
import type { Message } from 'kafkajs';
import { counter, gauge } from '@app/common';
import { Db, Migration, Queryable } from '@app/database';
import { DomainEvent } from './events';
import { KafkaService } from './kafka.service';

export const OUTBOX_MIGRATION: Migration = {
  id: '000_outbox',
  sql: `
    CREATE TABLE IF NOT EXISTS outbox_events (
      id           bigserial   PRIMARY KEY,
      event_id     text        NOT NULL UNIQUE,
      event_type   text        NOT NULL,
      topic        text        NOT NULL,
      message_key  text        NOT NULL,
      payload      jsonb       NOT NULL,
      created_at   timestamptz NOT NULL DEFAULT now(),
      published_at timestamptz
    );
    CREATE INDEX IF NOT EXISTS outbox_unpublished_idx ON outbox_events (id) WHERE published_at IS NULL;
    CREATE INDEX IF NOT EXISTS outbox_key_idx ON outbox_events (message_key, id);
  `,
};

/** Lets an event carry the trace of the request that produced it (see enqueueEvent / OutboxRelay). */
export const OUTBOX_TRACE_MIGRATION: Migration = {
  id: '000_outbox_trace_context',
  sql: `ALTER TABLE outbox_events ADD COLUMN IF NOT EXISTS trace_context jsonb;`,
};

export const PROCESSED_EVENTS_MIGRATION: Migration = {
  id: '000_processed_events',
  sql: `
    CREATE TABLE IF NOT EXISTS processed_events (
      consumer     text        NOT NULL,
      event_id     text        NOT NULL,
      processed_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (consumer, event_id)
    );
  `,
};

/**
 * Transactional outbox, write side: call this INSIDE the same DB transaction that
 * changes business state. Either both commit or neither does, so we can never
 * "update the payment but lose the event" (the dual-write problem).
 */
export async function enqueueEvent(client: Queryable, topic: string, key: string, event: DomainEvent): Promise<void> {
  // Capture the current trace (W3C traceparent) so consumers' work joins the request's trace.
  // With tracing disabled the propagator is a no-op and nothing is stored.
  const trace: Record<string, string> = {};
  propagation.inject(context.active(), trace);
  await client.query(
    `INSERT INTO outbox_events (event_id, event_type, topic, message_key, payload, trace_context)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb)`,
    [event.id, event.type, topic, key, JSON.stringify(event), Object.keys(trace).length ? JSON.stringify(trace) : null],
  );
}

/**
 * Idempotent-consumer guard. Call inside the transaction that applies the
 * event's side effects; returns false if this consumer already processed the event.
 */
export async function markProcessed(client: Queryable, consumer: string, eventId: string): Promise<boolean> {
  const res = await client.query(
    `INSERT INTO processed_events (consumer, event_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
    [consumer, eventId],
  );
  return res.rowCount === 1;
}

const POLL_MS = parseInt(process.env.OUTBOX_POLL_MS ?? '100', 10);
const MAX_BACKOFF_MS = 5_000;
const BATCH_SIZE = 200;
const RELAY_LOCK_KEY = 72_400_002;

const outboxPublished = counter('payforge_outbox_published_total', 'Events relayed from the outbox to Kafka');
const outboxLag = gauge('payforge_outbox_pending', 'Events written to the outbox but not yet published');

/**
 * Transactional outbox, read side: polls unpublished rows in id order and publishes
 * them to Kafka. A transaction-scoped advisory lock means only one relay instance is
 * active at a time, which preserves ordering. Delivery is at-least-once (a crash
 * between publish and commit republishes), which is why every consumer is idempotent.
 */
@Injectable()
export class OutboxRelay implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('OutboxRelay');
  private timer?: NodeJS.Timeout;
  private lagTimer?: NodeJS.Timeout;
  private backoffMs = POLL_MS;
  private stopped = false;
  private lastWarnAt = 0;

  constructor(
    private readonly db: Db,
    private readonly kafka: KafkaService,
  ) {}

  onModuleInit(): void {
    this.schedule(POLL_MS);
    this.lagTimer = setInterval(() => void this.updateLag(), 5_000);
  }

  onModuleDestroy(): void {
    this.stopped = true;
    clearTimeout(this.timer);
    clearInterval(this.lagTimer);
  }

  private schedule(ms: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => void this.tick(), ms);
  }

  private async tick(): Promise<void> {
    let published = 0;
    try {
      published = await this.publishBatch();
      this.backoffMs = POLL_MS;
    } catch (err) {
      this.backoffMs = Math.min(this.backoffMs * 2, MAX_BACKOFF_MS);
      if (Date.now() - this.lastWarnAt > 10_000) {
        this.lastWarnAt = Date.now();
        this.logger.warn(`Outbox relay paused: ${(err as Error).message}. Events are safely buffered in Postgres.`);
      }
    }
    this.schedule(published === BATCH_SIZE ? 0 : this.backoffMs);
  }

  async publishBatch(): Promise<number> {
    if (!this.kafka.isReady()) throw new Error('Kafka producer not connected');
    return this.db.tx(async (client) => {
      const lock = await client.query<{ locked: boolean }>('SELECT pg_try_advisory_xact_lock($1) AS locked', [RELAY_LOCK_KEY]);
      if (!lock.rows[0].locked) return 0;

      const { rows } = await client.query<{ id: number; topic: string; message_key: string; payload: DomainEvent; trace_context: Record<string, string> | null }>(
        `SELECT id, topic, message_key, payload, trace_context FROM outbox_events WHERE published_at IS NULL ORDER BY id LIMIT $1`,
        [BATCH_SIZE],
      );
      if (!rows.length) return 0;

      const toMessage = (row: (typeof rows)[number]): Message => ({
        key: row.message_key,
        value: JSON.stringify(row.payload),
        headers: { 'event-id': row.payload.id, 'event-type': row.payload.type, ...(row.trace_context ?? {}) },
      });

      if (rows.some((r) => r.trace_context)) {
        // Tracing on: publish each event inside the context of the request that produced it,
        // so the Kafka producer/consumer spans continue that trace (in order, one at a time).
        for (const row of rows) {
          const parent = row.trace_context ? propagation.extract(ROOT_CONTEXT, row.trace_context) : ROOT_CONTEXT;
          await context.with(parent, () => this.kafka.publish(row.topic, [toMessage(row)]));
        }
      } else {
        const byTopic = new Map<string, Message[]>();
        for (const row of rows) byTopic.set(row.topic, [...(byTopic.get(row.topic) ?? []), toMessage(row)]);
        for (const [topic, messages] of byTopic) await this.kafka.publish(topic, messages);
      }
      await client.query('UPDATE outbox_events SET published_at = now() WHERE id = ANY($1::bigint[])', [rows.map((r) => r.id)]);
      outboxPublished.inc(rows.length);
      return rows.length;
    });
  }

  private async updateLag(): Promise<void> {
    try {
      const row = await this.db.one<{ n: number }>('SELECT count(*) AS n FROM outbox_events WHERE published_at IS NULL');
      outboxLag.set(row?.n ?? 0);
    } catch {
      /* best effort */
    }
  }
}
