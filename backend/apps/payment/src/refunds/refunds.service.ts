import { Injectable, Logger } from '@nestjs/common';
import { AcquirerRefundResponse, Errors, formatInr, RequestContext } from '@app/common';
import { Db } from '@app/database';
import { EventTypes, RefundSucceededInternal } from '@app/messaging';
import { AcquirerClient, AcquirerTechnicalError, AcquirerTimeoutError } from '../acquirers/acquirer.client';
import { REFUNDABLE_STATUSES } from '../domain/state-machine';
import type { RefundRow } from '../domain/types';
import { refundView } from '../domain/views';
import { CreateRefundDto, ListRefundsDto } from '../dto';
import { PaymentRepository } from '../payments/payment.repository';

@Injectable()
export class RefundsService {
  private readonly logger = new Logger('Refunds');

  constructor(
    private readonly db: Db,
    private readonly repo: PaymentRepository,
    private readonly acquirers: AcquirerClient,
  ) {}

  /**
   * 1. Reserve the refund in a transaction (row lock on the payment, so two concurrent
   *    refunds can never exceed the captured amount; pending refunds count against it).
   * 2. Call the acquirer outside the transaction (idempotent on the refund id).
   * 3. Finalise. If the acquirer is down, the refund stays pending and a job retries it.
   */
  async create(ctx: RequestContext, dto: CreateRefundDto) {
    const { refund, acquirerRef } = await this.db.tx(async (c) => {
      const pi = await this.repo.lockIntent(c, dto.payment_intent, ctx.merchantId);
      if (!REFUNDABLE_STATUSES.includes(pi.status)) {
        throw Errors.unexpectedState(`PaymentIntent ${pi.id} has a status of ${pi.status}; only captured payments can be refunded.`);
      }
      const pending = await this.repo.pendingRefundTotal(c, pi.id);
      const refundable = pi.amount_received - pi.amount_refunded - pending;
      if (refundable <= 0) throw Errors.unexpectedState('This payment has already been fully refunded (or has refunds in flight).');
      const amount = dto.amount ?? refundable;
      if (amount > refundable) {
        throw Errors.invalid(
          `Refund amount ${formatInr(amount)} is greater than the refundable amount ${formatInr(refundable)}.`,
          'amount',
          'amount_too_large',
        );
      }
      const created = await this.repo.insertRefund(c, {
        payment_intent_id: pi.id,
        merchant_id: pi.merchant_id,
        amount,
        currency: pi.currency,
        reason: dto.reason ?? null,
        acquirer: pi.acquirer!,
      });
      await this.repo.emitRefund(c, created, EventTypes.refundCreated);
      return { refund: created, acquirerRef: pi.acquirer_ref! };
    });
    return refundView(await this.execute(refund, acquirerRef));
  }

  async execute(refund: RefundRow, paymentAcquirerRef: string): Promise<RefundRow> {
    let res: AcquirerRefundResponse;
    try {
      res = await this.acquirers.refund(refund.acquirer, { merchant_ref: refund.id, payment_id: paymentAcquirerRef, amount: refund.amount });
    } catch (err) {
      if (err instanceof AcquirerTechnicalError || err instanceof AcquirerTimeoutError) {
        this.logger.warn(`Refund ${refund.id} deferred: ${err.message}. Will retry.`);
        await this.db.query('UPDATE refunds SET updated_at = now() WHERE id = $1', [refund.id]);
        return refund;
      }
      throw err;
    }
    return this.finalize(refund, res);
  }

  private async finalize(refund: RefundRow, res: AcquirerRefundResponse): Promise<RefundRow> {
    return this.db.tx(async (c) => {
      const pi = await this.repo.lockIntent(c, refund.payment_intent_id);
      const current = await this.repo.lockRefund(c, refund.id);
      if (!current || current.status !== 'pending') return current ?? refund;

      if (res.status === 'approved') {
        const succeeded = await this.repo.updateRefund(c, refund.id, { status: 'succeeded', acquirer_ref: res.id });
        const refunded = pi.amount_refunded + refund.amount;
        await this.repo.transition(c, pi, refunded >= pi.amount_received ? 'refunded' : 'partially_refunded', { amount_refunded: refunded });
        const internal: RefundSucceededInternal = {
          refund_id: refund.id,
          payment_intent_id: pi.id,
          acquirer: refund.acquirer,
          acquirer_ref: res.id,
          amount: refund.amount,
          succeeded_at: new Date().toISOString(),
        };
        await this.repo.emitRefund(c, succeeded, EventTypes.refundSucceeded, { ...internal });
        return succeeded;
      }

      const failed = await this.repo.updateRefund(c, refund.id, {
        status: 'failed',
        acquirer_ref: res.id,
        failure_reason: res.decline_code ?? 'declined_by_acquirer',
      });
      await this.repo.emitRefund(c, failed, EventTypes.refundFailed);
      return failed;
    });
  }

  async retryPending(): Promise<void> {
    for (const refund of await this.repo.stalePendingRefunds()) {
      const pi = await this.db.one<{ acquirer_ref: string }>('SELECT acquirer_ref FROM payment_intents WHERE id = $1', [refund.payment_intent_id]);
      if (pi?.acquirer_ref) await this.execute(refund, pi.acquirer_ref);
    }
  }

  async list(ctx: RequestContext, q: ListRefundsDto) {
    const rows = await this.repo.listRefunds(ctx.merchantId, q.payment_intent, q.limit ?? 20);
    return { object: 'list', data: rows.map(refundView), has_more: false };
  }

  async retrieve(ctx: RequestContext, id: string) {
    const refund = await this.repo.findRefund(ctx.merchantId, id);
    if (!refund) throw Errors.notFound('refund', id);
    return refundView(refund);
  }
}
