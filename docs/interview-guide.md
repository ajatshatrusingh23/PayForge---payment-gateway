# Interview guide

How to present PayForge on a CV and in interviews: what to say, what to show, and the questions you're likely to get, with answers grounded in this codebase. Re-run `npm run load` and `npm run load:chaos` on your own machine before an interview so you quote numbers you've seen yourself.

## CV entry

**PayForge: Payment Gateway (Stripe/Razorpay-style)** · *NestJS, TypeScript, PostgreSQL, Kafka, Redis, Next.js, Docker* · [GitHub link] · [demo video]

- Built a payment gateway from scratch as **9 NestJS microservices** (API gateway, payments, card vault, risk engine, double-entry ledger, webhooks, settlement and reconciliation, bank simulator) with a hosted checkout, a **1.6 KB JS SDK** and a Next.js merchant dashboard.
- Designed **smart routing** across 3 acquirers with health scoring, circuit breakers and cascading. During a simulated acquirer outage, success rate held at **99.55% vs 0.85%** for single-acquirer routing.
- Guaranteed **no double charges**: Postgres-backed idempotency keys (50 concurrent retries → 1 payment), row-locked state machine (10 parallel confirms → 1 charge), and timeouts treated as *unknown* and resolved by status checks, never retried elsewhere.
- Implemented an **append-only double-entry ledger** whose balance and immutability are enforced by Postgres triggers, plus **reconciliation** of bank settlement files that holds payouts on mismatches.
- Made event delivery reliable with a **transactional outbox → Kafka** and idempotent consumers; **HMAC-signed webhooks** with exponential backoff, dead-lettering and replay.
- Sustained **~138 payments/s (413 req/s) at 100% success, p95 confirm 363 ms** on a laptop; 79 unit tests (including property-based), 30 e2e scenarios, k6 load and chaos tests, CI on GitHub Actions.
- Proved crash-safety with **fault injection**: with the payment database starved (1,468 pool timeouts), 0 of 2,566 bank-approved payments were lost, thanks to write-ahead attempts and a self-healing status checker.

Pick 3–4 bullets that fit the role. Lead with the routing numbers for backend and infra roles, and with idempotency and ledger for fintech roles.

## The 2-minute explanation

> "PayForge is my own version of Razorpay: not an app that calls Razorpay, but the gateway itself. A merchant's server creates a payment, the customer pays in my hosted checkout, and the system does risk checks, tokenizes the card in a vault, picks the best bank to route to, and handles OTP and UPI.
>
> The interesting part is correctness under failure. Retries can't double-charge because of idempotency keys and a state machine. If a bank times out, I don't fail the payment or retry at another bank. I mark it unknown and a worker asks the same bank what happened. If a bank goes down, a circuit breaker and health-based routing move traffic within seconds. I measured that: 99.5% success during an outage versus under 1% for a naive setup.
>
> Every rupee goes through a double-entry ledger that Postgres itself refuses to unbalance, events go to Kafka through a transactional outbox so nothing is lost, and a reconciliation job checks my records against the bank's settlement file before paying merchants. While load testing I found a real bug where a bank outage was polluting fraud scores, and I fixed it."

## Demo script (5 minutes)

See the README's *5-minute demo*. Practise it: pay with the OTP card → payment detail (timeline, risk, journal) → take a bank down in Ops → corrupt a settlement file → run reconciliation.

---

## Likely questions

### Idempotency & double charges

**Q: How do you make sure a customer is never charged twice?**
Three layers. (1) **Idempotency keys** on POSTs: the first request inserts `(merchant, key)` into Postgres; retries with the same body get the stored response; a different body gets `idempotency_key_reused`; a concurrent duplicate gets 409. (2) The **state machine plus a row lock**: confirm is only legal from `created` or `failed`, and the claim happens under `SELECT … FOR UPDATE`, so ten parallel confirms produce one attempt. (3) **Bank-side de-duplication**: every authorization carries our attempt id, and the bank refuses to create a second transaction for it. Plus: timeouts are never retried at another bank.

**Q: Why store idempotency keys in Postgres and not Redis?**
`INSERT … ON CONFLICT DO NOTHING` on a primary key is atomic, durable and has no TTL to tune. With a Redis `SET NX` lock, the lock can expire while the first request is still running, or Redis can restart and forget it. The cost is one extra write, which is small next to a 100–200 ms bank call.

