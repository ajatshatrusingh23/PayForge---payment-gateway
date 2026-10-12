import { Injectable, Logger } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { AcquirerPaymentResponse, ACQUIRERS, applyBps, computeFees, config, Errors, isAcquirerCode, TEST_OTP } from '@app/common';
import { Db } from '@app/database';
import { EventTypes, PaymentCapturedInternal, PaymentFailedInternal } from '@app/messaging';
import { OPEN_ATTEMPT_STATUSES, PaymentAttemptRow, PaymentError, PaymentIntentRow } from '../domain/types';
import { paymentOutcomes } from '../metrics';
import { PaymentRepository } from './payment.repository';

const MAX_OTP_ATTEMPTS = 3;
const UPI_COLLECT_TTL_MS = 5 * 60_000;

export const ACQUIRERS_UNAVAILABLE: PaymentError = {
  type: 'api_error',
  code: 'acquirers_unavailable',
  message: 'All payment processors are temporarily unavailable. Please try again shortly.',
};

export const PROCESSING_ERROR: PaymentError = {
  type: 'api_error',
  code: 'processing_error',
  message: 'An error occurred while processing your payment. Please try again.',
};

/**
 * Applies acquirer outcomes to payments. Every path that resolves a payment goes
 * through here: synchronous confirm, OTP verification, bank callbacks, the status
 * poller and the expiry job. All methods are idempotent and lock in the same order
 * (payment intent, then attempt), so concurrent resolvers can't deadlock or double-apply.
 */
@Injectable()
export class OutcomeService {
  private readonly logger = new Logger('Outcomes');

  constructor(
    private readonly db: Db,
    private readonly repo: PaymentRepository,
  ) {}

  async applyAcquirerResponse(attemptId: string, res: AcquirerPaymentResponse): Promise<PaymentIntentRow> {
    const snapshot = await this.repo.findAttempt(attemptId);
    if (!snapshot) throw Errors.notFound('payment_attempt', attemptId);

    return this.db.tx(async (c) => {
      const pi = await this.repo.lockIntent(c, snapshot.payment_intent_id);
      const attempt = await this.repo.lockAttempt(c, attemptId);
      if (!OPEN_ATTEMPT_STATUSES.includes(attempt.status)) return pi; // already resolved elsewhere

      switch (res.status) {
        case 'approved':
          return this.onApproved(c, pi, attempt, res);
        case 'declined':
          return this.onDeclined(c, pi, attempt, res);
        case 'requires_otp':
          return this.onRequiresOtp(c, pi, attempt, res);
        case 'pending':
          return this.onPending(c, pi, attempt, res);
        default:
          throw new Error(`Unknown acquirer status ${(res as { status: string }).status}`);
      }
    });
  }

  private async onApproved(c: PoolClient, pi: PaymentIntentRow, attempt: PaymentAttemptRow, res: AcquirerPaymentResponse) {
    await this.repo.updateAttempt(attempt.id, { status: 'approved', acquirer_ref: res.id, decline_code: null, next_check_at: null }, c);
    if (pi.status !== 'processing' && pi.status !== 'pending') {
      // Late approval for a payment we already gave up on: reconciliation will flag it for refund.
      this.logger.error(`Late approval on ${attempt.acquirer} for ${pi.id} (status ${pi.status}); flagged for reconciliation`);
      return pi;
    }
    const common = { acquirer: attempt.acquirer, acquirer_ref: res.id, next_action: null, last_payment_error: null };

    if (!res.captured) {
      paymentOutcomes.inc({ status: 'authorized', method: attempt.method });
      return this.repo.transition(c, pi, 'authorized', { ...common, amount_capturable: pi.amount }, { type: EventTypes.paymentAuthorized });
    }

    const capturedAt = new Date();
    const fees = computeFees(pi.amount, pi.fee_bps);
    const internal: PaymentCapturedInternal = {
      attempt_id: attempt.id,
      acquirer: attempt.acquirer,
      acquirer_ref: res.id,
      method: attempt.method,
      amount: pi.amount,
      fee: fees.fee,
      gst: fees.gst,
      net: fees.net,
      acquirer_fee: isAcquirerCode(attempt.acquirer) ? applyBps(pi.amount, ACQUIRERS[attempt.acquirer].costBps) : 0,
      captured_at: capturedAt.toISOString(),
    };
    paymentOutcomes.inc({ status: 'captured', method: attempt.method });
    return this.repo.transition(
      c,
      pi,
      'captured',
      { ...common, amount_received: pi.amount, amount_capturable: 0, fee: fees.fee, gst: fees.gst, captured_at: capturedAt },
      { type: EventTypes.paymentCaptured, internal: { ...internal } },
    );
  }

