import { Inject, Injectable, Logger } from '@nestjs/common';
import { ACQUIRER_CODES, ACQUIRERS, PaymentMethodType, REDIS, RedisClient } from '@app/common';
import { AcquirerClient } from '../acquirers/acquirer.client';
import { Candidate, healthScore, rankCandidates, RoutingStrategy, smoothedSuccessRate } from './scoring';

const STATS_WINDOW_MS = 5 * 60_000;
const STATS_MAX_ENTRIES = 200;
const DEFAULT_LATENCY_MS = 300;
const EPSILON = parseFloat(process.env.ROUTING_EPSILON ?? '0.05');

/**
 * Picks the order in which acquirers are tried. Live stats are kept in Redis
 * (shared by all payment-service instances) as a capped list of recent outcomes.
 */
@Injectable()
export class RouterService {
  private readonly logger = new Logger('Router');
  private strategy: RoutingStrategy = process.env.ROUTING_STRATEGY === 'single' ? 'single' : 'smart';

  constructor(
    @Inject(REDIS) private readonly redis: RedisClient,
    private readonly acquirers: AcquirerClient,
  ) {}

  getStrategy(): RoutingStrategy {
    return this.strategy;
  }

  setStrategy(strategy: RoutingStrategy): void {
    this.logger.warn(`Routing strategy changed: ${this.strategy} -> ${strategy}`);
    this.strategy = strategy;
  }

  /** Demo/testing: forget all routing history so every acquirer starts from the prior again. */
  async resetStats(): Promise<void> {
    const keys = ACQUIRER_CODES.flatMap((code) => [`route:stats:${code}:card`, `route:stats:${code}:upi`]);
    await this.redis.del(...keys);
  }

  async rank(method: PaymentMethodType): Promise<string[]> {
    const candidates = await this.candidates(method);
    return rankCandidates(candidates, this.strategy, EPSILON);
  }

  /** ok = the acquirer gave a definitive answer (approve/decline/OTP/pending). Declines are not the acquirer's fault. */
  async record(acquirer: string, method: PaymentMethodType, ok: boolean, latencyMs: number): Promise<void> {
    const key = `route:stats:${acquirer}:${method}`;
    await this.redis
      .multi()
      .lpush(key, `${Date.now()}:${ok ? 1 : 0}:${Math.round(latencyMs)}`)
      .ltrim(key, 0, STATS_MAX_ENTRIES - 1)
      .expire(key, 3_600)
      .exec()
      .catch(() => undefined);
  }

  async health() {
    const methods: PaymentMethodType[] = ['card', 'upi'];
    const byMethod = await Promise.all(methods.map(async (m) => [m, await this.candidates(m)] as const));
    return {
      object: 'routing_health',
      strategy: this.strategy,
      exploration_rate: EPSILON,
      acquirers: ACQUIRER_CODES.map((code) => ({
        code,
        name: ACQUIRERS[code].name,
        cost_bps: ACQUIRERS[code].costBps,
        circuit: this.acquirers.state(code),
        methods: Object.fromEntries(
          byMethod
            .map(([method, list]) => [method, list.find((c) => c.code === code)] as const)
            .filter(([, c]) => c !== undefined)
            .map(([method, c]) => [
              method,
              {
                samples: c!.samples,
                success_rate: Number(smoothedSuccessRate(c!).toFixed(4)),
                avg_latency_ms: Math.round(c!.avgLatencyMs),
                score: Number(healthScore(c!).toFixed(4)),
              },
            ]),
        ),
      })),
    };
  }

  private async candidates(method: PaymentMethodType): Promise<Candidate[]> {
    const codes = ACQUIRER_CODES.filter((c) => ACQUIRERS[c].methods.includes(method));
    let lists: string[][] = codes.map(() => []);
    try {
      const pipeline = this.redis.pipeline();
      codes.forEach((code) => pipeline.lrange(`route:stats:${code}:${method}`, 0, STATS_MAX_ENTRIES - 1));
      const results = (await pipeline.exec()) ?? [];
      lists = results.map(([, value]) => (value as string[]) ?? []);
    } catch {
      // Redis unavailable: route on priors alone rather than failing payments.
    }
    const cutoff = Date.now() - STATS_WINDOW_MS;
    return codes.map((code, i) => {
      let successes = 0;
      let samples = 0;
      let latencyTotal = 0;
      for (const entry of lists[i]) {
        const [ts, ok, latency] = entry.split(':').map(Number);
        if (ts < cutoff) continue;
        samples++;
        successes += ok;
        // Only successful calls count towards latency: an acquirer that fails fast must not look "faster".
        if (ok) latencyTotal += latency;
      }
      return {
        code,
        costBps: ACQUIRERS[code].costBps,
        circuit: this.acquirers.state(code),
        successes,
        samples,
        avgLatencyMs: successes ? latencyTotal / successes : DEFAULT_LATENCY_MS,
      };
    });
  }
}
