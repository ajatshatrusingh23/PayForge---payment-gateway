import QRCode from 'qrcode';
import { Api, ApiError, PaymentIntent } from './api';
import { detectBrand, formatCardNumber, formatExpiry, luhnValid, parseExpiry, TEST_CARDS, TEST_VPAS } from './card';
import './styles.css';

const API_URL: string = import.meta.env.VITE_API_URL ?? 'http://localhost:8080';
const SUCCESS = ['captured', 'authorized', 'partially_refunded', 'refunded'];
const POLL_MS = 2_000;
const POLL_LIMIT_MS = 6 * 60_000;

// Parameters arrive in the URL fragment (never sent to any server).
const params = new URLSearchParams(location.hash.slice(1));
const clientSecret = params.get('cs') ?? '';
const publishableKey = params.get('pk') ?? '';
const parentOrigin = safeOrigin(params.get('origin'));
const mode = params.get('mode') ?? 'standalone';
const returnUrl = params.get('return_url');
const embedded = window.parent !== window;
document.documentElement.dataset.theme = params.get('theme') === 'dark' ? 'dark' : 'light';

const app = document.getElementById('app')!;
const api = new Api(API_URL, publishableKey, clientSecret);

let intent: PaymentIntent | null = null;
let tab: 'card' | 'upi' = 'card';
let pollTimer: number | undefined;
let pollStarted = 0;
let countdownTimer: number | undefined;

// ------------------------------------------------------------------ parent window messaging

function safeOrigin(value: string | null): string | null {
  try {
    return value ? new URL(value).origin : null;
  } catch {
    return null;
  }
}

/** Messages only ever go to the exact origin that embedded us (never '*'). */
function notify(message: Record<string, unknown>): void {
  if (embedded && parentOrigin) window.parent.postMessage(message, parentOrigin);
}

new ResizeObserver(() => notify({ type: 'payforge:resize', height: Math.ceil(document.documentElement.scrollHeight) })).observe(document.body);

// ------------------------------------------------------------------ rendering helpers

const esc = (s: unknown) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

