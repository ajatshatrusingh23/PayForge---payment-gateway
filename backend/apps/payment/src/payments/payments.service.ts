import { Injectable, Logger } from '@nestjs/common';
import {
  AcquirerPaymentResponse,
  ACQUIRERS,
  applyBps,
  computeFees,
  config,
  DEFAULT_FEE_BPS,
  Errors,
  IdPrefix,
  isAcquirerCode,
  newId,
  randomString,
  RequestContext,
  safeEqual,
} from '@app/common';
import { Db } from '@app/database';
import { EventTypes } from '@app/messaging';
import { AcquirerClient, AcquirerTechnicalError, AcquirerTimeoutError } from '../acquirers/acquirer.client';
import { PaymentMethodInfo, PlatformClients, RevealedCredentials, RiskResult } from '../clients/platform.clients';
import { CONFIRMABLE_STATUSES } from '../domain/state-machine';
import type { PaymentIntentRow, PaymentMethodDetails } from '../domain/types';
import { paymentIntentView } from '../domain/views';
import { CancelDto, CaptureDto, ConfirmPaymentIntentDto, CreatePaymentIntentDto, ListPaymentIntentsDto, VerifyOtpDto } from '../dto';
import { acquirerLatency, acquirerRequests, confirmDuration, routingFailovers } from '../metrics';
import { RouterService } from '../routing/router.service';
import { ACQUIRERS_UNAVAILABLE, OutcomeService, PROCESSING_ERROR } from './outcome.service';
import { PaymentRepository } from './payment.repository';

const MAX_CONFIRM_ATTEMPTS = 5;
const INTENT_TTL_MINUTES = parseInt(process.env.PAYMENT_INTENT_TTL_MINUTES ?? '30', 10);
const METADATA_MAX_KEYS = 20;

@Injectable()
export class PaymentsService {
  private readonly logger = new Logger('Payments');

  constructor(
    private readonly db: Db,
    private readonly repo: PaymentRepository,
    private readonly clients: PlatformClients,
    private readonly acquirers: AcquirerClient,
    private readonly router: RouterService,
    private readonly outcomes: OutcomeService,
  ) {}

  // ------------------------------------------------------------------ create / read

  async create(ctx: RequestContext, dto: CreatePaymentIntentDto) {
    this.validateMetadata(dto.metadata);
    const merchant = await this.clients.merchant(ctx.merchantId, ctx.requestId);
    const id = newId(IdPrefix.paymentIntent);
    const pi = await this.db.tx(async (c) => {
      const created = await this.repo.insertIntent(c, {
        id,
        merchant_id: ctx.merchantId,
        amount: dto.amount,
        currency: dto.currency ?? 'INR',
        capture_method: dto.capture_method ?? 'automatic',
        client_secret: `${id}_secret_${randomString(24)}`,
        description: dto.description ?? null,
        statement_descriptor: (dto.statement_descriptor ?? merchant.business_name).slice(0, 22),
        customer_email: dto.customer_email?.toLowerCase() ?? null,
        metadata: dto.metadata ?? {},
        payment_method_types: dto.payment_method_types ?? ['card', 'upi'],
        fee_bps: merchant.fee_bps ?? DEFAULT_FEE_BPS, // pricing is snapshotted at creation time
        expires_at: new Date(Date.now() + INTENT_TTL_MINUTES * 60_000),
      });
      await this.repo.emit(c, created, { type: EventTypes.paymentCreated });
      return created;
    });
    return paymentIntentView(pi, { includeSecret: true, audience: ctx.authType });
  }

  async retrieve(ctx: RequestContext, id: string, clientSecret?: string) {
    const pi = await this.repo.findIntent(ctx.merchantId, id);
    if (!pi) throw Errors.notFound('payment_intent', id);
    this.assertClientSecret(ctx, pi, clientSecret);
    return paymentIntentView(pi, { audience: ctx.authType });
  }

