#!/usr/bin/env node
/**
 * Load & chaos testing without extra tooling (k6 scripts also live in load-tests/k6).
 *
 *   node scripts/loadtest.mjs                       # 30s, 40 concurrent customers, full payment flow
 *   node scripts/loadtest.mjs --duration 60 --concurrency 80
 *   node scripts/loadtest.mjs --chaos               # AlphaBank outage: naive single-acquirer vs smart routing
 *
 * Each "payment" is the real 3-call flow a merchant + browser make:
 *   POST /v1/payment_intents (secret key) -> POST /v1/payment_methods (publishable) -> POST .../confirm
 */
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const API = process.env.PAYFORGE_API_URL ?? 'http://localhost:8080';
const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? Number(process.argv[i + 1]) : fallback;
};
const CHAOS = process.argv.includes('--chaos');
const DURATION = arg('duration', CHAOS ? 30 : 30) * 1000;
const CONCURRENCY = arg('concurrency', 40);
const MERCHANTS = arg('merchants', 4);

/** A random, Luhn-valid Visa number, so every simulated customer has their own card (realistic risk signals). */
function randomCard() {
  let pan = '411111';
  while (pan.length < 15) pan += Math.floor(Math.random() * 10);
  let sum = 0;
  for (let i = 0; i < 15; i++) {
    let d = Number(pan[14 - i]);
    if (i % 2 === 0) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return pan + ((10 - (sum % 10)) % 10);
}

const randomIp = () => `10.${(Math.random() * 255) | 0}.${(Math.random() * 255) | 0}.${1 + ((Math.random() * 253) | 0)}`;

async function call(method, path, key, body, headers = {}) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${key}`,
      'x-forwarded-for': randomIp(),
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, body: json };
}

async function signupMerchants(n) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const res = await fetch(`${API}/v1/merchants/signup`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': randomIp() },
      body: JSON.stringify({ name: 'Load Test', email: `load+${randomUUID().slice(0, 8)}@payforge.dev`, password: 'loadtest-password', business_name: `LoadCo ${i}` }),
    });
    const json = await res.json();
    if (!res.ok) throw new Error(`signup failed: ${JSON.stringify(json)}`);
    out.push({ sk: json.api_keys.secret_key, pk: json.api_keys.publishable_key, jwt: json.token });
  }
  return out;
}

const percentile = (sorted, p) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] : 0);

/** Runs `CONCURRENCY` virtual customers in a closed loop until the deadline. */
async function runPhase(merchants, durationMs, onTick) {
  const stats = { flows: [], confirms: [], statuses: {}, errors: {}, timeline: [] };
  const started = Date.now();
  const deadline = started + durationMs;
  let next = 0;

  async function customer() {
    while (Date.now() < deadline) {
      const m = merchants[next++ % merchants.length];
      const t0 = performance.now();
      try {
        const pi = await call('POST', '/v1/payment_intents', m.sk, { amount: 49900, description: 'load test', customer_email: `c${randomUUID().slice(0, 6)}@example.com` }, { 'idempotency-key': randomUUID() });
        if (pi.status !== 201) throw new Error(`create ${pi.status} ${pi.body?.error?.code ?? ''}`);
        const pm = await call('POST', '/v1/payment_methods', m.pk, { type: 'card', card: { number: randomCard(), exp_month: 12, exp_year: 2031, cvc: '123' } });
        if (pm.status !== 201) throw new Error(`tokenize ${pm.status} ${pm.body?.error?.code ?? ''}`);
        const t1 = performance.now();
        const res = await call('POST', `/v1/payment_intents/${pi.body.id}/confirm`, m.pk, { payment_method: pm.body.id, client_secret: pi.body.client_secret });
        if (res.status !== 200) throw new Error(`confirm ${res.status} ${res.body?.error?.code ?? ''}`);
        const t2 = performance.now();
        stats.flows.push(t2 - t0);
        stats.confirms.push(t2 - t1);
        stats.statuses[res.body.status] = (stats.statuses[res.body.status] ?? 0) + 1;
        stats.timeline.push({ at: Date.now() - started, ok: res.body.status === 'captured' });
      } catch (err) {
        const key = err.message.slice(0, 60);
        stats.errors[key] = (stats.errors[key] ?? 0) + 1;
        stats.timeline.push({ at: Date.now() - started, ok: false });
      }
    }
  }

  const ticker = onTick ? setInterval(() => onTick(Date.now() - started), 250) : null;
  await Promise.all(Array.from({ length: CONCURRENCY }, customer));
  if (ticker) clearInterval(ticker);
  const elapsed = (Date.now() - started) / 1000;
  const flows = [...stats.flows].sort((a, b) => a - b);
  const confirms = [...stats.confirms].sort((a, b) => a - b);
  const total = stats.timeline.length;
  const captured = stats.statuses.captured ?? 0;
  return {
    duration_s: Number(elapsed.toFixed(1)),
    concurrency: CONCURRENCY,
    payments: total,
    payments_per_sec: Number((total / elapsed).toFixed(1)),
    api_requests_per_sec: Number(((total * 3) / elapsed).toFixed(1)),
    success_rate: total ? Number((captured / total).toFixed(4)) : 0,
    statuses: stats.statuses,
    errors: stats.errors,
    flow_latency_ms: summarize(flows),
    confirm_latency_ms: summarize(confirms),
    timeline: stats.timeline,
  };
}

const summarize = (sorted) => ({
  p50: Math.round(percentile(sorted, 50)),
  p90: Math.round(percentile(sorted, 90)),
  p95: Math.round(percentile(sorted, 95)),
  p99: Math.round(percentile(sorted, 99)),
  max: Math.round(sorted[sorted.length - 1] ?? 0),
});

const fmtPct = (r) => `${(r * 100).toFixed(2)}%`;

async function admin(jwt, method, path, body) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { authorization: `Bearer ${jwt}`, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${await res.text()}`);
  return res.json();
}

