import { Injectable, Logger } from '@nestjs/common';
import CircuitBreaker from 'opossum';
import {
  ACQUIRER_CODES,
  AcquirerPaymentRequest,
  AcquirerPaymentResponse,
  AcquirerRefundResponse,
  callService,
  config,
  ServiceCallError,
  ServiceTimeoutError,
  ServiceUnreachableError,
} from '@app/common';
import { circuitState } from '../metrics';

/** The acquirer could not process the request at all. Safe to retry on another acquirer. */
export class AcquirerTechnicalError extends Error {
  constructor(
    readonly acquirer: string,
    message: string,
    readonly circuitOpen = false,
  ) {
    super(message);
  }
}

/**
 * The acquirer did not answer in time. The outcome is UNKNOWN: the money may have moved.
 * Never cascade to another acquirer on a timeout (that is how customers get charged twice);
 * resolve it later with a status check against the same acquirer.
 */
export class AcquirerTimeoutError extends Error {
  constructor(
    readonly acquirer: string,
    message: string,
  ) {
    super(message);
  }
}

export type CircuitStatus = 'closed' | 'open' | 'half_open';

const AUTH_TIMEOUT_MS = parseInt(process.env.ACQUIRER_TIMEOUT_MS ?? '3000', 10);
const OPS_TIMEOUT_MS = 5_000;

/**
 * One circuit breaker per acquirer (opossum). If at least 50% of requests in a rolling
 * 10s window fail (minimum 5 requests), the circuit opens and we stop sending traffic there
 * for CIRCUIT_RESET_MS; then a single trial request decides whether to close it again.
 * Business outcomes (declines, 4xx) do NOT count as failures: only acquirer health does.
 */
@Injectable()
export class AcquirerClient {
  private readonly logger = new Logger('AcquirerClient');
  private readonly breakers = new Map<string, CircuitBreaker<[() => Promise<unknown>], unknown>>();

  constructor() {
    for (const code of ACQUIRER_CODES) {
      const breaker = new CircuitBreaker((fn: () => Promise<unknown>) => fn(), {
        name: code,
        timeout: false, // our HTTP client enforces its own timeout so we can tell timeouts apart
        errorThresholdPercentage: 50,
        volumeThreshold: 5,
        rollingCountTimeout: 10_000,
        rollingCountBuckets: 10,
        resetTimeout: parseInt(process.env.CIRCUIT_RESET_MS ?? '10000', 10),
        errorFilter: (err: unknown) => err instanceof ServiceCallError && err.status < 500,
      });
      breaker.on('open', () => {
        this.logger.warn(`Circuit OPEN for acquirer ${code}: routing traffic elsewhere`);
        circuitState.set({ acquirer: code }, 2);
      });
      breaker.on('halfOpen', () => {
        this.logger.log(`Circuit HALF-OPEN for acquirer ${code}: sending a trial request`);
        circuitState.set({ acquirer: code }, 1);
      });
      breaker.on('close', () => {
        this.logger.log(`Circuit CLOSED for acquirer ${code}: acquirer recovered`);
        circuitState.set({ acquirer: code }, 0);
      });
      circuitState.set({ acquirer: code }, 0);
      this.breakers.set(code, breaker);
    }
  }

  state(code: string): CircuitStatus {
    const breaker = this.breakers.get(code);
    if (!breaker) return 'open';
    if (breaker.opened) return 'open';
    if (breaker.halfOpen) return 'half_open';
    return 'closed';
  }

  authorize(acquirer: string, req: AcquirerPaymentRequest): Promise<AcquirerPaymentResponse> {
    return this.exec(acquirer, () =>
      callService<AcquirerPaymentResponse>(config.services.bank, `/acquirers/${acquirer}/payments`, { body: req, timeoutMs: AUTH_TIMEOUT_MS }),
    );
  }

  /** Status check by our own reference. Returns null if the acquirer never saw the request. */
  async lookup(acquirer: string, merchantRef: string): Promise<AcquirerPaymentResponse | null> {
    try {
      return await this.exec(acquirer, () =>
        callService<AcquirerPaymentResponse>(
          config.services.bank,
          `/acquirers/${acquirer}/payments?merchant_ref=${encodeURIComponent(merchantRef)}`,
          { timeoutMs: OPS_TIMEOUT_MS },
        ),
      );
    } catch (err) {
      if (err instanceof ServiceCallError && err.status === 404) return null;
      throw err;
    }
  }

  verifyOtp(acquirer: string, acquirerRef: string, otp: string): Promise<AcquirerPaymentResponse> {
    return this.exec(acquirer, () =>
      callService<AcquirerPaymentResponse>(config.services.bank, `/acquirers/${acquirer}/payments/${acquirerRef}/otp`, {
        body: { otp },
        timeoutMs: OPS_TIMEOUT_MS,
      }),
    );
  }

  capture(acquirer: string, acquirerRef: string, amount: number): Promise<AcquirerPaymentResponse> {
    return this.exec(acquirer, () =>
      callService<AcquirerPaymentResponse>(config.services.bank, `/acquirers/${acquirer}/payments/${acquirerRef}/capture`, {
        body: { amount },
        timeoutMs: OPS_TIMEOUT_MS,
      }),
    );
  }

  void(acquirer: string, acquirerRef: string): Promise<AcquirerPaymentResponse> {
    return this.exec(acquirer, () =>
      callService<AcquirerPaymentResponse>(config.services.bank, `/acquirers/${acquirer}/payments/${acquirerRef}/void`, {
        body: {},
        timeoutMs: OPS_TIMEOUT_MS,
      }),
    );
  }

  refund(acquirer: string, body: { merchant_ref: string; payment_id: string; amount: number }): Promise<AcquirerRefundResponse> {
    return this.exec(acquirer, () =>
      callService<AcquirerRefundResponse>(config.services.bank, `/acquirers/${acquirer}/refunds`, { body, timeoutMs: OPS_TIMEOUT_MS }),
    );
  }

  private async exec<T>(acquirer: string, fn: () => Promise<T>): Promise<T> {
    const breaker = this.breakers.get(acquirer);
    if (!breaker) throw new AcquirerTechnicalError(acquirer, `Unknown acquirer ${acquirer}`);
    try {
      return (await breaker.fire(fn)) as T;
    } catch (err) {
      const e = err as Error & { code?: string };
      if (e.code === 'EOPENBREAKER') throw new AcquirerTechnicalError(acquirer, `Circuit open for ${acquirer}`, true);
      if (err instanceof ServiceTimeoutError) throw new AcquirerTimeoutError(acquirer, e.message);
      if (err instanceof ServiceUnreachableError) throw new AcquirerTechnicalError(acquirer, e.message);
      if (err instanceof ServiceCallError && err.status >= 500) {
        throw new AcquirerTechnicalError(acquirer, `${acquirer} returned ${err.status} (${err.code ?? 'error'})`);
      }
      throw err;
    }
  }
}
