import './instrument';
import { bootstrapService, config } from '@app/common';
import { AppModule } from './app.module';

bootstrapService(AppModule, {
  name: 'merchant',
  port: config.ports.merchant,
  swagger: {
    title: 'PayForge Merchant Service',
    description: 'Merchant onboarding, API keys, dashboard login and KYC.',
  },
}).catch((err) => {
  console.error(err);
  process.exit(1);
});
