import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { Db, purgeExpiredIdempotencyKeys } from '@app/database';
import { AcquirerClient } from '../acquirers/acquirer.client';
import type { PaymentAttemptRow } from '../domain/types';
import { OutcomeService, PROCESSING_ERROR } from '../payments/outcome.service';
import { PaymentRepository } from '../payments/payment.repository';
import { RefundsService } from '../refunds/refunds.service';

/** If an acquirer still has no record of an attempt after this long, it never arrived. */
const NOT_FOUND_GRACE_MS = 60_000;

/**
 * Background workers that make the system self-healing:
 *  - status checks resolve payments whose outcome is unknown (timeouts, UPI, crashes mid-call);
 *  - expiry closes abandoned payments;
 *  - refund retries finish refunds that hit an acquirer outage.
 */
@Injectable()
export class JobsService {
  private readonly logger = new Logger('Jobs');
  private readonly running = new Set<string>();

  constructor(
    private readonly db: Db,
    private readonly repo: PaymentRepository,
    private readonly acquirers: AcquirerClient,
    private readonly outcomes: OutcomeService,
    private readonly refunds: RefundsService,
  ) {}

  @Interval(2_000)
  resolveOpenAttempts() {
    return this.guard('status-check', async () => {
      for (const attempt of await this.repo.attemptsNeedingStatusCheck()) {
        try {
          const res = await this.acquirers.lookup(attempt.acquirer, attempt.id);
          if (!res) {
            if (Date.now() - attempt.created_at.getTime() > NOT_FOUND_GRACE_MS) {
              this.logger.warn(`Attempt ${attempt.id} unknown to ${attempt.acquirer}; failing it`);
              await this.outcomes.attemptNotFound(attempt.id);
            } else {
              await this.backoff(attempt);
            }
            continue;
          }
          if (res.status === 'pending') {
            await this.backoff(attempt);
            continue;
          }
          this.logger.log(`Status check resolved ${attempt.id} on ${attempt.acquirer}: ${res.status}`);
          await this.outcomes.applyAcquirerResponse(attempt.id, res);
        } catch (err) {
          this.logger.warn(`Status check for ${attempt.id} failed: ${(err as Error).message}`);
          await this.backoff(attempt);
        }
      }
    });
  }

  @Interval(15_000)
  expirePayments() {
    return this.guard('expiry', async () => {
      for (const id of await this.repo.expirable()) await this.outcomes.expire(id);
    });
  }

  /** Self-healing: fail payments that died in `processing` before reaching any bank. */
  @Interval(30_000)
  sweepStuckProcessing() {
    return this.guard('stuck-sweeper', async () => {
      for (const id of await this.repo.stuckProcessing()) {
        this.logger.warn(`Payment ${id} stuck in processing with no open bank attempt; failing it`);
        await this.outcomes.failInProcessing(id, PROCESSING_ERROR);
      }
    });
  }

  @Interval(5_000)
  retryRefunds() {
    return this.guard('refund-retry', () => this.refunds.retryPending());
  }

  @Interval(3_600_000)
  purgeIdempotencyKeys() {
    return this.guard('idempotency-purge', async () => {
      const n = await purgeExpiredIdempotencyKeys(this.db);
      if (n) this.logger.log(`Purged ${n} expired idempotency keys`);
    });
  }

  /** Exponential backoff for status checks: 2s, 4s, 8s ... capped at 60s. */
  private backoff(attempt: PaymentAttemptRow) {
    const delay = Math.min(2 ** (attempt.checks + 1) * 1_000, 60_000);
    return this.repo.updateAttempt(attempt.id, { checks: attempt.checks + 1, next_check_at: new Date(Date.now() + delay) });
  }

  private async guard(name: string, fn: () => Promise<void>): Promise<void> {
    if (this.running.has(name)) return;
    this.running.add(name);
    try {
      await fn();
    } catch (err) {
      this.logger.error(`Job ${name} failed: ${(err as Error).message}`);
    } finally {
      this.running.delete(name);
    }
  }
}
