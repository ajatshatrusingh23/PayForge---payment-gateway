import './instrument';
import { bootstrapService, config } from '@app/common';
import { AppModule } from './app.module';

bootstrapService(AppModule, {
  name: 'ledger',
  port: config.ports.ledger,
  swagger: {
    title: 'PayForge Ledger',
    description: 'Append-only double-entry ledger, balances and integrity checks.',
  },
}).catch((err) => {
  console.error(err);
  process.exit(1);
});
