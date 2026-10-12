import { signWebhookPayload, stableStringify, verifyWebhookSignature } from './crypto';
import { newId, randomString } from './ids';

describe('webhook signatures', () => {
  const secret = 'whsec_test';
  const body = JSON.stringify({ id: 'evt_1', type: 'payment_intent.captured' });

  it('verifies a valid signature', () => {
    const header = signWebhookPayload(secret, body, 1_700_000_000);
    expect(verifyWebhookSignature(secret, body, header, 300, 1_700_000_100)).toEqual({ valid: true });
  });

  it('rejects a tampered body', () => {
    const header = signWebhookPayload(secret, body, 1_700_000_000);
    const result = verifyWebhookSignature(secret, body.replace('captured', 'refunded'), header, 300, 1_700_000_000);
    expect(result.valid).toBe(false);
  });

  it('rejects a replay outside the tolerance window', () => {
    const header = signWebhookPayload(secret, body, 1_700_000_000);
    expect(verifyWebhookSignature(secret, body, header, 300, 1_700_001_000)).toEqual({ valid: false, reason: 'timestamp outside tolerance' });
  });

  it('rejects the wrong secret and malformed headers', () => {
    const header = signWebhookPayload(secret, body);
    expect(verifyWebhookSignature('whsec_other', body, header).valid).toBe(false);
    expect(verifyWebhookSignature(secret, body, 'garbage').valid).toBe(false);
    expect(verifyWebhookSignature(secret, body, undefined).valid).toBe(false);
  });
});

describe('stableStringify', () => {
  it('is independent of key order (so idempotency hashes are stable)', () => {
    expect(stableStringify({ b: 1, a: { d: [1, 2], c: 'x' } })).toBe(stableStringify({ a: { c: 'x', d: [1, 2] }, b: 1 }));
  });

  it('drops undefined values like JSON.stringify does', () => {
    expect(stableStringify({ a: 1, b: undefined })).toBe('{"a":1}');
  });
});

describe('ids', () => {
  it('generates prefixed base62 identifiers of the requested length', () => {
    const id = newId('pi');
    expect(id).toMatch(/^pi_[0-9A-Za-z]{24}$/);
    expect(randomString(40)).toHaveLength(40);
  });

  it('does not repeat across many generations', () => {
    const ids = new Set(Array.from({ length: 10_000 }, () => newId('x')));
    expect(ids.size).toBe(10_000);
  });
});
