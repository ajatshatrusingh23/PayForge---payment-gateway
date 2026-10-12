import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { counter, Errors, histogram, IdPrefix, newId, randomString, REDIS, RedisClient } from '@app/common';
import { Db } from '@app/database';
import { DomainEvent, EventTypes, KafkaService, markProcessed, PaymentCapturedInternal, PaymentFailedInternal, Topics } from '@app/messaging';
import { AssessDto, CreateBlocklistDto } from './dto';
import { countsAsDecline, evaluate, RiskSignals, RULES, THRESHOLDS, VELOCITY_WINDOW_SECONDS } from './rules';

const DECLINE_WINDOW_SECONDS = 3_600;
const MIN_SAMPLES_FOR_AVERAGE = 20;

const decisions = counter('payforge_risk_decisions_total', 'Risk decisions', ['decision'] as const);
const assessLatency = histogram('payforge_risk_assess_seconds', 'Risk assessment latency', [], [0.002, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25]);

@Injectable()
export class RiskService implements OnModuleInit {
  private readonly logger = new Logger('RiskService');

  constructor(
    private readonly db: Db,
    @Inject(REDIS) private readonly redis: RedisClient,
    private readonly kafka: KafkaService,
  ) {}

  onModuleInit(): void {
    // Feedback loop: payment outcomes feed back into risk signals.
    this.kafka.subscribe('risk', [Topics.payments], (event) => this.onPaymentEvent(event));
  }

  async assess(dto: AssessDto) {
    const stop = assessLatency.startTimer();
    const started = Date.now();
    const signals = await this.gatherSignals(dto);
    const { score, decision, hits } = evaluate(signals);
    const latencyMs = Date.now() - started;
    const id = newId(IdPrefix.riskAssessment);
    await this.db.query(
      `INSERT INTO risk_assessments (id, merchant_id, payment_intent_id, score, decision, reasons, signals, latency_ms)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8)`,
      [id, dto.merchant_id, dto.payment_intent_id, score, decision, JSON.stringify(hits), JSON.stringify(signals), latencyMs],
    );
    decisions.inc({ decision });
    stop();
    return { id, object: 'risk_assessment', payment_intent_id: dto.payment_intent_id, score, decision, reasons: hits, latency_ms: latencyMs };
  }

  /** Velocity counters are Redis sorted sets (score = timestamp), i.e. exact sliding windows. */
  private async gatherSignals(dto: AssessDto): Promise<RiskSignals> {
    const now = Date.now();
    const windowStart = now - VELOCITY_WINDOW_SECONDS * 1_000;
    const member = `${dto.payment_intent_id}:${randomString(6)}`;
    const email = dto.email?.trim().toLowerCase();
    const keys = {
      instrument: `risk:vel:pm:${dto.fingerprint}`,
      ip: dto.ip ? `risk:vel:ip:${dto.ip}` : null,
      email: email ? `risk:vel:email:${email}` : null,
    };

    const multi = this.redis.multi();
    const order: Array<'instrument' | 'ip' | 'email'> = [];
    for (const name of ['instrument', 'ip', 'email'] as const) {
      const key = keys[name];
      if (!key) continue;
      order.push(name);
      multi.zremrangebyscore(key, 0, windowStart).zadd(key, now, member).zcard(key).expire(key, VELOCITY_WINDOW_SECONDS);
    }
    multi.get(`risk:declines:${dto.fingerprint}`);
    multi.hmget(`risk:amt:${dto.merchant_id}`, 'count', 'sum');
    const results = (await multi.exec()) ?? [];

    const counts: Record<string, number> = { instrument: 0, ip: 0, email: 0 };
    order.forEach((name, i) => {
      counts[name] = Number(results[i * 4 + 2]?.[1] ?? 0);
    });
    const declines = Number(results[order.length * 4]?.[1] ?? 0);
    const [countRaw, sumRaw] = (results[order.length * 4 + 1]?.[1] as Array<string | null>) ?? [];
    const samples = Number(countRaw ?? 0);
    const average = samples >= MIN_SAMPLES_FOR_AVERAGE ? Number(sumRaw ?? 0) / samples : null;

    const blocked = await this.db.many<{ type: string }>(
      `SELECT type FROM blocklist WHERE merchant_id = $1 AND (
         (type = 'fingerprint' AND value = $2) OR (type = 'email' AND value = $3) OR
         (type = 'ip' AND value = $4) OR (type = 'vpa' AND value = $5))`,
      [dto.merchant_id, dto.fingerprint, email ?? null, dto.ip ?? null, dto.vpa?.toLowerCase() ?? null],
    );

    return {
      amount: dto.amount,
      currency: dto.currency,
      paymentMethodType: dto.payment_method_type,
      cardCountry: dto.card_country ?? null,
      email: email ?? null,
      instrumentAttempts: counts.instrument,
      ipAttempts: counts.ip,
      emailAttempts: counts.email,
      recentDeclines: declines,
      merchantAverageAmount: average,
      blocklistHits: blocked.map((b) => b.type),
    };
  }

