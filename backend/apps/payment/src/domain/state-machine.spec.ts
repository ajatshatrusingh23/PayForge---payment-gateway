import { allowedTransitions, assertTransition, canTransition, isTerminal, PAYMENT_STATUSES } from './state-machine';

describe('payment state machine', () => {
  it('allows the happy path', () => {
    expect(canTransition('created', 'processing')).toBe(true);
    expect(canTransition('processing', 'captured')).toBe(true);
    expect(canTransition('captured', 'partially_refunded')).toBe(true);
    expect(canTransition('partially_refunded', 'refunded')).toBe(true);
  });

  it('allows async and step-up flows', () => {
    expect(canTransition('processing', 'requires_action')).toBe(true);
    expect(canTransition('requires_action', 'processing')).toBe(true);
    expect(canTransition('processing', 'pending')).toBe(true);
    expect(canTransition('pending', 'captured')).toBe(true);
    expect(canTransition('authorized', 'voided')).toBe(true);
  });

  it('lets a failed payment be retried with another method', () => {
    expect(canTransition('failed', 'processing')).toBe(true);
  });

  it('rejects money-unsafe transitions', () => {
    expect(canTransition('created', 'captured')).toBe(false); // never capture without processing
    expect(canTransition('refunded', 'captured')).toBe(false);
    expect(canTransition('captured', 'failed')).toBe(false);
    expect(canTransition('pending', 'processing')).toBe(false); // an unknown outcome must never be re-sent
    expect(() => assertTransition('canceled', 'processing')).toThrow(/Invalid payment state transition/);
  });

  it('has terminal states with no way out', () => {
    for (const s of ['refunded', 'canceled', 'voided', 'expired'] as const) expect(isTerminal(s)).toBe(true);
    expect(isTerminal('captured')).toBe(false);
  });

  it('only references known statuses', () => {
    for (const from of PAYMENT_STATUSES) {
      for (const to of allowedTransitions(from)) expect(PAYMENT_STATUSES).toContain(to);
    }
  });
});