async function main() {
  const health = await fetch(`${API}/health`).catch(() => null);
  if (!health?.ok) throw new Error(`Gateway not reachable at ${API}`);
  console.log(`Setting up ${MERCHANTS} merchants…`);
  const merchants = await signupMerchants(MERCHANTS);
  mkdirSync(join(root, 'load-tests/results'), { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

  if (!CHAOS) {
    console.log(`Load test: ${CONCURRENCY} concurrent customers for ${DURATION / 1000}s against ${API}\n`);
    const r = await runPhase(merchants, DURATION);
    const { timeline, ...summary } = r;
    console.log(JSON.stringify(summary, null, 2));
    writeFileSync(join(root, `load-tests/results/load-${stamp}.json`), JSON.stringify(summary, null, 2));
    console.log(`
| Metric | Value |
|---|---|
| Throughput | ${r.payments_per_sec} payments/s (${r.api_requests_per_sec} API req/s) |
| Success rate | ${fmtPct(r.success_rate)} of ${r.payments} payments |
| Confirm latency p50 / p95 / p99 | ${r.confirm_latency_ms.p50} / ${r.confirm_latency_ms.p95} / ${r.confirm_latency_ms.p99} ms |
| Full flow latency p50 / p95 / p99 | ${r.flow_latency_ms.p50} / ${r.flow_latency_ms.p95} / ${r.flow_latency_ms.p99} ms |`);
    return;
  }

  // ---------------------------------------------------------------- chaos: AlphaBank outage
  const jwt = merchants[0].jwt;
  const results = {};
  try {
    for (const strategy of ['single', 'smart']) {
      await admin(jwt, 'POST', '/v1/routing/strategy', { strategy });
      await admin(jwt, 'POST', '/v1/routing/reset');
      await admin(jwt, 'POST', '/v1/simulator/reset');
      console.log(`\n▸ ${strategy === 'single' ? 'Naive single-acquirer routing' : 'Smart routing'}: AlphaBank goes down between ${DURATION / 3000}s and ${(2 * DURATION) / 3000}s`);
      let state = 'up';
      const r = await runPhase(merchants, DURATION, (elapsed) => {
        if (state === 'up' && elapsed > DURATION / 3) {
          state = 'down';
          void admin(jwt, 'PATCH', '/v1/simulator/acquirers/alpha', { down: true });
          console.log('  ⚡ AlphaBank DOWN');
        } else if (state === 'down' && elapsed > (2 * DURATION) / 3) {
          state = 'recovered';
          void admin(jwt, 'PATCH', '/v1/simulator/acquirers/alpha', { down: false });
          console.log('  ✓ AlphaBank restored');
        }
      });
      const outage = r.timeline.filter((t) => t.at > DURATION / 3 && t.at <= (2 * DURATION) / 3);
      r.outage_success_rate = outage.length ? Number((outage.filter((t) => t.ok).length / outage.length).toFixed(4)) : 0;
      r.outage_payments = outage.length;
      delete r.timeline;
      results[strategy] = r;
      console.log(`  overall success ${fmtPct(r.success_rate)} · during outage ${fmtPct(r.outage_success_rate)} (${r.outage_payments} payments) · confirm p95 ${r.confirm_latency_ms.p95} ms`);
      await new Promise((res) => setTimeout(res, 2000));
    }
  } finally {
    await admin(jwt, 'PATCH', '/v1/simulator/acquirers/alpha', { down: false }).catch(() => undefined);
    await admin(jwt, 'POST', '/v1/routing/strategy', { strategy: 'smart' }).catch(() => undefined);
  }
  writeFileSync(join(root, `load-tests/results/chaos-${stamp}.json`), JSON.stringify(results, null, 2));
  console.log(`
| AlphaBank outage (${DURATION / 3000}s of ${DURATION / 1000}s) | Naive single acquirer | Smart routing + failover |
|---|---|---|
| Success rate during outage | ${fmtPct(results.single.outage_success_rate)} | ${fmtPct(results.smart.outage_success_rate)} |
| Overall success rate | ${fmtPct(results.single.success_rate)} | ${fmtPct(results.smart.success_rate)} |
| Payments attempted | ${results.single.payments} | ${results.smart.payments} |
| Confirm latency p95 | ${results.single.confirm_latency_ms.p95} ms | ${results.smart.confirm_latency_ms.p95} ms |`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
