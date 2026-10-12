/* global PayForge */
const inr = (paise) => `₹${(paise / 100).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`;
const cart = new Map();
let config;

async function init() {
  config = await (await fetch('/api/config')).json();
  renderProducts();
  renderCart();
  document.getElementById('checkout').addEventListener('click', checkout);
}

function renderProducts() {
  const grid = document.getElementById('products');
  grid.innerHTML = config.products
    .map(
      (p) => `
      <article class="product">
        <div class="thumb" style="--h:${p.hue}"><span>${p.name
          .split(' ')
          .map((w) => w[0])
          .join('')
          .slice(0, 2)}</span></div>
        <div class="product-body">
          <h3>${p.name}</h3>
          <p>${p.detail}</p>
          <div class="product-foot">
            <strong>${inr(p.price)}</strong>
            <button class="btn" data-add="${p.id}">Add</button>
          </div>
        </div>
      </article>`,
    )
    .join('');
  grid.querySelectorAll('[data-add]').forEach((b) =>
    b.addEventListener('click', () => {
      cart.set(b.dataset.add, (cart.get(b.dataset.add) ?? 0) + 1);
      renderCart();
    }),
  );
}

function renderCart() {
  const lines = [...cart.entries()].map(([id, qty]) => ({ product: config.products.find((p) => p.id === id), qty }));
  const total = lines.reduce((s, l) => s + l.product.price * l.qty, 0);
  const el = document.getElementById('cart-lines');
  el.innerHTML = lines.length
    ? lines
        .map(
          (l) => `<div class="line"><span>${l.product.name} <span class="qty">× ${l.qty}</span></span>
            <span>${inr(l.product.price * l.qty)} <button class="link" data-remove="${l.product.id}" aria-label="Remove">✕</button></span></div>`,
        )
        .join('')
    : '<p class="empty">Your cart is empty.</p>';
  el.querySelectorAll('[data-remove]').forEach((b) =>
    b.addEventListener('click', () => {
      cart.delete(b.dataset.remove);
      renderCart();
    }),
  );
  document.getElementById('cart-total').textContent = inr(total);
  const btn = document.getElementById('checkout');
  btn.disabled = !lines.length;
  btn.textContent = lines.length ? `Checkout · ${inr(total)}` : 'Checkout';
}

function setStatus(html, kind = 'info') {
  const el = document.getElementById('status');
  el.hidden = false;
  el.className = `status ${kind}`;
  el.innerHTML = html;
}

async function checkout() {
  const btn = document.getElementById('checkout');
  btn.disabled = true;
  setStatus('Creating your order…');
  const res = await fetch('/api/orders', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      items: [...cart.entries()].map(([id, qty]) => ({ id, qty })),
      email: document.getElementById('email').value,
    }),
  });
  const data = await res.json();
  if (!res.ok) {
    setStatus(data.error ?? 'Something went wrong', 'error');
    btn.disabled = false;
    return;
  }

  setStatus(`Order <code>${data.order.id}</code> created. Complete payment in the secure checkout.`);
  const payforge = PayForge(config.publishableKey, { checkoutUrl: config.checkoutUrl });
  const handle = payforge.open({
    clientSecret: data.client_secret,
    onSuccess: () => {
      setTimeout(() => handle.close(), 1200);
      waitForWebhook(data.order.id);
    },
    onFailure: (result) => setStatus(`Payment attempt failed: ${result.error?.message ?? result.status}. You can retry in the checkout.`, 'error'),
    onClose: () => {
      btn.disabled = false;
    },
  });
}

/** The browser saying "paid" isn't proof. We wait until OUR server has received the signed webhook. */
async function waitForWebhook(orderId) {
  setStatus('Payment received. Confirming your order via webhook…');
  for (let i = 0; i < 60; i++) {
    const order = await (await fetch(`/api/orders/${orderId}`)).json();
    if (order.status === 'paid') {
      cart.clear();
      renderCart();
      setStatus(
        `<strong>Order confirmed!</strong> <code>${order.id}</code> · ${inr(order.amount)}<br/><span class="small">Marked paid by the signed <code>payment_intent.captured</code> webhook. <a href="/orders.html">View orders</a></span>`,
        'success',
      );
      return;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  setStatus('Still waiting for the webhook. PayForge retries automatically; check the Orders page.', 'warn');
}

init();
