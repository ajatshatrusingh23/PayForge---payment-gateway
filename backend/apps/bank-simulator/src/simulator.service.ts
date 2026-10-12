import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import {
  AcquirerPaymentRequest,
  AcquirerPaymentResponse,
  AcquirerRefundResponse,
  ApiError,
  applyBps,
  BANK_SIGNATURE_HEADER,
  bankCallbackSecret,
  Errors,
  hmacSha256,
  randomString,
  SettlementReport,
  TEST_OTP,
  testCardOutcome,
} from '@app/common';
import { Db } from '@app/database';
import { AcquirerRuntime, AcquirerState } from './acquirer-state';

interface TxnRow {
  id: string;
  acquirer: string;
  merchant_ref: string;
  merchant_id: string | null;
  type: 'sale' | 'auth' | 'capture' | 'void' | 'refund';
  method: string;
  amount: number;
  currency: string;
  status: 'approved' | 'declined' | 'requires_otp' | 'pending';
  captured: boolean;
  decline_code: string | null;
  parent_id: string | null;
  otp_attempts: number;
  resolve_at: Date | null;
  upi_vpa: string | null;
  callback_url: string | null;
  fee: number;
  approved_at: Date | null;
  created_at: Date;
}

interface Decision {
  status: TxnRow['status'];
  declineCode?: string;
  resolveAt?: Date;
  hangMs?: number;
}

const DECLINE_MESSAGES: Record<string, string> = {
  do_not_honor: 'The card issuer declined the payment.',
  insufficient_funds: 'The card has insufficient funds to complete the purchase.',
  expired_card: 'The card has expired.',
  otp_failed: 'The OTP was entered incorrectly too many times.',
  upi_declined: 'The customer declined the UPI collect request.',
  amount_exceeds_captured: 'Refund amount exceeds the captured amount.',
};

const MAX_OTP_ATTEMPTS = 3;
const UPI_APPROVAL_DELAY_MS = parseInt(process.env.SIM_UPI_DELAY_MS ?? '3000', 10);
/** How long the "acquirer_timeout" test card hangs before answering (well past PayForge's timeout). */
const HANG_MS = parseInt(process.env.SIM_HANG_MS ?? '10000', 10);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

