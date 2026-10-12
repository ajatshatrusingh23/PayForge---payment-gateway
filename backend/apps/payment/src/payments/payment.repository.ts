import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { Errors, IdPrefix, newId } from '@app/common';
import { Db, Queryable } from '@app/database';
import { buildEvent, enqueueEvent, Topics } from '@app/messaging';
import { assertTransition, PaymentStatus } from '../domain/state-machine';
import type { AttemptStatus, PaymentAttemptRow, PaymentIntentRow, RefundRow } from '../domain/types';
import { paymentIntentView, refundView } from '../domain/views';

const JSON_COLUMNS = new Set(['metadata', 'payment_method_details', 'last_payment_error', 'next_action']);
const UPDATABLE_INTENT_COLUMNS = new Set([
  'payment_method_id',
  'payment_method_type',
  'payment_method_details',
  'amount_capturable',
  'amount_received',
  'amount_refunded',
  'fee',
  'gst',
  'acquirer',
  'acquirer_ref',
  'last_payment_error',
  'next_action',
  'risk_score',
  'risk_decision',
  'attempt_count',
  'cancellation_reason',
  'captured_at',
  'canceled_at',
]);

export type IntentPatch = Partial<PaymentIntentRow>;

export type NewIntent = Pick<
  PaymentIntentRow,
  | 'id'
  | 'merchant_id'
  | 'amount'
  | 'currency'
  | 'capture_method'
  | 'client_secret'
  | 'description'
  | 'statement_descriptor'
  | 'customer_email'
  | 'metadata'
  | 'payment_method_types'
  | 'fee_bps'
  | 'expires_at'
>;

export interface EventSpec {
  type: string;
  internal?: Record<string, unknown>;
}

/**
 * All persistence for the payment service. Status changes go through `transition`,
 * which (1) validates the move against the state machine, (2) applies it with an
 * optimistic version check, and (3) writes the domain event to the outbox in the
 * SAME transaction.
 */
@Injectable()
export class PaymentRepository {
  constructor(private readonly db: Db) {}

  // ------------------------------------------------------------------ intents

  async insertIntent(c: Queryable, row: NewIntent): Promise<PaymentIntentRow> {
    const inserted = await this.db.one<PaymentIntentRow>(
      `INSERT INTO payment_intents
         (id, merchant_id, amount, currency, status, capture_method, client_secret, description, statement_descriptor,
          customer_email, metadata, payment_method_types, fee_bps, expires_at)
       VALUES ($1, $2, $3, $4, 'created', $5, $6, $7, $8, $9, $10::jsonb, $11, $12, $13)
       RETURNING *`,
      [
        row.id,
        row.merchant_id,
        row.amount,
        row.currency,
        row.capture_method,
        row.client_secret,
        row.description,
        row.statement_descriptor,
        row.customer_email,
        JSON.stringify(row.metadata ?? {}),
        row.payment_method_types,
        row.fee_bps,
        row.expires_at,
      ],
      c,
    );
    return inserted!;
  }

  async findIntent(merchantId: string, id: string, c: Queryable = this.db.pool): Promise<PaymentIntentRow | null> {
    return this.db.one<PaymentIntentRow>('SELECT * FROM payment_intents WHERE id = $1 AND merchant_id = $2', [id, merchantId], c);
  }

  async getIntent(merchantId: string, id: string): Promise<PaymentIntentRow> {
    const pi = await this.findIntent(merchantId, id);
    if (!pi) throw Errors.notFound('payment_intent', id);
    return pi;
  }

  /** SELECT ... FOR UPDATE: serialises concurrent operations on one payment. */
  async lockIntent(c: PoolClient, id: string, merchantId?: string): Promise<PaymentIntentRow> {
    const pi = await this.db.one<PaymentIntentRow>(
      `SELECT * FROM payment_intents WHERE id = $1 AND ($2::text IS NULL OR merchant_id = $2) FOR UPDATE`,
      [id, merchantId ?? null],
      c,
    );
    if (!pi) throw Errors.notFound('payment_intent', id);
    return pi;
  }

  async transition(c: PoolClient, pi: PaymentIntentRow, to: PaymentStatus, patch: IntentPatch = {}, event?: EventSpec): Promise<PaymentIntentRow> {
    assertTransition(pi.status, to);
    const updated = await this.update(c, pi, { ...patch, status: to });
    if (event) await this.emit(c, updated, event);
    return updated;
  }

  /** Field update without a status change (e.g. recording the risk score). */
  async patch(c: PoolClient, pi: PaymentIntentRow, patch: IntentPatch): Promise<PaymentIntentRow> {
    return this.update(c, pi, patch);
  }

  async emit(c: PoolClient, pi: PaymentIntentRow, event: EventSpec): Promise<void> {
    await enqueueEvent(
      c,
      Topics.payments,
      pi.id,
      buildEvent(event.type, pi.merchant_id, paymentIntentView(pi, { includeSecret: false }), event.internal),
    );
  }

