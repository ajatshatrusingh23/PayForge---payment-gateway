// 200 concurrent requests with the SAME Idempotency-Key must create exactly ONE PaymentIntent.
//   k6 run load-tests/k6/idempotency-storm.js
import http from 'k6/http';
import { check } from 'k6';
import { Counter } from 'k6/metrics';
import { API, headers, signupMerchants, uuid } from './lib.js';

const created = new Counter('storm_201');
const conflicts = new Counter('storm_409');

export const options = {
  scenarios: { storm: { executor: 'shared-iterations', vus: 200, iterations: 200, maxDuration: '30s' } },
  thresholds: { checks: ['rate==1'] },
};

export function setup() {
  const [merchant] = signupMerchants(1);
  return { merchant, key: uuid(), description: `storm-${uuid().slice(0, 8)}` };
}

export default function ({ merchant, key, description }) {
  const res = http.post(`${API}/v1/payment_intents`, JSON.stringify({ amount: 12345, description }), headers(merchant.sk, { 'idempotency-key': key }));
  if (res.status === 201) created.add(1);
  if (res.status === 409) conflicts.add(1);
  check(res, { 'only 201 (first or replay) or 409 (in progress)': (r) => r.status === 201 || r.status === 409 });
}

export function teardown({ merchant, description }) {
  const list = http.get(`${API}/v1/payment_intents?limit=100&q=${description}`, headers(merchant.sk)).json('data');
  const ids = new Set(list.map((p) => p.id));
  check(ids, { 'exactly one PaymentIntent was created': (s) => s.size === 1 });
  console.log(`distinct payment intents created: ${ids.size}`);
}
