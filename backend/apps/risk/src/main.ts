import './instrument';
import { bootstrapService, config } from '@app/common';
import { AppModule } from './app.module';

bootstrapService(AppModule, {
  name: 'risk',
  port: config.ports.risk,
  swagger: {
    title: 'PayForge Risk Engine',
    description: 'Real-time rule-based fraud scoring with velocity checks and blocklists.',
  },
}).catch((err) => {
  console.error(err);
  process.exit(1);
});
