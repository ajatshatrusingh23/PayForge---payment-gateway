import { Injectable, Logger } from '@nestjs/common';
import { callService, config, Errors, ServiceCallError } from '@app/common';
import type { PaymentMethodDetails } from '../domain/types';

export interface MerchantInfo {
  id: string;
  business_name: string;
  fee_bps: number;
  kyc_status: string;
}

export interface PaymentMethodInfo {
  id: string;
  type: 'card' | 'upi';
  fingerprint: string;
  card?: PaymentMethodDetails['card'];
  upi?: { vpa: string };
}

export type RevealedCredentials =
  | { type: 'card'; pan: string; exp_month: number; exp_year: number; name: string | null }
  | { type: 'upi'; vpa: string };

export interface RiskResult {
  id: string | null;
  score: number | null;
  decision: 'allow' | 'challenge' | 'block';
  reasons: Array<{ rule: string; score: number; message: string }>;
}

const RISK_TIMEOUT_MS = parseInt(process.env.RISK_TIMEOUT_MS ?? '500', 10);
const MERCHANT_CACHE_TTL_MS = 60_000;

/** Typed clients for the merchant, vault and risk services. */
@Injectable()
export class PlatformClients {
  private readonly logger = new Logger('PlatformClients');
  private readonly merchantCache = new Map<string, { value: MerchantInfo; expiresAt: number }>();

  async merchant(merchantId: string, requestId?: string): Promise<MerchantInfo> {
    const cached = this.merchantCache.get(merchantId);
    if (cached && cached.expiresAt > Date.now()) return cached.value;
    const value = await callService<MerchantInfo>(config.services.merchant, `/internal/merchants/${merchantId}`, { requestId });
    this.merchantCache.set(merchantId, { value, expiresAt: Date.now() + MERCHANT_CACHE_TTL_MS });
    return value;
  }

  async paymentMethod(merchantId: string, id: string, requestId?: string): Promise<PaymentMethodInfo> {
    try {
      return await callService<PaymentMethodInfo>(config.services.vault, `/internal/payment_methods/${id}`, { merchantId, requestId });
    } catch (err) {
      if (err instanceof ServiceCallError && err.status === 404) {
        throw Errors.invalid(`No such payment_method: '${id}'`, 'payment_method', 'resource_missing');
      }
      throw err;
    }
  }

  async reveal(merchantId: string, id: string, requestId?: string): Promise<RevealedCredentials> {
    return callService<RevealedCredentials>(config.services.vault, `/internal/payment_methods/${id}/reveal`, {
      body: { purpose: 'authorize_payment' },
      merchantId,
      requestId,
      headers: { 'x-caller': 'payment-service' },
    });
  }

  /**
   * Risk is on the critical path, so it gets a strict latency budget. If it is slow or down we
   * FAIL SAFE: fall back to "challenge" (step-up OTP) instead of blindly allowing or blocking.
   */
  async assessRisk(body: Record<string, unknown>, requestId?: string): Promise<RiskResult> {
    try {
      return await callService<RiskResult>(config.services.risk, '/internal/risk/assess', {
        body,
        requestId,
        timeoutMs: RISK_TIMEOUT_MS,
      });
    } catch (err) {
      this.logger.warn(`Risk service unavailable (${(err as Error).message}); failing safe to challenge`);
      return {
        id: null,
        score: null,
        decision: 'challenge',
        reasons: [{ rule: 'risk_unavailable', score: 0, message: 'Risk engine unavailable; stepped up to OTP' }],
      };
    }
  }
}
