import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import type { PoolClient } from 'pg';
import {
  ACQUIRER_CODES,
  callService,
  config,
  counter,
  Errors,
  IdPrefix,
  newId,
  SettlementReport,
} from '@app/common';
import { Db } from '@app/database';
import {
  AcquirerSettlementInternal,
  buildEvent,
  DomainEvent,
  enqueueEvent,
  EventTypes,
  KafkaService,
  PaymentCapturedInternal,
  PayoutPaidInternal,
  RefundSucceededInternal,
  Topics,
} from '@app/messaging';
import { AcquirerLine, PlatformItem, reconcile } from './recon';

const RECON_GRACE_MS = parseInt(process.env.RECON_GRACE_MS ?? '60000', 10);
const reconExceptions = counter('payforge_recon_exceptions_total', 'Reconciliation exceptions raised', ['type'] as const);
const payoutsPaid = counter('payforge_payouts_total', 'Payouts sent to merchants');

interface MerchantInfo {
  id: string;
  business_name: string;
  kyc_status: string;
  settlement_account: Record<string, string> | null;
}

@Injectable()
export class SettlementService implements OnModuleInit {
  private readonly logger = new Logger('Settlement');

  constructor(
    private readonly db: Db,
    private readonly kafka: KafkaService,
  ) {}

  onModuleInit(): void {
    this.kafka.subscribe('settlement', [Topics.payments], (event) => this.onPaymentEvent(event));
  }

  // ------------------------------------------------------------------ ingest our side

  private async onPaymentEvent(event: DomainEvent): Promise<void> {
    if (event.type === EventTypes.paymentCaptured) {
      const i = event.internal as unknown as PaymentCapturedInternal;
      const pi = event.data.object as { id: string };
      await this.db.query(
        `INSERT INTO settlement_items (id, merchant_id, type, source_id, payment_intent_id, merchant_ref, acquirer, acquirer_ref,
                                       amount, fee, gst, net, acquirer_fee, occurred_at)
         VALUES ($1, $2, 'payment', $3, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
         ON CONFLICT (source_id) DO NOTHING`,
        [newId(IdPrefix.settlementItem), event.merchant_id, pi.id, i.attempt_id, i.acquirer, i.acquirer_ref, i.amount, i.fee, i.gst, i.net, i.acquirer_fee, i.captured_at],
      );
    } else if (event.type === EventTypes.refundSucceeded) {
      const i = event.internal as unknown as RefundSucceededInternal;
      await this.db.query(
        `INSERT INTO settlement_items (id, merchant_id, type, source_id, payment_intent_id, merchant_ref, acquirer, acquirer_ref,
                                       amount, net, occurred_at)
         VALUES ($1, $2, 'refund', $3, $4, $3, $5, $6, $7, $8, $9)
         ON CONFLICT (source_id) DO NOTHING`,
        [newId(IdPrefix.settlementItem), event.merchant_id, i.refund_id, i.payment_intent_id, i.acquirer, i.acquirer_ref, i.amount, -i.amount, i.succeeded_at],
      );
    }
  }

  // ------------------------------------------------------------------ scheduled run

  /** Nightly at 02:00 IST: reconcile yesterday's files and pay merchants (T+1 settlement). */
  @Cron('0 30 20 * * *')
  async nightly(): Promise<void> {
    const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    await this.runAll([yesterday]);
  }

  /** Demo: reconcile yesterday + today across all acquirers, then run payouts. */
  async runNow() {
    if (!config.demoMode) throw Errors.forbidden('On-demand settlement runs are only available in demo mode');
    const today = new Date().toISOString().slice(0, 10);
    const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    return this.runAll([yesterday, today]);
  }

  private async runAll(dates: string[]) {
    const recon = [];
    for (const date of dates) {
      for (const acquirer of ACQUIRER_CODES) {
        try {
          recon.push(await this.reconcileAcquirer(acquirer, date));
        } catch (err) {
          this.logger.error(`Reconciliation failed for ${acquirer} ${date}: ${(err as Error).message}`);
          recon.push({ acquirer, business_date: date, error: (err as Error).message });
        }
      }
    }
    const payouts = await this.runPayouts();
    return { object: 'settlement_run', reconciliation: recon, payouts };
  }

  // ------------------------------------------------------------------ reconciliation

