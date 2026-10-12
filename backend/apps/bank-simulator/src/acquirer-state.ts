import { Injectable } from '@nestjs/common';
import { ACQUIRERS, AcquirerCode, AcquirerProfile, Errors, isAcquirerCode } from '@app/common';

export interface AcquirerRuntime extends AcquirerProfile {
  latencyMs: number;
  jitterMs: number;
  /** Probability that a request fails with a technical (5xx) error before reaching the issuer. */
  technicalFailureRate: number;
  down: boolean;
  /** One-shot: the next settlement report contains a wrong amount and omits a line. */
  injectDiscrepancy: boolean;
  stats: { requests: number; approved: number; declined: number; pending: number; technicalFailures: number; rejectedWhileDown: number };
}

const DEFAULTS: Record<AcquirerCode, Pick<AcquirerRuntime, 'latencyMs' | 'jitterMs' | 'technicalFailureRate'>> = {
  alpha: { latencyMs: 60, jitterMs: 40, technicalFailureRate: 0.02 },
  beta: { latencyMs: 220, jitterMs: 80, technicalFailureRate: 0.005 },
  gamma: { latencyMs: 120, jitterMs: 60, technicalFailureRate: 0.01 },
};

/** Runtime knobs for each simulated acquirer, adjustable at runtime for chaos experiments. */
@Injectable()
export class AcquirerState {
  private readonly state = new Map<AcquirerCode, AcquirerRuntime>();

  constructor() {
    this.reset();
  }

  reset(): void {
    const override = process.env.SIM_TECH_FAILURE_RATE;
    for (const profile of Object.values(ACQUIRERS)) {
      const d = DEFAULTS[profile.code];
      this.state.set(profile.code, {
        ...profile,
        ...d,
        technicalFailureRate: override !== undefined ? parseFloat(override) : d.technicalFailureRate,
        down: false,
        injectDiscrepancy: false,
        stats: { requests: 0, approved: 0, declined: 0, pending: 0, technicalFailures: 0, rejectedWhileDown: 0 },
      });
    }
  }

  get(code: string): AcquirerRuntime {
    if (!isAcquirerCode(code)) throw Errors.notFound('acquirer', code);
    return this.state.get(code)!;
  }

  all(): AcquirerRuntime[] {
    return [...this.state.values()];
  }

  update(code: string, patch: Partial<Pick<AcquirerRuntime, 'down' | 'latencyMs' | 'jitterMs' | 'technicalFailureRate' | 'injectDiscrepancy'>>) {
    const current = this.get(code);
    Object.assign(current, Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)));
    return current;
  }

  latency(code: string): number {
    const s = this.get(code);
    return Math.max(0, Math.round(s.latencyMs + (Math.random() * 2 - 1) * s.jitterMs));
  }
}
