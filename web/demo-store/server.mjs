// ChaiCart: a sample merchant integrating PayForge the way a real store should:
//   1. The SERVER computes the amount and creates the PaymentIntent with the secret key.
//   2. The BROWSER only ever sees the client_secret and the publishable key.
//   3. The order is marked paid only by a VERIFIED WEBHOOK, never by the browser redirect.
import express from 'express';
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
loadEnv(join(here, '.env'));

const PORT = Number(process.env.PORT ?? 3000);
const API_URL = process.env.PAYFORGE_API_URL ?? 'http://localhost:8080';
const CHECKOUT_URL = process.env.PAYFORGE_CHECKOUT_URL ?? 'http://localhost:5174';
const { PAYFORGE_SECRET_KEY: SECRET_KEY, PAYFORGE_PUBLISHABLE_KEY: PUBLISHABLE_KEY, PAYFORGE_WEBHOOK_SECRET: WEBHOOK_SECRET } = process.env;

if (!SECRET_KEY || !PUBLISHABLE_KEY || !WEBHOOK_SECRET) {
  console.error('Missing PayForge keys. Run `npm run seed` from the repository root (it writes web/demo-store/.env).');
  process.exit(1);
}

const PRODUCTS = [
  { id: 'masala-chai', name: 'Masala Chai', detail: '250 g · cardamom, ginger, clove', price: 34900, hue: 18 },
  { id: 'assam-gold', name: 'Assam CTC Gold', detail: '500 g · strong & malty', price: 49900, hue: 35 },
  { id: 'darjeeling', name: 'Darjeeling First Flush', detail: '100 g · muscatel, floral', price: 89900, hue: 95 },
  { id: 'kahwa', name: 'Kashmiri Kahwa', detail: '100 g · saffron & almond', price: 64900, hue: 48 },
  { id: 'kulhad', name: 'Kulhad Set', detail: '6 clay cups', price: 39900, hue: 12 },
  { id: 'kettle', name: 'Brass Chai Kettle', detail: '1.2 L · hand-hammered', price: 149900, hue: 42 },
];

const orders = new Map();
const processedEvents = new Set();
let failWebhooksUntil = 0;

const app = express();

// ---------------------------------------------------------------- webhook (needs the RAW body to verify the signature)
app.post('/webhooks/payforge', express.raw({ type: '*/*' }), (req, res) => {
  if (Date.now() < failWebhooksUntil) {
    return res.status(503).send('Chaos mode: endpoint is "down" so you can watch PayForge retry with backoff');
  }
  const body = req.body.toString('utf8');
  const check = verifySignature(body, req.get('payforge-signature'), WEBHOOK_SECRET);
  if (!check.ok) {
    console.warn(`Rejected webhook: ${check.reason}`);
    return res.status(400).send(check.reason);
  }
  const event = JSON.parse(body);
  // Deliveries are at-least-once: de-duplicate on event id.
  if (processedEvents.has(event.id)) return res.sendStatus(200);
  processedEvents.add(event.id);

  const object = event.data.object;
  const piId = object.object === 'refund' ? object.payment_intent : object.id;
  const order = [...orders.values()].find((o) => o.payment_intent === piId);
  if (order) {
    order.events.push({ type: event.type, at: new Date().toISOString() });
    if (event.type === 'payment_intent.captured') {
      order.status = 'paid';
      order.paid_at = new Date().toISOString();
    } else if (event.type === 'payment_intent.payment_failed') {
      order.last_error = object.last_payment_error?.message ?? 'Payment failed';
    } else if (event.type === 'refund.succeeded') {
      order.refunded = (order.refunded ?? 0) + object.amount;
      order.status = order.refunded >= order.amount ? 'refunded' : 'partially_refunded';
    }
    console.log(`Webhook ${event.type} -> order ${order.id} is now ${order.status}`);
  }
  res.sendStatus(200);
});

app.use(express.json());
app.use(express.static(join(here, 'public')));

// The PayForge.js SDK (in production you'd load it from PayForge's CDN).
app.get('/sdk/payforge.js', (_req, res) => {
  const file = join(here, '..', '..', 'sdk', 'payforge-js', 'dist', 'payforge.umd.cjs');
  if (!existsSync(file)) return res.status(404).type('text/plain').send('Build the SDK first: npm run build:sdk');
  res.type('application/javascript').send(readFileSync(file));
});

