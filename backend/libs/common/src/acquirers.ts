/**
 * Catalogue of acquiring banks the platform is connected to. All three are
 * simulated by the bank-simulator service; each has a different profile so
 * smart routing has real trade-offs to make (speed vs reliability vs cost).
 */
export type PaymentMethodType = 'card' | 'upi';

export interface AcquirerProfile {
  code: AcquirerCode;
  name: string;
  methods: PaymentMethodType[];
  /** What the acquirer charges PayForge per successful transaction (platform cost). */
  costBps: number;
}

export type AcquirerCode = 'alpha' | 'beta' | 'gamma';

export const ACQUIRERS: Record<AcquirerCode, AcquirerProfile> = {
  alpha: { code: 'alpha', name: 'AlphaBank', methods: ['card', 'upi'], costBps: 180 },
  beta: { code: 'beta', name: 'BetaBank', methods: ['card', 'upi'], costBps: 160 },
  gamma: { code: 'gamma', name: 'GammaPay', methods: ['upi'], costBps: 120 },
};

export const ACQUIRER_CODES = Object.keys(ACQUIRERS) as AcquirerCode[];

export function isAcquirerCode(value: string): value is AcquirerCode {
  return value in ACQUIRERS;
}
