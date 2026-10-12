#!/usr/bin/env node
/**
 * Sets up the demo merchant ("ChaiCart") and wires the demo store to it.
 *   npm run seed              merchant + KYC + webhook endpoint + web/demo-store/.env
 *   npm run seed -- --with-data   ...plus ~40 realistic payments so the dashboard has something to show
 */
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const API = process.env.PAYFORGE_API_URL ?? 'http://localhost:8080';
const STORE_WEBHOOK_URL = process.env.STORE_WEBHOOK_URL ?? 'http://localhost:3000/webhooks/payforge';
const CHECKOUT_URL = process.env.PAYFORGE_CHECKOUT_URL ?? 'http://localhost:5174';
const DEMO = { name: 'Asha Verma', email: 'demo@chaicart.in', password: 'chaicart-demo-123', business_name: 'ChaiCart' };
const withData = process.argv.includes('--with-data');

const randomIp = () => `10.${(Math.random() * 255) | 0}.${(Math.random() * 255) | 0}.${1 + ((Math.random() * 253) | 0)}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(method, path, { key, body, headers = {} } = {}) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      'x-forwarded-for': randomIp(),
      ...(key ? { authorization: `Bearer ${key}` } : {}),
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...headers,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, body: json };
}

async function main() {
  const health = await fetch(`${API}/health`).catch(() => null);
  if (!health?.ok) throw new Error(`PayForge gateway is not reachable at ${API}. Start it with: npm run dev`);

  // 1. Merchant (idempotent: log in and roll the key if it already exists)
  let jwt, secretKey, publishableKey;
  const signup = await api('POST', '/v1/merchants/signup', { body: DEMO });
  if (signup.status === 201) {
    jwt = signup.body.token;
    ({ secret_key: secretKey, publishable_key: publishableKey } = signup.body.api_keys);
    console.log(`✔ Created merchant ${signup.body.merchant.id}`);
  } else if (signup.body?.error?.code === 'email_taken') {
    const login = await api('POST', '/v1/merchants/login', { body: { email: DEMO.email, password: DEMO.password } });
    if (login.status !== 200) throw new Error(`Login failed: ${JSON.stringify(login.body)}`);
    jwt = login.body.token;
    secretKey = (await api('POST', '/v1/api_keys/roll', { key: jwt })).body.secret_key;
    publishableKey = (await api('GET', '/v1/api_keys', { key: jwt })).body.data.find((k) => k.type === 'publishable' && k.status === 'active').key;
    console.log(`✔ Merchant exists: logged in and rolled a fresh secret key`);
  } else {
    throw new Error(`Signup failed: ${JSON.stringify(signup.body)}`);
  }

  // 2. KYC (required before settlement)
  await api('POST', '/v1/merchants/me/kyc', {
    key: jwt,
    body: { pan: 'AAACC1234F', account_holder_name: 'ChaiCart Foods Pvt Ltd', bank_account_number: '50100123456789', ifsc: 'HDFC0001234' },
  });
  console.log('✔ KYC approved, settlement account on file');

  // 3. Webhook endpoint for the demo store
  const endpoints = (await api('GET', '/v1/webhook_endpoints', { key: jwt })).body.data;
  let endpoint = endpoints.find((e) => e.url === STORE_WEBHOOK_URL);
  if (endpoint) endpoint = (await api('GET', `/v1/webhook_endpoints/${endpoint.id}`, { key: jwt })).body;
  else endpoint = (await api('POST', '/v1/webhook_endpoints', { key: jwt, body: { url: STORE_WEBHOOK_URL, enabled_events: ['*'], description: 'ChaiCart order fulfilment' } })).body;
  console.log(`✔ Webhook endpoint ${endpoint.id} -> ${STORE_WEBHOOK_URL}`);

  // 4. Demo store configuration
  const env = [
    `PAYFORGE_API_URL=${API}`,
    `PAYFORGE_CHECKOUT_URL=${CHECKOUT_URL}`,
    `PAYFORGE_SECRET_KEY=${secretKey}`,
    `PAYFORGE_PUBLISHABLE_KEY=${publishableKey}`,
    `PAYFORGE_WEBHOOK_SECRET=${endpoint.secret}`,
    '',
  ].join('\n');
  writeFileSync(join(root, 'web', 'demo-store', '.env'), env);
  console.log('✔ Wrote web/demo-store/.env');

  if (withData) await generateTraffic(secretKey, publishableKey, jwt);

  console.log(`
Done. Dashboard login: ${DEMO.email} / ${DEMO.password}
  Dashboard  http://localhost:3001
  Store      http://localhost:3000
  API        ${API}`);
}

async function generateTraffic(sk, pk, jwt) {
  console.log('\nGenerating sample payments…');
  const prices = [34900, 49900, 89900, 64900, 39900, 149900, 74800, 98800, 119700];
  const plan = [
    ...Array(24).fill('4111111111111111'),
    ...Array(4).fill('5555555555554444'),
    ...Array(3).fill('6522000000000006'),
    ...Array(3).fill('4000000000000002'),
    ...Array(2).fill('4000000000009995'),
    ...Array(2).fill('otp'),
    ...Array(4).fill('upi'),
    'upi-fail',
    'manual',
  ].sort(() => Math.random() - 0.5);

  const captured = [];
  let n = 0;
  for (const kind of plan) {
    const amount = prices[(Math.random() * prices.length) | 0];
    const pi = (
      await api('POST', '/v1/payment_intents', {
        key: sk,
        body: {
          amount,
          description: `ChaiCart order #${1000 + n}`,
          customer_email: `customer${n}@example.com`,
          capture_method: kind === 'manual' ? 'manual' : 'automatic',
          metadata: { order_id: `ord_seed_${n}` },
        },
        headers: { 'idempotency-key': randomUUID() },
      })
    ).body;
    n++;
    const pm =
      kind === 'upi' || kind === 'upi-fail'
        ? { type: 'upi', upi: { vpa: kind === 'upi' ? `customer${n}@okaxis` : 'fail@pfbank' } }
        : { type: 'card', card: { number: kind === 'otp' || kind === 'manual' ? (kind === 'otp' ? '4000000000003220' : '4111111111111111') : kind, exp_month: 12, exp_year: 2030, cvc: '123' } };
    const method = (await api('POST', '/v1/payment_methods', { key: pk, body: pm })).body;
    let result = (await api('POST', `/v1/payment_intents/${pi.id}/confirm`, { key: pk, body: { payment_method: method.id, client_secret: pi.client_secret } })).body;
    if (result.status === 'requires_action') {
      result = (await api('POST', `/v1/payment_intents/${pi.id}/otp`, { key: pk, body: { otp: '123456', client_secret: pi.client_secret } })).body;
    }
    if (result.status === 'captured') captured.push(result);
    process.stdout.write(result.status === 'captured' ? '.' : result.status === 'failed' ? 'x' : '~');
  }
  await sleep(4000); // let UPI collect requests resolve

  for (const pi of captured.slice(0, 3)) {
    await api('POST', '/v1/refunds', { key: sk, body: { payment_intent: pi.id, amount: Math.round(pi.amount / 2) } });
  }
  await sleep(1500);
  const run = (await api('POST', '/v1/settlements/run', { key: jwt })).body;
  const paid = run?.payouts?.find((p) => p.status === 'paid');
  console.log(`\n✔ ${plan.length} payments, 3 refunds, settlement run${paid ? ` (payout ₹${(paid.amount / 100).toFixed(2)})` : ''}`);
}

main().catch((err) => {
  console.error(`✘ ${err.message}`);
  process.exit(1);
});
