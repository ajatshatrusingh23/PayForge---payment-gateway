import { Migration } from '@app/database';
import { PROCESSED_EVENTS_MIGRATION } from '@app/messaging';

export const migrations: Migration[] = [
  PROCESSED_EVENTS_MIGRATION,
  {
    id: '001_risk',
    sql: `
      CREATE TABLE risk_assessments (
        id                text        PRIMARY KEY,
        merchant_id       text        NOT NULL,
        payment_intent_id text        NOT NULL,
        score             int         NOT NULL CHECK (score BETWEEN 0 AND 100),
        decision          text        NOT NULL CHECK (decision IN ('allow', 'challenge', 'block')),
        reasons           jsonb       NOT NULL,
        signals           jsonb       NOT NULL,
        latency_ms        int         NOT NULL,
        created_at        timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX risk_assessments_pi_idx ON risk_assessments (payment_intent_id);
      CREATE INDEX risk_assessments_merchant_idx ON risk_assessments (merchant_id, created_at DESC);

      CREATE TABLE blocklist (
        id          text        PRIMARY KEY,
        merchant_id text        NOT NULL,
        type        text        NOT NULL CHECK (type IN ('fingerprint', 'email', 'ip', 'vpa')),
        value       text        NOT NULL,
        reason      text,
        created_at  timestamptz NOT NULL DEFAULT now(),
        UNIQUE (merchant_id, type, value)
      );
    `,
  },
];
