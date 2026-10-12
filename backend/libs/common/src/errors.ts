import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import type { ValidationError } from 'class-validator';

export type ErrorType =
  | 'invalid_request_error'
  | 'authentication_error'
  | 'permission_error'
  | 'rate_limit_error'
  | 'idempotency_error'
  | 'card_error'
  | 'api_error';

export interface ApiErrorBody {
  type: ErrorType;
  code: string;
  message: string;
  param?: string;
  [extra: string]: unknown;
}

/**
 * The one error shape every PayForge service returns:
 *   { "error": { "type": "...", "code": "...", "message": "...", "param": "...", "request_id": "..." } }
 */
export class ApiError extends HttpException {
  constructor(
    status: number,
    readonly type: ErrorType,
    readonly code: string,
    message: string,
    readonly param?: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super({ error: { type, code, message, ...(param ? { param } : {}), ...extra } }, status);
    // HttpException would otherwise derive a generic message ("Api Error") from the response object.
    this.message = message;
  }

  get body(): ApiErrorBody {
    return (this.getResponse() as { error: ApiErrorBody }).error;
  }
}

/** Raised by the idempotency layer to replay a previously stored error response verbatim. */
export class ReplayedResponse extends HttpException {
  constructor(body: unknown, status: number) {
    super(body as Record<string, unknown>, status);
  }
}

export const Errors = {
  invalid: (message: string, param?: string, code = 'parameter_invalid') =>
    new ApiError(HttpStatus.BAD_REQUEST, 'invalid_request_error', code, message, param),
  notFound: (resource: string, id: string) =>
    new ApiError(HttpStatus.NOT_FOUND, 'invalid_request_error', 'resource_missing', `No such ${resource}: '${id}'`),
  unauthorized: (message = 'Invalid API key provided') =>
    new ApiError(HttpStatus.UNAUTHORIZED, 'authentication_error', 'unauthorized', message),
  forbidden: (message: string) =>
    new ApiError(HttpStatus.FORBIDDEN, 'permission_error', 'forbidden', message),
  conflict: (code: string, message: string) =>
    new ApiError(HttpStatus.CONFLICT, 'invalid_request_error', code, message),
  unexpectedState: (message: string, extra: Record<string, unknown> = {}) =>
    new ApiError(HttpStatus.BAD_REQUEST, 'invalid_request_error', 'unexpected_state', message, undefined, extra),
  card: (code: string, message: string, param?: string) =>
    new ApiError(HttpStatus.PAYMENT_REQUIRED, 'card_error', code, message, param),
  rateLimited: (message = 'Too many requests. Please retry after a short delay.') =>
    new ApiError(HttpStatus.TOO_MANY_REQUESTS, 'rate_limit_error', 'rate_limited', message),
  upstream: (message: string) =>
    new ApiError(HttpStatus.BAD_GATEWAY, 'api_error', 'upstream_error', message),
  unavailable: (message: string) =>
    new ApiError(HttpStatus.SERVICE_UNAVAILABLE, 'api_error', 'service_unavailable', message),
};

/** Turns class-validator output into a single, human-friendly invalid_request_error. */
export function validationExceptionFactory(errors: ValidationError[]): ApiError {
  const first = findFirstConstraint(errors);
  if (!first) return Errors.invalid('Invalid request body');
  return Errors.invalid(first.message, first.path, first.code);
}

function findFirstConstraint(
  errors: ValidationError[],
  parent = '',
): { path: string; message: string; code: string } | undefined {
  for (const err of errors) {
    const path = parent ? `${parent}[${err.property}]` : err.property;
    if (err.constraints && Object.keys(err.constraints).length) {
      const [rule, message] = Object.entries(err.constraints)[0];
      const code = rule === 'whitelistValidation' ? 'parameter_unknown' : 'parameter_invalid';
      const friendly = rule === 'whitelistValidation' ? `Received unknown parameter: ${path}` : message;
      return { path, message: friendly, code };
    }
    if (err.children?.length) {
      const nested = findFirstConstraint(err.children, path);
      if (nested) return nested;
    }
  }
  return undefined;
}

@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger('ExceptionFilter');

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();
    const req = ctx.getRequest<Request>();
    const requestId = req.headers['x-request-id'] as string | undefined;

    if (exception instanceof ReplayedResponse) {
      res.setHeader('idempotent-replayed', 'true');
      res.status(exception.getStatus()).json(exception.getResponse());
      return;
    }

    if (exception instanceof ApiError) {
      res.status(exception.getStatus()).json({ error: { ...exception.body, request_id: requestId } });
      return;
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const response = exception.getResponse();
      const message =
        typeof response === 'string'
          ? response
          : ((response as { message?: string | string[] }).message ?? exception.message);
      res.status(status).json({
        error: {
          type: status === 404 ? 'invalid_request_error' : status >= 500 ? 'api_error' : 'invalid_request_error',
          code: status === 404 ? 'route_not_found' : 'http_error',
          message: Array.isArray(message) ? message.join('; ') : message,
          request_id: requestId,
        },
      });
      return;
    }

    const err = exception as Error;
    this.logger.error(`Unhandled error on ${req.method} ${req.url}: ${err?.message}`, err?.stack);
    res.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
      error: {
        type: 'api_error',
        code: 'internal_error',
        message: 'An unexpected error occurred. It has been logged; please retry.',
        request_id: requestId,
      },
    });
  }
}
