import { Injectable, Logger } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { ApiError, config, counter, HEADER } from '@app/common';
import { Authenticator, Principal } from './authenticator';
import { POLICIES, RateLimiter } from './rate-limiter';
import { matchRoute, Route } from './routes';

/** Client headers we pass through. Everything else, especially x-internal-token / x-merchant-id, is dropped. */
const FORWARDED_HEADERS = new Set(['content-type', 'accept', 'idempotency-key', 'user-agent']);
const RETURNED_HEADERS = ['content-type', 'idempotent-replayed', 'retry-after'];
const UPSTREAM_TIMEOUT_MS = 30_000;

const gatewayRequests = counter('payforge_gateway_requests_total', 'Requests through the gateway', ['upstream', 'status'] as const);

@Injectable()
export class GatewayProxy {
  private readonly logger = new Logger('Gateway');

  constructor(
    private readonly authenticator: Authenticator,
    private readonly limiter: RateLimiter,
  ) {}

  async handle(req: Request, res: Response, next: NextFunction): Promise<void> {
    if (req.path === '/health' || req.path === '/metrics') return next();
    if (req.path === '/' && req.method === 'GET') {
      res.json({ service: 'PayForge API', version: 'v1', docs: 'https://github.com/your-username/payforge#api', livemode: false });
      return;
    }

    const route = matchRoute(req.path);
    res.locals.routeLabel = route?.prefix ?? 'unmatched';
    if (!route) {
      this.send(res, 404, {
        type: 'invalid_request_error',
        code: 'route_not_found',
        message: `Unrecognized request URL (${req.method}: ${req.path}).`,
      });
      return;
    }

    const started = Date.now();
    try {
      const principal = route.public ? null : await this.authenticator.authenticate(req.headers.authorization);
      if (route.dashboardOnly && principal?.type !== 'dashboard') {
        throw new ApiError(403, 'permission_error', 'dashboard_only', 'This endpoint is only available to logged-in dashboard users.');
      }

      const bucket = principal
        ? principal.type === 'publishable'
          ? `pk:${principal.merchantId}:${req.ip}`
          : `${principal.type}:${principal.merchantId}`
        : `anon:${req.ip}`;
      const policy = POLICIES[principal?.type ?? 'anonymous'];
      const rate = await this.limiter.consume(bucket, policy);
      res.setHeader('x-ratelimit-limit', String(rate.limit));
      res.setHeader('x-ratelimit-remaining', String(Math.max(0, rate.remaining)));
      if (!rate.allowed) {
        res.setHeader('retry-after', String(Math.max(1, Math.ceil(rate.retryAfterMs / 1000))));
        throw new ApiError(429, 'rate_limit_error', 'rate_limited', 'Too many requests. Please slow down and retry after the Retry-After interval.');
      }

      await this.forward(req, res, route, principal);
    } catch (err) {
      if (err instanceof ApiError) {
        this.send(res, err.getStatus(), err.body);
      } else {
        this.logger.error(`Gateway error on ${req.method} ${req.path}: ${(err as Error).message}`);
        this.send(res, 502, { type: 'api_error', code: 'bad_gateway', message: 'Unexpected gateway error.' });
      }
    } finally {
      gatewayRequests.inc({ upstream: route.upstream, status: String(res.statusCode) });
      if (config.env !== 'test') {
        this.logger.log(`${req.method} ${req.originalUrl} -> ${route.upstream} ${res.statusCode} ${Date.now() - started}ms`);
      }
    }
  }

  private async forward(req: Request, res: Response, route: Route, principal: Principal | null): Promise<void> {
    const path = route.rewrite ? req.originalUrl.replace(route.prefix, route.rewrite) : req.originalUrl;
    const headers: Record<string, string> = {
      [HEADER.internalToken]: config.internalToken,
      [HEADER.requestId]: String(req.headers[HEADER.requestId] ?? ''),
      [HEADER.clientIp]: req.ip ?? '',
    };
    for (const [name, value] of Object.entries(req.headers)) {
      if (FORWARDED_HEADERS.has(name) && typeof value === 'string') headers[name] = value;
    }
    if (principal) {
      headers[HEADER.merchantId] = principal.merchantId;
      headers[HEADER.authType] = principal.type;
    }
    const body = req.method !== 'GET' && req.method !== 'HEAD' && Buffer.isBuffer(req.body) && req.body.length ? req.body : undefined;

    let upstream: globalThis.Response;
    try {
      upstream = await fetch(`${config.services[route.upstream]}${path}`, {
        method: req.method,
        headers,
        body,
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      });
    } catch (err) {
      const timedOut = (err as Error).name === 'TimeoutError';
      throw new ApiError(
        timedOut ? 504 : 503,
        'api_error',
        timedOut ? 'upstream_timeout' : 'service_unavailable',
        timedOut ? 'The request timed out. It may still complete; retry safely with the same Idempotency-Key.' : `The ${route.upstream} service is temporarily unavailable.`,
      );
    }

    res.status(upstream.status);
    for (const name of RETURNED_HEADERS) {
      const value = upstream.headers.get(name);
      if (value) res.setHeader(name, value);
    }
    res.send(Buffer.from(await upstream.arrayBuffer()));
  }

  private send(res: Response, status: number, error: Record<string, unknown>): void {
    res.status(status).json({ error: { ...error, request_id: res.getHeader('request-id') } });
  }
}
