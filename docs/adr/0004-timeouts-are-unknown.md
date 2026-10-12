# ADR 0004: A timeout is an unknown outcome, never a failure, and never retried elsewhere

**Status:** accepted

## Context
If an authorization request to a bank times out, the bank may still have approved and debited the customer. Treating the timeout as a failure (and letting the customer retry), or failing over to another acquirer, can charge the customer twice.

## Decision
The acquirer client distinguishes three error classes:
- **Technical failure** (5xx, connection refused, circuit open): nothing was processed, so cascade to the next acquirer.
- **Timeout**: the attempt becomes `unknown` and the payment `pending`. No other acquirer is tried.
- **Business response** (decline, OTP, pending): apply it.
Every attempt is written *before* calling the bank (write-ahead), and the bank de-duplicates on our attempt id. A status-check worker asks the same bank about `initiated`, `pending` and `unknown` attempts with exponential backoff (2 s → 60 s) and resolves them; if the bank has no record after 60 s, the attempt never arrived and the payment fails cleanly.

The same rule covers our own failures: once a bank has answered, an error while *recording* the answer (for example a database timeout) leaves the attempt open for the status checker instead of failing the payment. Fault injection with a starved DB pool: 0 of 2,566 bank-approved payments lost.

## Consequences
+ No double charges from timeouts; crashes mid-call heal themselves.
− The customer sees "confirming with your bank" for a few seconds in rare cases.
Verified by the `4000 0000 0000 0119` test card (the bank hangs 10 s): the payment is captured by the status check with exactly one attempt.