  async list(ctx: RequestContext, q: ListPaymentIntentsDto) {
    const { rows, hasMore } = await this.repo.listIntents(ctx.merchantId, {
      limit: q.limit ?? 20,
      startingAfter: q.starting_after,
      status: q.status,
      q: q.q,
    });
    return { object: 'list', data: rows.map((r) => paymentIntentView(r, { audience: ctx.authType })), has_more: hasMore };
  }

  timeline(ctx: RequestContext, id: string) {
    return this.repo.timeline(ctx.merchantId, id);
  }

  // ------------------------------------------------------------------ confirm

  async confirm(ctx: RequestContext, id: string, dto: ConfirmPaymentIntentDto) {
    const existing = await this.repo.findIntent(ctx.merchantId, id);
    if (!existing) throw Errors.notFound('payment_intent', id);
    this.assertClientSecret(ctx, existing, dto.client_secret);

    // Validate the payment method before touching payment state.
    const pm = await this.clients.paymentMethod(ctx.merchantId, dto.payment_method, ctx.requestId);
    if (!existing.payment_method_types.includes(pm.type)) {
      throw Errors.invalid(`This PaymentIntent does not accept ${pm.type} payments`, 'payment_method');
    }

    // Claim the payment: a short transaction holding the row lock, never held across network calls.
    const claimed = await this.db.tx(async (c) => {
      const pi = await this.repo.lockIntent(c, id, ctx.merchantId);
      if (!CONFIRMABLE_STATUSES.includes(pi.status)) {
        throw Errors.unexpectedState(`This PaymentIntent has a status of ${pi.status} and cannot be confirmed.`, {
          payment_intent_status: pi.status,
        });
      }
      if (pi.expires_at.getTime() < Date.now()) {
        throw Errors.unexpectedState('This PaymentIntent has expired. Please create a new one.');
      }
      if (pi.attempt_count >= MAX_CONFIRM_ATTEMPTS) {
        throw Errors.unexpectedState(`The maximum of ${MAX_CONFIRM_ATTEMPTS} payment attempts has been reached for this PaymentIntent.`);
      }
      return this.repo.transition(c, pi, 'processing', {
        payment_method_id: pm.id,
        payment_method_type: pm.type,
        payment_method_details: toDetails(pm),
        last_payment_error: null,
        next_action: null,
        attempt_count: pi.attempt_count + 1,
      });
    });

    const stop = confirmDuration.startTimer();
    const result = await this.process(ctx, claimed, pm);
    stop({ method: pm.type, outcome: result.status });
    return paymentIntentView(result, { audience: ctx.authType });
  }

