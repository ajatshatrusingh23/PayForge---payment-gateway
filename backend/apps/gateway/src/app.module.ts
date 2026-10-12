import { Module } from '@nestjs/common';
import { CommonModule, RedisModule } from '@app/common';
import { Authenticator } from './authenticator';
import { GatewayProxy } from './proxy';
import { RateLimiter } from './rate-limiter';

@Module({
  imports: [CommonModule.forService('gateway'), RedisModule],
  providers: [Authenticator, RateLimiter, GatewayProxy],
})
export class AppModule {}
