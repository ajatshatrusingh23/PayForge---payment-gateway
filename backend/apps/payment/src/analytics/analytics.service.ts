import { Injectable } from '@nestjs/common';
import { Db } from '@app/database';

const SUCCESS = `status IN ('authorized', 'captured', 'partially_refunded', 'refunded')`;

@Injectable()
export class AnalyticsService {
  constructor(private readonly db: Db) {}

  /** Dashboard KPIs. Success rate = succeeded / (succeeded + failed), i.e. over payments that reached an outcome. */
  async summary(merchantId: string, days: number) {
    const params = [merchantId, days];
    const window = `merchant_id = $1 AND created_at >= now() - make_interval(days => $2)`;

    const [totals, daily, byMethod, byAcquirer, declines] = await Promise.all([
      this.db.one<{
        attempted: number;
        succeeded: number;
        failed: number;
        gross_volume: number;
        refunded_volume: number;
        fees: number;
        avg_ticket: number;
      }>(
        `SELECT count(*) FILTER (WHERE status NOT IN ('created', 'canceled', 'expired')) AS attempted,
                count(*) FILTER (WHERE ${SUCCESS}) AS succeeded,
                count(*) FILTER (WHERE status = 'failed') AS failed,
                COALESCE(sum(amount_received), 0) AS gross_volume,
                COALESCE(sum(amount_refunded), 0) AS refunded_volume,
                COALESCE(sum(fee + gst), 0) AS fees,
                COALESCE(round(avg(amount_received) FILTER (WHERE amount_received > 0)), 0) AS avg_ticket
         FROM payment_intents WHERE ${window}`,
        params,
      ),
      this.db.many<{ day: string; succeeded: number; failed: number; volume: number }>(
        `SELECT to_char(date_trunc('day', created_at AT TIME ZONE 'Asia/Kolkata'), 'YYYY-MM-DD') AS day,
                count(*) FILTER (WHERE ${SUCCESS}) AS succeeded,
                count(*) FILTER (WHERE status = 'failed') AS failed,
                COALESCE(sum(amount_received), 0) AS volume
         FROM payment_intents WHERE ${window}
         GROUP BY 1 ORDER BY 1`,
        params,
      ),
      this.db.many<{ method: string; attempted: number; succeeded: number; volume: number }>(
        `SELECT payment_method_type AS method,
                count(*) AS attempted,
                count(*) FILTER (WHERE ${SUCCESS}) AS succeeded,
                COALESCE(sum(amount_received), 0) AS volume
         FROM payment_intents WHERE ${window} AND payment_method_type IS NOT NULL
         GROUP BY 1 ORDER BY 2 DESC`,
        params,
      ),
      this.db.many<{ acquirer: string; attempts: number; approved: number; declined: number; technical_failures: number; timeouts: number; avg_latency_ms: number }>(
        `SELECT acquirer,
                count(*) AS attempts,
                count(*) FILTER (WHERE status = 'approved') AS approved,
                count(*) FILTER (WHERE status = 'declined') AS declined,
                count(*) FILTER (WHERE status = 'technical_failure') AS technical_failures,
                count(*) FILTER (WHERE status IN ('unknown', 'not_found')) AS timeouts,
                COALESCE(round(avg(latency_ms)), 0) AS avg_latency_ms
         FROM payment_attempts WHERE ${window}
         GROUP BY 1 ORDER BY 2 DESC`,
        params,
      ),
      this.db.many<{ code: string; count: number }>(
        `SELECT COALESCE(last_payment_error->>'decline_code', last_payment_error->>'code') AS code, count(*) AS count
         FROM payment_intents WHERE ${window} AND status = 'failed'
         GROUP BY 1 ORDER BY 2 DESC LIMIT 5`,
        params,
      ),
    ]);

    const t = totals!;
    const decided = t.succeeded + t.failed;
    return {
      object: 'analytics_summary',
      days,
      totals: {
        attempted: t.attempted,
        succeeded: t.succeeded,
        failed: t.failed,
        success_rate: decided ? Number((t.succeeded / decided).toFixed(4)) : null,
        gross_volume: t.gross_volume,
        refunded_volume: t.refunded_volume,
        fees: t.fees,
        net_volume: t.gross_volume - t.refunded_volume - t.fees,
        average_ticket: t.avg_ticket,
      },
      daily: fillDays(daily, days),
      by_method: byMethod.map((m) => ({ ...m, success_rate: m.attempted ? Number((m.succeeded / m.attempted).toFixed(4)) : null })),
      by_acquirer: byAcquirer,
      top_decline_codes: declines,
    };
  }
}

/** Returns one row per day (IST), including days with no payments. */
function fillDays(rows: Array<{ day: string; succeeded: number; failed: number; volume: number }>, days: number) {
  const byDay = new Map(rows.map((r) => [r.day, r]));
  const out = [];
  const istNow = new Date(Date.now() + 5.5 * 3_600_000);
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(istNow.getTime() - i * 86_400_000).toISOString().slice(0, 10);
    out.push(byDay.get(d) ?? { day: d, succeeded: 0, failed: 0, volume: 0 });
  }
  return out;
}