  /** Risk → vault → smart routing with failover → acquirer. */
  private async process(ctx: RequestContext, pi: PaymentIntentRow, pm: PaymentMethodInfo): Promise<PaymentIntentRow> {
    let risk: RiskResult;
    let credentials: RevealedCredentials;
    try {
      risk = await this.clients.assessRisk(
        {
          merchant_id: pi.merchant_id,
          payment_intent_id: pi.id,
          amount: pi.amount,
          currency: pi.currency,
          payment_method_type: pm.type,
          fingerprint: pm.fingerprint,
          card_country: pm.card?.country,
          vpa: pm.upi?.vpa,
          email: pi.customer_email ?? undefined,
          ip: ctx.clientIp,
        },
        ctx.requestId,
      );
      pi = await this.db.tx(async (c) =>
        this.repo.patch(c, await this.repo.lockIntent(c, pi.id), { risk_score: risk.score, risk_decision: risk.decision }),
      );
      if (risk.decision === 'block') {
        return this.outcomes.failInProcessing(pi.id, {
          type: 'card_error',
          code: 'payment_blocked',
          decline_code: 'risk_blocked',
          message: 'This payment was blocked by PayForge Risk to protect against fraud.',
          payment_method: pm.id,
        });
      }
      credentials = await this.clients.reveal(pi.merchant_id, pm.id, ctx.requestId);
    } catch (err) {
      this.logger.error(`Pre-authorization step failed for ${pi.id}: ${(err as Error).message}`);
      return this.outcomes.failInProcessing(pi.id, PROCESSING_ERROR);
    }

    const order = await this.router.rank(pm.type);
    for (let i = 0; i < order.length; i++) {
      const acquirer = order[i];
      // Write-ahead: the attempt exists BEFORE the bank is called, so whatever happens next
      // (crash, DB outage) the status-check worker knows which bank to ask.
      const attempt = await this.repo.createAttempt(pi, acquirer, pm.type);
      const started = Date.now();
      let res: AcquirerPaymentResponse;
      try {
        res = await this.acquirers.authorize(acquirer, {
          merchant_ref: attempt.id,
          merchant_id: pi.merchant_id,
          amount: pi.amount,
          currency: pi.currency,
          method: pm.type,
          capture: pi.capture_method === 'automatic',
          force_otp: risk.decision === 'challenge' && pm.type === 'card',
          card:
            credentials.type === 'card'
              ? { pan: credentials.pan, exp_month: credentials.exp_month, exp_year: credentials.exp_year, name: credentials.name }
              : undefined,
          upi: credentials.type === 'upi' ? { vpa: credentials.vpa } : undefined,
          callback_url: `${config.services.payment}/internal/acquirer-callbacks/${acquirer}`,
        });
      } catch (err) {
        const latency = Date.now() - started;
        if (err instanceof AcquirerTimeoutError) {
          // Unknown outcome: do NOT try another acquirer (risk of double charge). Resolve by status check.
          void this.router.record(acquirer, pm.type, false, latency);
          acquirerRequests.inc({ acquirer, method: pm.type, outcome: 'timeout' });
          return this.outcomes.markUnknown(attempt.id, err.message, latency);
        }
        if (err instanceof AcquirerTechnicalError) {
          // Nothing was processed: safe to cascade to the next acquirer.
          if (!err.circuitOpen) void this.router.record(acquirer, pm.type, false, latency);
          acquirerRequests.inc({ acquirer, method: pm.type, outcome: err.circuitOpen ? 'circuit_open' : 'technical_failure' });
          await this.repo.updateAttempt(attempt.id, { status: 'technical_failure', error_message: err.message, latency_ms: latency, next_check_at: null });
          if (i < order.length - 1) {
            routingFailovers.inc({ from: acquirer });
            this.logger.warn(`Failing over ${pi.id}: ${acquirer} -> ${order[i + 1]} (${err.message})`);
          }
          continue;
        }
        // A 4xx from the acquirer means it rejected our request outright: nothing was processed.
        this.logger.error(`Acquirer ${acquirer} rejected the request for ${pi.id}: ${(err as Error).message}`);
        await this.repo.updateAttempt(attempt.id, { status: 'technical_failure', error_message: (err as Error).message, latency_ms: latency, next_check_at: null });
        return this.outcomes.failInProcessing(pi.id, PROCESSING_ERROR);
      }

      // The bank has answered. From here on, a failure is OUR problem (e.g. the DB pool timed out)
      // and must never fail the payment: the bank may have taken the customer's money. The
      // attempt row stays open and the status-check worker re-applies the bank's answer.
      const latency = Date.now() - started;
      void this.router.record(acquirer, pm.type, true, latency);
      acquirerRequests.inc({ acquirer, method: pm.type, outcome: res.status });
      acquirerLatency.observe({ acquirer }, latency / 1_000);
      try {
        await this.repo.updateAttempt(attempt.id, { latency_ms: latency });
        return await this.outcomes.applyAcquirerResponse(attempt.id, res);
      } catch (err) {
        return this.deferToStatusCheck(pi, attempt.id, acquirer, err as Error);
      }
    }
    return this.outcomes.failInProcessing(pi.id, ACQUIRERS_UNAVAILABLE);
  }

  // ------------------------------------------------------------------ OTP (3-D Secure style step-up)

