#!/usr/bin/env node
/**
 * PayForge end-to-end test suite. Runs against a live stack through the public gateway.
 *   npm run e2e        (with the backend running: npm run dev)
 * No dependencies: Node 20+ only.
 */
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';

const GW = process.env.PAYFORGE_API_URL ?? 'http://localhost:8080';
const HOOK_PORT = Number(process.env.E2E_WEBHOOK_PORT ?? 4999);
// Hostname the webhook service uses to reach this script's receiver. When the stack runs in
// Docker (npm run docker:up) that's host.docker.internal rather than localhost.
const HOOK_HOST = process.env.E2E_WEBHOOK_HOST ?? 'localhost';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------ tiny test harness
const results = [];
let current = '';
async function test(name, fn) {
  current = name;
  const started = Date.now();
  try {
    await fn();
    results.push({ name, ok: true, ms: Date.now() - started });
    console.log(`  \x1b[32m✔\x1b[0m ${name} \x1b[2m(${Date.now() - started}ms)\x1b[0m`);
  } catch (err) {
    results.push({ name, ok: false, ms: Date.now() - started, error: err.message });
    console.log(`  \x1b[31m✘ ${name}\x1b[0m\n    ${err.message}`);
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}
function eq(actual, expected, label) {
  if (actual !== expected) throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

// Each request looks like a different customer (as real traffic would), so per-IP rate limits and
// risk velocity rules don't treat the whole suite as one very busy shopper.
const randomIp = () => `10.${(Math.random() * 255) | 0}.${(Math.random() * 255) | 0}.${1 + ((Math.random() * 253) | 0)}`;
const uniqueEmail = () => `buyer+${randomUUID().slice(0, 8)}@example.com`;

async function api(method, path, { key, body, headers = {} } = {}) {
  const res = await fetch(`${GW}${path}`, {
    method,
    headers: {
      'x-forwarded-for': randomIp(),
      ...(key ? { authorization: `Bearer ${key}` } : {}),
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...headers,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = text;
  }
  return { status: res.status, body: json, headers: res.headers };
}

async function waitFor(fn, { timeout = 20_000, interval = 500, label = 'condition' } = {}) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    last = await fn();
    if (last) return last;
    await sleep(interval);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

// ------------------------------------------------------------------ webhook receiver
const received = [];
let hookSecret = '';
function verify(body, header) {
  const parts = Object.fromEntries(header.split(',').map((kv) => kv.split('=')));
  const expected = createHmac('sha256', hookSecret).update(`${parts.t}.${body}`).digest('hex');
  return expected.length === parts.v1?.length && timingSafeEqual(Buffer.from(expected), Buffer.from(parts.v1));
}
const hookServer = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const valid = verify(body, req.headers['payforge-signature'] ?? '');
    received.push({ valid, event: JSON.parse(body) });
    res.writeHead(valid ? 200 : 400).end();
  });
});

// ------------------------------------------------------------------ fixtures
const CARDS = {
  visa: '4111111111111111',
  declined: '4000000000000002',
  insufficient: '4000000000009995',
  otp: '4000000000003220',
  timeout: '4000000000000119',
  international: '4000000760000002',
  mastercard: '5555555555554444',
};

let SK, PK, JWT, MERCHANT;
const card = (number) => ({ type: 'card', card: { number, exp_month: 12, exp_year: 2031, cvc: '123', name: 'E2E Tester' } });

async function createIntent(extra = {}, idempotencyKey) {
  const r = await api('POST', '/v1/payment_intents', {
    key: SK,
    body: { amount: 49900, description: 'E2E order', customer_email: uniqueEmail(), ...extra },
    headers: idempotencyKey ? { 'idempotency-key': idempotencyKey } : {},
  });
  eq(r.status, 201, `create intent (${JSON.stringify(r.body?.error)})`);
  return r.body;
}
async function tokenize(pm) {
  const r = await api('POST', '/v1/payment_methods', { key: PK, body: pm });
  eq(r.status, 201, `tokenize (${JSON.stringify(r.body?.error)})`);
  return r.body;
}
async function confirm(pi, pm) {
  const r = await api('POST', `/v1/payment_intents/${pi.id}/confirm`, { key: PK, body: { payment_method: pm.id, client_secret: pi.client_secret } });
  eq(r.status, 200, `confirm (${JSON.stringify(r.body?.error)})`);
  return r.body;
}
async function pay(number, extra = {}) {
  const pi = await createIntent(extra);
  return confirm(pi, await tokenize(card(number)));
}
async function retrieve(id) {
  return (await api('GET', `/v1/payment_intents/${id}`, { key: SK })).body;
}