**Q: What if the first request crashed halfway?**
The key stays `in_progress`. After 60 s a retry takes it over with a compare-and-set on `locked_at`. Meanwhile the write-ahead attempt row lets the status poller finish whatever reached the bank.

### Timeouts, failover, resilience

**Q: The bank times out. What do you do?**
Mark the attempt `unknown` and the payment `pending`, and **don't** try another bank, because the first one may have charged the customer. A worker queries the same bank by our reference with backoff. If the bank approved, we capture; if it has no record after 60 s, the request never arrived and we fail cleanly. Test card `4000 0000 0000 0119` demonstrates it.

**Q: How does smart routing work?**
Each acquirer gets a score: 60% recent success rate (smoothed toward a prior so a single failure doesn't condemn it), 25% speed (latency of successful calls only, because a fast-failing bank shouldn't look fast) and 15% cost. Open circuits are excluded. 5% of traffic explores non-preferred banks so recovering banks get noticed. Technical errors cascade to the next bank within the same request.

**Q: Explain circuit breakers.**
Closed means traffic flows. If at least 50% of at least 5 requests in 10 s fail, the circuit opens and calls fail instantly without waiting for timeouts, which protects both us and the struggling bank. After 10 s it goes half-open, lets one trial through, and closes if it succeeds. Declines don't count as failures, only technical errors do.

**Q: Your numbers say 99.55%, not 100%. Why?**
While AlphaBank was down and its circuit open, BetaBank was the only card acquirer left, and it has its own small random failure rate with nothing left to cascade to. That's the honest residual. A third card acquirer would close the gap.

### Events & consistency

**Q: What is the dual-write problem, and how do you solve it?**
Updating the database and publishing to Kafka are two systems; a crash between them loses or invents events. I write the event to an outbox table in the *same* transaction as the state change, and a relay publishes it afterwards. Kafka being down only delays events; it never loses them.

**Q: Exactly-once or at-least-once?**
At-least-once delivery with exactly-once effects. The relay can republish after a crash and Kafka can redeliver, so each consumer de-duplicates with a unique constraint (journal per event id, delivery per endpoint and event, settlement item per payment).

**Q: Event ordering?**
Events are keyed by payment id (same partition, ordered per payment). One relay instance is active at a time (advisory lock) and publishes in outbox id order. Consumers are still written not to depend on cross-payment ordering.

### Ledger & money

**Q: Why double-entry instead of a balance column?**
A balance column can't explain itself and one bad update silently creates money. With double-entry, every movement is a journal whose debits equal credits, balances are derived, and Postgres enforces balance with a deferred constraint trigger at commit and blocks UPDATE/DELETE. I can prove the books are consistent at any time (the Ops page shows the accounting equation).

**Q: Walk me through the entries for a ₹499 payment.**
Debit acquirer receivable 499.00; credit merchant payable 487.22, fee revenue 9.98, GST payable 1.80; then debit acquirer-fees expense 8.98 and credit acquirer receivable 8.98 for the bank's cost. Debits = credits = 507.98. On a refund: debit merchant payable, credit acquirer receivable. On a payout: debit merchant payable, credit bank.

**Q: Why integer paise?**
Floats can't represent 0.1 exactly, so rounding errors accumulate. Every amount is a `bigint` of paise and percentages use integer basis-point math with half-up rounding. A property test checks that fee + GST + net == amount for any amount.

**Q: What breaks at scale?**
Hot accounts: platform fee revenue is written on every payment. Because I derive balances instead of updating a row there's no lock contention today, but summing gets slow. I'd add periodic balance snapshots or split hot accounts into N sub-accounts.

### Reconciliation

**Q: What is reconciliation and why is it needed?**
Checking our records against the bank's settlement file. Banks and gateways disagree in practice: an approval lands after we timed out, a file is wrong, a transaction slips to the next day. I join on the reference we sent with each request and classify each line as matched, amount mismatch, missing at the acquirer, or missing on our side. Mismatches hold that merchant's payout. A grace period prevents in-flight transactions from being flagged.

### Security

