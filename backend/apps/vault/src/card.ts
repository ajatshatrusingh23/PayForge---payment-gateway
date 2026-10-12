export type CardBrand = 'visa' | 'mastercard' | 'rupay' | 'amex' | 'unknown';
export type CardFunding = 'credit' | 'debit' | 'prepaid';

export interface BinInfo {
  issuer: string;
  country: string;
  funding: CardFunding;
}

/** Luhn (mod 10) checksum: catches single-digit typos and most transpositions. */
export function luhnValid(pan: string): boolean {
  if (!/^\d+$/.test(pan)) return false;
  let sum = 0;
  let double = false;
  for (let i = pan.length - 1; i >= 0; i--) {
    let digit = pan.charCodeAt(i) - 48;
    if (double) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    double = !double;
  }
  return sum % 10 === 0;
}

export function detectBrand(pan: string): CardBrand {
  if (/^3[47]/.test(pan)) return 'amex';
  if (/^4/.test(pan)) return 'visa';
  if (/^(5[1-5]|222[1-9]|22[3-9]\d|2[3-6]\d{2}|27[01]\d|2720)/.test(pan)) return 'mastercard';
  if (/^(508|60|65|81|82|353|356)/.test(pan)) return 'rupay';
  return 'unknown';
}

export function validLengthForBrand(pan: string, brand: CardBrand): boolean {
  switch (brand) {
    case 'amex':
      return pan.length === 15;
    case 'visa':
      return [13, 16, 19].includes(pan.length);
    case 'mastercard':
    case 'rupay':
      return pan.length === 16;
    default:
      return pan.length >= 12 && pan.length <= 19;
  }
}

export function cvcValid(cvc: string, brand: CardBrand): boolean {
  return brand === 'amex' ? /^\d{4}$/.test(cvc) : /^\d{3}$/.test(cvc);
}

export function normalizeExpYear(year: number): number {
  return year < 100 ? 2000 + year : year;
}

/** A card is valid through the last day of its expiry month. */
export function isExpired(month: number, year: number, now = new Date()): boolean {
  const y = normalizeExpYear(year);
  const currentYear = now.getUTCFullYear();
  const currentMonth = now.getUTCMonth() + 1;
  return y < currentYear || (y === currentYear && month < currentMonth);
}

/**
 * Tiny BIN (Bank Identification Number) table for test mode. Real gateways
 * license BIN databases; longest-prefix match (8-digit, then 6-digit) is used,
 * because networks moved to 8-digit BINs in 2022.
 */
const BIN_TABLE: Record<string, BinInfo> = {
  '40000007': { issuer: 'Liberty National Bank', country: 'US', funding: 'credit' },
  '400000': { issuer: 'Ganga Test Bank', country: 'IN', funding: 'credit' },
  '411111': { issuer: 'Sahyadri Co-operative Bank', country: 'IN', funding: 'debit' },
  '555555': { issuer: 'Deccan Finance Bank', country: 'IN', funding: 'credit' },
  '652200': { issuer: 'Bharat Rural Bank', country: 'IN', funding: 'debit' },
};

export function lookupBin(pan: string): BinInfo {
  return BIN_TABLE[pan.slice(0, 8)] ?? BIN_TABLE[pan.slice(0, 6)] ?? { issuer: 'Unknown issuer', country: 'IN', funding: 'credit' };
}

/** UPI Virtual Payment Address, e.g. rahul.sharma@okaxis */
export const VPA_PATTERN = /^[a-zA-Z0-9._-]{2,256}@[a-zA-Z][a-zA-Z0-9]{1,63}$/;