  private async onPaymentEvent(event: DomainEvent): Promise<void> {
    if (event.type !== EventTypes.paymentFailed && event.type !== EventTypes.paymentCaptured) return;
    await this.db.tx(async (c) => {
      if (!(await markProcessed(c, 'risk', event.id))) return;
      if (event.type === EventTypes.paymentFailed) {
        const internal = (event.internal ?? {}) as PaymentFailedInternal;
        if (!internal.fingerprint || !countsAsDecline(internal)) return;
        const key = `risk:declines:${internal.fingerprint}`;
        await this.redis.multi().incr(key).expire(key, DECLINE_WINDOW_SECONDS).exec();
      } else if (event.merchant_id) {
        const internal = event.internal as unknown as PaymentCapturedInternal;
        await this.redis
          .multi()
          .hincrby(`risk:amt:${event.merchant_id}`, 'count', 1)
          .hincrby(`risk:amt:${event.merchant_id}`, 'sum', internal.amount)
          .exec();
      }
    });
  }

  async listAssessments(merchantId: string, paymentIntentId?: string) {
    const rows = await this.db.many(
      `SELECT id, payment_intent_id, score, decision, reasons, latency_ms, created_at FROM risk_assessments
       WHERE merchant_id = $1 AND ($2::text IS NULL OR payment_intent_id = $2)
       ORDER BY created_at DESC LIMIT 50`,
      [merchantId, paymentIntentId ?? null],
    );
    return { object: 'list', data: rows.map((r) => ({ object: 'risk_assessment', ...r })) };
  }

  async listBlocklist(merchantId: string) {
    const rows = await this.db.many('SELECT * FROM blocklist WHERE merchant_id = $1 ORDER BY created_at DESC', [merchantId]);
    return { object: 'list', data: rows.map(({ merchant_id: _m, ...r }) => ({ object: 'blocklist_entry', ...r })) };
  }

  async addToBlocklist(merchantId: string, dto: CreateBlocklistDto) {
    const value = dto.type === 'email' || dto.type === 'vpa' ? dto.value.trim().toLowerCase() : dto.value.trim();
    const row = await this.db.one(
      `INSERT INTO blocklist (id, merchant_id, type, value, reason) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (merchant_id, type, value) DO UPDATE SET reason = EXCLUDED.reason
       RETURNING id, type, value, reason, created_at`,
      [newId(IdPrefix.blocklist, 16), merchantId, dto.type, value, dto.reason ?? null],
    );
    return { object: 'blocklist_entry', ...row };
  }

  async removeFromBlocklist(merchantId: string, id: string) {
    const res = await this.db.query('DELETE FROM blocklist WHERE id = $1 AND merchant_id = $2', [id, merchantId]);
    if (!res.rowCount) throw Errors.notFound('blocklist_entry', id);
    return { id, deleted: true };
  }

  rules() {
    return {
      thresholds: THRESHOLDS,
      velocity_window_seconds: VELOCITY_WINDOW_SECONDS,
      rules: RULES.map((r) => ({ id: r.id, description: r.description })),
    };
  }
}
