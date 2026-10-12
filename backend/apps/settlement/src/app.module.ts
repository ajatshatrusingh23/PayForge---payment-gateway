import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { CommonModule } from '@app/common';
import { DatabaseModule } from '@app/database';
import { MessagingModule } from '@app/messaging';
import { migrations } from './migrations';
import { SettlementController } from './settlement.controller';
import { SettlementService } from './settlement.service';

@Module({
  imports: [
    CommonModule.forService('settlement'),
    DatabaseModule.forRoot({ database: 'pf_settlement', migrations }),
    MessagingModule.forRoot({ clientId: 'settlement', outbox: true }),
    ScheduleModule.forRoot(),
  ],
  controllers: [SettlementController],
  providers: [SettlementService],
})
export class AppModule {}
