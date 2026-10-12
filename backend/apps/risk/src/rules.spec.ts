import { countsAsDecline, evaluate, RiskSignals } from './rules';

const base: RiskSignals = {
  amount: 49_900,
  currency: 'INR',
  paymentMethodType: 'card',
  cardCountry: 'IN',
  email: 'buyer@example.com',
  instrumentAttempts: 1,
  ipAttempts: 1,
  emailAttempts: 1,
  recentDeclines: 0,
  merchantAverageAmount: null,
  blocklistHits: [],
};

describe('risk rules', () => {
  it('allows an ordinary domestic payment with score 0', () => {
    expect(evaluate(base)).toEqual({ score: 0, decision: 'allow', hits: [] });
  });

  it('challenges a foreign, high-value payment from a disposable email (score 50)', () => {
    const r = evaluate({ ...base, cardCountry: 'US', amount: 15_000_000, email: 'x@mailinator.com' });
    expect(r.score).toBe(50);
    expect(r.decision).toBe('challenge');
    expect(r.hits.map((h) => h.rule).sort()).toEqual(['disposable_email', 'high_value', 'international_card']);
  });

  it('blocks a blocklisted card outright', () => {
    expect(evaluate({ ...base, blocklistHits: ['fingerprint'] }).decision).toBe('block');
  });

  it('detects card testing: many attempts + recent declines', () => {
    const r = evaluate({ ...base, instrumentAttempts: 6, recentDeclines: 3, ipAttempts: 15 });
    expect(r.decision).toBe('block');
    expect(r.score).toBe(100);
  });

  it('flags amounts far above the merchant average once there is history', () => {
    expect(evaluate({ ...base, amount: 600_000, merchantAverageAmount: 50_000 }).hits[0].rule).toBe('amount_anomaly');
    expect(evaluate({ ...base, amount: 600_000, merchantAverageAmount: null }).hits).toHaveLength(0);
  });

  it('does not apply card-country rules to UPI', () => {
    expect(evaluate({ ...base, paymentMethodType: 'upi', cardCountry: 'US' }).score).toBe(0);
  });

  it('caps the score at 100', () => {
    const r = evaluate({ ...base, blocklistHits: ['fingerprint', 'ip'], instrumentAttempts: 10 });
    expect(r.score).toBe(100);
  });
});

describe('decline-streak feedback', () => {
  it('counts issuer declines only: an acquirer outage must not make customers look like fraudsters', () => {
    expect(countsAsDecline({ decline_type: 'issuer', decline_code: 'insufficient_funds' })).toBe(true);
    expect(countsAsDecline({ decline_type: 'technical', decline_code: 'acquirers_unavailable' })).toBe(false);
    expect(countsAsDecline({ decline_type: 'risk', decline_code: 'risk_blocked' })).toBe(false);
  });

  it('falls back to the decline code for events without decline_type', () => {
    expect(countsAsDecline({ decline_code: 'do_not_honor' })).toBe(true);
    expect(countsAsDecline({ decline_code: 'processing_error' })).toBe(false);
  });
});
