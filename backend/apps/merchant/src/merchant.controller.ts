import { Body, Controller, Get, HttpCode, Param, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Auth, Ctx, NoMerchant, RequestContext } from '@app/common';
import { AuthenticateKeyDto, KycDto, LoginDto, SignupDto } from './dto';
import { MerchantService } from './merchant.service';

@ApiTags('Merchants')
@Controller()
export class MerchantController {
  constructor(private readonly merchants: MerchantService) {}

  @NoMerchant()
  @Post('v1/merchants/signup')
  signup(@Body() dto: SignupDto) {
    return this.merchants.signup(dto);
  }

  @NoMerchant()
  @Post('v1/merchants/login')
  @HttpCode(200)
  login(@Body() dto: LoginDto) {
    return this.merchants.login(dto);
  }

  @Auth('dashboard', 'secret')
  @Get('v1/merchants/me')
  me(@Ctx() ctx: RequestContext) {
    return this.merchants.me(ctx.merchantId);
  }

  @Auth('dashboard')
  @Post('v1/merchants/me/kyc')
  @HttpCode(200)
  kyc(@Ctx() ctx: RequestContext, @Body() dto: KycDto) {
    return this.merchants.submitKyc(ctx.merchantId, dto);
  }

  @Auth('dashboard')
  @Get('v1/api_keys')
  listKeys(@Ctx() ctx: RequestContext) {
    return this.merchants.listKeys(ctx.merchantId);
  }

  @Auth('dashboard')
  @Post('v1/api_keys/roll')
  @HttpCode(200)
  rollKey(@Ctx() ctx: RequestContext) {
    return this.merchants.rollSecretKey(ctx.merchantId);
  }

  // ---- internal (service-to-service) ----

  @Post('internal/auth/api-key')
  @HttpCode(200)
  authenticate(@Body() dto: AuthenticateKeyDto) {
    return this.merchants.authenticateKey(dto.key);
  }

  @Get('internal/merchants')
  listIds() {
    return this.merchants.listIds();
  }

  @Get('internal/merchants/:id')
  internal(@Param('id') id: string) {
    return this.merchants.getInternal(id);
  }
}
