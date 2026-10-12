import { Module } from '@nestjs/common';
import { CommonModule, RedisModule } from '@app/common';
import { DatabaseModule } from '@app/database';
import { MessagingModule } from '@app/messaging';
import { migrations } from './migrations';
import { RiskController } from './risk.controller';
import { RiskService } from './risk.service';

@Module({
  imports: [
    CommonModule.forService('risk'),
    DatabaseModule.forRoot({ database: 'pf_risk', migrations }),
    RedisModule,
    MessagingModule.forRoot({ clientId: 'risk' }),
  ],
  controllers: [RiskController],
  providers: [RiskService],
})
export class AppModule {}
