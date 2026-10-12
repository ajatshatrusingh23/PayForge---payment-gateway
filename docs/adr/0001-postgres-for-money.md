# ADR 0001: PostgreSQL (with raw SQL) for everything that touches money

**Status:** accepted

## Context
Payments need atomic multi-row updates (payment + attempt + outbox event), row-level locking (two refunds racing on one payment), and invariants that must hold even if application code has a bug (a journal must balance; a refund can't exceed the captured amount).

## Decision
Every service that holds state uses PostgreSQL 16, one database per service, accessed with raw SQL through a thin `Db` helper (`query`, `one`, `many`, `tx` with retry on serialization failures and deadlocks). Invariants live in the schema: `CHECK` constraints (`amount_refunded <= amount_received`), unique constraints (idempotency, de-duplication) and triggers (balanced, append-only ledger). Money is `bigint` paise.

## Consequences
+ ACID guarantees, `SELECT … FOR UPDATE`, `SKIP LOCKED` work queues and advisory locks are all available.
+ Raw SQL makes the locking and constraints explicit and reviewable (an ORM hides exactly the parts that matter here).
− More SQL to write and no generated types; mitigated by typed row interfaces and the e2e suite.
− Vertical scaling limits; mitigated by database-per-service and keeping hot paths short.
