import { AuthType, computeFees } from '@app/common';
import type { PaymentIntentRow, RefundRow } from './types';

export interface ViewOptions {
  /** Include client_secret (on create, and for the merchant's own secret-key / dashboard reads). */
  includeSecret?: boolean;
  /** Caller authenticated with a publishable key (browser): hide merchant-only fields. */
  audience?: AuthType;
}

/** Public API representation of a PaymentIntent (what merchants and webhooks see). */
export function paymentIntentView(pi: PaymentIntentRow, opts: ViewOptions = {}) {
  const browser = opts.audience === 'publishable';
  const showSecret = opts.includeSecret ?? (opts.audience === 'secret' || opts.audience === 'dashboard');
  const fees = pi.amount_received > 0 ? computeFees(pi.amount_received, pi.fee_bps) : null;
  return {
    id: pi.id,
    object: 'payment_intent',
    amount: pi.amount,
    currency: pi.currency,
    status: pi.status,
    capture_method: pi.capture_method,
    ...(showSecret || browser ? { client_secret: pi.client_secret } : {}),
    description: pi.description,
    statement_descriptor: pi.statement_descriptor,
    payment_method_types: pi.payment_method_types,
    payment_method: pi.payment_method_id,
    payment_method_details: pi.payment_method_details,
    amount_capturable: pi.amount_capturable,
    amount_received: pi.amount_received,
    amount_refunded: pi.amount_refunded,
    last_payment_error: pi.last_payment_error,
    next_action: pi.next_action,
    attempt_count: pi.attempt_count,
    created_at: pi.created_at,
    updated_at: pi.updated_at,
    expires_at: pi.expires_at,
    ...(browser
      ? {}
      : {
          customer_email: pi.customer_email,
          metadata: pi.metadata,
          fees: fees ? { fee: fees.fee, gst: fees.gst, net: fees.net, fee_bps: pi.fee_bps } : null,
          risk: pi.risk_score === null ? null : { score: pi.risk_score, decision: pi.risk_decision },
          acquirer: pi.acquirer,
          captured_at: pi.captured_at,
          canceled_at: pi.canceled_at,
          cancellation_reason: pi.cancellation_reason,
        }),
    livemode: false,
  };
}

export function refundView(r: RefundRow) {
  return {
    id: r.id,
    object: 'refund',
    amount: r.amount,
    currency: r.currency,
    payment_intent: r.payment_intent_id,
    status: r.status,
    reason: r.reason,
    failure_reason: r.failure_reason,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}
