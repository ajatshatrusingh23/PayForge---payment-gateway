import { randomBytes } from 'crypto';
import { EnvelopeCrypto } from './envelope';

const kek = () => randomBytes(32);

describe('EnvelopeCrypto', () => {
  const crypto = new EnvelopeCrypto(new Map([[1, kek()]]), 1, randomBytes(32));

  it('round-trips a PAN', () => {
    const secret = crypto.encrypt('4111111111111111', 'pm_1');
    expect(crypto.decrypt(secret, 'pm_1')).toBe('4111111111111111');
  });

  it('never produces the same ciphertext twice (random IV + random DEK)', () => {
    const a = crypto.encrypt('4111111111111111', 'pm_1');
    const b = crypto.encrypt('4111111111111111', 'pm_1');
    expect(a.ciphertext.equals(b.ciphertext)).toBe(false);
    expect(a.ciphertext.toString('utf8')).not.toContain('4111');
  });

  it('detects tampering (GCM authentication tag)', () => {
    const secret = crypto.encrypt('4111111111111111', 'pm_1');
    secret.ciphertext[secret.ciphertext.length - 1] ^= 0xff;
    expect(() => crypto.decrypt(secret, 'pm_1')).toThrow();
  });

  it('binds the ciphertext to its record id (AAD): copying it to another row fails', () => {
    const secret = crypto.encrypt('4111111111111111', 'pm_1');
    expect(() => crypto.decrypt(secret, 'pm_2')).toThrow();
  });

  it('supports key rotation: old records decrypt with their original KEK version', () => {
    const v1 = kek();
    const v2 = kek();
    const before = new EnvelopeCrypto(new Map([[1, v1]]), 1, randomBytes(32));
    const old = before.encrypt('5555555555554444', 'pm_old');
    const after = new EnvelopeCrypto(
      new Map([
        [1, v1],
        [2, v2],
      ]),
      2,
      randomBytes(32),
    );
    expect(after.decrypt(old, 'pm_old')).toBe('5555555555554444');
    expect(after.encrypt('x', 'pm_new').keyVersion).toBe(2);
  });

  it('fingerprints deterministically without revealing the PAN', () => {
    const fp = crypto.fingerprint('card:4111111111111111');
    expect(fp).toBe(crypto.fingerprint('card:4111111111111111'));
    expect(fp).not.toBe(crypto.fingerprint('card:5555555555554444'));
    expect(fp).toMatch(/^[0-9a-f]{32}$/);
  });

  it('rejects keys of the wrong size', () => {
    expect(() => new EnvelopeCrypto(new Map([[1, randomBytes(16)]]), 1, randomBytes(32))).toThrow();
  });
});
