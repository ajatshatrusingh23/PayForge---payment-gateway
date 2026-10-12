import './instrument';
import { bootstrapService, config } from '@app/common';
import { AppModule } from './app.module';

bootstrapService(AppModule, {
  name: 'payment',
  port: config.ports.payment,
  rawBody: true,
  swagger: {
    title: 'PayForge Payments API',
    description: 'Payment intents, confirmation, OTP, capture, cancel, refunds, routing and analytics.',
  },
}).catch((err) => {
  console.error(err);
  process.exit(1);
});
