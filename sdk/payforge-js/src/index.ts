/**
 * PayForge.js
 *
 * Card and UPI details are collected inside an iframe served from PayForge's own
 * origin, so the merchant's page never touches card data. This keeps merchants out
 * of PCI DSS scope, the same model as Stripe Elements and Razorpay Checkout.
 *
 *   const payforge = PayForge('pk_test_...');
 *   payforge.open({ clientSecret, onSuccess: (r) => ..., onFailure: (r) => ... });
 */

export type PaymentStatus =
  | 'created'
  | 'processing'
  | 'requires_action'
  | 'pending'
  | 'authorized'
  | 'captured'
  | 'failed'
  | 'canceled'
  | 'expired'
  | 'partially_refunded'
  | 'refunded';

export interface PaymentResult {
  paymentIntentId: string;
  status: PaymentStatus;
  error?: { code: string; message: string };
}

export interface CheckoutOptions {
  /** The PaymentIntent's client_secret, created by your server with your secret key. */
  clientSecret: string;
  /** Payment captured (or authorized for manual capture). Always confirm via webhook on your server too. */
  onSuccess?: (result: PaymentResult) => void;
  /** An attempt failed. The customer can retry with another method inside the checkout. */
  onFailure?: (result: PaymentResult) => void;
  onReady?: () => void;
  /** Modal only: the customer closed the checkout. */
  onClose?: () => void;
  theme?: 'light' | 'dark';
}

export interface PayForgeOptions {
  /** Where the hosted checkout is served. Defaults to the local dev server. */
  checkoutUrl?: string;
}

export interface CheckoutHandle {
  close(): void;
}

type CheckoutMessage =
  | { type: 'payforge:ready' }
  | { type: 'payforge:resize'; height: number }
  | { type: 'payforge:result'; paymentIntentId: string; status: PaymentStatus; error?: { code: string; message: string } }
  | { type: 'payforge:close' };

const SUCCESS: PaymentStatus[] = ['captured', 'authorized', 'partially_refunded', 'refunded'];
const DEFAULT_CHECKOUT_URL = 'http://localhost:5174';

class PayForgeClient {
  private readonly checkoutOrigin: string;

  constructor(
    private readonly publishableKey: string,
    private readonly opts: PayForgeOptions = {},
  ) {
    if (publishableKey.startsWith('sk_')) {
      throw new Error('PayForge: never use your SECRET key in the browser. Use your publishable key (pk_test_...).');
    }
    if (!publishableKey.startsWith('pk_')) throw new Error('PayForge: invalid publishable key.');
    this.checkoutOrigin = new URL(this.checkoutUrl).origin;
  }

  private get checkoutUrl(): string {
    return (this.opts.checkoutUrl ?? DEFAULT_CHECKOUT_URL).replace(/\/$/, '');
  }

  /** Renders the checkout inline inside `target`. */
  mount(target: string | HTMLElement, options: CheckoutOptions): CheckoutHandle {
    const container = typeof target === 'string' ? document.querySelector<HTMLElement>(target) : target;
    if (!container) throw new Error(`PayForge: mount target ${String(target)} not found`);
    const iframe = this.createIframe(options, 'embedded');
    container.appendChild(iframe);
    const stop = this.listen(iframe, options, () => undefined);
    return {
      close: () => {
        stop();
        iframe.remove();
      },
    };
  }

  /** Opens the checkout in a modal overlay. */
  open(options: CheckoutOptions): CheckoutHandle {
    const overlay = document.createElement('div');
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    Object.assign(overlay.style, {
      position: 'fixed',
      inset: '0',
      background: 'rgba(15, 23, 42, 0.55)',
      backdropFilter: 'blur(2px)',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      zIndex: '2147483646',
      padding: '16px',
    });
    const frameWrap = document.createElement('div');
    Object.assign(frameWrap.style, { width: '100%', maxWidth: '420px', position: 'relative' });
    const iframe = this.createIframe(options, 'modal');
    frameWrap.appendChild(iframe);
    overlay.appendChild(frameWrap);

    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      stop();
      document.removeEventListener('keydown', onKey);
      overlay.remove();
      document.body.style.overflow = previousOverflow;
      options.onClose?.();
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close();
    overlay.addEventListener('click', (e) => e.target === overlay && close());
    document.addEventListener('keydown', onKey);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    document.body.appendChild(overlay);

    const stop = this.listen(iframe, options, close);
    return { close };
  }

  private createIframe(options: CheckoutOptions, mode: 'embedded' | 'modal'): HTMLIFrameElement {
    if (!options.clientSecret?.includes('_secret_')) throw new Error('PayForge: a valid clientSecret is required');
    // Parameters go in the URL fragment, which browsers never send to servers or in Referer headers.
    const params = new URLSearchParams({
      cs: options.clientSecret,
      pk: this.publishableKey,
      origin: window.location.origin,
      mode,
      theme: options.theme ?? 'light',
    });
    const iframe = document.createElement('iframe');
    iframe.src = `${this.checkoutUrl}/#${params.toString()}`;
    iframe.title = 'PayForge secure checkout';
    iframe.allow = 'payment';
    iframe.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms allow-popups');
    Object.assign(iframe.style, {
      width: '100%',
      height: '520px',
      border: '0',
      borderRadius: '14px',
      background: 'transparent',
      colorScheme: 'normal',
      transition: 'height 120ms ease',
    });
    return iframe;
  }

  /** Only trusts messages that come from OUR iframe AND the PayForge checkout origin. */
  private listen(iframe: HTMLIFrameElement, options: CheckoutOptions, close: () => void): () => void {
    const handler = (event: MessageEvent<CheckoutMessage>) => {
      if (event.source !== iframe.contentWindow || event.origin !== this.checkoutOrigin) return;
      const msg = event.data;
      if (!msg || typeof msg !== 'object') return;
      switch (msg.type) {
        case 'payforge:ready':
          options.onReady?.();
          break;
        case 'payforge:resize':
          if (Number.isFinite(msg.height)) iframe.style.height = `${Math.min(Math.max(msg.height, 200), 900)}px`;
          break;
        case 'payforge:result': {
          const result: PaymentResult = { paymentIntentId: msg.paymentIntentId, status: msg.status, error: msg.error };
          if (SUCCESS.includes(msg.status)) options.onSuccess?.(result);
          else options.onFailure?.(result);
          break;
        }
        case 'payforge:close':
          close();
          break;
      }
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }
}

export default function PayForge(publishableKey: string, options?: PayForgeOptions): PayForgeClient {
  return new PayForgeClient(publishableKey, options);
}

export type { PayForgeClient };
