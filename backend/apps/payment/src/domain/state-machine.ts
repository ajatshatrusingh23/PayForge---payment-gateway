import { Errors } from '@app/common';

export const PAYMENT_STATUSES = [
  'created',
  'processing',
  'requires_action',
  'pending',
  'authorized',
  'captured',
  'partially_refunded',
  'refunded',
  'failed',
  'canceled',
  'voided',
  'expired',
] as const;

export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

/**
 * Every legal status change. Anything not listed here is a bug and is rejected,
 * no matter which code path (API call, acquirer callback, poller, expiry job) attempts it.
 *
 *   created ──confirm──▶ processing ──▶ requires_action (OTP) ──▶ processing
 *      │                     │──▶ pending (UPI collect / acquirer timeout) ──▶ authorized | captured | failed
 *      │                     │──▶ authorized ──capture──▶ captured ──▶ partially_refunded ──▶ refunded
 *      │                     │          └──void──▶ voided
 *      │                     └──▶ failed ──(retry with a new payment method)──▶ processing
 *      └──▶ canceled | expired
 */
const TRANSITIONS: Record<PaymentStatus, readonly PaymentStatus[]> = {
  created: ['processing', 'canceled', 'expired'],
  failed: ['processing', 'canceled', 'expired'],
  processing: ['requires_action', 'pending', 'authorized', 'captured', 'failed'],
  requires_action: ['processing', 'failed', 'canceled', 'expired'],
  pending: ['authorized', 'captured', 'failed'],
  authorized: ['captured', 'voided'],
  captured: ['partially_refunded', 'refunded'],
  partially_refunded: ['partially_refunded', 'refunded'],
  refunded: [],
  canceled: [],
  voided: [],
  expired: [],
};

export const CONFIRMABLE_STATUSES: readonly PaymentStatus[] = ['created', 'failed'];
export const SUCCESS_STATUSES: readonly PaymentStatus[] = ['authorized', 'captured', 'partially_refunded', 'refunded'];
export const REFUNDABLE_STATUSES: readonly PaymentStatus[] = ['captured', 'partially_refunded'];

export function canTransition(from: PaymentStatus, to: PaymentStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export function assertTransition(from: PaymentStatus, to: PaymentStatus): void {
  if (!canTransition(from, to)) {
    throw Errors.unexpectedState(`Invalid payment state transition: ${from} -> ${to}`);
  }
}

export function isTerminal(status: PaymentStatus): boolean {
  return TRANSITIONS[status].length === 0;
}

export function allowedTransitions(from: PaymentStatus): readonly PaymentStatus[] {
  return TRANSITIONS[from];
}
