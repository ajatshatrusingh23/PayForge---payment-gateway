import { Inject, Injectable } from '@nestjs/common';
import bcrypt from 'bcryptjs';
import type { PoolClient } from 'pg';
import {
  API_KEY_CACHE_PREFIX,
  Errors,
  IdPrefix,
  newId,
  randomString,
  REDIS,
  RedisClient,
  sha256,
  signDashboardToken,
} from '@app/common';
import { Db } from '@app/database';
import { KycDto, LoginDto, SignupDto } from './dto';

interface MerchantRow {
  id: string;
  name: string;
  email: string;
  password_hash: string;
  business_name: string;
  kyc_status: string;
  pan_masked: string | null;
  settlement_account: Record<string, string> | null;
  fee_bps: number;
  created_at: Date;
}

type KeyType = 'secret' | 'publishable';

const API_KEY_PATTERN = /^(sk|pk)_test_[A-Za-z0-9]{32}$/;
// Used to keep login timing identical whether or not the email exists (prevents user enumeration).
const DUMMY_HASH = bcrypt.hashSync('payforge-timing-equaliser', 10);

@Injectable()
export class MerchantService {
  constructor(
    private readonly db: Db,
    @Inject(REDIS) private readonly redis: RedisClient,
  ) {}

  async signup(dto: SignupDto) {
    const email = dto.email.trim().toLowerCase();
    const passwordHash = await bcrypt.hash(dto.password, 10);
    const id = newId(IdPrefix.merchant, 16);
    try {
      return await this.db.tx(async (c) => {
        await c.query(
          `INSERT INTO merchants (id, name, email, password_hash, business_name) VALUES ($1, $2, $3, $4, $5)`,
          [id, dto.name.trim(), email, passwordHash, dto.business_name.trim()],
        );
        const publishable = await this.issueKey(c, id, 'publishable');
        const secret = await this.issueKey(c, id, 'secret');
        const merchant = (await this.db.one<MerchantRow>('SELECT * FROM merchants WHERE id = $1', [id], c))!;
        return {
          merchant: this.toView(merchant),
          api_keys: { publishable_key: publishable, secret_key: secret },
          token: signDashboardToken({ sub: id, email }),
          notice: 'Store your secret key now. For security it is only shown once.',
        };
      });
    } catch (err) {
      if ((err as { code?: string }).code === '23505') {
        throw Errors.conflict('email_taken', 'An account with this email already exists');
      }
      throw err;
    }
  }

  async login(dto: LoginDto) {
    const merchant = await this.db.one<MerchantRow>('SELECT * FROM merchants WHERE email = $1', [dto.email.trim().toLowerCase()]);
    const ok = await bcrypt.compare(dto.password, merchant?.password_hash ?? DUMMY_HASH);
    if (!merchant || !ok) throw Errors.unauthorized('Invalid email or password');
    return { merchant: this.toView(merchant), token: signDashboardToken({ sub: merchant.id, email: merchant.email }) };
  }

  async me(merchantId: string) {
    return this.toView(await this.getRow(merchantId));
  }

  async listKeys(merchantId: string) {
    const rows = await this.db.many<{
      id: string;
      type: KeyType;
      key_prefix: string;
      last4: string;
      publishable_key: string | null;
      created_at: Date;
      revoked_at: Date | null;
      last_used_at: Date | null;
    }>(`SELECT * FROM api_keys WHERE merchant_id = $1 ORDER BY revoked_at NULLS FIRST, created_at DESC`, [merchantId]);
    return {
      object: 'list',
      data: rows.map((k) => ({
        id: k.id,
        object: 'api_key',
        type: k.type,
        key: k.publishable_key ?? `${k.key_prefix}${'•'.repeat(12)}${k.last4}`,
        status: k.revoked_at ? 'revoked' : 'active',
        created_at: k.created_at,
        last_used_at: k.last_used_at,
        revoked_at: k.revoked_at,
      })),
    };
  }

