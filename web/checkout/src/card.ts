export type Brand = 'visa' | 'mastercard' | 'rupay' | 'amex' | 'unknown';

export function detectBrand(digits: string): Brand {
  if (/^3[47]/.test(digits)) return 'amex';
  if (/^4/.test(digits)) return 'visa';
  if (/^(5[1-5]|222[1-9]|22[3-9]\d|2[3-6]\d{2}|27[01]\d|2720)/.test(digits)) return 'mastercard';
  if (/^(508|60|65|81|82|353|356)/.test(digits)) return 'rupay';
  return 'unknown';
}

export function luhnValid(digits: string): boolean {
  if (!/^\d{12,19}$/.test(digits)) return false;
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

/** 4242 4242 4242 4242, or 3782 822463 10005 for Amex. */
export function formatCardNumber(raw: string): string {
  const digits = raw.replace(/\D/g, '').slice(0, 19);
  const groups = detectBrand(digits) === 'amex' ? [4, 6, 5] : [4, 4, 4, 4, 3];
  const out: string[] = [];
  let i = 0;
  for (const size of groups) {
    if (i >= digits.length) break;
    out.push(digits.slice(i, i + size));
    i += size;
  }
  return out.join(' ');
}

export function formatExpiry(raw: string): string {
  const digits = raw.replace(/\D/g, '').slice(0, 4);
  if (digits.length === 1 && Number(digits) > 1) return `0${digits} / `;
  return digits.length > 2 ? `${digits.slice(0, 2)} / ${digits.slice(2)}` : digits;
}

export function parseExpiry(value: string): { month: number; year: number } | null {
  const digits = value.replace(/\D/g, '');
  if (digits.length !== 4) return null;
  const month = Number(digits.slice(0, 2));
  const year = 2000 + Number(digits.slice(2));
  if (month < 1 || month > 12) return null;
  const now = new Date();
  if (year < now.getFullYear() || (year === now.getFullYear() && month < now.getMonth() + 1)) return null;
  return { month, year };
}

export const TEST_CARDS = [
  { number: '4111 1111 1111 1111', label: 'Visa: succeeds' },
  { number: '6522 0000 0000 0006', label: 'RuPay: succeeds' },
  { number: '4000 0000 0000 3220', label: 'Requires OTP (123456)' },
  { number: '4000 0000 0000 0002', label: 'Declined by bank' },
  { number: '4000 0000 0000 9995', label: 'Insufficient funds' },
  { number: '4000 0000 0000 0119', label: 'Bank timeout: resolves later' },
  { number: '4000 0007 6000 0002', label: 'International card (risk)' },
];

export const TEST_VPAS = [
  { vpa: 'success@pfbank', label: 'Approves after ~3s' },
  { vpa: 'fail@pfbank', label: 'Customer declines' },
];
