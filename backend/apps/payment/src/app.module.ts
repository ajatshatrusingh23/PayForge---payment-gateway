import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { CommonModule, RedisModule } from '@app/common';
import { DatabaseModule, IdempotencyInterceptor } from '@app/database';
import { MessagingModule } from '@app/messaging';
import { AcquirerClient } from './acquirers/acquirer.client';
import { AnalyticsService } from './analytics/analytics.service';
import { PlatformClients } from './clients/platform.clients';
import { AcquirerCallbacksController, InsightsController, PaymentIntentsController, RefundsController } from './controllers';
import { JobsService } from './jobs/jobs.service';
import { migrations } from './migrations';
import { OutcomeService } from './payments/outcome.service';
import { PaymentRepository } from './payments/payment.repository';
import { PaymentsService } from './payments/payments.service';
import { RefundsService } from './refunds/refunds.service';
import { RouterService } from './routing/router.service';

@Module({
  imports: [
    CommonModule.forService('payment'),
    DatabaseModule.forRoot({ database: 'pf_payment', migrations }),
    RedisModule,
    MessagingModule.forRoot({ clientId: 'payment', outbox: true }),
    ScheduleModule.forRoot(),
  ],
  controllers: [PaymentIntentsController, RefundsController, InsightsController, AcquirerCallbacksController],
  providers: [
    PaymentRepository,
    PlatformClients,
    AcquirerClient,
    RouterService,
    OutcomeService,
    PaymentsService,
    RefundsService,
    AnalyticsService,
    JobsService,
    IdempotencyInterceptor,
  ],
})
export class AppModule {}
