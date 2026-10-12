// Chaos test: AlphaBank goes down mid-test; smart routing must keep the success rate above 97%.
//   k6 run load-tests/k6/chaos-failover.js
// Compare with the naive baseline: k6 run -e STRATEGY=single load-tests/k6/chaos-failover.js
import http from 'k6/http';
import { sleep } from 'k6';
import { Rate, Trend } from 'k6/metrics';
import { API, payOnce, signupMerchants } from './lib.js';

const metrics = { confirm: new Trend('confirm_duration', true), success: new Rate('payment_success') };
const STRATEGY = __ENV.STRATEGY || 'smart';

export const options = {
  scenarios: {
    traffic: { executor: 'constant-vus', vus: 30, duration: '60s', exec: 'traffic' },
    outage: { executor: 'per-vu-iterations', vus: 1, iterations: 1, startTime: '20s', exec: 'outage' },
  },
  thresholds: STRATEGY === 'smart' ? { payment_success: ['rate>0.97'] } : {},
};

const admin = (jwt, method, path, body) =>
  http.request(method, `${API}${path}`, body ? JSON.stringify(body) : null, { headers: { authorization: `Bearer ${jwt}`, 'content-type': 'application/json' } });

export function setup() {
  const merchants = signupMerchants(4);
  admin(merchants[0].jwt, 'POST', '/v1/routing/strategy', { strategy: STRATEGY });
  admin(merchants[0].jwt, 'POST', '/v1/routing/reset');
  return { merchants };
}

export function traffic(data) {
  payOnce(data.merchants[Math.floor(Math.random() * data.merchants.length)], metrics);
}

export function outage(data) {
  const jwt = data.merchants[0].jwt;
  admin(jwt, 'PATCH', '/v1/simulator/acquirers/alpha', { down: true });
  console.log('AlphaBank DOWN');
  sleep(20);
  admin(jwt, 'PATCH', '/v1/simulator/acquirers/alpha', { down: false });
  console.log('AlphaBank restored');
}

export function teardown(data) {
  admin(data.merchants[0].jwt, 'PATCH', '/v1/simulator/acquirers/alpha', { down: false });
  admin(data.merchants[0].jwt, 'POST', '/v1/routing/strategy', { strategy: 'smart' });
}
