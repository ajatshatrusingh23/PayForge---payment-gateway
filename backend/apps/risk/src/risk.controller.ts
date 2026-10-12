import { Body, Controller, Delete, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Auth, Ctx, RequestContext } from '@app/common';
import { AssessDto, CreateBlocklistDto } from './dto';
import { RiskService } from './risk.service';

@ApiTags('Risk')
@Controller()
export class RiskController {
  constructor(private readonly risk: RiskService) {}

  @Post('internal/risk/assess')
  @HttpCode(200)
  assess(@Body() dto: AssessDto) {
    return this.risk.assess(dto);
  }

  @Auth('secret', 'dashboard')
  @Get('v1/risk/assessments')
  assessments(@Ctx() ctx: RequestContext, @Query('payment_intent') paymentIntentId?: string) {
    return this.risk.listAssessments(ctx.merchantId, paymentIntentId);
  }

  @Auth('secret', 'dashboard')
  @Get('v1/risk/rules')
  rules() {
    return this.risk.rules();
  }

  @Auth('secret', 'dashboard')
  @Get('v1/risk/blocklist')
  blocklist(@Ctx() ctx: RequestContext) {
    return this.risk.listBlocklist(ctx.merchantId);
  }

  @Auth('secret', 'dashboard')
  @Post('v1/risk/blocklist')
  block(@Ctx() ctx: RequestContext, @Body() dto: CreateBlocklistDto) {
    return this.risk.addToBlocklist(ctx.merchantId, dto);
  }

  @Auth('secret', 'dashboard')
  @Delete('v1/risk/blocklist/:id')
  unblock(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.risk.removeFromBlocklist(ctx.merchantId, id);
  }
}