  async verifyOtp(ctx: RequestContext, id: string, dto: VerifyOtpDto) {
    const existing = await this.repo.findIntent(ctx.merchantId, id);
    if (!existing) throw Errors.notFound('payment_intent', id);
    this.assertClientSecret(ctx, existing, dto.client_secret);

    const { pi, attempt } = await this.db.tx(async (c) => {
      const locked = await this.repo.lockIntent(c, id, ctx.merchantId);
      if (locked.status !== 'requires_action') {
        throw Errors.unexpectedState(`This PaymentIntent has a status of ${locked.status}; no OTP is pending.`);
      }
      const pending = await this.repo.latestAttempt(c, locked.id, 'requires_otp');
      if (!pending?.acquirer_ref) throw Errors.unexpectedState('No OTP challenge is pending for this PaymentIntent.');
      return { pi: await this.repo.transition(c, locked, 'processing'), attempt: pending };
    });

    let res;
    try {
      res = await this.acquirers.verifyOtp(attempt.acquirer, attempt.acquirer_ref!, dto.otp);
    } catch (err) {
      await this.outcomes.revertToRequiresAction(pi.id, null, null);
      if (err instanceof AcquirerTimeoutError || err instanceof AcquirerTechnicalError) {
        throw Errors.unavailable('The bank could not verify the OTP right now. Please try again.');
      }
      throw err;
    }

    if (res.status === 'requires_otp') {
      const remaining = res.otp_attempts_remaining ?? 0;
      const updated = await this.outcomes.revertToRequiresAction(pi.id, remaining, {
        type: 'card_error',
        code: 'incorrect_otp',
        message: `Incorrect OTP. ${remaining} attempt${remaining === 1 ? '' : 's'} remaining.`,
      });
      return paymentIntentView(updated, { audience: ctx.authType });
    }
    try {
      return paymentIntentView(await this.outcomes.applyAcquirerResponse(attempt.id, res), { audience: ctx.authType });
    } catch (err) {
      // The bank already processed the OTP: never surface our own failure as a payment failure.
      return paymentIntentView(await this.deferToStatusCheck(pi, attempt.id, attempt.acquirer, err as Error), { audience: ctx.authType });
    }
  }

  /**
   * Recording a bank's answer failed on our side. Leave the attempt open and ask the
   * status-check worker to fetch the answer from the bank again shortly; the customer
   * sees "processing" and the checkout keeps polling until it resolves.
   */
  private async deferToStatusCheck(pi: PaymentIntentRow, attemptId: string, acquirer: string, err: Error): Promise<PaymentIntentRow> {
    this.logger.error(`Could not record ${acquirer}'s answer for ${attemptId} (${err.message}); status-check worker will reconcile it`);
    await this.repo.updateAttempt(attemptId, { next_check_at: new Date(Date.now() + 1_000) }).catch(() => undefined);
    return (await this.repo.findIntent(pi.merchant_id, pi.id).catch(() => null)) ?? pi;
  }

  // ------------------------------------------------------------------ capture / cancel

  async capture(ctx: RequestContext, id: string, dto: CaptureDto) {
    const pi = await this.repo.getIntent(ctx.merchantId, id);
    if (pi.status !== 'authorized') {
      throw Errors.unexpectedState(`This PaymentIntent has a status of ${pi.status}; only authorized payments can be captured.`);
    }
    const amount = dto.amount_to_capture ?? pi.amount_capturable;
    if (amount > pi.amount_capturable) {
      throw Errors.invalid(`amount_to_capture cannot exceed the authorized amount of ${pi.amount_capturable}`, 'amount_to_capture');
    }
    const attempt = await this.repo.latestAttempt(this.db.pool, pi.id, 'approved');
    if (!attempt?.acquirer_ref) throw Errors.unexpectedState('No approved authorization found for this PaymentIntent.');

    let res;
    try {
      // Idempotent at the acquirer (keyed by our attempt id), so a retried capture never double-captures.
      res = await this.acquirers.capture(attempt.acquirer, attempt.acquirer_ref, amount);
    } catch (err) {
      if (err instanceof AcquirerTimeoutError || err instanceof AcquirerTechnicalError) {
        throw Errors.unavailable('The acquirer could not capture this payment right now. Captures are idempotent; please retry.');
      }
      throw err;
    }

    const updated = await this.db.tx(async (c) => {
      const locked = await this.repo.lockIntent(c, id, ctx.merchantId);
      if (locked.status !== 'authorized') return locked; // a concurrent capture already finished
      const fees = computeFees(amount, locked.fee_bps);
      const capturedAt = new Date();
      return this.repo.transition(
        c,
        locked,
        'captured',
        { amount_received: amount, amount_capturable: 0, fee: fees.fee, gst: fees.gst, captured_at: capturedAt },
        {
          type: EventTypes.paymentCaptured,
          internal: {
            attempt_id: attempt.id,
            acquirer: attempt.acquirer,
            acquirer_ref: res.id,
            method: attempt.method,
            amount,
            fee: fees.fee,
            gst: fees.gst,
            net: fees.net,
            acquirer_fee: isAcquirerCode(attempt.acquirer) ? applyBps(amount, ACQUIRERS[attempt.acquirer].costBps) : 0,
            captured_at: capturedAt.toISOString(),
          },
        },
      );
    });
    return paymentIntentView(updated, { audience: ctx.authType });
  }

