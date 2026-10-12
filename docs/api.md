# API reference

Base URL: `http://localhost:8080`. Full schemas: Swagger UI on each service (`http://localhost:4002/docs` for payments).

## Authentication

| Credential | Header | Use from | Can do |
|---|---|---|---|
| Secret key `sk_test_…` | `Authorization: Bearer sk_test_…` (or `-u sk_test_…:`) | your server | everything for your account |
| Publishable key `pk_test_…` | `Authorization: Bearer pk_test_…` | browsers | tokenize, and retrieve/confirm/OTP a PaymentIntent **with its `client_secret`** |
| Dashboard session | httpOnly cookie via the dashboard BFF | dashboard | everything plus demo/ops endpoints |

All amounts are integers in **paise** (₹499.00 = `49900`). POST endpoints marked ⟲ accept an `Idempotency-Key` header.

## Errors

```json
{ "error": { "type": "invalid_request_error", "code": "parameter_invalid", "message": "…", "param": "amount", "request_id": "req_…" } }
```

| type | HTTP | examples |
|---|---|---|
| `invalid_request_error` | 400 / 404 | `parameter_invalid`, `parameter_unknown`, `resource_missing`, `unexpected_state`, `amount_too_large` |
| `card_error` | 402 | `incorrect_number`, `expired_card`, `invalid_cvc` (at tokenization) |
| `authentication_error` / `permission_error` | 401 / 403 | invalid key, publishable key on a server-only endpoint |
| `idempotency_error` | 400 / 409 | `idempotency_key_reused`, `idempotency_key_in_use` |
| `rate_limit_error` | 429 | `rate_limited` (see `Retry-After`) |
| `api_error` | 5xx | `upstream_timeout`, `service_unavailable` |

## Payment intents

| Method | Path | Auth | Notes |
|---|---|---|---|
| POST ⟲ | `/v1/payment_intents` | secret | `amount` (required), `currency` (`INR`), `capture_method` (`automatic`/`manual`), `description`, `customer_email`, `statement_descriptor`, `payment_method_types`, `metadata` |
| GET | `/v1/payment_intents` | secret | `limit`, `starting_after`, `status`, `q` (id / email / description) |
| GET | `/v1/payment_intents/:id` | secret, or publishable + `?client_secret=` | |
| GET | `/v1/payment_intents/:id/timeline` | secret | events, acquirer attempts, refunds |
| POST ⟲ | `/v1/payment_intents/:id/confirm` | publishable + `client_secret`, or secret | `payment_method` (`pm_…`). Returns 200 with the resulting status |
| POST | `/v1/payment_intents/:id/otp` | publishable + `client_secret`, or secret | `otp` |
| POST ⟲ | `/v1/payment_intents/:id/capture` | secret | `amount_to_capture` (≤ authorized) |
| POST ⟲ | `/v1/payment_intents/:id/cancel` | secret | voids an authorization, or cancels an unpaid intent |

Statuses: `created`, `processing`, `requires_action` (`next_action.type = otp`), `pending` (`next_action.type = upi_collect`, or a bank timeout being resolved), `authorized`, `captured`, `partially_refunded`, `refunded`, `failed` (retryable with a new payment method), `canceled`, `voided`, `expired`.

## Payment methods

| Method | Path | Auth | Body |
|---|---|---|---|
| POST | `/v1/payment_methods` | publishable / secret | `{ "type": "card", "card": { "number", "exp_month", "exp_year", "cvc", "name?" } }` or `{ "type": "upi", "upi": { "vpa" } }` |
| GET | `/v1/payment_methods/:id` | secret | brand, last4, issuer, country, funding, fingerprint |

## Refunds

| Method | Path | Notes |
|---|---|---|
| POST ⟲ | `/v1/refunds` | `payment_intent`, `amount?` (defaults to the remaining refundable amount), `reason?` |
| GET | `/v1/refunds?payment_intent=` | |
| GET | `/v1/refunds/:id` | |

## Balance, ledger, settlement

| Method | Path | Notes |
|---|---|---|
| GET | `/v1/balance` | ledger balance owed to you, lifetime totals |
| GET | `/v1/ledger/journals?reference=&limit=` | double-entry journals with lines |
| GET | `/v1/ledger/integrity` | debits = credits proof + trial balance |
| GET | `/v1/settlements/summary` | pending reconciliation / ready / on hold / paid out |
| GET | `/v1/payouts` | payouts with UTR |
| GET | `/v1/reconciliation/runs`, `/v1/reconciliation/runs/:id`, `/v1/reconciliation/exceptions` | |
| POST | `/v1/settlements/run` | dashboard, demo mode: reconcile + pay out now |

## Webhooks

| Method | Path | Notes |
|---|---|---|
| POST | `/v1/webhook_endpoints` | `url`, `enabled_events` (`["*"]` default). Returns the signing `secret` |
| GET / DELETE | `/v1/webhook_endpoints[/:id]` | |
| POST | `/v1/webhook_endpoints/:id/test` | sends a signed `ping` |
| GET | `/v1/webhook_deliveries?status=&object_id=` | status: `pending`, `retrying`, `succeeded`, `dead` |
| POST | `/v1/webhook_deliveries/:id/retry` | replay |

Each delivery has the headers `PayForge-Signature: t=<unix>,v1=<hex>`, `PayForge-Event-Id` and `PayForge-Event-Type`. Verify `v1 == HMAC_SHA256(secret, t + "." + rawBody)` and that `t` is within 5 minutes.

## Risk

| Method | Path | Notes |
|---|---|---|
| GET | `/v1/risk/rules` | rules and thresholds |
| GET | `/v1/risk/assessments?payment_intent=` | score, decision, reasons |
| GET / POST / DELETE | `/v1/risk/blocklist[/:id]` | `type`: `fingerprint`, `email`, `ip`, `vpa` |

## Routing & chaos (dashboard, demo mode)

| Method | Path | Notes |
|---|---|---|
| GET | `/v1/routing/health` | per-acquirer circuit, success rate, latency, score |
| POST | `/v1/routing/strategy` | `{ "strategy": "smart" \| "single" }` |
| POST | `/v1/routing/reset` | clear routing stats |
| GET | `/v1/simulator/acquirers` | simulated banks and their counters |
| PATCH | `/v1/simulator/acquirers/:code` | `down`, `latency_ms`, `technical_failure_rate`, `inject_discrepancy` |
| POST | `/v1/simulator/reset` | restore defaults |

## Merchant

| Method | Path | Notes |
|---|---|---|
| POST | `/v1/merchants/signup`, `/v1/merchants/login` | public, rate-limited per IP |
| GET | `/v1/merchants/me` | |
| POST | `/v1/merchants/me/kyc` | PAN, bank account, IFSC (mock verification) |
| GET | `/v1/api_keys`, POST `/v1/api_keys/roll` | rolling revokes the old secret key immediately |
