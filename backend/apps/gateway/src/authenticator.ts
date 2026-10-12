import { Inject, Injectable } from '@nestjs/common';
import {
  API_KEY_CACHE_PREFIX,
  AuthType,
  callService,
  config,
  Errors,
  REDIS,
  RedisClient,
  ServiceCallError,
  sha256,
  verifyDashboardToken,
} from '@app/common';

export interface Principal {
  merchantId: string;
  type: AuthType;
}

const POSITIVE_TTL_SECONDS = 60;
const NEGATIVE_TTL_SECONDS = 10;

/**
 * Resolves the Authorization header to a merchant:
 *  - `Bearer sk_test_...` / `Bearer pk_test_...`: API keys (verified by the merchant service, cached in Redis)
 *  - `Basic base64(sk_test_...:)`: curl -u style, like Stripe
 *  - `Bearer <jwt>`: dashboard session
 */
@Injectable()
export class Authenticator {
  constructor(@Inject(REDIS) private readonly redis: RedisClient) {}

  async authenticate(header: string | undefined): Promise<Principal> {
    if (!header) {
      throw Errors.unauthorized('You did not provide an API key. Use "Authorization: Bearer sk_test_..." (or pk_test_ from browsers).');
    }
    let token: string;
    if (header.startsWith('Bearer ')) token = header.slice(7).trim();
    else if (header.startsWith('Basic ')) token = Buffer.from(header.slice(6), 'base64').toString('utf8').split(':')[0];
    else throw Errors.unauthorized('Unsupported Authorization scheme. Use Bearer.');

    if (/^(sk|pk)_/.test(token)) return this.apiKey(token);

    const claims = verifyDashboardToken(token);
    if (!claims) throw Errors.unauthorized('Invalid or expired session. Please log in again.');
    return { merchantId: claims.sub, type: 'dashboard' };
  }

  private async apiKey(key: string): Promise<Principal> {
    const cacheKey = `${API_KEY_CACHE_PREFIX}${sha256(key)}`;
    const cached = await this.redis.get(cacheKey).catch(() => null);
    if (cached === 'invalid') throw Errors.unauthorized(`Invalid API key provided: ${mask(key)}`);
    if (cached) return JSON.parse(cached) as Principal;

    try {
      const res = await callService<{ merchant_id: string; key_type: 'secret' | 'publishable' }>(
        config.services.merchant,
        '/internal/auth/api-key',
        { body: { key }, timeoutMs: 3_000 },
      );
      const principal: Principal = { merchantId: res.merchant_id, type: res.key_type };
      await this.redis.set(cacheKey, JSON.stringify(principal), 'EX', POSITIVE_TTL_SECONDS).catch(() => undefined);
      return principal;
    } catch (err) {
      if (err instanceof ServiceCallError && err.status === 401) {
        // Negative caching blunts brute-force key guessing against the merchant service.
        await this.redis.set(cacheKey, 'invalid', 'EX', NEGATIVE_TTL_SECONDS).catch(() => undefined);
        throw Errors.unauthorized(`Invalid API key provided: ${mask(key)}`);
      }
      throw Errors.unavailable('Authentication is temporarily unavailable. Please retry.');
    }
  }
}

function mask(key: string): string {
  return key.length > 12 ? `${key.slice(0, 8)}${'*'.repeat(8)}${key.slice(-4)}` : '***';
}
