import { Injectable } from '@nestjs/common';
import { Errors, IdPrefix, newId, randomString } from '@app/common';
import { Db } from '@app/database';
import { API_VERSION } from './dispatcher.service';
import { CreateEndpointDto, ListDeliveriesDto } from './dto';
import { assertSafeWebhookUrl } from './url-guard';

interface EndpointRow {
  id: string;
  merchant_id: string;
  url: string;
  secret: string;
  enabled_events: string[];
  description: string | null;
  status: string;
  created_at: Date;
}

@Injectable()
export class WebhookService {
  constructor(private readonly db: Db) {}

  async createEndpoint(merchantId: string, dto: CreateEndpointDto) {
    await assertSafeWebhookUrl(dto.url);
    const row = await this.db.one<EndpointRow>(
      `INSERT INTO webhook_endpoints (id, merchant_id, url, secret, enabled_events, description)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [newId(IdPrefix.webhookEndpoint, 16), merchantId, dto.url, `whsec_${randomString(32)}`, dto.enabled_events ?? ['*'], dto.description ?? null],
    );
    return this.endpointView(row!, true);
  }

  async listEndpoints(merchantId: string) {
    const rows = await this.db.many<EndpointRow>(
      `SELECT * FROM webhook_endpoints WHERE merchant_id = $1 AND status = 'enabled' ORDER BY created_at DESC`,
      [merchantId],
    );
    return { object: 'list', data: rows.map((r) => this.endpointView(r, false)) };
  }

  async getEndpoint(merchantId: string, id: string) {
    return this.endpointView(await this.endpointRow(merchantId, id), true);
  }

  async disableEndpoint(merchantId: string, id: string) {
    await this.endpointRow(merchantId, id);
    await this.db.query(`UPDATE webhook_endpoints SET status = 'disabled' WHERE id = $1`, [id]);
    return { id, object: 'webhook_endpoint', deleted: true };
  }

  async sendTest(merchantId: string, id: string) {
    const endpoint = await this.endpointRow(merchantId, id);
    const eventId = newId(IdPrefix.event);
    const payload = {
      id: eventId,
      object: 'event',
      type: 'ping',
      api_version: API_VERSION,
      created_at: new Date().toISOString(),
      data: { object: { message: 'Hello from PayForge! Your webhook endpoint is reachable.' } },
    };
    const deliveryId = newId(IdPrefix.webhookDelivery);
    await this.db.query(
      `INSERT INTO webhook_deliveries (id, endpoint_id, merchant_id, event_id, event_type, payload) VALUES ($1, $2, $3, $4, 'ping', $5::jsonb)`,
      [deliveryId, endpoint.id, merchantId, eventId, JSON.stringify(payload)],
    );
    return { delivery_id: deliveryId, event_id: eventId, status: 'queued' };
  }

  async listDeliveries(merchantId: string, q: ListDeliveriesDto) {
    const rows = await this.db.many(
      `SELECT d.id, d.endpoint_id, e.url, d.event_id, d.event_type, d.object_id, d.status, d.attempts, d.next_attempt_at,
              d.last_response_code, d.last_error, d.last_latency_ms, d.last_attempt_at, d.created_at
         FROM webhook_deliveries d JOIN webhook_endpoints e ON e.id = d.endpoint_id
        WHERE d.merchant_id = $1
          AND ($2::text IS NULL OR d.status = $2)
          AND ($3::text IS NULL OR d.object_id = $3)
        ORDER BY d.created_at DESC
        LIMIT $4`,
      [merchantId, q.status ?? null, q.object_id ?? null, q.limit ?? 25],
    );
    const counts = await this.db.many<{ status: string; count: number }>(
      `SELECT status, count(*) AS count FROM webhook_deliveries WHERE merchant_id = $1 GROUP BY status`,
      [merchantId],
    );
    return {
      object: 'list',
      data: rows.map((r) => ({ object: 'webhook_delivery', ...r })),
      summary: Object.fromEntries(counts.map((c) => [c.status, c.count])),
    };
  }

  async getDelivery(merchantId: string, id: string) {
    const row = await this.db.one('SELECT * FROM webhook_deliveries WHERE id = $1 AND merchant_id = $2', [id, merchantId]);
    if (!row) throw Errors.notFound('webhook_delivery', id);
    const attempts = await this.db.many(
      'SELECT attempt, response_code, error, latency_ms, created_at FROM webhook_attempts WHERE delivery_id = $1 ORDER BY attempt',
      [id],
    );
    return { object: 'webhook_delivery', ...row, attempt_history: attempts };
  }

  /** Manual replay from the dashboard: works for dead-lettered and even already-succeeded deliveries. */
  async retryDelivery(merchantId: string, id: string) {
    const row = await this.db.one(
      `UPDATE webhook_deliveries SET status = 'pending', next_attempt_at = now(), updated_at = now()
       WHERE id = $1 AND merchant_id = $2 RETURNING id, status`,
      [id, merchantId],
    );
    if (!row) throw Errors.notFound('webhook_delivery', id);
    return { ...row, object: 'webhook_delivery' };
  }

  private async endpointRow(merchantId: string, id: string): Promise<EndpointRow> {
    const row = await this.db.one<EndpointRow>('SELECT * FROM webhook_endpoints WHERE id = $1 AND merchant_id = $2', [id, merchantId]);
    if (!row) throw Errors.notFound('webhook_endpoint', id);
    return row;
  }

  private endpointView(row: EndpointRow, revealSecret: boolean) {
    return {
      id: row.id,
      object: 'webhook_endpoint',
      url: row.url,
      enabled_events: row.enabled_events,
      description: row.description,
      status: row.status,
      secret: revealSecret ? row.secret : `whsec_${'•'.repeat(8)}${row.secret.slice(-4)}`,
      created_at: row.created_at,
    };
  }
}
