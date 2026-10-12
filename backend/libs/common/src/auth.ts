import {
  CanActivate,
  createParamDecorator,
  ExecutionContext,
  Injectable,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { config } from './config';
import { safeEqual } from './crypto';
import { Errors } from './errors';

/**
 * Trust model
 * -----------
 * The API gateway authenticates the caller (API key or dashboard JWT) and then
 * forwards the request with these headers:
 *   x-internal-token  shared secret: proves the request came from inside the platform
 *   x-merchant-id     the authenticated merchant
 *   x-auth-type       secret | publishable | dashboard | internal
 * Each service authorises the request with the AuthGuard below, so a service
 * can never be reached directly with a spoofed merchant id. (In production you
 * would use mTLS or a service mesh instead of a shared token.)
 */
export type AuthType = 'secret' | 'publishable' | 'dashboard' | 'internal';

export const HEADER = {
  internalToken: 'x-internal-token',
  merchantId: 'x-merchant-id',
  authType: 'x-auth-type',
  requestId: 'x-request-id',
  clientIp: 'x-client-ip',
  caller: 'x-caller',
} as const;

const AUTH_METADATA = 'pf:auth';
const OPEN_METADATA = 'pf:open';

/** Which caller types may invoke the endpoint. Endpoints without this decorator are internal-only. */
export const Auth = (...types: AuthType[]) => SetMetadata(AUTH_METADATA, types);
/** Reachable through the gateway without a merchant (e.g. signup/login). Still requires the internal token. */
export const NoMerchant = () => SetMetadata(AUTH_METADATA, 'none');
/** Completely open (health checks, metrics, callbacks that verify their own signature). */
export const Open = () => SetMetadata(OPEN_METADATA, true);

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(OPEN_METADATA, targets)) return true;

    const req = context.switchToHttp().getRequest<Request>();
    const token = req.headers[HEADER.internalToken];
    if (typeof token !== 'string' || !safeEqual(token, config.internalToken)) {
      throw Errors.unauthorized('Requests must come through the PayForge API gateway');
    }

    const allowed = this.reflector.getAllAndOverride<AuthType[] | 'none'>(AUTH_METADATA, targets) ?? ['internal'];
    if (allowed === 'none') return true;

    const authType = req.headers[HEADER.authType] as AuthType | undefined;
    if (!authType || !allowed.includes(authType)) {
      throw Errors.forbidden(
        `This endpoint requires ${allowed.join(' or ')} authentication${authType ? ` (got ${authType})` : ''}`,
      );
    }
    if (authType !== 'internal' && !req.headers[HEADER.merchantId]) {
      throw Errors.unauthorized('Missing merchant context');
    }
    return true;
  }
}

export interface RequestContext {
  requestId: string;
  merchantId: string;
  authType: AuthType;
  clientIp?: string;
}

/** Injects the authenticated caller context into a controller method. */
export const Ctx = createParamDecorator((_: unknown, context: ExecutionContext): RequestContext => {
  const req = context.switchToHttp().getRequest<Request>();
  return {
    requestId: (req.headers[HEADER.requestId] as string) ?? '',
    merchantId: (req.headers[HEADER.merchantId] as string) ?? '',
    authType: (req.headers[HEADER.authType] as AuthType) ?? 'internal',
    clientIp: (req.headers[HEADER.clientIp] as string) ?? req.ip,
  };
});