const inr = (paise: number) =>
  `₹${(paise / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const ICONS = {
  lock: '<svg viewBox="0 0 24 24" width="12" height="12" aria-hidden="true"><path fill="currentColor" d="M12 2a5 5 0 0 0-5 5v3H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8a2 2 0 0 0-2-2h-1V7a5 5 0 0 0-5-5Zm-3 8V7a3 3 0 1 1 6 0v3H9Z"/></svg>',
  check: '<svg viewBox="0 0 52 52" width="64" height="64" aria-hidden="true"><circle cx="26" cy="26" r="25" fill="none" stroke="currentColor" stroke-width="2"/><path fill="none" stroke="currentColor" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round" d="M14 27l8 8 16-17"/></svg>',
  cross: '<svg viewBox="0 0 52 52" width="64" height="64" aria-hidden="true"><circle cx="26" cy="26" r="25" fill="none" stroke="currentColor" stroke-width="2"/><path fill="none" stroke="currentColor" stroke-width="3.5" stroke-linecap="round" d="M18 18l16 16M34 18 18 34"/></svg>',
  close: '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M6.4 5 5 6.4 10.6 12 5 17.6 6.4 19l5.6-5.6 5.6 5.6 1.4-1.4-5.6-5.6L19 6.4 17.6 5 12 10.6z"/></svg>',
};

function shell(body: string): void {
  const pi = intent;
  app.innerHTML = `
    <section class="card">
      <header class="head">
        <div>
          <div class="merchant">${esc(pi?.statement_descriptor ?? 'PayForge')}</div>
          ${pi?.description ? `<div class="desc">${esc(pi.description)}</div>` : ''}
        </div>
        <div class="head-right">
          ${pi ? `<div class="amount">${inr(pi.amount)}</div>` : ''}
          ${mode === 'modal' ? `<button class="icon-btn" id="close" aria-label="Close checkout">${ICONS.close}</button>` : ''}
        </div>
      </header>
      <span class="test-pill">TEST MODE</span>
      <div class="body">${body}</div>
      <footer class="foot">${ICONS.lock}<span>Secured by <strong>PayForge</strong> · card data never touches the merchant</span></footer>
    </section>`;
  document.getElementById('close')?.addEventListener('click', () => notify({ type: 'payforge:close' }));
}

function spinner(text: string, sub = ''): string {
  return `<div class="center"><div class="spinner" role="status"></div><p class="lead">${esc(text)}</p>${sub ? `<p class="muted">${sub}</p>` : ''}</div>`;
}

// ------------------------------------------------------------------ screens

function renderForm(error?: string): void {
  const types = intent?.payment_method_types ?? ['card', 'upi'];
  if (!types.includes(tab)) tab = types[0];
  const tabs =
    types.length > 1
      ? `<div class="tabs" role="tablist">${types
          .map((t) => `<button type="button" role="tab" data-tab="${t}" class="${t === tab ? 'active' : ''}" aria-selected="${t === tab}">${t === 'card' ? 'Card' : 'UPI'}</button>`)
          .join('')}</div>`
      : '';
  const errorBox = `<div class="error" id="error" role="alert">${error ? esc(error) : ''}</div>`;
  const pay = `<button class="pay" type="submit" id="pay">Pay ${inr(intent!.amount)}</button>`;

  const cardForm = `
    <form id="form" novalidate>
      <label>Card number
        <div class="with-badge">
          <input id="number" inputmode="numeric" autocomplete="cc-number" placeholder="1234 1234 1234 1234" required />
          <span class="brand" id="brand"></span>
        </div>
      </label>
      <div class="row">
        <label>Expiry<input id="exp" inputmode="numeric" autocomplete="cc-exp" placeholder="MM / YY" required /></label>
        <label>CVC<input id="cvc" inputmode="numeric" autocomplete="cc-csc" placeholder="123" maxlength="4" required /></label>
      </div>
      <label>Name on card<input id="name" autocomplete="cc-name" placeholder="As printed on card" /></label>
      ${errorBox}${pay}
    </form>
    <details class="helper"><summary>Test cards</summary>
      <ul>${TEST_CARDS.map((c) => `<li><button type="button" class="fill" data-card="${c.number}">${c.number}</button><span>${esc(c.label)}</span></li>`).join('')}</ul>
      <p class="muted">Any future expiry, any 3-digit CVC.</p>
    </details>`;

  const upiForm = `
    <form id="form" novalidate>
      <label>UPI ID<input id="vpa" autocomplete="off" placeholder="yourname@bank" required /></label>
      <p class="muted">We'll send a payment request to your UPI app. Approve it there to complete the payment.</p>
      ${errorBox}${pay}
    </form>
    <details class="helper"><summary>Test UPI IDs</summary>
      <ul>${TEST_VPAS.map((v) => `<li><button type="button" class="fill" data-vpa="${v.vpa}">${v.vpa}</button><span>${esc(v.label)}</span></li>`).join('')}</ul>
    </details>`;

  shell(`${tabs}${tab === 'card' ? cardForm : upiForm}`);

  app.querySelectorAll<HTMLButtonElement>('[data-tab]').forEach((b) =>
    b.addEventListener('click', () => {
      tab = b.dataset.tab as 'card' | 'upi';
      renderForm();
    }),
  );

  if (tab === 'card') {
    const number = document.getElementById('number') as HTMLInputElement;
    const exp = document.getElementById('exp') as HTMLInputElement;
    const brand = document.getElementById('brand')!;
    number.addEventListener('input', () => {
      number.value = formatCardNumber(number.value);
      const b = detectBrand(number.value.replace(/\D/g, ''));
      brand.textContent = b === 'unknown' ? '' : b.toUpperCase();
    });
    exp.addEventListener('input', (e) => {
      if ((e as InputEvent).inputType?.startsWith('delete')) return;
      exp.value = formatExpiry(exp.value);
    });
    app.querySelectorAll<HTMLButtonElement>('[data-card]').forEach((b) =>
      b.addEventListener('click', () => {
        number.value = b.dataset.card!;
        number.dispatchEvent(new Event('input'));
        exp.value = '12 / 30';
        (document.getElementById('cvc') as HTMLInputElement).value = '123';
        (document.getElementById('name') as HTMLInputElement).value = 'Test Customer';
      }),
    );
  } else {
    app.querySelectorAll<HTMLButtonElement>('[data-vpa]').forEach((b) =>
      b.addEventListener('click', () => {
        (document.getElementById('vpa') as HTMLInputElement).value = b.dataset.vpa!;
      }),
    );
  }
  document.getElementById('form')!.addEventListener('submit', (e) => {
    e.preventDefault();
    void (tab === 'card' ? submitCard() : submitUpi());
  });
}

function showError(message: string): void {
  const el = document.getElementById('error');
  if (el) el.textContent = message;
  setBusy(false);
}

function setBusy(busy: boolean): void {
  const btn = document.getElementById('pay') as HTMLButtonElement | null;
  if (!btn || !intent) return;
  btn.disabled = busy;
  btn.innerHTML = busy ? '<span class="btn-spinner"></span> Processing…' : `Pay ${inr(intent.amount)}`;
}

async function submitCard(): Promise<void> {
  const digits = (document.getElementById('number') as HTMLInputElement).value.replace(/\D/g, '');
  const expiry = parseExpiry((document.getElementById('exp') as HTMLInputElement).value);
  const cvc = (document.getElementById('cvc') as HTMLInputElement).value.trim();
  const name = (document.getElementById('name') as HTMLInputElement).value.trim();
  if (!luhnValid(digits)) return showError('Your card number is invalid.');
  if (!expiry) return showError("Your card's expiry date is invalid or in the past.");
  if (!/^\d{3,4}$/.test(cvc)) return showError("Your card's security code is invalid.");
  setBusy(true);
  try {
    const pm = await api.createPaymentMethod({
      type: 'card',
      card: { number: digits, exp_month: expiry.month, exp_year: expiry.year, cvc, ...(name ? { name } : {}) },
    });
    handle(await api.confirm(pm.id));
  } catch (err) {
    showError((err as Error).message);
  }
}

async function submitUpi(): Promise<void> {
  const vpa = (document.getElementById('vpa') as HTMLInputElement).value.trim();
  if (!/^[a-zA-Z0-9._-]{2,256}@[a-zA-Z][a-zA-Z0-9]{1,63}$/.test(vpa)) return showError('Enter a valid UPI ID, e.g. name@bank.');
  setBusy(true);
  try {
    const pm = await api.createPaymentMethod({ type: 'upi', upi: { vpa } });
    handle(await api.confirm(pm.id));
  } catch (err) {
    showError((err as Error).message);
  }
}

function renderOtp(error?: string): void {
  const action = intent?.next_action?.type === 'otp' ? intent.next_action.otp : null;
  shell(`
    <form id="otp-form" class="otp" novalidate>
      <h2>Verify it's you</h2>
      <p class="muted">Your bank sent a one-time password to your registered mobile number.</p>
      <input id="otp" class="otp-input" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="••••••" aria-label="One-time password" />
      ${action?.test_hint ? `<p class="hint">${esc(action.test_hint)}</p>` : ''}
      ${action ? `<p class="muted small">${action.attempts_remaining} attempt${action.attempts_remaining === 1 ? '' : 's'} remaining</p>` : ''}
      <div class="error" id="error" role="alert">${error ? esc(error) : ''}</div>
      <button class="pay" type="submit" id="pay">Verify &amp; pay ${inr(intent!.amount)}</button>
    </form>`);
  const input = document.getElementById('otp') as HTMLInputElement;
  input.focus();
  input.addEventListener('input', () => (input.value = input.value.replace(/\D/g, '').slice(0, 6)));
  document.getElementById('otp-form')!.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (input.value.length < 4) return showError('Enter the OTP sent to your phone.');
    setBusy(true);
    try {
      handle(await api.verifyOtp(input.value));
    } catch (err) {
      showError((err as Error).message);
    }
  });
}

async function renderUpiWaiting(): Promise<void> {
  const upi = intent?.next_action?.type === 'upi_collect' ? intent.next_action.upi_collect : null;
  shell(`
    <div class="center upi">
      <canvas id="qr" aria-label="UPI QR code"></canvas>
      <p class="lead">Approve the request in your UPI app</p>
      <p class="muted">Request sent to <strong>${esc(upi?.vpa ?? '')}</strong>. Or scan the QR with any UPI app.</p>
      <div class="waiting"><div class="spinner small"></div><span>Waiting for approval · <span id="countdown"></span></span></div>
    </div>`);
  if (upi) {
    await QRCode.toCanvas(document.getElementById('qr') as HTMLCanvasElement, upi.qr_payload, { width: 180, margin: 1 });
    const expires = new Date(upi.expires_at).getTime();
    const tick = () => {
      const left = Math.max(0, Math.round((expires - Date.now()) / 1000));
      const el = document.getElementById('countdown');
      if (el) el.textContent = `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;
    };
    tick();
    countdownTimer = window.setInterval(tick, 1000);
  }
}

