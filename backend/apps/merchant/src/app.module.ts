import { Module } from '@nestjs/common';
import { CommonModule, RedisModule } from '@app/common';
import { DatabaseModule } from '@app/database';
import { MerchantController } from './merchant.controller';
import { MerchantService } from './merchant.service';
import { migrations } from './migrations';

@Module({
  imports: [CommonModule.forService('merchant'), DatabaseModule.forRoot({ database: 'pf_merchant', migrations }), RedisModule],
  controllers: [MerchantController],
  providers: [MerchantService],
})
export class AppModule {}
