import { Migration } from '@app/database';

export const migrations: Migration[] = [
  {
    id: '001_payment_methods',
    sql: `
      -- PCI DSS: the PAN is stored only encrypted; CVC is never stored at all (PCI DSS 3.3.1).
      CREATE TABLE payment_methods (
        id              text        PRIMARY KEY,
        merchant_id     text        NOT NULL,
        type            text        NOT NULL CHECK (type IN ('card', 'upi')),
        fingerprint     text        NOT NULL,
        card_brand      text,
        card_last4      text,
        card_bin        text,
        card_exp_month  int,
        card_exp_year   int,
        card_country    text,
        card_issuer     text,
        card_funding    text,
        cardholder_name text,
        pan_ciphertext  bytea,
        dek_wrapped     bytea,
        key_version     int,
        upi_vpa         text,
        created_at      timestamptz NOT NULL DEFAULT now(),
        CHECK (type <> 'card' OR (pan_ciphertext IS NOT NULL AND dek_wrapped IS NOT NULL AND key_version IS NOT NULL))
      );
      CREATE INDEX payment_methods_merchant_idx ON payment_methods (merchant_id, created_at DESC);
      CREATE INDEX payment_methods_fingerprint_idx ON payment_methods (fingerprint);

      -- Every decryption is audited: who, why, when.
      CREATE TABLE vault_access_log (
        id                bigserial   PRIMARY KEY,
        payment_method_id text        NOT NULL REFERENCES payment_methods(id),
        merchant_id       text        NOT NULL,
        caller            text        NOT NULL,
        purpose           text        NOT NULL,
        request_id        text,
        accessed_at       timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX vault_access_log_pm_idx ON vault_access_log (payment_method_id);
    `,
  },
];