function renderSuccess(): void {
  const pi = intent!;
  shell(`
    <div class="center result success">
      ${ICONS.check}
      <h2>Payment successful</h2>
      <p class="big">${inr(pi.amount)}</p>
      <p class="muted small">Payment ID <code>${esc(pi.id)}</code></p>
      <p class="muted">${embedded ? 'You can close this window.' : returnUrl ? 'Returning you to the merchant…' : 'You can close this page.'}</p>
    </div>`);
}

function renderTerminal(title: string, message: string): void {
  shell(`<div class="center result failure">${ICONS.cross}<h2>${esc(title)}</h2><p class="muted">${esc(message)}</p></div>`);
}

// ------------------------------------------------------------------ state handling

function handle(pi: PaymentIntent): void {
  intent = pi;
  window.clearTimeout(pollTimer);
  window.clearInterval(countdownTimer);

  if (SUCCESS.includes(pi.status)) {
    renderSuccess();
    notify({ type: 'payforge:result', paymentIntentId: pi.id, status: pi.status });
    if (!embedded && returnUrl) {
      setTimeout(() => (location.href = `${returnUrl}${returnUrl.includes('?') ? '&' : '?'}payment_intent=${pi.id}&status=${pi.status}`), 1500);
    }
    return;
  }
  switch (pi.status) {
    case 'created':
      return renderForm();
    case 'failed': {
      const error = pi.last_payment_error ?? { code: 'payment_failed', message: 'Your payment could not be completed.' };
      notify({ type: 'payforge:result', paymentIntentId: pi.id, status: pi.status, error: { code: error.code, message: error.message } });
      return renderForm(`${error.message} Please try another payment method.`);
    }
    case 'requires_action':
      return renderOtp(pi.last_payment_error?.code === 'incorrect_otp' ? pi.last_payment_error.message : undefined);
    case 'pending':
      if (pi.next_action?.type === 'upi_collect') void renderUpiWaiting();
      else shell(spinner('Confirming with your bank…', 'This can take a few seconds. Please don’t close this window.'));
      return poll();
    case 'processing':
      shell(spinner('Processing your payment…'));
      return poll();
    case 'expired':
      return renderTerminal('Payment link expired', 'Please return to the merchant and try again.');
    case 'canceled':
    case 'voided':
      return renderTerminal('Payment canceled', 'This payment was canceled by the merchant.');
    default:
      return renderTerminal('Something went wrong', `Unexpected payment status: ${pi.status}`);
  }
}

function poll(): void {
  if (!pollStarted) pollStarted = Date.now();
  if (Date.now() - pollStarted > POLL_LIMIT_MS) {
    renderTerminal('Still waiting…', 'We have not heard back from your bank yet. You will be notified once the payment is confirmed.');
    return;
  }
  pollTimer = window.setTimeout(async () => {
    try {
      const latest = await api.retrieve();
      if (latest.status === intent?.status && (latest.status === 'pending' || latest.status === 'processing')) return poll();
      pollStarted = 0;
      handle(latest);
    } catch {
      poll();
    }
  }, POLL_MS);
}

async function start(): Promise<void> {
  if (!clientSecret.includes('_secret_') || !publishableKey.startsWith('pk_')) {
    return renderTerminal('Invalid checkout link', 'This checkout link is missing or malformed.');
  }
  shell(spinner('Loading secure checkout…'));
  try {
    handle(await api.retrieve());
    notify({ type: 'payforge:ready' });
  } catch (err) {
    const e = err as ApiError;
    renderTerminal(e.status === 404 ? 'Payment not found' : 'Unable to load checkout', e.message);
  }
}

void start();