  private async onDeclined(c: PoolClient, pi: PaymentIntentRow, attempt: PaymentAttemptRow, res: AcquirerPaymentResponse) {
    await this.repo.updateAttempt(
      attempt.id,
      { status: 'declined', acquirer_ref: res.id, decline_code: res.decline_code, next_check_at: null },
      c,
    );
    if (pi.status !== 'processing' && pi.status !== 'pending') return pi;
    return this.failIntent(c, pi, {
      type: 'card_error',
      code: res.decline_code === 'otp_failed' ? 'authentication_failed' : 'payment_declined',
      decline_code: res.decline_code,
      message: res.decline_message ?? 'Your payment was declined.',
      payment_method: pi.payment_method_id,
    });
  }

  private async onRequiresOtp(c: PoolClient, pi: PaymentIntentRow, attempt: PaymentAttemptRow, res: AcquirerPaymentResponse) {
    await this.repo.updateAttempt(attempt.id, { status: 'requires_otp', acquirer_ref: res.id, next_check_at: null }, c);
    if (pi.status !== 'processing') return pi;
    return this.repo.transition(
      c,
      pi,
      'requires_action',
      { acquirer: attempt.acquirer, acquirer_ref: res.id, next_action: this.otpNextAction(MAX_OTP_ATTEMPTS) },
      { type: EventTypes.paymentRequiresAction },
    );
  }

  private async onPending(c: PoolClient, pi: PaymentIntentRow, attempt: PaymentAttemptRow, res: AcquirerPaymentResponse) {
    await this.repo.updateAttempt(
      attempt.id,
      { status: 'pending', acquirer_ref: res.id, next_check_at: new Date(Date.now() + 2_000) },
      c,
    );
    if (pi.status !== 'processing') return pi;
    return this.repo.transition(
      c,
      pi,
      'pending',
      {
        acquirer: attempt.acquirer,
        acquirer_ref: res.id,
        next_action: pi.payment_method_type === 'upi' ? this.upiNextAction(pi) : null,
      },
      { type: EventTypes.paymentPending },
    );
  }

  /** The acquirer timed out: we do NOT know whether money moved, so park the payment as pending. */
  async markUnknown(attemptId: string, message: string, latencyMs: number): Promise<PaymentIntentRow> {
    const snapshot = await this.repo.findAttempt(attemptId);
    if (!snapshot) throw Errors.notFound('payment_attempt', attemptId);
    return this.db.tx(async (c) => {
      const pi = await this.repo.lockIntent(c, snapshot.payment_intent_id);
      const attempt = await this.repo.lockAttempt(c, attemptId);
      if (attempt.status !== 'initiated') return pi;
      await this.repo.updateAttempt(
        attemptId,
        { status: 'unknown', error_message: message, latency_ms: latencyMs, next_check_at: new Date(Date.now() + 2_000) },
        c,
      );
      if (pi.status !== 'processing') return pi;
      return this.repo.transition(c, pi, 'pending', { acquirer: attempt.acquirer, next_action: null }, { type: EventTypes.paymentPending });
    });
  }

