import { IDEMPOTENCY_MIGRATION, Migration } from '@app/database';
import { OUTBOX_MIGRATION, OUTBOX_TRACE_MIGRATION } from '@app/messaging';

export const migrations: Migration[] = [
  IDEMPOTENCY_MIGRATION,
  OUTBOX_MIGRATION,
  OUTBOX_TRACE_MIGRATION,
  {
    id: '001_payments',
    sql: `
      CREATE TABLE payment_intents (
        id                     text        PRIMARY KEY,
        merchant_id            text        NOT NULL,
        amount                 bigint      NOT NULL CHECK (amount > 0),
        currency               text        NOT NULL DEFAULT 'INR',
        status                 text        NOT NULL,
        capture_method         text        NOT NULL DEFAULT 'automatic' CHECK (capture_method IN ('automatic', 'manual')),
        client_secret          text        NOT NULL,
        description            text,
        statement_descriptor   text,
        customer_email         text,
        metadata               jsonb       NOT NULL DEFAULT '{}',
        payment_method_types   text[]      NOT NULL DEFAULT '{card,upi}',
        payment_method_id      text,
        payment_method_type    text,
        payment_method_details jsonb,
        amount_capturable      bigint      NOT NULL DEFAULT 0,
        amount_received        bigint      NOT NULL DEFAULT 0,
        amount_refunded        bigint      NOT NULL DEFAULT 0,
        fee_bps                int         NOT NULL,
        fee                    bigint      NOT NULL DEFAULT 0,
        gst                    bigint      NOT NULL DEFAULT 0,
        acquirer               text,
        acquirer_ref           text,
        last_payment_error     jsonb,
        next_action            jsonb,
        risk_score             int,
        risk_decision          text,
        attempt_count          int         NOT NULL DEFAULT 0,
        cancellation_reason    text,
        version                int         NOT NULL DEFAULT 0,
        created_at             timestamptz NOT NULL DEFAULT now(),
        updated_at             timestamptz NOT NULL DEFAULT now(),
        expires_at             timestamptz NOT NULL,
        captured_at            timestamptz,
        canceled_at            timestamptz,
        CONSTRAINT amounts_consistent CHECK (
          amount_received <= amount AND amount_refunded <= amount_received AND amount_capturable <= amount
        )
      );
      CREATE INDEX payment_intents_merchant_idx ON payment_intents (merchant_id, created_at DESC, id DESC);
      CREATE INDEX payment_intents_expiry_idx ON payment_intents (expires_at)
        WHERE status IN ('created', 'failed', 'requires_action');

      CREATE TABLE payment_attempts (
        id                text        PRIMARY KEY,
        payment_intent_id text        NOT NULL REFERENCES payment_intents(id),
        merchant_id       text        NOT NULL,
        acquirer          text        NOT NULL,
        method            text        NOT NULL,
        status            text        NOT NULL,
        acquirer_ref      text,
        decline_code      text,
        error_message     text,
        latency_ms        int,
        checks            int         NOT NULL DEFAULT 0,
        next_check_at     timestamptz,
        created_at        timestamptz NOT NULL DEFAULT now(),
        updated_at        timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX payment_attempts_pi_idx ON payment_attempts (payment_intent_id, created_at);
      CREATE INDEX payment_attempts_open_idx ON payment_attempts (next_check_at)
        WHERE status IN ('initiated', 'pending', 'unknown');
      CREATE INDEX payment_attempts_merchant_idx ON payment_attempts (merchant_id, created_at DESC);

      CREATE TABLE refunds (
        id                text        PRIMARY KEY,
        payment_intent_id text        NOT NULL REFERENCES payment_intents(id),
        merchant_id       text        NOT NULL,
        amount            bigint      NOT NULL CHECK (amount > 0),
        currency          text        NOT NULL DEFAULT 'INR',
        status            text        NOT NULL CHECK (status IN ('pending', 'succeeded', 'failed')),
        reason            text,
        acquirer          text        NOT NULL,
        acquirer_ref      text,
        failure_reason    text,
        created_at        timestamptz NOT NULL DEFAULT now(),
        updated_at        timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX refunds_pi_idx ON refunds (payment_intent_id);
      CREATE INDEX refunds_merchant_idx ON refunds (merchant_id, created_at DESC);
      CREATE INDEX refunds_pending_idx ON refunds (updated_at) WHERE status = 'pending';
    `,
  },
  {
    id: '002_status_check_index',
    sql: `
      -- OTP attempts can also be scheduled for a status check (when recording the bank's answer failed).
      DROP INDEX IF EXISTS payment_attempts_open_idx;
      CREATE INDEX payment_attempts_open_idx ON payment_attempts (next_check_at)
        WHERE status IN ('initiated', 'pending', 'unknown', 'requires_otp');
    `,
  },
];
