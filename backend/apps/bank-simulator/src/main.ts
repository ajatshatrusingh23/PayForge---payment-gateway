import './instrument';
import { bootstrapService, config } from '@app/common';
import { AppModule } from './app.module';

bootstrapService(AppModule, {
  name: 'bank-simulator',
  port: config.ports.bank,
  swagger: {
    title: 'PayForge Bank Simulator',
    description: 'Simulated acquiring banks (AlphaBank, BetaBank, GammaPay) with chaos controls.',
  },
}).catch((err) => {
  console.error(err);
  process.exit(1);
});
