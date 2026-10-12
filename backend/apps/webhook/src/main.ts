import './instrument';
import { bootstrapService, config } from '@app/common';
import { AppModule } from './app.module';

bootstrapService(AppModule, {
  name: 'webhook',
  port: config.ports.webhook,
  swagger: {
    title: 'PayForge Webhooks',
    description: 'Signed webhook delivery with retries, exponential backoff, dead-lettering and replay.',
  },
}).catch((err) => {
  console.error(err);
  process.exit(1);
});
