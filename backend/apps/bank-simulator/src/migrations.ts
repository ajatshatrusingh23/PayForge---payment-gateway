import { Migration } from '@app/database';

export const migrations: Migration[] = [
  {
    id: '001_bank_transactions',
    sql: `
      CREATE TABLE bank_transactions (
        id             text        PRIMARY KEY,
        acquirer       text        NOT NULL,
        merchant_ref   text        NOT NULL,
        merchant_id    text,
        type           text        NOT NULL CHECK (type IN ('sale', 'auth', 'capture', 'void', 'refund')),
        method         text        NOT NULL,
        amount         bigint      NOT NULL CHECK (amount > 0),
        currency       text        NOT NULL DEFAULT 'INR',
        status         text        NOT NULL CHECK (status IN ('approved', 'declined', 'requires_otp', 'pending')),
        captured       boolean     NOT NULL DEFAULT false,
        decline_code   text,
        parent_id      text        REFERENCES bank_transactions(id),
        otp_attempts   int         NOT NULL DEFAULT 0,
        resolve_at     timestamptz,
        upi_vpa        text,
        callback_url   text,
        fee            bigint      NOT NULL DEFAULT 0,
        approved_at    timestamptz,
        created_at     timestamptz NOT NULL DEFAULT now(),
        updated_at     timestamptz NOT NULL DEFAULT now(),
        -- The acquirer de-duplicates on the merchant's reference, so a retried
        -- authorization can never create a second charge.
        UNIQUE (acquirer, merchant_ref, type)
      );
      CREATE INDEX bank_transactions_report_idx ON bank_transactions (acquirer, approved_at) WHERE status = 'approved';
      CREATE INDEX bank_transactions_pending_idx ON bank_transactions (resolve_at) WHERE status = 'pending';
    `,
  },
];
