import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from 'crypto';
import { Logger } from '@nestjs/common';

const IV_LENGTH = 12; // 96-bit nonce, the recommended size for GCM
const TAG_LENGTH = 16;

/** AES-256-GCM. Output layout: iv (12) | auth tag (16) | ciphertext. */
export function aesGcmEncrypt(key: Buffer, plaintext: Buffer, aad: Buffer): Buffer {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]);
}

/** Throws if the data, the tag or the AAD was tampered with (GCM is authenticated encryption). */
export function aesGcmDecrypt(key: Buffer, blob: Buffer, aad: Buffer): Buffer {
  const iv = blob.subarray(0, IV_LENGTH);
  const tag = blob.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
  const ciphertext = blob.subarray(IV_LENGTH + TAG_LENGTH);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAAD(aad);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

export interface EncryptedSecret {
  ciphertext: Buffer;
  wrappedKey: Buffer;
  keyVersion: number;
}

/**
 * Envelope encryption, the same pattern AWS KMS / GCP KMS use:
 *  - every card gets its own random data-encryption key (DEK);
 *  - the DEK is encrypted ("wrapped") by a key-encryption key (KEK) held outside the DB;
 *  - the record id is bound in as AAD, so a ciphertext copied onto another row fails to decrypt.
 * Rotating the KEK only requires re-wrapping the 32-byte DEKs, not re-encrypting card data.
 */
export class EnvelopeCrypto {
  private readonly logger = new Logger('EnvelopeCrypto');

  constructor(
    private readonly keks: Map<number, Buffer>,
    private readonly activeVersion: number,
    private readonly fingerprintKey: Buffer,
  ) {
    if (!keks.has(activeVersion)) throw new Error(`Active KEK version ${activeVersion} is not configured`);
    for (const [version, key] of keks) {
      if (key.length !== 32) throw new Error(`KEK v${version} must be 32 bytes (got ${key.length})`);
    }
  }

  /**
   * VAULT_MASTER_KEYS="1:<base64 32 bytes>,2:<base64 32 bytes>"  VAULT_ACTIVE_KEY_VERSION=2
   * In production these would come from an HSM/KMS, never from the same place as the database.
   */
  static fromEnv(): EnvelopeCrypto {
    const devKey = createHash('sha256').update('payforge-dev-master-key-v1').digest();
    const raw = process.env.VAULT_MASTER_KEYS;
    const keks = new Map<number, Buffer>();
    if (raw) {
      for (const entry of raw.split(',')) {
        const [version, b64] = entry.split(':');
        keks.set(parseInt(version, 10), Buffer.from(b64, 'base64'));
      }
    } else {
      keks.set(1, devKey);
      if (process.env.NODE_ENV === 'production') throw new Error('VAULT_MASTER_KEYS must be set in production');
      new Logger('EnvelopeCrypto').warn('Using the built-in development KEK. Set VAULT_MASTER_KEYS for real deployments.');
    }
    const active = parseInt(process.env.VAULT_ACTIVE_KEY_VERSION ?? String(Math.max(...keks.keys())), 10);
    const fingerprintKey = process.env.VAULT_FINGERPRINT_KEY
      ? Buffer.from(process.env.VAULT_FINGERPRINT_KEY, 'base64')
      : createHash('sha256').update('payforge-dev-fingerprint-key-v1').digest();
    return new EnvelopeCrypto(keks, active, fingerprintKey);
  }

  encrypt(plaintext: string, recordId: string): EncryptedSecret {
    const dek = randomBytes(32);
    try {
      const ciphertext = aesGcmEncrypt(dek, Buffer.from(plaintext, 'utf8'), Buffer.from(recordId));
      const wrappedKey = aesGcmEncrypt(this.keks.get(this.activeVersion)!, dek, Buffer.from(`dek:${recordId}`));
      return { ciphertext, wrappedKey, keyVersion: this.activeVersion };
    } finally {
      dek.fill(0); // best-effort: don't leave key material lying around in memory
    }
  }

  decrypt(secret: EncryptedSecret, recordId: string): string {
    const kek = this.keks.get(secret.keyVersion);
    if (!kek) throw new Error(`KEK version ${secret.keyVersion} is not available`);
    const dek = aesGcmDecrypt(kek, secret.wrappedKey, Buffer.from(`dek:${recordId}`));
    try {
      return aesGcmDecrypt(dek, secret.ciphertext, Buffer.from(recordId)).toString('utf8');
    } finally {
      dek.fill(0);
    }
  }

  /**
   * Keyed fingerprint (HMAC-SHA256). The same card always gets the same fingerprint, so
   * risk rules can count velocity per card, but without the key you can't brute-force
   * the PAN back from it (a plain SHA-256 of a 16-digit PAN is trivially reversible).
   */
  fingerprint(value: string): string {
    return createHmac('sha256', this.fingerprintKey).update(value).digest('hex').slice(0, 32);
  }

  get currentKeyVersion(): number {
    return this.activeVersion;
  }
}
