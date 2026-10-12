import { Module } from '@nestjs/common';
import { CommonModule } from '@app/common';
import { DatabaseModule } from '@app/database';
import { MessagingModule } from '@app/messaging';
import { LedgerController } from './ledger.controller';
import { LedgerService } from './ledger.service';
import { migrations } from './migrations';

@Module({
  imports: [
    CommonModule.forService('ledger'),
    DatabaseModule.forRoot({ database: 'pf_ledger', migrations }),
    MessagingModule.forRoot({ clientId: 'ledger' }),
  ],
  controllers: [LedgerController],
  providers: [LedgerService],
})
export class AppModule {}
