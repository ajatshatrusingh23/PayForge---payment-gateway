import { Controller, Get, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Auth, Ctx, RequestContext } from '@app/common';
import { LedgerService } from './ledger.service';

@ApiTags('Ledger')
@Controller('v1')
export class LedgerController {
  constructor(private readonly ledger: LedgerService) {}

  @Auth('secret', 'dashboard')
  @Get('balance')
  balance(@Ctx() ctx: RequestContext) {
    return this.ledger.balance(ctx.merchantId);
  }

  @Auth('secret', 'dashboard')
  @Get('ledger/journals')
  journals(@Ctx() ctx: RequestContext, @Query('reference') reference?: string, @Query('limit') limit?: string) {
    return this.ledger.journals(ctx.merchantId, reference, Math.min(Math.max(parseInt(limit ?? '25', 10) || 25, 1), 100));
  }

  @Auth('secret', 'dashboard')
  @Get('ledger/integrity')
  integrity(@Ctx() ctx: RequestContext) {
    return this.ledger.integrity(ctx.merchantId);
  }
}
