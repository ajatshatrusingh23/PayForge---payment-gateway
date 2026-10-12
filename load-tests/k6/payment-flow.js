// Ramping arrival-rate load test of the full payment flow.
//   k6 run load-tests/k6/payment-flow.js
//   docker run --rm -i --add-host=host.docker.internal:host-gateway -e API_URL=http://host.docker.internal:8080 \
//     -v "$PWD/load-tests/k6:/scripts" grafana/k6 run /scripts/payment-flow.js
import { Rate, Trend } from 'k6/metrics';
import { payOnce, signupMerchants } from './lib.js';

const metrics = {
  confirm: new Trend('confirm_duration', true),
  success: new Rate('payment_success'),
};

export const options = {
  scenarios: {
    checkout: {
      executor: 'ramping-arrival-rate',
      startRate: 10,
      timeUnit: '1s',
      preAllocatedVUs: 60,
      maxVUs: 300,
      stages: [
        { target: 50, duration: '20s' },
        { target: Number(__ENV.PEAK_RPS || 120), duration: '40s' },
        { target: 0, duration: '10s' },
      ],
    },
  },
  thresholds: {
    http_req_failed: ['rate<0.01'],
    payment_success: ['rate>0.99'],
    confirm_duration: ['p(95)<800', 'p(99)<1500'],
  },
};

export function setup() {
  return { merchants: signupMerchants(4) };
}

export default function (data) {
  payOnce(data.merchants[Math.floor(Math.random() * data.merchants.length)], metrics);
}
