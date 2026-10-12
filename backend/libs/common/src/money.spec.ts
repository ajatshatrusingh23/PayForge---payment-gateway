import fc from 'fast-check';
import { applyBps, computeFees, formatInr, MAX_AMOUNT, MIN_AMOUNT } from './money';

describe('money', () => {
  it('computes the ₹499 example from the case study exactly', () => {
    expect(computeFees(49_900)).toEqual({ amount: 49_900, fee: 998, gst: 180, net: 48_722 });
  });

  it('rounds half-up using integer arithmetic only', () => {
    expect(applyBps(25, 200)).toBe(1); // 0.5 paise -> 1
    expect(applyBps(24, 200)).toBe(0); // 0.48 paise -> 0
    expect(applyBps(10_000, 250)).toBe(250);
  });

  it('rejects non-integer inputs instead of silently using floats', () => {
    expect(() => applyBps(10.5, 200)).toThrow();
  });

  it('property: fee + gst + net always equals the amount, and nothing is negative', () => {
    fc.assert(
      fc.property(fc.integer({ min: MIN_AMOUNT, max: MAX_AMOUNT }), fc.integer({ min: 0, max: 1000 }), (amount, bps) => {
        const f = computeFees(amount, bps);
        return f.fee + f.gst + f.net === amount && f.fee >= 0 && f.gst >= 0 && f.net >= 0;
      }),
    );
  });

  it('formats paise as Indian rupees', () => {
    expect(formatInr(12_345_678)).toBe('₹1,23,456.78');
    expect(formatInr(-500)).toBe('-₹5.00');
  });
});