  async reconcileAcquirer(acquirer: string, date: string) {
    const report = await callService<SettlementReport>(config.services.bank, `/acquirers/${acquirer}/settlement-report?date=${date}`, {
      timeoutMs: 15_000,
    });
    const runId = newId(IdPrefix.reconRun);
    const start = new Date(`${date}T00:00:00.000Z`);
    const end = new Date(start.getTime() + 86_400_000);

    return this.db.tx(async (c) => {
      // One reconciliation per acquirer at a time.
      await c.query(`SELECT pg_advisory_xact_lock(hashtext('recon:' || $1))`, [acquirer]);

      const newLines: Array<{ type: string; amount: number; fee: number }> = [];
      for (const line of report.lines) {
        const ins = await c.query(
          `INSERT INTO acquirer_report_lines (acquirer_ref, acquirer, business_date, merchant_ref, type, amount, fee, approved_at, ingested_run_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) ON CONFLICT (acquirer_ref) DO NOTHING`,
          [line.acquirer_ref, acquirer, date, line.merchant_ref, line.type, line.amount, line.fee, line.approved_at, runId],
        );
        if (ins.rowCount) newLines.push(line);
      }

      const lines = await this.db.many<AcquirerLine & { fee: number }>(
        `SELECT acquirer_ref, merchant_ref, amount, fee, ingested_at, exception_raised FROM acquirer_report_lines
         WHERE acquirer = $1 AND matched_item_id IS NULL FOR UPDATE`,
        [acquirer],
        c,
      );
      const items = await this.db.many<PlatformItem & { merchant_id: string; net: number }>(
        `SELECT id, merchant_id, merchant_ref, amount, net, recon_status, occurred_at FROM settlement_items
         WHERE acquirer = $1 AND recon_status IN ('unreconciled', 'missing_in_acquirer')
           AND (merchant_ref = ANY($2) OR (occurred_at >= $3 AND occurred_at < $4))
         FOR UPDATE`,
        [acquirer, lines.map((l) => l.merchant_ref), start, end],
        c,
      );

      const result = reconcile(items, lines, { start, end, graceMs: RECON_GRACE_MS, now: new Date() });

      for (const { item, line } of result.matched) {
        await c.query(`UPDATE settlement_items SET recon_status = 'matched', recon_run_id = $2 WHERE id = $1`, [item.id, runId]);
        await c.query(`UPDATE acquirer_report_lines SET matched_item_id = $2 WHERE acquirer_ref = $1`, [line.acquirer_ref, item.id]);
      }
      for (const { item, line } of result.mismatched) {
        await c.query(`UPDATE settlement_items SET recon_status = 'mismatch', recon_run_id = $2 WHERE id = $1`, [item.id, runId]);
        await c.query(`UPDATE acquirer_report_lines SET matched_item_id = $2, exception_raised = true WHERE acquirer_ref = $1`, [line.acquirer_ref, item.id]);
      }
      for (const item of result.missingInAcquirer) {
        await c.query(`UPDATE settlement_items SET recon_status = 'missing_in_acquirer', recon_run_id = $2 WHERE id = $1`, [item.id, runId]);
      }
      for (const line of result.missingInPlatform) {
        await c.query(`UPDATE acquirer_report_lines SET exception_raised = true WHERE acquirer_ref = $1`, [line.acquirer_ref]);
      }

      const gross = newLines.filter((l) => l.type !== 'refund').reduce((s, l) => s + l.amount, 0);
      const refunds = newLines.filter((l) => l.type === 'refund').reduce((s, l) => s + l.amount, 0);
      const fees = newLines.reduce((s, l) => s + l.fee, 0);
      const net = gross - refunds - fees;

      await c.query(
        `INSERT INTO recon_runs (id, acquirer, business_date, lines_ingested, matched, mismatched, missing_in_acquirer, missing_in_platform,
                                 platform_amount, acquirer_amount, net_settlement)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [
          runId,
          acquirer,
          date,
          newLines.length,
          result.matched.length,
          result.mismatched.length,
          result.missingInAcquirer.length,
          result.missingInPlatform.length,
          [...result.matched, ...result.mismatched].reduce((s, m) => s + m.item.amount, 0),
          [...result.matched, ...result.mismatched].reduce((s, m) => s + m.line.amount, 0),
          net,
        ],
      );
      await this.recordExceptions(c, runId, result, items);

      if (newLines.length) {
        const internal: AcquirerSettlementInternal = {
          run_id: runId,
          acquirer,
          business_date: date,
          gross_amount: gross,
          refund_amount: refunds,
          acquirer_fees: fees,
          net_amount: net,
        };
        await enqueueEvent(c, Topics.settlements, acquirer, buildEvent(EventTypes.acquirerSettlementReceived, null, { id: runId, acquirer, business_date: date }, { ...internal }));
      }

      const summary = {
        run_id: runId,
        acquirer,
        business_date: date,
        lines_ingested: newLines.length,
        matched: result.matched.length,
        mismatched: result.mismatched.length,
        missing_in_acquirer: result.missingInAcquirer.length,
        missing_in_platform: result.missingInPlatform.length,
        net_settlement: net,
      };
      if (result.mismatched.length || result.missingInAcquirer.length || result.missingInPlatform.length) {
        this.logger.warn(`Reconciliation exceptions for ${acquirer} ${date}: ${JSON.stringify(summary)}`);
      }
      return summary;
    });
  }

  private async recordExceptions(c: PoolClient, runId: string, result: ReturnType<typeof reconcile>, items: Array<PlatformItem & { merchant_id: string }>) {
    const merchantOf = new Map(items.map((i) => [i.id, i.merchant_id]));
    const insert = (type: string, row: { merchant_id?: string | null; merchant_ref?: string; acquirer_ref?: string; item_id?: string; platform?: number | null; acquirer?: number | null; details: string }) => {
      reconExceptions.inc({ type });
      return c.query(
        `INSERT INTO recon_exceptions (run_id, type, merchant_id, merchant_ref, acquirer_ref, settlement_item_id, platform_amount, acquirer_amount, details)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [runId, type, row.merchant_id ?? null, row.merchant_ref ?? null, row.acquirer_ref ?? null, row.item_id ?? null, row.platform ?? null, row.acquirer ?? null, row.details],
      );
    };
    for (const { item, line } of result.mismatched) {
      await insert('amount_mismatch', {
        merchant_id: merchantOf.get(item.id),
        merchant_ref: item.merchant_ref,
        acquirer_ref: line.acquirer_ref,
        item_id: item.id,
        platform: item.amount,
        acquirer: line.amount,
        details: `Acquirer reported ${line.amount} but we recorded ${item.amount} (difference ${line.amount - item.amount} paise). Payout held.`,
      });
    }
    for (const item of result.missingInAcquirer) {
      await insert('missing_in_acquirer', {
        merchant_id: merchantOf.get(item.id),
        merchant_ref: item.merchant_ref,
        item_id: item.id,
        platform: item.amount,
        details: 'We captured this payment but it is absent from the acquirer settlement file. Payout held pending investigation.',
      });
    }
    for (const line of result.missingInPlatform) {
      await insert('missing_in_platform', {
        merchant_ref: line.merchant_ref,
        acquirer_ref: line.acquirer_ref,
        acquirer: line.amount,
        details: 'Acquirer settled a transaction we have no successful record of (e.g. a late approval after a timeout). Needs refund or manual capture.',
      });
    }
  }

  // ------------------------------------------------------------------ payouts

  /** Pays each merchant the net of their reconciled, unpaid items. Mismatched items stay on hold. */
  async runPayouts() {
    const merchants = await this.db.many<{ merchant_id: string }>(
      `SELECT DISTINCT merchant_id FROM settlement_items WHERE recon_status = 'matched' AND payout_id IS NULL`,
    );
    const results = [];
    for (const { merchant_id } of merchants) {
      let merchant: MerchantInfo;
      try {
        merchant = await callService<MerchantInfo>(config.services.merchant, `/internal/merchants/${merchant_id}`);
      } catch (err) {
        results.push({ merchant_id, status: 'skipped', reason: `merchant lookup failed: ${(err as Error).message}` });
        continue;
      }
      if (merchant.kyc_status !== 'approved' || !merchant.settlement_account) {
        results.push({ merchant_id, status: 'on_hold', reason: 'KYC not approved' });
        continue;
      }
      results.push(await this.payMerchant(merchant));
    }
    return results;
  }

  private async payMerchant(merchant: MerchantInfo) {
    return this.db.tx(async (c) => {
      const items = await this.db.many<{ id: string; net: number }>(
        `SELECT id, net FROM settlement_items WHERE merchant_id = $1 AND recon_status = 'matched' AND payout_id IS NULL FOR UPDATE`,
        [merchant.id],
        c,
      );
      const amount = items.reduce((s, i) => s + i.net, 0);
      if (amount <= 0) {
        return { merchant_id: merchant.id, status: 'carried_forward', reason: 'net amount is not positive', amount };
      }
      const payoutId = newId(IdPrefix.payout);
      const utr = `PFUTR${Math.floor(Math.random() * 1e12).toString().padStart(12, '0')}`;
      const payout = await this.db.one<{ id: string; amount: number; created_at: Date; paid_at: Date }>(
        `INSERT INTO payouts (id, merchant_id, amount, item_count, status, utr, destination, paid_at)
         VALUES ($1, $2, $3, $4, 'paid', $5, $6::jsonb, now()) RETURNING *`,
        [payoutId, merchant.id, amount, items.length, utr, JSON.stringify(merchant.settlement_account)],
        c,
      );
      await c.query('UPDATE settlement_items SET payout_id = $1 WHERE id = ANY($2)', [payoutId, items.map((i) => i.id)]);
      const view = this.payoutView({ ...payout!, merchant_id: merchant.id, item_count: items.length, status: 'paid', utr, destination: merchant.settlement_account });
      const internal: PayoutPaidInternal = { payout_id: payoutId, amount };
      await enqueueEvent(c, Topics.settlements, merchant.id, buildEvent(EventTypes.payoutPaid, merchant.id, view, { ...internal }));
      payoutsPaid.inc();
      this.logger.log(`Paid ${merchant.id} ${amount} paise (${items.length} items) UTR ${utr}`);
      return { merchant_id: merchant.id, status: 'paid', payout_id: payoutId, amount, items: items.length, utr };
    });
  }

  // ------------------------------------------------------------------ queries

  async listPayouts(merchantId: string) {
    const rows = await this.db.many('SELECT * FROM payouts WHERE merchant_id = $1 ORDER BY created_at DESC LIMIT 50', [merchantId]);
    return { object: 'list', data: rows.map((r) => this.payoutView(r as never)) };
  }

  async summary(merchantId: string) {
    const row = await this.db.one<Record<string, number>>(
      `SELECT COALESCE(SUM(net) FILTER (WHERE recon_status = 'unreconciled'), 0) AS pending_reconciliation,
              COALESCE(SUM(net) FILTER (WHERE recon_status = 'matched' AND payout_id IS NULL), 0) AS ready_for_payout,
              COALESCE(SUM(net) FILTER (WHERE recon_status IN ('mismatch', 'missing_in_acquirer')), 0) AS on_hold,
              COALESCE(SUM(net) FILTER (WHERE payout_id IS NOT NULL), 0) AS paid_out
       FROM settlement_items WHERE merchant_id = $1`,
      [merchantId],
    );
    return { object: 'settlement_summary', currency: 'INR', ...row };
  }

  async listItems(merchantId: string, reconStatus?: string, limit = 50) {
    const rows = await this.db.many(
      `SELECT id, type, payment_intent_id, merchant_ref, acquirer, amount, fee, gst, net, recon_status, payout_id, occurred_at
       FROM settlement_items WHERE merchant_id = $1 AND ($2::text IS NULL OR recon_status = $2)
       ORDER BY occurred_at DESC LIMIT $3`,
      [merchantId, reconStatus ?? null, limit],
    );
    return { object: 'list', data: rows };
  }

  async listRuns() {
    const rows = await this.db.many('SELECT * FROM recon_runs ORDER BY created_at DESC LIMIT 50');
    return { object: 'list', data: rows };
  }

  async getRun(merchantId: string, id: string) {
    const run = await this.db.one('SELECT * FROM recon_runs WHERE id = $1', [id]);
    if (!run) throw Errors.notFound('recon_run', id);
    // Exceptions are visible to the merchant they concern (or platform-level ones without a merchant).
    const exceptions = await this.db.many(
      `SELECT * FROM recon_exceptions WHERE run_id = $1 AND (merchant_id IS NULL OR merchant_id = $2) ORDER BY id`,
      [id, merchantId],
    );
    return { ...run, exceptions };
  }

  async listExceptions(merchantId: string) {
    const rows = await this.db.many(
      `SELECT e.*, r.acquirer, r.business_date FROM recon_exceptions e JOIN recon_runs r ON r.id = e.run_id
       WHERE e.merchant_id IS NULL OR e.merchant_id = $1 ORDER BY e.id DESC LIMIT 50`,
      [merchantId],
    );
    return { object: 'list', data: rows };
  }

  private payoutView(p: { id: string; merchant_id: string; amount: number; item_count: number; status: string; utr: string | null; destination: unknown; created_at: Date; paid_at: Date | null }) {
    return {
      id: p.id,
      object: 'payout',
      amount: p.amount,
      currency: 'INR',
      status: p.status,
      item_count: p.item_count,
      utr: p.utr,
      destination: p.destination,
      created_at: p.created_at,
      paid_at: p.paid_at,
    };
  }
}
