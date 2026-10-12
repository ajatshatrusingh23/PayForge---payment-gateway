import { Global, Inject, Logger, Module, OnModuleDestroy } from '@nestjs/common';
import Redis from 'ioredis';
import { config } from './config';

export const REDIS = Symbol('REDIS');
export type RedisClient = Redis;

@Global()
@Module({
  providers: [
    {
      provide: REDIS,
      useFactory: () => {
        const logger = new Logger('Redis');
        const client = new Redis(config.redisUrl, {
          maxRetriesPerRequest: 2,
          enableReadyCheck: true,
          lazyConnect: false,
        });
        client.on('error', (err) => logger.warn(`Redis error: ${err.message}`));
        return client;
      },
    },
  ],
  exports: [REDIS],
})
export class RedisModule implements OnModuleDestroy {
  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  async onModuleDestroy(): Promise<void> {
    await this.redis.quit().catch(() => undefined);
  }
}

/** Gateway caches API-key lookups under `${API_KEY_CACHE_PREFIX}${sha256(key)}`; the merchant service evicts on revoke. */
export const API_KEY_CACHE_PREFIX = 'gw:key:';
