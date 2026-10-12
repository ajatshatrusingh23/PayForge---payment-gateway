export interface PaymentIntent {
  id: string;
  amount: number;
  currency: string;
  status: string;
  description: string | null;
  statement_descriptor: string | null;
  payment_method_types: Array<'card' | 'upi'>;
  last_payment_error: { code: string; message: string; decline_code?: string } | null;
  next_action:
    | { type: 'otp'; otp: { attempts_remaining: number; test_hint?: string } }
    | { type: 'upi_collect'; upi_collect: { vpa: string; qr_payload: string; expires_at: string } }
    | null;
}

export interface PaymentMethod {
  id: string;
  type: 'card' | 'upi';
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly code?: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

/** Browser-side client: authenticates with the publishable key + the intent's client secret only. */
export class Api {
  constructor(
    private readonly baseUrl: string,
    private readonly publishableKey: string,
    private readonly clientSecret: string,
  ) {}

  get paymentIntentId(): string {
    return this.clientSecret.split('_secret_')[0];
  }

  retrieve(): Promise<PaymentIntent> {
    return this.request('GET', `/v1/payment_intents/${this.paymentIntentId}?client_secret=${encodeURIComponent(this.clientSecret)}`);
  }

  createPaymentMethod(body: unknown): Promise<PaymentMethod> {
    return this.request('POST', '/v1/payment_methods', body);
  }

  /** Idempotency key is tied to the payment method, so a retried submit never double-confirms. */
  confirm(paymentMethodId: string): Promise<PaymentIntent> {
    return this.request(
      'POST',
      `/v1/payment_intents/${this.paymentIntentId}/confirm`,
      { payment_method: paymentMethodId, client_secret: this.clientSecret },
      `confirm-${paymentMethodId}`,
    );
  }

  verifyOtp(otp: string): Promise<PaymentIntent> {
    return this.request('POST', `/v1/payment_intents/${this.paymentIntentId}/otp`, { otp, client_secret: this.clientSecret });
  }

  private async request<T>(method: string, path: string, body?: unknown, idempotencyKey?: string): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${this.publishableKey}`,
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
          ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch {
      throw new ApiError('Network error. Check your connection and try again.', 'network_error');
    }
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = (json as { error?: { message?: string; code?: string } }).error;
      throw new ApiError(err?.message ?? `Request failed (${res.status})`, err?.code, res.status);
    }
    return json as T;
  }
}
