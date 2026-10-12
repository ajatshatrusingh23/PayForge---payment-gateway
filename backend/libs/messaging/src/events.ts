import { IdPrefix, newId } from '@app/common';

export const Topics = {
  payments: 'payforge.payments',
  settlements: 'payforge.settlements',
  deadLetter: 'payforge.dead-letter',
} as const;

export const ALL_TOPICS = Object.values(Topics);

/**
 * Event envelope shared by every producer/consumer.
 *  - `data.object` is the public representation, forwarded to merchants as a webhook.
 *  - `internal` carries platform-only fields (acquirer, costs, fingerprints) and is
 *    stripped by the webhook service before anything leaves the platform.
 */
export interface DomainEvent<TObject = Record<string, unknown>, TInternal = Record<string, unknown>> {
  id: string;
  type: string;
  created_at: string;
  merchant_id: string | null;
  data: { object: TObject };
  internal?: TInternal;
}

export function buildEvent<TObject, TInternal = Record<string, unknown>>(
  type: string,
  merchantId: string | null,
  object: TObject,
  internal?: TInternal,
): DomainEvent<TObject, TInternal> {
  return {
    id: newId(IdPrefix.event),
    type,
    created_at: new Date().toISOString(),
    merchant_id: merchantId,
    data: { object },
    ...(internal ? { internal } : {}),
  };
}

export const EventTypes = {
  paymentCreated: 'payment_intent.created',
  paymentRequiresAction: 'payment_intent.requires_action',
  paymentPending: 'payment_intent.pending',
  paymentAuthorized: 'payment_intent.authorized',
  paymentCaptured: 'payment_intent.captured',
  paymentFailed: 'payment_intent.payment_failed',
  paymentCanceled: 'payment_intent.canceled',
  paymentVoided: 'payment_intent.voided',
  paymentExpired: 'payment_intent.expired',
  refundCreated: 'refund.created',
  refundSucceeded: 'refund.succeeded',
  refundFailed: 'refund.failed',
  payoutPaid: 'payout.paid',
  acquirerSettlementReceived: 'acquirer_settlement.received',
  reconciliationCompleted: 'reconciliation.completed',
} as const;

/** Events that are platform-internal and never delivered to merchants. */
export const INTERNAL_EVENT_TYPES: ReadonlySet<string> = new Set([
  EventTypes.acquirerSettlementReceived,
  EventTypes.reconciliationCompleted,
]);

// ---- internal payload contracts --------------------------------------------------

export interface PaymentCapturedInternal {
  attempt_id: string;
  acquirer: string;
  acquirer_ref: string;
  method: string;
  amount: number;
  fee: number;
  gst: number;
  net: number;
  acquirer_fee: number;
  captured_at: string;
}

export interface PaymentFailedInternal {
  fingerprint?: string | null;
  decline_code?: string | null;
  /**
   * Why it failed. Only `issuer` declines say anything about the customer's card;
   * `technical` (acquirer outage, processing error) and `risk` (we blocked it) must not
   * feed fraud signals, or an acquirer outage would flag every customer as a fraudster.
   */
  decline_type?: 'issuer' | 'technical' | 'risk';
}

export interface RefundSucceededInternal {
  refund_id: string;
  payment_intent_id: string;
  acquirer: string;
  acquirer_ref: string;
  amount: number;
  succeeded_at: string;
}

export interface AcquirerSettlementInternal {
  run_id: string;
  acquirer: string;
  business_date: string;
  gross_amount: number;
  refund_amount: number;
  acquirer_fees: number;
  net_amount: number;
}

export interface PayoutPaidInternal {
  payout_id: string;
  amount: number;
}
