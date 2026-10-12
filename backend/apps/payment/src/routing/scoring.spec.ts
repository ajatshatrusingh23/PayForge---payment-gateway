import { Candidate, healthScore, rankCandidates, smoothedSuccessRate } from './scoring';

const candidate = (code: string, overrides: Partial<Candidate> = {}): Candidate => ({
  code,
  costBps: 180,
  circuit: 'closed',
  successes: 100,
  samples: 100,
  avgLatencyMs: 100,
  ...overrides,
});

describe('smart routing scoring', () => {
  it('smooths success rate toward a prior so one early failure does not condemn an acquirer', () => {
    expect(smoothedSuccessRate({ successes: 0, samples: 1 })).toBeGreaterThan(0.7);
    expect(smoothedSuccessRate({ successes: 0, samples: 0 })).toBeCloseTo(0.95);
  });

  it('prefers higher success rate over everything else', () => {
    const order = rankCandidates([candidate('flaky', { successes: 60 }), candidate('solid')], 'smart');
    expect(order[0]).toBe('solid');
  });

  it('breaks ties on latency, then cost', () => {
    expect(rankCandidates([candidate('slow', { avgLatencyMs: 900 }), candidate('fast', { avgLatencyMs: 80 })], 'smart')[0]).toBe('fast');
    expect(rankCandidates([candidate('pricey', { costBps: 250 }), candidate('cheap', { costBps: 120 })], 'smart')[0]).toBe('cheap');
  });

  it('excludes acquirers whose circuit is open', () => {
    const order = rankCandidates([candidate('down', { circuit: 'open' }), candidate('up', { successes: 70 })], 'smart');
    expect(order).toEqual(['up']);
  });

  it('keeps half-open acquirers eligible so they can prove recovery', () => {
    expect(rankCandidates([candidate('recovering', { circuit: 'half_open' })], 'smart')).toEqual(['recovering']);
  });

  it('explores a non-preferred acquirer with probability epsilon', () => {
    const list = [candidate('best'), candidate('other', { successes: 90 })];
    expect(rankCandidates(list, 'smart', 0.1, () => 0.05)[0]).toBe('other'); // explore
    expect(rankCandidates(list, 'smart', 0.1, () => 0.5)[0]).toBe('best'); // exploit
  });

  it("'single' strategy is the naive baseline: one acquirer, no failover", () => {
    expect(rankCandidates([candidate('a', { circuit: 'open' }), candidate('b')], 'single')).toEqual(['a']);
  });

  it('scores are bounded between 0 and 1', () => {
    const s = healthScore(candidate('x', { avgLatencyMs: 50_000, costBps: 10_000 }));
    expect(s).toBeGreaterThanOrEqual(0);
    expect(s).toBeLessThanOrEqual(1);
  });
});
