import { Controller, DynamicModule, Get, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AuthGuard, Open } from './auth';
import { MetricsController } from './metrics';

const startedAt = Date.now();
let serviceName = 'unknown';

@Controller()
class HealthController {
  @Open()
  @Get('health')
  health() {
    return { status: 'ok', service: serviceName, uptime_seconds: Math.round((Date.now() - startedAt) / 1000) };
  }
}

/**
 * Cross-cutting pieces every service gets: /health, /metrics and the global AuthGuard
 * (deny-by-default: an endpoint is internal-only unless it opts in with @Auth()).
 */
@Module({})
export class CommonModule {
  static forService(name: string): DynamicModule {
    serviceName = name;
    return {
      module: CommonModule,
      controllers: [HealthController, MetricsController],
      providers: [{ provide: APP_GUARD, useClass: AuthGuard }],
    };
  }
}