**Q: How do you handle card data?**
Only the vault sees card numbers: browsers send them directly with a publishable key, so merchants are out of PCI scope. Each PAN gets its own AES-256-GCM key, wrapped by a versioned master key; the record id is authenticated data so ciphertexts can't be swapped between rows. CVC is never stored. Fingerprints are HMACs, so velocity rules work without decryption. Every decryption is audited.

**Q: How do services trust each other?**
Only the gateway is public. It authenticates the caller, strips any client-supplied internal headers, and forwards with an internal token plus the merchant id. Services are deny-by-default: an endpoint is internal-only unless it opts in. In production I'd replace the shared token with mTLS.

**Q: Webhook security?**
HMAC-SHA256 over `timestamp.body`; receivers check the signature in constant time and reject timestamps older than 5 minutes (replay protection). Webhook URLs are checked against private and link-local ranges at registration and send time (SSRF, DNS rebinding).

### Risk

**Q: How does the risk engine decide?**
Signals first (Redis sorted sets as exact sliding windows for card, IP and email velocity; blocklists; merchant average ticket; decline streak), then pure rule functions add points: ≥50 means an OTP challenge, ≥80 means block. Every decision stores which rules fired, so it's explainable. It has a 500 ms budget, and if it's down we fail *safe* to an OTP challenge.

**Q: Tell me about a bug you found.**
The chaos test showed 0% success after an outage. The decline-streak rule was counting "all acquirers unavailable" as card declines, so an outage made every customer look like a card tester. I added a `decline_type` (issuer, technical or risk) to failure events and only issuer declines now feed fraud signals. The lesson: infrastructure failures must not leak into customer-level risk.

**Q: Any other bug you found?**
Yes, a "charged but failed" bug, found with fault injection. Under load, our database pool timed out *after* the bank had approved, and the code treated that like a bank error and failed the payment. The bank's records showed the money taken. Fix: once the bank has answered, our own errors never fail the payment; the write-ahead attempt row lets the status checker re-apply the bank's answer. I proved it by starving the payment DB (1,468 pool timeouts): 0 of 2,566 bank-approved payments were lost. Reconciliation had independently flagged the two broken payments as `missing_in_platform`, so the safety net works too.

**Q: How do you debug a payment across nine services?**
Every request has a `request-id` propagated everywhere, and with OpenTelemetry on, one trace follows the payment from the gateway through payment, risk, vault and the bank, then through Kafka into the ledger, webhook and settlement consumers. I store the trace context in the outbox row so it survives the asynchronous hop.

### Design trade-offs

**Q: Why microservices? Isn't that overkill?**
The boundaries follow real constraints: the vault exists to shrink PCI scope, the ledger needs its own invariants, and webhooks and settlement shouldn't slow down payments. It also let me practise async consistency. For a small team I'd start with a modular monolith with the same modules, and the code is organised so that works.

**Q: Why NestJS?**
Dependency injection, decorators for guards and interceptors (auth and idempotency are each one decorator), a first-class monorepo, and an Angular/Spring-like structure that maps to LLD discussions.

**Q: What would you change for production?**
mTLS and a secrets manager, KEKs in an HSM, CDC (Debezium) instead of polling the outbox, read replicas for the dashboard, multi-AZ Postgres, per-merchant rate limits and pricing, real acquirer adapters (ISO 8583), 3-D Secure 2, automatic refunds for late approvals found by reconciliation, and an ML risk model.

---

## Numbers to remember

| | |
|---|---|
| Throughput | ~138 payments/s, 413 API req/s, 100% success (laptop) |
| Latency | confirm p50 259 / p95 363 / p99 418 ms, including 60–220 ms simulated bank time |
| Outage | 99.55% vs 0.85% success during a 10 s acquirer outage |
| Concurrency | 50 identical retries → 1 payment · 10 parallel confirms → 1 charge · 20 refunds → never over-refunded |
| Pricing | 2% + 18% GST: ₹499 → ₹487.22 to the merchant |
| Retries | webhooks: 8 attempts, 5 s → 320 s with jitter; status checks: 2 s → 60 s |
| Tests | 79 unit · 30 e2e · 4 browser flows · k6 load + chaos + idempotency |
| Fault injection | 1,468 DB timeouts → 0 of 2,566 bank-approved payments lost |