// ------------------------------------------------------------------ suite
async function main() {
  await new Promise((r) => hookServer.listen(HOOK_PORT, r));
  console.log(`\nPayForge E2E against ${GW}\n`);

  const health = await api('GET', '/health').catch(() => null);
  if (!health || health.status !== 200) {
    console.error(`Gateway not reachable at ${GW}. Start the stack first (npm run dev).`);
    process.exit(1);
  }

  console.log('Onboarding');
  await test('merchant signs up and gets test API keys', async () => {
    const r = await api('POST', '/v1/merchants/signup', {
      body: { name: 'E2E Bot', email: `e2e+${Date.now()}@payforge.dev`, password: 'correct-horse-battery', business_name: 'E2E Chai Co' },
    });
    eq(r.status, 201, 'signup status');
    ({ secret_key: SK, publishable_key: PK } = r.body.api_keys);
    JWT = r.body.token;
    MERCHANT = r.body.merchant.id;
    assert(SK.startsWith('sk_test_') && PK.startsWith('pk_test_'), 'key prefixes');
  });
  await test('KYC is approved (required for payouts)', async () => {
    const r = await api('POST', '/v1/merchants/me/kyc', {
      key: JWT,
      body: { pan: 'ABCDE1234F', account_holder_name: 'E2E Chai Co', bank_account_number: '123456789012', ifsc: 'HDFC0001234' },
    });
    eq(r.body.kyc_status, 'approved', 'kyc status');
  });
  await test('webhook endpoint registered and signed ping delivered', async () => {
    const r = await api('POST', '/v1/webhook_endpoints', { key: SK, body: { url: `http://${HOOK_HOST}:${HOOK_PORT}/webhooks`, enabled_events: ['*'] } });
    eq(r.status, 201, 'endpoint create');
    hookSecret = r.body.secret;
    await api('POST', `/v1/webhook_endpoints/${r.body.id}/test`, { key: SK });
    await waitFor(() => received.find((h) => h.event.type === 'ping'), { label: 'ping webhook' });
    assert(received.find((h) => h.event.type === 'ping').valid, 'ping signature valid');
  });

  console.log('\nCard payments');
  let captured;
  await test('Visa card is captured, fees are 2% + 18% GST', async () => {
    captured = await pay(CARDS.visa);
    eq(captured.status, 'captured', 'status');
    eq(captured.amount_received, 49900, 'amount_received');
    const full = await retrieve(captured.id);
    eq(full.fees.fee, 998, 'fee');
    eq(full.fees.gst, 180, 'gst');
    eq(full.fees.net, 48722, 'net');
  });
  await test('issuer decline fails the payment; retry with another card succeeds', async () => {
    const pi = await createIntent();
    const failed = await confirm(pi, await tokenize(card(CARDS.declined)));
    eq(failed.status, 'failed', 'status after decline');
    eq(failed.last_payment_error.decline_code, 'do_not_honor', 'decline code');
    const retried = await confirm(pi, await tokenize(card(CARDS.visa)));
    eq(retried.status, 'captured', 'status after retry');
    eq(retried.attempt_count, 2, 'attempt_count');
  });
  await test('insufficient funds decline', async () => {
    const pi = await pay(CARDS.insufficient);
    eq(pi.last_payment_error.decline_code, 'insufficient_funds', 'decline code');
  });
  await test('invalid card number is rejected at tokenization (Luhn)', async () => {
    const r = await api('POST', '/v1/payment_methods', { key: PK, body: card('4111111111111112') });
    eq(r.status, 402, 'status');
    eq(r.body.error.code, 'incorrect_number', 'error code');
  });

  console.log('\nOTP / step-up authentication');
  await test('OTP card requires action; wrong OTP keeps it open; correct OTP captures', async () => {
    const pi = await createIntent();
    const step = await confirm(pi, await tokenize(card(CARDS.otp)));
    eq(step.status, 'requires_action', 'status');
    eq(step.next_action.type, 'otp', 'next_action');
    const wrong = await api('POST', `/v1/payment_intents/${pi.id}/otp`, { key: PK, body: { otp: '000000', client_secret: pi.client_secret } });
    eq(wrong.body.status, 'requires_action', 'status after wrong OTP');
    eq(wrong.body.last_payment_error.code, 'incorrect_otp', 'error code');
    eq(wrong.body.next_action.otp.attempts_remaining, 2, 'attempts remaining');
    const ok = await api('POST', `/v1/payment_intents/${pi.id}/otp`, { key: PK, body: { otp: '123456', client_secret: pi.client_secret } });
    eq(ok.body.status, 'captured', 'status after correct OTP');
  });

  console.log('\nUPI');
  await test('UPI collect is pending, then captured when the customer approves', async () => {
    const pi = await createIntent();
    const pending = await confirm(pi, await tokenize({ type: 'upi', upi: { vpa: 'success@pfbank' } }));
    eq(pending.status, 'pending', 'initial status');
    eq(pending.next_action.type, 'upi_collect', 'next_action');
    assert(pending.next_action.upi_collect.qr_payload.startsWith('upi://pay?'), 'QR payload');
    await waitFor(async () => (await retrieve(pi.id)).status === 'captured', { label: 'UPI capture' });
  });
  await test('UPI collect declined by the customer fails the payment', async () => {
    const pi = await createIntent();
    await confirm(pi, await tokenize({ type: 'upi', upi: { vpa: 'fail@pfbank' } }));
    const done = await waitFor(async () => {
      const p = await retrieve(pi.id);
      return p.status === 'failed' ? p : null;
    }, { label: 'UPI failure' });
    eq(done.last_payment_error.decline_code, 'upi_declined', 'decline code');
  });

  console.log('\nUnknown outcomes (acquirer timeout)');
  await test('timeout parks the payment as pending (no failover!), status check resolves it', async () => {
    const pi = await createIntent();
    const res = await confirm(pi, await tokenize(card(CARDS.timeout)));
    eq(res.status, 'pending', 'status right after timeout');
    await waitFor(async () => (await retrieve(pi.id)).status === 'captured', { timeout: 30_000, label: 'status-check resolution' });
    const { attempts } = (await api('GET', `/v1/payment_intents/${pi.id}/timeline`, { key: SK })).body;
    // Earlier attempts may have cascaded past a technical failure (safe: nothing was processed),
    // but nothing may be attempted AFTER the timed-out one: that would risk a double charge.
    const timedOut = attempts.findIndex((a) => /timed out/.test(a.error_message ?? ''));
    assert(timedOut >= 0, 'a timed-out attempt exists');
    eq(timedOut, attempts.length - 1, 'the timed-out attempt is the last one (never retried elsewhere)');
    eq(attempts[timedOut].status, 'approved', 'resolved by status check to the bank\'s real answer');
  });

  console.log('\nAuthorize & capture, cancel, void');
  await test('manual capture: authorize then capture a partial amount', async () => {
    const pi = await createIntent({ capture_method: 'manual' });
    const auth = await confirm(pi, await tokenize(card(CARDS.visa)));
    eq(auth.status, 'authorized', 'status');
    eq(auth.amount_capturable, 49900, 'capturable');
    const cap = await api('POST', `/v1/payment_intents/${pi.id}/capture`, { key: SK, body: { amount_to_capture: 30000 } });
    eq(cap.body.status, 'captured', 'status after capture');
    eq(cap.body.amount_received, 30000, 'amount_received');
  });
  await test('cancel an unpaid intent; void an authorization', async () => {
    const pi = await createIntent();
    eq((await api('POST', `/v1/payment_intents/${pi.id}/cancel`, { key: SK, body: {} })).body.status, 'canceled', 'cancel');
    const pi2 = await createIntent({ capture_method: 'manual' });
    await confirm(pi2, await tokenize(card(CARDS.visa)));
    eq((await api('POST', `/v1/payment_intents/${pi2.id}/cancel`, { key: SK, body: {} })).body.status, 'voided', 'void');
  });
  await test('state machine rejects illegal transitions (confirm a captured payment)', async () => {
    const r = await api('POST', `/v1/payment_intents/${captured.id}/confirm`, { key: SK, body: { payment_method: 'pm_x' } });
    assert(r.status === 400, `expected 400, got ${r.status}`);
  });

  console.log('\nRefunds');
  await test('partial refund, over-refund rejected, then full refund', async () => {
    const pi = await pay(CARDS.visa);
    const r1 = await api('POST', '/v1/refunds', { key: SK, body: { payment_intent: pi.id, amount: 10000 } });
    eq(r1.body.status, 'succeeded', 'first refund');
    eq((await retrieve(pi.id)).status, 'partially_refunded', 'status');
    const over = await api('POST', '/v1/refunds', { key: SK, body: { payment_intent: pi.id, amount: 50000 } });
    eq(over.body.error?.code, 'amount_too_large', 'over-refund error');
    const r2 = await api('POST', '/v1/refunds', { key: SK, body: { payment_intent: pi.id } });
    eq(r2.body.amount, 39900, 'remaining refund amount');
    const final = await retrieve(pi.id);
    eq(final.status, 'refunded', 'final status');
    eq(final.amount_refunded, 49900, 'amount_refunded');
  });
  await test('20 concurrent refunds can never exceed the captured amount', async () => {
    const pi = await pay(CARDS.visa);
    const attempts = await Promise.all(
      Array.from({ length: 20 }, () => api('POST', '/v1/refunds', { key: SK, body: { payment_intent: pi.id, amount: 10000 } })),
    );
    const ok = attempts.filter((r) => r.status === 201).length;
    eq(ok, 4, 'successful refunds (4 × ₹100 fit in ₹499)');
    assert((await retrieve(pi.id)).amount_refunded <= 49900, 'never over-refunded');
  });

  console.log('\nIdempotency & concurrency');
  await test('idempotent replay returns the same object with idempotent-replayed header', async () => {
    const key = randomUUID();
    const body = { amount: 49900, description: 'E2E order', customer_email: 'same@example.com' };
    const a = (await api('POST', '/v1/payment_intents', { key: SK, body, headers: { 'idempotency-key': key } })).body;
    const b = await api('POST', '/v1/payment_intents', { key: SK, body, headers: { 'idempotency-key': key } });
    eq(b.body.id, a.id, 'same id');
    eq(b.headers.get('idempotent-replayed'), 'true', 'replay header');
  });
  await test('same key with a different body is rejected', async () => {
    const key = randomUUID();
    await createIntent({}, key);
    const r = await api('POST', '/v1/payment_intents', { key: SK, body: { amount: 100 }, headers: { 'idempotency-key': key } });
    eq(r.body.error?.code, 'idempotency_key_reused', 'error code');
  });
  await test('idempotency storm: 50 concurrent identical requests create exactly 1 payment', async () => {
    const key = randomUUID();
    const body = { amount: 12345, description: 'storm' };
    const responses = await Promise.all(
      Array.from({ length: 50 }, () => api('POST', '/v1/payment_intents', { key: SK, body, headers: { 'idempotency-key': key } })),
    );
    const ids = new Set(responses.filter((r) => r.status === 201).map((r) => r.body.id));
    eq(ids.size, 1, 'distinct payment intents created');
    assert(responses.every((r) => r.status === 201 || r.status === 409), 'only 201 or 409 responses');
  });
  await test('10 concurrent confirms on one payment charge the customer exactly once', async () => {
    const pi = await createIntent();
    const pm = await tokenize(card(CARDS.visa));
    const responses = await Promise.all(
      Array.from({ length: 10 }, () => api('POST', `/v1/payment_intents/${pi.id}/confirm`, { key: PK, body: { payment_method: pm.id, client_secret: pi.client_secret } })),
    );
    eq(responses.filter((r) => r.status === 200 && r.body.status === 'captured').length, 1, 'confirms that captured');
    assert(responses.filter((r) => r.status !== 200).every((r) => r.body.error?.code === 'unexpected_state'), 'losers get unexpected_state');
    const timeline = (await api('GET', `/v1/payment_intents/${pi.id}/timeline`, { key: SK })).body;
    eq(timeline.attempts.filter((a) => a.status === 'approved').length, 1, 'approved attempts (charges)');
  });

  console.log('\nRisk engine');
  await test('risky payment (foreign card + high value + disposable email) is escalated', async () => {
    const pi = await pay(CARDS.international, { amount: 15_000_000, customer_email: `x${Date.now()}@mailinator.com` });
    const ra = (await api('GET', `/v1/risk/assessments?payment_intent=${pi.id}`, { key: SK })).body.data[0];
    assert(['international_card', 'high_value', 'disposable_email'].every((rule) => ra.reasons.some((r) => r.rule === rule)), 'expected rules fired');
    // Score 50 => challenge (step-up OTP). Re-running the suite within 10 minutes also trips card velocity => block.
    if (ra.decision === 'challenge') eq(pi.status, 'requires_action', 'challenged payment requires OTP');
    else if (ra.decision === 'block') eq(pi.last_payment_error.decline_code, 'risk_blocked', 'blocked payment');
    else throw new Error(`expected challenge or block, got ${ra.decision} (score ${ra.score})`);
  });
  await test('blocklisted card is blocked before reaching any acquirer', async () => {
    const pm = await tokenize(card(CARDS.mastercard));
    const entry = (await api('POST', '/v1/risk/blocklist', { key: SK, body: { type: 'fingerprint', value: pm.fingerprint, reason: 'e2e' } })).body;
    try {
      const pi = await createIntent();
      const res = await confirm(pi, pm);
      eq(res.status, 'failed', 'status');
      eq(res.last_payment_error.decline_code, 'risk_blocked', 'decline code');
      const timeline = (await api('GET', `/v1/payment_intents/${pi.id}/timeline`, { key: SK })).body;
      eq(timeline.attempts.length, 0, 'no acquirer attempts');
    } finally {
      await api('DELETE', `/v1/risk/blocklist/${entry.id}`, { key: SK });
    }
  });

  console.log('\nSmart routing & failover');
  await test('outage of the preferred acquirer: payments fail over and keep succeeding', async () => {
    // Take down whichever bank the router ACTUALLY prefers right now. (Reading scores isn't enough:
    // 5% epsilon-exploration can route the first payment elsewhere, which then becomes preferred.)
    await api('POST', '/v1/routing/reset', { key: JWT });
    const probe = await pay(CARDS.visa);
    const used = (await api('GET', `/v1/payment_intents/${probe.id}/timeline`, { key: SK })).body.attempts.find((a) => a.status === 'approved').acquirer;
    const cardAcquirers = (await api('GET', '/v1/routing/health', { key: SK })).body.acquirers.filter((a) => a.methods.card);
    const preferred = cardAcquirers.find((a) => a.code === used);
    const backup = cardAcquirers.find((a) => a.code !== used);
    // Deterministic test: the backup's own random technical failures (realistic, ~0.5-2%) are switched off.
    const sim = (await api('GET', '/v1/simulator/acquirers', { key: JWT })).body.data;
    const backupRate = sim.find((a) => a.code === backup.code).technical_failure_rate;
    await api('PATCH', `/v1/simulator/acquirers/${backup.code}`, { key: JWT, body: { technical_failure_rate: 0 } });
    await api('PATCH', `/v1/simulator/acquirers/${preferred.code}`, { key: JWT, body: { down: true } });
    try {
      const payments = [];
      for (let i = 0; i < 12; i++) payments.push(await pay(CARDS.visa));
      eq(payments.filter((p) => p.status === 'captured').length, 12, `captured while ${preferred.name} is down`);
      const timelines = await Promise.all(payments.map((p) => api('GET', `/v1/payment_intents/${p.id}/timeline`, { key: SK }).then((r) => r.body)));
      const failovers = timelines.filter(
        (t) => t.attempts.some((a) => a.acquirer === preferred.code && a.status === 'technical_failure') && t.attempts.some((a) => a.acquirer === backup.code && a.status === 'approved'),
      ).length;
      assert(failovers >= 1, `expected at least one ${preferred.code} -> ${backup.code} failover, saw ${failovers}`);
      const after = (await api('GET', '/v1/routing/health', { key: SK })).body.acquirers;
      const down = after.find((a) => a.code === preferred.code);
      const up = after.find((a) => a.code === backup.code);
      assert(down.circuit === 'open' || down.methods.card.score < up.methods.card.score, `${preferred.code} should be circuit-open or demoted`);
      console.log(`    \x1b[2m${preferred.name} down: ${failovers} payment(s) failed over to ${backup.name}; ${preferred.code} circuit=${down.circuit}\x1b[0m`);
    } finally {
      await api('PATCH', `/v1/simulator/acquirers/${preferred.code}`, { key: JWT, body: { down: false } });
      await api('PATCH', `/v1/simulator/acquirers/${backup.code}`, { key: JWT, body: { technical_failure_rate: backupRate } });
    }
  });

  console.log('\nSecurity');
  await test('publishable key cannot create payments or read data', async () => {
    eq((await api('POST', '/v1/payment_intents', { key: PK, body: { amount: 100 } })).status, 403, 'create with pk');
    eq((await api('GET', '/v1/balance', { key: PK })).status, 403, 'balance with pk');
  });
  await test('wrong client_secret hides the payment (404)', async () => {
    const pi = await createIntent();
    eq((await api('GET', `/v1/payment_intents/${pi.id}?client_secret=nope`, { key: PK })).status, 404, 'status');
  });
  await test('invalid API key is rejected', async () => {
    eq((await api('GET', '/v1/balance', { key: 'sk_test_' + 'x'.repeat(32) })).status, 401, 'status');
  });
  await test('services reject calls that bypass the gateway', async () => {
    let r;
    try {
      r = await fetch('http://localhost:4002/v1/payment_intents', { headers: { 'x-merchant-id': MERCHANT, 'x-auth-type': 'secret' } });
    } catch {
      return; // In Docker only the gateway is published: internal services aren't reachable at all.
    }
    eq(r.status, 401, 'direct call status (spoofed merchant headers without the internal token)');
  });

  console.log('\nWebhooks, ledger, settlement');
  await test('webhooks are delivered with valid signatures, without internal fields', async () => {
    const hook = await waitFor(() => received.find((h) => h.event.type === 'payment_intent.captured' && h.event.data.object.id === captured.id), {
      label: 'captured webhook',
    });
    assert(hook.valid, 'signature valid');
    assert(!('internal' in hook.event), 'internal fields stripped');
  });
  await test('ledger stays balanced (debits = credits, accounting equation holds)', async () => {
    await sleep(1500);
    const r = (await api('GET', '/v1/ledger/integrity', { key: SK })).body;
    assert(r.balanced, `ledger unbalanced: ${JSON.stringify(r.accounting_equation)}`);
    eq(r.total_debits, r.total_credits, 'debits vs credits');
  });
  await test('reconciliation matches acquirer reports and pays the merchant', async () => {
    await sleep(1000);
    const before = (await api('GET', '/v1/balance', { key: SK })).body.available;
    const run = (await api('POST', '/v1/settlements/run', { key: JWT })).body;
    const mine = run.payouts.find((p) => p.merchant_id === MERCHANT);
    eq(mine?.status, 'paid', `payout status (${JSON.stringify(mine)})`);
    assert(run.reconciliation.some((r) => r.matched > 0), 'some transactions matched');
    const after = await waitFor(async () => {
      const b = (await api('GET', '/v1/balance', { key: SK })).body;
      return b.lifetime.paid_out > 0 ? b : null;
    }, { label: 'payout posted to ledger' });
    eq(after.available, before - mine.amount, 'balance reduced by payout');
  });

  // ------------------------------------------------------------------ summary
  hookServer.close();
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed${failed.length ? `, ${failed.length} failed` : ''}\n`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((err) => {
  console.error(`Fatal error in "${current}":`, err);
  process.exit(1);
});
