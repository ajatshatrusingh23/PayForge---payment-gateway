import { ConsoleLogger, INestApplication, Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import type { NextFunction, Request, Response } from 'express';
import { HEADER } from './auth';
import { config, DEV_INTERNAL_TOKEN, DEV_JWT_SECRET } from './config';
import { GlobalExceptionFilter, validationExceptionFactory } from './errors';
import { IdPrefix, newId } from './ids';
import { httpMetricsMiddleware, initMetrics } from './metrics';

export interface BootstrapOptions {
  name: string;
  port: number;
  swagger?: { title: string; description: string };
  /** Hook to register extra Express middleware before Nest's router (used by the gateway proxy). */
  configure?: (app: NestExpressApplication) => void | Promise<void>;
  bodyParser?: boolean;
  /** Keep the raw request body (req.rawBody) for HMAC signature verification. */
  rawBody?: boolean;
  cors?: boolean;
}

function requestIdMiddleware(req: Request, res: Response, next: NextFunction): void {
  const incoming = req.headers[HEADER.requestId];
  const requestId = typeof incoming === 'string' && incoming.length <= 64 ? incoming : newId(IdPrefix.request, 16);
  req.headers[HEADER.requestId] = requestId;
  res.setHeader('request-id', requestId);
  next();
}

/** Shared bootstrap so every service has identical logging, validation, errors, metrics and shutdown behaviour. */
export async function bootstrapService(module: unknown, opts: BootstrapOptions): Promise<INestApplication> {
  initMetrics(opts.name);

  const logger = new ConsoleLogger({
    prefix: `PayForge:${opts.name}`,
    json: config.logJson,
    colors: !config.logJson,
    timestamp: true,
  });

  const app = await NestFactory.create<NestExpressApplication>(module as never, {
    logger,
    bodyParser: opts.bodyParser ?? true,
    rawBody: opts.rawBody ?? false,
  });

  // Only trust X-Forwarded-For from known proxies (local/private networks by default). Trusting it from
  // anyone would let a client spoof its IP and dodge IP-based rate limits and risk velocity rules.
  app.set('trust proxy', process.env.TRUST_PROXY ?? 'loopback, linklocal, uniquelocal');
  app.disable('x-powered-by');
  app.use(requestIdMiddleware);
  app.use(httpMetricsMiddleware);
  if (opts.cors) {
    const origins = (process.env.CORS_ORIGINS ?? 'http://localhost:5174,http://localhost:3000,http://localhost:3001')
      .split(',')
      .map((o) => o.trim());
    app.enableCors({
      origin: origins,
      allowedHeaders: ['authorization', 'content-type', 'idempotency-key', 'x-request-id'],
      exposedHeaders: ['request-id', 'idempotent-replayed', 'x-ratelimit-limit', 'x-ratelimit-remaining', 'retry-after'],
      maxAge: 600,
    });
  }
  if (opts.configure) await opts.configure(app);

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      exceptionFactory: validationExceptionFactory,
    }),
  );
  app.useGlobalFilters(new GlobalExceptionFilter());
  app.enableShutdownHooks();

  if (opts.swagger) {
    const doc = new DocumentBuilder()
      .setTitle(opts.swagger.title)
      .setDescription(opts.swagger.description)
      .setVersion('1.0')
      .addBearerAuth()
      .build();
    SwaggerModule.setup('docs', app, () => SwaggerModule.createDocument(app, doc));
  }

  if (config.isProduction && (config.internalToken === DEV_INTERNAL_TOKEN || config.jwtSecret === DEV_JWT_SECRET)) {
    throw new Error('Refusing to start in production with development secrets. Set INTERNAL_TOKEN and JWT_SECRET.');
  }

  await app.listen(opts.port, '0.0.0.0');
  Logger.log(`${opts.name} listening on http://localhost:${opts.port}`, 'Bootstrap');
  return app;
}