  async cancel(ctx: RequestContext, id: string, dto: CancelDto) {
    const pi = await this.repo.getIntent(ctx.merchantId, id);
    if (pi.status === 'authorized') {
      const attempt = await this.repo.latestAttempt(this.db.pool, pi.id, 'approved');
      if (!attempt?.acquirer_ref) throw Errors.unexpectedState('No approved authorization found for this PaymentIntent.');
      try {
        await this.acquirers.void(attempt.acquirer, attempt.acquirer_ref);
      } catch (err) {
        if (err instanceof AcquirerTimeoutError || err instanceof AcquirerTechnicalError) {
          throw Errors.unavailable('The acquirer could not void this authorization right now; please retry.');
        }
        throw err;
      }
    }
    const updated = await this.db.tx(async (c) => {
      const locked = await this.repo.lockIntent(c, id, ctx.merchantId);
      const reason = dto.cancellation_reason ?? 'requested_by_customer';
      if (locked.status === 'authorized') {
        return this.repo.transition(
          c,
          locked,
          'voided',
          { amount_capturable: 0, canceled_at: new Date(), cancellation_reason: reason },
          { type: EventTypes.paymentVoided },
        );
      }
      if (!['created', 'failed', 'requires_action'].includes(locked.status)) {
        throw Errors.unexpectedState(`This PaymentIntent has a status of ${locked.status} and cannot be canceled.`);
      }
      return this.repo.transition(
        c,
        locked,
        'canceled',
        { next_action: null, canceled_at: new Date(), cancellation_reason: reason },
        { type: EventTypes.paymentCanceled },
      );
    });
    return paymentIntentView(updated, { audience: ctx.authType });
  }

  // ------------------------------------------------------------------ helpers

  /** Browsers (publishable key) must prove they hold this intent's client secret. */
  private assertClientSecret(ctx: RequestContext, pi: PaymentIntentRow, clientSecret?: string): void {
    if (ctx.authType !== 'publishable') return;
    if (!clientSecret || !safeEqual(clientSecret, pi.client_secret)) {
      // 404 rather than 403: don't reveal that the payment intent exists.
      throw Errors.notFound('payment_intent', pi.id);
    }
  }

  private validateMetadata(metadata?: Record<string, string>): void {
    if (!metadata) return;
    const entries = Object.entries(metadata);
    if (entries.length > METADATA_MAX_KEYS) throw Errors.invalid(`metadata can have at most ${METADATA_MAX_KEYS} keys`, 'metadata');
    for (const [key, value] of entries) {
      if (key.length > 40) throw Errors.invalid('metadata keys must be at most 40 characters', `metadata[${key}]`);
      if (typeof value !== 'string' || value.length > 500) {
        throw Errors.invalid('metadata values must be strings of at most 500 characters', `metadata[${key}]`);
      }
    }
  }
}

function toDetails(pm: PaymentMethodInfo): PaymentMethodDetails {
  return {
    type: pm.type,
    fingerprint: pm.fingerprint,
    ...(pm.card ? { card: pm.card } : {}),
    ...(pm.upi ? { upi: pm.upi } : {}),
  };
}
