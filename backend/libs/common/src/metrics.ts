import { Controller, Get, Header } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { collectDefaultMetrics, Counter, Gauge, Histogram, Registry } from 'prom-client';
import { Open } from './auth';

/** One Prometheus registry per process; every service exposes it on GET /metrics. */
export const registry = new Registry();

let initialised = false;
export function initMetrics(service: string): void {
  if (initialised) return;
  initialised = true;
  registry.setDefaultLabels({ service });
  collectDefaultMetrics({ register: registry });
}

export const httpRequestDuration = new Histogram({
  name: 'http_request_duration_seconds',
  help: 'HTTP request latency by route',
  labelNames: ['method', 'route', 'status'] as const,
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [registry],
});

export function counter<T extends string>(name: string, help: string, labelNames: readonly T[] = []) {
  return new Counter<T>({ name, help, labelNames, registers: [registry] });
}

export function gauge<T extends string>(name: string, help: string, labelNames: readonly T[] = []) {
  return new Gauge<T>({ name, help, labelNames, registers: [registry] });
}

export function histogram<T extends string>(
  name: string,
  help: string,
  labelNames: readonly T[] = [],
  buckets = [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
) {
  return new Histogram<T>({ name, help, labelNames, buckets, registers: [registry] });
}

/** Records request latency. Uses the matched route *pattern* (not the raw URL) to keep label cardinality bounded. */
export function httpMetricsMiddleware(req: Request, res: Response, next: NextFunction): void {
  const end = httpRequestDuration.startTimer();
  res.on('finish', () => {
    if (req.path === '/metrics') return;
    const route = (req.route?.path as string | undefined) ?? (res.locals.routeLabel as string | undefined) ?? 'unmatched';
    end({ method: req.method, route, status: String(res.statusCode) });
  });
  next();
}

@Controller()
export class MetricsController {
  @Open()
  @Get('metrics')
  @Header('content-type', registry.contentType)
  async metrics(): Promise<string> {
    return registry.metrics();
  }
}