app.get('/api/config', (_req, res) => {
  res.json({ publishableKey: PUBLISHABLE_KEY, checkoutUrl: CHECKOUT_URL, products: PRODUCTS });
});

app.post('/api/orders', async (req, res) => {
  const items = Array.isArray(req.body?.items) ? req.body.items : [];
  const lines = items
    .map((i) => ({ product: PRODUCTS.find((p) => p.id === i.id), qty: Math.min(Math.max(parseInt(i.qty, 10) || 0, 0), 10) }))
    .filter((l) => l.product && l.qty > 0);
  if (!lines.length) return res.status(400).json({ error: 'Your cart is empty' });

  // Never trust a price from the browser: compute it on the server.
  const amount = lines.reduce((sum, l) => sum + l.product.price * l.qty, 0);
  const order = {
    id: `ord_${randomUUID().slice(0, 8)}`,
    items: lines.map((l) => ({ id: l.product.id, name: l.product.name, qty: l.qty, price: l.product.price })),
    amount,
    status: 'awaiting_payment',
    created_at: new Date().toISOString(),
    events: [],
  };

  const response = await fetch(`${API_URL}/v1/payment_intents`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${SECRET_KEY}`,
      'content-type': 'application/json',
      // If this request is retried (timeout, double click), PayForge returns the same intent.
      'idempotency-key': `order-${order.id}`,
    },
    body: JSON.stringify({
      amount,
      description: `ChaiCart order ${order.id}`,
      customer_email: typeof req.body.email === 'string' && req.body.email.includes('@') ? req.body.email : undefined,
      metadata: { order_id: order.id },
    }),
  }).catch((err) => ({ ok: false, json: async () => ({ error: { message: err.message } }) }));

  const pi = await response.json();
  if (!response.ok) return res.status(502).json({ error: pi.error?.message ?? 'Could not reach PayForge' });
  order.payment_intent = pi.id;
  orders.set(order.id, order);
  res.status(201).json({ order, client_secret: pi.client_secret });
});

app.get('/api/orders', (_req, res) => res.json([...orders.values()].reverse()));
app.get('/api/orders/:id', (req, res) => {
  const order = orders.get(req.params.id);
  return order ? res.json(order) : res.status(404).json({ error: 'Order not found' });
});

app.post('/api/chaos/webhooks', (req, res) => {
  const seconds = Math.min(Math.max(Number(req.body?.seconds) || 0, 0), 600);
  failWebhooksUntil = Date.now() + seconds * 1000;
  res.json({ failing_until: seconds ? new Date(failWebhooksUntil).toISOString() : null });
});
app.get('/api/chaos/webhooks', (_req, res) =>
  res.json({ failing_until: Date.now() < failWebhooksUntil ? new Date(failWebhooksUntil).toISOString() : null }),
);

app.listen(PORT, () => console.log(`ChaiCart demo store on http://localhost:${PORT}`));

// ---------------------------------------------------------------- helpers

/** PayForge-Signature: t=<unix>,v1=<hex HMAC-SHA256(secret, `${t}.${body}`)>; reject if older than 5 minutes. */
function verifySignature(body, header, secret, toleranceSeconds = 300) {
  if (!header) return { ok: false, reason: 'missing signature' };
  const parts = Object.fromEntries(header.split(',').map((kv) => kv.split('=').map((s) => s.trim())));
  const timestamp = Number(parts.t);
  if (!timestamp || !parts.v1) return { ok: false, reason: 'malformed signature' };
  if (Math.abs(Date.now() / 1000 - timestamp) > toleranceSeconds) return { ok: false, reason: 'stale signature (possible replay)' };
  const expected = Buffer.from(createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex'));
  const given = Buffer.from(parts.v1);
  return expected.length === given.length && timingSafeEqual(expected, given) ? { ok: true } : { ok: false, reason: 'signature mismatch' };
}

function loadEnv(file) {
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (match && process.env[match[1]] === undefined) process.env[match[1]] = match[2].replace(/^['"]|['"]$/g, '');
  }
}
