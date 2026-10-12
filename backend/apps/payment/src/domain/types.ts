import type { PaymentStatus } from './state-machine';

export interface PaymentMethodDetails {
  type: 'card' | 'upi';
  fingerprint: string;
  card?: { brand: string; last4: string; exp_month: number; exp_year: number; country: string; issuer: string; funding: string };
  upi?: { vpa: string };
}

export interface PaymentError {
  type: 'card_error' | 'api_error' | 'invalid_request_error';
  code: string;
  message: string;
  decline_code?: string | null;
  payment_method?: string | null;
}

export interface PaymentIntentRow {
  id: string;
  merchant_id: string;
  amount: number;
  currency: string;
  status: PaymentStatus;
  capture_method: 'automatic' | 'manual';
  client_secret: string;
  description: string | null;
  statement_descriptor: string | null;
  customer_email: string | null;
  metadata: Record<string, string>;
  payment_method_types: string[];
  payment_method_id: string | null;
  payment_method_type: 'card' | 'upi' | null;
  payment_method_details: PaymentMethodDetails | null;
  amount_capturable: number;
  amount_received: number;
  amount_refunded: number;
  fee_bps: number;
  fee: number;
  gst: number;
  acquirer: string | null;
  acquirer_ref: string | null;
  last_payment_error: PaymentError | null;
  next_action: Record<string, unknown> | null;
  risk_score: number | null;
  risk_decision: string | null;
  attempt_count: number;
  cancellation_reason: string | null;
  version: number;
  created_at: Date;
  updated_at: Date;
  expires_at: Date;
  captured_at: Date | null;
  canceled_at: Date | null;
}

export type AttemptStatus =
  | 'initiated'
  | 'approved'
  | 'declined'
  | 'requires_otp'
  | 'pending'
  | 'unknown'
  | 'technical_failure'
  | 'not_found';

export const OPEN_ATTEMPT_STATUSES: readonly AttemptStatus[] = ['initiated', 'requires_otp', 'pending', 'unknown'];

export interface PaymentAttemptRow {
  id: string;
  payment_intent_id: string;
  merchant_id: string;
  acquirer: string;
  method: 'card' | 'upi';
  status: AttemptStatus;
  acquirer_ref: string | null;
  decline_code: string | null;
  error_message: string | null;
  latency_ms: number | null;
  checks: number;
  next_check_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface RefundRow {
  id: string;
  payment_intent_id: string;
  merchant_id: string;
  amount: number;
  currency: string;
  status: 'pending' | 'succeeded' | 'failed';
  reason: string | null;
  acquirer: string;
  acquirer_ref: string | null;
  failure_reason: string | null;
  created_at: Date;
  updated_at: Date;
}
