import { Body, Controller, Delete, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Auth, Ctx, RequestContext } from '@app/common';
import { CreateEndpointDto, ListDeliveriesDto } from './dto';
import { WebhookService } from './webhook.service';

@ApiTags('Webhooks')
@Controller('v1')
export class WebhookController {
  constructor(private readonly webhooks: WebhookService) {}

  @Auth('secret', 'dashboard')
  @Post('webhook_endpoints')
  create(@Ctx() ctx: RequestContext, @Body() dto: CreateEndpointDto) {
    return this.webhooks.createEndpoint(ctx.merchantId, dto);
  }

  @Auth('secret', 'dashboard')
  @Get('webhook_endpoints')
  list(@Ctx() ctx: RequestContext) {
    return this.webhooks.listEndpoints(ctx.merchantId);
  }

  @Auth('secret', 'dashboard')
  @Get('webhook_endpoints/:id')
  get(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.webhooks.getEndpoint(ctx.merchantId, id);
  }

  @Auth('secret', 'dashboard')
  @Delete('webhook_endpoints/:id')
  remove(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.webhooks.disableEndpoint(ctx.merchantId, id);
  }

  @Auth('secret', 'dashboard')
  @Post('webhook_endpoints/:id/test')
  @HttpCode(202)
  test(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.webhooks.sendTest(ctx.merchantId, id);
  }

  @Auth('secret', 'dashboard')
  @Get('webhook_deliveries')
  deliveries(@Ctx() ctx: RequestContext, @Query() q: ListDeliveriesDto) {
    return this.webhooks.listDeliveries(ctx.merchantId, q);
  }

  @Auth('secret', 'dashboard')
  @Get('webhook_deliveries/:id')
  delivery(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.webhooks.getDelivery(ctx.merchantId, id);
  }

  @Auth('secret', 'dashboard')
  @Post('webhook_deliveries/:id/retry')
  @HttpCode(202)
  retry(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.webhooks.retryDelivery(ctx.merchantId, id);
  }
}
