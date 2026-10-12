import http from 'k6/http';

export const API = __ENV.API_URL || 'http://localhost:8080';

export function uuid() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

/** Simulated customers come from many IPs, as real traffic does (per-IP limits and risk rules). */
export function randomIp() {
  return `10.${(Math.random() * 255) | 0}.${(Math.random() * 255) | 0}.${1 + ((Math.random() * 253) | 0)}`;
}

/** Random Luhn-valid Visa number: every customer has their own card. */
export function randomCard() {
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

export function headers(key, extra = {}) {
  return { headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', 'x-forwarded-for': randomIp(), ...extra } };
}

export function signupMerchants(n) {
  const merchants = [];
  for (let i = 0; i < n; i++) {
    const res = http.post(
      `${API}/v1/merchants/signup`,
      JSON.stringify({ name: 'k6', email: `k6+${uuid().slice(0, 8)}@payforge.dev`, password: 'k6-load-test-pw', business_name: `k6 Merchant ${i}` }),
      { headers: { 'content-type': 'application/json', 'x-forwarded-for': randomIp() } },
    );
    if (res.status !== 201) throw new Error(`signup failed: ${res.status} ${res.body}`);
    const body = res.json();
    merchants.push({ sk: body.api_keys.secret_key, pk: body.api_keys.publishable_key, jwt: body.token });
  }
  return merchants;
}

/** The real three-call flow: create (server), tokenize (browser), confirm (browser). */
export function payOnce(m, metrics) {
  const pi = http.post(`${API}/v1/payment_intents`, JSON.stringify({ amount: 49900, description: 'k6 load' }), headers(m.sk, { 'idempotency-key': uuid() }));
  if (pi.status !== 201) return metrics.success.add(false);
  const pm = http.post(
    `${API}/v1/payment_methods`,
    JSON.stringify({ type: 'card', card: { number: randomCard(), exp_month: 12, exp_year: 2031, cvc: '123' } }),
    headers(m.pk),
  );
  if (pm.status !== 201) return metrics.success.add(false);
  const confirm = http.post(
    `${API}/v1/payment_intents/${pi.json('id')}/confirm`,
    JSON.stringify({ payment_method: pm.json('id'), client_secret: pi.json('client_secret') }),
    headers(m.pk),
  );
  metrics.confirm.add(confirm.timings.duration);
  metrics.success.add(confirm.status === 200 && confirm.json('status') === 'captured');
}
