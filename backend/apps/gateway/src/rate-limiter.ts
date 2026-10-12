import { Inject, Injectable, Logger } from '@nestjs/common';
import { AuthType, envInt, REDIS, RedisClient } from '@app/common';

/**
 * Token bucket, executed atomically inside Redis (Lua) so every gateway instance shares
 * one limit per key with no race between "read tokens" and "write tokens".
 * Time comes from Redis (TIME) so clock skew between gateway hosts doesn't matter.
 */
const TOKEN_BUCKET_LUA = `
local key = KEYS[1]
local capacity = tonumber(ARGV[1])
local refill_per_sec = tonumber(ARGV[2])
local t = redis.call('TIME')
local now_ms = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
local data = redis.call('HMGET', key, 'tokens', 'ts')
local tokens = tonumber(data[1]) or capacity
local ts = tonumber(data[2]) or now_ms
tokens = math.min(capacity, tokens + math.max(0, now_ms - ts) / 1000 * refill_per_sec)
local allowed = 0
local retry_ms = 0
if tokens >= 1 then
  tokens = tokens - 1
  allowed = 1
else
  retry_ms = math.ceil((1 - tokens) / refill_per_sec * 1000)
end
redis.call('HSET', key, 'tokens', tokens, 'ts', now_ms)
redis.call('PEXPIRE', key, math.ceil(capacity / refill_per_sec * 1000) + 1000)
return { allowed, math.floor(tokens), retry_ms }
`;

export interface RatePolicy {
  capacity: number;
  refillPerSec: number;
}

export interface RateDecision {
  allowed: boolean;
  limit: number;
  remaining: number;
  retryAfterMs: number;
}

export const POLICIES: Record<AuthType | 'anonymous', RatePolicy> = {
  secret: { capacity: envInt('RATE_LIMIT_SECRET_BURST', 200), refillPerSec: envInt('RATE_LIMIT_SECRET_RPS', 100) },
  publishable: { capacity: envInt('RATE_LIMIT_PUBLISHABLE_BURST', 40), refillPerSec: envInt('RATE_LIMIT_PUBLISHABLE_RPS', 10) },
  dashboard: { capacity: envInt('RATE_LIMIT_DASHBOARD_BURST', 100), refillPerSec: envInt('RATE_LIMIT_DASHBOARD_RPS', 30) },
  internal: { capacity: 1_000, refillPerSec: 1_000 },
  // Signup/login: tight per-IP limit to slow down credential stuffing.
  anonymous: { capacity: envInt('RATE_LIMIT_ANON_BURST', 20), refillPerSec: 0.5 },
};

@Injectable()
export class RateLimiter {
  private readonly logger = new Logger('RateLimiter');
  private lastWarn = 0;

  constructor(@Inject(REDIS) private readonly redis: RedisClient) {}

  async consume(bucket: string, policy: RatePolicy): Promise<RateDecision> {
    try {
      const [allowed, remaining, retryMs] = (await this.redis.eval(
        TOKEN_BUCKET_LUA,
        1,
        `gw:rl:${bucket}`,
        policy.capacity,
        policy.refillPerSec,
      )) as [number, number, number];
      return { allowed: allowed === 1, limit: policy.capacity, remaining, retryAfterMs: retryMs };
    } catch (err) {
      // Fail open: a Redis outage should degrade rate limiting, not take payments down.
      if (Date.now() - this.lastWarn > 10_000) {
        this.lastWarn = Date.now();
        this.logger.warn(`Rate limiter unavailable, failing open: ${(err as Error).message}`);
      }
      return { allowed: true, limit: policy.capacity, remaining: policy.capacity, retryAfterMs: 0 };
    }
  }
}
