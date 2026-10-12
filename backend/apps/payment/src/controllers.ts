import { Body, Controller, Get, Headers, HttpCode, Param, Post, Query, Req } from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import {
  AcquirerPaymentResponse,
  Auth,
  BANK_SIGNATURE_HEADER,
  bankCallbackSecret,
  config,
  Ctx,
  Errors,
  hmacSha256,
  Open,
  RequestContext,
  safeEqual,
} from '@app/common';
import { Idempotent } from '@app/database';
import { AnalyticsService } from './analytics/analytics.service';
import {
  AnalyticsQueryDto,
  CancelDto,
  CaptureDto,
  ConfirmPaymentIntentDto,
  CreatePaymentIntentDto,
  CreateRefundDto,
  ListPaymentIntentsDto,
  ListRefundsDto,
  RetrieveQueryDto,
  RoutingStrategyDto,
  VerifyOtpDto,
} from './dto';
import { OutcomeService } from './payments/outcome.service';
import { PaymentRepository } from './payments/payment.repository';
import { PaymentsService } from './payments/payments.service';
import { RefundsService } from './refunds/refunds.service';
import { RouterService } from './routing/router.service';

@ApiTags('Payment intents')
@Controller('v1/payment_intents')
export class PaymentIntentsController {
  constructor(private readonly payments: PaymentsService) {}

  @Auth('secret')
  @Idempotent()
  @Post()
  create(@Ctx() ctx: RequestContext, @Body() dto: CreatePaymentIntentDto) {
    return this.payments.create(ctx, dto);
  }

  @Auth('secret', 'dashboard')
  @Get()
  list(@Ctx() ctx: RequestContext, @Query() q: ListPaymentIntentsDto) {
    return this.payments.list(ctx, q);
  }

  @Auth('secret', 'dashboard', 'publishable')
  @Get(':id')
  retrieve(@Ctx() ctx: RequestContext, @Param('id') id: string, @Query() q: RetrieveQueryDto) {
    return this.payments.retrieve(ctx, id, q.client_secret);
  }

  @Auth('secret', 'dashboard')
  @Get(':id/timeline')
  timeline(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.payments.timeline(ctx, id);
  }

  @Auth('secret', 'publishable')
  @Idempotent()
  @Post(':id/confirm')
  @HttpCode(200)
  confirm(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() dto: ConfirmPaymentIntentDto) {
    return this.payments.confirm(ctx, id, dto);
  }

  @Auth('secret', 'publishable')
  @Post(':id/otp')
  @HttpCode(200)
  otp(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() dto: VerifyOtpDto) {
    return this.payments.verifyOtp(ctx, id, dto);
  }

  @Auth('secret', 'dashboard')
  @Idempotent()
  @Post(':id/capture')
  @HttpCode(200)
  capture(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() dto: CaptureDto) {
    return this.payments.capture(ctx, id, dto);
  }

  @Auth('secret', 'dashboard')
  @Idempotent()
  @Post(':id/cancel')
  @HttpCode(200)
  cancel(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() dto: CancelDto) {
    return this.payments.cancel(ctx, id, dto);
  }
}

@ApiTags('Refunds')
@Controller('v1/refunds')
export class RefundsController {
  constructor(private readonly refunds: RefundsService) {}

  @Auth('secret', 'dashboard')
  @Idempotent()
  @Post()
  create(@Ctx() ctx: RequestContext, @Body() dto: CreateRefundDto) {
    return this.refunds.create(ctx, dto);
  }

  @Auth('secret', 'dashboard')
  @Get()
  list(@Ctx() ctx: RequestContext, @Query() q: ListRefundsDto) {
    return this.refunds.list(ctx, q);
  }

  @Auth('secret', 'dashboard')
  @Get(':id')
  retrieve(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.refunds.retrieve(ctx, id);
  }
}

@ApiTags('Analytics & routing')
@Controller('v1')
export class InsightsController {
  constructor(
    private readonly analytics: AnalyticsService,
    private readonly router: RouterService,
  ) {}

  @Auth('secret', 'dashboard')
  @Get('analytics/summary')
  summary(@Ctx() ctx: RequestContext, @Query() q: AnalyticsQueryDto) {
    return this.analytics.summary(ctx.merchantId, q.days ?? 7);
  }

  @Auth('secret', 'dashboard')
  @Get('routing/health')
  health() {
    return this.router.health();
  }

  /** Demo only: switch between smart routing and a naive single-acquirer setup to compare them live. */
  @Auth('dashboard')
  @Post('routing/strategy')
  @HttpCode(200)
  setStrategy(@Body() dto: RoutingStrategyDto) {
    if (!config.demoMode) throw Errors.forbidden('Routing strategy can only be changed in demo mode');
    this.router.setStrategy(dto.strategy);
    return this.router.health();
  }

  /** Demo only: clear routing statistics (e.g. before a live failover demo). */
  @Auth('dashboard')
  @Post('routing/reset')
  @HttpCode(200)
  async resetStats() {
    if (!config.demoMode) throw Errors.forbidden('Routing statistics can only be reset in demo mode');
    await this.router.resetStats();
    return this.router.health();
  }
}

/** Asynchronous notifications from acquirers (e.g. UPI collect approved). HMAC-verified. */
@ApiTags('Acquirer callbacks')
@Controller('internal/acquirer-callbacks')
export class AcquirerCallbacksController {
  constructor(
    private readonly repo: PaymentRepository,
    private readonly outcomes: OutcomeService,
  ) {}

  @Open()
  @Post(':acquirer')
  @HttpCode(200)
  async handle(
    @Param('acquirer') acquirer: string,
    @Req() req: RawBodyRequest<Request>,
    @Headers(BANK_SIGNATURE_HEADER) signature?: string,
  ) {
    const raw = req.rawBody?.toString('utf8') ?? '';
    if (!signature || !safeEqual(hmacSha256(bankCallbackSecret(), raw), signature)) {
      throw Errors.unauthorized('Invalid acquirer signature');
    }
    const body = JSON.parse(raw) as AcquirerPaymentResponse;
    const attempt = await this.repo.findAttempt(body.merchant_ref);
    if (!attempt || attempt.acquirer !== acquirer) throw Errors.notFound('payment_attempt', body.merchant_ref);
    if (body.status !== 'pending') await this.outcomes.applyAcquirerResponse(attempt.id, body);
    return { received: true };
  }
}
