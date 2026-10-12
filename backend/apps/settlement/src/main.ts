import './instrument';
import { bootstrapService, config } from '@app/common';
import { AppModule } from './app.module';

bootstrapService(AppModule, {
  name: 'settlement',
  port: config.ports.settlement,
  swagger: {
    title: 'PayForge Settlement & Reconciliation',
    description: 'Acquirer reconciliation, merchant payouts and settlement reports.',
  },
}).catch((err) => {
  console.error(err);
  process.exit(1);
});
