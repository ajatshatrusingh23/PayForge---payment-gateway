import { Migration } from '@app/database';

export const migrations: Migration[] = [
  {
    id: '001_webhooks',
    sql: `
      CREATE TABLE webhook_endpoints (
        id             text        PRIMARY KEY,
        merchant_id    text        NOT NULL,
        url            text        NOT NULL,
        secret         text        NOT NULL, -- production: encrypt at rest / keep in a KMS
        enabled_events text[]      NOT NULL DEFAULT '{*}',
        description    text,
        status         text        NOT NULL DEFAULT 'enabled' CHECK (status IN ('enabled', 'disabled')),
        created_at     timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX webhook_endpoints_merchant_idx ON webhook_endpoints (merchant_id) WHERE status = 'enabled';

      CREATE TABLE webhook_deliveries (
        id                 text        PRIMARY KEY,
        endpoint_id        text        NOT NULL REFERENCES webhook_endpoints(id),
        merchant_id        text        NOT NULL,
        event_id           text        NOT NULL,
        event_type         text        NOT NULL,
        object_id          text,
        payload            jsonb       NOT NULL,
        status             text        NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'retrying', 'succeeded', 'dead')),
        attempts           int         NOT NULL DEFAULT 0,
        next_attempt_at    timestamptz NOT NULL DEFAULT now(),
        last_response_code int,
        last_response_body text,
        last_error         text,
        last_latency_ms    int,
        last_attempt_at    timestamptz,
        created_at         timestamptz NOT NULL DEFAULT now(),
        updated_at         timestamptz NOT NULL DEFAULT now(),
        UNIQUE (endpoint_id, event_id) -- fan-out is idempotent even if Kafka redelivers the event
      );
      CREATE INDEX webhook_deliveries_due_idx ON webhook_deliveries (next_attempt_at) WHERE status IN ('pending', 'retrying');
      CREATE INDEX webhook_deliveries_merchant_idx ON webhook_deliveries (merchant_id, created_at DESC);
      CREATE INDEX webhook_deliveries_object_idx ON webhook_deliveries (object_id);

      CREATE TABLE webhook_attempts (
        id            bigserial   PRIMARY KEY,
        delivery_id   text        NOT NULL REFERENCES webhook_deliveries(id),
        attempt       int         NOT NULL,
        response_code int,
        error         text,
        latency_ms    int         NOT NULL,
        created_at    timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX webhook_attempts_delivery_idx ON webhook_attempts (delivery_id);
    `,
  },
];