  async emitRefund(c: PoolClient, refund: RefundRow, type: string, internal?: Record<string, unknown>): Promise<void> {
    await enqueueEvent(c, Topics.payments, refund.payment_intent_id, buildEvent(type, refund.merchant_id, refundView(refund), internal));
  }

  private async update(c: PoolClient, pi: PaymentIntentRow, patch: IntentPatch & { status?: PaymentStatus }): Promise<PaymentIntentRow> {
    const sets: string[] = [];
    const values: unknown[] = [pi.id, pi.version];
    for (const [column, value] of Object.entries(patch)) {
      if (value === undefined) continue;
      if (column !== 'status' && !UPDATABLE_INTENT_COLUMNS.has(column)) throw new Error(`Column ${column} is not updatable`);
      const isJson = JSON_COLUMNS.has(column);
      values.push(isJson && value !== null ? JSON.stringify(value) : value);
      sets.push(`${column} = $${values.length}${isJson ? '::jsonb' : ''}`);
    }
    const row = await this.db.one<PaymentIntentRow>(
      `UPDATE payment_intents SET ${[...sets, 'version = version + 1', 'updated_at = now()'].join(', ')}
       WHERE id = $1 AND version = $2 RETURNING *`,
      values,
      c,
    );
    if (!row) throw Errors.conflict('concurrent_update', `PaymentIntent ${pi.id} was modified concurrently; please retry`);
    return row;
  }

  async listIntents(merchantId: string, opts: { limit: number; startingAfter?: string; status?: string; q?: string }) {
    const rows = await this.db.many<PaymentIntentRow>(
      `SELECT * FROM payment_intents p
       WHERE p.merchant_id = $1
         AND ($2::text IS NULL OR p.status = $2)
         AND ($3::text IS NULL OR p.id = $3 OR p.customer_email ILIKE '%' || $3 || '%' OR p.description ILIKE '%' || $3 || '%')
         AND ($4::text IS NULL OR (p.created_at, p.id) < (SELECT created_at, id FROM payment_intents WHERE id = $4 AND merchant_id = $1))
       ORDER BY p.created_at DESC, p.id DESC
       LIMIT $5`,
      [merchantId, opts.status ?? null, opts.q ?? null, opts.startingAfter ?? null, opts.limit + 1],
    );
    return { rows: rows.slice(0, opts.limit), hasMore: rows.length > opts.limit };
  }

  async expirable(limit = 100): Promise<string[]> {
    const rows = await this.db.many<{ id: string }>(
      `SELECT id FROM payment_intents WHERE status IN ('created', 'failed', 'requires_action') AND expires_at < now()
       ORDER BY expires_at LIMIT $1`,
      [limit],
    );
    return rows.map((r) => r.id);
  }

  /**
   * Payments stuck in `processing` with no open attempt: the process failed before any bank was
   * called (e.g. the DB was unavailable while recording a risk/vault failure). No money moved.
   */
  async stuckProcessing(limit = 50): Promise<string[]> {
    const rows = await this.db.many<{ id: string }>(
      `SELECT p.id FROM payment_intents p
       WHERE p.status = 'processing' AND p.updated_at < now() - interval '2 minutes'
         AND NOT EXISTS (
           SELECT 1 FROM payment_attempts a
           WHERE a.payment_intent_id = p.id AND a.status IN ('initiated', 'pending', 'unknown', 'requires_otp'))
       ORDER BY p.updated_at LIMIT $1`,
      [limit],
    );
    return rows.map((r) => r.id);
  }

  async timeline(merchantId: string, id: string) {
    await this.getIntent(merchantId, id);
    const events = await this.db.many<{ payload: { id: string; type: string; created_at: string } }>(
      'SELECT payload FROM outbox_events WHERE message_key = $1 ORDER BY id',
      [id],
    );
    const attempts = await this.db.many<PaymentAttemptRow>(
      'SELECT * FROM payment_attempts WHERE payment_intent_id = $1 ORDER BY created_at',
      [id],
    );
    const refunds = await this.db.many<RefundRow>('SELECT * FROM refunds WHERE payment_intent_id = $1 ORDER BY created_at', [id]);
    return {
      object: 'payment_timeline',
      payment_intent: id,
      events: events.map((e) => ({ id: e.payload.id, type: e.payload.type, created_at: e.payload.created_at })),
      attempts: attempts.map((a) => ({
        id: a.id,
        acquirer: a.acquirer,
        method: a.method,
        status: a.status,
        acquirer_ref: a.acquirer_ref,
        decline_code: a.decline_code,
        error_message: a.error_message,
        latency_ms: a.latency_ms,
        created_at: a.created_at,
        updated_at: a.updated_at,
      })),
      refunds: refunds.map(refundView),
    };
  }

  // ------------------------------------------------------------------ attempts

  async createAttempt(pi: PaymentIntentRow, acquirer: string, method: 'card' | 'upi'): Promise<PaymentAttemptRow> {
    const row = await this.db.one<PaymentAttemptRow>(
      `INSERT INTO payment_attempts (id, payment_intent_id, merchant_id, acquirer, method, status, next_check_at)
       VALUES ($1, $2, $3, $4, $5, 'initiated', now() + interval '30 seconds') RETURNING *`,
      [newId(IdPrefix.paymentAttempt), pi.id, pi.merchant_id, acquirer, method],
    );
    return row!;
  }

