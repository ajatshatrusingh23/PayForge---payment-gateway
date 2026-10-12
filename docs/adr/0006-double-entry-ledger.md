# ADR 0006: An append-only double-entry ledger with database-enforced invariants

**Status:** accepted

## Context
A `balance` column that gets incremented can't explain *why* it has the value it has, and one buggy update silently creates or destroys money.

## Decision
Money movements are journals of debit and credit lines over a chart of accounts (merchant payable, acquirer receivable, fee revenue, GST payable, acquirer fees expense, platform bank). Posting rules are pure functions of events and are property-tested to balance for any amount. Postgres enforces: positive amounts, a **deferred constraint trigger** that rejects unbalanced journals at commit, **no UPDATE/DELETE** (corrections are reversing entries), and one journal per event id. Balances are derived by summing lines. An integrity endpoint proves debits = credits and assets + expenses = liabilities + revenue.

## Consequences
+ Every rupee is traceable to an event; the books can be proven consistent at any time.
+ Platform economics (fee revenue vs acquirer cost) are visible.
− Summing lines gets slower as the ledger grows; at scale, add periodic balance snapshots or partitioned balance rows (hot accounts such as fee revenue are written on every payment).
