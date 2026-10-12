/**
 * Money is ALWAYS an integer number of the currency's minor unit (paise for INR).
 * Floating point is never used for amounts: 0.1 + 0.2 !== 0.3.
 */

export const SUPPORTED_CURRENCIES = ['INR'] as const;
export type Currency = (typeof SUPPORTED_CURRENCIES)[number];

export const MIN_AMOUNT = 100; // ₹1.00
export const MAX_AMOUNT = 50_000_000; // ₹5,00,000.00

/** Platform pricing: 2% per successful payment, plus 18% GST on that fee. */
export const DEFAULT_FEE_BPS = 200;
export const GST_BPS = 1800;

/**
 * amount * bps / 10_000, rounded half-up, using integer arithmetic only.
 * bps = basis points (1 bps = 0.01%).
 */
export function applyBps(amount: number, bps: number): number {
  if (!Number.isSafeInteger(amount) || !Number.isSafeInteger(bps)) {
    throw new Error(`applyBps expects integers, got amount=${amount} bps=${bps}`);
  }
  return Math.floor((amount * bps + 5_000) / 10_000);
}

export interface FeeBreakdown {
  amount: number;
  fee: number;
  gst: number;
  net: number;
}

/** Splits a captured amount into platform fee, GST on the fee, and the merchant's net. */
export function computeFees(amount: number, feeBps = DEFAULT_FEE_BPS): FeeBreakdown {
  const fee = applyBps(amount, feeBps);
  const gst = applyBps(fee, GST_BPS);
  return { amount, fee, gst, net: amount - fee - gst };
}

export function formatInr(paise: number): string {
  const sign = paise < 0 ? '-' : '';
  const abs = Math.abs(paise);
  const rupees = Math.floor(abs / 100);
  const rest = String(abs % 100).padStart(2, '0');
  return `${sign}₹${rupees.toLocaleString('en-IN')}.${rest}`;
}
