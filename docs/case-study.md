# Case study: surviving a Diwali flash sale

## Context

**ChaiCart** is a (fictional) Indian D2C tea brand. For its Diwali sale it expects about 10× normal traffic for a few hours. Its first payment integration was the common one: one payment provider, a "Pay" button, and order status updated when the customer's browser came back from the payment page.

On a normal day that works. Under sale conditions it breaks in ways that cost real money and trust:

| What happens under load | What the naive integration does | Business impact |
|---|---|---|
| Customer's network drops after clicking Pay; the app retries | Creates a second payment, **charges twice** | Refunds, support tickets, chargebacks |
| The bank answers slowly and the request times out | Shows "failed", but the bank already debited the customer | Customer pays, gets no order |
| The single acquiring bank has an outage | **Every** payment fails until it recovers | Revenue loss at peak |
| Customer closes the tab before the redirect | Order never marked paid | Paid orders left unshipped |
| Webhook endpoint briefly down during a deploy | Events lost | Silent inconsistencies |
| Bots test stolen cards against the checkout | Thousands of small authorizations | Fraud losses, acquirer penalties |
| Month-end: "why is our bank balance ₹3,200 short?" | Nobody can tell | Manual reconciliation in spreadsheets |

## Goal

Design the gateway side so that a merchant like ChaiCart gets correct money movement under retries, timeouts, outages and fraud, and can *prove* it. Non-goals: moving real money, card-network certification, multi-region deployment.

## Key decisions

| Decision | Alternative considered | Why this one | ADR |
|---|---|---|---|
| PostgreSQL with explicit transactions and row locks for money | MongoDB / eventual consistency | Ledger and refund limits need ACID and constraints *in the database* | [0001](adr/0001-postgres-for-money.md) |
| Idempotency keys stored in Postgres; the primary key is the lock | Redis `SET NX` lock + separate store | One atomic statement, no TTL races, survives restarts | [0002](adr/0002-idempotency-in-postgres.md) |
| Transactional outbox → Kafka | Publish to Kafka after commit | Removes the dual-write problem; payments work while Kafka is down | [0003](adr/0003-transactional-outbox.md) |
| At-least-once delivery + idempotent consumers | "Exactly-once" Kafka transactions | Simpler and works across DB boundaries; uniqueness constraints give exactly-once *effects* | [0003](adr/0003-transactional-outbox.md) |
| Never retry a timed-out authorization on another acquirer | Retry everything | A timeout means "unknown", and retrying elsewhere can double-charge | [0004](adr/0004-timeouts-are-unknown.md) |
| Health-scored routing + circuit breakers + cascade on technical errors | Static primary/secondary failover | Reacts to partial degradation, not just hard outages | [0005](adr/0005-smart-routing.md) |
| Double-entry ledger with DB-enforced balance and immutability | A `balance` column | Every rupee is explainable; bugs can't silently create money | [0006](adr/0006-double-entry-ledger.md) |
| Envelope encryption in a dedicated vault service | Encrypt with one app key | Keeps card data in one small service; key rotation re-wraps 32-byte keys only | [0007](adr/0007-vault-envelope-encryption.md) |
| Risk fails *safe* (to OTP challenge), not open or closed | Allow or block when risk is down | A risk outage neither lets fraud through nor blocks honest customers | [0008](adr/0008-risk-fails-safe.md) |

## How each failure is now handled

- **Double clicks and retries.** The merchant sends `Idempotency-Key: order-<id>`. Retries return the stored response (`idempotent-replayed: true`); 50 concurrent identical requests create exactly one payment. A second, concurrent confirm on the same payment is rejected by the row lock and state machine, so 10 parallel confirms produce one charge.
- **Bank timeouts.** The attempt is marked `unknown` and the payment `pending` ("confirming with your bank…"). A status-check worker asks *the same* bank using our attempt id and resolves it within seconds. No second bank is ever tried.
- **Acquirer outage.** The router stops sending traffic to the failing bank: per-request cascade first, then score demotion, then the circuit breaker opens.
- **Tab closed.** The order is marked paid only by the signed `payment_intent.captured` webhook, which is retried with backoff for ~10 minutes, then dead-lettered and replayable.
- **Card testing.** Velocity windows per card, IP and email, a decline-streak signal and blocklists step suspicious payments up to OTP or block them before any bank is contacted.
- **Month-end questions.** Every movement is a balanced journal. Reconciliation matches each line of the bank's settlement file to our records, and mismatches hold the payout and appear as exceptions.

