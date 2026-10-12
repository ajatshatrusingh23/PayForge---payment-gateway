/**
 * Rule-based risk scoring.
 *
 * Signals are gathered first (Redis counters, blocklist lookups), then the rules
 * are pure functions of those signals. That keeps every rule unit-testable and
 * every decision explainable: the assessment stores exactly which rules fired and why.
 */
export interface RiskSignals {
  amount: number;
  currency: string;
  paymentMethodType: 'card' | 'upi';
  cardCountry?: string | null;
  email?: string | null;
  /** Attempts with this card / VPA in the velocity window, including this one. */
  instrumentAttempts: number;
  ipAttempts: number;
  emailAttempts: number;
  /** Recent declines on this instrument (fed by payment_failed events). */
  recentDeclines: number;
  /** Rolling average ticket size for the merchant (null until there is enough history). */
  merchantAverageAmount: number | null;
  blocklistHits: string[];
}

export interface RuleHit {
  rule: string;
  score: number;
  message: string;
}

export type RiskDecision = 'allow' | 'challenge' | 'block';

export const THRESHOLDS = { challenge: 50, block: 80 } as const;
export const VELOCITY_WINDOW_SECONDS = 600;

const HIGH_VALUE_AMOUNT = 10_000_000; // ₹1,00,000
const DISPOSABLE_EMAIL_DOMAINS = new Set([
  'mailinator.com',
  'guerrillamail.com',
  '10minutemail.com',
  'tempmail.com',
  'temp-mail.org',
  'yopmail.com',
  'trashmail.com',
  'sharklasers.com',
]);

export interface Rule {
  id: string;
  description: string;
  evaluate(s: RiskSignals): RuleHit | null;
}

const hit = (rule: string, score: number, message: string): RuleHit => ({ rule, score, message });
const formatInr = (paise: number) => `₹${(paise / 100).toLocaleString('en-IN')}`;

export const RULES: Rule[] = [
  {
    id: 'blocklist',
    description: 'Card, UPI ID, email or IP is on the merchant blocklist',
    evaluate: (s) => (s.blocklistHits.length ? hit('blocklist', 100, `Blocklisted ${s.blocklistHits.join(', ')}`) : null),
  },
  {
    id: 'instrument_velocity',
    description: 'Same card / UPI ID used more than 3 times in 10 minutes',
    evaluate: (s) =>
      s.instrumentAttempts > 3
        ? hit('instrument_velocity', 40, `Payment method used ${s.instrumentAttempts} times in 10 minutes`)
        : null,
  },
  {
    id: 'ip_velocity',
    description: 'More than 10 attempts from one IP address in 10 minutes',
    evaluate: (s) => (s.ipAttempts > 10 ? hit('ip_velocity', 30, `${s.ipAttempts} attempts from this IP in 10 minutes`) : null),
  },
  {
    id: 'email_velocity',
    description: 'More than 5 attempts for one email in 10 minutes',
    evaluate: (s) => (s.emailAttempts > 5 ? hit('email_velocity', 20, `${s.emailAttempts} attempts for this email in 10 minutes`) : null),
  },
  {
    id: 'decline_streak',
    description: 'Payment method was declined 2+ times in the last hour (card testing)',
    evaluate: (s) =>
      s.recentDeclines >= 2 ? hit('decline_streak', 30, `${s.recentDeclines} recent declines on this payment method`) : null,
  },
  {
    id: 'high_value',
    description: 'Amount of ₹1,00,000 or more',
    evaluate: (s) => (s.amount >= HIGH_VALUE_AMOUNT ? hit('high_value', 15, `High-value payment of ${formatInr(s.amount)}`) : null),
  },
  {
    id: 'amount_anomaly',
    description: "Amount is more than 5x the merchant's average ticket size",
    evaluate: (s) => {
      if (!s.merchantAverageAmount || s.amount <= s.merchantAverageAmount * 5) return null;
      const ratio = (s.amount / s.merchantAverageAmount).toFixed(1);
      return hit('amount_anomaly', 25, `Amount is ${ratio}x the merchant's average of ${formatInr(Math.round(s.merchantAverageAmount))}`);
    },
  },
  {
    id: 'international_card',
    description: 'Card issued outside India',
    evaluate: (s) =>
      s.paymentMethodType === 'card' && s.cardCountry && s.cardCountry !== 'IN'
        ? hit('international_card', 20, `Card issued in ${s.cardCountry}`)
        : null,
  },
  {
    id: 'disposable_email',
    description: 'Customer email uses a disposable email domain',
    evaluate: (s) => {
      const domain = s.email?.split('@')[1]?.toLowerCase();
      return domain && DISPOSABLE_EMAIL_DOMAINS.has(domain) ? hit('disposable_email', 15, `Disposable email domain (${domain})`) : null;
    },
  },
];

export function evaluate(signals: RiskSignals): { score: number; decision: RiskDecision; hits: RuleHit[] } {
  const hits = RULES.map((r) => r.evaluate(signals)).filter((h): h is RuleHit => h !== null);
  const score = Math.min(100, hits.reduce((sum, h) => sum + h.score, 0));
  const decision: RiskDecision = score >= THRESHOLDS.block ? 'block' : score >= THRESHOLDS.challenge ? 'challenge' : 'allow';
  return { score, decision, hits };
}

const NON_ISSUER_CODES = new Set(['risk_blocked', 'acquirers_unavailable', 'processing_error']);

/** Only genuine issuer declines count towards the decline-streak (card testing) signal. */
export function countsAsDecline(internal: { decline_type?: string; decline_code?: string | null }): boolean {
  if (internal.decline_type) return internal.decline_type === 'issuer';
  return !!internal.decline_code && !NON_ISSUER_CODES.has(internal.decline_code);
}
