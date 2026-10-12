import { randomBytes } from 'crypto';

const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
// 248 is the largest multiple of 62 below 256; rejecting bytes >= 248 removes modulo bias.
const UNBIASED_LIMIT = 248;

/** Cryptographically random base62 string without modulo bias. */
export function randomString(length: number): string {
  let out = '';
  while (out.length < length) {
    const bytes = randomBytes(length * 2);
    for (let i = 0; i < bytes.length && out.length < length; i++) {
      if (bytes[i] < UNBIASED_LIMIT) out += ALPHABET[bytes[i] % 62];
    }
  }
  return out;
}

/** Stripe-style prefixed identifiers, e.g. `pi_3fK9...`. The prefix tells you the object type at a glance. */
export function newId(prefix: string, length = 24): string {
  return `${prefix}_${randomString(length)}`;
}

export const IdPrefix = {
  merchant: 'acct',
  apiKey: 'key',
  paymentIntent: 'pi',
  paymentAttempt: 'pa',
  paymentMethod: 'pm',
  refund: 're',
  event: 'evt',
  journal: 'je',
  webhookEndpoint: 'we',
  webhookDelivery: 'whd',
  riskAssessment: 'ra',
  blocklist: 'bl',
  payout: 'po',
  settlementItem: 'si',
  reconRun: 'rr',
  request: 'req',
} as const;
