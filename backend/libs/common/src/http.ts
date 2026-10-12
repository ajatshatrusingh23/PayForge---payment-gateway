import { config } from './config';
import { HEADER } from './auth';

export class ServiceCallError extends Error {
  constructor(
    readonly status: number,
    readonly body: unknown,
    message: string,
  ) {
    super(message);
  }

  /** Error code from a PayForge-shaped error body, if present. */
  get code(): string | undefined {
    return (this.body as { error?: { code?: string } })?.error?.code;
  }
}

export class ServiceTimeoutError extends Error {}
export class ServiceUnreachableError extends Error {}

export interface CallOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  timeoutMs?: number;
  requestId?: string;
  /** Act on behalf of a merchant (service-to-service call scoped to that merchant). */
  merchantId?: string;
  headers?: Record<string, string>;
}

/**
 * Minimal typed client for service-to-service HTTP calls.
 * Always attaches the internal token, propagates the request id, and enforces a timeout
 * so that one slow dependency can never hang a request forever.
 */
export async function callService<T>(baseUrl: string, path: string, opts: CallOptions = {}): Promise<T> {
  const method = opts.method ?? (opts.body === undefined ? 'GET' : 'POST');
  const headers: Record<string, string> = {
    accept: 'application/json',
    [HEADER.internalToken]: config.internalToken,
    [HEADER.authType]: 'internal',
    ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}),
    ...(opts.requestId ? { [HEADER.requestId]: opts.requestId } : {}),
    ...(opts.merchantId ? { [HEADER.merchantId]: opts.merchantId } : {}),
    ...opts.headers,
  };

  let res: Response;
  try {
    res = await fetch(`${baseUrl}${path}`, {
      method,
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 5_000),
    });
  } catch (err) {
    const e = err as Error;
    if (e.name === 'TimeoutError' || e.name === 'AbortError') {
      throw new ServiceTimeoutError(`${method} ${baseUrl}${path} timed out after ${opts.timeoutMs ?? 5_000}ms`);
    }
    throw new ServiceUnreachableError(`${method} ${baseUrl}${path} failed: ${e.message}`);
  }

  const text = await res.text();
  let data: unknown = undefined;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }
  if (!res.ok) {
    throw new ServiceCallError(res.status, data, `${method} ${path} returned ${res.status}`);
  }
  return data as T;
}
