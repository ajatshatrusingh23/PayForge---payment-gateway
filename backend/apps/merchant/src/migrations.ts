import { Migration } from '@app/database';

export const migrations: Migration[] = [
  {
    id: '001_merchants_and_keys',
    sql: `
      CREATE TABLE merchants (
        id                 text        PRIMARY KEY,
        name               text        NOT NULL,
        email              text        NOT NULL UNIQUE,
        password_hash      text        NOT NULL,
        business_name      text        NOT NULL,
        kyc_status         text        NOT NULL DEFAULT 'pending' CHECK (kyc_status IN ('pending', 'approved', 'rejected')),
        pan_masked         text,
        settlement_account jsonb,
        fee_bps            int         NOT NULL DEFAULT 200 CHECK (fee_bps BETWEEN 0 AND 1000),
        created_at         timestamptz NOT NULL DEFAULT now()
      );

      -- Secret keys are stored only as a SHA-256 hash (like a password, but keys are
      -- 190-bit random so a fast hash is safe and keeps per-request auth cheap).
      CREATE TABLE api_keys (
        id              text        PRIMARY KEY,
        merchant_id     text        NOT NULL REFERENCES merchants(id),
        type            text        NOT NULL CHECK (type IN ('secret', 'publishable')),
        key_hash        text        NOT NULL UNIQUE,
        key_prefix      text        NOT NULL,
        last4           text        NOT NULL,
        publishable_key text,
        created_at      timestamptz NOT NULL DEFAULT now(),
        revoked_at      timestamptz,
        last_used_at    timestamptz
      );
      CREATE INDEX api_keys_merchant_idx ON api_keys (merchant_id);
    `,
  },
];
