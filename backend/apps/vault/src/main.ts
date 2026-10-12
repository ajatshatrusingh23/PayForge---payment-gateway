import './instrument';
import { bootstrapService, config } from '@app/common';
import { AppModule } from './app.module';

bootstrapService(AppModule, {
  name: 'vault',
  port: config.ports.vault,
  swagger: {
    title: 'PayForge Vault',
    description: 'Card and UPI tokenization with AES-256-GCM envelope encryption. The only service that ever sees a card number.',
  },
}).catch((err) => {
  console.error(err);
  process.exit(1);
});
