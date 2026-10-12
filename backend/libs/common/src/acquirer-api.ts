/**
 * Wire contract between PayForge and an acquiring bank. The bank simulator
 * implements it; the payment service's AcquirerClient consumes it. A real
 * integration (e.g. an ISO 8583 or bank REST adapter) would sit behind the same interface.
 */
export type AcquirerTxnStatus = 'approved' | 'declined' | 'requires_otp' | 'pending';

export interface AcquirerPaymentRequest {
  /** PayForge attempt id: the acquirer's idempotency key for this authorization. */
  merchant_ref: string;
  merchant_id: string;
  amount: number;
  currency: string;
  method: 'card' | 'upi';
  /** true = sale (auth + capture in one message), false = auth only. */
  capture: boolean;
  /** Risk engine requested step-up authentication (3-D Secure style OTP challenge). */
  force_otp?: boolean;
  card?: { pan: string; exp_month: number; exp_year: number; name?: string | null };
  upi?: { vpa: string };
  callback_url?: string;
}

export interface AcquirerPaymentResponse {
  id: string;
  merchant_ref: string;
  type: 'sale' | 'auth' | 'capture' | 'void';
  status: AcquirerTxnStatus;
  captured: boolean;
  amount: number;
  decline_code: string | null;
  decline_message: string | null;
  otp_attempts_remaining?: number;
  created_at: string;
}

export interface AcquirerRefundResponse {
  id: string;
  merchant_ref: string;
  status: 'approved' | 'declined';
  amount: number;
  decline_code: string | null;
}

export interface SettlementReportLine {
  acquirer_ref: string;
  merchant_ref: string;
  type: 'sale' | 'capture' | 'refund';
  amount: number;
  fee: number;
  approved_at: string;
}

export interface SettlementReport {
  acquirer: string;
  business_date: string;
  lines: SettlementReportLine[];
}

export const BANK_SIGNATURE_HEADER = 'x-bank-signature';

export function bankCallbackSecret(): string {
  return process.env.BANK_CALLBACK_SECRET ?? 'pf_dev_bank_callback_secret';
}
