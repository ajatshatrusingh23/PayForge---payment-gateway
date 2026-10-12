import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { counter, histogram, IdPrefix, newId, SIGNATURE_HEADER, signWebhookPayload } from '@app/common';
import { Db } from '@app/database';
import { DomainEvent, INTERNAL_EVENT_TYPES, KafkaService, Topics } from '@app/messaging';
import { MAX_ATTEMPTS, nextRetryDelayMs } from './backoff';
import { ALLOW_PRIVATE_URLS, assertSafeWebhookUrl } from './url-guard';

export const API_VERSION = '2026-10-01';
const POLL_MS = parseInt(process.env.WEBHOOK_POLL_MS ?? '500', 10);
const BATCH_SIZE = 25;
const DELIVERY_TIMEOUT_MS = 10_000;
/** A claimed delivery is invisible to other workers for this long (a lease, in case this worker dies). */
const LEASE_SECONDS = 60;

interface DueDelivery {
  id: string;
  endpoint_id: string;
  event_id: string;
  event_type: string;
  payload: unknown;
  attempts: number;
  url: string;
  secret: string;
  endpoint_status: string;
}

const deliveries = counter('payforge_webhook_deliveries_total', 'Webhook delivery attempts by outcome', ['outcome'] as const);
const deliveryLatency = histogram('payforge_webhook_delivery_seconds', 'Webhook HTTP latency', [], [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10]);

/**
 * Consumes domain events, fans them out to each subscribed endpoint (one delivery row per
 * endpoint × event), and a polling worker sends them. Workers claim due rows with
 * FOR UPDATE SKIP LOCKED, so any number of webhook-service instances can run in parallel
 * without sending the same delivery twice at the same time.
 */
@Injectable()
export class WebhookDispatcher implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('WebhookDispatcher');
  private timer?: NodeJS.Timeout;
  private busy = false;

  constructor(
    private readonly db: Db,
    private readonly kafka: KafkaService,
  ) {}

  onModuleInit(): void {
    this.kafka.subscribe('webhooks', [Topics.payments, Topics.settlements], (event) => this.fanOut(event));
    this.timer = setInterval(() => void this.tick(), POLL_MS);
  }

  onModuleDestroy(): void {
    clearInterval(this.timer);
  }

  async fanOut(event: DomainEvent): Promise<void> {
    if (!event.merchant_id || INTERNAL_EVENT_TYPES.has(event.type)) return;
    const endpoints = await this.db.many<{ id: string }>(
      `SELECT id FROM webhook_endpoints
       WHERE merchant_id = $1 AND status = 'enabled' AND ('*' = ANY(enabled_events) OR $2 = ANY(enabled_events))`,
      [event.merchant_id, event.type],
    );
    if (!endpoints.length) return;
    // `internal` never leaves the platform: merchants get only the public object.
    const payload = { id: event.id, object: 'event', type: event.type, api_version: API_VERSION, created_at: event.created_at, data: event.data };
    const objectId = (event.data?.object as { id?: string })?.id ?? null;
    for (const endpoint of endpoints) {
      await this.db.query(
        `INSERT INTO webhook_deliveries (id, endpoint_id, merchant_id, event_id, event_type, object_id, payload)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb) ON CONFLICT (endpoint_id, event_id) DO NOTHING`,
        [newId(IdPrefix.webhookDelivery), endpoint.id, event.merchant_id, event.id, event.type, objectId, JSON.stringify(payload)],
      );
    }
  }

  private async tick(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      const due = await this.db.many<DueDelivery>(
        `UPDATE webhook_deliveries d
            SET next_attempt_at = now() + make_interval(secs => $1), updated_at = now()
           FROM webhook_endpoints e
          WHERE e.id = d.endpoint_id
            AND d.id IN (
              SELECT id FROM webhook_deliveries
               WHERE status IN ('pending', 'retrying') AND next_attempt_at <= now()
               ORDER BY next_attempt_at
               LIMIT $2
               FOR UPDATE SKIP LOCKED)
        RETURNING d.id, d.endpoint_id, d.event_id, d.event_type, d.payload, d.attempts, e.url, e.secret, e.status AS endpoint_status`,
        [LEASE_SECONDS, BATCH_SIZE],
      );
      await Promise.all(due.map((d) => this.deliver(d)));
    } catch (err) {
      this.logger.warn(`Dispatch tick failed: ${(err as Error).message}`);
    } finally {
      this.busy = false;
    }
  }

  private async deliver(d: DueDelivery): Promise<void> {
    const body = JSON.stringify(d.payload);
    const attempt = d.attempts + 1;
    const started = Date.now();
    let code: number | null = null;
    let responseBody: string | null = null;
    let error: string | null = null;

    if (d.endpoint_status !== 'enabled') {
      error = 'endpoint disabled';
    } else {
      try {
        if (!ALLOW_PRIVATE_URLS) await assertSafeWebhookUrl(d.url, false);
        const res = await fetch(d.url, {
          method: 'POST',
          redirect: 'manual',
          signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
          headers: {
            'content-type': 'application/json',
            'user-agent': 'PayForge-Webhooks/1.0',
            [SIGNATURE_HEADER]: signWebhookPayload(d.secret, body),
            'payforge-event-id': d.event_id,
            'payforge-event-type': d.event_type,
            'payforge-delivery-attempt': String(attempt),
          },
          body,
        });
        code = res.status;
        responseBody = (await res.text()).slice(0, 1_000);
      } catch (err) {
        const e = err as Error;
        error = e.name === 'TimeoutError' ? `timed out after ${DELIVERY_TIMEOUT_MS / 1000}s` : e.message;
      }
    }

    const latency = Date.now() - started;
    deliveryLatency.observe(latency / 1_000);
    const ok = code !== null && code >= 200 && code < 300;
    const dead = !ok && (attempt >= MAX_ATTEMPTS || d.endpoint_status !== 'enabled');
    const status = ok ? 'succeeded' : dead ? 'dead' : 'retrying';
    const nextAttemptAt = ok || dead ? new Date() : new Date(Date.now() + nextRetryDelayMs(attempt));

    await this.db.tx(async (c) => {
      await c.query(
        `INSERT INTO webhook_attempts (delivery_id, attempt, response_code, error, latency_ms) VALUES ($1, $2, $3, $4, $5)`,
        [d.id, attempt, code, error ?? (ok ? null : `HTTP ${code}`), latency],
      );
      await c.query(
        `UPDATE webhook_deliveries
            SET status = $2, attempts = $3, next_attempt_at = $4, last_response_code = $5, last_response_body = $6,
                last_error = $7, last_latency_ms = $8, last_attempt_at = now(), updated_at = now()
          WHERE id = $1`,
        [d.id, status, attempt, nextAttemptAt, code, responseBody, ok ? null : (error ?? `HTTP ${code}`), latency],
      );
    });
    deliveries.inc({ outcome: status });

    if (dead) {
      this.logger.warn(`Delivery ${d.id} (${d.event_type}) moved to dead-letter after ${attempt} attempts`);
      await this.kafka
        .publish(Topics.deadLetter, [{ key: d.id, value: body, headers: { source: 'webhooks', 'delivery-id': d.id, error: String(error ?? code) } }])
        .catch(() => undefined);
    }
  }
}
