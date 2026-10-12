import { Body, Controller, Get, Headers, HttpCode, Param, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Auth, Ctx, HEADER, RequestContext } from '@app/common';
import { CreatePaymentMethodDto, RevealDto } from './dto';
import { VaultService } from './vault.service';

@ApiTags('Payment methods')
@Controller()
export class VaultController {
  constructor(private readonly vault: VaultService) {}

  /** Called from the browser (checkout) with a publishable key: the merchant's server never sees card data. */
  @Auth('publishable', 'secret')
  @Post('v1/payment_methods')
  @HttpCode(201)
  create(@Ctx() ctx: RequestContext, @Body() dto: CreatePaymentMethodDto) {
    return this.vault.create(ctx.merchantId, dto);
  }

  @Auth('secret', 'dashboard')
  @Get('v1/payment_methods/:id')
  get(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.vault.get(ctx.merchantId, id);
  }

  @Auth('dashboard')
  @Get('v1/vault/access_log')
  accessLog(@Ctx() ctx: RequestContext, @Query('payment_method') paymentMethodId?: string) {
    return this.vault.accessLog(ctx.merchantId, paymentMethodId);
  }

  // ---- internal ----

  @Get('internal/payment_methods/:id')
  internalGet(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.vault.get(ctx.merchantId, id);
  }

  @Post('internal/payment_methods/:id/reveal')
  @HttpCode(200)
  reveal(
    @Ctx() ctx: RequestContext,
    @Param('id') id: string,
    @Body() dto: RevealDto,
    @Headers(HEADER.caller) caller = 'unknown',
  ) {
    return this.vault.reveal(ctx.merchantId, id, caller, dto.purpose, ctx.requestId);
  }
}
