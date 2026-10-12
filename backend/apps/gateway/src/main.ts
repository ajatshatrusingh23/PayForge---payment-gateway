import './instrument';
import express from 'express';
import { bootstrapService, config } from '@app/common';
import { AppModule } from './app.module';
import { GatewayProxy } from './proxy';

bootstrapService(AppModule, {
  name: 'gateway',
  port: config.ports.gateway,
  bodyParser: false, // bodies are forwarded byte-for-byte
  cors: true,
  configure: (app) => {
    const proxy = app.get(GatewayProxy);
    app.use(express.raw({ type: () => true, limit: '1mb' }));
    app.use((req: express.Request, res: express.Response, next: express.NextFunction) => void proxy.handle(req, res, next));
  },
}).catch((err) => {
  console.error(err);
  process.exit(1);
});
