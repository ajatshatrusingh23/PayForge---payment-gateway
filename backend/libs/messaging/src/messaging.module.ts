import { DynamicModule, Module, Provider } from '@nestjs/common';
import { KafkaService, MESSAGING_OPTIONS, MessagingOptions } from './kafka.service';
import { OutboxRelay } from './outbox';

@Module({})
export class MessagingModule {
  static forRoot(options: MessagingOptions): DynamicModule {
    const providers: Provider[] = [{ provide: MESSAGING_OPTIONS, useValue: options }, KafkaService];
    if (options.outbox) providers.push(OutboxRelay);
    return {
      module: MessagingModule,
      global: true,
      providers,
      exports: [KafkaService],
    };
  }
}
