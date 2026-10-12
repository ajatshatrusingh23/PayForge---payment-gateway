# ADR 0008: The risk engine is on the critical path, with a latency budget, and fails safe

**Status:** accepted

## Context
Fraud checks must run before the bank is contacted, but a slow or broken risk service must not take payments down, and it must not silently let fraud through either.

## Decision
The payment service calls risk with a 500 ms budget. If risk times out or errors, the decision becomes **challenge** (OTP step-up), not allow and not block. Rules are pure functions over signals (Redis sorted-set velocity windows, blocklists, merchant averages), and every assessment stores the rules that fired. Feedback from outcomes is filtered: only *issuer* declines feed the decline-streak signal. Technical failures and our own risk blocks don't, because an acquirer outage must not turn customers into suspects (a bug found by the chaos test).

## Consequences
+ Predictable latency, explainable decisions, graceful degradation.
− Rules need tuning per merchant vertical; an ML score could complement them later with the rules as guardrails.
