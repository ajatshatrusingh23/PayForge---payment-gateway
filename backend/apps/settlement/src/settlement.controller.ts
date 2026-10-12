import { Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Auth, Ctx, RequestContext } from '@app/common';
import { SettlementService } from './settlement.service';

@ApiTags('Settlement & reconciliation')
@Controller('v1')
export class SettlementController {
  constructor(private readonly settlement: SettlementService) {}

  @Auth('secret', 'dashboard')
  @Get('payouts')
  payouts(@Ctx() ctx: RequestContext) {
    return this.settlement.listPayouts(ctx.merchantId);
  }

  @Auth('secret', 'dashboard')
  @Get('settlements/summary')
  summary(@Ctx() ctx: RequestContext) {
    return this.settlement.summary(ctx.merchantId);
  }

  @Auth('secret', 'dashboard')
  @Get('settlements/items')
  items(@Ctx() ctx: RequestContext, @Query('recon_status') reconStatus?: string) {
    return this.settlement.listItems(ctx.merchantId, reconStatus);
  }

  @Auth('dashboard')
  @Post('settlements/run')
  @HttpCode(200)
  run() {
    return this.settlement.runNow();
  }

  @Auth('secret', 'dashboard')
  @Get('reconciliation/runs')
  runs() {
    return this.settlement.listRuns();
  }

  @Auth('secret', 'dashboard')
  @Get('reconciliation/runs/:id')
  runDetail(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.settlement.getRun(ctx.merchantId, id);
  }

  @Auth('secret', 'dashboard')
  @Get('reconciliation/exceptions')
  exceptions(@Ctx() ctx: RequestContext) {
    return this.settlement.listExceptions(ctx.merchantId);
  }
}
