import { TEST_CARDS } from '@app/common';
import { cvcValid, detectBrand, isExpired, lookupBin, luhnValid, validLengthForBrand, VPA_PATTERN } from './card';

describe('card validation', () => {
  it('accepts every documented test card (all are Luhn-valid)', () => {
    for (const card of TEST_CARDS) {
      expect(luhnValid(card.number)).toBe(true);
      expect(detectBrand(card.number)).toBe(card.brand);
    }
  });

  it('catches single-digit typos with Luhn', () => {
    expect(luhnValid('4111111111111112')).toBe(false);
    expect(luhnValid('4111-1111')).toBe(false);
  });

  it('detects brands, including RuPay and 2-series Mastercard', () => {
    expect(detectBrand('378282246310005')).toBe('amex');
    expect(detectBrand('2223003122003222')).toBe('mastercard');
    expect(detectBrand('6522000000000006')).toBe('rupay');
    expect(detectBrand('9999999999999999')).toBe('unknown');
  });

  it('validates length and CVC per brand', () => {
    expect(validLengthForBrand('378282246310005', 'amex')).toBe(true);
    expect(validLengthForBrand('41111111111111111', 'visa')).toBe(false);
    expect(cvcValid('1234', 'amex')).toBe(true);
    expect(cvcValid('1234', 'visa')).toBe(false);
  });

  it('treats a card as valid through the end of its expiry month', () => {
    const now = new Date(Date.UTC(2026, 9, 11)); // October 2026
    expect(isExpired(10, 2026, now)).toBe(false);
    expect(isExpired(9, 2026, now)).toBe(true);
    expect(isExpired(1, 27, now)).toBe(false); // 2-digit year
  });

  it('uses longest-prefix BIN lookup (8-digit before 6-digit)', () => {
    expect(lookupBin('4000000760000002').country).toBe('US');
    expect(lookupBin('4000000000000002').country).toBe('IN');
  });

  it('validates UPI VPAs', () => {
    expect(VPA_PATTERN.test('rahul.sharma@okaxis')).toBe(true);
    expect(VPA_PATTERN.test('no-at-sign')).toBe(false);
    expect(VPA_PATTERN.test('x@1bank')).toBe(false);
  });
});
