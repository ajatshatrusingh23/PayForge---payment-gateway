import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsBoolean, IsInt, IsNumber, IsOptional, Max, Min } from 'class-validator';
import { AcquirerPaymentRequest, Auth, Errors } from '@app/common';
import { AcquirerRuntime, AcquirerState } from './acquirer-state';
import { SimulatorService } from './simulator.service';

/** The acquirer-facing API that PayForge's payment service talks to (internal only). */
@ApiTags('Acquirer API (simulated)')
@Controller('acquirers/:acquirer')
export class AcquirerController {
  constructor(private readonly sim: SimulatorService) {}

  @Post('payments')
  @HttpCode(200)
  authorize(@Param('acquirer') acquirer: string, @Body() body: AcquirerPaymentRequest) {
    return this.sim.authorize(acquirer, body);
  }

  @Get('payments')
  byMerchantRef(@Param('acquirer') acquirer: string, @Query('merchant_ref') merchantRef?: string) {
    if (!merchantRef) throw Errors.invalid('merchant_ref is required', 'merchant_ref');
    return this.sim.getByMerchantRef(acquirer, merchantRef);
  }

  @Post('payments/:id/otp')
  @HttpCode(200)
  otp(@Param('acquirer') acquirer: string, @Param('id') id: string, @Body() body: { otp?: string }) {
    return this.sim.verifyOtp(acquirer, id, String(body?.otp ?? ''));
  }

  @Post('payments/:id/capture')
  @HttpCode(200)
  capture(@Param('acquirer') acquirer: string, @Param('id') id: string, @Body() body: { amount: number }) {
    return this.sim.capture(acquirer, id, body?.amount);
  }

  @Post('payments/:id/void')
  @HttpCode(200)
  void(@Param('acquirer') acquirer: string, @Param('id') id: string) {
    return this.sim.void(acquirer, id);
  }

  @Post('refunds')
  @HttpCode(200)
  refund(@Param('acquirer') acquirer: string, @Body() body: { merchant_ref: string; payment_id: string; amount: number }) {
    return this.sim.refund(acquirer, body);
  }

  @Get('settlement-report')
  report(@Param('acquirer') acquirer: string, @Query('date') date: string) {
    return this.sim.settlementReport(acquirer, date);
  }
}

class UpdateAcquirerDto {
  @IsOptional()
  @IsBoolean()
  down?: boolean;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(30_000)
  latency_ms?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @Max(1)
  technical_failure_rate?: number;

  @IsOptional()
  @IsBoolean()
  inject_discrepancy?: boolean;
}

/** Chaos-engineering controls, exposed to the dashboard's Ops page in demo mode. */
@ApiTags('Chaos controls')
@Controller('admin')
export class AdminController {
  constructor(private readonly state: AcquirerState) {}

  @Auth('dashboard', 'internal')
  @Get('acquirers')
  list() {
    return { object: 'list', data: this.state.all().map(toView) };
  }

  @Auth('dashboard', 'internal')
  @Patch('acquirers/:acquirer')
  update(@Param('acquirer') acquirer: string, @Body() dto: UpdateAcquirerDto) {
    return toView(
      this.state.update(acquirer, {
        down: dto.down,
        latencyMs: dto.latency_ms,
        technicalFailureRate: dto.technical_failure_rate,
        injectDiscrepancy: dto.inject_discrepancy,
      }),
    );
  }

  @Auth('dashboard', 'internal')
  @Post('reset')
  @HttpCode(200)
  reset() {
    this.state.reset();
    return this.list();
  }
}

function toView(a: AcquirerRuntime) {
  return {
    code: a.code,
    name: a.name,
    methods: a.methods,
    cost_bps: a.costBps,
    latency_ms: a.latencyMs,
    jitter_ms: a.jitterMs,
    technical_failure_rate: a.technicalFailureRate,
    down: a.down,
    inject_discrepancy: a.injectDiscrepancy,
    stats: {
      requests: a.stats.requests,
      approved: a.stats.approved,
      declined: a.stats.declined,
      pending: a.stats.pending,
      technical_failures: a.stats.technicalFailures,
      rejected_while_down: a.stats.rejectedWhileDown,
    },
  };
}
