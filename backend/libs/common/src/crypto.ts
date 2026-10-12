import { createHash, createHmac, timingSafeEqual } from 'crypto';

export const sha256 = (input: string | Buffer): string => createHash('sha256').update(input).digest('hex');

export const hmacSha256 = (secret: string | Buffer, payload: string | Buffer): string =>
  createHmac('sha256', secret).update(payload).digest('hex');

/** Constant-time string comparison; avoids leaking how many leading characters matched. */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/**
 * Deterministic JSON: object keys sorted recursively. Two semantically equal
 * request bodies always hash to the same value (used for idempotency checks).
 */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
}

// ---------------------------------------------------------------------------
// Webhook signatures: `PayForge-Signature: t=<unix seconds>,v1=<hex hmac>`
// The timestamp is part of the signed payload, so a captured request cannot be
// replayed later (receivers reject anything older than the tolerance window).
// ---------------------------------------------------------------------------

export const SIGNATURE_HEADER = 'payforge-signature';
export const DEFAULT_SIGNATURE_TOLERANCE_SECONDS = 300;

export function signWebhookPayload(secret: string, body: string, timestamp = Math.floor(Date.now() / 1000)): string {
  const signature = hmacSha256(secret, `${timestamp}.${body}`);
  return `t=${timestamp},v1=${signature}`;
}

export type SignatureCheck = { valid: true } | { valid: false; reason: string };

export function verifyWebhookSignature(
  secret: string,
  body: string,
  header: string | undefined,
  toleranceSeconds = DEFAULT_SIGNATURE_TOLERANCE_SECONDS,
  now = Math.floor(Date.now() / 1000),
): SignatureCheck {
  if (!header) return { valid: false, reason: 'missing signature header' };
  const parts = Object.fromEntries(
    header.split(',').map((kv) => {
      const idx = kv.indexOf('=');
      return [kv.slice(0, idx).trim(), kv.slice(idx + 1).trim()];
    }),
  );
  const timestamp = Number(parts.t);
  if (!Number.isFinite(timestamp) || !parts.v1) return { valid: false, reason: 'malformed signature header' };
  if (Math.abs(now - timestamp) > toleranceSeconds) return { valid: false, reason: 'timestamp outside tolerance' };
  const expected = hmacSha256(secret, `${timestamp}.${body}`);
  return safeEqual(expected, parts.v1) ? { valid: true } : { valid: false, reason: 'signature mismatch' };
}
