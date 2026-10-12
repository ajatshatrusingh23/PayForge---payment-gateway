import { Migration } from '@app/database';
import { OUTBOX_MIGRATION, OUTBOX_TRACE_MIGRATION } from '@app/messaging';

export const migrations: Migration[] = [
  OUTBOX_MIGRATION,
  OUTBOX_TRACE_MIGRATION,
  {
    id: '001_settlement',
    sql: `
      -- Our side of the books: one row per captured payment / succeeded refund.
      CREATE TABLE settlement_items (
        id                text        PRIMARY KEY,
        merchant_id       text        NOT NULL,
        type              text        NOT NULL CHECK (type IN ('payment', 'refund')),
        source_id         text        NOT NULL UNIQUE,  -- pi_ / re_: makes event consumption idempotent
        payment_intent_id text        NOT NULL,
        merchant_ref      text        NOT NULL,         -- the reference the acquirer knows us by
        acquirer          text        NOT NULL,
        acquirer_ref      text,
        amount            bigint      NOT NULL CHECK (amount > 0),
        fee               bigint      NOT NULL DEFAULT 0,
        gst               bigint      NOT NULL DEFAULT 0,
        net               bigint      NOT NULL,         -- signed effect on what we owe the merchant
        acquirer_fee      bigint      NOT NULL DEFAULT 0,
        occurred_at       timestamptz NOT NULL,
        recon_status      text        NOT NULL DEFAULT 'unreconciled'
                          CHECK (recon_status IN ('unreconciled', 'matched', 'mismatch', 'missing_in_acquirer')),
        recon_run_id      text,
        payout_id         text,
        created_at        timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX settlement_items_recon_idx ON settlement_items (acquirer, recon_status);
      CREATE INDEX settlement_items_payout_idx ON settlement_items (merchant_id, recon_status) WHERE payout_id IS NULL;
      CREATE INDEX settlement_items_ref_idx ON settlement_items (merchant_ref);

      -- The acquirer's side: every report line is ingested exactly once.
      CREATE TABLE acquirer_report_lines (
        acquirer_ref     text        PRIMARY KEY,
        acquirer         text        NOT NULL,
        business_date    date        NOT NULL,
        merchant_ref     text        NOT NULL,
        type             text        NOT NULL,
        amount           bigint      NOT NULL,
        fee              bigint      NOT NULL,
        approved_at      timestamptz NOT NULL,
        ingested_run_id  text        NOT NULL,
        ingested_at      timestamptz NOT NULL DEFAULT now(),
        matched_item_id  text,
        exception_raised boolean     NOT NULL DEFAULT false
      );
      CREATE INDEX acquirer_report_lines_unmatched_idx ON acquirer_report_lines (acquirer) WHERE matched_item_id IS NULL;

      CREATE TABLE recon_runs (
        id                  text        PRIMARY KEY,
        acquirer            text        NOT NULL,
        business_date       date        NOT NULL,
        lines_ingested      int         NOT NULL,
        matched             int         NOT NULL,
        mismatched          int         NOT NULL,
        missing_in_acquirer int         NOT NULL,
        missing_in_platform int         NOT NULL,
        platform_amount     bigint      NOT NULL,
        acquirer_amount     bigint      NOT NULL,
        net_settlement      bigint      NOT NULL,
        created_at          timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX recon_runs_created_idx ON recon_runs (created_at DESC);

      CREATE TABLE recon_exceptions (
        id                 bigserial   PRIMARY KEY,
        run_id             text        NOT NULL REFERENCES recon_runs(id),
        type               text        NOT NULL CHECK (type IN ('amount_mismatch', 'missing_in_acquirer', 'missing_in_platform')),
        merchant_id        text,
        merchant_ref       text,
        acquirer_ref       text,
        settlement_item_id text,
        platform_amount    bigint,
        acquirer_amount    bigint,
        details            text,
        status             text        NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
        created_at         timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX recon_exceptions_run_idx ON recon_exceptions (run_id);

      CREATE TABLE payouts (
        id          text        PRIMARY KEY,
        merchant_id text        NOT NULL,
        amount      bigint      NOT NULL CHECK (amount > 0),
        item_count  int         NOT NULL,
        status      text        NOT NULL CHECK (status IN ('paid', 'failed')),
        utr         text,
        destination jsonb,
        created_at  timestamptz NOT NULL DEFAULT now(),
        paid_at     timestamptz
      );
      CREATE INDEX payouts_merchant_idx ON payouts (merchant_id, created_at DESC);
    `,
  },
];
