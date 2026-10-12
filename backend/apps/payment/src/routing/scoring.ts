/**
 * Smart routing: pure scoring functions (unit-tested in scoring.spec.ts).
 *
 * Each acquirer gets a health score from its recent success rate, latency and cost:
 *   score = 0.60 * successRate + 0.25 * speed + 0.15 * cheapness
 * Success rate is smoothed toward a prior so one early failure doesn't condemn an
 * acquirer, and a small exploration rate (epsilon-greedy, as in a multi-armed bandit)
 * keeps sending a trickle of traffic to non-preferred acquirers so their stats stay fresh.
 */
export type RoutingStrategy = 'smart' | 'single';
export type CircuitStatus = 'closed' | 'open' | 'half_open';

export interface Candidate {
  code: string;
  costBps: number;
  circuit: CircuitStatus;
  successes: number;
  samples: number;
  avgLatencyMs: number;
}

export const WEIGHTS = { successRate: 0.6, speed: 0.25, cost: 0.15 } as const;
const PRIOR_SUCCESS_RATE = 0.95;
const PRIOR_WEIGHT = 5;
const LATENCY_CEILING_MS = 2_000;
const COST_CEILING_BPS = 300;

export function smoothedSuccessRate(c: Pick<Candidate, 'successes' | 'samples'>): number {
  return (c.successes + PRIOR_SUCCESS_RATE * PRIOR_WEIGHT) / (c.samples + PRIOR_WEIGHT);
}

export function healthScore(c: Candidate): number {
  const speed = 1 - Math.min(c.avgLatencyMs, LATENCY_CEILING_MS) / LATENCY_CEILING_MS;
  const cheapness = 1 - Math.min(c.costBps, COST_CEILING_BPS) / COST_CEILING_BPS;
  return WEIGHTS.successRate * smoothedSuccessRate(c) + WEIGHTS.speed * speed + WEIGHTS.cost * cheapness;
}

/**
 * Returns acquirer codes in the order they should be tried.
 *  - 'single': the naive baseline. Always the primary acquirer, no failover.
 *  - 'smart' : highest health score first, open circuits excluded, cascade on technical failure.
 */
export function rankCandidates(candidates: Candidate[], strategy: RoutingStrategy, epsilon = 0, random: () => number = Math.random): string[] {
  if (!candidates.length) return [];
  if (strategy === 'single') return [candidates[0].code];

  const healthy = candidates.filter((c) => c.circuit !== 'open').sort((a, b) => healthScore(b) - healthScore(a));
  if (healthy.length > 1 && random() < epsilon) {
    const i = 1 + Math.floor(random() * (healthy.length - 1));
    [healthy[0], healthy[i]] = [healthy[i], healthy[0]];
  }
  return healthy.map((c) => c.code);
}
