import { Injectable } from '@nestjs/common';
import { counter, Errors, IdPrefix, newId } from '@app/common';
import { Db } from '@app/database';
import { cvcValid, detectBrand, isExpired, lookupBin, luhnValid, normalizeExpYear, validLengthForBrand } from './card';
import { CreatePaymentMethodDto } from './dto';
import { EnvelopeCrypto } from './envelope';

interface PaymentMethodRow {
  id: string;
  merchant_id: string;
  type: 'card' | 'upi';
  fingerprint: string;
  card_brand: string | null;
  card_last4: string | null;
  card_bin: string | null;
  card_exp_month: number | null;
  card_exp_year: number | null;
  card_country: string | null;
  card_issuer: string | null;
  card_funding: string | null;
  cardholder_name: string | null;
  pan_ciphertext: Buffer | null;
  dek_wrapped: Buffer | null;
  key_version: number | null;
  upi_vpa: string | null;
  created_at: Date;
}

const tokenized = counter('payforge_vault_tokenized_total', 'Payment methods tokenized', ['type', 'brand'] as const);
const revealed = counter('payforge_vault_reveals_total', 'PAN decryptions (audited)', ['caller'] as const);

@Injectable()
export class VaultService {
  private readonly crypto = EnvelopeCrypto.fromEnv();

  constructor(private readonly db: Db) {}

  async create(merchantId: string, dto: CreatePaymentMethodDto) {
    return dto.type === 'card' ? this.createCard(merchantId, dto) : this.createUpi(merchantId, dto);
  }

  private async createCard(merchantId: string, dto: CreatePaymentMethodDto) {
    const card = dto.card!;
    const pan = card.number.replace(/\s+/g, '');
    const brand = detectBrand(pan);
    if (!/^\d{12,19}$/.test(pan) || !luhnValid(pan) || !validLengthForBrand(pan, brand)) {
      throw Errors.card('incorrect_number', 'Your card number is incorrect.', 'card[number]');
    }
    if (brand === 'unknown') {
      throw Errors.card('card_not_supported', 'This card brand is not supported.', 'card[number]');
    }
    const expYear = normalizeExpYear(card.exp_year);
    if (isExpired(card.exp_month, expYear)) {
      throw Errors.card('expired_card', 'Your card has expired.', 'card[exp_year]');
    }
    if (!cvcValid(card.cvc, brand)) {
      throw Errors.card('invalid_cvc', "Your card's security code is invalid.", 'card[cvc]');
    }
    // CVC is validated here and then discarded. It is never persisted.

    const id = newId(IdPrefix.paymentMethod);
    const bin = lookupBin(pan);
    const encrypted = this.crypto.encrypt(pan, id);
    const row = await this.db.one<PaymentMethodRow>(
      `INSERT INTO payment_methods
         (id, merchant_id, type, fingerprint, card_brand, card_last4, card_bin, card_exp_month, card_exp_year,
          card_country, card_issuer, card_funding, cardholder_name, pan_ciphertext, dek_wrapped, key_version)
       VALUES ($1, $2, 'card', $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
       RETURNING *`,
      [
        id,
        merchantId,
        this.crypto.fingerprint(`card:${pan}`),
        brand,
        pan.slice(-4),
        pan.slice(0, 6),
        card.exp_month,
        expYear,
        bin.country,
        bin.issuer,
        bin.funding,
        card.name ?? null,
        encrypted.ciphertext,
        encrypted.wrappedKey,
        encrypted.keyVersion,
      ],
    );
    tokenized.inc({ type: 'card', brand });
    return this.toView(row!);
  }

  private async createUpi(merchantId: string, dto: CreatePaymentMethodDto) {
    const vpa = dto.upi!.vpa.trim().toLowerCase();
    const row = await this.db.one<PaymentMethodRow>(
      `INSERT INTO payment_methods (id, merchant_id, type, fingerprint, upi_vpa)
       VALUES ($1, $2, 'upi', $3, $4) RETURNING *`,
      [newId(IdPrefix.paymentMethod), merchantId, this.crypto.fingerprint(`upi:${vpa}`), vpa],
    );
    tokenized.inc({ type: 'upi', brand: 'upi' });
    return this.toView(row!);
  }

  async get(merchantId: string, id: string) {
    return this.toView(await this.getRow(merchantId, id));
  }

  /**
   * Decrypts the PAN for an authorised internal caller (the payment service, to send it
   * to the acquirer). Each call writes an audit record in the same transaction.
   */
  async reveal(merchantId: string, id: string, caller: string, purpose: string, requestId: string) {
    return this.db.tx(async (c) => {
      const row = await this.db.one<PaymentMethodRow>('SELECT * FROM payment_methods WHERE id = $1 AND merchant_id = $2', [id, merchantId], c);
      if (!row) throw Errors.notFound('payment_method', id);
      await c.query(
        `INSERT INTO vault_access_log (payment_method_id, merchant_id, caller, purpose, request_id) VALUES ($1, $2, $3, $4, $5)`,
        [id, merchantId, caller, purpose, requestId || null],
      );
      revealed.inc({ caller });
      if (row.type === 'upi') return { type: 'upi' as const, vpa: row.upi_vpa };
      const pan = this.crypto.decrypt(
        { ciphertext: row.pan_ciphertext!, wrappedKey: row.dek_wrapped!, keyVersion: row.key_version! },
        row.id,
      );
      return {
        type: 'card' as const,
        pan,
        exp_month: row.card_exp_month,
        exp_year: row.card_exp_year,
        name: row.cardholder_name,
      };
    });
  }

  async accessLog(merchantId: string, paymentMethodId?: string) {
    const rows = await this.db.many(
      `SELECT payment_method_id, caller, purpose, request_id, accessed_at FROM vault_access_log
       WHERE merchant_id = $1 AND ($2::text IS NULL OR payment_method_id = $2)
       ORDER BY id DESC LIMIT 100`,
      [merchantId, paymentMethodId ?? null],
    );
    return { object: 'list', data: rows };
  }

  private async getRow(merchantId: string, id: string): Promise<PaymentMethodRow> {
    const row = await this.db.one<PaymentMethodRow>('SELECT * FROM payment_methods WHERE id = $1 AND merchant_id = $2', [id, merchantId]);
    if (!row) throw Errors.notFound('payment_method', id);
    return row;
  }

  private toView(row: PaymentMethodRow) {
    return {
      id: row.id,
      object: 'payment_method',
      type: row.type,
      fingerprint: row.fingerprint,
      ...(row.type === 'card'
        ? {
            card: {
              brand: row.card_brand,
              last4: row.card_last4,
              exp_month: row.card_exp_month,
              exp_year: row.card_exp_year,
              country: row.card_country,
              issuer: row.card_issuer,
              funding: row.card_funding,
            },
          }
        : { upi: { vpa: row.upi_vpa } }),
      created_at: row.created_at,
    };
  }
}
