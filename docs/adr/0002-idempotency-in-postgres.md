# ADR 0002: Idempotency keys stored in Postgres, with the primary key as the lock

**Status:** accepted

## Context
Clients retry POSTs after timeouts. Without protection, a retried `create` or `confirm` can charge a customer twice. The common Redis-lock approach (`SET NX` + TTL) has edge cases: the lock expires while the first request is still running, or Redis restarts and forgets the key.

## Decision
An interceptor on POST endpoints does `INSERT INTO idempotency_keys (merchant_id, key, request_hash, status='in_progress') ON CONFLICT DO NOTHING`.
- Inserted → this request owns the key; the response (2xx or card error 402) is stored with the key.
- Conflict + same request hash + completed → replay the stored response with `idempotent-replayed: true`.
- Conflict + different hash → `400 idempotency_key_reused`.
- Conflict + still in progress → `409 idempotency_key_in_use` (a lock older than 60 s is taken over: crash recovery).
- Validation errors and 5xx release the key so the client can fix the request and retry.
Keys are scoped per merchant and purged after 24 h.

## Consequences
+ One atomic statement decides the winner; there is no race window and no TTL to tune.
+ Survives restarts; replays are byte-for-byte identical.
− One extra write per idempotent request (cheap compared with the bank call).
Verified by an e2e test: 50 concurrent identical requests produce exactly 1 PaymentIntent.
