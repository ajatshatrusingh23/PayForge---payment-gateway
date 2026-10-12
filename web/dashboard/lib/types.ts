export interface List<T> {
  object: 'list';
  data: T[];
  has_more?: boolean;
}

export interface Merchant {
  id: string;
  name: string;
  email: string;
  business_name: string;
  kyc_status: 'pending' | 'approved' | 'rejected';
  pan: string | null;
  settlement_account: { account_holder_name: string; account_number_last4: string; ifsc: string } | null;
  pricing: { fee_bps: number };
  created_at: string;
}

export interface PaymentIntent {
  id: string;
  amount: number;
  currency: string;
  status: string;
  capture_method: 'automatic' | 'manual';
  description: string | null;
  statement_descriptor: string | null;
  customer_email: string | null;
  metadata: Record<string, string>;
  payment_method: string | null;
  payment_method_details: {
    type: 'card' | 'upi';
    fingerprint: string;
    card?: { brand: string; last4: string; exp_month: number; exp_year: number; country: string; issuer: string; funding: string };
    upi?: { vpa: string };
  } | null;
  amount_capturable: number;
  amount_received: number;
  amount_refunded: number;
  fees: { fee: number; gst: number; net: number; fee_bps: number } | null;
  risk: { score: number; decision: string } | null;
  acquirer: string | null;
  last_payment_error: { type: string; code: string; message: string; decline_code?: string } | null;
  next_action: { type: string } | null;
  attempt_count: number;
  created_at: string;
  updated_at: string;
  captured_at: string | null;
}

export interface Timeline {
  events: Array<{ id: string; type: string; created_at: string }>;
  attempts: Array<{
    id: string;
    acquirer: string;
    method: string;
    status: string;
    acquirer_ref: string | null;
    decline_code: string | null;
    error_message: string | null;
    latency_ms: number | null;
    created_at: string;
  }>;
  refunds: Refund[];
}

export interface Refund {
  id: string;
  amount: number;
  status: string;
  reason: string | null;
  failure_reason: string | null;
  payment_intent: string;
  created_at: string;
}

export interface AnalyticsSummary {
  days: number;
  totals: {
    attempted: number;
    succeeded: number;
    failed: number;
    success_rate: number | null;
    gross_volume: number;
    refunded_volume: number;
    fees: number;
    net_volume: number;
    average_ticket: number;
  };
  daily: Array<{ day: string; succeeded: number; failed: number; volume: number }>;
  by_method: Array<{ method: string; attempted: number; succeeded: number; volume: number; success_rate: number | null }>;
  by_acquirer: Array<{ acquirer: string; attempts: number; approved: number; declined: number; technical_failures: number; timeouts: number; avg_latency_ms: number }>;
  top_decline_codes: Array<{ code: string; count: number }>;
}

export interface RiskAssessment {
  id: string;
  payment_intent_id: string;
  score: number;
  decision: 'allow' | 'challenge' | 'block';
  reasons: Array<{ rule: string; score: number; message: string }>;
  latency_ms: number;
  created_at: string;
}

export interface Journal {
  id: string;
  event_type: string;
  reference_id: string;
  description: string;
  created_at: string;
  lines: Array<{ account: string; direction: 'debit' | 'credit'; amount: number }>;
}

export interface WebhookEndpoint {
  id: string;
  url: string;
  enabled_events: string[];
  description: string | null;
  secret: string;
  created_at: string;
}

export interface WebhookDelivery {
  id: string;
  url: string;
  event_id: string;
  event_type: string;
  object_id: string | null;
  status: 'pending' | 'retrying' | 'succeeded' | 'dead';
  attempts: number;
  next_attempt_at: string;
  last_response_code: number | null;
  last_error: string | null;
  last_latency_ms: number | null;
  created_at: string;
}

export interface AcquirerHealth {
  code: string;
  name: string;
  cost_bps: number;
  circuit: 'closed' | 'open' | 'half_open';
  methods: Record<string, { samples: number; success_rate: number; avg_latency_ms: number; score: number }>;
}

export interface SimulatorAcquirer {
  code: string;
  name: string;
  latency_ms: number;
  technical_failure_rate: number;
  down: boolean;
  inject_discrepancy: boolean;
  stats: { requests: number; approved: number; declined: number; technical_failures: number; rejected_while_down: number };
}
