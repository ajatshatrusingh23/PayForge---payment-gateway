# ADR 0003: Transactional outbox with at-least-once delivery and idempotent consumers

**Status:** accepted

## Context
After a payment is captured, the ledger, webhooks, settlement and risk must hear about it. Writing to Postgres and then publishing to Kafka is a *dual write*: if the process dies between the two (or Kafka is down), the payment exists but nobody hears about it.

## Decision
State changes insert their event into an `outbox_events` table **in the same transaction**. A relay in each producing service polls unpublished rows in id order and publishes them to Kafka (idempotent producer, acks=all), then marks them published. A transaction-scoped advisory lock keeps one relay active at a time, which preserves ordering. Consumers make effects idempotent with unique constraints (`journal_entries.event_id`, `webhook_deliveries(endpoint_id, event_id)`, `settlement_items.source_id`, `processed_events`). Failing handlers retry 5 times, then go to `payforge.dead-letter`.

## Consequences
+ No lost events, ever; payments keep working while Kafka is down (events queue in Postgres).
+ Exactly-once *effects* without distributed transactions.
− Up to ~100 ms extra latency for downstream consumers (poll interval); a CDC tool (Debezium) could replace polling at scale.
− Duplicates are possible by design, so every consumer must stay idempotent.