  async lockAttempt(c: PoolClient, id: string): Promise<PaymentAttemptRow> {
    const row = await this.db.one<PaymentAttemptRow>('SELECT * FROM payment_attempts WHERE id = $1 FOR UPDATE', [id], c);
    if (!row) throw Errors.notFound('payment_attempt', id);
    return row;
  }

  async findAttempt(id: string): Promise<PaymentAttemptRow | null> {
    return this.db.one<PaymentAttemptRow>('SELECT * FROM payment_attempts WHERE id = $1', [id]);
  }

  async updateAttempt(
    id: string,
    patch: { status?: AttemptStatus; acquirer_ref?: string | null; decline_code?: string | null; error_message?: string | null; latency_ms?: number; next_check_at?: Date | null; checks?: number },
    c: Queryable = this.db.pool,
  ): Promise<void> {
    const sets: string[] = [];
    const values: unknown[] = [id];
    for (const [column, value] of Object.entries(patch)) {
      if (value === undefined) continue;
      values.push(value);
      sets.push(`${column} = $${values.length}`);
    }
    await c.query(`UPDATE payment_attempts SET ${[...sets, 'updated_at = now()'].join(', ')} WHERE id = $1`, values);
  }

  async latestAttempt(c: Queryable, piId: string, status?: AttemptStatus): Promise<PaymentAttemptRow | null> {
    return this.db.one<PaymentAttemptRow>(
      `SELECT * FROM payment_attempts WHERE payment_intent_id = $1 AND ($2::text IS NULL OR status = $2)
       ORDER BY created_at DESC LIMIT 1`,
      [piId, status ?? null],
      c,
    );
  }

  /** Attempts whose outcome we don't know yet: in flight too long, async (UPI), or timed out. */
  async attemptsNeedingStatusCheck(limit = 25): Promise<PaymentAttemptRow[]> {
    return this.db.many<PaymentAttemptRow>(
      `SELECT * FROM payment_attempts
       WHERE status IN ('initiated', 'pending', 'unknown', 'requires_otp') AND next_check_at <= now()
       ORDER BY next_check_at LIMIT $1`,
      [limit],
    );
  }

  // ------------------------------------------------------------------ refunds

  async insertRefund(c: PoolClient, r: Pick<RefundRow, 'payment_intent_id' | 'merchant_id' | 'amount' | 'currency' | 'reason' | 'acquirer'>): Promise<RefundRow> {
    const row = await this.db.one<RefundRow>(
      `INSERT INTO refunds (id, payment_intent_id, merchant_id, amount, currency, status, reason, acquirer)
       VALUES ($1, $2, $3, $4, $5, 'pending', $6, $7) RETURNING *`,
      [newId(IdPrefix.refund), r.payment_intent_id, r.merchant_id, r.amount, r.currency, r.reason, r.acquirer],
      c,
    );
    return row!;
  }

  async lockRefund(c: PoolClient, id: string): Promise<RefundRow | null> {
    return this.db.one<RefundRow>('SELECT * FROM refunds WHERE id = $1 FOR UPDATE', [id], c);
  }

  async updateRefund(c: PoolClient, id: string, patch: { status: RefundRow['status']; acquirer_ref?: string | null; failure_reason?: string | null }): Promise<RefundRow> {
    const row = await this.db.one<RefundRow>(
      `UPDATE refunds SET status = $2, acquirer_ref = COALESCE($3, acquirer_ref), failure_reason = $4, updated_at = now()
       WHERE id = $1 RETURNING *`,
      [id, patch.status, patch.acquirer_ref ?? null, patch.failure_reason ?? null],
      c,
    );
    return row!;
  }

  async pendingRefundTotal(c: PoolClient, piId: string): Promise<number> {
    const row = await this.db.one<{ total: number }>(
      `SELECT COALESCE(SUM(amount), 0) AS total FROM refunds WHERE payment_intent_id = $1 AND status = 'pending'`,
      [piId],
      c,
    );
    return row?.total ?? 0;
  }

  async findRefund(merchantId: string, id: string): Promise<RefundRow | null> {
    return this.db.one<RefundRow>('SELECT * FROM refunds WHERE id = $1 AND merchant_id = $2', [id, merchantId]);
  }

  async listRefunds(merchantId: string, paymentIntentId: string | undefined, limit: number): Promise<RefundRow[]> {
    return this.db.many<RefundRow>(
      `SELECT * FROM refunds WHERE merchant_id = $1 AND ($2::text IS NULL OR payment_intent_id = $2)
       ORDER BY created_at DESC LIMIT $3`,
      [merchantId, paymentIntentId ?? null, limit],
    );
  }

  async stalePendingRefunds(limit = 20): Promise<RefundRow[]> {
    return this.db.many<RefundRow>(
      `SELECT * FROM refunds WHERE status = 'pending' AND updated_at < now() - interval '5 seconds' ORDER BY updated_at LIMIT $1`,
      [limit],
    );
  }
}
