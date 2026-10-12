import {
  CallHandler,
  ExecutionContext,
  HttpException,
  Injectable,
  Logger,
  NestInterceptor,
  UseInterceptors,
} from '@nestjs/common';
import { HTTP_CODE_METADATA } from '@nestjs/common/constants';
import { Reflector } from '@nestjs/core';
import type { Request, Response } from 'express';
import { catchError, from, map, mergeMap, Observable, of, throwError } from 'rxjs';
import { ApiError, HEADER, ReplayedResponse, sha256, stableStringify } from '@app/common';
import { Db, Migration } from './db';

export const IDEMPOTENCY_MIGRATION: Migration = {
  id: '000_idempotency_keys',
  sql: `
    CREATE TABLE IF NOT EXISTS idempotency_keys (
      merchant_id    text        NOT NULL,
      idem_key       text        NOT NULL,
      request_method text        NOT NULL,
      request_path   text        NOT NULL,
      request_hash   text        NOT NULL,
      status         text        NOT NULL CHECK (status IN ('in_progress', 'completed')),
      response_code  int,
      response_body  jsonb,
      locked_at      timestamptz NOT NULL DEFAULT now(),
      created_at     timestamptz NOT NULL DEFAULT now(),
      completed_at   timestamptz,
      PRIMARY KEY (merchant_id, idem_key)
    );
    CREATE INDEX IF NOT EXISTS idempotency_keys_created_idx ON idempotency_keys (created_at);
  `,
};

/** A request still marked in_progress after this long is assumed to have crashed and may be taken over. */
const STALE_LOCK_MS = 60_000;

type BeginResult = { kind: 'proceed' } | { kind: 'replay'; code: number; body: unknown };

interface KeyRow {
  request_hash: string;
  status: 'in_progress' | 'completed';
  response_code: number | null;
  response_body: unknown;
  locked_at: Date;
}

/**
 * Idempotency-Key support (same contract as Stripe):
 *  - The first request with a key executes and its response is stored.
 *  - Retries with the same key + same body get the stored response (header `idempotent-replayed: true`).
 *  - Same key + different body -> 400 idempotency_key_reused.
 *  - Same key while the first request is still running -> 409 idempotency_key_in_use.
 *
 * The PRIMARY KEY (merchant_id, idem_key) is the lock: INSERT ... ON CONFLICT DO NOTHING
 * is atomic, so exactly one concurrent request wins, with no Redis and no race window.
 */
@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  private readonly logger = new Logger('Idempotency');

  constructor(
    private readonly db: Db,
    private readonly reflector: Reflector,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const http = context.switchToHttp();
    const req = http.getRequest<Request>();
    const header = req.headers['idempotency-key'];
    const key = Array.isArray(header) ? header[0] : header;
    if (key === undefined) return next.handle();
    if (!key || key.length > 255) {
      throw new ApiError(400, 'idempotency_error', 'idempotency_key_invalid', 'Idempotency-Key must be 1-255 characters');
    }

    const merchantId = (req.headers[HEADER.merchantId] as string) || 'platform';
    const path = req.originalUrl.split('?')[0];
    const successCode =
      this.reflector.get<number>(HTTP_CODE_METADATA, context.getHandler()) ?? (req.method === 'POST' ? 201 : 200);
    const requestHash = sha256(`${req.method} ${path} ${stableStringify(req.body ?? {})}`);

    return from(this.begin(merchantId, key, req.method, path, requestHash)).pipe(
      mergeMap((begun) => {
        if (begun.kind === 'replay') {
          if (begun.code >= 400) return throwError(() => new ReplayedResponse(begun.body, begun.code));
          http.getResponse<Response>().setHeader('idempotent-replayed', 'true');
          return of(begun.body);
        }
        return next.handle().pipe(
          mergeMap((body) => from(this.complete(merchantId, key, successCode, body)).pipe(map(() => body))),
          catchError((err) => from(this.onError(merchantId, key, err)).pipe(mergeMap(() => throwError(() => err)))),
        );
      }),
    );
  }

  private async begin(merchantId: string, key: string, method: string, path: string, hash: string, retry = true): Promise<BeginResult> {
    const inserted = await this.db.query(
      `INSERT INTO idempotency_keys (merchant_id, idem_key, request_method, request_path, request_hash, status)
       VALUES ($1, $2, $3, $4, $5, 'in_progress')
       ON CONFLICT (merchant_id, idem_key) DO NOTHING`,
      [merchantId, key, method, path, hash],
    );
    if (inserted.rowCount === 1) return { kind: 'proceed' };

    const row = await this.db.one<KeyRow>(
      'SELECT request_hash, status, response_code, response_body, locked_at FROM idempotency_keys WHERE merchant_id = $1 AND idem_key = $2',
      [merchantId, key],
    );
    if (!row) {
      // The previous holder released the key between our INSERT and SELECT; try once more.
      if (retry) return this.begin(merchantId, key, method, path, hash, false);
      throw new ApiError(409, 'idempotency_error', 'idempotency_key_in_use', 'Idempotency-Key is busy, please retry');
    }
    if (row.request_hash !== hash) {
      throw new ApiError(
        400,
        'idempotency_error',
        'idempotency_key_reused',
        'Keys for idempotent requests can only be used with the same parameters they were first used with.',
      );
    }
    if (row.status === 'completed') {
      return { kind: 'replay', code: row.response_code ?? 200, body: row.response_body };
    }
    if (Date.now() - new Date(row.locked_at).getTime() > STALE_LOCK_MS) {
      const takeover = await this.db.query(
        `UPDATE idempotency_keys SET locked_at = now()
         WHERE merchant_id = $1 AND idem_key = $2 AND status = 'in_progress' AND locked_at = $3`,
        [merchantId, key, row.locked_at],
      );
      if (takeover.rowCount === 1) {
        this.logger.warn(`Took over stale idempotency key ${key} for ${merchantId}`);
        return { kind: 'proceed' };
      }
    }
    throw new ApiError(
      409,
      'idempotency_error',
      'idempotency_key_in_use',
      'A request with this Idempotency-Key is already in progress. Retry once it has completed.',
    );
  }

  private async complete(merchantId: string, key: string, code: number, body: unknown): Promise<void> {
    await this.db.query(
      `UPDATE idempotency_keys
         SET status = 'completed', response_code = $3, response_body = $4::jsonb, completed_at = now()
       WHERE merchant_id = $1 AND idem_key = $2`,
      [merchantId, key, code, JSON.stringify(body ?? null)],
    );
  }

  /**
   * Card errors (402) are business outcomes and are stored, so a retry returns the same decline.
   * Validation errors, conflicts and 5xx release the key so the client can fix the request and retry.
   */
  private async onError(merchantId: string, key: string, err: unknown): Promise<void> {
    const status = err instanceof HttpException ? err.getStatus() : 500;
    if (err instanceof ApiError && status === 402) {
      await this.complete(merchantId, key, status, err.getResponse()).catch(() => undefined);
      return;
    }
    await this.db
      .query(`DELETE FROM idempotency_keys WHERE merchant_id = $1 AND idem_key = $2 AND status = 'in_progress'`, [merchantId, key])
      .catch(() => undefined);
  }
}

/** Marks a POST endpoint as supporting the Idempotency-Key header. */
export const Idempotent = () => UseInterceptors(IdempotencyInterceptor);

export async function purgeExpiredIdempotencyKeys(db: Db, olderThanHours = 24): Promise<number> {
  const res = await db.query(`DELETE FROM idempotency_keys WHERE created_at < now() - make_interval(hours => $1)`, [olderThanHours]);
  return res.rowCount ?? 0;
}