@Injectable()
export class SimulatorService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('BankSimulator');
  private sweeper?: NodeJS.Timeout;
  private sweeping = false;

  constructor(
    private readonly db: Db,
    private readonly state: AcquirerState,
  ) {}

  onModuleInit(): void {
    // Pending UPI collect requests are resolved from the DB (not in-memory timers) so they survive restarts.
    this.sweeper = setInterval(() => void this.resolveDuePending(), 500);
  }

  onModuleDestroy(): void {
    clearInterval(this.sweeper);
  }

  // ---------------------------------------------------------------- authorization

  async authorize(acquirer: string, req: AcquirerPaymentRequest): Promise<AcquirerPaymentResponse> {
    const s = this.state.get(acquirer);
    if (!req?.merchant_ref || !Number.isSafeInteger(req.amount) || req.amount <= 0) {
      throw Errors.invalid('merchant_ref and a positive integer amount are required');
    }
    if (!s.methods.includes(req.method)) {
      throw new ApiError(400, 'invalid_request_error', 'method_not_supported', `${s.name} does not support ${req.method}`);
    }
    s.stats.requests++;
    await this.simulateNetwork(s, true);

    const type = req.capture ? 'sale' : 'auth';
    const existing = await this.findByRef(acquirer, req.merchant_ref, type);
    if (existing) return this.view(existing); // idempotent retry

    const decision = this.decide(req);
    const approved = decision.status === 'approved';
    const row = await this.db.one<TxnRow>(
      `INSERT INTO bank_transactions
         (id, acquirer, merchant_ref, merchant_id, type, method, amount, currency, status, captured,
          decline_code, resolve_at, upi_vpa, callback_url, fee, approved_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
       ON CONFLICT (acquirer, merchant_ref, type) DO NOTHING
       RETURNING *`,
      [
        `${acquirer.toUpperCase()}_${randomString(18)}`,
        acquirer,
        req.merchant_ref,
        req.merchant_id ?? null,
        type,
        req.method,
        req.amount,
        req.currency ?? 'INR',
        decision.status,
        approved && req.capture,
        decision.declineCode ?? null,
        decision.resolveAt ?? null,
        req.upi?.vpa ?? null,
        req.callback_url ?? null,
        approved && req.capture ? applyBps(req.amount, s.costBps) : 0,
        approved ? new Date() : null,
      ],
    );
    if (!row) return this.view((await this.findByRef(acquirer, req.merchant_ref, type))!);

    if (decision.status === 'approved') s.stats.approved++;
    else if (decision.status === 'declined') s.stats.declined++;
    else s.stats.pending++;

    if (decision.hangMs) await sleep(decision.hangMs);
    return this.view(row);
  }

  /** Issuer decision, driven by test card numbers / test VPAs (like Stripe's test mode). */
  private decide(req: AcquirerPaymentRequest): Decision {
    if (req.method === 'upi') {
      return { status: 'pending', resolveAt: new Date(Date.now() + UPI_APPROVAL_DELAY_MS) };
    }
    const card = req.card;
    if (!card?.pan) throw Errors.invalid('card details are required for card payments');
    const now = new Date();
    const expYear = card.exp_year < 100 ? 2000 + card.exp_year : card.exp_year;
    if (expYear < now.getUTCFullYear() || (expYear === now.getUTCFullYear() && card.exp_month < now.getUTCMonth() + 1)) {
      return { status: 'declined', declineCode: 'expired_card' };
    }
    switch (testCardOutcome(card.pan)) {
      case 'declined':
        return { status: 'declined', declineCode: 'do_not_honor' };
      case 'insufficient_funds':
        return { status: 'declined', declineCode: 'insufficient_funds' };
      case 'otp_required':
        return { status: 'requires_otp' };
      case 'acquirer_timeout':
        return { status: 'approved', hangMs: HANG_MS };
      default:
        return req.force_otp ? { status: 'requires_otp' } : { status: 'approved' };
    }
  }

  async getByMerchantRef(acquirer: string, merchantRef: string): Promise<AcquirerPaymentResponse> {
    await this.simulateNetwork(this.state.get(acquirer), false);
    let row = await this.db.one<TxnRow>(
      `SELECT * FROM bank_transactions WHERE acquirer = $1 AND merchant_ref = $2 AND type IN ('sale', 'auth')`,
      [acquirer, merchantRef],
    );
    if (!row) throw Errors.notFound('transaction', merchantRef);
    if (row.status === 'pending' && row.resolve_at && row.resolve_at.getTime() <= Date.now()) {
      row = (await this.resolvePending(row.id)) ?? row;
    }
    return this.view(row);
  }

  async verifyOtp(acquirer: string, id: string, otp: string): Promise<AcquirerPaymentResponse> {
    const s = this.state.get(acquirer);
    await this.simulateNetwork(s, false);
    return this.db.tx(async (c) => {
      const row = await this.db.one<TxnRow>('SELECT * FROM bank_transactions WHERE id = $1 AND acquirer = $2 FOR UPDATE', [id, acquirer], c);
      if (!row) throw Errors.notFound('transaction', id);
      if (row.status !== 'requires_otp') return this.view(row);

      if (otp === TEST_OTP) {
        const sale = row.type === 'sale';
        const updated = await this.db.one<TxnRow>(
          `UPDATE bank_transactions SET status = 'approved', captured = $2, fee = $3, approved_at = now(), updated_at = now()
           WHERE id = $1 RETURNING *`,
          [id, sale, sale ? applyBps(row.amount, s.costBps) : 0],
          c,
        );
        s.stats.approved++;
        return this.view(updated!);
      }

      const attempts = row.otp_attempts + 1;
      if (attempts >= MAX_OTP_ATTEMPTS) {
        const updated = await this.db.one<TxnRow>(
          `UPDATE bank_transactions SET status = 'declined', decline_code = 'otp_failed', otp_attempts = $2, updated_at = now()
           WHERE id = $1 RETURNING *`,
          [id, attempts],
          c,
        );
        s.stats.declined++;
        return this.view(updated!);
      }
      const updated = await this.db.one<TxnRow>(
        'UPDATE bank_transactions SET otp_attempts = $2, updated_at = now() WHERE id = $1 RETURNING *',
        [id, attempts],
        c,
      );
      return { ...this.view(updated!), otp_attempts_remaining: MAX_OTP_ATTEMPTS - attempts };
    });
  }

  // ---------------------------------------------------------------- capture / void / refund

  async capture(acquirer: string, id: string, amount: number): Promise<AcquirerPaymentResponse> {
    const s = this.state.get(acquirer);
    await this.simulateNetwork(s, false);
    return this.db.tx(async (c) => {
      const auth = await this.lockParent(c, acquirer, id);
      if (auth.type !== 'auth' || auth.status !== 'approved') throw Errors.unexpectedState('Only approved authorizations can be captured');
      const existing = await this.findByRef(acquirer, auth.merchant_ref, 'capture', c);
      if (existing) return this.view(existing);
      if (await this.findByRef(acquirer, auth.merchant_ref, 'void', c)) throw Errors.unexpectedState('Authorization has been voided');
      if (!Number.isSafeInteger(amount) || amount <= 0 || amount > auth.amount) throw Errors.invalid('Capture amount must be between 1 and the authorized amount');

      const row = await this.db.one<TxnRow>(
        `INSERT INTO bank_transactions (id, acquirer, merchant_ref, merchant_id, type, method, amount, status, captured, parent_id, fee, approved_at)
         VALUES ($1, $2, $3, $4, 'capture', $5, $6, 'approved', true, $7, $8, now()) RETURNING *`,
        [`${acquirer.toUpperCase()}_CAP_${randomString(14)}`, acquirer, auth.merchant_ref, auth.merchant_id, auth.method, amount, auth.id, applyBps(amount, s.costBps)],
        c,
      );
      await c.query('UPDATE bank_transactions SET captured = true, updated_at = now() WHERE id = $1', [auth.id]);
      return this.view(row!);
    });
  }

  async void(acquirer: string, id: string): Promise<AcquirerPaymentResponse> {
    await this.simulateNetwork(this.state.get(acquirer), false);
    return this.db.tx(async (c) => {
      const auth = await this.lockParent(c, acquirer, id);
      if (auth.type !== 'auth' || auth.status !== 'approved' || auth.captured) {
        throw Errors.unexpectedState('Only uncaptured, approved authorizations can be voided');
      }
      const existing = await this.findByRef(acquirer, auth.merchant_ref, 'void', c);
      if (existing) return this.view(existing);
      const row = await this.db.one<TxnRow>(
        `INSERT INTO bank_transactions (id, acquirer, merchant_ref, merchant_id, type, method, amount, status, parent_id, approved_at)
         VALUES ($1, $2, $3, $4, 'void', $5, $6, 'approved', $7, now()) RETURNING *`,
        [`${acquirer.toUpperCase()}_VOID_${randomString(14)}`, acquirer, auth.merchant_ref, auth.merchant_id, auth.method, auth.amount, auth.id],
        c,
      );
      return this.view(row!);
    });
  }

  async refund(acquirer: string, body: { merchant_ref: string; payment_id: string; amount: number }): Promise<AcquirerRefundResponse> {
    await this.simulateNetwork(this.state.get(acquirer), false);
    if (!body?.merchant_ref || !body.payment_id || !Number.isSafeInteger(body.amount) || body.amount <= 0) {
      throw Errors.invalid('merchant_ref, payment_id and a positive integer amount are required');
    }
    return this.db.tx(async (c) => {
      const existing = await this.findByRef(acquirer, body.merchant_ref, 'refund', c);
      if (existing) return this.refundView(existing);
      const parent = await this.lockParent(c, acquirer, body.payment_id);
      const captured = await this.capturedAmount(c, parent);
      const refunded = await this.db.one<{ total: number }>(
        `SELECT COALESCE(SUM(amount), 0) AS total FROM bank_transactions WHERE parent_id = $1 AND type = 'refund' AND status = 'approved'`,
        [parent.id],
        c,
      );
      const ok = captured > 0 && refunded!.total + body.amount <= captured;
      const row = await this.db.one<TxnRow>(
        `INSERT INTO bank_transactions (id, acquirer, merchant_ref, merchant_id, type, method, amount, status, decline_code, parent_id, approved_at)
         VALUES ($1, $2, $3, $4, 'refund', $5, $6, $7, $8, $9, $10) RETURNING *`,
        [
          `${acquirer.toUpperCase()}_RFND_${randomString(14)}`,
          acquirer,
          body.merchant_ref,
          parent.merchant_id,
          parent.method,
          body.amount,
          ok ? 'approved' : 'declined',
          ok ? null : 'amount_exceeds_captured',
          parent.id,
          ok ? new Date() : null,
        ],
        c,
      );
      return this.refundView(row!);
    });
  }

  // ---------------------------------------------------------------- settlement report

  async settlementReport(acquirer: string, date: string): Promise<SettlementReport> {
    const s = this.state.get(acquirer);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw Errors.invalid('date must be YYYY-MM-DD', 'date');
    const rows = await this.db.many<TxnRow>(
      `SELECT * FROM bank_transactions
       WHERE acquirer = $1 AND status = 'approved' AND type IN ('sale', 'capture', 'refund')
         AND approved_at >= $2::date AND approved_at < $2::date + 1
       ORDER BY approved_at, id`,
      [acquirer, date],
    );
    let lines = rows.map((r) => ({
      acquirer_ref: r.id,
      merchant_ref: r.merchant_ref,
      type: r.type as 'sale' | 'capture' | 'refund',
      amount: r.amount,
      fee: r.fee,
      approved_at: r.approved_at!.toISOString(),
    }));
    if (s.injectDiscrepancy && lines.length > 0) {
      // Chaos: one line reported short by ₹1 and the last line missing (as if it slipped to the next file).
      lines = lines.map((l, i) => (i === 0 ? { ...l, amount: l.amount - 100 } : l));
      if (lines.length > 1) lines = lines.slice(0, -1);
      s.injectDiscrepancy = false;
      this.logger.warn(`Injected a reconciliation discrepancy into ${s.name}'s report for ${date}`);
    }
    return { acquirer, business_date: date, lines };
  }

  // ---------------------------------------------------------------- internals

  /** Applies the acquirer's outage flag, latency, and (optionally) random technical failures. */
  private async simulateNetwork(s: AcquirerRuntime, allowRandomFailure: boolean): Promise<void> {
    if (s.down) {
      s.stats.rejectedWhileDown++;
      await sleep(20);
      throw new ApiError(503, 'api_error', 'acquirer_unavailable', `${s.name} is currently unavailable`);
    }
    await sleep(this.state.latency(s.code));
    if (allowRandomFailure && Math.random() < s.technicalFailureRate) {
      s.stats.technicalFailures++;
      throw new ApiError(502, 'api_error', 'issuer_unreachable', `${s.name} could not reach the issuer`);
    }
  }

  private async resolveDuePending(): Promise<void> {
    if (this.sweeping) return;
    this.sweeping = true;
    try {
      const due = await this.db.many<{ id: string }>(
        `SELECT id FROM bank_transactions WHERE status = 'pending' AND resolve_at <= now() ORDER BY resolve_at LIMIT 50`,
      );
      for (const { id } of due) await this.resolvePending(id);
    } catch (err) {
      this.logger.warn(`Pending sweep failed: ${(err as Error).message}`);
    } finally {
      this.sweeping = false;
    }
  }

  /** UPI collect: the customer approves (or declines) on their phone a few seconds later. */
  private async resolvePending(id: string): Promise<TxnRow | null> {
    const row = await this.db.tx(async (c) => {
      const pending = await this.db.one<TxnRow>(`SELECT * FROM bank_transactions WHERE id = $1 AND status = 'pending' FOR UPDATE`, [id], c);
      if (!pending) return null;
      const s = this.state.get(pending.acquirer);
      const decline = (pending.upi_vpa ?? '').startsWith('fail');
      const sale = pending.type === 'sale';
      const updated = await this.db.one<TxnRow>(
        `UPDATE bank_transactions
           SET status = $2, decline_code = $3, captured = $4, fee = $5, approved_at = $6, updated_at = now()
         WHERE id = $1 RETURNING *`,
        [
          id,
          decline ? 'declined' : 'approved',
          decline ? 'upi_declined' : null,
          !decline && sale,
          !decline && sale ? applyBps(pending.amount, s.costBps) : 0,
          decline ? null : new Date(),
        ],
        c,
      );
      if (decline) s.stats.declined++;
      else s.stats.approved++;
      return updated;
    });
    if (row?.callback_url) void this.sendCallback(row);
    return row;
  }

  /** Async notification to PayForge, HMAC-signed. If it never arrives, PayForge's poller catches up. */
  private async sendCallback(row: TxnRow): Promise<void> {
    const body = JSON.stringify(this.view(row));
    const signature = hmacSha256(bankCallbackSecret(), body);
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const res = await fetch(row.callback_url!, {
          method: 'POST',
          headers: { 'content-type': 'application/json', [BANK_SIGNATURE_HEADER]: signature },
          body,
          signal: AbortSignal.timeout(3_000),
        });
        if (res.ok) return;
      } catch {
        /* retry */
      }
      await sleep(1_000 * attempt);
    }
    this.logger.warn(`Callback for ${row.id} failed after 3 attempts; PayForge will reconcile by polling`);
  }

  private async findByRef(acquirer: string, merchantRef: string, type: TxnRow['type'], client?: Parameters<Db['one']>[2]) {
    return this.db.one<TxnRow>(
      'SELECT * FROM bank_transactions WHERE acquirer = $1 AND merchant_ref = $2 AND type = $3',
      [acquirer, merchantRef, type],
      client,
    );
  }

  private async lockParent(client: Parameters<Db['one']>[2], acquirer: string, id: string): Promise<TxnRow> {
    const row = await this.db.one<TxnRow>(
      `SELECT * FROM bank_transactions WHERE id = $1 AND acquirer = $2 AND type IN ('sale', 'auth') FOR UPDATE`,
      [id, acquirer],
      client,
    );
    if (!row) throw Errors.notFound('transaction', id);
    return row;
  }

  private async capturedAmount(client: Parameters<Db['one']>[2], parent: TxnRow): Promise<number> {
    if (parent.status !== 'approved') return 0;
    if (parent.type === 'sale') return parent.captured ? parent.amount : 0;
    const capture = await this.findByRef(parent.acquirer, parent.merchant_ref, 'capture', client);
    return capture?.amount ?? 0;
  }

  private view(row: TxnRow): AcquirerPaymentResponse {
    return {
      id: row.id,
      merchant_ref: row.merchant_ref,
      type: row.type as AcquirerPaymentResponse['type'],
      status: row.status,
      captured: row.captured,
      amount: row.amount,
      decline_code: row.decline_code,
      decline_message: row.decline_code ? (DECLINE_MESSAGES[row.decline_code] ?? 'The payment was declined.') : null,
      created_at: row.created_at.toISOString(),
    };
  }

  private refundView(row: TxnRow): AcquirerRefundResponse {
    return {
      id: row.id,
      merchant_ref: row.merchant_ref,
      status: row.status === 'approved' ? 'approved' : 'declined',
      amount: row.amount,
      decline_code: row.decline_code,
    };
  }
}