  /** Fail a payment that is still in `processing` (risk block, vault error, no acquirer available...). */
  async failInProcessing(piId: string, error: PaymentError): Promise<PaymentIntentRow> {
    return this.db.tx(async (c) => {
      const pi = await this.repo.lockIntent(c, piId);
      if (pi.status !== 'processing') return pi;
      return this.failIntent(c, pi, error);
    });
  }

  /** The acquirer has no record of the attempt long after we sent it: it never arrived. */
  async attemptNotFound(attemptId: string): Promise<PaymentIntentRow | null> {
    const snapshot = await this.repo.findAttempt(attemptId);
    if (!snapshot) return null;
    return this.db.tx(async (c) => {
      const pi = await this.repo.lockIntent(c, snapshot.payment_intent_id);
      const attempt = await this.repo.lockAttempt(c, attemptId);
      if (!OPEN_ATTEMPT_STATUSES.includes(attempt.status)) return pi;
      await this.repo.updateAttempt(attemptId, { status: 'not_found', next_check_at: null }, c);
      const latest = await this.repo.latestAttempt(c, pi.id);
      if ((pi.status === 'processing' || pi.status === 'pending') && latest?.id === attemptId) {
        return this.failIntent(c, pi, PROCESSING_ERROR);
      }
      return pi;
    });
  }

  /** After a wrong OTP (or a failed OTP call), go back to requires_action so the customer can retry. */
  async revertToRequiresAction(piId: string, attemptsRemaining: number | null, error: PaymentError | null): Promise<PaymentIntentRow> {
    return this.db.tx(async (c) => {
      const pi = await this.repo.lockIntent(c, piId);
      if (pi.status !== 'processing') return pi;
      return this.repo.transition(c, pi, 'requires_action', {
        last_payment_error: error,
        ...(attemptsRemaining !== null ? { next_action: this.otpNextAction(attemptsRemaining) } : {}),
      });
    });
  }

  async expire(piId: string): Promise<void> {
    await this.db.tx(async (c) => {
      const pi = await this.repo.lockIntent(c, piId);
      if (!['created', 'failed', 'requires_action'].includes(pi.status) || pi.expires_at.getTime() > Date.now()) return;
      await this.repo.transition(c, pi, 'expired', { next_action: null, amount_capturable: 0 }, { type: EventTypes.paymentExpired });
    });
  }

  private async failIntent(c: PoolClient, pi: PaymentIntentRow, error: PaymentError): Promise<PaymentIntentRow> {
    const internal: PaymentFailedInternal = {
      fingerprint: pi.payment_method_details?.fingerprint ?? null,
      decline_code: error.decline_code ?? error.code,
      decline_type: error.decline_code === 'risk_blocked' ? 'risk' : error.type === 'card_error' ? 'issuer' : 'technical',
    };
    paymentOutcomes.inc({ status: 'failed', method: pi.payment_method_type ?? 'unknown' });
    return this.repo.transition(
      c,
      pi,
      'failed',
      { last_payment_error: error, next_action: null, amount_capturable: 0 },
      { type: EventTypes.paymentFailed, internal: { ...internal } },
    );
  }

  otpNextAction(attemptsRemaining: number) {
    return {
      type: 'otp',
      otp: {
        attempts_remaining: attemptsRemaining,
        ...(config.demoMode ? { test_hint: `Test mode: the OTP is ${TEST_OTP}` } : {}),
      },
    };
  }

  private upiNextAction(pi: PaymentIntentRow) {
    const payee = encodeURIComponent(pi.statement_descriptor ?? 'PayForge');
    const amount = (pi.amount / 100).toFixed(2);
    return {
      type: 'upi_collect',
      upi_collect: {
        vpa: pi.payment_method_details?.upi?.vpa ?? null,
        qr_payload: `upi://pay?pa=payforge@pfbank&pn=${payee}&am=${amount}&cu=INR&tr=${pi.id}`,
        expires_at: new Date(Date.now() + UPI_COLLECT_TTL_MS).toISOString(),
      },
    };
  }
}
