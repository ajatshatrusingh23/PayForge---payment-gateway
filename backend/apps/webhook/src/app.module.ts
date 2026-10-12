import { Module } from '@nestjs/common';
import { CommonModule } from '@app/common';
import { DatabaseModule } from '@app/database';
import { MessagingModule } from '@app/messaging';
import { WebhookDispatcher } from './dispatcher.service';
import { migrations } from './migrations';
import { WebhookController } from './webhook.controller';
import { WebhookService } from './webhook.service';

@Module({
  imports: [
    CommonModule.forService('webhook'),
    DatabaseModule.forRoot({ database: 'pf_webhook', migrations }),
    MessagingModule.forRoot({ clientId: 'webhook' }),
  ],
  controllers: [WebhookController],
  providers: [WebhookService, WebhookDispatcher],
})
export class AppModule {}
