import { counter, gauge, histogram } from '@app/common';

export const paymentOutcomes = counter('payforge_payments_total', 'Payment outcomes by status and method', ['status', 'method'] as const);

export const acquirerRequests = counter(
  'payforge_acquirer_requests_total',
  'Authorization calls to acquirers by outcome',
  ['acquirer', 'method', 'outcome'] as const,
);

export const acquirerLatency = histogram(
  'payforge_acquirer_latency_seconds',
  'Acquirer authorization latency',
  ['acquirer'] as const,
  [0.025, 0.05, 0.1, 0.25, 0.5, 1, 2, 3, 5],
);

export const circuitState = gauge('payforge_circuit_state', 'Circuit breaker state per acquirer (0=closed, 1=half-open, 2=open)', [
  'acquirer',
] as const);

export const routingFailovers = counter('payforge_routing_failovers_total', 'Times routing cascaded past a failing acquirer', [
  'from',
] as const);

export const confirmDuration = histogram(
  'payforge_confirm_duration_seconds',
  'End-to-end confirm latency (risk + vault + routing + acquirer)',
  ['method', 'outcome'] as const,
  [0.05, 0.1, 0.25, 0.5, 1, 2, 3, 5, 10],
);