  /** Revokes all active secret keys and issues a new one (e.g. after a suspected leak). */
  async rollSecretKey(merchantId: string) {
    const { secret, revokedHashes } = await this.db.tx(async (c) => {
      const revoked = await c.query<{ key_hash: string }>(
        `UPDATE api_keys SET revoked_at = now() WHERE merchant_id = $1 AND type = 'secret' AND revoked_at IS NULL RETURNING key_hash`,
        [merchantId],
      );
      return { secret: await this.issueKey(c, merchantId, 'secret'), revokedHashes: revoked.rows.map((r) => r.key_hash) };
    });
    // Evict the gateway's auth cache so the old key stops working immediately, not after the cache TTL.
    if (revokedHashes.length) {
      await this.redis.del(...revokedHashes.map((h) => `${API_KEY_CACHE_PREFIX}${h}`)).catch(() => undefined);
    }
    return { secret_key: secret, notice: 'The previous secret key has been revoked.' };
  }

  /** Mock KYC: validates formats and approves instantly. Settlement is blocked until KYC is approved. */
  async submitKyc(merchantId: string, dto: KycDto) {
    const panMasked = `${dto.pan.slice(0, 3)}****${dto.pan.slice(7)}`;
    const account = {
      account_holder_name: dto.account_holder_name,
      account_number_last4: dto.bank_account_number.slice(-4),
      ifsc: dto.ifsc,
      bank_code: dto.ifsc.slice(0, 4),
    };
    const row = await this.db.one<MerchantRow>(
      `UPDATE merchants SET kyc_status = 'approved', pan_masked = $2, settlement_account = $3::jsonb
       WHERE id = $1 RETURNING *`,
      [merchantId, panMasked, JSON.stringify(account)],
    );
    if (!row) throw Errors.notFound('merchant', merchantId);
    return this.toView(row);
  }

  async authenticateKey(key: string) {
    if (!API_KEY_PATTERN.test(key)) throw Errors.unauthorized();
    const row = await this.db.one<{ id: string; merchant_id: string; type: KeyType; last_used_at: Date | null }>(
      `SELECT id, merchant_id, type, last_used_at FROM api_keys WHERE key_hash = $1 AND revoked_at IS NULL`,
      [sha256(key)],
    );
    if (!row) throw Errors.unauthorized();
    // Throttle last_used_at writes: at most once a minute per key, so a hot key causes no write load.
    if (!row.last_used_at || Date.now() - row.last_used_at.getTime() > 60_000) {
      void this.db.query('UPDATE api_keys SET last_used_at = now() WHERE id = $1', [row.id]).catch(() => undefined);
    }
    return { merchant_id: row.merchant_id, key_type: row.type, key_id: row.id };
  }

  async getInternal(merchantId: string) {
    const m = await this.getRow(merchantId);
    return {
      id: m.id,
      business_name: m.business_name,
      email: m.email,
      fee_bps: m.fee_bps,
      kyc_status: m.kyc_status,
      settlement_account: m.settlement_account,
    };
  }

  async listIds() {
    const rows = await this.db.many<{ id: string }>('SELECT id FROM merchants ORDER BY created_at');
    return { data: rows.map((r) => r.id) };
  }

  private async issueKey(c: PoolClient, merchantId: string, type: KeyType): Promise<string> {
    const key = `${type === 'secret' ? 'sk' : 'pk'}_test_${randomString(32)}`;
    await c.query(
      `INSERT INTO api_keys (id, merchant_id, type, key_hash, key_prefix, last4, publishable_key)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [newId(IdPrefix.apiKey, 16), merchantId, type, sha256(key), key.slice(0, 12), key.slice(-4), type === 'publishable' ? key : null],
    );
    return key;
  }

  private async getRow(merchantId: string): Promise<MerchantRow> {
    const row = await this.db.one<MerchantRow>('SELECT * FROM merchants WHERE id = $1', [merchantId]);
    if (!row) throw Errors.notFound('merchant', merchantId);
    return row;
  }

  private toView(m: MerchantRow) {
    return {
      id: m.id,
      object: 'merchant',
      name: m.name,
      email: m.email,
      business_name: m.business_name,
      kyc_status: m.kyc_status,
      pan: m.pan_masked,
      settlement_account: m.settlement_account,
      pricing: { fee_bps: m.fee_bps, gst_on_fee: '18%' },
      created_at: m.created_at,
    };
  }
}
