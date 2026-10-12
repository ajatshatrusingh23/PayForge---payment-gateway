# ADR 0005: Health-scored routing with circuit breakers and cascading

**Status:** accepted

## Context
Static primary/secondary failover only reacts to hard outages and sends 100% of traffic to the primary until it fails completely. Banks often degrade partially (slower, more 5xx) before failing.

## Decision
For each payment method, acquirers are ranked by `0.60 × success rate + 0.25 × speed + 0.15 × cheapness`, computed from the last 5 minutes of outcomes in Redis (shared by all payment instances). The success rate is smoothed toward a 95% prior; latency counts successful calls only, so a fast-failing bank never looks fast. Open circuits (opossum: ≥50% errors over ≥5 requests in 10 s) are excluded. With 5% probability a non-preferred acquirer goes first (epsilon-greedy), so stats for recovering banks stay fresh. Technical failures cascade within the same request.

## Consequences
+ Measured: during a 10 s AlphaBank outage, success stayed at 99.55% versus 0.85% for single-acquirer routing.
+ Cost is part of the score, so cheaper acquirers win when health is equal.
− Circuit state is per process (fine; Redis stats are shared). A strategy switch (smart/single) exists for demos and comparisons.