## Results (measured)

Single laptop, all services plus Postgres, Redis and Kafka running together, full three-call payment flow (create → tokenize → confirm) with simulated bank latency of 60–220 ms:

| Metric | Result |
|---|---|
| Sustained throughput | **137.7 payments/s** (413 API requests/s) |
| Success rate | **100%** of 4,175 payments |
| Confirm latency | p50 259 ms · p95 363 ms · p99 418 ms |

**AlphaBank outage, 10 s in the middle of a 30 s run, 30 concurrent customers:**

| | Naive single acquirer | PayForge smart routing |
|---|---:|---:|
| Success rate **during** the outage | 0.85% | **99.55%** |
| Success rate overall | 44.35% | **99.63%** |
| Confirm p95 | 203 ms (failing fast) | 329 ms |

The naive setup also stays degraded *after* the bank recovers, because its only acquirer's circuit breaker is still open. Smart routing had already moved traffic away and probes the recovered bank in the background.

Correctness under concurrency (end-to-end suite): idempotency storm → 1 payment; 10 parallel confirms → 1 charge; 20 parallel refunds on ₹499 → exactly ₹400 refunded; ledger balanced after every run.

## Something the chaos test caught

The first chaos run looked catastrophic: smart routing had *0%* success after the outage. Investigation showed that the risk engine's "decline streak" signal (two or more recent declines on a card suggests card testing) was counting **technical** failures, such as "all acquirers unavailable", as if the customer's bank had declined the card. During an outage every customer's card collected "declines", so afterwards legitimate payments were challenged with OTP.

The fix was to classify every failure as `issuer`, `technical` or `risk` in the event, and let only issuer declines feed fraud signals. The lesson: **an infrastructure incident must never leak into customer risk scores.** In production this kind of bug turns a 10-minute bank outage into hours of false fraud flags.

## Fault injection: starving the database

The second bug was found by deliberately breaking our own infrastructure. Running the containerized stack on a 2-CPU VM under a k6 chaos test, two payments came back `failed` with `processing_error`, yet the bank's records showed both as **approved**: the customer was charged for a "failed" payment.

**Cause.** The confirm path wrapped *both* the bank call and the recording of its answer in one `try`. When our own database pool timed out *after* the bank had answered, the error was treated like a bank failure and the payment was failed.

**Fix.** Once a bank has answered, our own failures may never fail the payment. The attempt row was written before the bank call (write-ahead), so if recording the answer fails, the attempt stays open and the status-check worker fetches the answer from the bank again. The customer sees "processing" for a moment, then success. A sweeper also fails payments that died in `processing` *before* reaching any bank (no money moved).

**Proof.** The payment service was run with a 2-connection pool and a 30 ms connect timeout, under 40 concurrent customers, then the pool was restored:

| | Result |
|---|---:|
| Database pool timeouts injected | 1,468 |
| Bank answers whose recording failed (deferred to the status checker) | 158 |
| Payments the bank approved during the test | 2,566 |
| …of which not captured in PayForge afterwards | **0** |
| Payments left stuck in `processing` | **0** |
| Payments that failed before reaching a bank, cleaned up by the sweeper | 57 (no money moved) |

**Defence in depth.** Reconciliation independently flagged both payments broken by the old code as `missing_in_platform` (₹499 each, settled by the bank but not successful in our records), the exception an operator would refund. The fix prevents the bug; reconciliation catches whatever slips through.

## What I'd do next

- Replace the shared internal token with mTLS (service mesh) and move the vault KEKs to a KMS or HSM.
- Partitioned balance rows for hot ledger accounts (the platform fee account is written on every payment).
- Multi-armed-bandit routing tuned per BIN range and issuer, not just per acquirer.
- An ML risk score (gradient boosting on velocity and device features) alongside the rules, with the rules kept as guardrails.
- Automatic refund of `missing_in_platform` reconciliation exceptions (late approvals after a timeout).
